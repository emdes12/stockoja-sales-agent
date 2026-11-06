import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { logger } from '../log.js';
import { getSettings, setState, type Settings } from '../settings.js';
import {
  enqueue,
  claimNext,
  markDone,
  markFailed,
  PermanentError,
  releaseInterrupted,
  type Task,
  type TaskPolicy,
} from '../queue/queue.js';

export type AgentState = 'stopped' | 'running' | 'paused' | 'stopping';

export interface TaskContext {
  db: Db;
  signal: AbortSignal;
  settings: Settings;
  log: ReturnType<typeof logger>;
}

export interface TaskHandler {
  policy: TaskPolicy;
  run(task: Task, ctx: TaskContext): Promise<unknown>;
}

export type HandlerRegistry = Record<string, TaskHandler>;

/**
 * Work the agent queues for itself on a timer while running. One task per time slot (idempotency key),
 * so restarts and multiple ticks in a slot never queue it twice. Nothing is scheduled while stopped.
 */
export interface RecurringJob {
  type: string;
  /** Fixed, or read from settings (e.g. how often to check the mailbox). */
  everyMinutes: number | ((settings: Settings) => number);
  enabled: (settings: Settings) => boolean;
}

const log = logger('agent');

/** Resolves after `ms`, or early (rejecting) when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A task being worked on, and how to interrupt it. */
interface Running {
  task: Task;
  startedAt: Date;
  abort: AbortController;
}

/**
 * The agent. Each kind of task has its own lane, and all lanes run at the same time: a Telegram check, an email send
 * or an inbox check never waits behind a long discovery run. Within one lane tasks run one after another, because
 * tasks of one kind share an outside service whose spacing rules depend on it (OpenStreetMap's fair use, the gap
 * between emails). Only while running. Pause lets running tasks finish and takes no new ones. Stop interrupts them;
 * each goes back to the queue if its type is safe to repeat, otherwise it is held for review.
 */
export class Agent {
  state: AgentState = 'stopped';
  since = new Date();
  readonly workerId = `worker-${randomUUID().slice(0, 8)}`;

  /** Tasks being worked on now, one per lane. */
  private readonly running = new Map<string, Running>();
  /** Lanes (by task type) currently taking work. */
  private readonly lanes = new Map<string, Promise<void>>();
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  private lastScheduleAt = 0;

  constructor(
    private readonly db: Db,
    private readonly handlers: HandlerRegistry,
    private readonly pollMs = 1500,
    private readonly recurring: RecurringJob[] = [],
  ) {}

  /** Everything being worked on now, oldest first. */
  get currentTasks(): Array<{ task: Task; startedAt: Date }> {
    return [...this.running.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()).map(({ task, startedAt }) => ({ task, startedAt }));
  }

  /** The longest-running task (kept for older callers). */
  get current(): { task: Task; startedAt: Date } | null {
    return this.currentTasks[0] ?? null;
  }

  /**
   * Queues due recurring jobs (at most once a minute). A job that is already waiting or running is not queued again,
   * so checks never pile up.
   */
  private async schedule() {
    if (!this.recurring.length || Date.now() - this.lastScheduleAt < 60_000) return;
    this.lastScheduleAt = Date.now();
    const settings = await getSettings(this.db);
    for (const job of this.recurring) {
      if (!job.enabled(settings)) continue;
      const minutes = typeof job.everyMinutes === 'function' ? job.everyMinutes(settings) : job.everyMinutes;
      const slot = Math.floor(Date.now() / (minutes * 60_000));
      const waiting = await this.db.query(`SELECT 1 FROM tasks WHERE type = $1 AND status IN ('pending', 'running') AND payload ? 'slot' LIMIT 1`, [job.type]);
      if (waiting.rowCount) continue;
      await enqueue(this.db, job.type, { slot }, { idempotencyKey: `${job.type}:${minutes}:${slot}`, maxAttempts: 1 });
    }
  }

  /** Repeated timer checks left waiting (e.g. while one kind of task held up the rest) collapse into one. */
  private async collapseRecurring() {
    for (const job of this.recurring) {
      const { rowCount } = await this.db.query(
        `UPDATE tasks SET status = 'cancelled', last_error = 'Replaced by a newer check of the same kind', updated_at = now()
         WHERE type = $1 AND status = 'pending' AND payload ? 'slot'
           AND id <> (SELECT max(id) FROM tasks WHERE type = $1 AND status = 'pending' AND payload ? 'slot')`,
        [job.type],
      );
      if (rowCount) log.info(`${rowCount} repeated ${job.type} check(s) collapsed into one`);
    }
  }

  get policies(): Record<string, TaskPolicy> {
    return Object.fromEntries(Object.entries(this.handlers).map(([t, h]) => [t, h.policy]));
  }

  private async setStateTo(next: AgentState) {
    this.state = next;
    this.since = new Date();
    if (next !== 'stopping') await setState(this.db, 'agent', { state: next, at: this.since.toISOString() }).catch(() => {});
  }

  async start() {
    if (this.state !== 'stopped') return this.state;
    await this.setStateTo('running');
    log.info('Agent started');
    await this.collapseRecurring().catch((err) => log.error('Could not tidy repeated checks', err));
    this.loop = this.run().catch((err) => log.error('Worker loop crashed', err));
    return this.state;
  }

  async pause() {
    if (this.state !== 'running') return this.state;
    await this.setStateTo('paused');
    log.info('Agent paused; tasks already running will finish');
    return this.state;
  }

  async resume() {
    if (this.state !== 'paused') return this.state;
    await this.setStateTo('running');
    this.wake?.();
    log.info('Agent resumed');
    return this.state;
  }

  async stop() {
    if (this.state === 'stopped' || this.state === 'stopping') return this.state;
    this.state = 'stopping';
    for (const r of this.running.values()) r.abort.abort(new Error('Agent stopped'));
    this.wake?.();
    await this.loop;
    await Promise.all(this.lanes.values());
    this.loop = null;
    await this.setStateTo('stopped');
    log.info('Agent stopped');
    return this.state;
  }

  /** Wakes the agent so newly queued work starts without waiting for the next poll. */
  nudge() {
    this.wake?.();
  }

  private idle(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = done;
    }).finally(() => (this.wake = null));
  }

  /** Opens a lane for every kind of task that has work due and no lane yet. */
  private async run() {
    while (this.state === 'running' || this.state === 'paused') {
      if (this.state === 'running') {
        try {
          await this.schedule();
          const { rows } = await this.db.query<{ type: string }>(`SELECT DISTINCT type FROM tasks WHERE status = 'pending' AND run_at <= now()`);
          for (const { type } of rows) if (!this.lanes.has(type)) this.openLane(type);
        } catch (err) {
          log.error('Could not read the task queue (is Postgres running?)', err);
          await this.idle(this.pollMs * 4);
          continue;
        }
      }
      await this.idle(this.pollMs);
    }
  }

  /** One kind of task, one after another, until none is due (or the agent pauses or stops). */
  private openLane(type: string) {
    const lane = (async () => {
      while (this.state === 'running') {
        let task: Task | null;
        try {
          task = await claimNext(this.db, this.workerId, type);
        } catch (err) {
          log.error('Could not read the task queue (is Postgres running?)', err);
          return;
        }
        if (!task) return;
        await this.execute(task);
      }
    })()
      .catch((err) => log.error(`Lane ${type} crashed`, err))
      .finally(() => this.lanes.delete(type));
    this.lanes.set(type, lane);
  }

  private async execute(task: Task) {
    const handler = this.handlers[task.type];
    if (!handler) {
      await markFailed(this.db, task, new PermanentError(`No handler for task type "${task.type}"`));
      return;
    }
    const abort = new AbortController();
    this.running.set(task.type, { task, startedAt: new Date(), abort });
    const tlog = logger(`task:${task.type}`);
    try {
      const settings = await getSettings(this.db);
      const result = await handler.run(task, { db: this.db, signal: abort.signal, settings, log: tlog });
      if (abort.signal.aborted) await releaseInterrupted(this.db, task, handler.policy);
      else await markDone(this.db, task.id, result);
    } catch (err) {
      if (abort.signal.aborted) {
        await releaseInterrupted(this.db, task, handler.policy);
        tlog.info(`Task #${task.id} interrupted by Stop`);
      } else {
        const outcome = await markFailed(this.db, task, err);
        const level = outcome === 'failed' ? 'error' : outcome === 'rescheduled' ? 'info' : 'warn';
        tlog[level](`Task #${task.id} ${outcome === 'held' ? 'held for review' : outcome}: ${(err as Error).message}`);
      }
    } finally {
      this.running.delete(task.type);
    }
  }
}
