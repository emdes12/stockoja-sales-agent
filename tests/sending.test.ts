import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { hasTestDb, resetDb, testDb } from './helpers.js';
import { env } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import { logger } from '../src/log.js';
import { settingsSchema, updateSettings, type Settings } from '../src/settings.js';
import { upsertLead, type LeadCandidate } from '../src/leads/leads.js';
import { seedOutreach } from '../src/outreach/seed.js';
import { approveMessage, createDraft } from '../src/outreach/messages.js';
import { addSuppression } from '../src/outreach/suppressions.js';
import { enqueueSend, sendingHandlers, TASK_CHECK_DELIVERY, TASK_FOLLOWUP, TASK_SEND_EMAIL } from '../src/outreach/sending.js';
import { composeEmail, textToHtml } from '../src/outreach/email/compose.js';
import { inSendWindow, nextWindowStart, lagosDayStart } from '../src/outreach/email/window.js';
import { HoldForReviewError, RateLimitedError, type Task } from '../src/queue/queue.js';
import { AmbiguousSendError } from '../src/outreach/email/resend.js';
import { Agent } from '../src/agent/controller.js';
import { createApp } from '../src/server/app.js';

// ── A fake Resend, so no test can ever send real email ───────────────────────
interface Seen { method: string; path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }
const seen: Seen[] = [];
const replies: Array<{ status: number; body: unknown; headers?: Record<string, string> }> = [];
const events: Record<string, string> = {};
let domains: Array<{ name: string; status: string }> = [];
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ method: req.method!, path: req.url!, headers: req.headers, body });
      let out: { status: number; body: unknown; headers?: Record<string, string> };
      if (req.method === 'POST' && req.url === '/emails') out = replies.shift() ?? { status: 200, body: { id: `em_${seen.length}` } };
      else if (req.url?.startsWith('/emails/')) out = { status: 200, body: { last_event: events[req.url.slice(8)] ?? 'delivered' } };
      else if (req.url === '/domains') out = { status: 200, body: { data: domains } };
      else out = { status: 404, body: {} };
      res.writeHead(out.status, { 'Content-Type': 'application/json', ...out.headers });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  env.RESEND_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  env.RESEND_API_KEY = 're_test_key_not_real_123456';
  env.OUTREACH_FROM_ADDRESS = 'hello@sales.stockoja.com';
  env.OUTREACH_REPLY_TO = 'me@mymailbox.ng';
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('sending hours (Lagos time)', () => {
  const s = { sendWindowStartHour: 9, sendWindowEndHour: 17, sendOnWeekends: false };
  it('knows the window and the next opening', () => {
    // Monday 2026-10-26 09:30 WAT = 08:30 UTC
    expect(inSendWindow(new Date('2026-10-26T08:30:00Z'), s)).toBe(true);
    // Monday 17:30 WAT → next is Tuesday 09:00 WAT = 08:00 UTC
    expect(nextWindowStart(new Date('2026-10-26T16:30:00Z'), s).toISOString()).toBe('2026-10-27T08:00:00.000Z');
    // Saturday → Monday 09:00 WAT
    expect(nextWindowStart(new Date('2026-10-31T10:00:00Z'), s).toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect(nextWindowStart(new Date('2026-10-31T10:00:00Z'), { ...s, sendOnWeekends: true }).toISOString()).toBe('2026-10-31T10:00:00.000Z');
    // Lagos midnight is 23:00 UTC the day before
    expect(lagosDayStart(new Date('2026-10-26T23:30:00Z')).toISOString()).toBe('2026-10-26T23:00:00.000Z');
  });
});

describe('composing', () => {
  it('builds a safe HTML version with clickable links, reply-to, unsubscribe header and a stable idempotency key', () => {
    expect(textToHtml('Hi <b>\n\nGo: https://x.ng/a?b=1&c=2.')).toBe(
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#17201c"><p style="margin:0 0 14px">Hi &lt;b&gt;</p><p style="margin:0 0 14px">Go: <a href="https://x.ng/a?b=1&amp;c=2">https://x.ng/a?b=1&amp;c=2</a>.</p></div>',
    );
    const e = composeEmail({ id: 7, lead_id: 3, step: 'intro', to_address: 'a@b.ng', subject: 'S', body: 'B' }, settingsSchema.parse({ senderName: 'Muri "A" <x>' }));
    expect(e.from).toBe('Muri A x <hello@sales.stockoja.com>');
    expect(e.replyTo).toBe('me@mymailbox.ng');
    expect(e.headers['List-Unsubscribe']).toBe('<mailto:me@mymailbox.ng?subject=unsubscribe>');
    expect(e.idempotencyKey).toBe('stockoja-sales-msg-7');
  });
});

const d = hasTestDb ? describe : describe.skip;
let db: Db;
beforeAll(async () => {
  if (hasTestDb) db = await testDb();
});
afterAll(async () => {
  await db?.end();
});
beforeEach(async () => {
  seen.length = 0;
  replies.length = 0;
  if (hasTestDb) {
    await resetDb(db);
    await seedOutreach(db);
  }
});

const live: Settings = settingsSchema.parse({
  senderName: 'Muri', emailSendingMode: 'live', sendWindowStartHour: 0, sendWindowEndHour: 24, sendOnWeekends: true, minSecondsBetweenEmails: 10,
});
const ctx = (settings: Settings) => ({ db, signal: new AbortController().signal, settings, log: logger('test') });
const lead = (extra: Partial<LeadCandidate> = {}): LeadCandidate => ({
  business_name: 'Ada Styles', category: 'fashion', source: 'osm', source_ref: 'node/1', state: 'Lagos',
  phone: '08031234567', email: 'info@ada.ng', website: 'https://ada.ng', facts: [], ...extra,
});

/** An approved intro email and its send task. */
async function approvedEmail(settings: Settings, extra: Partial<LeadCandidate> = {}) {
  const { leadId } = await upsertLead(db, lead(extra), 50);
  const draft = await createDraft(db, leadId, 'email', settings);
  const msg = await approveMessage(db, draft.id, settings);
  const task = (await enqueueSend(db, msg))!;
  return { leadId, msg, task };
}
const runSend = (task: Task, settings: Settings) => sendingHandlers[TASK_SEND_EMAIL]!.run(task, ctx(settings));
const msgRow = async (id: number) => (await db.query('SELECT * FROM messages WHERE id = $1', [id])).rows[0];
const sends = () => seen.filter((s) => s.method === 'POST' && s.path === '/emails');

d('sending', () => {
  it('dry run renders and records, but never calls Resend', async () => {
    const dry = { ...live, emailSendingMode: 'dry_run' as const };
    const { msg, task } = await approvedEmail(dry);
    expect(await runSend(task, dry)).toEqual({ dryRun: true });
    expect((await msgRow(msg.id)).status).toBe('dry_run');
    expect(seen).toHaveLength(0);
  });

  it('sends once with an idempotency key; running the task again does nothing', async () => {
    const { leadId, msg, task } = await approvedEmail(live);
    const result = (await runSend(task, live)) as { sent: boolean };
    expect(result.sent).toBe(true);
    expect(sends()).toHaveLength(1);
    const req = sends()[0]!;
    expect(req.headers['idempotency-key']).toBe(`stockoja-sales-msg-${msg.id}`);
    expect(req.body).toMatchObject({ to: ['info@ada.ng'], reply_to: 'me@mymailbox.ng', from: 'Muri <hello@sales.stockoja.com>' });
    const row = await msgRow(msg.id);
    expect([row.status, row.sent_by, row.provider_message_id]).toEqual(['sent', 'provider', 'em_1']);
    expect((await db.query('SELECT status FROM leads WHERE id = $1', [leadId])).rows[0].status).toBe('contacted');
    const follow = (await db.query(`SELECT run_at FROM tasks WHERE type = $1`, [TASK_FOLLOWUP])).rows[0];
    expect(new Date(follow.run_at).getTime()).toBeGreaterThan(Date.now() + 3.9 * 86400_000);

    expect(await runSend(task, live)).toEqual({ skipped: 'message is sent' });
    expect(sends()).toHaveLength(1);
  });

  it('retries an uncertain send with the same idempotency key', async () => {
    const { msg, task } = await approvedEmail(live);
    replies.push({ status: 500, body: { message: 'internal' } });
    await expect(runSend(task, live)).rejects.toBeInstanceOf(AmbiguousSendError);
    expect((await msgRow(msg.id)).status).toBe('sending');
    await db.query(`UPDATE messages SET sent_at = NULL`); // no earlier send to space from
    await runSend(task, live);
    expect(sends().map((s) => s.headers['idempotency-key'])).toEqual([`stockoja-sales-msg-${msg.id}`, `stockoja-sales-msg-${msg.id}`]);
    expect((await msgRow(msg.id)).status).toBe('sent');
  });

  it('backs off on 429 and keeps the message approved', async () => {
    const { msg, task } = await approvedEmail(live);
    replies.push({ status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '30' } });
    const err = (await runSend(task, live).catch((e: unknown) => e)) as RateLimitedError;
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterMs).toBe(30_000);
    expect((await msgRow(msg.id)).status).toBe('approved');
  });

  it('waits for sending hours, the daily limit and spacing without touching Resend', async () => {
    const closed = { ...live, sendWindowStartHour: 0, sendWindowEndHour: 1, sendOnWeekends: false };
    const { task } = await approvedEmail(live);
    if (!inSendWindow(new Date(), closed)) await expect(runSend(task, closed)).rejects.toBeInstanceOf(RateLimitedError);
    await db.query(`INSERT INTO messages (lead_id, channel, step, body, status, sent_at, sent_by) VALUES (1, 'email', 'followup_2', 'x', 'sent', now(), 'provider')`);
    await expect(runSend(task, { ...live, dailyEmailLimit: 1 })).rejects.toThrow(/Daily limit/);
    await expect(runSend(task, { ...live, minSecondsBetweenEmails: 600 })).rejects.toThrow(/Spacing/);
    expect(sends()).toHaveLength(0);
  });

  it('does not send to an address blocked after approval, and holds when email is not set up', async () => {
    const { msg, task } = await approvedEmail(live);
    await addSuppression(db, 'email', 'info@ada.ng', { source: 'reply_stop' });
    expect(await runSend(task, live)).toEqual({ skipped: 'SUPPRESSED' });
    expect((await msgRow(msg.id)).status).toBe('cancelled');

    const other = await approvedEmail(live, { business_name: 'Bola Shoes', source_ref: 'node/2', email: 'hi@bola.ng', phone: '08039999999', website: 'https://bola.ng' });
    const saved = env.OUTREACH_REPLY_TO;
    env.OUTREACH_REPLY_TO = '';
    await expect(runSend(other.task, live)).rejects.toBeInstanceOf(HoldForReviewError);
    env.OUTREACH_REPLY_TO = saved;
    expect(sends()).toHaveLength(0);
  });
});

d('follow-ups and delivery', () => {
  it('drafts a follow-up only while the lead is waiting, referencing the first subject', async () => {
    const { leadId, task } = await approvedEmail(live);
    await runSend(task, live);
    const follow = (await db.query<Task>(`SELECT * FROM tasks WHERE type = $1`, [TASK_FOLLOWUP])).rows[0]!;
    const r = (await sendingHandlers[TASK_FOLLOWUP]!.run(follow, ctx(live))) as { drafted: number };
    const draft = await msgRow(r.drafted);
    expect([draft.step, draft.status, draft.subject]).toEqual(['followup_1', 'draft', 'Re: Tracking clothing stock by size and colour']);

    await db.query(`UPDATE messages SET status = 'cancelled' WHERE id = $1`, [r.drafted]);
    await db.query(`UPDATE leads SET status = 'interested' WHERE id = $1`, [leadId]);
    expect(await sendingHandlers[TASK_FOLLOWUP]!.run(follow, ctx(live))).toEqual({ skipped: 'lead is interested' });
  });

  it('adds bounced addresses to the do-not-contact list', async () => {
    const { leadId, task } = await approvedEmail(live);
    await runSend(task, live);
    events.em_1 = 'bounced';
    const result = await sendingHandlers[TASK_CHECK_DELIVERY]!.run({} as Task, ctx(live));
    expect(result).toMatchObject({ checked: 1, bounced: 1 });
    const s = (await db.query(`SELECT source FROM suppressions WHERE value = 'info@ada.ng' AND lifted_at IS NULL`)).rows[0];
    expect(s.source).toBe('bounce');
    expect((await db.query(`SELECT count(*)::int AS n FROM tasks WHERE lead_id = $1 AND type = $2 AND status = 'pending'`, [leadId, TASK_FOLLOWUP])).rows[0].n).toBe(0);
    delete events.em_1;
  });
});

d('switching to live', () => {
  const PORT = 6397;
  const host = `127.0.0.1:${PORT}`;
  const put = (body: object) =>
    request(createApp({ db, agent: new Agent(db, {}, 50), recovery: { requeued: 0, heldInterrupted: 0, heldOverdue: 0, at: new Date(), wasRunningAtShutdown: false }, port: PORT, shutdown: async () => {} }))
      .put('/api/settings').set('Host', host).set('X-Agent-Client', 'dashboard').send(body);

  it('is refused until the From domain is verified in Resend', async () => {
    await updateSettings(db, { senderName: 'Muri' });
    domains = [];
    expect((await put({ emailSendingMode: 'live' }).expect(422)).body.error.code).toBe('DOMAIN_NOT_VERIFIED');
    domains = [{ name: 'sales.stockoja.com', status: 'pending' }];
    await put({ emailSendingMode: 'live' }).expect(422);
    domains = [{ name: 'sales.stockoja.com', status: 'verified' }];
    await put({ emailSendingMode: 'live' }).expect(200);
    await put({ sendWindowStartHour: 18, sendWindowEndHour: 9 }).expect(422);
  });
});
