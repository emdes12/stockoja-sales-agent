/**
 * Splits a document into chunks for search. Pure; tested in tests/knowledge.test.ts.
 *
 * - structure (default): follows the document's own shape. Text is split at headings, then paragraphs and list
 *   items; those pieces are packed into chunks of up to `words` words. A piece that is too long on its own is
 *   split at sentences. Each chunk remembers its heading path ("Pricing › Plans"), and a heading always stays with
 *   the text under it.
 * - fixed: a plain sliding window of `words` words, ignoring the layout. Useful for text with no structure.
 *
 * `overlap` words from the end of one chunk are repeated at the start of the next (within the same section), so
 * a fact that falls on a boundary is still found whole. Overlap is capped at half the chunk size.
 */

export type ChunkStrategy = 'structure' | 'fixed';

export interface ChunkOptions {
  strategy: ChunkStrategy;
  words: number;
  overlap: number;
}

export interface Chunk {
  heading: string | null;
  content: string;
  wordCount: number;
}

const split = (s: string) => s.split(/\s+/).filter(Boolean);
export const countWords = (s: string) => split(s).length;

export const effectiveOverlap = (words: number, overlap: number) => Math.max(0, Math.min(overlap, Math.floor(words / 2)));

export function normaliseText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  const clean = normaliseText(text);
  if (!clean) return [];
  const size = Math.max(10, opts.words);
  const overlap = effectiveOverlap(size, opts.overlap);
  return opts.strategy === 'fixed' ? fixedChunks(clean, size, overlap) : structuredChunks(clean, size, overlap);
}

function fixedChunks(text: string, size: number, overlap: number): Chunk[] {
  const words = split(text);
  const step = size - overlap;
  const out: Chunk[] = [];
  for (let i = 0; i < words.length; i += step) {
    const part = words.slice(i, i + size);
    out.push({ heading: null, content: part.join(' '), wordCount: part.length });
    if (i + size >= words.length) break;
  }
  return out;
}

interface Unit {
  section: number;
  path: string | null;
  text: string;
  words: number;
}

/** Breaks text into units no longer than `size` words: paragraphs, else sentences, else word windows. */
function fit(text: string, size: number): string[] {
  if (countWords(text) <= size) return [text];
  const sentences = text.split(/(?<=[.!?…])\s+|\n+/).filter((s) => s.trim());
  const out: string[] = [];
  let cur: string[] = [];
  let n = 0;
  for (const s of sentences) {
    const w = countWords(s);
    if (w > size) {
      if (cur.length) out.push(cur.join(' '));
      cur = [];
      n = 0;
      const words = split(s);
      for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(' '));
      continue;
    }
    if (n + w > size && cur.length) {
      out.push(cur.join(' '));
      cur = [];
      n = 0;
    }
    cur.push(s);
    n += w;
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}

function toUnits(text: string, size: number): Unit[] {
  const units: Unit[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let section = 0;
  let pendingHeading: string[] = [];
  const path = () => (stack.length ? stack.map((h) => h.title).join(' › ') : null);

  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const body: string[] = [];
    const flushBody = () => {
      const t = body.join('\n').trim();
      body.length = 0;
      if (!t) return;
      // A heading stays with the first text under it.
      const withHeading = [...pendingHeading, t].join('\n');
      pendingHeading = [];
      for (const piece of fit(withHeading, size)) units.push({ section, path: path(), text: piece, words: countWords(piece) });
    };
    for (const line of lines) {
      const h = line.match(/^(#{1,6})\s+(.+)$/);
      if (!h) {
        body.push(line);
        continue;
      }
      flushBody();
      const level = h[1]!.length;
      const title = h[2]!.replace(/#+\s*$/, '').trim();
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title });
      section++;
      pendingHeading.push(line.trim());
    }
    flushBody();
  }
  // Headings with no text after them (end of document) are kept on their own.
  if (pendingHeading.length) {
    const t = pendingHeading.join('\n');
    units.push({ section, path: path(), text: t, words: countWords(t) });
  }
  return units;
}

function structuredChunks(text: string, size: number, overlap: number): Chunk[] {
  const out: Chunk[] = [];
  let parts: string[] = [];
  let words = 0;
  let heading: string | null = null;
  let lastSection = -1;

  const flush = () => {
    const content = parts.join('\n\n');
    out.push({ heading, content, wordCount: countWords(content) });
  };

  for (const u of toUnits(text, size)) {
    if (words + u.words > size && parts.length) {
      flush();
      const tail = overlap && u.section === lastSection ? split(parts.join(' ')).slice(-overlap) : [];
      // Overlap only as far as it still leaves room for the new text.
      const room = Math.max(0, size - u.words);
      const keep = tail.slice(tail.length - Math.min(tail.length, room));
      parts = keep.length ? [`…${keep.join(' ')}`] : [];
      words = keep.length;
      heading = u.path;
    }
    if (!parts.length) heading = u.path;
    parts.push(u.text);
    words += u.words;
    lastSection = u.section;
  }
  if (parts.length) flush();
  return out;
}
