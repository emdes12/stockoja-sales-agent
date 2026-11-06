import type pg from 'pg';
import { tx, type Db, type Queryable } from '../db/pool.js';
import type { Category } from '../discovery/catalog.js';
import { nameKey, normalizeEmail, normalizeUrl, phoneKey, formatPhone, websiteDomain } from './normalize.js';
import { qualify, type Fact } from './qualify.js';

export const LEAD_STATUSES = [
  'discovered', 'qualified', 'unqualified', 'archived', 'do_not_contact',
  'contacted', 'replied', 'interested', 'demo_booked', 'registered', 'activated', 'declined',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface LeadRow {
  id: number;
  business_name: string;
  name_key: string;
  category: Category;
  source_tag: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  phone: string | null;
  phone_key: string | null;
  email: string | null;
  website: string | null;
  website_domain: string | null;
  socials: Record<string, string>;
  branch_count: number;
  is_chain_brand: boolean;
  source: string;
  source_url: string | null;
  discovered_at: Date;
  score: number | null;
  score_breakdown: unknown[];
  facts: Fact[];
  assumptions: unknown[];
  relevance: unknown[];
  status: LeadStatus;
  status_set_by: 'auto' | 'user';
  notes: string | null;
  qualified_at: Date | null;
  enriched_at: Date | null;
  asked_to_hear_at: Date | null;
  referred_by_lead_id: number | null;
  referral_code: string | null;
  /** Set when the lead came from a WhatsApp group export you imported: the group's name. */
  group_source: string | null;
  updated_at: Date;
}

/** A business as one source describes it, before de-duplication. */
export interface LeadCandidate {
  business_name: string;
  category: Category;
  source: 'osm' | 'csv' | 'manual' | 'form' | 'whatsapp_group';
  source_ref: string;
  source_url?: string | null;
  source_tag?: string | null;
  city?: string | null;
  state?: string | null;
  address?: string | null;
  lat?: number | null;
  lon?: number | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  socials?: Record<string, string>;
  is_chain_brand?: boolean;
  facts: Fact[];
  notes?: string | null;
  /** A WhatsApp group export: the group's name. Only set on a new lead (a business already listed elsewhere stays as it was). */
  group_source?: string | null;
}

export type UpsertOutcome = 'created' | 'merged' | 'seen';

const DEDUPE_LOCK = 724_100_002;

/** Normalised fields of a candidate, ready to store. */
function prepare(c: LeadCandidate) {
  const pk = phoneKey(c.phone);
  const website = normalizeUrl(c.website);
  return {
    business_name: c.business_name.trim(),
    name_key: nameKey(c.business_name),
    phone_key: pk,
    phone: pk ? formatPhone(pk) : null,
    email: normalizeEmail(c.email),
    website: website && websiteDomain(website) ? website : null,
    website_domain: websiteDomain(website),
  };
}

async function findMatch(client: pg.PoolClient, c: LeadCandidate, p: ReturnType<typeof prepare>) {
  const bySource = await client.query<{ lead_id: number }>(
    'SELECT lead_id FROM lead_sources WHERE source = $1 AND source_ref = $2',
    [c.source, c.source_ref],
  );
  if (bySource.rows[0]) return { id: bySource.rows[0].lead_id, via: 'source' as const };

  const checks: Array<[string, unknown[]]> = [];
  if (p.phone_key) checks.push(['phone_key = $1', [p.phone_key]]);
  if (p.email) checks.push(['lower(email) = $1', [p.email]]);
  if (p.website_domain) checks.push(['website_domain = $1', [p.website_domain]]);
  // Same name in the same state is treated as one business (branches of one shop are one prospect).
  if (p.name_key && c.state) checks.push(['name_key = $1 AND state = $2', [p.name_key, c.state]]);
  for (const [where, params] of checks) {
    const { rows } = await client.query<{ id: number }>(`SELECT id FROM leads WHERE ${where} ORDER BY id LIMIT 1`, params);
    if (rows[0]) return { id: rows[0].id, via: 'match' as const };
  }
  return null;
}

function mergeFacts(existing: Fact[], incoming: Fact[]): Fact[] {
  const seen = new Set(existing.map((f) => `${f.label}|${f.value}|${f.source}`));
  return [...existing, ...incoming.filter((f) => !seen.has(`${f.label}|${f.value}|${f.source}`))];
}

/**
 * Adds a candidate, merging it into an existing lead when it is the same business
 * (same source record, phone, email, website domain, or name within the same state).
 * Existing values are never overwritten; only blanks are filled. Re-qualifies the lead afterwards.
 */
export async function upsertLead(
  db: Db,
  c: LeadCandidate,
  threshold: number,
): Promise<{ leadId: number; outcome: UpsertOutcome }> {
  return tx(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [DEDUPE_LOCK]);
    const p = prepare(c);
    const match = await findMatch(client, c, p);
    let leadId: number;
    let outcome: UpsertOutcome;

    if (match) {
      leadId = match.id;
      outcome = match.via === 'source' ? 'seen' : 'merged';
      const cur = (await client.query<LeadRow>('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [leadId])).rows[0]!;
      await client.query(
        `UPDATE leads SET
           phone = coalesce(phone, $2), phone_key = coalesce(phone_key, $3), email = coalesce(email, $4),
           website = coalesce(website, $5), website_domain = coalesce(website_domain, $6),
           address = coalesce(address, $7), city = coalesce(city, $8), state = coalesce(state, $9),
           lat = coalesce(lat, $10), lon = coalesce(lon, $11), source_tag = coalesce(source_tag, $12),
           socials = $13::jsonb || socials, is_chain_brand = is_chain_brand OR $14, facts = $15, updated_at = now()
         WHERE id = $1`,
        [
          leadId, p.phone, p.phone_key, p.email, p.website, p.website_domain, c.address ?? null, c.city ?? null,
          c.state ?? null, c.lat ?? null, c.lon ?? null, c.source_tag ?? null, JSON.stringify(c.socials ?? {}),
          !!c.is_chain_brand, JSON.stringify(mergeFacts(cur.facts, c.facts)),
        ],
      );
    } else {
      outcome = 'created';
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO leads (business_name, name_key, category, source_tag, city, state, address, lat, lon, phone, phone_key,
           email, website, website_domain, socials, is_chain_brand, source, source_url, facts, notes, group_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
        [
          p.business_name, p.name_key, c.category, c.source_tag ?? null, c.city ?? null, c.state ?? null, c.address ?? null,
          c.lat ?? null, c.lon ?? null, p.phone, p.phone_key, p.email, p.website, p.website_domain,
          JSON.stringify(c.socials ?? {}), !!c.is_chain_brand, c.source, c.source_url ?? null, JSON.stringify(c.facts),
          c.notes ?? null, c.group_source ?? null,
        ],
      );
      leadId = rows[0]!.id;
    }

    await client.query(
      `INSERT INTO lead_sources (lead_id, source, source_ref, source_url, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source, source_ref) DO UPDATE SET last_seen = now()`,
      [leadId, c.source, c.source_ref, c.source_url ?? null, JSON.stringify({ name: c.business_name, lat: c.lat, lon: c.lon })],
    );
    // Each OpenStreetMap element is one physical location.
    await client.query(
      `UPDATE leads SET branch_count = greatest(1, (SELECT count(*) FROM lead_sources WHERE lead_id = $1 AND source = 'osm'))
       WHERE id = $1`,
      [leadId],
    );
    await requalify(client, leadId, threshold);
    return { leadId, outcome };
  });
}

/** Recomputes score, assumptions and feature fit. Changes status only if you have not set it yourself. */
export async function requalify(db: Queryable, leadId: number, threshold: number): Promise<LeadRow | null> {
  const lead = (await db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
  if (!lead) return null;
  const q = qualify({
    category: lead.category,
    phone_key: lead.phone_key,
    email: lead.email,
    website_domain: lead.website_domain,
    socials: lead.socials,
    address: lead.address,
    branch_count: lead.branch_count,
    is_chain_brand: lead.is_chain_brand,
    has_opening_hours: lead.facts.some((f) => f.label === 'Opening hours'),
    asked_to_hear: !!lead.asked_to_hear_at,
  });
  const autoStatus: LeadStatus = q.score >= threshold && q.hasContactChannel ? 'qualified' : 'unqualified';
  const { rows } = await db.query<LeadRow>(
    `UPDATE leads SET score = $2, score_breakdown = $3, assumptions = $4, relevance = $5,
       status = CASE WHEN status_set_by = 'auto' AND status IN ('discovered', 'qualified', 'unqualified') THEN $6 ELSE status END,
       qualified_at = CASE WHEN status_set_by = 'auto' AND $6 = 'qualified' AND status <> 'qualified' THEN now() ELSE qualified_at END,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [leadId, q.score, JSON.stringify(q.breakdown), JSON.stringify(q.assumptions), JSON.stringify(q.relevance), autoStatus],
  );
  return rows[0] ?? null;
}

/** Re-scores every lead, e.g. after you change the qualification threshold. */
export async function requalifyAll(db: Db, threshold: number): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM leads ORDER BY id');
  for (const r of rows) await requalify(db, r.id, threshold);
  return rows.length;
}

export interface LeadFilters {
  q?: string;
  status?: LeadStatus;
  category?: Category;
  state?: string;
  minScore?: number;
  contact?: 'email' | 'phone' | 'any' | 'none';
  sort?: 'score' | 'newest' | 'name';
  page: number;
  pageSize: number;
}

export async function listLeads(db: Queryable, f: LeadFilters) {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.q) {
    const like = p(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`);
    where.push(`(business_name ILIKE ${like} OR city ILIKE ${like} OR address ILIKE ${like} OR email ILIKE ${like} OR website_domain ILIKE ${like})`);
  }
  if (f.status) where.push(`status = ${p(f.status)}`);
  if (f.category) where.push(`category = ${p(f.category)}`);
  if (f.state) where.push(`state = ${p(f.state)}`);
  if (f.minScore !== undefined) where.push(`coalesce(score, 0) >= ${p(f.minScore)}`);
  if (f.contact === 'email') where.push('email IS NOT NULL');
  if (f.contact === 'phone') where.push('phone_key IS NOT NULL');
  if (f.contact === 'any') where.push(`(email IS NOT NULL OR phone_key IS NOT NULL OR socials <> '{}'::jsonb)`);
  if (f.contact === 'none') where.push(`(email IS NULL AND phone_key IS NULL AND socials = '{}'::jsonb)`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order =
    f.sort === 'newest' ? 'discovered_at DESC, id DESC' : f.sort === 'name' ? 'business_name ASC' : 'score DESC NULLS LAST, id DESC';
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM leads ${clause}`, params)).rows[0]!.n;
  const { rows } = await db.query<LeadRow>(
    `SELECT id, business_name, category, city, state, phone, email, website, website_domain, socials, branch_count,
            is_chain_brand, source, score, status, status_set_by, discovered_at, enriched_at
     FROM leads ${clause} ORDER BY ${order} LIMIT ${p(f.pageSize)} OFFSET ${p((f.page - 1) * f.pageSize)}`,
    params,
  );
  return { data: rows, meta: { page: f.page, pageSize: f.pageSize, total, pages: Math.max(1, Math.ceil(total / f.pageSize)) } };
}

export async function getLead(db: Queryable, id: number) {
  const lead = (await db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [id])).rows[0];
  if (!lead) return null;
  const sources = (
    await db.query('SELECT source, source_ref, source_url, first_seen, last_seen FROM lead_sources WHERE lead_id = $1 ORDER BY first_seen', [id])
  ).rows;
  const tasks = (
    await db.query(
      'SELECT id, type, status, attempts, last_error, review_reason, run_at, updated_at FROM tasks WHERE lead_id = $1 ORDER BY id DESC LIMIT 20',
      [id],
    )
  ).rows;
  const referredBy = lead.referred_by_lead_id
    ? (await db.query<{ id: number; business_name: string }>('SELECT id, business_name FROM leads WHERE id = $1', [lead.referred_by_lead_id])).rows[0] ?? null
    : null;
  const referrals = (
    await db.query('SELECT id, business_name, status FROM leads WHERE referred_by_lead_id = $1 ORDER BY id', [id])
  ).rows;
  return { ...lead, sources, tasks, referredBy, referrals };
}

export async function updateLead(
  db: Db,
  id: number,
  patch: { status?: LeadStatus; notes?: string | null; category?: Category; socials?: Record<string, string | null> },
  threshold: number,
): Promise<LeadRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  if (patch.status !== undefined) {
    params.push(patch.status);
    sets.push(`status = $${params.length}`, `status_set_by = 'user'`);
    if (patch.status === 'qualified') sets.push('qualified_at = coalesce(qualified_at, now())');
  }
  if (patch.notes !== undefined) {
    params.push(patch.notes);
    sets.push(`notes = $${params.length}`);
  }
  if (patch.category !== undefined) {
    params.push(patch.category);
    sets.push(`category = $${params.length}`);
  }
  if (patch.socials !== undefined) {
    // Set or replace a profile per platform; null removes it.
    const set = Object.fromEntries(Object.entries(patch.socials).filter(([, v]) => v));
    const remove = Object.entries(patch.socials).filter(([, v]) => !v).map(([k]) => k);
    params.push(JSON.stringify(set), remove);
    sets.push(`socials = (socials - $${params.length}::text[]) || $${params.length - 1}::jsonb`);
  }
  if (!sets.length) return (await db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [id])).rows[0] ?? null;
  const { rows } = await db.query<LeadRow>(`UPDATE leads SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  if (!rows[0]) return null;
  return patch.category !== undefined || patch.socials !== undefined ? requalify(db, id, threshold) : rows[0];
}

/** Hands status back to automatic scoring. */
export async function resetLeadStatus(db: Db, id: number, threshold: number) {
  await db.query(`UPDATE leads SET status_set_by = 'auto', status = 'discovered' WHERE id = $1`, [id]);
  return requalify(db, id, threshold);
}

/** Adds what a website showed: email (only if none yet), social links, and facts. */
export async function applyEnrichment(
  db: Db,
  id: number,
  found: { email: string | null; socials: Record<string, string>; facts: Fact[] },
  threshold: number,
) {
  await tx(db, async (client) => {
    const cur = (await client.query<LeadRow>('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) return;
    await client.query(
      `UPDATE leads SET email = coalesce(email, $2), socials = $3::jsonb || socials, facts = $4, enriched_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, normalizeEmail(found.email), JSON.stringify(found.socials), JSON.stringify(mergeFacts(cur.facts, found.facts))],
    );
    await requalify(client, id, threshold);
  });
}

export async function leadCounts(db: Queryable) {
  const { rows } = await db.query<{ status: LeadStatus; n: number }>('SELECT status, count(*)::int AS n FROM leads GROUP BY status');
  const by = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
  for (const r of rows) by[r.status] = r.n;
  const contact = (
    await db.query<{ email: number; phone: number }>(
      `SELECT count(*) FILTER (WHERE email IS NOT NULL)::int AS email, count(*) FILTER (WHERE phone_key IS NOT NULL)::int AS phone FROM leads`,
    )
  ).rows[0]!;
  return { total: Object.values(by).reduce((a, b) => a + b, 0), byStatus: by, withEmail: contact.email, withPhone: contact.phone };
}
