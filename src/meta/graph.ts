import { createHmac } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import { env } from '../config.js';
import { getState, setState } from '../settings.js';
import { PermanentError, RateLimitedError } from '../queue/queue.js';
import { recordUsage } from '../usage.js';

/**
 * A small client for Meta's Graph API, used with StockỌja's own Page access token. The token travels in the
 * Authorization header (never in a URL, so it can't end up in a log), and with META_APP_SECRET set each call
 * carries an appsecret_proof. Calls cost nothing; each is recorded in usage at 0.
 */

/** Replaceable in tests, so no test ever calls Meta. */
export const metaDeps: { fetch: (url: string, init: RequestInit) => Promise<Response> } = {
  fetch: (url, init) => fetch(url, init),
};

export interface ConfigProblem {
  key: string;
  message: string;
}

export function metaConfigProblems(): ConfigProblem[] {
  const p: ConfigProblem[] = [];
  if (!env.META_PAGE_ACCESS_TOKEN) p.push({ key: 'META_PAGE_ACCESS_TOKEN', message: 'Set META_PAGE_ACCESS_TOKEN in .env (a long-lived Page access token).' });
  if (!env.META_PAGE_ID) p.push({ key: 'META_PAGE_ID', message: "Set META_PAGE_ID in .env (your Facebook Page's numeric id)." });
  return p;
}

/** An error from Meta, with its code so callers can tell "not found" from "no permission". */
export class MetaApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: number | null, readonly subcode: number | null) {
    super(message);
  }
}

/** Codes Meta uses for rate limits (app, user, page and business-use-case limits). */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80006]);

/** Turns a Meta error into one you can act on. Never includes the token. */
export function explainMetaError(err: MetaApiError): Error {
  if (err.code === 190) {
    return new PermanentError('Meta says the Page access token is invalid or has expired. Generate a new long-lived Page token (see docs/META_SETUP.md) and update META_PAGE_ACCESS_TOKEN.');
  }
  if (err.code !== null && RATE_LIMIT_CODES.has(err.code)) return new RateLimitedError(`Meta rate limit: ${err.message}`, 15 * 60_000);
  if (err.code === 10 || err.code === 200 || (err.code !== null && err.code >= 200 && err.code < 300)) {
    return new PermanentError(`Meta refused the request for lack of permission: ${err.message}. Check the app's permissions in docs/META_SETUP.md.`);
  }
  return err;
}

type Params = Record<string, string | number | undefined>;

export async function graph<T>(
  db: Queryable,
  path: string,
  opts: { params?: Params; method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal; kind?: string } = {},
): Promise<T> {
  const url = new URL(`${env.META_GRAPH_URL.replace(/\/$/, '')}/${env.META_GRAPH_VERSION}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  if (env.META_APP_SECRET) {
    url.searchParams.set('appsecret_proof', createHmac('sha256', env.META_APP_SECRET).update(env.META_PAGE_ACCESS_TOKEN).digest('hex'));
  }
  const res = await metaDeps.fetch(url.toString(), {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${env.META_PAGE_ACCESS_TOKEN}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal ?? AbortSignal.timeout(20_000),
  });
  await recordUsage(db, 'meta', opts.kind ?? 'graph_call');
  const json = (await res.json().catch(() => null)) as { error?: { message?: string; code?: number; error_subcode?: number } } | null;
  if (!res.ok || json?.error) {
    const e = json?.error;
    throw new MetaApiError(e?.message ?? `Meta returned HTTP ${res.status}`, res.status, e?.code ?? null, e?.error_subcode ?? null);
  }
  return json as T;
}

/** Follows a `paging.next` link (already carries its own query, but not the token). */
export async function graphNext<T>(db: Queryable, next: string, signal?: AbortSignal): Promise<T> {
  const u = new URL(next);
  const base = `${env.META_GRAPH_URL.replace(/\/$/, '')}/`;
  // Only follow links back to the Graph API we were configured with.
  if (!next.startsWith(base)) throw new PermanentError('Unexpected paging link from Meta');
  u.searchParams.delete('access_token');
  const path = u.pathname.replace(/^\/v\d+\.\d+\//, '');
  return graph<T>(db, path, { params: Object.fromEntries(u.searchParams), signal });
}

/** The Instagram professional account linked to the Page: META_IG_USER_ID, or read from the Page once and kept. */
export async function igUserId(db: Queryable): Promise<string> {
  if (env.META_IG_USER_ID) return env.META_IG_USER_ID;
  const saved = await getState<{ pageId: string; id: string }>(db, 'meta.igUserId');
  if (saved && saved.pageId === env.META_PAGE_ID) return saved.id;
  const page = await graph<{ instagram_business_account?: { id: string } }>(db, env.META_PAGE_ID, { params: { fields: 'instagram_business_account' } });
  const id = page.instagram_business_account?.id;
  if (!id) throw new PermanentError('No Instagram professional account is linked to this Facebook Page. Link it in Instagram (Settings → Account type and tools / Business tools) or in Meta Business Suite.');
  await setState(db, 'meta.igUserId', { pageId: env.META_PAGE_ID, id });
  return id;
}

/** Proves the token and Page work, and names what they reach. Only on your click; stores nothing. */
export async function testMeta(db: Queryable): Promise<
  { ok: true; page: string; instagram: string | null; appSecretProof: boolean } | { ok: false; error: string }
> {
  const problems = metaConfigProblems();
  if (problems.length) return { ok: false, error: problems.map((p) => p.message).join(' ') };
  try {
    const page = await graph<{ name: string; instagram_business_account?: { username?: string } }>(db, env.META_PAGE_ID, {
      params: { fields: 'name,instagram_business_account{username}' },
    });
    return { ok: true, page: page.name, instagram: page.instagram_business_account?.username ?? null, appSecretProof: !!env.META_APP_SECRET };
  } catch (err) {
    return { ok: false, error: (err instanceof MetaApiError ? explainMetaError(err) : (err as Error)).message };
  }
}
