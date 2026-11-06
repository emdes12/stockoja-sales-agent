import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { hasTestDb, resetDb, testDb } from './helpers.js';
import type { Db } from '../src/db/pool.js';
import { env } from '../src/config.js';
import { logger } from '../src/log.js';
import { settingsSchema, updateSettings, type Settings } from '../src/settings.js';
import { upsertLead, type LeadCandidate } from '../src/leads/leads.js';
import { seedOutreach } from '../src/outreach/seed.js';
import type { MessageRow } from '../src/outreach/messages.js';
import { maybeAutoApprove } from '../src/outreach/autonomy.js';
import { sendingDelay, sendingHandlers, TASK_SEND_EMAIL } from '../src/outreach/sending.js';
import { AiCallError, aiDeps, generateResilient, modelChain, pickBackups, resetModelState, type GenerateRequest } from '../src/ai/gemini.js';
import { draftOutreach } from '../src/ai/write.js';
import { autoAnswer, recordReply } from '../src/inbox/process.js';
import { telegramDeps } from '../src/telegram/bot.js';
import { checkTelegram } from '../src/telegram/inbox.js';
import { telegramSendHandlers, TASK_SEND_TELEGRAM } from '../src/telegram/send.js';
import type { Task } from '../src/queue/queue.js';
import { Agent } from '../src/agent/controller.js';
import { createApp } from '../src/server/app.js';

const stubs = { ...aiDeps };
const saved = { model: env.GEMINI_MODEL, fallback: env.GEMINI_FALLBACK_MODELS };
let sleeps: number[] = [];
let tried: string[] = [];
const ok = (model: string, text = 'Hello') => ({ text, inputTokens: 100, outputTokens: 50, model, finishReason: 'STOP' });

beforeEach(() => {
  sleeps = [];
  tried = [];
  resetModelState();
  aiDeps.sleep = async (ms) => void sleeps.push(ms);
});
afterEach(() => {
  Object.assign(aiDeps, stubs);
  env.GEMINI_MODEL = saved.model;
  env.GEMINI_FALLBACK_MODELS = saved.fallback;
  env.GEMINI_API_KEY = '';
});

describe('busy Gemini: retries, then a backup model (no database)', () => {
  it('picks stable Flash models, newest first, Flash before Flash-Lite', () => {
    const available = ['gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-flash', 'gemini-2.0-flash', 'gemini-3.1-flash-preview-09', 'gemini-3.1-pro', 'gemini-2.5-flash-lite'];
    expect(pickBackups(available, 'gemini-2.5-flash')).toEqual(['gemini-3.1-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite']);
  });

  it('retries a busy model twice with growing waits, then uses the backup, and rests the busy one', async () => {
    env.GEMINI_MODEL = 'primary';
    env.GEMINI_FALLBACK_MODELS = 'backup';
    aiDeps.generate = async (req: GenerateRequest) => {
      tried.push(req.model!);
      if (req.model === 'primary') throw new AiCallError('AI_UNAVAILABLE', 'HTTP 503 high demand', 'busy');
      return ok(req.model!);
    };
    expect((await generateResilient({ system: 's', prompt: 'p', maxOutputTokens: 10 })).model).toBe('backup');
    expect(tried).toEqual(['primary', 'primary', 'primary', 'backup']);
    expect(sleeps).toEqual([2000, 6000]);

    tried = [];
    await generateResilient({ system: 's', prompt: 'p', maxOutputTokens: 10 });
    expect(tried).toEqual(['backup']); // primary is resting
  });

  it('skips a model out of quota at once; stops at once when the request itself is refused', async () => {
    env.GEMINI_MODEL = 'primary';
    env.GEMINI_FALLBACK_MODELS = 'backup';
    aiDeps.generate = async (req) => {
      tried.push(req.model!);
      if (req.model === 'primary') throw new AiCallError('AI_RATE_LIMITED', '429', 'quota');
      return ok(req.model!);
    };
    await generateResilient({ system: 's', prompt: 'p', maxOutputTokens: 10 });
    expect(tried).toEqual(['primary', 'backup']);
    expect(sleeps).toEqual([]);

    resetModelState();
    tried = [];
    aiDeps.generate = async (req) => {
      tried.push(req.model!);
      throw new AiCallError('AI_FAILED', 'HTTP 400 bad request', 'refused');
    };
    await expect(generateResilient({ system: 's', prompt: 'p', maxOutputTokens: 10 })).rejects.toThrow('HTTP 400');
    expect(tried).toEqual(['primary']);
  });

  it('finds backups for the key when none are set, and says when every model failed', async () => {
    env.GEMINI_MODEL = 'gemini-2.5-flash';
    env.GEMINI_FALLBACK_MODELS = '';
    aiDeps.listModels = async () => ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'text-embedding-004'];
    expect(await modelChain()).toEqual({ models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'], source: 'auto' });
    aiDeps.generate = async () => {
      throw new AiCallError('AI_UNAVAILABLE', 'HTTP 503', 'busy');
    };
    await expect(generateResilient({ system: 's', prompt: 'p', maxOutputTokens: 10 })).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
      message: expect.stringContaining('tried gemini-2.5-flash, gemini-2.5-flash-lite'),
    });
  });
});

// ── With the database ─────────────────────────────────────────────────────────

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

const settings: Settings = settingsSchema.parse({ senderName: 'Muri', readReplies: true });
const ctx = (s: Settings) => ({ db, signal: new AbortController().signal, settings: s, log: logger('test') });
const lead = (extra: Partial<LeadCandidate> = {}): LeadCandidate => ({
  business_name: 'Ada Styles', category: 'fashion', source: 'osm', source_ref: 'node/1', state: 'Lagos',
  phone: '08031234567', email: 'info@ada.ng', facts: [], socials: { instagram: 'https://instagram.com/adastyles', telegram: '@adastyles' }, ...extra,
});
const row = async (id: number) => (await db.query<MessageRow>('SELECT * FROM messages WHERE id = $1', [id])).rows[0]!;

d('AI-first drafting', () => {
  it('writes outreach for each lead on any channel; the agent adds the link and STOP; AI outreach is never auto-approved', async () => {
    env.GEMINI_API_KEY = 'test-key-not-real';
    const prompts: GenerateRequest[] = [];
    aiDeps.generate = async (req) => {
      prompts.push(req);
      return ok(req.model!, 'Hello Ada Styles. Fashion shops lose sales when stock runs out unnoticed; StockỌja keeps count for you.');
    };
    const { leadId } = await upsertLead(db, lead(), 70);
    const msg = await draftOutreach(db, leadId, 'instagram', settings, { createdBy: 'agent' });
    expect(msg).toMatchObject({ channel: 'instagram', step: 'intro', ai_generated: true, status: 'draft' });
    expect(msg.body).toContain('Fashion shops lose sales');
    expect(msg.body).toMatch(/Try it free: https?:\/\//);
    expect(msg.body).toContain('reply STOP');
    expect(prompts[0]!.system).toContain('Instagram direct message');
    const auto = { ...settings, mode: 'autonomous' as const, autoApproveIntros: true, autoApproveMinScore: 0 };
    expect(await maybeAutoApprove(db, msg.id, auto)).toBeNull();
  });

  it('uses the template, and says why on the draft, when Gemini stays busy', async () => {
    env.GEMINI_API_KEY = 'test-key-not-real';
    aiDeps.generate = async () => {
      throw new AiCallError('AI_UNAVAILABLE', 'Gemini primary is busy or down (HTTP 503)', 'busy');
    };
    const { leadId } = await upsertLead(db, lead(), 70);
    const msg = await draftOutreach(db, leadId, 'email', settings, { createdBy: 'agent' });
    expect(msg.ai_generated).toBe(false);
    expect(msg.status_reason).toMatch(/^Template used: Gemini could not write this right now/);
    expect(msg.body).toContain('Ada Styles');
  });

  it('answers a message with AI first, falls back to the knowledge base, and auto-sends only grounded answers', async () => {
    env.GEMINI_API_KEY = 'test-key-not-real';
    aiDeps.generate = async (req) => ok(req.model!, 'Yes, it works offline and syncs later.');
    const { leadId } = await upsertLead(db, lead(), 70);
    const rec = (await recordReply(db, leadId, { channel: 'email', from: 'info@ada.ng', subject: 'Question', text: 'Does it work offline? How much is it?', date: null, messageId: '<q1@ada.ng>', source: 'imap' }))!;
    const answer = await autoAnswer(db, rec.msg, settings);
    expect(answer && 'drafted' in answer && answer.drafted.ai_generated).toBe(true);
    // Not grounded in any knowledge here, so even with auto-send on it waits for you.
    const auto = { ...settings, mode: 'autonomous' as const, replyAutonomy: { ...settings.replyAutonomy, email: 'auto_send' as const } };
    expect(await maybeAutoApprove(db, (answer as { drafted: MessageRow }).drafted.id, auto)).toBeNull();

    // AI unavailable, AI answers off for the KB: nothing drafted, and it says why.
    aiDeps.generate = async () => {
      throw new AiCallError('AI_UNAVAILABLE', 'busy', 'busy');
    };
    const rec2 = (await recordReply(db, leadId, { channel: 'email', from: 'info@ada.ng', subject: 'Another', text: 'Can I add staff? Is there a price?', date: null, messageId: '<q2@ada.ng>', source: 'imap' }))!;
    expect(await autoAnswer(db, rec2.msg, { ...settings, autoDraftReplies: false })).toMatchObject({ skipped: 'AI_UNAVAILABLE' });
    // "Off" for the channel: no draft at all.
    expect(await autoAnswer(db, rec2.msg, { ...settings, replyAutonomy: { ...settings.replyAutonomy, email: 'off' } })).toBeNull();
  });
});

// ── Telegram, with a fake Telegram ────────────────────────────────────────────

interface TgCall { method: string; body: Record<string, unknown> }
let tgCalls: TgCall[] = [];
let tgRoutes: Record<string, (b: Record<string, unknown>) => { ok: boolean; result?: unknown; error_code?: number; description?: string }> = {};
const realTgFetch = telegramDeps.fetch;

const update = (id: number, chat: number, text: string, from: { username?: string; first_name?: string } = {}, type = 'private') => ({
  update_id: id,
  message: { message_id: id * 10, date: Math.floor(Date.now() / 1000), text, chat: { id: chat, type }, from: { id: chat, is_bot: false, ...from } },
});

d('Telegram bot inbox and answers', () => {
  const PORT = 6396;
  const app = () =>
    createApp({ db, agent: new Agent(db, {}, 50), recovery: { requeued: 0, heldInterrupted: 0, heldOverdue: 0, at: new Date(), wasRunningAtShutdown: false }, port: PORT, shutdown: async () => {} });
  const host = (r: request.Test) => r.set('Host', `127.0.0.1:${PORT}`).set('X-Agent-Client', 'dashboard');

  beforeEach(() => {
    tgCalls = [];
    env.TELEGRAM_BOT_TOKEN = `123456:${'a'.repeat(35)}`;
    env.TELEGRAM_API_URL = 'http://telegram.test';
    telegramDeps.fetch = async (url, init) => {
      const method = url.split('/').pop()!;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      tgCalls.push({ method, body });
      const r = tgRoutes[method]?.(body) ?? { ok: false, error_code: 404, description: 'Not Found' };
      return new Response(JSON.stringify(r), { status: r.ok ? 200 : r.error_code ?? 400, headers: { 'content-type': 'application/json' } });
    };
  });
  afterEach(() => {
    telegramDeps.fetch = realTgFetch;
    env.TELEGRAM_BOT_TOKEN = '';
  });

  it('reads private messages to the bot, matches leads by username, and answers back through the bot', async () => {
    await updateSettings(db, { senderName: 'Muri' });
    const { leadId } = await upsertLead(db, lead(), 70);
    let batch = [
      update(1, 501, '/start', { username: 'kemi_shop' }),
      update(2, 501, 'Hello, how much is the Growth plan?', { username: 'kemi_shop', first_name: 'Kemi' }),
      update(3, -900, 'group chatter', { username: 'someone' }, 'group'),
      update(4, 777, 'Interested. How do I start?', { username: 'adastyles' }),
    ];
    tgRoutes = { getUpdates: () => ({ ok: true, result: batch }) };
    const r = await checkTelegram(db, settings);
    expect(r).toMatchObject({ updates: 4, messages: 2, fromLeads: 1 });
    const inbound = (await db.query<MessageRow & { from_address: string; external_message_id: string }>(`SELECT * FROM messages WHERE direction = 'inbound' ORDER BY id`)).rows;
    expect(inbound.map((m) => [m.lead_id, m.from_address, m.external_message_id])).toEqual([
      [null, '@kemi_shop', 'telegram:501:20'],
      [leadId, '@adastyles', 'telegram:777:40'],
    ]);

    // The next check asks only for newer updates; a repeat is harmless.
    batch = [];
    await checkTelegram(db, settings);
    expect(tgCalls.at(-1)).toMatchObject({ method: 'getUpdates', body: { offset: 5 } });

    // Your answer from the inbox goes back through the bot, once.
    const kemi = inbound[0]!;
    const sent = await host(request(app()).post(`/api/inbox/${kemi.id}/reply`)).send({ body: 'Growth is ₦5,000 a month.', send: true, optOut: true }).expect(201);
    expect(sent.body).toMatchObject({ sent: true });
    const task = (await db.query<Task>(`SELECT * FROM tasks WHERE type = $1`, [TASK_SEND_TELEGRAM])).rows[0]!;
    tgRoutes.sendMessage = () => ({ ok: true, result: { message_id: 99 } });
    expect(await telegramSendHandlers[TASK_SEND_TELEGRAM]!.run(task, ctx(settings))).toEqual({ sent: true });
    const out = await row(sent.body.message.id);
    expect(out).toMatchObject({ status: 'sent', provider_message_id: '99', to_address: 'kemi_shop', lead_id: null });
    const call = tgCalls.find((c) => c.method === 'sendMessage')!;
    expect(call.body.chat_id).toBe(501);
    expect(String(call.body.text)).toContain('reply STOP');
    expect(await telegramSendHandlers[TASK_SEND_TELEGRAM]!.run(task, ctx(settings))).toEqual({ skipped: 'message is sent' });
  });

  it('sends a new message through the bot to someone who wrote to it, found by their username', async () => {
    await updateSettings(db, { senderName: 'Muri' });
    tgRoutes = { getUpdates: () => ({ ok: true, result: [update(1, 701, 'Hi', { username: 'bola_store' })] }) };
    await checkTelegram(db, settings);
    const sent = await host(request(app()).post('/api/inbox/compose')).send({ channel: 'telegram', to: '@Bola_Store', body: 'Following up: did you try it?', send: true }).expect(201);
    expect(sent.body).toMatchObject({ sent: true, message: { step: 'message', created_by: 'user', status: 'approved' } });
    const task = (await db.query<Task>(`SELECT * FROM tasks WHERE type = $1`, [TASK_SEND_TELEGRAM])).rows[0]!;
    tgRoutes.sendMessage = () => ({ ok: true, result: { message_id: 5 } });
    expect(await telegramSendHandlers[TASK_SEND_TELEGRAM]!.run(task, ctx(settings))).toEqual({ sent: true });
    expect(tgCalls.find((c) => c.method === 'sendMessage')!.body.chat_id).toBe(701);

    // Someone who never wrote to the bot: you send it yourself, from the chat link.
    const cold = await host(request(app()).post('/api/inbox/compose')).send({ channel: 'telegram', to: '@stranger', body: 'Hello', send: true }).expect(201);
    expect(cold.body).toMatchObject({ sent: false, chatLink: { url: expect.stringContaining('t.me/stranger') } });
  });

  it('hands the answer back to you when the person blocked the bot', async () => {
    await updateSettings(db, { senderName: 'Muri' });
    tgRoutes = { getUpdates: () => ({ ok: true, result: [update(1, 601, 'Do you have an app for phones?', { username: 'tunde' })] }) };
    await checkTelegram(db, settings);
    const msg = (await db.query<MessageRow>(`SELECT * FROM messages WHERE direction = 'inbound'`)).rows[0]!;
    const sent = await host(request(app()).post(`/api/inbox/${msg.id}/reply`)).send({ body: 'Yes, it works in the browser on any phone.', send: true }).expect(201);
    const task = (await db.query<Task>(`SELECT * FROM tasks WHERE type = $1`, [TASK_SEND_TELEGRAM])).rows[0]!;
    tgRoutes.sendMessage = () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
    await telegramSendHandlers[TASK_SEND_TELEGRAM]!.run(task, ctx(settings));
    expect(await row(sent.body.message.id)).toMatchObject({ status: 'approved', status_reason: expect.stringContaining('blocked your bot') });
  });
});

// ── The inbox from the app ────────────────────────────────────────────────────

d('inbox: paste-in, replies and contacts', () => {
  const PORT = 6395;
  const app = () =>
    createApp({ db, agent: new Agent(db, {}, 50), recovery: { requeued: 0, heldInterrupted: 0, heldOverdue: 0, at: new Date(), wasRunningAtShutdown: false }, port: PORT, shutdown: async () => {} });
  const host = (r: request.Test) => r.set('Host', `127.0.0.1:${PORT}`).set('X-Agent-Client', 'dashboard');

  it('pastes a LinkedIn message, matches the lead by profile, and lists it under LinkedIn', async () => {
    await updateSettings(db, { senderName: 'Muri' });
    const { leadId } = await upsertLead(db, lead({ socials: { linkedin: 'https://www.linkedin.com/company/ada-styles/' } }), 70);
    const r = await host(request(app()).post('/api/inbox/paste'))
      .send({ channel: 'linkedin', from: 'linkedin.com/company/ada-styles', text: 'Interested. Can you show me how it works?' })
      .expect(201);
    expect(r.body.message).toMatchObject({ lead_id: leadId, channel: 'linkedin', source: 'paste' });
    const list = await host(request(app()).get('/api/inbox?view=all&channel=linkedin')).expect(200);
    expect(list.body.data).toHaveLength(1);
    const counts = await host(request(app()).get('/api/inbox/counts')).expect(200);
    expect(counts.body.channels.linkedin).toMatchObject({ total: 1, not_lead: 0 });

    // Switched off: not accepted.
    await updateSettings(db, { inboxAccess: { ...settings.inboxAccess, tiktok: false } });
    await host(request(app()).post('/api/inbox/paste')).send({ channel: 'tiktok', from: '@x', text: 'hi' }).expect(422);
  });

  it('answers an email from someone who is not a lead, from the app, and the send goes to them', async () => {
    await updateSettings(db, { senderName: 'Muri' });
    const pasted = await host(request(app()).post('/api/inbox/paste'))
      .send({ channel: 'email', from: 'Buyer@Yahoo.com', text: 'Do you deliver to Abuja? How much is it?' })
      .expect(201);
    const inboundId = pasted.body.message.id;
    expect(pasted.body.message.lead_id).toBeNull();

    // Saved as a draft first, then sent: the same draft is reused, not a second one.
    await host(request(app()).post(`/api/inbox/${inboundId}/reply`)).send({ body: 'We do.', subject: 'Re: Delivery' }).expect(201);
    const sent = await host(request(app()).post(`/api/inbox/${inboundId}/reply`)).send({ body: 'Yes, we deliver to Abuja.', send: true }).expect(201);
    expect(sent.body.sent).toBe(true);
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE in_reply_to_id = $1`, [inboundId])).rows[0].n).toBe(1);
    const out = await row(sent.body.message.id);
    expect(out).toMatchObject({ lead_id: null, to_address: 'buyer@yahoo.com', subject: 'Re: Delivery', status: 'approved' });
    expect(out.body).not.toContain('STOP'); // only when you tick it
    expect(out.body).not.toMatch(/getting back to me/); // they wrote first
    expect((await db.query(`SELECT handled_at FROM messages WHERE id = $1`, [inboundId])).rows[0].handled_at).not.toBeNull();

    const task = (await db.query<Task>(`SELECT * FROM tasks WHERE type = $1`, [TASK_SEND_EMAIL])).rows[0]!;
    const dry = { ...settings, sendWindowStartHour: 0, sendWindowEndHour: 24, sendOnWeekends: true };
    expect(await sendingHandlers[TASK_SEND_EMAIL]!.run(task, ctx(dry))).toEqual({ dryRun: true });
    expect((await row(out.id)).status).toBe('dry_run');
  });

  it('marks a conversation read when opened, and unread again on request', async () => {
    await updateSettings(db, { senderName: 'Muri' });
    const a = await host(request(app()).post('/api/inbox/paste')).send({ channel: 'tiktok', from: '@reader', text: 'Hello?' }).expect(201);
    await host(request(app()).post('/api/inbox/paste')).send({ channel: 'tiktok', from: '@reader', text: 'Are you there?' }).expect(201);
    const unread = async () => (await host(request(app()).get('/api/inbox/counts')).expect(200)).body.channels.tiktok.unread;
    expect(await unread()).toBe(2);
    expect((await host(request(app()).get('/api/inbox?view=unread&channel=tiktok')).expect(200)).body.data).toHaveLength(2);
    expect((await host(request(app()).post(`/api/inbox/${a.body.message.id}/read`)).send({}).expect(200)).body).toEqual({ changed: 2 });
    expect(await unread()).toBe(0);
    await host(request(app()).post(`/api/inbox/${a.body.message.id}/read`)).send({ read: false }).expect(200);
    expect(await unread()).toBe(1);
    await host(request(app()).post('/api/inbox/999999/read')).send({}).expect(404);
  });

  it('writes a new message on any channel: email to an address, WhatsApp by chat link, several to one lead', async () => {
    await updateSettings(db, { senderName: 'Muri' });
    // Email needs a subject.
    await host(request(app()).post('/api/inbox/compose')).send({ channel: 'email', to: 'new@shop.ng', body: 'Hello', send: true }).expect(422);
    const email = await host(request(app()).post('/api/inbox/compose'))
      .send({ channel: 'email', to: 'New@Shop.ng', subject: 'StockỌja', body: 'Hello from StockỌja.', send: true })
      .expect(201);
    expect(email.body).toMatchObject({ sent: true, message: { to_address: 'new@shop.ng', subject: 'StockỌja', step: 'message', lead_id: null } });
    expect(email.body.message.body).toBe('Hello from StockỌja.');
    const withLine = await host(request(app()).post('/api/inbox/compose')).send({ channel: 'email', to: 'b@shop.ng', subject: 'Hi', body: 'Hello', optOut: true }).expect(201);
    expect(withLine.body.message.body).toContain('reply STOP');

    // WhatsApp: you send it, from the chat.
    const wa = await host(request(app()).post('/api/inbox/compose')).send({ channel: 'whatsapp', to: '0803 555 1234', body: 'Hello', send: true }).expect(201);
    expect(wa.body).toMatchObject({ sent: false, chatLink: { url: expect.stringContaining('wa.me/2348035551234') } });

    // To a lead: any number of your own messages, next to the agent's outreach.
    const { leadId } = await upsertLead(db, lead(), 70);
    for (const body of ['First note', 'Second note']) await host(request(app()).post('/api/inbox/compose')).send({ channel: 'email', leadId, subject: 'Hi', body }).expect(201);
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE lead_id = $1 AND step = 'message' AND status = 'draft'`, [leadId])).rows[0].n).toBe(2);
    await host(request(app()).post('/api/inbox/compose')).send({ channel: 'email', leadId: 999999, subject: 'Hi', body: 'x' }).expect(404);
  });

  it('sends messages you write outside sending hours; outreach still waits for them', async () => {
    const night = new Date('2026-10-28T02:00:00Z'); // a Wednesday, 03:00 in Lagos
    expect(await sendingDelay(db, settings, night)).toMatchObject({ why: expect.stringContaining('Outside sending hours') });
    expect(await sendingDelay(db, settings, night, { yours: true })).toBeNull();
  });

  it('ignores a contact (reversible), cancelling the agent drafts to them', async () => {
    await updateSettings(db, { senderName: 'Muri' });
    const pasted = await host(request(app()).post('/api/inbox/paste')).send({ channel: 'tiktok', from: '@spammy', text: 'Hello, how much is it?' }).expect(201);
    const contactId = pasted.body.message.social_contact_id;
    await host(request(app()).post(`/api/inbox/${pasted.body.message.id}/draft-reply`)).send({ mode: 'blank' }).expect(201);
    await db.query(`UPDATE messages SET created_by = 'agent' WHERE direction = 'outbound'`);
    await host(request(app()).post(`/api/inbox/contacts/${contactId}/ignore`)).send({ ignore: true }).expect(204);
    expect((await db.query(`SELECT status FROM messages WHERE direction = 'outbound'`)).rows).toEqual([{ status: 'cancelled' }]);
    const attention = await host(request(app()).get('/api/inbox?view=attention')).expect(200);
    expect(attention.body.data).toHaveLength(0);
    await host(request(app()).post(`/api/inbox/contacts/${contactId}/ignore`)).send({ ignore: false }).expect(204);
    await host(request(app()).post('/api/inbox/contacts/999999/ignore')).send({ ignore: true }).expect(404);
  });
});
