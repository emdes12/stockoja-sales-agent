import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import type { Db } from '../db/pool.js';
import { getState, setState, type Settings } from '../settings.js';
import { parseCategory } from '../discovery/catalog.js';
import { manualToCandidate } from '../discovery/csvImport.js';
import { assertOk, fetchText } from '../discovery/http.js';
import { requalify, upsertLead } from '../leads/leads.js';
import type { RecurringJob, TaskHandler } from '../agent/controller.js';
import { PermanentError } from '../queue/queue.js';
import { recordUsage } from '../usage.js';
import { findReferrer } from './referrals.js';

/**
 * The interest form: merchants fill in a Google Form (free, always online); you publish its response sheet as
 * CSV; the running agent reads that link and adds each new answer as a lead, linked to whoever referred them.
 * Nothing is posted back to Google and no Google login is stored.
 */
export const TASK_IMPORT_FORM = 'inbound.import_form';

export const FORM_FIELDS = [
  'timestamp', 'businessName', 'phone', 'email', 'instagram', 'facebook', 'tiktok', 'telegram',
  'category', 'city', 'state', 'consent', 'referredBy', 'referralCode',
] as const;
export type FormField = (typeof FORM_FIELDS)[number];
export type FormColumns = Record<FormField, string>;

export interface MappedSheet {
  headers: string[];
  /** Which column each field was found in (by its title). */
  matched: Partial<Record<FormField, string>>;
  /** Fields you named in Settings that the sheet doesn't have. */
  missing: FormField[];
  rows: Array<{ key: string; values: Partial<Record<FormField, string>> }>;
}

/** Finds each field's column by its title: an exact match (ignoring case), else a column that starts with it. */
export function mapSheet(csv: string, columns: FormColumns): MappedSheet {
  const records = parse(csv.replace(/^﻿/, ''), { relax_column_count: true, skip_empty_lines: true }) as string[][];
  const headers = (records[0] ?? []).map((h) => h.trim());
  const lower = headers.map((h) => h.toLowerCase());
  const index: Partial<Record<FormField, number>> = {};
  const matched: MappedSheet['matched'] = {};
  const missing: FormField[] = [];
  for (const field of FORM_FIELDS) {
    const want = columns[field]?.trim().toLowerCase();
    if (!want) continue;
    let i = lower.indexOf(want);
    if (i < 0) i = lower.findIndex((h) => h.startsWith(want));
    if (i < 0) missing.push(field);
    else {
      index[field] = i;
      matched[field] = headers[i]!;
    }
  }
  const rows = records.slice(1).map((cells) => {
    const values: Partial<Record<FormField, string>> = {};
    for (const [field, i] of Object.entries(index) as Array<[FormField, number]>) {
      const v = cells[i]?.trim();
      if (v) values[field] = v;
    }
    return { key: createHash('sha1').update(cells.map((c) => c.trim()).join('\u0001')).digest('hex'), values };
  });
  return { headers, matched, missing, rows };
}

/** A ticked consent box comes through as its label; an unticked one as nothing. */
export const consentGiven = (v: string | undefined) => !!v && !/^(no|false|0|n|off)$/i.test(v.trim());

export interface ImportSummary {
  rows: number;
  alreadyImported: number;
  created: number;
  merged: number;
  seen: number;
  skipped: Record<string, number>;
  referrals: number;
  missingColumns: FormField[];
}

/** Adds every new answer as a lead (or merges it into the lead it matches) and links referrals. */
export async function importResponses(db: Db, sheet: MappedSheet, settings: Settings): Promise<ImportSummary> {
  const summary: ImportSummary = { rows: sheet.rows.length, alreadyImported: 0, created: 0, merged: 0, seen: 0, skipped: {}, referrals: 0, missingColumns: sheet.missing };
  const skip = async (key: string, values: object, reason: string) => {
    summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
    await db.query(
      `INSERT INTO form_responses (row_key, outcome, skip_reason, data) VALUES ($1, 'skipped', $2, $3) ON CONFLICT (row_key) DO NOTHING`,
      [key, reason, JSON.stringify(values)],
    );
  };
  for (const { key, values: v } of sheet.rows) {
    if ((await db.query('SELECT 1 FROM form_responses WHERE row_key = $1', [key])).rowCount) {
      summary.alreadyImported++;
      continue;
    }
    if (!v.businessName) {
      await skip(key, v, 'NO_BUSINESS_NAME');
      continue;
    }
    if (settings.interestFormRequireConsent && !consentGiven(v.consent)) {
      await skip(key, v, 'NO_CONSENT');
      continue;
    }
    const candidate = manualToCandidate(
      {
        business_name: v.businessName,
        category: parseCategory(v.category) ?? settings.interestFormDefaultCategory,
        phone: v.phone, whatsapp: v.phone, email: v.email,
        instagram: v.instagram, facebook: v.facebook, tiktok: v.tiktok, telegram: v.telegram,
        city: v.city, state: v.state,
        notes: v.category && !parseCategory(v.category) ? `Sells: ${v.category}` : null,
      },
      'form',
    );
    if ('error' in candidate) {
      await skip(key, v, 'INVALID');
      continue;
    }
    if (!candidate.phone && !candidate.email && !Object.keys(candidate.socials ?? {}).length) {
      await skip(key, v, 'NO_CONTACT');
      continue;
    }
    candidate.source_ref = key;
    candidate.facts.push({
      label: 'Asked to hear from us',
      value: `Filled in the interest form${v.timestamp ? ` (${v.timestamp})` : ''}${consentGiven(v.consent) ? ', and agreed to be contacted' : ''}`,
      source: 'Your interest form',
    });
    const { leadId, outcome } = await upsertLead(db, candidate, settings.qualifyThreshold);
    summary[outcome]++;
    await db.query('UPDATE leads SET asked_to_hear_at = coalesce(asked_to_hear_at, now()) WHERE id = $1', [leadId]);

    const referrer = await findReferrer(db, { code: v.referralCode, text: v.referredBy }, settings, leadId);
    if (referrer) {
      const { rowCount } = await db.query('UPDATE leads SET referred_by_lead_id = $2 WHERE id = $1 AND referred_by_lead_id IS NULL', [leadId, referrer.leadId]);
      if (rowCount) summary.referrals++;
    }
    await requalify(db, leadId, settings.qualifyThreshold);
    await db.query(
      `INSERT INTO form_responses (row_key, submitted_at, lead_id, outcome, referred_by_text, referral_code, referrer_lead_id, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (row_key) DO NOTHING`,
      [key, v.timestamp ?? null, leadId, outcome, v.referredBy ?? null, v.referralCode ?? null, referrer?.leadId ?? null, JSON.stringify(v)],
    );
  }
  return summary;
}

/** Reads the published response sheet. */
export async function fetchSheet(db: Db, url: string, signal?: AbortSignal): Promise<string> {
  const r = await fetchText(url, { signal, timeoutMs: 30_000, maxBytes: 5_000_000, headers: { Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.5' } });
  await recordUsage(db, 'google_sheets', 'read_form_responses');
  assertOk(r, 'Interest form sheet');
  if (/text\/html/i.test(r.contentType) || /^\s*<(!doctype|html)/i.test(r.text)) {
    throw new PermanentError(
      'That link returns a web page, not CSV. In the response sheet: File → Share → Publish to web → pick the responses sheet and "Comma-separated values (.csv)", then copy that link.',
    );
  }
  return r.text;
}

export interface LastImport extends Partial<ImportSummary> {
  at: string;
  error?: string;
}

export const formHandlers: Record<string, TaskHandler> = {
  [TASK_IMPORT_FORM]: {
    // Reading the sheet and importing is idempotent (each answer is remembered by its hash).
    policy: { retrySafe: true, reviewIfOverdue: false },
    async run(_task, { db, signal, settings, log }) {
      if (!settings.interestFormEnabled) return { skipped: 'the interest form is off in Settings' };
      if (!settings.interestFormCsvUrl) return { skipped: 'no response-sheet link in Settings' };
      try {
        const sheet = mapSheet(await fetchSheet(db, settings.interestFormCsvUrl, signal), settings.interestFormColumns);
        if (!sheet.matched.businessName) throw new PermanentError(`The sheet has no "${settings.interestFormColumns.businessName}" column. Check the column titles under Settings → Interest form.`);
        const summary = await importResponses(db, sheet, settings);
        await setState(db, 'inbound.lastImport', { at: new Date().toISOString(), ...summary } satisfies LastImport);
        const skipped = Object.entries(summary.skipped).map(([k, n]) => `${n} ${k.toLowerCase().replace(/_/g, ' ')}`).join(', ');
        if (summary.created || summary.merged || skipped) {
          log.info(`Interest form: ${summary.created} new lead(s), ${summary.merged} matched existing, ${summary.referrals} referral(s) linked${skipped ? `; skipped ${skipped}` : ''}`);
        }
        return summary;
      } catch (err) {
        if (!signal.aborted) await setState(db, 'inbound.lastImport', { at: new Date().toISOString(), error: (err as Error).message } satisfies LastImport);
        throw err;
      }
    },
  },
};

export const formRecurring: RecurringJob[] = [
  {
    type: TASK_IMPORT_FORM,
    everyMinutes: (s) => s.interestFormCheckMinutes,
    enabled: (s) => s.interestFormEnabled && !!s.interestFormCsvUrl,
  },
];

export const lastImport = (db: Db) => getState<LastImport>(db, 'inbound.lastImport');
