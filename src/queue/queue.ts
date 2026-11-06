import type { Db, Queryable } from '../db/pool.js';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'needs_review';

export interface Task<P = Record<string, unknown>> {
  id: number;
  type: string;
  payload: P;
  status: TaskStatus;
  idempotency_key: string | null;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  review_reason: string | null;
  lead_id: number | null;
  created_at: Date;
  updated_at: Date;
}

/** How the worker treats a task type. */
export interface TaskPolicy {
  /** Interrupted mid-run (crash, shutdown, Stop): safe to run again automatically? False → held for review. */
  retrySafe: boolean;
  /** Found overdue at start-up: hold for review instead of running late? (e.g. a follow-up that may no longer fit) */
  reviewIfOverdue: boolean;
}

/** Thrown by handlers when a provider asks us to slow down; the task is retried after `retryAfterMs`, not counted as failed. */
export class RateLimitedError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
  }
}

/** Thrown for failures retrying cannot fix (bad input, 4xx); the task fails at once. */
export class PermanentError extends Error {}

/** Thrown when a person must decide (e.g. email not configured): the task is held for review, not retried. */
export class HoldForReviewError extends Error {}

export interface EnqueueOptions {
  idempotencyKey?: string;
  runAt?: Date;
  maxAttempts?: number;
  leadId?: number | null;
}

/**
 * Adds a task. With an idempotency key, a second enqueue of the same work is a no-op (returns null),
 * whatever state the first one is in, so restarts and double clicks never create duplicates.
 */
export async function enqueue(
  db: Queryable,
  type: string,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<Task | null> {
  const { rows } = await db.query<Task>(
    `INSERT INTO tasks (type, payload, idempotency_key, run_at, max_attempts, lead_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [type, JSON.stringify(payload), opts.idempotencyKey ?? null, opts.runAt ?? new Date(), opts.maxAttempts ?? 3, opts.leadId ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Claims the next due task for this worker, of one type when given (the agent's lane for that type). SKIP LOCKED
 * keeps two claimers from taking the same row.
 */
export async function claimNext(db: Queryable, workerId: string, type?: string): Promise<Task | null> {
  const { rows } = await db.query<Task>(
    `UPDATE tasks SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM tasks WHERE status = 'pending' AND run_at <= now() AND ($2::text IS NULL OR type = $2)
       ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1
     )
     RETURNING *`,
    [workerId, type ?? null],
  );
  return rows[0] ?? null;
}

export async function markDone(db: Queryable, id: number, result: unknown) {
  await db.query(
    `UPDATE tasks SET status = 'done', result = $2, last_error = NULL, locked_at = NULL, locked_by = NULL,
       finished_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'running'`,
    [id, JSON.stringify(result ?? null)],
  );
}

const backoffMs = (attempt: number) => Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));

/** Records a failure: retries later with backoff while attempts remain, otherwise fails. */
export async function markFailed(db: Queryable, task: Task, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof RateLimitedError) {
    // A rate limit is not the task's fault: give the attempt back and wait as asked.
    await db.query(
      `UPDATE tasks SET status = 'pending', attempts = greatest(attempts - 1, 0), run_at = now() + ($2 || ' milliseconds')::interval,
         last_error = $3, locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = $1`,
      [task.id, String(err.retryAfterMs), message],
    );
    return 'rescheduled' as const;
  }
  if (err instanceof HoldForReviewError) {
    await db.query(
      `UPDATE tasks SET status = 'needs_review', review_reason = $2, attempts = greatest(attempts - 1, 0),
         locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = $1`,
      [task.id, message],
    );
    return 'held' as const;
  }
  const permanent = err instanceof PermanentError;
  if (!permanent && task.attempts < task.max_attempts) {
    await db.query(
      `UPDATE tasks SET status = 'pending', run_at = now() + ($2 || ' milliseconds')::interval, last_error = $3,
         locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = $1`,
      [task.id, String(backoffMs(task.attempts)), message],
    );
    return 'retrying' as const;
  }
  await db.query(
    `UPDATE tasks SET status = 'failed', last_error = $2, locked_at = NULL, locked_by = NULL, finished_at = now(), updated_at = now()
     WHERE id = $1`,
    [task.id, message],
  );
  return 'failed' as const;
}

/** A task stopped part-way (Stop pressed): re-queue if safe, otherwise hold for review. */
export async function releaseInterrupted(db: Queryable, task: Task, policy: TaskPolicy) {
  if (policy.retrySafe) {
    await db.query(
      `UPDATE tasks SET status = 'pending', attempts = greatest(attempts - 1, 0), locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [task.id],
    );
  } else {
    await holdForReview(db, task.id, 'Stopped while running. Check whether it completed before retrying.');
  }
}

export async function holdForReview(db: Queryable, id: number, reason: string) {
  await db.query(
    `UPDATE tasks SET status = 'needs_review', review_reason = $2, locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'running')`,
    [id, reason],
  );
}

export interface RecoveryReport {
  requeued: number;
  heldInterrupted: number;
  heldOverdue: number;
}

/**
 * Runs once when the app starts, before any task executes:
 * - tasks left "running" by a crash or shutdown are re-queued if their type is safe to repeat, otherwise held;
 * - pending tasks overdue by more than `graceMinutes` are held for review when their type asks for it.
 * Nothing is executed blindly.
 */
export async function recoverOnStartup(
  db: Db,
  policies: Record<string, TaskPolicy>,
  graceMinutes: number,
): Promise<RecoveryReport> {
  const report: RecoveryReport = { requeued: 0, heldInterrupted: 0, heldOverdue: 0 };
  const safeTypes = Object.entries(policies).filter(([, p]) => p.retrySafe).map(([t]) => t);
  const reviewTypes = Object.entries(policies).filter(([, p]) => p.reviewIfOverdue).map(([t]) => t);

  const requeued = await db.query(
    `UPDATE tasks SET status = 'pending', attempts = greatest(attempts - 1, 0), locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE status = 'running' AND type = ANY($1)`,
    [safeTypes],
  );
  report.requeued = requeued.rowCount ?? 0;

  const held = await db.query(
    `UPDATE tasks SET status = 'needs_review', locked_at = NULL, locked_by = NULL, updated_at = now(),
       review_reason = 'Interrupted when the app last closed. Check whether it completed before retrying.'
     WHERE status = 'running'`,
  );
  report.heldInterrupted = held.rowCount ?? 0;

  const overdue = await db.query(
    `UPDATE tasks SET status = 'needs_review', updated_at = now(),
       review_reason = 'Overdue by ' || to_char(now() - run_at, 'FMDD"d" FMHH24"h" FMMI"m"') || ' when the app started. Retry or cancel.'
     WHERE status = 'pending' AND type = ANY($1) AND run_at < now() - ($2 || ' minutes')::interval`,
    [reviewTypes, String(graceMinutes)],
  );
  report.heldOverdue = overdue.rowCount ?? 0;
  return report;
}

/** Retry a held or failed task now. */
export async function retryTask(db: Queryable, id: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE tasks SET status = 'pending', run_at = now(), review_reason = NULL, finished_at = NULL,
       max_attempts = greatest(max_attempts, attempts + 1), updated_at = now()
     WHERE id = $1 AND status IN ('needs_review', 'failed', 'cancelled')`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export async function cancelTask(db: Queryable, id: number, reason = 'Cancelled by you'): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE tasks SET status = 'cancelled', review_reason = $2, finished_at = now(), updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'needs_review', 'failed')`,
    [id, reason],
  );
  return (rowCount ?? 0) > 0;
}

/** Cancels a lead's waiting tasks of the given types (used when a prospect replies, declines or opts out). */
export async function cancelLeadTasks(db: Queryable, leadId: number, types: string[], reason: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE tasks SET status = 'cancelled', review_reason = $3, finished_at = now(), updated_at = now()
     WHERE lead_id = $1 AND type = ANY($2) AND status IN ('pending', 'needs_review')`,
    [leadId, types, reason],
  );
  return rowCount ?? 0;
}
