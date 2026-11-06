import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import { parseCategory } from './catalog.js';
import { normalizeUrl, socialPlatform } from '../leads/normalize.js';
import type { LeadCandidate } from '../leads/leads.js';
import type { Fact } from '../leads/qualify.js';

/** Column names accepted in an import file (case-insensitive; spaces or underscores). */
export const CSV_COLUMNS = [
  'business_name', 'category', 'city', 'state', 'address', 'phone', 'email', 'website',
  'instagram', 'facebook', 'tiktok', 'telegram', 'whatsapp', 'source_url', 'notes',
] as const;

export interface ManualLeadInput {
  business_name: string;
  category: string;
  city?: string | null;
  state?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  tiktok?: string | null;
  telegram?: string | null;
  whatsapp?: string | null;
  source_url?: string | null;
  notes?: string | null;
}

/**
 * A lead you supply (form or CSV). Everything in it is recorded as "Added by you", which the dashboard
 * shows separately from facts read from a public source.
 */
export function manualToCandidate(input: ManualLeadInput, source: 'csv' | 'manual' | 'form'): LeadCandidate | { error: string } {
  const name = input.business_name?.trim();
  if (!name) return { error: 'business_name is required' };
  const category = parseCategory(input.category);
  if (!category) return { error: `Unknown category "${input.category ?? ''}"` };

  const socials: Record<string, string> = {};
  for (const p of ['instagram', 'facebook', 'tiktok', 'telegram', 'whatsapp'] as const) {
    const v = input[p]?.trim();
    if (v) socials[p] = v;
  }
  let website = normalizeUrl(input.website);
  if (website && socialPlatform(website)) {
    socials[socialPlatform(website)!] ??= website;
    website = null;
  }
  const sourceUrl = normalizeUrl(input.source_url);
  const by = source === 'csv' ? 'Imported by you (CSV)' : source === 'form' ? 'Your interest form' : 'Added by you';
  const fact = (label: string, value: string | null | undefined): Fact[] =>
    value?.trim() ? [{ label, value: value.trim(), source: by, url: sourceUrl }] : [];

  // Stable reference so importing the same row twice is recognised.
  const ref = createHash('sha1')
    .update([name.toLowerCase(), input.phone ?? '', input.email ?? '', website ?? '', input.city ?? ''].join('|'))
    .digest('hex')
    .slice(0, 16);

  return {
    business_name: name,
    category,
    source,
    source_ref: ref,
    source_url: sourceUrl,
    city: input.city?.trim() || null,
    state: input.state?.trim() || null,
    address: input.address?.trim() || null,
    phone: input.phone?.trim() || null,
    email: input.email?.trim() || null,
    website,
    socials,
    facts: [
      ...fact('Business name', name),
      ...fact('Phone', input.phone),
      ...fact('Email', input.email),
      ...fact('Website', website),
      ...fact('Address', input.address),
      ...Object.entries(socials).map(([p, v]) => ({ label: `Profile (${p})`, value: v, source: by, url: sourceUrl })),
    ],
    notes: input.notes?.trim() || null,
  };
}

export function parseCsv(text: string): { rows: ManualLeadInput[]; error?: string } {
  try {
    const records = parse(text, {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_')),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    }) as Record<string, string>[];
    if (records.length > 5000) return { rows: [], error: 'Import at most 5,000 rows at a time.' };
    if (records[0] && !('business_name' in records[0])) return { rows: [], error: 'The CSV needs a business_name column.' };
    return { rows: records as unknown as ManualLeadInput[] };
  } catch (err) {
    return { rows: [], error: `Could not read the CSV: ${(err as Error).message}` };
  }
}
