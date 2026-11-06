import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { hasTestDb, resetDb, testDb } from './helpers.js';
import type { Db } from '../src/db/pool.js';
import { upsertLead, listLeads, updateLead, requalify, type LeadCandidate } from '../src/leads/leads.js';
import {
  enqueue, claimNext, markFailed, recoverOnStartup, retryTask, cancelLeadTasks, RateLimitedError, PermanentError,
} from '../src/queue/queue.js';
import { Agent, sleep, type HandlerRegistry } from '../src/agent/controller.js';
import { createApp } from '../src/server/app.js';
import { getSettings } from '../src/settings.js';

const d = hasTestDb ? describe : describe.skip;

let db: Db;
beforeAll(async () => {
  if (hasTestDb) db = await testDb();
});
afterAll(async () => {
  await db?.end();
});
beforeEach(async () => {
  if (hasTestDb) await resetDb(db);
});

const osm = (id: number, extra: Partial<LeadCandidate> = {}): LeadCandidate => ({
  business_name: 'Ada Styles',
  category: 'fashion',
  source: 'osm',
  source_ref: `node/${id}`,
  state: 'Lagos',
  facts: [{ label: 'Business name', value: 'Ada Styles', source: 'OpenStreetMap' }],
  ...extra,
});

d('lead de-duplication', () => {
  it('recognises the same source record on a second run', async () => {
    const a = await upsertLead(db, osm(1, { phone: '08031234567' }), 50);
    const b = await upsertLead(db, osm(1, { phone: '08031234567' }), 50);
    expect(a.outcome).toBe('created');
    expect(b).toEqual({ leadId: a.leadId, outcome: 'seen' });
    expect((await db.query('SELECT count(*)::int AS n FROM leads')).rows[0].n).toBe(1);
  });

  it('merges by phone across sources and only fills blanks', async () => {
    const a = await upsertLead(db, osm(1, { phone: '+234 803 123 4567', website: 'https://ada.ng' }), 50);
    const b = await upsertLead(db, { ...osm(0), source: 'manual', source_ref: 'm1', business_name: 'ADA STYLES LTD', phone: '0803 123 4567', email: 'hi@ada.ng', website: 'https://other.ng' }, 50);
    expect(b).toEqual({ leadId: a.leadId, outcome: 'merged' });
    const lead = (await db.query('SELECT * FROM leads WHERE id = $1', [a.leadId])).rows[0];
    expect(lead.email).toBe('hi@ada.ng');
    expect(lead.website).toBe('https://ada.ng/');
    expect(lead.business_name).toBe('Ada Styles');
  });

  it('treats the same name in the same state as one business with several locations', async () => {
    const a = await upsertLead(db, osm(1, { lat: 6.5, lon: 3.3 }), 50);
    const b = await upsertLead(db, osm(2, { business_name: 'Ada Styles Ltd', lat: 6.6, lon: 3.4 }), 50);
    const c = await upsertLead(db, osm(3, { state: 'Oyo' }), 50);
    expect(b.leadId).toBe(a.leadId);
    expect(c.leadId).not.toBe(a.leadId);
    const lead = (await db.query('SELECT branch_count FROM leads WHERE id = $1', [a.leadId])).rows[0];
    expect(lead.branch_count).toBe(2);
  });

  it('qualifies automatically but never overrides a status you set', async () => {
    const { leadId } = await upsertLead(db, osm(1, { phone: '08031234567', email: 'a@ada.ng', website: 'https://ada.ng' }), 50);
    expect((await db.query('SELECT status FROM leads WHERE id = $1', [leadId])).rows[0].status).toBe('qualified');
    await updateLead(db, leadId, { status: 'do_not_contact' }, 50);
    await requalify(db, leadId, 50);
    expect((await db.query('SELECT status FROM leads WHERE id = $1', [leadId])).rows[0].status).toBe('do_not_contact');
  });

  it('filters and paginates', async () => {
    await upsertLead(db, osm(1, { phone: '08031234567' }), 50);
    await upsertLead(db, osm(2, { business_name: 'Gadget Hub', category: 'electronics', email: 'x@gh.ng' }), 50);
    const res = await listLeads(db, { contact: 'email', page: 1, pageSize: 10 });
    expect(res.meta.total).toBe(1);
    expect(res.data[0]!.business_name).toBe('Gadget Hub');
    expect((await listLeads(db, { q: 'ada', page: 1, pageSize: 10 })).meta.total).toBe(1);
  });
});

d('task queue', () => {
  it('ignores a second enqueue with the same idempotency key', async () => {
    expect(await enqueue(db, 'x', {}, { idempotencyKey: 'k1' })).not.toBeNull();
    expect(await enqueue(db, 'x', {}, { idempotencyKey: 'k1' })).toBeNull();
  });

  it('never hands the same task to two claimers', async () => {
    await enqueue(db, 'x', {});
    const [a, b] = await Promise.all([claimNext(db, 'w1'), claimNext(db, 'w2')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('does not run future tasks early', async () => {
    await enqueue(db, 'x', {}, { runAt: new Date(Date.now() + 60_000) });
    expect(await claimNext(db, 'w')).toBeNull();
  });

  it('retries with backoff, gives rate-limited attempts back, and fails permanently on bad input', async () => {
    await enqueue(db, 'x', {}, { maxAttempts: 2 });
    let t = (await claimNext(db, 'w'))!;
    expect(await markFailed(db, t, new RateLimitedError('slow down', 10))).toBe('rescheduled');
    await sleep(30);
    t = (await claimNext(db, 'w'))!;
    expect(t.attempts).toBe(1);
    expect(await markFailed(db, t, new Error('boom'))).toBe('retrying');
    await db.query('UPDATE tasks SET run_at = now()');
    t = (await claimNext(db, 'w'))!;
    expect(await markFailed(db, t, new Error('boom'))).toBe('failed');

    await enqueue(db, 'y', {}, { maxAttempts: 5 });
    const y = (await claimNext(db, 'w'))!;
    expect(await markFailed(db, y, new PermanentError('bad'))).toBe('failed');
  });

  it('recovers after a crash without running anything blindly', async () => {
    const policies = {
      safe: { retrySafe: true, reviewIfOverdue: false },
      unsafe: { retrySafe: false, reviewIfOverdue: true },
    };
    await enqueue(db, 'safe', {});
    await enqueue(db, 'unsafe', {});
    await claimNext(db, 'old');
    await claimNext(db, 'old'); // both "running" when the app died
    await enqueue(db, 'unsafe', {}, { runAt: new Date(Date.now() - 3 * 3600_000) }); // overdue follow-up
    await enqueue(db, 'safe', {}, { runAt: new Date(Date.now() - 3 * 3600_000) }); // overdue but harmless

    const report = await recoverOnStartup(db, policies, 60);
    expect(report).toEqual({ requeued: 1, heldInterrupted: 1, heldOverdue: 1 });
    const rows = (await db.query('SELECT type, status FROM tasks ORDER BY id')).rows;
    expect(rows.map((r) => r.status)).toEqual(['pending', 'needs_review', 'needs_review', 'pending']);

    const held = (await db.query(`SELECT id FROM tasks WHERE status = 'needs_review' LIMIT 1`)).rows[0];
    expect(await retryTask(db, held.id)).toBe(true);
  });

  it('cancels a lead’s waiting follow-ups', async () => {
    const { leadId } = await upsertLead(db, osm(1, { phone: '08031234567' }), 50);
    await enqueue(db, 'followup', {}, { leadId, runAt: new Date(Date.now() + 86400_000) });
    expect(await cancelLeadTasks(db, leadId, ['followup'], 'Replied')).toBe(1);
  });
});

d('agent controls', () => {
  it('runs tasks only while running; Stop re-queues a safe task and holds an unsafe one', async () => {
    const ran: number[] = [];
    const handlers: HandlerRegistry = {
      quick: { policy: { retrySafe: true, reviewIfOverdue: false }, run: async (t) => void ran.push(t.id) },
      slowSafe: { policy: { retrySafe: true, reviewIfOverdue: false }, run: async (_t, { signal }) => sleep(5000, signal) },
      slowUnsafe: { policy: { retrySafe: false, reviewIfOverdue: true }, run: async (_t, { signal }) => sleep(5000, signal) },
    };
    const agent = new Agent(db, handlers, 20);
    const q = await enqueue(db, 'quick', {});
    await sleep(100);
    expect(ran).toEqual([]); // stopped: nothing runs

    await agent.start();
    await sleep(200);
    expect(ran).toEqual([q!.id]);

    await agent.pause();
    await enqueue(db, 'quick', {});
    await sleep(150);
    expect(ran).toHaveLength(1); // paused: no new work
    await agent.resume();
    await sleep(200);
    expect(ran).toHaveLength(2);

    const s = await enqueue(db, 'slowSafe', {});
    await sleep(150);
    await agent.stop();
    expect((await db.query('SELECT status FROM tasks WHERE id = $1', [s!.id])).rows[0].status).toBe('pending');

    await db.query(`UPDATE tasks SET status = 'cancelled' WHERE id = $1`, [s!.id]);
    const u = await enqueue(db, 'slowUnsafe', {});
    await agent.start();
    await sleep(150);
    await agent.stop();
    expect((await db.query('SELECT status FROM tasks WHERE id = $1', [u!.id])).rows[0].status).toBe('needs_review');
    expect(agent.state).toBe('stopped');
  });

  it('runs each kind of task in its own lane: a slow kind never delays another', async () => {
    const ran: string[] = [];
    const handlers: HandlerRegistry = {
      slow: { policy: { retrySafe: true, reviewIfOverdue: false }, run: async (t, { signal }) => { await sleep(400, signal); ran.push(`slow${t.id}`); } },
      quick: { policy: { retrySafe: true, reviewIfOverdue: false }, run: async (t) => void ran.push(`quick${t.id}`) },
    };
    const agent = new Agent(db, handlers, 20);
    const s1 = await enqueue(db, 'slow', {});
    const s2 = await enqueue(db, 'slow', {});
    const q = await enqueue(db, 'quick', {});
    await agent.start();
    await sleep(200);
    expect(ran).toEqual([`quick${q!.id}`]); // done while the first slow task is still going
    expect(agent.currentTasks.map((c) => c.task.type)).toEqual(['slow']);
    await sleep(800);
    expect(ran).toEqual([`quick${q!.id}`, `slow${s1!.id}`, `slow${s2!.id}`]); // same kind: one after another
    await agent.stop();
  });

  it('collapses repeated timer checks left waiting into one, and never queues another while one waits', async () => {
    const ran: number[] = [];
    const handlers: HandlerRegistry = { check: { policy: { retrySafe: true, reviewIfOverdue: false }, run: async (t) => void ran.push(t.id) } };
    for (let slot = 1; slot <= 3; slot++) await enqueue(db, 'check', { slot }, { idempotencyKey: `check:1:${slot}` });
    const agent = new Agent(db, handlers, 20, [{ type: 'check', everyMinutes: 1, enabled: () => true }]);
    await agent.start();
    await sleep(200);
    await agent.stop();
    expect(ran).toHaveLength(1);
    const statuses = (await db.query(`SELECT status FROM tasks WHERE type = 'check' ORDER BY id`)).rows.map((r) => r.status);
    expect(statuses).toEqual(['cancelled', 'cancelled', 'done']);
  });
});

d('HTTP API', () => {
  const PORT = 6399;
  const makeApp = () =>
    createApp({
      db,
      agent: new Agent(db, {}, 50),
      recovery: { requeued: 0, heldInterrupted: 0, heldOverdue: 0, at: new Date(), wasRunningAtShutdown: false },
      port: PORT,
      shutdown: async () => {},
    });
  const host = `127.0.0.1:${PORT}`;

  it('rejects other hosts and cross-site writes', async () => {
    const app = makeApp();
    await request(app).get('/api/status').set('Host', 'evil.example:6399').expect(403);
    await request(app).post('/api/agent/start').set('Host', host).expect(403);
    await request(app).get('/api/status').set('Host', host).expect(200);
  });

  it('adds a lead, validates input, and returns 404 for unknown leads', async () => {
    const app = makeApp();
    const post = (body: unknown) => request(app).post('/api/leads').set('Host', host).set('X-Agent-Client', 'dashboard').send(body as object);
    const created = await post({ business_name: 'Kemi Beauty', category: 'skincare', instagram: 'https://instagram.com/kemi' }).expect(201);
    await post({ business_name: 'Kemi Beauty', category: 'skincare', instagram: 'https://instagram.com/kemi' }).expect(200);
    const bad = await post({ category: 'fashion' }).expect(422);
    expect(bad.body.error.fields[0].path).toBe('business_name');
    await request(app).get(`/api/leads/${created.body.leadId}`).set('Host', host).expect(200);
    await request(app).get('/api/leads/999999').set('Host', host).expect(404);
  });

  it('queues each discovery search at most once a day unless forced', async () => {
    const app = makeApp();
    const post = (body: unknown) => request(app).post('/api/discovery/runs').set('Host', host).set('X-Agent-Client', 'dashboard').send(body as object);
    const first = await post({ categories: ['fashion'], regions: ['NG-LA'] }).expect(202);
    const again = await post({ categories: ['fashion'], regions: ['NG-LA'] }).expect(202);
    const forced = await post({ categories: ['fashion'], regions: ['NG-LA'], force: true }).expect(202);
    expect([first.body.queued, again.body.queued, forced.body.queued]).toEqual([1, 0, 1]);
  });

  it('keeps Approval Mode as default and refuses autonomous mode until outreach exists', async () => {
    const app = makeApp();
    expect((await getSettings(db)).mode).toBe('approval');
    await request(app).put('/api/settings').set('Host', host).set('X-Agent-Client', 'dashboard').send({ mode: 'autonomous' }).expect(422);
    await request(app).put('/api/settings').set('Host', host).set('X-Agent-Client', 'dashboard').send({ mode: 'research' }).expect(200);
  });
});
