import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { hasTestDb, resetDb, testDb } from './helpers.js';
import type { Db } from '../src/db/pool.js';
import { settingsSchema, type Settings } from '../src/settings.js';
import { upsertLead, type LeadCandidate } from '../src/leads/leads.js';
import { seedOutreach, SOCIAL_TEMPLATES } from '../src/outreach/seed.js';
import { approveMessage, autoDraft, chatLinkFor, createDraft, markSentByYou } from '../src/outreach/messages.js';
import { buildVars, complianceProblems, render } from '../src/outreach/render.js';
import { chatLink, MAX_LENGTH, socialHandle } from '../src/outreach/channels.js';
import { personalLine, spin } from '../src/outreach/variety.js';
import { addSuppression, applyDoNotContact, normalizeSuppression } from '../src/outreach/suppressions.js';
import { consentGiven, importResponses, mapSheet, type FormColumns } from '../src/inbound/form.js';
import { referralLinkFor } from '../src/inbound/referrals.js';
import { Agent } from '../src/agent/controller.js';
import { createApp } from '../src/server/app.js';

describe('social handles and chat links (no database)', () => {
  it('reads a username from profile links and @names, and refuses posts, groups and invites', () => {
    expect(socialHandle('instagram', 'https://www.instagram.com/Ada.Styles/?hl=en')).toBe('ada.styles');
    expect(socialHandle('instagram', '@ada_styles')).toBe('ada_styles');
    expect(socialHandle('instagram', 'instagram.com/p/Cx12ab')).toBeNull();
    expect(socialHandle('instagram', 'https://tiktok.com/@ada')).toBeNull();
    expect(socialHandle('tiktok', 'https://www.tiktok.com/@ada.styles?lang=en')).toBe('ada.styles');
    expect(socialHandle('facebook', 'https://web.facebook.com/AdaStylesNG')).toBe('adastylesng');
    expect(socialHandle('facebook', 'https://www.facebook.com/profile.php?id=100012345678')).toBe('100012345678');
    expect(socialHandle('facebook', 'https://facebook.com/groups/lagosvendors')).toBeNull();
    expect(socialHandle('telegram', 't.me/AdaStyles')).toBe('adastyles');
    expect(socialHandle('telegram', 'https://t.me/joinchat/AbCdEf')).toBeNull();
    expect(socialHandle('telegram', '@ab')).toBeNull(); // too short for Telegram
  });

  it('opens the right chat; only WhatsApp carries the text', () => {
    expect(chatLink('instagram', 'ada', 'Hi')).toEqual({ url: 'https://ig.me/m/ada', prefilled: false });
    expect(chatLink('facebook', 'adang', 'Hi')!.url).toBe('https://m.me/adang');
    expect(chatLink('tiktok', 'ada', 'Hi')!.url).toBe('https://www.tiktok.com/@ada');
    expect(chatLink('telegram', 'adastyles', 'Hi')!.url).toBe('https://t.me/adastyles');
    expect(chatLink('whatsapp', '2348031234567', 'Hi there')).toEqual({ url: 'https://wa.me/2348031234567?text=Hi%20there', prefilled: true });
    expect(chatLink('email', 'a@b.ng', 'Hi')).toBeNull();
  });

  it('keeps every social template within its length limit, complete and compliant', () => {
    const settings = settingsSchema.parse({ senderName: 'Muri', bookingUrl: 'https://cal.com/stockoja/demo' });
    const lead = { id: 123456, business_name: 'Ada Styles and Fabrics International', category: 'fashion' as const, city: 'Ikeja', branch_count: 3, socials: { instagram: 'ada' }, website: null };
    for (const t of SOCIAL_TEMPLATES) {
      for (let i = 0; i < 20; i++) {
        const body = render(spin(t.body), buildVars(lead, settings, t.channel, t.step, { personal_line: personalLine(lead) }));
        expect(body.missing, t.name).toEqual([]);
        expect(complianceProblems(t.channel, null, body.text), t.name).toEqual([]);
        expect(body.text.length, t.name).toBeLessThanOrEqual(MAX_LENGTH[t.channel]);
        expect(body.text, t.name).not.toContain('!');
      }
    }
  });

  it('puts social accounts on the do-not-contact list by platform and username', () => {
    expect(normalizeSuppression('handle', 'instagram:@Ada.Styles')).toBe('instagram:ada.styles');
    expect(normalizeSuppression('handle', 'https://t.me/AdaStyles')).toBe('telegram:adastyles');
    expect(normalizeSuppression('handle', 'myspace:ada')).toBeNull();
  });
});

const COLUMNS = settingsSchema.parse({}).interestFormColumns as FormColumns;
const SHEET = `Timestamp,Business name,WhatsApp number,Email,Instagram,What do you sell?,City,Consent: may StockỌja contact you?,Who referred you?,Referral code
26/10/2026 10:00:00,Bola Shoes,08031112222,,@bolashoes,Shoes and bags,Yaba,"Yes, you may contact me",,
26/10/2026 10:05:00,Chika Beauty,,chika@beauty.ng,,Skincare,Ikeja,,,
26/10/2026 10:10:00,Dami Gadgets,08055556666,,,phones,Ikeja,Yes,Bola Shoes,
26/10/2026 10:20:00,Eko Wears,08077778888,,,clothes,Lekki,Yes,,REFCODE_HERE`;

describe('interest form sheet (no database)', () => {
  it('finds columns by title, or by the start of a long question', () => {
    const sheet = mapSheet(SHEET, COLUMNS);
    expect(sheet.matched).toMatchObject({ businessName: 'Business name', category: 'What do you sell?', consent: 'Consent: may StockỌja contact you?', referredBy: 'Who referred you?' });
    expect(sheet.missing).toEqual(expect.arrayContaining(['facebook', 'tiktok', 'telegram', 'state']));
    expect(sheet.rows).toHaveLength(4);
    expect(sheet.rows[0]!.values).toMatchObject({ businessName: 'Bola Shoes', instagram: '@bolashoes' });
    expect(consentGiven('Yes, you may contact me')).toBe(true);
    expect(consentGiven('No')).toBe(false);
    expect(consentGiven(undefined)).toBe(false);
  });
});

// ── With the test database ────────────────────────────────────────────────────

const d = hasTestDb ? describe : describe.skip;
let db: Db;
const base = settingsSchema.parse({ senderName: 'Muri' });
const lead = (n: number, extra: Partial<LeadCandidate> = {}): LeadCandidate => ({
  business_name: `Shop ${n}`, category: 'fashion', source: 'manual', source_ref: `m/${n}`, state: 'Lagos',
  phone: null, email: null, website: null, facts: [], ...extra,
});

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

d('send-it-yourself social channels', () => {
  it('drafts an Instagram DM from a profile link, and records it as sent by you', async () => {
    const { leadId } = await upsertLead(db, lead(1, { socials: { instagram: 'https://instagram.com/shop.one' } }), 0);
    const draft = await createDraft(db, leadId, 'instagram', base);
    expect(draft).toMatchObject({ channel: 'instagram', to_address: 'shop.one', subject: null, status: 'draft' });
    expect(chatLinkFor(draft)).toBeNull(); // only once approved
    const approved = await approveMessage(db, draft.id, base);
    expect(chatLinkFor(approved)).toEqual({ url: 'https://ig.me/m/shop.one', prefilled: false });
    const sent = await markSentByYou(db, draft.id, base);
    expect(sent).toMatchObject({ status: 'sent', sent_by: 'user' });
    expect((await db.query('SELECT status FROM leads WHERE id = $1', [leadId])).rows[0].status).toBe('contacted');
  });

  it('refuses leads without a usable profile, and blocked accounts', async () => {
    const { leadId } = await upsertLead(db, lead(2, { socials: { instagram: 'https://instagram.com/p/xyz' } }), 0);
    await expect(createDraft(db, leadId, 'instagram', base)).rejects.toMatchObject({ code: 'NO_ADDRESS' });
    const ok = (await upsertLead(db, lead(3, { socials: { tiktok: '@shopthree' } }), 0)).leadId;
    await addSuppression(db, 'handle', 'tiktok:@shopthree');
    await expect(createDraft(db, ok, 'tiktok', base)).rejects.toMatchObject({ code: 'SUPPRESSED' });
  });

  it('marking do-not-contact blocks their social accounts too', async () => {
    const { leadId } = await upsertLead(db, lead(4, { socials: { telegram: 't.me/shopfour', facebook: 'facebook.com/shopfour' } }), 0);
    await applyDoNotContact(db, leadId, 'Asked us to stop');
    const values = (await db.query(`SELECT value FROM suppressions WHERE kind = 'handle' ORDER BY value`)).rows.map((r) => r.value);
    expect(values).toEqual(['facebook:shopfour', 'telegram:shopfour']);
  });

  it('drafts on social channels only when you switch them on, in your order', async () => {
    await upsertLead(db, lead(5, { socials: { instagram: '@shopfive' } }), 0);
    await db.query(`UPDATE leads SET status = 'qualified'`);
    expect((await autoDraft(db, { ...base, draftChannels: ['email', 'whatsapp'] })).created).toBe(0);
    const r = await autoDraft(db, { ...base, draftChannels: ['email', 'instagram'] });
    expect(r.created).toBe(1);
    expect((await db.query('SELECT channel FROM messages')).rows[0].channel).toBe('instagram');
  });
});

d('interest form import and referrals', () => {
  const on: Settings = { ...base, interestFormEnabled: true, interestFormCsvUrl: 'https://docs.google.com/x/pub?output=csv', referralAskEnabled: true, referralLinksEnabled: true, referralPrefillUrl: 'https://docs.google.com/forms/d/e/abc/viewform?usp=pp_url&entry.111=REFCODE' };

  it('imports consenting answers once, links referrals by name and by code, and lifts their score', async () => {
    const { leadId: refId } = await upsertLead(db, lead(9, { business_name: 'Eko Referrer', phone: '08099990000' }), 50);
    const { code, link } = await referralLinkFor(db, refId, on);
    expect(link).toBe(`https://docs.google.com/forms/d/e/abc/viewform?usp=pp_url&entry.111=${code}`);
    expect((await referralLinkFor(db, refId, on)).code).toBe(code); // stable

    const sheet = mapSheet(SHEET.replace('REFCODE_HERE', code), COLUMNS);
    const first = await importResponses(db, sheet, on);
    expect(first).toMatchObject({ rows: 4, created: 3, skipped: { NO_CONSENT: 1 }, referrals: 2 });

    const bola = (await db.query(`SELECT * FROM leads WHERE business_name = 'Bola Shoes'`)).rows[0];
    expect(bola).toMatchObject({ category: 'shoes_bags', source: 'form', phone_key: '2348031112222' });
    expect(bola.asked_to_hear_at).not.toBeNull();
    expect(bola.score_breakdown).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Asked us to get in touch (interest form)' })]));
    const dami = (await db.query(`SELECT referred_by_lead_id FROM leads WHERE business_name = 'Dami Gadgets'`)).rows[0];
    expect(dami.referred_by_lead_id).toBe(bola.id);
    const eko = (await db.query(`SELECT referred_by_lead_id FROM leads WHERE business_name = 'Eko Wears'`)).rows[0];
    expect(eko.referred_by_lead_id).toBe(refId);

    // Reading the same sheet again adds nothing.
    expect(await importResponses(db, sheet, on)).toMatchObject({ alreadyImported: 4, created: 0, referrals: 0 });
  });

  it('ignores referral answers when those options are off, and imports without consent when not required', async () => {
    const off = { ...on, referralAskEnabled: false, referralLinksEnabled: false, interestFormRequireConsent: false };
    const r = await importResponses(db, mapSheet(SHEET, COLUMNS), off);
    expect(r).toMatchObject({ created: 4, referrals: 0 });
    await expect(referralLinkFor(db, 1, off)).rejects.toMatchObject({ code: 'REFERRAL_LINKS_OFF' });
  });
});

d('interest form API', () => {
  const PORT = 6399;
  const app = () =>
    createApp({ db, agent: new Agent(db, {}, 50), recovery: { requeued: 0, heldInterrupted: 0, heldOverdue: 0, at: new Date(), wasRunningAtShutdown: false }, port: PORT, shutdown: async () => {} });
  const host = (r: request.Test) => r.set('Host', `127.0.0.1:${PORT}`).set('X-Agent-Client', 'dashboard');
  const realFetch = globalThis.fetch;

  it('checks the settings, tests the sheet without importing, and hands out referral links', async () => {
    await host(request(app()).put('/api/settings')).send({ interestFormEnabled: true }).expect(422);
    await host(request(app()).put('/api/settings')).send({ referralLinksEnabled: true }).expect(422);
    await host(request(app()).put('/api/settings')).send({ referralPrefillUrl: 'https://forms.gle/no-placeholder' }).expect(422);
    await host(request(app()).put('/api/settings'))
      .send({ interestFormCsvUrl: 'https://docs.google.com/spreadsheets/d/e/x/pub?output=csv', interestFormEnabled: true, referralPrefillUrl: 'https://forms.gle/x?entry.1=REFCODE', referralLinksEnabled: true })
      .expect(200);

    globalThis.fetch = (async () => new Response(SHEET, { status: 200, headers: { 'content-type': 'text/csv' } })) as typeof fetch;
    try {
      const t = await host(request(app()).post('/api/inbound/test')).expect(200);
      expect(t.body).toMatchObject({ rows: 4, matched: { businessName: 'Business name' } });
      expect((await db.query('SELECT count(*)::int AS n FROM leads')).rows[0].n).toBe(0);
      globalThis.fetch = (async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
      const bad = await host(request(app()).post('/api/inbound/test')).expect(422);
      expect(bad.body.error.message).toContain('Publish to web');
    } finally {
      globalThis.fetch = realFetch;
    }

    const { leadId } = await upsertLead(db, lead(1, { phone: '08031234567' }), 50);
    const link = await host(request(app()).post(`/api/leads/${leadId}/referral-link`)).expect(200);
    expect(link.body.link).toMatch(/^https:\/\/forms\.gle\/x\?entry\.1=[A-Z2-9]{6}$/);
    await host(request(app()).post('/api/leads/999999/referral-link')).expect(404);
    const detail = await host(request(app()).get(`/api/leads/${leadId}`)).expect(200);
    expect(detail.body).toMatchObject({ referral_code: link.body.code, referredBy: null, referrals: [] });
  });
});
