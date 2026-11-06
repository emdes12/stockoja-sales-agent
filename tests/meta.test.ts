import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { hasTestDb, resetDb, testDb } from './helpers.js';
import type { Db } from '../src/db/pool.js';
import { env } from '../src/config.js';
import { logger } from '../src/log.js';
import { settingsSchema, type Settings } from '../src/settings.js';
import { upsertLead, type LeadCandidate } from '../src/leads/leads.js';
import { approveMessage, chatLinkFor, type MessageRow } from '../src/outreach/messages.js';
import { afterApprove } from '../src/outreach/sending.js';
import { draftReply } from '../src/inbox/process.js';
import { metaDeps } from '../src/meta/graph.js';
import { applyInstagramProfile, lookupInstagram, phonesIn, profileFacts } from '../src/meta/instagram.js';
import { checkMetaInbox } from '../src/meta/inbox.js';
import { metaSendHandlers, TASK_SEND_META } from '../src/meta/send.js';
import { PermanentError, type Task } from '../src/queue/queue.js';
import { Agent } from '../src/agent/controller.js';
import { createApp } from '../src/server/app.js';

const PAGE = '1000001';
const IG = '17841000002';
const TOKEN = 'EAAtest-page-token-not-real';

interface Call { method: string; path: string; params: URLSearchParams; auth: string | null; body: unknown }
let calls: Call[] = [];
/** Answers keyed by "METHOD path" (path without the version); a function can vary by call. */
let routes: Record<string, (c: Call) => { status?: number; json: unknown } | 'network'> = {};

const fakeFetch = async (url: string, init: RequestInit) => {
  const u = new URL(url);
  const call: Call = {
    method: init.method ?? 'GET',
    path: u.pathname.replace(/^\/v\d+\.\d+\//, ''),
    params: u.searchParams,
    auth: (init.headers as Record<string, string>).Authorization ?? null,
    body: init.body ? JSON.parse(String(init.body)) : null,
  };
  calls.push(call);
  const route = routes[`${call.method} ${call.path}`];
  const r = route ? route(call) : { status: 404, json: { error: { message: `no route for ${call.method} ${call.path}`, code: 100 } } };
  if (r === 'network') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
};

const d = hasTestDb ? describe : describe.skip;
let db: Db;
const realFetch = metaDeps.fetch;
beforeAll(async () => {
  if (hasTestDb) db = await testDb();
  metaDeps.fetch = fakeFetch;
});
afterAll(async () => {
  metaDeps.fetch = realFetch;
  await db?.end();
});
const configure = () => {
  env.META_PAGE_ACCESS_TOKEN = TOKEN;
  env.META_PAGE_ID = PAGE;
  env.META_IG_USER_ID = '';
  env.META_APP_SECRET = 'app-secret-not-real';
};
beforeEach(async () => {
  calls = [];
  routes = {
    [`GET ${PAGE}`]: () => ({ json: { id: PAGE, name: 'StockOja', instagram_business_account: { id: IG, username: 'stockoja' } } }),
  };
  configure();
  if (hasTestDb) await resetDb(db);
});

const settings: Settings = settingsSchema.parse({
  senderName: 'Muri', instagramLookupEnabled: true, metaInboxEnabled: true, metaInboxLookbackDays: 7,
});
const lead = (extra: Partial<LeadCandidate> = {}): LeadCandidate => ({
  business_name: 'Ada Styles', category: 'fashion', source: 'manual', source_ref: 'ada', state: 'Lagos', facts: [], ...extra,
});
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe('Instagram profile helpers (no database)', () => {
  it('finds Nigerian mobile numbers in a bio', () => {
    expect(phonesIn('Orders: 0803 123 4567 or +234 905-555-1212. Shop at Yaba')).toEqual(['+234 803 123 4567', '+234 905 555 1212']);
    expect(phonesIn('Since 2019 · 12,000 happy customers')).toEqual([]);
    expect(phonesIn(null)).toEqual([]);
  });

  it('credits every fact to Instagram', () => {
    const facts = profileFacts({ username: 'ada', name: 'Ada', biography: null, website: null, followers: 1200, following: 10, posts: 0, phonesInBio: [], checkedAt: '' });
    expect(facts.map((f) => f.label)).toEqual(['Instagram name', 'Instagram followers', 'Instagram posts']);
    expect(facts.every((f) => f.source.startsWith('Instagram') && f.url === 'https://www.instagram.com/ada/')).toBe(true);
  });
});

d('Instagram lookup', () => {
  const discovery = (c: Call) => {
    const fields = c.params.get('fields') ?? '';
    if (fields.includes('username(nobody)')) {
      return { status: 400, json: { error: { message: 'Invalid user id', code: 110, error_subcode: 2207013 } } };
    }
    return {
      json: {
        business_discovery: {
          username: 'adastyles', name: 'Ada Styles', biography: 'Ankara and lace. WhatsApp 0803 123 4567', website: 'https://adastyles.ng',
          followers_count: 5400, follows_count: 120, media_count: 310,
        },
      },
    };
  };

  it('refuses when switched off or not set up, without calling Meta', async () => {
    await expect(lookupInstagram(db, { ...settings, instagramLookupEnabled: false }, '@adastyles')).rejects.toMatchObject({ code: 'LOOKUP_OFF' });
    env.META_PAGE_ACCESS_TOKEN = '';
    await expect(lookupInstagram(db, settings, '@adastyles')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(calls).toHaveLength(0);
  });

  it('returns the public profile; the token goes in a header with an appsecret_proof, never in the URL', async () => {
    routes[`GET ${IG}`] = discovery;
    const p = await lookupInstagram(db, settings, 'https://www.instagram.com/AdaStyles/');
    expect(p).toMatchObject({ username: 'adastyles', followers: 5400, posts: 310, website: 'https://adastyles.ng/', phonesInBio: ['+234 803 123 4567'] });
    for (const c of calls) {
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
      expect(c.params.has('access_token')).toBe(false);
      expect(c.params.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(calls.at(-1)!.params.get('fields')).toContain('business_discovery.username(adastyles)');
  });

  it('explains a personal or missing account', async () => {
    routes[`GET ${IG}`] = discovery;
    await expect(lookupInstagram(db, settings, '@nobody')).rejects.toMatchObject({ code: 'IG_NOT_FOUND' });
  });

  it('adds the profile to a lead without overwriting what you entered', async () => {
    routes[`GET ${IG}`] = discovery;
    const { leadId } = await upsertLead(db, lead({ website: 'https://ada-own-site.ng', socials: { instagram: '@adastyles' } }), 50);
    const p = await lookupInstagram(db, settings, '@adastyles');
    await applyInstagramProfile(db, leadId, p, 50);
    await applyInstagramProfile(db, leadId, { ...p, followers: 6000 }, 50);
    const row = (await db.query('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
    expect(row.website).toBe('https://ada-own-site.ng/');
    expect(row.phone).toBe('+234 803 123 4567');
    expect(row.socials.instagram).toBe('@adastyles');
    expect(row.instagram_profile.followers).toBe(6000);
    // The second lookup replaced the first snapshot's facts.
    expect(row.facts.filter((f: { label: string }) => f.label === 'Instagram followers').map((f: { value: string }) => f.value)).toEqual(['6000']);
  });
});

d('Instagram/Facebook inbox', () => {
  const igConversations = () => ({
    json: {
      data: [
        {
          id: 't_ig1', updated_time: ago(5),
          messages: { data: [
            { id: 'mid3', message: 'Is there a free plan?', created_time: ago(5), from: { id: 'igsid-ada', username: 'AdaStyles' } },
            { id: 'mid2', message: 'Thanks for writing', created_time: ago(30), from: { id: IG, username: 'stockoja' } },
          ] },
        },
        {
          id: 't_ig2', updated_time: ago(10),
          messages: { data: [{ id: 'mid9', message: 'How much is Scale?', created_time: ago(10), from: { id: 'igsid-new', username: 'newshop' } }] },
        },
      ],
    },
  });
  const fbConversations = () => ({
    json: { data: [{ id: 't_fb1', updated_time: ago(3), messages: { data: [{ id: 'mfb1', message: 'Hello, I sell phones', created_time: ago(3), from: { id: 'psid-77', name: 'Kunle Phones' } }] } }] },
  });

  it('records replies from known leads, parks strangers, skips your own messages, and never duplicates', async () => {
    routes[`GET ${PAGE}/conversations`] = (c) => (c.params.get('platform') === 'instagram' ? igConversations() : fbConversations());
    const { leadId } = await upsertLead(db, lead({ socials: { instagram: 'https://instagram.com/adastyles' } }), 50);

    const r = await checkMetaInbox(db, settings);
    expect(r).toMatchObject({ replies: 1, unmatched: 2, duplicates: 0 });
    const replies = (await db.query(`SELECT * FROM messages WHERE direction = 'inbound' AND lead_id IS NOT NULL`)).rows;
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ lead_id: leadId, channel: 'instagram', from_address: '@adastyles', external_message_id: 'instagram:mid3', classification: 'question' });
    expect(replies[0].social_contact_id).not.toBeNull();
    const unmatched = (await db.query(`SELECT channel, from_address FROM messages WHERE direction = 'inbound' AND lead_id IS NULL ORDER BY id`)).rows;
    expect(unmatched).toEqual([{ channel: 'instagram', from_address: '@newshop' }, { channel: 'facebook', from_address: 'Kunle Phones' }]);

    // Checking again finds nothing new (the cursor moved past these conversations).
    const again = await checkMetaInbox(db, settings);
    expect(again).toMatchObject({ replies: 0, unmatched: 0 });
    // Even read again from scratch, the same messages are not stored twice.
    await db.query(`DELETE FROM settings WHERE key LIKE 'state.meta.cursor.%'`);
    await checkMetaInbox(db, settings);
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE direction = 'inbound'`)).rows[0].n).toBe(3);
  });

  const PORT = 6398;
  const app = () =>
    createApp({ db, agent: new Agent(db, {}, 50), recovery: { requeued: 0, heldInterrupted: 0, heldOverdue: 0, at: new Date(), wasRunningAtShutdown: false }, port: PORT, shutdown: async () => {} });
  const host = (r: request.Test) => r.set('Host', `127.0.0.1:${PORT}`).set('X-Agent-Client', 'dashboard');

  it('links a stranger to a lead, or adds them as a new lead, from the inbox', async () => {
    routes[`GET ${PAGE}/conversations`] = (c) => (c.params.get('platform') === 'instagram' ? igConversations() : fbConversations());
    await host(request(app()).put('/api/settings')).send({ metaInboxEnabled: true, senderName: 'Muri' }).expect(200);
    await checkMetaInbox(db, settings);
    const contactOf = async (from: string) => (await db.query(`SELECT social_contact_id AS id FROM messages WHERE from_address = $1 AND lead_id IS NULL`, [from])).rows[0];
    const ig = await contactOf('@newshop');
    const fb = await contactOf('Kunle Phones');

    const list = await host(request(app()).get('/api/inbox?view=not_lead&channel=instagram')).expect(200);
    expect(list.body.data.map((m: { from_address: string }) => m.from_address).sort()).toEqual(['@adastyles', '@newshop']);

    const { leadId } = await upsertLead(db, lead({ business_name: 'New Shop', source_ref: 'new' }), 50);
    const linked = await host(request(app()).post(`/api/inbox/contacts/${ig.id}/link`)).send({ leadId }).expect(200);
    expect(linked.body.moved).toBe(1);
    const saved = (await db.query('SELECT socials FROM leads WHERE id = $1', [leadId])).rows[0];
    expect(saved.socials.instagram).toBe('@newshop');

    const created = await host(request(app()).post(`/api/inbox/contacts/${fb.id}/new-lead`)).send({ business_name: 'Kunle Phones', category: 'electronics' }).expect(201);
    const reply = (await db.query(`SELECT * FROM messages WHERE lead_id = $1 AND direction = 'inbound'`, [created.body.leadId])).rows[0];
    expect(reply).toMatchObject({ channel: 'facebook', external_message_id: 'facebook:mfb1' });
    // Only @adastyles (not linked here, no lead in this test) is still without a lead.
    expect((await db.query(`SELECT from_address FROM messages WHERE direction = 'inbound' AND lead_id IS NULL`)).rows).toEqual([{ from_address: '@adastyles' }]);

    // The next message from that Messenger user goes straight to the lead.
    routes[`GET ${PAGE}/conversations`] = (c) =>
      c.params.get('platform') === 'instagram'
        ? { json: { data: [] } }
        : { json: { data: [{ id: 't_fb1', updated_time: ago(0), messages: { data: [{ id: 'mfb2', message: 'Please call me', created_time: ago(0), from: { id: 'psid-77', name: 'Kunle Phones' } }] } }] } };
    expect(await checkMetaInbox(db, settings)).toMatchObject({ replies: 1, unmatched: 0 });
  });

  it('refuses to switch features on before the Meta app is set up', async () => {
    env.META_PAGE_ACCESS_TOKEN = '';
    for (const patch of [{ instagramLookupEnabled: true }, { metaInboxEnabled: true }, { metaReplySending: 'live' }]) {
      const r = await host(request(app()).put('/api/settings')).send(patch).expect(422);
      expect(r.body.error.message).toContain('META_PAGE_ACCESS_TOKEN');
    }
    configure();
    await host(request(app()).put('/api/settings')).send({ metaReplySending: 'live' }).expect(422); // needs the inbox on
  });
});

d('Instagram/Facebook replies', () => {
  const ctx = (s: Settings) => ({ db, signal: new AbortController().signal, settings: s, log: logger('test') });
  const live: Settings = { ...settings, metaReplySending: 'live' };

  /** A Messenger user (no username) who wrote `minutesAgo`, linked to a lead with no Facebook profile saved. */
  async function approvedFacebookReply(s: Settings, minutesAgo: number) {
    routes[`GET ${PAGE}/conversations`] = (c) =>
      c.params.get('platform') === 'instagram'
        ? { json: { data: [] } }
        : { json: { data: [{ id: 't_fb1', updated_time: ago(minutesAgo), messages: { data: [{ id: 'mfb1', message: 'Is there a free plan?', created_time: ago(minutesAgo), from: { id: 'psid-77', name: 'Kunle Phones' } }] } }] } };
    const { leadId } = await upsertLead(db, lead({ business_name: 'Kunle Phones', category: 'electronics', source_ref: 'k' }), 50);
    await db.query(`INSERT INTO social_contacts (platform, external_id, name, lead_id) VALUES ('facebook', 'psid-77', 'Kunle Phones', $1)`, [leadId]);
    await checkMetaInbox(db, { ...s, metaInboxLookbackDays: 7 });
    const inbound = (await db.query(`SELECT id FROM messages WHERE direction = 'inbound'`)).rows[0];
    const draft = await draftReply(db, inbound.id, s, 'blank', 'user');
    if (!('drafted' in draft)) throw new Error('no draft');
    await db.query(`UPDATE messages SET body = replace(body, '{{your_answer}}', 'Yes, the Hustle plan is free.') WHERE id = $1`, [draft.drafted.id]);
    const msg = await approveMessage(db, draft.drafted.id, s);
    return { leadId, msg };
  }
  const row = async (id: number) => (await db.query<MessageRow>('SELECT * FROM messages WHERE id = $1', [id])).rows[0]!;
  const tasks = async () => (await db.query<Task>(`SELECT * FROM tasks WHERE type = $1`, [TASK_SEND_META])).rows;
  const run = (t: Task, s: Settings) => metaSendHandlers[TASK_SEND_META]!.run(t, ctx(s));

  it('drafts a reply to the chat even when the lead has no Facebook profile; no public chat link for it', async () => {
    const { msg } = await approvedFacebookReply(settings, 5);
    expect(msg.to_address).toBe('id:psid-77');
    expect(chatLinkFor(msg)).toBeNull();
  });

  it('"you send them" mode never queues an API send', async () => {
    const { msg } = await approvedFacebookReply(settings, 5);
    expect(await afterApprove(db, msg, settings)).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('live mode sends an approved reply inside 24 hours, once, as a RESPONSE', async () => {
    routes[`POST ${PAGE}/messages`] = () => ({ json: { recipient_id: 'psid-77', message_id: 'm_out_1' } });
    const { msg } = await approvedFacebookReply(live, 5);
    await afterApprove(db, msg, live);
    const [task] = await tasks();
    expect(await run(task!, live)).toEqual({ sent: true });
    expect(await run(task!, live)).toEqual({ skipped: 'message is sent' });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ recipient: { id: 'psid-77' }, messaging_type: 'RESPONSE', message: { text: msg.body } });
    expect(await row(msg.id)).toMatchObject({ status: 'sent', sent_by: 'provider', provider_message_id: 'm_out_1' });
  });

  it('outside the 24-hour window it stays with you to send', async () => {
    const { msg } = await approvedFacebookReply(live, 25 * 60);
    expect(await afterApprove(db, msg, live)).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it("a refusal from Meta or a lost connection hands it back to you; it is never resent blindly", async () => {
    routes[`POST ${PAGE}/messages`] = () => ({ status: 400, json: { error: { message: 'Outside of allowed window', code: 10, error_subcode: 2018278 } } });
    const first = await approvedFacebookReply(live, 5);
    await afterApprove(db, first.msg, live);
    const [t1] = await tasks();
    await run(t1!, live);
    expect(await row(first.msg.id)).toMatchObject({ status: 'approved', status_reason: expect.stringContaining('24-hour') });

    await resetDb(db);
    calls = [];
    routes[`POST ${PAGE}/messages`] = () => 'network';
    const second = await approvedFacebookReply(live, 5);
    await afterApprove(db, second.msg, live);
    const [t2] = await tasks();
    await expect(run(t2!, live)).rejects.toBeInstanceOf(PermanentError);
    expect(await row(second.msg.id)).toMatchObject({ status: 'approved', status_reason: expect.stringContaining('may or may not') });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});
