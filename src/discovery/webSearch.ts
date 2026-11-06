import { tx, type Db, type Queryable } from '../db/pool.js';
import type { Settings } from '../settings.js';
import { env, userAgent } from '../config.js';
import { normalizeUrl, socialPlatform, websiteDomain } from '../leads/normalize.js';
import { socialHandle, type SocialChannel } from '../outreach/channels.js';
import { OutreachError } from '../outreach/messages.js';

/**
 * Web search through an official API (Tavily, Brave, or both), on your click only. A result that is a business
 * website or a social profile becomes something you can add as a lead (or look up on Instagram). Nothing is
 * scraped: results come from the provider, and pages are read later only through the normal website check,
 * which follows robots.txt.
 *
 * Spending is capped by the agent itself: each provider has a monthly limit you set, counted before every call,
 * so a mistake can't run up a bill (Brave has no cap of its own). The same search within a few days is answered
 * from the saved results.
 */

export const PROVIDERS = ['tavily', 'brave'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const SCOPES = ['any', 'instagram', 'facebook', 'tiktok'] as const;
export type Scope = (typeof SCOPES)[number];

const SCOPE_DOMAIN: Record<Exclude<Scope, 'any'>, string> = { instagram: 'instagram.com', facebook: 'facebook.com', tiktok: 'tiktok.com' };
/** Nominal cost per search, for the Usage page. Tavily's free plan simply stops at its allowance; Brave bills against a $5 monthly credit. */
const COST_USD: Record<Provider, string> = { tavily: '0', brave: '0.005' };
const LABEL: Record<Provider, string> = { tavily: 'Tavily', brave: 'Brave Search' };

/** Replaceable in tests, so no test ever calls a provider. */
export const searchDeps: { fetch: (url: string, init: RequestInit) => Promise<Response> } = {
  fetch: (url, init) => fetch(url, init),
};

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  kind: 'website' | 'profile' | 'other';
  /** For a profile: platform and username. */
  platform: SocialChannel | null;
  handle: string | null;
  domain: string | null;
  /** A lead you already have with this website or profile. */
  leadId: number | null;
}

export interface ProviderOutcome {
  provider: Provider;
  cached: boolean;
  results: SearchResult[];
  error: string | null;
  usedThisMonth: number;
  limit: number;
}

export const keyFor = (p: Provider) => (p === 'tavily' ? env.TAVILY_API_KEY : env.BRAVE_SEARCH_API_KEY);
export const limitFor = (p: Provider, s: Settings) => (p === 'tavily' ? s.tavilyMonthlyLimit : s.braveMonthlyLimit);

export function searchConfigProblems(p: Provider): string[] {
  return keyFor(p) ? [] : [`Set ${p === 'tavily' ? 'TAVILY_API_KEY' : 'BRAVE_SEARCH_API_KEY'} in .env, then restart the app.`];
}

export async function usedThisMonth(db: Queryable, p: Provider): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT coalesce(sum(units), 0)::int AS n FROM usage_events WHERE provider = $1 AND kind = 'search' AND at >= date_trunc('month', now())`,
    [p],
  );
  return rows[0]!.n;
}

/** Counts the search before it is made, under a lock, so two clicks can't both slip past the limit. */
async function reserve(db: Db, p: Provider, settings: Settings, query: string) {
  const limit = limitFor(p, settings);
  return tx(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [724_100_010]);
    const used = await usedThisMonth(client, p);
    if (used >= limit) {
      throw new OutreachError('SEARCH_LIMIT', `${LABEL[p]}: this month's limit of ${limit} searches is reached. Raise it in Settings → Web search & groups, or wait for next month.`);
    }
    await client.query(
      `INSERT INTO usage_events (provider, kind, units, estimated_usd, detail) VALUES ($1, 'search', 1, $2, $3)`,
      [p, COST_USD[p], JSON.stringify({ query: query.slice(0, 200) })],
    );
    return used + 1;
  });
}

interface Raw {
  title: string;
  url: string;
  snippet: string;
}

async function callProvider(p: Provider, query: string, scope: Scope, settings: Settings, signal?: AbortSignal): Promise<Raw[]> {
  const timeout = AbortSignal.timeout(20_000);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const count = settings.webSearchResultsPerQuery;
  let res: Response;
  if (p === 'tavily') {
    res = await searchDeps.fetch(`${env.TAVILY_API_URL.replace(/\/$/, '')}/search`, {
      method: 'POST',
      signal: sig,
      headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}`, 'Content-Type': 'application/json', 'User-Agent': userAgent() },
      body: JSON.stringify({
        query,
        search_depth: 'basic', // 1 credit; "advanced" costs 2
        max_results: count,
        include_answer: false,
        ...(scope !== 'any' ? { include_domains: [SCOPE_DOMAIN[scope]] } : {}),
      }),
    });
  } else {
    const url = new URL(`${env.BRAVE_SEARCH_API_URL.replace(/\/$/, '')}/res/v1/web/search`);
    url.searchParams.set('q', scope !== 'any' ? `${query} site:${SCOPE_DOMAIN[scope]}` : query);
    url.searchParams.set('count', String(count));
    url.searchParams.set('country', settings.webSearchCountry);
    url.searchParams.set('safesearch', 'moderate');
    res = await searchDeps.fetch(url.toString(), {
      method: 'GET',
      signal: sig,
      headers: { 'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY, Accept: 'application/json', 'User-Agent': userAgent() },
    });
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const msg = (body?.detail as string) ?? ((body?.error as { detail?: string })?.detail) ?? `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new OutreachError('SEARCH_KEY', `${LABEL[p]} refused the API key (${msg}). Check it in .env.`);
    if (res.status === 429) throw new OutreachError('SEARCH_RATE', `${LABEL[p]} says too many requests or the plan's allowance is used up (${msg}).`);
    throw new OutreachError('SEARCH_FAILED', `${LABEL[p]} search failed: ${msg}`);
  }
  if (p === 'tavily') {
    const rows = (body?.results as Array<{ title?: string; url?: string; content?: string }>) ?? [];
    return rows.filter((r) => r.url).map((r) => ({ title: r.title ?? '', url: r.url!, snippet: r.content ?? '' }));
  }
  const rows = ((body?.web as { results?: Array<{ title?: string; url?: string; description?: string }> })?.results) ?? [];
  return rows.filter((r) => r.url).map((r) => ({ title: r.title ?? '', url: r.url!, snippet: (r.description ?? '').replace(/<\/?strong>/g, '') }));
}

/** What a result is: a business website, a social profile (with its username), or something else (a post, a directory page). */
export function classify(raw: Raw): Omit<SearchResult, 'leadId'> {
  const url = normalizeUrl(raw.url) ?? raw.url;
  const platform = socialPlatform(url) as SocialChannel | null;
  const base = { title: raw.title.trim().slice(0, 300), url, snippet: raw.snippet.trim().slice(0, 500) };
  if (platform && ['instagram', 'facebook', 'tiktok', 'telegram'].includes(platform)) {
    const handle = socialHandle(platform, url);
    return { ...base, kind: handle ? 'profile' : 'other', platform: handle ? platform : null, handle, domain: null };
  }
  if (platform) return { ...base, kind: 'other', platform: null, handle: null, domain: null };
  const domain = websiteDomain(url);
  return { ...base, kind: domain ? 'website' : 'other', platform: null, handle: null, domain };
}

/** Marks results that are already leads (same website domain, or same profile username). */
async function markKnown(db: Queryable, results: Array<Omit<SearchResult, 'leadId'>>): Promise<SearchResult[]> {
  const domains = [...new Set(results.map((r) => r.domain).filter(Boolean))] as string[];
  const byDomain = new Map<string, number>();
  if (domains.length) {
    const { rows } = await db.query<{ id: number; website_domain: string }>(`SELECT id, website_domain FROM leads WHERE website_domain = ANY($1)`, [domains]);
    for (const r of rows) byDomain.set(r.website_domain, r.id);
  }
  const out: SearchResult[] = [];
  for (const r of results) {
    let leadId = r.domain ? byDomain.get(r.domain) ?? null : null;
    if (!leadId && r.platform && r.handle) {
      const { rows } = await db.query<{ id: number; v: string }>(
        `SELECT id, socials->>$1 AS v FROM leads WHERE socials ? $1 AND position($2 in lower(socials->>$1)) > 0`,
        [r.platform, r.handle],
      );
      leadId = rows.find((x) => socialHandle(r.platform!, x.v) === r.handle)?.id ?? null;
    }
    out.push({ ...r, leadId });
  }
  return out;
}

export interface SearchRequest {
  query: string;
  scope: Scope;
  providers: Provider[];
  /** Ignore saved results and search again (spends a search). */
  fresh?: boolean;
}

/** Runs one search on each chosen provider. A provider that fails or is over its limit reports why; the others still run. */
export async function webSearch(db: Db, settings: Settings, req: SearchRequest, signal?: AbortSignal): Promise<ProviderOutcome[]> {
  const query = req.query.trim().replace(/\s+/g, ' ');
  if (query.length < 3) throw new OutreachError('BAD_QUERY', 'Type at least a few words to search for.');
  const chosen = [...new Set(req.providers)];
  if (!chosen.length) throw new OutreachError('NO_PROVIDER', 'Choose Tavily, Brave or both.');
  for (const p of chosen) {
    if (!settings.webSearchProviders.includes(p)) throw new OutreachError('PROVIDER_OFF', `${LABEL[p]} is off. Tick it in Settings → Web search & groups.`);
  }
  const outcomes: ProviderOutcome[] = [];
  for (const p of chosen) {
    const limit = limitFor(p, settings);
    const base = { provider: p, limit };
    const problems = searchConfigProblems(p);
    if (problems.length) {
      outcomes.push({ ...base, cached: false, results: [], error: problems.join(' '), usedThisMonth: await usedThisMonth(db, p) });
      continue;
    }
    if (!req.fresh && settings.webSearchCacheDays > 0) {
      const saved = (await db.query<{ results: Array<Omit<SearchResult, 'leadId'>> }>(
        `SELECT results FROM web_searches WHERE provider = $1 AND lower(query) = lower($2) AND scope = $3 AND error IS NULL
           AND created_at > now() - make_interval(days => $4) ORDER BY created_at DESC LIMIT 1`,
        [p, query, req.scope, settings.webSearchCacheDays],
      )).rows[0];
      if (saved) {
        outcomes.push({ ...base, cached: true, results: await markKnown(db, saved.results), error: null, usedThisMonth: await usedThisMonth(db, p) });
        continue;
      }
    }
    let used: number;
    try {
      used = await reserve(db, p, settings, query);
    } catch (err) {
      if (!(err instanceof OutreachError)) throw err;
      outcomes.push({ ...base, cached: false, results: [], error: err.message, usedThisMonth: await usedThisMonth(db, p) });
      continue;
    }
    try {
      const results = (await callProvider(p, query, req.scope, settings, signal)).map(classify);
      await db.query(`INSERT INTO web_searches (provider, query, scope, results) VALUES ($1, $2, $3, $4)`, [p, query, req.scope, JSON.stringify(results)]);
      outcomes.push({ ...base, cached: false, results: await markKnown(db, results), error: null, usedThisMonth: used });
    } catch (err) {
      const message = err instanceof OutreachError ? err.message : `${LABEL[p]}: ${(err as Error).message}`;
      await db.query(`INSERT INTO web_searches (provider, query, scope, error) VALUES ($1, $2, $3, $4)`, [p, query, req.scope, message]);
      outcomes.push({ ...base, cached: false, results: [], error: message, usedThisMonth: used });
    }
  }
  return outcomes;
}

/** Ready-made queries for a category and place, so you don't have to think of wording each time. */
export function suggestQueries(categoryLabel: string, place: string): Array<{ query: string; scope: Scope }> {
  const what = categoryLabel.toLowerCase().replace(/ & /g, ' and ');
  const p = place.trim();
  return [
    { query: `${what} shop ${p}`, scope: 'any' },
    { query: `${what} ${p} WhatsApp orders`, scope: 'any' },
    { query: `${what} ${p}`, scope: 'instagram' },
    { query: `${what} vendor ${p}`, scope: 'facebook' },
    { query: `${what} ${p}`, scope: 'tiktok' },
  ];
}
