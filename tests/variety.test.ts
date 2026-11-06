import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { hasTestDb, resetDb, testDb } from './helpers.js';
import type { Db } from '../src/db/pool.js';
import { settingsSchema, type Settings } from '../src/settings.js';
import { upsertLead, type LeadCandidate } from '../src/leads/leads.js';
import { seedOutreach, STARTER_VARIANTS } from '../src/outreach/seed.js';
import { createDraft, editMessage, regenerateDraft } from '../src/outreach/messages.js';
import { buildVars, complianceProblems, render } from '../src/outreach/render.js';
import { findSimilar, personalLine, personalLines, similarity, spin, spinCount } from '../src/outreach/variety.js';
import { Agent } from '../src/agent/controller.js';
import { createApp } from '../src/server/app.js';

const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe('phrase alternatives (no database)', () => {
  it('picks one option per group and leaves {{placeholders}} alone', () => {
    expect(spin('{Hello|Hi} {{business_name}}, {a|b|c}', seq(0, 0.99))).toBe('Hello {{business_name}}, c');
    expect(spin('{{business_name}} and {single}')).toBe('{{business_name}} and {single}');
    expect(spinCount('{a|b} {x|y|z} {{name}}')).toBe(6);
    expect(spinCount('no options here')).toBe(1);
    // Options may contain placeholders.
    expect(spin("{I'm {{sender_name}}|This is {{sender_name}}}.", seq(0.99))).toBe('This is {{sender_name}}.');
    expect(spinCount('{a {{x}}|b}')).toBe(2);
  });

  it('builds a personal line only from verified details', () => {
    const base = { business_name: 'Ada Styles', branch_count: 1, socials: {}, website: null };
    expect(personalLines(base)).toEqual([]);
    expect(personalLine(base)).toBe('');
    const lines = personalLines({ ...base, branch_count: 3, socials: { instagram: 'adastyles' }, website: 'https://ada.ng' });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('3 branches');
    expect(lines[1]).toContain('Instagram');
  });

  it('flags drafts that read almost the same as a recent one, ignoring the business names', () => {
    const body = 'Hello Ada Styles team, StockOja keeps your stock, sales and expenses in one place, so you always know what you have and what you sold today.';
    const other = body.replace('Ada Styles', 'Bola Shoes');
    expect(similarity(body, other, ['Ada Styles', 'Bola Shoes'])).toBe(1);
    const mine = { id: 1, subject: 'Hi', body, business_name: 'Ada Styles' };
    expect(findSimilar(mine, [{ id: 2, subject: 'Other', body: other, business_name: 'Bola Shoes' }])).toMatchObject({ id: 2, businessName: 'Bola Shoes', sameSubject: false });
    expect(findSimilar(mine, [{ id: 3, subject: 'hi ', body: 'Something else entirely about shoes and bags and a market.', business_name: 'C' }])).toMatchObject({ id: 3, sameSubject: true });
    expect(findSimilar(mine, [{ id: 4, subject: 'X', body: 'Something else entirely about shoes and bags and a market.', business_name: 'C' }])).toBeNull();
  });

  it('every starter variant renders completely and passes the compliance checks', () => {
    const settings = settingsSchema.parse({ senderName: 'Muri' });
    const lead = { id: 1, business_name: 'Ada Styles', category: 'fashion' as const, city: 'Ikeja', branch_count: 2, socials: {}, website: null };
    for (const t of STARTER_VARIANTS) {
      for (let i = 0; i < 5; i++) {
        const vars = buildVars(lead, settings, t.channel, t.step, { personal_line: personalLine(lead), previous_subject: 'Earlier subject' });
        const body = render(spin(t.body), vars);
        const subject = t.subject ? render(spin(t.subject), vars) : null;
        expect([...body.missing, ...(subject?.missing ?? [])], t.name).toEqual([]);
        expect(complianceProblems(t.channel, subject?.text ?? null, body.text), t.name).toEqual([]);
        expect(body.text, t.name).not.toMatch(/[{}|]/);
      }
    }
  });
});

// ── With the test database ────────────────────────────────────────────────────

const d = hasTestDb ? describe : describe.skip;
let db: Db;
const settings: Settings = settingsSchema.parse({ senderName: 'Muri' });
const lead = (n: number, extra: Partial<LeadCandidate> = {}): LeadCandidate => ({
  business_name: `Shop ${n}`, category: 'fashion', source: 'osm', source_ref: `node/${n}`, state: 'Lagos',
  phone: null, email: `info@shop${n}.ng`, website: null, facts: [], ...extra,
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

async function addVariants() {
  for (const t of STARTER_VARIANTS) {
    await db.query('INSERT INTO templates (name, channel, step, category, subject, body, active) VALUES ($1,$2,$3,$4,$5,$6,true)', [t.name, t.channel, t.step, t.category, t.subject, t.body]);
  }
}

d('template rotation', () => {
  it('spreads drafts across the active variants for the category', async () => {
    await addVariants();
    const fashion = (await db.query<{ id: number }>(`SELECT id FROM templates WHERE active AND channel = 'email' AND step = 'intro' AND category = 'fashion'`)).rows.map((r) => r.id);
    expect(fashion.length).toBeGreaterThanOrEqual(3);
    const used: number[] = [];
    for (let i = 1; i <= fashion.length; i++) {
      const { leadId } = await upsertLead(db, lead(i), 50);
      used.push((await createDraft(db, leadId, 'email', settings)).template_id!);
    }
    // Least-used first: one draft per variant before any repeats, and category-specific ones only.
    expect([...used].sort()).toEqual([...fashion].sort());
  });

  it('regenerates an unedited draft with another variant, and refuses edited ones', async () => {
    await addVariants();
    const { leadId } = await upsertLead(db, lead(1), 50);
    const draft = await createDraft(db, leadId, 'email', settings);
    const again = await regenerateDraft(db, draft.id, settings);
    expect(again.id).toBe(draft.id);
    expect(again.template_id).not.toBe(draft.template_id);
    expect(again.status_reason).toBe('Regenerated');

    await editMessage(db, draft.id, { subject: again.subject, body: `${again.body}\n\nP.S. edited` });
    await expect(regenerateDraft(db, draft.id, settings)).rejects.toMatchObject({ code: 'EDITED' });
  });
});

d('variety API', () => {
  const PORT = 6398;
  const app = () =>
    createApp({ db, agent: new Agent(db, {}, 50), recovery: { requeued: 0, heldInterrupted: 0, heldOverdue: 0, at: new Date(), wasRunningAtShutdown: false }, port: PORT, shutdown: async () => {} });
  const host = (r: request.Test) => r.set('Host', `127.0.0.1:${PORT}`).set('X-Agent-Client', 'dashboard');

  it('adds starter variants switched off, once', async () => {
    const first = await host(request(app()).post('/api/templates/starter-variants')).expect(200);
    expect(first.body.added).toBe(STARTER_VARIANTS.length);
    expect((await host(request(app()).post('/api/templates/starter-variants')).expect(200)).body.added).toBe(0);
    const list = await host(request(app()).get('/api/templates')).expect(200);
    const variants = list.body.data.filter((t: { name: string }) => t.name.includes('variant'));
    expect(variants.every((t: { active: boolean }) => !t.active)).toBe(true);
    expect(variants.every((t: { versions: number }) => t.versions > 1)).toBe(true);
  });

  it('marks a draft that repeats a recent subject, and regenerates through the API', async () => {
    // Only the seed template is active, so two drafts share a subject.
    const a = (await upsertLead(db, lead(1), 50)).leadId;
    const b = (await upsertLead(db, lead(2), 50)).leadId;
    await createDraft(db, a, 'email', settings);
    const second = await createDraft(db, b, 'email', settings);
    const res = await host(request(app()).get('/api/messages?status=draft')).expect(200);
    const flagged = res.body.data.find((m: { id: number }) => m.id === second.id);
    expect(flagged.similar).toMatchObject({ businessName: 'Shop 1', sameSubject: true });

    await host(request(app()).put('/api/settings')).send({ senderName: 'Muri' }).expect(200);
    const regen = await host(request(app()).post(`/api/messages/${second.id}/regenerate`)).expect(200);
    expect(regen.body.data?.id ?? regen.body.id).toBe(second.id);
  });
});
