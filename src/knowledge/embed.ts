import path from 'node:path';
import { ROOT_DIR } from '../config.js';

/**
 * Embeddings run on your laptop with a small open model (BGE small, English, ~35 MB). It is downloaded once from
 * Hugging Face on first use into .cache/models, then works offline. No API key, no cost, and your documents
 * never leave the laptop.
 */
export const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
export const EMBED_DIMS = 384;
/** BGE expects this instruction on search queries (not on the passages being searched). */
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

export type EmbedKind = 'query' | 'passage';

export const embedState: { status: 'idle' | 'loading' | 'ready' | 'failed'; error: string | null } = { status: 'idle', error: null };

type Extractor = (texts: string[], opts: { pooling: 'cls'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let extractor: Promise<Extractor> | null = null;

async function loadExtractor(): Promise<Extractor> {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = path.join(ROOT_DIR, '.cache', 'models');
  return (await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' })) as unknown as Extractor;
}

async function localEmbed(texts: string[], kind: EmbedKind): Promise<number[][]> {
  if (!texts.length) return [];
  if (!extractor) {
    embedState.status = 'loading';
    extractor = loadExtractor().then(
      (e) => {
        embedState.status = 'ready';
        embedState.error = null;
        return e;
      },
      (err: Error) => {
        extractor = null;
        embedState.status = 'failed';
        embedState.error = `Could not load the search model: ${err.message}`;
        throw err;
      },
    );
  }
  const run = await extractor;
  const input = kind === 'query' ? texts.map((t) => QUERY_PREFIX + t) : texts;
  // CLS pooling + normalisation is how BGE is meant to be used; inputs over 512 tokens are truncated.
  return (await run(input, { pooling: 'cls', normalize: true })).tolist();
}

/** Replaceable in tests, so no test downloads the model. */
export const embedDeps: { embed: (texts: string[], kind: EmbedKind) => Promise<number[][]> } = { embed: localEmbed };

/** pgvector's text form: [0.1,0.2,…]. */
export const toVector = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : '0')).join(',')}]`;
