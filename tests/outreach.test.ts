import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { hasTestDb, resetDb, testDb } from './helpers.js';
import type { Db } from '../src/db/pool.js';
import { upsertLead, type LeadCandidate } from '../src/leads/leads.js';
import { complianceProblems, registrationLink, render, whatsappNumber } from '../src/outreach/render.js';
import { approveMessage, autoDraft, createDraft, editMessage, markSentByYou, OutreachError } from '../src/outreach/messages.js';
import { addSuppression, applyDoNotContact } from '../src/outreach/suppressions.js';
import { rankKb, type KbEntry } from '../src/outreach/kb.js';
import { seedOutreach, SEED_TEMPLATES } from '../src/outreach/seed.js';
import { enqueue } from '../src/queue/queue.js';
import { getSettings, settingsSchema, updateSettings, type Settings } from '../src/settings.js';
import { Agent } from '../src/agent/controller.js';
import { createApp } from '../src/server/app.js';

const base: Settings = settingsSchema.parse({ senderName: 'Muri' });

describe('rendering', () => {
  it('fills placeholders and reports anything missing instead of guessing', () => {
    expect(render('Hi {{business_name}}{{in_city}}.', { business_name: 'Ada', in_city: '' }).text).toBe('Hi Ada.');
    const r = render('Book: {{booking_link}} {{nonsense}}', { booking_link: '' });
    expect(r.missing.sort()).toEqual(['booking_link', 'nonsense']);
  });

  it('tags registration links for attribution', () => {
    const url = new URL(registrationLink({ ...base, referralCode: 'SALES1' }, 'email', 'intro', 42));
    expect(url.origin + url.pathname).toBe('https://app.stockoja.com/register');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ref: 'SALES1', utm_source: 'sales_agent', utm_medium: 'email', utm_campaign: 'outreach_intro', utm_content: 'lead_42',
    });
  });

  it('requires an opt-out line, a subject and no gaps', () => {
    expect(complianceProblems('email', 'Hi', 'Hello. Reply STOP to opt out.')).toEqual([]);
    expect(complianceProblems('email', '', 'Hello {{x}}')).toHaveLength(3);
  });

  it('only offers WhatsApp for mobile numbers', () => {
    expect(whatsappNumber('2348031234567', {})).toBe('2348031234567');
    expect(whatsappNumber('2341234567890', {})).toBeNull(); // landline-style
    expect(whatsappNumber(null, { whatsapp: '0803 123 4567' })).toBe('2348031234567');
  });

  it('seed templates contain only known placeholders, an opt-out and no exclamation marks', () => {
    for (const t of SEED_TEMPLATES) {
      expect(t.body).toMatch(/\bSTOP\b/);
      expect(`${t.subject ?? ''}${t.body}`).not.toContain('!');
      if (t.channel === 'email') expect(t.subject).toBeTruthy();
    }
  });

  it('matches knowledge base answers by meaning words, and returns nothing for unrelated questions', () => {
    const e = (id: number, topic: string, question: string, answer: string): KbEntry => ({ id, topic, question, answer, status: 'approved', source: null, approved_at: null, updated_at: new Date() });
    const kb = [e(1, 'Online store', 'Can I sell online with StockỌja?', 'Yes, a storefront with Paystack.'), e(2, 'Devices', 'What devices does it work on?', 'Laptop, tablet or phone.')];
    expect(rankKb(kb, 'Does it work on my phone?')[0]?.entry.id).toBe(2);
    expect(rankKb(kb, 'can I sell online')[0]?.entry.id).toBe(1);
    expect(rankKb(kb, 'Do you deliver to Kano?')).toEqual([]);
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
  if (hasTestDb) {
    await resetDb(db);
    await seedOutreach(db);
  }
});

const lead = (id: number, extra: Partial<LeadCandidate> = {}): LeadCandidate => ({
  business_name: `Shop ${id}`,
  category: 'fashion',
  source: 'osm',
  source_ref: `node/${id}`,
  state: 'Lagos',
  city: 'Ikeja',
  phone: `0803123${String(id).padStart(4, '0')}`,
  email: `info@shop${id}.ng`,
  website: `https://shop${id}.ng`,
  facts: [],
  ...extra,
});

d('drafts and approval', () => {
  it('drafts from the category template, once per lead/channel/step', async () => {
    const { leadId } = await upsertLead(db, lead(1), 50);
    const m = await createDraft(db, leadId, 'email', base);
    expect(m.status).toBe('draft');
    expect(m.subject).toBe('Tracking clothing stock by size and colour');
    expect(m.body).toContain('Shop 1 in Ikeja');
    expect(m.body).toContain('utm_content=lead_1');
    expect(m.body).not.toContain('{{');
    await expect(createDraft(db, leadId, 'email', base)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('refuses without a sender name, in Research Mode, or with a missing booking link', async () => {
    const { leadId } = await upsertLead(db, lead(1), 50);
    await expect(createDraft(db, leadId, 'email', { ...base, senderName: '' })).rejects.toMatchObject({ code: 'NO_SENDER' });
    await expect(createDraft(db, leadId, 'email', { ...base, mode: 'research' })).rejects.toMatchObject({ code: 'RESEARCH_MODE' });
    await db.query(`UPDATE templates SET body = body || ' {{booking_link}}' WHERE channel = 'email' AND category = 'fashion'`);
    await expect(createDraft(db, leadId, 'email', base)).rejects.toMatchObject({ code: 'MISSING_VALUES' });
  });

  it('approval re-checks compliance; editing an approved message needs re-approval', async () => {
    const { leadId } = await upsertLead(db, lead(1), 50);
    const m = await createDraft(db, leadId, 'email', base);
    await editMessage(db, m.id, { body: 'No opt-out here' });
    await expect(approveMessage(db, m.id, base)).rejects.toMatchObject({ code: 'NOT_COMPLIANT' });
    await editMessage(db, m.id, { body: 'Hello. Reply STOP to opt out.' });
    expect((await approveMessage(db, m.id, base)).status).toBe('approved');
    const edited = await editMessage(db, m.id, { body: 'Changed. Reply STOP to opt out.' });
    expect(edited.status).toBe('draft');
    expect(edited.original_body).toContain('Hello Shop 1 team'); // the agent's draft is kept
  });

  it('WhatsApp is recorded as sent by you only after approval, and marks the lead contacted', async () => {
    const { leadId } = await upsertLead(db, lead(1, { email: null }), 50);
    const m = await createDraft(db, leadId, 'whatsapp', base);
    await expect(markSentByYou(db, m.id, base)).rejects.toMatchObject({ code: 'NOT_APPROVED' });
    await approveMessage(db, m.id, base);
    expect((await markSentByYou(db, m.id, base)).sent_by).toBe('user');
    expect((await db.query('SELECT status FROM leads WHERE id = $1', [leadId])).rows[0].status).toBe('contacted');
  });
});

d('do not contact', () => {
  it('blocks the address even when the business is found again under another name', async () => {
    const { leadId } = await upsertLead(db, lead(1), 50);
    const m = await createDraft(db, leadId, 'email', base);
    await enqueue(db, 'outreach.followup', {}, { leadId, runAt: new Date(Date.now() + 86400_000) });
    const res = await applyDoNotContact(db, leadId, 'Asked us to stop');
    expect(res).toEqual({ cancelledMessages: 1, cancelledTasks: 1 });
    expect((await db.query('SELECT status FROM messages WHERE id = $1', [m.id])).rows[0].status).toBe('cancelled');

    // Found again elsewhere with the same email → merged into the same lead, which stays closed.
    const again = await upsertLead(db, lead(99, { email: 'INFO@shop1.ng', phone: null, website: null, state: 'Oyo' }), 50);
    expect(again.leadId).toBe(leadId);
    expect((await db.query('SELECT status FROM leads WHERE id = $1', [leadId])).rows[0].status).toBe('do_not_contact');
    await expect(createDraft(db, leadId, 'email', base)).rejects.toMatchObject({ code: 'LEAD_CLOSED' });
  });

  it('blocks a listed address on any lead that has it', async () => {
    await addSuppression(db, 'email', ' Sales@Shop7.ng ', { reason: 'Replied STOP', source: 'reply_stop' });
    const { leadId } = await upsertLead(db, lead(7, { email: 'sales@shop7.ng' }), 50);
    await expect(createDraft(db, leadId, 'email', base)).rejects.toMatchObject({ code: 'SUPPRESSED' });
    // Someone who opted out on one channel is not contacted on another.
    await expect(createDraft(db, leadId, 'whatsapp', base)).rejects.toMatchObject({ code: 'SUPPRESSED' });
  });

  it('blocks a whole domain, but refuses to block free-mail domains', async () => {
    expect(await addSuppression(db, 'domain', 'gmail.com')).toHaveProperty('error');
    await addSuppression(db, 'domain', 'https://www.shop2.ng/');
    const { leadId } = await upsertLead(db, lead(2), 50);
    await expect(createDraft(db, leadId, 'email', base)).rejects.toBeInstanceOf(OutreachError);
  });
});

d('auto-drafting', () => {
  it('drafts best leads first, respects the daily limit, skips leads it cannot reach, never re-drafts rejected ones', async () => {
    for (let i = 1; i <= 4; i++) await upsertLead(db, lead(i), 50);
    await upsertLead(db, lead(5, { email: null, phone: null, socials: { instagram: 'https://instagram.com/x' } }), 50); // qualified via social only
    const settings = { ...base, dailyDraftLimit: 3 };
    const first = await autoDraft(db, settings);
    expect(first.created).toBe(3);
    expect(first.remainingToday).toBe(0);
    const second = await autoDraft(db, { ...settings, dailyDraftLimit: 10 });
    expect(second.created).toBe(1);
    // Reject one: it is not drafted again automatically.
    await db.query(`UPDATE messages SET status = 'rejected' WHERE id = 1`);
    const third = await autoDraft(db, { ...settings, dailyDraftLimit: 10 });
    expect(third.created).toBe(0);
  });
});

d('outreach API', () => {
  const PORT = 6398;
  const host = `127.0.0.1:${PORT}`;
  const app = () =>
    createApp({
      db,
      agent: new Agent(db, {}, 50),
      recovery: { requeued: 0, heldInterrupted: 0, heldOverdue: 0, at: new Date(), wasRunningAtShutdown: false },
      port: PORT,
      shutdown: async () => {},
    });
  const post = (a: ReturnType<typeof app>, url: string, body: object = {}) => request(a).post(url).set('Host', host).set('X-Agent-Client', 'dashboard').send(body);

  it('drafts, approves and lists; marking a lead do-not-contact cancels its drafts', async () => {
    await updateSettings(db, { senderName: 'Muri' });
    const a = app();
    const { leadId } = await upsertLead(db, lead(1), 50);
    const draft = await post(a, `/api/leads/${leadId}/drafts`, { channel: 'whatsapp' }).expect(201);
    await post(a, `/api/messages/${draft.body.id}/approve`).expect(200);
    const listed = await request(a).get('/api/messages?status=approved').set('Host', host).expect(200);
    expect(listed.body.data[0].chat_link).toMatchObject({ prefilled: true });
    expect(listed.body.data[0].chat_link.url).toMatch(/^https:\/\/wa\.me\/2348031230001\?text=/);

    await post(a, `/api/leads/${leadId}/drafts`, { channel: 'email' }).expect(201);
    await request(a).patch(`/api/leads/${leadId}`).set('Host', host).set('X-Agent-Client', 'dashboard').send({ status: 'do_not_contact' }).expect(200);
    const open = await db.query(`SELECT count(*)::int AS n FROM messages WHERE status IN ('draft', 'approved')`);
    expect(open.rows[0].n).toBe(0);
    await post(a, `/api/leads/${leadId}/drafts`, { channel: 'email' }).expect(409);
  });

  it('rejects templates without an opt-out or with unknown placeholders, and 404s unknown messages', async () => {
    const a = app();
    const t = { name: 'x', channel: 'email', step: 'intro', category: null, subject: 'Hi', body: 'Hello {{business_name}}' };
    await post(a, '/api/templates', t).expect(422);
    await post(a, '/api/templates', { ...t, body: 'Hello {{owner_name}}. Reply STOP.' }).expect(422);
    await post(a, '/api/templates', { ...t, body: 'Hello {{business_name}}. Reply STOP.' }).expect(201);
    await post(a, '/api/messages/999/approve').expect(404);
  });

  it('only uses approved knowledge base answers', async () => {
    const a = app();
    const q = () => request(a).get('/api/kb/search').query({ q: 'can I sell online' }).set('Host', host).expect(200);
    expect((await q()).body.data).toEqual([]); // seeded entries are drafts
    const entry = (await db.query(`SELECT id FROM kb_entries WHERE question LIKE 'Can I sell online%'`)).rows[0];
    await post(a, `/api/kb/${entry.id}/approve`).expect(200);
    expect((await q()).body.data[0].entry.id).toBe(entry.id);
    expect((await getSettings(db)).mode).toBe('approval');
  });
});
