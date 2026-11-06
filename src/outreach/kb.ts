import type { Queryable } from '../db/pool.js';

export interface KbEntry {
  id: number;
  topic: string;
  question: string;
  answer: string;
  status: 'draft' | 'approved' | 'retired';
  source: string | null;
  approved_at: Date | null;
  updated_at: Date;
}

export async function listKb(db: Queryable) {
  return (await db.query<KbEntry>(`SELECT * FROM kb_entries ORDER BY CASE status WHEN 'draft' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, topic, id`)).rows;
}

export async function createKb(db: Queryable, e: { topic: string; question: string; answer: string; source?: string | null }) {
  const { rows } = await db.query<KbEntry>(
    `INSERT INTO kb_entries (topic, question, answer, source) VALUES ($1, $2, $3, $4) RETURNING *`,
    [e.topic, e.question, e.answer, e.source ?? 'Written by you'],
  );
  return rows[0]!;
}

/** Changing an approved answer puts it back to draft: the agent only uses text you have approved as it stands. */
export async function updateKb(db: Queryable, id: number, patch: { topic?: string; question?: string; answer?: string }) {
  const { rows } = await db.query<KbEntry>(
    `UPDATE kb_entries SET topic = coalesce($2, topic), question = coalesce($3, question), answer = coalesce($4, answer),
       status = CASE WHEN status = 'approved' AND (coalesce($3, question) <> question OR coalesce($4, answer) <> answer) THEN 'draft' ELSE status END,
       approved_at = CASE WHEN status = 'approved' AND (coalesce($3, question) <> question OR coalesce($4, answer) <> answer) THEN NULL ELSE approved_at END,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, patch.topic ?? null, patch.question ?? null, patch.answer ?? null],
  );
  return rows[0] ?? null;
}

export async function setKbStatus(db: Queryable, id: number, status: 'approved' | 'retired' | 'draft') {
  const { rows } = await db.query<KbEntry>(
    `UPDATE kb_entries SET status = $2, approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE NULL END, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, status],
  );
  return rows[0] ?? null;
}

const STOP = new Set('a an and are as at be can do does for from how i in is it me my of on or the to we what with you your'.split(' '));
const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(ing|es|s)$/, ''));

/**
 * Finds approved answers for a question by word overlap. Deliberately simple and predictable:
 * if nothing approved matches well, it returns nothing, and the conversation goes to you.
 */
export function rankKb(entries: KbEntry[], question: string, minScore = 0.34) {
  const q = new Set(words(question));
  if (!q.size) return [];
  return entries
    .map((e) => {
      const qWords = new Set(words(`${e.topic} ${e.question}`));
      const aWords = new Set(words(e.answer));
      let hits = 0;
      for (const w of q) hits += qWords.has(w) ? 1 : aWords.has(w) ? 0.5 : 0;
      return { entry: e, score: hits / q.size };
    })
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score);
}

export async function searchKb(db: Queryable, question: string) {
  const approved = (await db.query<KbEntry>(`SELECT * FROM kb_entries WHERE status = 'approved'`)).rows;
  return rankKb(approved, question).slice(0, 3);
}
