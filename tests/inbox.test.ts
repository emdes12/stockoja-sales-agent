import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { hasTestDb, resetDb, testDb } from './helpers.js';
import { env } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import { logger } from '../src/log.js';
import { getState, settingsSchema, setState, type Settings } from '../src/settings.js';
import { upsertLead, type LeadCandidate } from '../src/leads/leads.js';
import { seedOutreach } from '../src/outreach/seed.js';
import { approveMessage } from '../src/outreach/messages.js';
import { enqueue, type Task } from '../src/queue/queue.js';
import { sendingHandlers, TASK_FOLLOWUP } from '../src/outreach/sending.js';
import { composeEmail } from '../src/outreach/email/compose.js';
import { classify, questionsIn } from '../src/inbox/classify.js';
import { baseSubject, parseEmail, stripQuoted } from '../src/inbox/parse.js';
import { draftReply, relabel } from '../src/inbox/process.js';
import { checkInbox, inboxDeps, inboxHandlers } from '../src/inbox/inbox.js';
import type { Mailbox, MailHeader } from '../src/inbox/mailbox.js';
import { Agent } from '../src/agent/controller.js';
import { createApp } from '../src/server/app.js';

const OUR_SUBJECT = 'Tracking clothing stock by size and colour';

/** An RFC 822 email, as the server would hand it over. */
function rawEmail(o: { from: string; subject: string; body: string; id: string; headers?: string[] }) {
  return [
    `From: Someone <${o.from}>`,
    'To: hello@stockoja.com',
    `Subject: ${o.subject}`,
    `Message-ID: <${o.id}@mail.test>`,
    'Date: Mon, 26 Oct 2026 10:00:00 +0100',
    ...(o.headers ?? []),
    'Content-Type: text/plain; charset=utf-8',
    '',
    o.body,
  ].join('\r\n');
}

describe('reading replies (no database)', () => {
  it('strips quoted history, signatures and phone footers', () => {
    expect(stripQuoted('Yes please.\n\nOn Mon, 26 Oct 2026 at 09:00, Muri <hello@sales.stockoja.com> wrote:\n> reply STOP and…')).toBe('Yes please.');
    expect(stripQuoted('Tell me more\nOn Mon, 26 Oct 2026 at 09:00, Muri\n<hello@sales.stockoja.com> wrote:\n> STOP')).toBe('Tell me more');
    expect(stripQuoted('How much?\n\nSent from my iPhone')).toBe('How much?');
    expect(stripQuoted('Ok\n________________________________\nFrom: Muri\nSent: Monday')).toBe('Ok');
    expect(stripQuoted('Thanks\n-- \nAda, Ada Styles')).toBe('Thanks');
  });

  it('labels replies by their own words, and explains why', () => {
    const c = (text: string, subject = 'Re: x', autoHeaders: string[] = []) => classify({ subject, text, autoHeaders }).label;
    expect(c('STOP')).toBe('opt_out');
    expect(c('Please remove me from your mailing list')).toBe('opt_out');
    expect(c("Don't contact me again")).toBe('opt_out');
    expect(c('', 'unsubscribe')).toBe('opt_out');
    expect(c('I am out of the office until Monday', 'Automatic reply: x')).toBe('auto_reply');
    expect(c('Thanks', 'Re: x', ['Auto-Submitted: auto-replied'])).toBe('auto_reply');
    expect(c("Not interested, thanks")).toBe('not_interested');
    expect(c('No thanks, we already use another system')).toBe('not_interested');
    expect(c('Can you show me a demo next week?')).toBe('demo_request');
    expect(c("Sounds good, tell me more")).toBe('interested');
    expect(c('I dey interested o')).toBe('interested');
    expect(c('How much does it cost per month?')).toBe('question');
    expect(c('Who is this?')).toBe('question');
    expect(c('ok noted')).toBe('other');
    // "not interested" must never read as "interested"
    expect(classify({ subject: 'Re: x', text: 'We are not interested' }).reasons).toEqual(['"not interested"']);
    expect(classify({ subject: 'Re: x', text: "I'm interested. How much is it?" })).toMatchObject({ label: 'interested', hasQuestion: true });
  });

  it('finds the questions worth looking up, and matches subjects across Re:/Fwd:', () => {
    expect(questionsIn('Good afternoon. How much does it cost? Also, can my staff use it?')).toEqual(['How much does it cost?', 'Also, can my staff use it?']);
    expect(baseSubject('RE: Fwd: Re[2]: Hello there')).toBe('hello there');
  });

  it('parses a real email: auto-reply headers, quoted STOP ignored', async () => {
    const auto = await parseEmail(rawEmail({ from: 'Info@Ada.ng', subject: 'Away', body: 'Back soon', id: 'a1', headers: ['Auto-Submitted: auto-replied'] }));
    expect(auto).toMatchObject({ from: 'info@ada.ng', messageId: '<a1@mail.test>', autoHeaders: ['Auto-Submitted: auto-replied'] });
    const quoted = await parseEmail(rawEmail({ from: 'info@ada.ng', subject: `Re: ${OUR_SUBJECT}`, id: 'q1', body: 'Interested!\r\n\r\nOn Mon, 26 Oct 2026, Muri wrote:\r\n> reply STOP' }));
    expect(classify(quoted).label).toBe('interested');
  });

  it('threads an answer under their email', () => {
    const e = composeEmail({ id: 9, lead_id: 1, step: 'reply', to_address: 'a@b.ng', subject: 'Re: x', body: 'B' }, settingsSchema.parse({ senderName: 'Muri' }), '<q1@mail.test>');
    expect(e.headers).toMatchObject({ 'In-Reply-To': '<q1@mail.test>', References: '<q1@mail.test>' });
    const bad = composeEmail({ id: 9, lead_id: 1, step: 'reply', to_address: 'a@b.ng', subject: 'Re: x', body: 'B' }, settingsSchema.parse({ senderName: 'Muri' }), 'x\r\nBcc: evil@x');
    expect(bad.headers['In-Reply-To']).toBeUndefined();
  });
});

// ── With the database and a fake mailbox ─────────────────────────────────────

class FakeMailbox implements Mailbox {
  downloaded: number[] = [];
  constructor(private mails: Array<{ uid: number; raw: string; from: string; subject: string; id: string }>, private uidValidity = '7') {}
  async open() {
    return { uidValidity: this.uidValidity, uidNext: Math.max(0, ...this.mails.map((m) => m.uid)) + 1, exists: this.mails.length };
  }
  async listHeaders({ afterUid, limit }: { afterUid: number | null; since: Date; limit: number }): Promise<MailHeader[]> {
    return this.mails
      .filter((m) => afterUid === null || m.uid > afterUid)
      .slice(0, limit)
      .map((m) => ({ uid: m.uid, from: m.from, subject: m.subject, date: new Date(), messageId: `<${m.id}@mail.test>`, inReplyTo: null, size: m.raw.length }));
  }
  async fetchRaw(uid: number) {
    this.downloaded.push(uid);
    return Buffer.from(this.mails.find((m) => m.uid === uid)!.raw);
  }
  async close() {}
}
const mail = (uid: number, from: string, subject: string, body: string, headers?: string[]) => ({
  uid, from, subject, id: `m${uid}`, raw: rawEmail({ from, subject, body, id: `m${uid}`, headers }),
});

const d = hasTestDb ? describe : describe.skip;
let db: Db;
beforeAll(async () => {
  if (hasTestDb) db = await testDb();
  env.IMAP_HOST = 'imap.test.invalid';
  env.IMAP_USER = 'hello@stockoja.com';
  env.IMAP_PASSWORD = 'not-a-real-password';
  env.OUTREACH_FROM_ADDRESS = 'hello@sales.stockoja.com';
  env.OUTREACH_REPLY_TO = 'hello@stockoja.com';
});
afterAll(async () => {
  await db?.end();
});

const settings: Settings = settingsSchema.parse({ senderName: 'Muri', bookingUrl: 'https://cal.com/muri/demo', readReplies: true });
const lead = (extra: Partial<LeadCandidate> = {}): LeadCandidate => ({
  business_name: 'Ada Styles', category: 'fashion', source: 'osm', source_ref: 'node/1', state: 'Lagos',
  phone: '08031234567', email: 'info@ada.ng', website: 'https://ada.ng', facts: [], ...extra,
});

/** A lead we emailed, with its follow-up waiting. */
async function contactedLead(extra: Partial<LeadCandidate> = {}, email = 'info@ada.ng') {
  const { leadId } = await upsertLead(db, lead({ email, ...extra }), 50);
  await db.query(
    `INSERT INTO messages (lead_id, channel, step, to_address, subject, body, status, sent_at, sent_by, provider_message_id)
     VALUES ($1, 'email', 'intro', $2, $3, 'Hello… reply STOP', 'sent', now() - interval '1 day', 'provider', 'em_1')`,
    [leadId, email, OUR_SUBJECT],
  );
  await db.query(`UPDATE leads SET status = 'contacted' WHERE id = $1`, [leadId]);
  await enqueue(db, TASK_FOLLOWUP, { leadId, step: 'followup_1' }, { idempotencyKey: `followup:${leadId}:followup_1`, leadId, runAt: new Date(Date.now() + 3 * 86400_000) });
  return leadId;
}
const leadRow = async (id: number) => (await db.query('SELECT * FROM leads WHERE id = $1', [id])).rows[0];
const pendingFollowUps = async (id: number) =>
  (await db.query(`SELECT count(*)::int AS n FROM tasks WHERE lead_id = $1 AND type = $2 AND status = 'pending'`, [id, TASK_FOLLOWUP])).rows[0].n;

beforeEach(async () => {
  if (!hasTestDb) return;
  await resetDb(db);
  await seedOutreach(db);
  await db.query(`UPDATE kb_entries SET status = 'approved', approved_at = now() WHERE topic IN ('Pricing', 'Staff')`);
});

d('checking the mailbox', () => {
  it('with "read every message" off, downloads only outreach-related mail, and acts on each kind', async () => {
    const s = { ...settings, emailReadAll: false };
    const ada = await contactedLead();
    const bola = await contactedLead({ business_name: 'Bola Shoes', source_ref: 'node/2', phone: '08039999999', website: 'https://bola.ng', category: 'shoes_bags' }, 'hi@bola.ng');
    const box = new FakeMailbox([
      mail(10, 'alerts@mybank.ng', 'Your statement', 'Private banking stuff'),
      mail(11, 'info@ada.ng', `Re: ${OUR_SUBJECT}`, "I'm interested. How much does it cost?\r\n\r\nOn Mon, Muri wrote:\r\n> reply STOP"),
      mail(12, 'hi@bola.ng', `Automatic reply: ${OUR_SUBJECT}`, 'I am out of the office', ['Auto-Submitted: auto-replied']),
      mail(13, 'stranger@gmail.com', `Re: ${OUR_SUBJECT}`, 'Who gave you my number?'),
      mail(14, 'notifications@cal.com', 'New event: Demo with Bola', 'Attendee: hi@bola.ng\r\nTime: as booked'),
    ]);
    inboxDeps.openMailbox = () => box;

    const r = await checkInbox(db, s);
    expect(r).toMatchObject({ looked: 5, replies: 2, unmatched: 1, bookings: 1, ignored: 1, drafted: 1 });
    expect(box.downloaded).not.toContain(10); // never fetched the bank email

    // Ada: interested, follow-ups stopped, answer drafted from the approved pricing entry with the sign-up link
    expect((await leadRow(ada)).status).toBe('interested');
    expect(await pendingFollowUps(ada)).toBe(0);
    const draft = (await db.query(`SELECT * FROM messages WHERE lead_id = $1 AND step = 'reply'`, [ada])).rows[0];
    expect(draft).toMatchObject({ status: 'draft', to_address: 'info@ada.ng', subject: `Re: ${OUR_SUBJECT}` });
    expect(draft.body).toMatch(/free to start/i);
    expect(draft.body).toMatch(/utm_campaign=outreach_reply/);
    expect(draft.body).not.toMatch(/\bSTOP\b/); // answers carry no opt-out line unless you add one

    // Bola: the auto-reply changed nothing, then the booking notice marked the demo
    expect((await leadRow(bola))).toMatchObject({ status: 'demo_booked', demo_source: 'booking_email' });
    expect((await db.query(`SELECT classification, needs_attention FROM messages WHERE lead_id = $1 AND direction = 'inbound'`, [bola])).rows[0])
      .toEqual({ classification: 'auto_reply', needs_attention: false });

    // Stranger: kept in the inbox under their contact, not attached to any lead
    expect((await db.query(`SELECT m.from_address, m.lead_id, c.platform FROM messages m JOIN social_contacts c ON c.id = m.social_contact_id
                             WHERE m.lead_id IS NULL`)).rows).toEqual([{ from_address: 'stranger@gmail.com', lead_id: null, platform: 'email' }]);

    // Next check reads nothing old; re-reading from scratch stores nothing twice
    expect((await checkInbox(db, s)).looked).toBe(0);
    await setState(db, 'inbox.cursor', null);
    const again = await checkInbox(db, s);
    expect(again).toMatchObject({ replies: 0, duplicates: 3, unmatched: 0 });
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE direction = 'inbound'`)).rows[0].n).toBe(3);
  });

  it('with "read every message" on, keeps mail from anyone in the chosen folders, except automated senders', async () => {
    await contactedLead();
    const inbox = new FakeMailbox([
      mail(10, 'customer@yahoo.com', 'Do you deliver to Abuja?', 'Hello, do you deliver to Abuja?'),
      mail(11, 'no-reply@bank.ng', 'Your statement', 'Private banking stuff'),
    ]);
    inboxDeps.openMailbox = () => inbox;
    const r = await checkInbox(db, { ...settings, emailReadAll: true, emailFolders: ['INBOX'] });
    expect(r).toMatchObject({ looked: 2, unmatched: 1, ignored: 1 });
    expect(inbox.downloaded).toEqual([10]);
    const m = (await db.query(`SELECT * FROM messages WHERE direction = 'inbound'`)).rows[0];
    expect(m).toMatchObject({ lead_id: null, folder: 'INBOX', classification: 'question', needs_attention: true });

    // Email switched off under Inbox access: nothing is read.
    const off = await inboxHandlers['inbox.check']!.run({} as never, { db, signal: new AbortController().signal, settings: { ...settings, inboxAccess: { ...settings.inboxAccess, email: false } }, log: logger('test') });
    expect(off).toMatchObject({ skipped: expect.stringContaining('switched off') });
  });

  it('applies STOP at once: do not contact, open messages and tasks cancelled', async () => {
    const ada = await contactedLead();
    const approved = (await db.query(
      `INSERT INTO messages (lead_id, channel, step, to_address, subject, body, status) VALUES ($1, 'email', 'followup_1', 'info@ada.ng', 'Re: x', 'reply STOP', 'approved') RETURNING id`,
      [ada],
    )).rows[0].id;
    inboxDeps.openMailbox = () => new FakeMailbox([mail(1, 'info@ada.ng', 'Re: hello', 'STOP')]);
    await checkInbox(db, settings);
    expect((await leadRow(ada)).status).toBe('do_not_contact');
    expect((await db.query(`SELECT source FROM suppressions WHERE value = 'info@ada.ng' AND lifted_at IS NULL`)).rows[0].source).toBe('reply_stop');
    expect((await db.query('SELECT status FROM messages WHERE id = $1', [approved])).rows[0].status).toBe('cancelled');
    expect(await pendingFollowUps(ada)).toBe(0);
  });

  it('answers a colleague at the same business domain, and starts from the newest mail on first run', async () => {
    const ada = await contactedLead();
    const box = new FakeMailbox([mail(40, 'sales@ada.ng', 'Re: hello', 'Can my staff use it without seeing everything?')]);
    inboxDeps.openMailbox = () => box;
    await checkInbox(db, settings);
    const reply = (await db.query(`SELECT * FROM messages WHERE lead_id = $1 AND step = 'reply'`, [ada])).rows[0];
    expect(reply.to_address).toBe('sales@ada.ng');
    expect(await getState(db, 'inbox.cursor')).toMatchObject({ lastUid: 40, uidValidity: '7' });
  });

  it('a question with no approved answer waits for you; a blank reply cannot be approved until written', async () => {
    const ada = await contactedLead();
    inboxDeps.openMailbox = () => new FakeMailbox([mail(1, 'info@ada.ng', 'Re: hello', 'Does it work with my Paystack terminal?')]);
    const r = await checkInbox(db, settings);
    expect(r.drafted).toBe(0);
    const inbound = (await db.query(`SELECT * FROM messages WHERE direction = 'inbound'`)).rows[0];
    expect([inbound.classification, inbound.needs_attention]).toEqual(['question', true]);

    const blank = await draftReply(db, inbound.id, settings, 'blank', 'user');
    expect('drafted' in blank).toBe(true);
    const draftId = (blank as { drafted: { id: number } }).drafted.id;
    await expect(approveMessage(db, draftId, settings)).rejects.toMatchObject({ code: 'NOT_COMPLIANT' });
    await expect(draftReply(db, inbound.id, settings, 'kb')).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect((await db.query('SELECT needs_attention FROM messages WHERE id = $1', [inbound.id])).rows[0].needs_attention).toBe(false);
    void ada;
  });

  it('out-of-office does not stop follow-ups; your relabel does', async () => {
    const ada = await contactedLead();
    inboxDeps.openMailbox = () => new FakeMailbox([mail(1, 'info@ada.ng', 'Out of office', 'Away until Monday')]);
    await checkInbox(db, settings);
    expect(await pendingFollowUps(ada)).toBe(1);
    const ctx = { db, signal: new AbortController().signal, settings, log: logger('test') };
    const follow = (await db.query<Task>(`SELECT * FROM tasks WHERE type = $1`, [TASK_FOLLOWUP])).rows[0]!;
    expect(await sendingHandlers[TASK_FOLLOWUP]!.run(follow, ctx)).toHaveProperty('drafted');

    const inbound = (await db.query(`SELECT id FROM messages WHERE direction = 'inbound'`)).rows[0];
    await relabel(db, inbound.id, 'not_interested');
    expect((await leadRow(ada)).status).toBe('declined');
    expect((await db.query(`SELECT status FROM messages WHERE step = 'followup_1'`)).rows[0].status).toBe('cancelled');
  });

  it('skips a message that keeps failing after three tries, so it cannot block the mailbox', async () => {
    await contactedLead();
    const box = new FakeMailbox([mail(5, 'info@ada.ng', 'Re: hi', 'Interested'), mail(6, 'info@ada.ng', 'Re: hi', 'How much?')]);
    box.fetchRaw = async (uid: number) => {
      if (uid === 5) throw new Error('server hiccup');
      return Buffer.from(rawEmail({ from: 'info@ada.ng', subject: 'Re: hi', body: 'How much?', id: 'm6' }));
    };
    inboxDeps.openMailbox = () => box;
    await expect(checkInbox(db, settings)).rejects.toThrow('server hiccup');
    await expect(checkInbox(db, settings)).rejects.toThrow('server hiccup');
    const r = await checkInbox(db, settings);
    expect(r).toMatchObject({ skipped: 1, replies: 1 });
  });
});

d('inbox API', () => {
  const PORT = 6396;
  const app = () =>
    createApp({ db, agent: new Agent(db, {}, 50), recovery: { requeued: 0, heldInterrupted: 0, heldOverdue: 0, at: new Date(), wasRunningAtShutdown: false }, port: PORT, shutdown: async () => {} });
  const call = (method: 'post' | 'put' | 'patch', path: string, body: object) =>
    request(app())[method](path).set('Host', `127.0.0.1:${PORT}`).set('X-Agent-Client', 'dashboard').send(body);

  it('logs a WhatsApp reply by hand, books a demo, and refuses mailbox reading without IMAP settings', async () => {
    await db.query(`INSERT INTO settings (key, value) VALUES ('senderName', '"Muri"')`);
    const ada = await contactedLead();
    const logged = await call('post', `/api/leads/${ada}/replies`, { channel: 'whatsapp', text: 'Abeg how much e cost?' }).expect(201);
    expect(logged.body.classification.label).toBe('question');
    expect(logged.body.answer.drafted.channel).toBe('whatsapp');

    const at = '2026-11-03T10:00:00+01:00';
    const booked = await call('post', `/api/leads/${ada}/demo`, { at, note: 'Zoom' }).expect(200);
    expect(booked.body).toMatchObject({ status: 'demo_booked', demo_source: 'user', demo_note: 'Zoom' });

    const saved = env.IMAP_PASSWORD;
    env.IMAP_PASSWORD = '';
    expect((await call('put', '/api/settings', { readReplies: true }).expect(422)).body.error.code).toBe('NOT_CONFIGURED');
    env.IMAP_PASSWORD = saved;
    await call('put', '/api/settings', { readReplies: true }).expect(200);
  });
});
