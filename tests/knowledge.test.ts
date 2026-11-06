import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { hasTestDb, resetDb, testDb } from './helpers.js';
import { env } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import { logger } from '../src/log.js';
import { settingsSchema, type Settings } from '../src/settings.js';
import { upsertLead, type LeadCandidate } from '../src/leads/leads.js';
import { seedOutreach } from '../src/outreach/seed.js';
import { approveMessage, editMessage } from '../src/outreach/messages.js';
import { maybeAutoApprove, returnAgentApprovals } from '../src/outreach/autonomy.js';
import { outreachHandlers, TASK_AUTO_DRAFT } from '../src/outreach/handlers.js';
import { chunkText } from '../src/knowledge/chunk.js';
import { htmlToText } from '../src/knowledge/html.js';
import { extractText } from '../src/knowledge/extract.js';
import { inScope } from '../src/knowledge/site.js';
import { addSource, rechunkSource, searchKnowledge, upsertPage } from '../src/knowledge/store.js';
import { aiDeps, type GenerateRequest } from '../src/ai/gemini.js';
import { createAiIntro, reviewAiText } from '../src/ai/write.js';
import { draftReply, recordReply } from '../src/inbox/process.js';
import { autostartDeps, autostartStatus, setAutostart } from '../src/system/autostart.js';
import { Agent } from '../src/agent/controller.js';
import { createApp } from '../src/server/app.js';
import type { Task } from '../src/queue/queue.js';

const DOC = `# StockỌja guide

StockỌja helps shops track stock, record sales and see profit.

## Pricing

The Starter plan is free for one store. The Growth plan costs ₦5,000 per month and adds staff accounts and an online store.

## Online store

Every business gets a free online store link. Customers order on WhatsApp and you confirm in the app.

## Offline use

Sales recorded without internet are kept on the phone and sync when the connection returns.`;

describe('chunking (no database)', () => {
  it('follows headings, keeps each heading with its text, and stays within the size', () => {
    const chunks = chunkText(DOC, { strategy: 'structure', words: 30, overlap: 0 });
    expect(chunks.every((c) => c.wordCount <= 30)).toBe(true);
    const pricing = chunks.find((c) => c.content.includes('₦5,000'))!;
    expect(pricing.heading).toBe('StockỌja guide › Pricing');
    expect(pricing.content).toMatch(/^## Pricing/);
    expect(chunks.some((c) => /^#+ [^\n]+$/.test(c.content))).toBe(false); // no heading left alone
  });

  it('repeats overlap words within a section, and splits long paragraphs at sentences', () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} talks about inventory.`).join(' ');
    const chunks = chunkText(`# Long\n\n${long}`, { strategy: 'structure', words: 20, overlap: 6 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[1]!.content.startsWith('…')).toBe(true);
    const tail = chunks[0]!.content.split(/\s+/).slice(-3).join(' ');
    expect(chunks[1]!.content).toContain(tail);
    expect(chunks.every((c) => c.wordCount <= 20)).toBe(true);
  });

  it('fixed windows ignore layout; overlap is capped at half the size', () => {
    const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkText(words, { strategy: 'fixed', words: 40, overlap: 30 });
    // overlap capped at 20 → step 20 → windows start at 0, 20, 40, 60
    expect(chunks.map((c) => c.content.split(' ')[0])).toEqual(['w0', 'w20', 'w40', 'w60']);
    expect(chunks.at(-1)!.content.endsWith('w99')).toBe(true);
  });

  it('turns web pages into structured text and collects same-site links', () => {
    const html = `<html><head><title>Pricing | StockỌja</title><script>var x = 1</script></head><body>
      <nav><a href="/features">Features</a><a href="https://facebook.com/x">FB</a></nav>
      <main><h1>Pricing</h1><p>Simple   plans for <b>every</b> shop.</p><ul><li>Starter: free</li><li>Growth: ₦5,000</li></ul>
      <table><tr><th>Plan</th><th>Stores</th></tr><tr><td>Growth</td><td>3</td></tr></table></main>
      <footer>© 2026</footer></body></html>`;
    const r = htmlToText(html, 'https://stockoja.com/pricing');
    expect(r.title).toBe('Pricing | StockỌja');
    expect(r.text).toBe('# Pricing\n\nSimple plans for every shop.\n\n- Starter: free\n\n- Growth: ₦5,000\n\nPlan | Stores\n\nGrowth | 3');
    expect(r.links).toContain('https://stockoja.com/features');
    const site = new URL('https://stockoja.com/help/');
    expect(inScope('https://stockoja.com/help/start?x=1#top', site)).toBe('https://stockoja.com/help/start');
    expect(inScope('https://stockoja.com/blog', site)).toBeNull();
    expect(inScope('https://stockoja.com/help/logo.png', site)).toBeNull();
    expect(inScope('https://other.com/help/', site)).toBeNull();
  });

  it('reads text, Markdown, CSV and HTML files, and refuses what it cannot read', async () => {
    expect((await extractText('Price list.csv', Buffer.from('Plan,Price\nGrowth,"₦5,000"\n'))).text).toBe('Plan: Growth; Price: ₦5,000');
    expect((await extractText('guide.md', Buffer.from(DOC))).title).toBe('guide');
    expect((await extractText('page.html', Buffer.from('<h2>Hi</h2><p>There</p>'))).text).toBe('## Hi\n\nThere');
    await expect(extractText('old.doc', Buffer.from('x'))).rejects.toThrow('.docx');
    await expect(extractText('empty.txt', Buffer.from('  '))).rejects.toThrow('No text');
  });

  it('flags AI text that names times, adds links or invents figures', () => {
    const ctx = 'The Growth plan costs ₦5,000 per month.';
    expect(reviewAiText('Growth is ₦5,000 a month.', ctx)).toEqual([]);
    const w = reviewAiText('Shall we talk on Tuesday at 10am? See www.x.com. It costs ₦9,000 [Your name]', ctx);
    expect(w.map((x) => [x.code, x.blocking])).toEqual([['time', true], ['link', true], ['placeholder', true], ['figures', false]]);
    expect(w.find((x) => x.code === 'figures')!.text).toContain('₦9,000');
  });
});

describe('start with Windows (no database)', () => {
  it('writes a launcher only it recognises, and removes only its own', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'startup-'));
    const orig = { ...autostartDeps };
    autostartDeps.startupDir = () => dir;
    autostartDeps.platform = () => 'win32';
    try {
      expect(await autostartStatus()).toMatchObject({ supported: true, enabled: false });
      const on = await setAutostart(true);
      expect(on.enabled).toBe(true);
      const content = await readFile(on.path!, 'utf8');
      expect(content).toContain('start-agent.bat" --background');
      const off = await setAutostart(false);
      expect(off.enabled).toBe(false);
      expect(existsSync(on.path!)).toBe(false);
      autostartDeps.platform = () => 'linux';
      await expect(setAutostart(true)).rejects.toThrow('only available on Windows');
    } finally {
      Object.assign(autostartDeps, orig);
    }
  });
});

// ── With the test database ────────────────────────────────────────────────────

const d = hasTestDb ? describe : describe.skip;
let db: Db;
const settings: Settings = settingsSchema.parse({ senderName: 'Muri', readReplies: true, knowledgeChunkWords: 60, knowledgeChunkOverlap: 10 });
const opts = { strategy: 'structure' as const, words: 60, overlap: 10 };
const lead = (extra: Partial<LeadCandidate> = {}): LeadCandidate => ({
  business_name: 'Ada Styles', category: 'fashion', source: 'osm', source_ref: 'node/1', state: 'Lagos',
  phone: '08031234567', email: 'info@ada.ng', website: 'https://ada.ng', facts: [], ...extra,
});

let aiCalls: GenerateRequest[] = [];
let aiReply = 'The Growth plan costs ₦5,000 per month and includes an online store.';
const origDeps = { ...aiDeps };

beforeAll(async () => {
  if (hasTestDb) db = await testDb();
  env.GEMINI_API_KEY = 'test-key-not-real';
  env.IMAP_HOST = 'imap.test.invalid';
  env.IMAP_USER = 'hello@stockoja.com';
  env.IMAP_PASSWORD = 'not-a-real-password';
  env.OUTREACH_REPLY_TO = 'hello@stockoja.com';
  aiDeps.listModels = async () => [];
  aiDeps.sleep = async () => {};
  aiDeps.generate = async (req) => {
    aiCalls.push(req);
    return { text: aiReply, inputTokens: 1000, outputTokens: 200, model: 'gemini-test', finishReason: 'STOP' };
  };
});
afterAll(async () => {
  Object.assign(aiDeps, origDeps);
  env.GEMINI_API_KEY = '';
  await db?.end();
});
beforeEach(async () => {
  aiCalls = [];
  aiReply = 'The Growth plan costs ₦5,000 per month and includes an online store.';
  if (hasTestDb) {
    await resetDb(db);
    await seedOutreach(db);
  }
});

d('knowledge store', () => {
  it('stores documents as chunks and finds them by words (full-text) when vectors are off', async () => {
    const src = await addSource(db, { kind: 'file', title: 'Guide', text: DOC, origin: 'guide.md' }, opts);
    expect(src.chunk_count).toBeGreaterThan(1);
    const { hits, mode } = await searchKnowledge(db, 'how much is the growth plan per month?');
    expect(mode).toBe('words');
    expect(hits[0]!.content).toContain('₦5,000');
    expect(hits[0]).toMatchObject({ title: 'Guide', heading: expect.stringMatching(/^StockỌja guide/), matchedBy: ['words'] });

    // Disabled documents are not searched; re-chunking uses the saved text.
    await db.query('UPDATE knowledge_sources SET enabled = false WHERE id = $1', [src.id]);
    expect((await searchKnowledge(db, 'growth plan')).hits).toEqual([]);
    const fixed = await rechunkSource(db, src.id, { strategy: 'fixed', words: 30, overlap: 5 });
    expect(fixed).toMatchObject({ strategy: 'fixed', chunk_words: 30, chunk_overlap: 5 });
    expect(fixed.chunk_count).toBeGreaterThan(src.chunk_count);
  });

  it('re-reads a web page only when its text changed', async () => {
    const page = { url: 'https://stockoja.com/pricing', siteRoot: 'https://stockoja.com/', title: 'Pricing', text: DOC };
    expect((await upsertPage(db, page, opts)).changed).toBe(true);
    const chunkIds = (await db.query('SELECT id FROM knowledge_chunks ORDER BY id')).rows;
    expect((await upsertPage(db, page, opts)).changed).toBe(false);
    expect((await db.query('SELECT id FROM knowledge_chunks ORDER BY id')).rows).toEqual(chunkIds);
    expect((await upsertPage(db, { ...page, text: `${DOC}\n\nNew: a desktop app.` }, opts)).changed).toBe(true);
    expect((await db.query(`SELECT count(*)::int AS n FROM knowledge_sources`)).rows[0].n).toBe(1);
  });
});

d('AI drafting (fake model, no real calls)', () => {
  async function inboundQuestion(text = 'How much is the Growth plan?') {
    const { leadId } = await upsertLead(db, lead(), 50);
    await db.query(`UPDATE leads SET status = 'contacted' WHERE id = $1`, [leadId]);
    const r = await recordReply(db, leadId, { channel: 'email', from: 'info@ada.ng', subject: 'Re: Hello', text, date: new Date(), messageId: '<q1@test>', autoHeaders: [], source: 'imap' });
    return r!.msg;
  }

  it('writes a reply from your knowledge, marks it AI-written, and records the cost', async () => {
    await addSource(db, { kind: 'file', title: 'Guide', text: DOC, origin: 'guide.md' }, opts);
    const inbound = await inboundQuestion();
    const r = await draftReply(db, inbound.id, settings, 'ai', 'user');
    if (!('drafted' in r)) throw new Error('expected a draft');
    expect(r.drafted).toMatchObject({ ai_generated: true, step: 'reply', status: 'draft' });
    expect(r.drafted.body).toContain('₦5,000');
    expect(r.drafted.body).not.toMatch(/reply STOP/);
    // The model got the relevant chunk and never the lead's phone number or email.
    expect(aiCalls[0]!.prompt).toContain('Growth plan costs ₦5,000');
    expect(aiCalls[0]!.prompt).not.toContain('08031234567');
    expect(aiCalls[0]!.prompt).not.toContain('info@ada.ng');
    const usage = (await db.query(`SELECT kind, units, estimated_usd FROM usage_events WHERE provider = 'gemini'`)).rows;
    expect(usage).toEqual([{ kind: 'draft_reply', units: 1200, estimated_usd: '0.000800' }]); // 1000×0.30 + 200×2.50 per million
  });

  it('reads the conversation so far, follows your instructions, and opens to fit who wrote first', async () => {
    // We wrote first (an intro that went out), they answered: "thanks for getting back to me", and the AI sees both.
    const { leadId } = await upsertLead(db, lead(), 50);
    await db.query(
      `INSERT INTO messages (lead_id, channel, step, to_address, subject, body, status, sent_at, sent_by)
       VALUES ($1, 'email', 'intro', 'info@ada.ng', 'Hello', 'Our intro about stock tracking', 'sent', now() - interval '2 days', 'provider')`,
      [leadId],
    );
    await db.query(
      `INSERT INTO messages (lead_id, channel, step, to_address, subject, body, status)
       VALUES ($1, 'email', 'followup_1', 'info@ada.ng', 'Re: Hello', 'A draft that never went', 'draft')`,
      [leadId],
    );
    const r1 = await recordReply(db, leadId, { channel: 'email', from: 'info@ada.ng', subject: 'Re: Hello', text: 'Do you support many shops?', date: new Date(Date.now() - 3600_000), messageId: '<h1@test>', autoHeaders: [], source: 'imap' });
    const r2 = await recordReply(db, leadId, { channel: 'email', from: 'info@ada.ng', subject: 'Re: Hello', text: 'And what does it cost?', date: new Date(), messageId: '<h2@test>', autoHeaders: [], source: 'imap' });
    const mine = { ...settings, aiInstructions: 'Always be brief. House style rule XYZ.' };
    const d1 = await draftReply(db, r2!.msg.id, mine, 'ai');
    if (!('drafted' in d1)) throw new Error('expected a draft');
    const call = aiCalls.at(-1)!;
    expect(call.system).toContain('House style rule XYZ');
    expect(call.system).toContain('You write on behalf of Muri');
    expect(call.prompt).toMatch(/CONVERSATION SO FAR[\s\S]*You: Our intro about stock tracking\nThem: Do you support many shops\?/);
    expect(call.prompt).not.toContain('A draft that never went');
    expect(call.prompt).toContain('THEIR LATEST MESSAGE');
    expect(d1.drafted.body).toMatch(/^Hello,\n\nThanks for getting back to me\./);

    // No history wanted: only the latest message.
    await draftReply(db, r1!.msg.id, { ...mine, aiReplyHistory: 0 }, 'ai');
    expect(aiCalls.at(-1)!.prompt).not.toContain('CONVERSATION SO FAR');
  });

  it('blocks approval of an AI draft that names a time until you edit it', async () => {
    aiReply = 'Happy to explain. Can we talk on Tuesday at 10am?';
    const inbound = await inboundQuestion('Can you explain how it works?');
    const r = await draftReply(db, inbound.id, settings, 'ai', 'user');
    if (!('drafted' in r)) throw new Error('expected a draft');
    await expect(approveMessage(db, r.drafted.id, settings)).rejects.toThrow('names a day or time');
    await editMessage(db, r.drafted.id, { body: r.drafted.body.replace(' Can we talk on Tuesday at 10am?', '') });
    expect((await approveMessage(db, r.drafted.id, settings)).status).toBe('approved');
  });

  it('stops at the monthly budget and the daily call limit, before calling', async () => {
    const inbound = await inboundQuestion();
    await expect(draftReply(db, inbound.id, { ...settings, aiMonthlyBudgetUsd: 0 }, 'ai')).rejects.toMatchObject({ code: 'AI_BUDGET' });
    await expect(draftReply(db, inbound.id, { ...settings, aiDailyCallLimit: 0 }, 'ai')).rejects.toMatchObject({ code: 'AI_LIMIT' });
    expect(aiCalls).toHaveLength(0);
  });

  it('writes an introduction with your links, signature and opt-out added by the agent', async () => {
    aiReply = JSON.stringify({ subject: 'Stock tracking for Ada Styles', body: 'Hello Ada Styles team,\n\nTrack every size and colour you sell.' });
    const { leadId } = await upsertLead(db, lead(), 50);
    const msg = await createAiIntro(db, leadId, settings, 'user');
    expect(msg).toMatchObject({ subject: 'Stock tracking for Ada Styles', ai_generated: true, template_id: null });
    expect(msg.body).toContain('utm_campaign=outreach_intro');
    expect(msg.body).toContain('reply STOP');
    expect(aiCalls[0]!.json).toBe(true);
    await expect(createAiIntro(db, leadId, settings, 'user')).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });
});

d('Controlled Autonomous Mode', () => {
  const auto: Settings = { ...settings, mode: 'autonomous', autoApproveMinScore: 0, autoApproveDailyLimit: 2 };
  const runAutoDraft = (s: Settings) =>
    outreachHandlers[TASK_AUTO_DRAFT]!.run({ id: 1, type: TASK_AUTO_DRAFT, payload: {} } as Task, { db, settings: s, signal: new AbortController().signal, log: logger('test') });

  it('approves template drafts within the daily limit and queues their send', async () => {
    for (let i = 1; i <= 3; i++) await upsertLead(db, lead({ business_name: `Shop ${i}`, source_ref: `node/${i}`, email: `info@shop${i}.ng`, phone: null, website: null }), 0);
    await db.query(`UPDATE leads SET status = 'qualified', score = 70`);
    const r = (await runAutoDraft(auto)) as { created: number; autoApproved: number };
    expect(r).toMatchObject({ created: 3, autoApproved: 2 });
    const rows = (await db.query(`SELECT status, approved_by FROM messages ORDER BY id`)).rows;
    expect(rows.filter((m) => m.approved_by === 'agent')).toHaveLength(2);
    expect((await db.query(`SELECT count(*)::int AS n FROM tasks WHERE type = 'outreach.send_email'`)).rows[0].n).toBe(2);

    // Switching the mode off returns unsent agent approvals to you.
    expect(await returnAgentApprovals(db)).toBe(2);
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE status = 'draft'`)).rows[0].n).toBe(3);
  });

  it('never approves AI-written text, edited drafts, low-score leads, or anything outside the mode', async () => {
    aiReply = JSON.stringify({ subject: 'Hi', body: 'Hello Ada Styles team,\n\nA short note.' });
    const { leadId } = await upsertLead(db, lead(), 0);
    await db.query(`UPDATE leads SET status = 'qualified', score = 70 WHERE id = $1`, [leadId]);
    const ai = await createAiIntro(db, leadId, settings, 'agent');
    expect(await maybeAutoApprove(db, ai.id, auto)).toBeNull();
    await db.query(`UPDATE messages SET status = 'cancelled' WHERE id = $1`, [ai.id]); // a rejected intro would block a new one

    // The agent's own drafting now writes with AI too; that is held for you as well.
    aiReply = JSON.stringify({ subject: 'Stock for Ada Styles', body: 'Hello Ada Styles team,\n\nA short note about your stock.' });
    await runAutoDraft({ ...settings, mode: 'approval' });
    const aiAuto = (await db.query(`SELECT id, ai_generated FROM messages WHERE status = 'draft'`)).rows[0];
    expect(aiAuto.ai_generated).toBe(true);
    expect(await maybeAutoApprove(db, aiAuto.id, auto)).toBeNull();
    await db.query(`UPDATE messages SET status = 'cancelled' WHERE id = $1`, [aiAuto.id]);

    await runAutoDraft({ ...settings, mode: 'approval', aiDraftIntros: false });
    const draft = (await db.query(`SELECT id FROM messages WHERE status = 'draft'`)).rows[0];
    expect(await maybeAutoApprove(db, draft.id, { ...auto, autoApproveMinScore: 80 })).toBeNull();
    expect(await maybeAutoApprove(db, draft.id, { ...auto, autoApproveIntros: false })).toBeNull();
    expect(await maybeAutoApprove(db, draft.id, { ...auto, mode: 'approval' })).toBeNull();
    expect((await maybeAutoApprove(db, draft.id, auto))?.approved_by).toBe('agent');
  });
});

d('stage 6 API', () => {
  const PORT = 6397;
  const app = () =>
    createApp({ db, agent: new Agent(db, {}, 50), recovery: { requeued: 0, heldInterrupted: 0, heldOverdue: 0, at: new Date(), wasRunningAtShutdown: false }, port: PORT, shutdown: async () => {} });
  const host = (r: request.Test) => r.set('Host', `127.0.0.1:${PORT}`).set('X-Agent-Client', 'dashboard');

  it('uploads a document, searches it, and checks chunk settings', async () => {
    const up = await host(request(app()).post('/api/knowledge/upload?name=Pricing.md&words=60&overlap=10'))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(DOC))
      .expect(201);
    expect(up.body).toMatchObject({ title: 'Pricing', kind: 'file', chunk_words: 60, chunk_overlap: 10 });
    const s = await host(request(app()).get('/api/knowledge/search?q=offline%20internet')).expect(200);
    expect(s.body.hits[0].content).toContain('sync when the connection returns');
    await host(request(app()).post('/api/knowledge/upload?name=x.exe')).set('Content-Type', 'application/octet-stream').send(Buffer.from('MZ')).expect(422);
    await host(request(app()).put('/api/settings')).send({ knowledgeChunkWords: 60, knowledgeChunkOverlap: 40 }).expect(422);
    await host(request(app()).delete(`/api/knowledge/sources/${up.body.id}`)).expect(204);
  });

  it('switches to Controlled Autonomous Mode only with replies being read, and back', async () => {
    await host(request(app()).put('/api/settings')).send({ senderName: 'Muri' }).expect(200);
    const refused = await host(request(app()).put('/api/settings')).send({ mode: 'autonomous' }).expect(422);
    expect(refused.body.error.message).toContain('reading replies');
    await host(request(app()).put('/api/settings')).send({ readReplies: true }).expect(200);
    await host(request(app()).put('/api/settings')).send({ mode: 'autonomous' }).expect(200);
    await host(request(app()).put('/api/settings')).send({ mode: 'approval' }).expect(200);
  });
});
