import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { deflateRawSync } from 'node:zlib';
import { hasTestDb, resetDb, testDb } from './helpers.js';
import type { Db } from '../src/db/pool.js';
import { env } from '../src/config.js';
import { settingsSchema, type Settings } from '../src/settings.js';
import { upsertLead } from '../src/leads/leads.js';
import { approveMessage, createDraft, withGroupFirstLine } from '../src/outreach/messages.js';
import { addSuppression } from '../src/outreach/suppressions.js';
import { seedOutreach } from '../src/outreach/seed.js';
import { classify, searchDeps, webSearch } from '../src/discovery/webSearch.js';
import { exportText, groupFromFileName, importExport, parseExport, previewExport } from '../src/inbound/whatsappExport.js';
import { Agent } from '../src/agent/controller.js';
import { createApp } from '../src/server/app.js';

interface Call { url: URL; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }
let calls: Call[] = [];
let answer: (c: Call) => { status?: number; json: unknown } = () => ({ json: {} });
const fakeFetch = async (url: string, init: RequestInit) => {
  const call: Call = { url: new URL(url), method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null };
  calls.push(call);
  const r = answer(call);
  return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
};

const tavilyResults = {
  results: [
    { title: 'Ada Fabrics | Balogun', url: 'https://adafabrics.ng/', content: 'Lace and ankara in Lagos', score: 0.9 },
    { title: 'Ada Fabrics (@adafabrics) • Instagram', url: 'https://www.instagram.com/adafabrics/', content: 'Ankara, lace', score: 0.8 },
    { title: 'A post', url: 'https://www.instagram.com/p/Cxyz/', content: '', score: 0.1 },
  ],
};
const braveResults = { web: { results: [{ title: 'Ada <strong>Fabrics</strong>', url: 'https://adafabrics.ng/', description: 'Best <strong>lace</strong>' }, { title: 'Bola Shoes', url: 'https://bolashoes.com.ng/', description: '' }] } };

const d = hasTestDb ? describe : describe.skip;
let db: Db;
const realFetch = searchDeps.fetch;
beforeAll(async () => {
  if (hasTestDb) db = await testDb();
  searchDeps.fetch = fakeFetch;
});
afterAll(async () => {
  searchDeps.fetch = realFetch;
  await db?.end();
});
beforeEach(async () => {
  calls = [];
  answer = (c) => ({ json: c.url.hostname.includes('tavily') ? tavilyResults : braveResults });
  env.TAVILY_API_KEY = 'tvly-test-not-real';
  env.BRAVE_SEARCH_API_KEY = 'brave-test-not-real';
  if (hasTestDb) await resetDb(db);
});

const settings: Settings = settingsSchema.parse({ senderName: 'Muri', webSearchProviders: ['tavily', 'brave'], groupImportEnabled: true });

describe('search results', () => {
  it('tells websites, profiles and other pages apart', () => {
    expect(classify({ title: 'x', url: 'https://www.instagram.com/adafabrics/', snippet: '' })).toMatchObject({ kind: 'profile', platform: 'instagram', handle: 'adafabrics' });
    expect(classify({ title: 'x', url: 'https://www.instagram.com/p/Cxyz/', snippet: '' })).toMatchObject({ kind: 'other', platform: null });
    expect(classify({ title: 'x', url: 'https://adafabrics.ng/shop', snippet: '' })).toMatchObject({ kind: 'website', domain: 'adafabrics.ng' });
    expect(classify({ title: 'x', url: 'https://x.com/ada', snippet: '' })).toMatchObject({ kind: 'other' });
  });
});

d('web search', () => {
  it('calls each chosen provider the documented way, with keys in headers only', async () => {
    const out = await webSearch(db, settings, { query: 'fabric shop Lagos', scope: 'instagram', providers: ['tavily', 'brave'] });
    expect(out.map((o) => [o.provider, o.error, o.results.length])).toEqual([['tavily', null, 3], ['brave', null, 2]]);
    const [t, b] = calls;
    expect(t!.method).toBe('POST');
    expect(t!.headers.Authorization).toBe('Bearer tvly-test-not-real');
    expect(t!.body).toMatchObject({ query: 'fabric shop Lagos', search_depth: 'basic', max_results: 10, include_domains: ['instagram.com'] });
    expect(b!.headers['X-Subscription-Token']).toBe('brave-test-not-real');
    expect(b!.url.searchParams.get('q')).toBe('fabric shop Lagos site:instagram.com');
    expect(b!.url.searchParams.get('country')).toBe('NG');
    for (const c of calls) expect(c.url.toString()).not.toContain('not-real');
    expect(out[1]!.results[0]!.snippet).toBe('Best lace');
    const usage = (await db.query(`SELECT provider, units, estimated_usd::text AS usd FROM usage_events WHERE kind = 'search' ORDER BY provider`)).rows;
    expect(usage).toEqual([{ provider: 'brave', units: 1, usd: '0.0050' }, { provider: 'tavily', units: 1, usd: '0.0000' }].map((u) => ({ ...u, usd: expect.any(String) })));
  });

  it('reuses saved results instead of spending another search, unless asked', async () => {
    await webSearch(db, settings, { query: 'Fabric shop  Lagos', scope: 'any', providers: ['tavily'] });
    const again = await webSearch(db, settings, { query: 'fabric shop lagos', scope: 'any', providers: ['tavily'] });
    expect(again[0]!.cached).toBe(true);
    expect(calls).toHaveLength(1);
    await webSearch(db, settings, { query: 'fabric shop lagos', scope: 'any', providers: ['tavily'], fresh: true });
    expect(calls).toHaveLength(2);
  });

  it('stops at the monthly limit, per provider, without calling it', async () => {
    const capped = { ...settings, braveMonthlyLimit: 1 };
    await webSearch(db, capped, { query: 'shoe shop Ikeja', scope: 'any', providers: ['brave'] });
    const out = await webSearch(db, capped, { query: 'bag shop Ikeja', scope: 'any', providers: ['brave', 'tavily'] });
    expect(out[0]!.error).toMatch(/limit of 1 searches/);
    expect(out[1]!.error).toBeNull();
    expect(calls.filter((c) => c.url.hostname.includes('brave'))).toHaveLength(1);
  });

  it('refuses providers that are off or have no key, and reports provider errors', async () => {
    await expect(webSearch(db, { ...settings, webSearchProviders: ['tavily'] }, { query: 'abc shop', scope: 'any', providers: ['brave'] })).rejects.toMatchObject({ code: 'PROVIDER_OFF' });
    env.TAVILY_API_KEY = '';
    const noKey = await webSearch(db, settings, { query: 'abc shop', scope: 'any', providers: ['tavily'] });
    expect(noKey[0]!.error).toMatch(/TAVILY_API_KEY/);
    answer = () => ({ status: 401, json: { detail: { error: 'bad key' } } });
    const bad = await webSearch(db, settings, { query: 'abc shop', scope: 'any', providers: ['brave'] });
    expect(bad[0]!.error).toMatch(/refused the API key/);
  });

  it('marks results that are already leads', async () => {
    const { leadId } = await upsertLead(db, { business_name: 'Ada Fabrics', category: 'fashion', source: 'manual', source_ref: 'a', website: 'https://adafabrics.ng', facts: [] }, 50);
    const out = await webSearch(db, settings, { query: 'ada fabrics', scope: 'any', providers: ['tavily'] });
    expect(out[0]!.results.filter((r) => r.leadId === leadId).map((r) => r.url)).toEqual(['https://adafabrics.ng/']);
  });
});

const ANDROID = [
  '12/03/2026, 09:14 - Messages and calls are end-to-end encrypted. No one outside of this chat can read or listen to them.',
  '12/03/2026, 09:15 - +234 803 123 4567 joined using this group\'s invite link',
  '12/03/2026, 09:20 - +234 803 123 4567: Good morning all. New ankara and lace fabrics in stock, Balogun market',
  'DM for prices',
  '12/03/2026, 09:31 - Mama Bisi Shoes: <Media omitted>',
  '12/03/2026, 09:32 - Mama Bisi Shoes: Ladies shoes and bags available, call 0805 555 1234',
  '12/03/2026, 10:02 - Tunde: Who has iPhone chargers?',
].join('\n');
const IOS = '‎[12/03/2026, 09:20:11] +234 701 222 3333: Skincare and perfume oils, wholesale\n[12/03/2026, 09:21:00] Ada: hello';

/** A minimal zip with one deflated file, as WhatsApp makes it. */
function zipOf(name: string, text: string) {
  const data = Buffer.from(text, 'utf8');
  const comp = deflateRawSync(data);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = 30 + n.length + comp.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + n.length, 12); end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, n, comp, central, n, end]);
}

describe('WhatsApp export parsing', () => {
  it('reads Android and iOS exports, one entry per sender, skipping system lines', () => {
    const a = parseExport(ANDROID);
    expect(a.senders.map((s) => s.key)).toEqual(['+234 803 123 4567', 'Mama Bisi Shoes', 'Tunde']);
    expect(a.senders[0]!.messages[0]).toContain('DM for prices');
    expect(parseExport(IOS).senders.map((s) => s.key)).toEqual(['+234 701 222 3333', 'Ada']);
  });

  it('reads the chat out of a .zip, and the group name from the file name', () => {
    expect(exportText('WhatsApp Chat with Lagos Vendors.zip', zipOf('_chat.txt', ANDROID))).toBe(ANDROID);
    expect(groupFromFileName('WhatsApp Chat with Lagos Vendors (2).zip')).toBe('Lagos Vendors');
    expect(groupFromFileName('chat.txt')).toBeNull();
  });
});

d('WhatsApp export import', () => {
  it('previews senders with numbers, samples and categories, flagging do-not-contact', async () => {
    await addSuppression(db, 'phone', '2348055551234', { reason: 'test' });
    const p = await previewExport(db, 'WhatsApp Chat with Lagos Vendors.txt', Buffer.from(ANDROID));
    expect(p.group).toBe('Lagos Vendors');
    const [fab, shoes, tunde] = p.candidates;
    expect(fab).toMatchObject({ phoneKey: '2348031234567', phoneFrom: 'sender', name: '', category: 'fashion' });
    expect(shoes).toMatchObject({ phoneKey: '2348055551234', phoneFrom: 'message', name: 'Mama Bisi Shoes', category: 'shoes_bags' });
    expect(shoes!.blocked).toBeTruthy();
    expect(shoes!.sample).not.toMatch(/Media omitted/);
    expect(tunde).toMatchObject({ phoneKey: null });
  });

  it('imports ticked vendors as group leads: no email, first line on the intro', async () => {
    await expect(importExport(db, { ...settings, groupImportEnabled: false }, 'G', [])).rejects.toMatchObject({ code: 'OFF' });
    const r = await importExport(db, settings, 'Lagos Vendors', [
      { name: 'Balogun Fabrics', phone: '2348031234567', category: 'fashion', sample: 'New ankara in stock' },
      { name: 'Nobody', phone: '12345', category: 'fashion' },
    ]);
    expect(r).toMatchObject({ created: 1, skipped: [{ name: 'Nobody', reason: 'No Nigerian phone number' }] });
    const lead = (await db.query(`SELECT * FROM leads WHERE phone_key = '2348031234567'`)).rows[0];
    expect(lead).toMatchObject({ group_source: 'Lagos Vendors', source: 'whatsapp_group' });
    expect(lead.facts.map((f: { label: string }) => f.label)).toEqual(['Seen in WhatsApp group', 'What they posted']);

    await seedOutreach(db);
    await db.query(`UPDATE leads SET email = 'shop@balogun.ng' WHERE id = $1`, [lead.id]);
    await expect(createDraft(db, lead.id, 'email', settings)).rejects.toMatchObject({ code: 'GROUP_LEAD' });
    const wa = await createDraft(db, lead.id, 'whatsapp', settings);
    expect(wa.body.split('\n')[0]).toBe('I saw your number in the "Lagos Vendors" WhatsApp group. If you\'d rather not hear from me, just reply STOP.');
    expect((await approveMessage(db, wa.id, settings)).status).toBe('approved');
    expect(withGroupFirstLine(wa.body, 'Lagos Vendors', settings)).toBe(wa.body);
  });

  it('does not mark an existing lead as a group lead', async () => {
    await upsertLead(db, { business_name: 'Known Shop', category: 'fashion', source: 'manual', source_ref: 'k', phone: '08031234567', facts: [] }, 50);
    const r = await importExport(db, settings, 'Lagos Vendors', [{ name: 'Known', phone: '+234 803 123 4567', category: 'fashion' }]);
    expect(r.merged).toBe(1);
    expect((await db.query(`SELECT group_source FROM leads`)).rows).toEqual([{ group_source: null }]);
  });

  const PORT = 6397;
  const app = () =>
    createApp({ db, agent: new Agent(db, {}, 50), recovery: { requeued: 0, heldInterrupted: 0, heldOverdue: 0, at: new Date(), wasRunningAtShutdown: false }, port: PORT, shutdown: async () => {} });
  const host = (r: request.Test) => r.set('Host', `127.0.0.1:${PORT}`).set('X-Agent-Client', 'dashboard');

  it('serves status, search, preview and import over the API', async () => {
    await db.query(`INSERT INTO settings (key, value) VALUES ('webSearchProviders', '["tavily"]'), ('groupImportEnabled', 'true')`)
    const status = await host(request(app()).get('/api/web-search/status'));
    expect(status.status).toBe(200);
    expect(status.body.providers.map((p: { id: string; keySet: boolean }) => [p.id, p.keySet])).toEqual([['tavily', true], ['brave', true]]);

    const preview = await host(request(app()).post('/api/whatsapp-export/preview')).send({ fileName: 'WhatsApp Chat with G.zip', base64: zipOf('_chat.txt', IOS).toString('base64') });
    expect(preview.status).toBe(200);
    expect(preview.body.candidates[0].phoneKey).toBe('2347012223333');

    const noConsent = await host(request(app()).post('/api/whatsapp-export/import')).send({ group: 'G', consent: false, rows: [{ name: 'x', phone: '07012223333', category: 'cosmetics' }] });
    expect(noConsent.status).toBe(422);
  });

  it('refuses to switch on a provider with no key', async () => {
    env.BRAVE_SEARCH_API_KEY = '';
    const r = await host(request(app()).put('/api/settings')).send({ webSearchProviders: ['brave'] });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/BRAVE_SEARCH_API_KEY/);
  });
});
