import { createHash } from 'node:crypto';
import { tx, type Db, type Queryable } from '../db/pool.js';
import type { Settings } from '../settings.js';
import { logger } from '../log.js';
import { chunkText, countWords, effectiveOverlap, normaliseText, type ChunkOptions, type ChunkStrategy } from './chunk.js';
import { EMBED_DIMS, EMBED_MODEL, embedDeps, embedState, toVector } from './embed.js';
import { KnowledgeError } from './extract.js';

const log = logger('knowledge');

export interface SourceRow {
  id: number;
  kind: 'file' | 'text' | 'web';
  title: string;
  origin: string | null;
  site_root: string | null;
  mime: string | null;
  content_hash: string | null;
  strategy: ChunkStrategy;
  chunk_words: number;
  chunk_overlap: number;
  enabled: boolean;
  word_count: number;
  chunk_count: number;
  fetched_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const SOURCE_COLUMNS = `id, kind, title, origin, site_root, mime, content_hash, strategy, chunk_words, chunk_overlap, enabled,
  word_count, chunk_count, fetched_at, created_at, updated_at`;

export const hashText = (text: string) => createHash('sha256').update(text).digest('hex');

export function chunkOptionsFrom(settings: Settings, override: Partial<ChunkOptions> = {}): ChunkOptions {
  const words = override.words ?? settings.knowledgeChunkWords;
  return {
    strategy: override.strategy ?? settings.knowledgeChunkStrategy,
    words,
    overlap: effectiveOverlap(words, override.overlap ?? settings.knowledgeChunkOverlap),
  };
}

// ── Vector support ────────────────────────────────────────────────────────────

const vectorReady = new WeakMap<Db, boolean>();

/**
 * Adds the embedding column and index when pgvector is enabled in this database (only a superuser can enable
 * it: `npm run db:setup`). Without it, search uses Postgres full-text search alone.
 */
export async function ensureVectorSupport(db: Db): Promise<boolean> {
  const known = vectorReady.get(db);
  if (known !== undefined) return known;
  const has = (await db.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`)).rowCount === 1;
  if (has) {
    await db.query(`ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(${EMBED_DIMS})`);
    await db.query(`CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)`);
  }
  vectorReady.set(db, has);
  return has;
}

// ── Sources ───────────────────────────────────────────────────────────────────

async function writeChunks(client: Queryable, sourceId: number, text: string, opts: ChunkOptions) {
  await client.query('DELETE FROM knowledge_chunks WHERE source_id = $1', [sourceId]);
  const chunks = chunkText(text, opts);
  if (chunks.length) {
    await client.query(
      `INSERT INTO knowledge_chunks (source_id, ord, heading, content, word_count)
       SELECT $1, t.ord, t.heading, t.content, t.wc FROM unnest($2::int[], $3::text[], $4::text[], $5::int[]) AS t(ord, heading, content, wc)`,
      [sourceId, chunks.map((_, i) => i), chunks.map((c) => c.heading), chunks.map((c) => c.content), chunks.map((c) => c.wordCount)],
    );
  }
  await client.query(
    `UPDATE knowledge_sources SET strategy = $2, chunk_words = $3, chunk_overlap = $4, chunk_count = $5, word_count = $6, updated_at = now()
     WHERE id = $1`,
    [sourceId, opts.strategy, opts.words, opts.overlap, chunks.length, countWords(text)],
  );
  return chunks.length;
}

export interface NewSource {
  kind: 'file' | 'text' | 'web';
  title: string;
  text: string;
  origin?: string | null;
  siteRoot?: string | null;
  mime?: string | null;
}

/** Saves a document and its chunks in one transaction. Embedding happens afterwards in the background. */
export async function addSource(db: Db, src: NewSource, opts: ChunkOptions): Promise<SourceRow> {
  const text = normaliseText(src.text);
  if (!text) throw new KnowledgeError('NO_TEXT', 'There is no text to add.');
  return tx(db, async (client) => {
    const { rows } = await client.query<SourceRow>(
      `INSERT INTO knowledge_sources (kind, title, origin, site_root, mime, raw_text, content_hash, strategy, chunk_words, chunk_overlap, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $1 = 'web' THEN now() END) RETURNING ${SOURCE_COLUMNS}`,
      [src.kind, src.title.slice(0, 300), src.origin ?? null, src.siteRoot ?? null, src.mime ?? null, text, hashText(text), opts.strategy, opts.words, opts.overlap],
    );
    await writeChunks(client, rows[0]!.id, text, opts);
    return getSourceIn(client, rows[0]!.id);
  });
}

async function getSourceIn(client: Queryable, id: number): Promise<SourceRow> {
  const row = (await client.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM knowledge_sources WHERE id = $1`, [id])).rows[0];
  if (!row) throw new KnowledgeError('NOT_FOUND', 'Document not found');
  return row;
}

/**
 * A website page, keyed by its URL. Unchanged text keeps its chunks (and embeddings); changed text is
 * re-chunked. Returns whether anything changed.
 */
export async function upsertPage(db: Db, page: { url: string; siteRoot: string; title: string; text: string }, opts: ChunkOptions) {
  const text = normaliseText(page.text);
  const hash = hashText(text);
  return tx(db, async (client) => {
    const existing = (
      await client.query<{ id: number; content_hash: string | null; strategy: string; chunk_words: number; chunk_overlap: number }>(
        `SELECT id, content_hash, strategy, chunk_words, chunk_overlap FROM knowledge_sources WHERE kind = 'web' AND origin = $1 FOR UPDATE`,
        [page.url],
      )
    ).rows[0];
    if (existing && existing.content_hash === hash) {
      await client.query(`UPDATE knowledge_sources SET fetched_at = now(), title = $2, site_root = $3 WHERE id = $1`, [existing.id, page.title.slice(0, 300), page.siteRoot]);
      return { id: existing.id, changed: false };
    }
    let id: number;
    if (existing) {
      id = existing.id;
      await client.query(
        `UPDATE knowledge_sources SET raw_text = $2, content_hash = $3, title = $4, site_root = $5, fetched_at = now(), updated_at = now() WHERE id = $1`,
        [id, text, hash, page.title.slice(0, 300), page.siteRoot],
      );
    } else {
      id = (
        await client.query<{ id: number }>(
          `INSERT INTO knowledge_sources (kind, title, origin, site_root, mime, raw_text, content_hash, strategy, chunk_words, chunk_overlap, fetched_at)
           VALUES ('web', $1, $2, $3, 'text/html', $4, $5, $6, $7, $8, now()) RETURNING id`,
          [page.title.slice(0, 300), page.url, page.siteRoot, text, hash, opts.strategy, opts.words, opts.overlap],
        )
      ).rows[0]!.id;
    }
    await writeChunks(client, id, text, opts);
    return { id, changed: true };
  });
}

/** Re-splits a source with new chunk settings (from its saved text, no re-upload). */
export async function rechunkSource(db: Db, id: number, opts: ChunkOptions) {
  return tx(db, async (client) => {
    const row = (await client.query<{ raw_text: string }>('SELECT raw_text FROM knowledge_sources WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!row) throw new KnowledgeError('NOT_FOUND', 'Document not found');
    await writeChunks(client, id, row.raw_text, opts);
    return getSourceIn(client, id);
  });
}

export async function rechunkAll(db: Db, opts: ChunkOptions) {
  const ids = (await db.query<{ id: number }>('SELECT id FROM knowledge_sources ORDER BY id')).rows.map((r) => r.id);
  for (const id of ids) await rechunkSource(db, id, opts);
  return ids.length;
}

export async function listSources(db: Queryable, kind?: string) {
  const { rows } = await db.query<SourceRow & { embedded: number }>(
    `SELECT ${SOURCE_COLUMNS.split(',').map((c) => `s.${c.trim()}`).join(', ')},
            (SELECT count(*)::int FROM knowledge_chunks c WHERE c.source_id = s.id AND c.embedded_at IS NOT NULL) AS embedded
     FROM knowledge_sources s ${kind ? 'WHERE s.kind = $1' : ''} ORDER BY s.kind, s.site_root NULLS FIRST, s.title`,
    kind ? [kind] : [],
  );
  return rows;
}

export async function getSource(db: Queryable, id: number) {
  const source = await getSourceIn(db, id);
  const chunks = (
    await db.query<{ id: number; ord: number; heading: string | null; content: string; word_count: number; embedded_at: Date | null }>(
      'SELECT id, ord, heading, content, word_count, embedded_at FROM knowledge_chunks WHERE source_id = $1 ORDER BY ord',
      [id],
    )
  ).rows;
  return { ...source, chunks };
}

export async function updateSource(db: Queryable, id: number, patch: { title?: string; enabled?: boolean }) {
  const { rowCount } = await db.query(
    `UPDATE knowledge_sources SET title = coalesce($2, title), enabled = coalesce($3, enabled), updated_at = now() WHERE id = $1`,
    [id, patch.title ?? null, patch.enabled ?? null],
  );
  if (!rowCount) throw new KnowledgeError('NOT_FOUND', 'Document not found');
  return getSourceIn(db, id);
}

/** Knowledge is your own content, so it can be removed for good (its chunks go with it). */
export async function deleteSource(db: Queryable, id: number) {
  const { rowCount } = await db.query('DELETE FROM knowledge_sources WHERE id = $1', [id]);
  if (!rowCount) throw new KnowledgeError('NOT_FOUND', 'Document not found');
}

export async function deleteSite(db: Queryable, siteRoot: string) {
  return (await db.query(`DELETE FROM knowledge_sources WHERE kind = 'web' AND site_root = $1`, [siteRoot])).rowCount ?? 0;
}

// ── Embedding (background, local) ─────────────────────────────────────────────

const embedding = { running: false, again: false, controller: null as AbortController | null };
const BATCH = 16;

/**
 * Embeds every chunk that has no embedding yet, in small batches. Runs in the background on your CPU; safe to
 * call repeatedly (one run at a time). Stops at shutdown via stopEmbedding().
 */
export function kickEmbedding(db: Db) {
  if (embedding.running) {
    embedding.again = true;
    return;
  }
  embedding.running = true;
  embedding.controller = new AbortController();
  const signal = embedding.controller.signal;
  void (async () => {
    try {
      do {
        embedding.again = false;
        await embedPending(db, signal);
      } while (embedding.again && !signal.aborted);
    } catch (err) {
      if (!signal.aborted) log.error('Embedding knowledge chunks failed; search uses full-text until it works', err);
    } finally {
      embedding.running = false;
      embedding.controller = null;
    }
  })();
}

export function stopEmbedding() {
  embedding.controller?.abort();
}

export async function embedPending(db: Db, signal?: AbortSignal): Promise<number> {
  if (!(await ensureVectorSupport(db))) return 0;
  let done = 0;
  for (;;) {
    if (signal?.aborted) break;
    const { rows } = await db.query<{ id: number; heading: string | null; content: string }>(
      `SELECT id, heading, content FROM knowledge_chunks WHERE embedded_at IS NULL ORDER BY id LIMIT ${BATCH}`,
    );
    if (!rows.length) break;
    const vectors = await embedDeps.embed(rows.map((r) => (r.heading ? `${r.heading}\n${r.content}` : r.content)), 'passage');
    for (let i = 0; i < rows.length; i++) {
      // A chunk replaced meanwhile (re-chunk) simply no longer exists: the update touches nothing.
      await db.query(`UPDATE knowledge_chunks SET embedding = $2::vector, embedded_at = now() WHERE id = $1`, [rows[i]!.id, toVector(vectors[i]!)]);
    }
    done += rows.length;
  }
  if (done) log.info(`Embedded ${done} knowledge chunk(s) for search`);
  return done;
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchHit {
  chunkId: number;
  sourceId: number;
  title: string;
  origin: string | null;
  kind: string;
  heading: string | null;
  content: string;
  score: number;
  similarity: number | null;
  matchedBy: Array<'meaning' | 'words'>;
}

/**
 * Hybrid search over enabled sources: meaning (vector similarity, when available) and words (Postgres full-text),
 * merged by reciprocal rank fusion. A chunk found both ways ranks highest. Falls back to words alone when the
 * vector extension or the local model is not available.
 */
export async function searchKnowledge(db: Db, query: string, opts: { limit?: number } = {}): Promise<{ hits: SearchHit[]; mode: 'hybrid' | 'words' }> {
  const q = query.trim().slice(0, 2000);
  const limit = opts.limit ?? 6;
  if (!q) return { hits: [], mode: 'words' };
  const POOL = 30;
  const K = 60;

  // Words: any of the query's terms (OR), ranked by how many and how close together.
  const words = await db.query<{ id: number }>(
    `SELECT c.id FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id
       CROSS JOIN (SELECT CAST(nullif(replace(plainto_tsquery('english', $1)::text, '&', '|'), '') AS tsquery) AS q) t
     WHERE s.enabled AND t.q IS NOT NULL AND c.tsv @@ t.q
     ORDER BY ts_rank_cd(c.tsv, t.q) DESC, c.id LIMIT ${POOL}`,
    [q],
  );

  let meaning: Array<{ id: number; sim: number }> = [];
  let mode: 'hybrid' | 'words' = 'words';
  if (await ensureVectorSupport(db)) {
    try {
      const [vec] = await embedDeps.embed([q], 'query');
      meaning = (
        await db.query<{ id: number; sim: number }>(
          `SELECT c.id, 1 - (c.embedding <=> $1::vector) AS sim FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id
           WHERE s.enabled AND c.embedding IS NOT NULL ORDER BY c.embedding <=> $1::vector LIMIT ${POOL}`,
          [toVector(vec!)],
        )
      ).rows;
      mode = 'hybrid';
    } catch (err) {
      log.warn(`Meaning search unavailable, using word search: ${(err as Error).message}`);
    }
  }

  const scores = new Map<number, { score: number; sim: number | null; by: Set<'meaning' | 'words'> }>();
  const add = (id: number, rank: number, by: 'meaning' | 'words', sim: number | null = null) => {
    const e = scores.get(id) ?? { score: 0, sim: null, by: new Set() };
    e.score += 1 / (K + rank + 1);
    if (sim !== null) e.sim = sim;
    e.by.add(by);
    scores.set(id, e);
  };
  words.rows.forEach((r, i) => add(r.id, i, 'words'));
  meaning.forEach((r, i) => add(r.id, i, 'meaning', Number(r.sim)));

  const top = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
  if (!top.length) return { hits: [], mode };
  const { rows } = await db.query<{ id: number; source_id: number; heading: string | null; content: string; title: string; origin: string | null; kind: string }>(
    `SELECT c.id, c.source_id, c.heading, c.content, s.title, s.origin, s.kind
     FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id WHERE c.id = ANY($1)`,
    [top.map(([id]) => id)],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hits = top
    .filter(([id]) => byId.has(id))
    .map(([id, e]) => {
      const r = byId.get(id)!;
      return {
        chunkId: id, sourceId: r.source_id, title: r.title, origin: r.origin, kind: r.kind, heading: r.heading, content: r.content,
        score: Number(e.score.toFixed(5)), similarity: e.sim === null ? null : Number(e.sim.toFixed(3)), matchedBy: [...e.by],
      };
    });
  return { hits, mode };
}

export async function knowledgeStatus(db: Db) {
  const vector = await ensureVectorSupport(db);
  const counts = (
    await db.query<{ sources: number; files: number; pages: number; chunks: number; embedded: number }>(
      `SELECT (SELECT count(*)::int FROM knowledge_sources) AS sources,
              (SELECT count(*)::int FROM knowledge_sources WHERE kind <> 'web') AS files,
              (SELECT count(*)::int FROM knowledge_sources WHERE kind = 'web') AS pages,
              (SELECT count(*)::int FROM knowledge_chunks) AS chunks,
              (SELECT count(*)::int FROM knowledge_chunks WHERE embedded_at IS NOT NULL) AS embedded`,
    )
  ).rows[0]!;
  return {
    ...counts,
    vector,
    model: EMBED_MODEL,
    embedder: { ...embedState, running: embedding.running },
  };
}

