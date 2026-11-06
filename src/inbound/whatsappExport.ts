import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type { Db, Queryable } from '../db/pool.js';
import type { Settings } from '../settings.js';
import { formatPhone, phoneKey } from '../leads/normalize.js';
import { upsertLead, type UpsertOutcome } from '../leads/leads.js';
import { parseCategory, type Category } from '../discovery/catalog.js';
import { suppressionReason } from '../outreach/suppressions.js';
import { OutreachError } from '../outreach/messages.js';

/**
 * WhatsApp group exports (assist only). You export a group chat yourself (group → More → Export chat → Without
 * media), upload the .txt or .zip here, tick the vendors you want, and they become leads. Nothing is read from
 * WhatsApp itself and the full chat is never stored: only each sender's name, number and one short sample of
 * what they posted (so you remember why you picked them).
 *
 * These people never agreed to hear from you, so their leads are low-trust: only messages you send yourself,
 * never email, and every first message opens with your group first line (where you got their number + STOP).
 */

const MAX_TEXT = 10_000_000;
const SAMPLE = 200;

/** Android: "12/03/2024, 14:22 - Name: text" (also "12/03/24, 2:22 pm - …"). iOS: "[12/03/2024, 14:22:05] Name: text". */
const ANDROID = /^(\d{1,2}[/.]\d{1,2}[/.]\d{2,4}),? (\d{1,2}:\d{2}(?::\d{2})?(?:[\s ]?[ap]\.?m\.?)?) - ([^:]{1,80}?): (.*)$/i;
const IOS = /^\[(\d{1,2}[/.]\d{1,2}[/.]\d{2,4}),? (\d{1,2}:\d{2}(?::\d{2})?(?:[\s ]?[AP]M)?)\] ([^:]{1,80}?): (.*)$/i;
/** A line that starts a new entry but has no "Name: " (joins, leaves, "changed the subject"…). */
const SYSTEM_START = /^(\[?\d{1,2}[/.]\d{1,2}[/.]\d{2,4},? \d{1,2}:\d{2})/;
/** Nigerian numbers written in a message: 0803 123 4567, +234 803…, 234803… */
const PHONE_IN_TEXT = /(?:\+?234[\s-]?|0)[789][01]\d(?:[\s-]?\d){7}/g;
const NOT_CONTENT = /^(<media omitted>|<attached:.*>|image omitted|video omitted|audio omitted|sticker omitted|document omitted|gif omitted|this message was deleted|you deleted this message|null|‎?missed (voice|video) call.*)$/i;

export interface ExportCandidate {
  /** Stable within one file: the sender as written in the export. */
  key: string;
  name: string;
  phone: string | null;
  phoneKey: string | null;
  /** Where the number came from: the sender line itself, or written in one of their messages. */
  phoneFrom: 'sender' | 'message' | null;
  messages: number;
  sample: string | null;
  category: Category | null;
  existingLeadId: number | null;
  /** On your do-not-contact list: can't be imported. */
  blocked: string | null;
}

export interface ExportPreview {
  group: string | null;
  lines: number;
  candidates: ExportCandidate[];
}

/** Text of an uploaded export: the .txt itself, or the chat inside a .zip ("_chat.txt", else the first .txt). */
export function exportText(fileName: string, data: Buffer): string {
  const isZip = data.length > 4 && data.readUInt32LE(0) === 0x04034b50;
  if (!isZip) {
    if (!/\.txt$/i.test(fileName) && /[\x00-\x08]/.test(data.subarray(0, 512).toString('latin1'))) {
      throw new OutreachError('BAD_FILE', 'That is not a WhatsApp export. Upload the .txt or .zip from "Export chat".');
    }
    return data.toString('utf8');
  }
  const entries = zipEntries(data);
  const chat = entries.find((e) => /(^|\/)_chat\.txt$/i.test(e.name)) ?? entries.find((e) => /\.txt$/i.test(e.name));
  if (!chat) throw new OutreachError('BAD_FILE', 'The .zip has no chat text file in it. Export the chat again "Without media".');
  return readZipEntry(data, chat).toString('utf8');
}

interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

/** A small reader for the zip's central directory (enough for WhatsApp's exports; no encryption, no zip64). */
function zipEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new OutreachError('BAD_FILE', 'The .zip file looks damaged. Export the chat again.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    out.push({
      method: buf.readUInt16LE(p + 10),
      compressed: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
      offset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

function readZipEntry(buf: Buffer, e: ZipEntry): Buffer {
  if (e.size > MAX_TEXT) throw new OutreachError('TOO_BIG', 'That chat is too large. Export a smaller group, or "Without media".');
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new OutreachError('BAD_FILE', 'The .zip file looks damaged. Export the chat again.');
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const raw = buf.subarray(start, start + e.compressed);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_TEXT });
  throw new OutreachError('BAD_FILE', 'The .zip uses a compression this app cannot read. Upload the .txt instead.');
}

/** The group's name from the export's file name ("WhatsApp Chat with Lagos Vendors.zip" → "Lagos Vendors"). */
export function groupFromFileName(fileName: string): string | null {
  const m = /WhatsApp Chat (?:with|-) (.+?)(?: \(\d+\))?\.(txt|zip)$/i.exec(fileName.split(/[\\/]/).pop() ?? '');
  return m?.[1]?.trim() || null;
}

interface Sender {
  key: string;
  messages: string[];
}

/** One candidate per sender, in the order they first wrote. */
export function parseExport(text: string): { lines: number; senders: Sender[] } {
  if (text.length > MAX_TEXT) throw new OutreachError('TOO_BIG', 'That chat is too large. Export a smaller group.');
  const senders = new Map<string, Sender>();
  let current: Sender | null = null;
  let lines = 0;
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/^[‎‏]+/, '');
    const m = ANDROID.exec(line) ?? IOS.exec(line);
    if (m) {
      lines++;
      const key = m[3]!.replace(/[‎‏‪‬]/g, '').trim();
      const s = senders.get(key) ?? { key, messages: [] };
      senders.set(key, s);
      s.messages.push(m[4]!.replace(/[‎‏]/g, ''));
      current = s;
    } else if (SYSTEM_START.test(line)) {
      current = null; // "X added Y", "X left"…: not a message
    } else if (current && line.trim()) {
      current.messages[current.messages.length - 1] += `\n${line}`;
    }
  }
  return { lines, senders: [...senders.values()] };
}

function candidateFrom(s: Sender): Omit<ExportCandidate, 'existingLeadId' | 'blocked'> {
  const content = s.messages.map((m) => m.trim()).filter((m) => m && !NOT_CONTENT.test(m));
  let key = phoneKey(s.key);
  let phoneFrom: ExportCandidate['phoneFrom'] = key ? 'sender' : null;
  if (!key) {
    for (const m of content) {
      for (const hit of m.match(PHONE_IN_TEXT) ?? []) {
        key = phoneKey(hit);
        if (key) break;
      }
      if (key) break;
    }
    if (key) phoneFrom = 'message';
  }
  // The longest message usually says what they sell.
  const best = [...content].sort((a, b) => b.length - a.length)[0] ?? null;
  const sample = best ? best.replace(/\s+/g, ' ').slice(0, SAMPLE) : null;
  const isNumber = phoneKey(s.key) !== null;
  return {
    key: s.key,
    name: isNumber ? '' : s.key.slice(0, 120),
    phone: formatPhone(key),
    phoneKey: key,
    phoneFrom,
    messages: s.messages.length,
    sample,
    category: parseCategory(`${s.key} ${content.join(' ')}`.slice(0, 5000)),
  };
}

export async function previewExport(db: Queryable, fileName: string, data: Buffer): Promise<ExportPreview> {
  const { lines, senders } = parseExport(exportText(fileName, data));
  if (!lines) throw new OutreachError('EMPTY', 'No messages found. Is this a WhatsApp chat export (the .txt or .zip from "Export chat")?');
  const candidates: ExportCandidate[] = [];
  for (const s of senders) {
    const c = candidateFrom(s);
    const existing = c.phoneKey ? (await db.query<{ id: number }>('SELECT id FROM leads WHERE phone_key = $1 ORDER BY id LIMIT 1', [c.phoneKey])).rows[0] : undefined;
    candidates.push({ ...c, existingLeadId: existing?.id ?? null, blocked: c.phoneKey ? await suppressionReason(db, { phoneKey: c.phoneKey }) : null });
  }
  return { group: groupFromFileName(fileName), lines, candidates };
}

export interface ImportRow {
  name: string;
  phone: string;
  category: Category;
  sample?: string | null;
  city?: string | null;
  state?: string | null;
}

export async function importExport(db: Db, settings: Settings, group: string, rows: ImportRow[]) {
  if (!settings.groupImportEnabled) throw new OutreachError('OFF', 'Turn on WhatsApp group imports in Settings → Web search & groups first.');
  const summary: Record<UpsertOutcome, number> & { skipped: Array<{ name: string; reason: string }> } = { created: 0, merged: 0, seen: 0, skipped: [] };
  for (const r of rows) {
    const key = phoneKey(r.phone);
    const name = r.name.trim();
    if (!key) {
      summary.skipped.push({ name: name || r.phone, reason: 'No Nigerian phone number' });
      continue;
    }
    const blocked = await suppressionReason(db, { phoneKey: key });
    if (blocked) {
      summary.skipped.push({ name: name || formatPhone(key)!, reason: blocked });
      continue;
    }
    const by = 'Your WhatsApp group export';
    const { outcome } = await upsertLead(db, {
      business_name: name || formatPhone(key)!,
      category: r.category,
      source: 'whatsapp_group',
      source_ref: createHash('sha1').update(`${group.toLowerCase()}|${key}`).digest('hex').slice(0, 16),
      city: r.city?.trim() || null,
      state: r.state?.trim() || null,
      phone: key,
      socials: { whatsapp: key },
      group_source: group,
      facts: [
        { label: 'Seen in WhatsApp group', value: group, source: by },
        ...(r.sample?.trim() ? [{ label: 'What they posted', value: r.sample.trim().slice(0, SAMPLE), source: by }] : []),
      ],
    }, settings.qualifyThreshold);
    summary[outcome]++;
  }
  return summary;
}
