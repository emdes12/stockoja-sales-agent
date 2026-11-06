import type { Db } from '../db/pool.js';
import type { RecurringJob, TaskHandler } from '../agent/controller.js';
import type { Settings } from '../settings.js';
import { setState } from '../settings.js';
import { fetchText, politeGap } from '../discovery/http.js';
import { robotsAllows } from '../discovery/website.js';
import { recordUsage } from '../usage.js';
import { htmlToText } from './html.js';
import { chunkOptionsFrom, kickEmbedding, upsertPage } from './store.js';
import { countWords } from './chunk.js';

export const TASK_READ_WEBSITES = 'knowledge.read_websites';

/** Pages with fewer words than this are skipped (menus, redirects, pages built by JavaScript). */
const MIN_WORDS = 25;
const SKIP_EXT = /\.(png|jpe?g|gif|webp|svg|ico|css|js|json|xml|zip|rar|mp4|mp3|webm|woff2?|ttf|pdf|docx?|xlsx?|pptx?)$/i;

export interface SiteReadResult {
  link: string;
  pages: number;
  changed: number;
  unchanged: number;
  skipped: Array<{ url: string; why: string }>;
  error: string | null;
}

/** Same host, under the link's path; no fragments or query strings (they repeat pages). */
export function inScope(candidate: string, link: URL): string | null {
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || u.host !== link.host || SKIP_EXT.test(u.pathname)) return null;
  const prefix = link.pathname.replace(/[^/]*$/, '');
  if (!u.pathname.startsWith(prefix)) return null;
  u.hash = '';
  u.search = '';
  return u.toString();
}

/**
 * Reads one of your website links (and, up to `websiteMaxPages`, the pages it links to on the same site) into
 * the knowledge base. Follows robots.txt and spaces requests out. Only reads public pages; never logs in.
 */
export async function readWebsite(db: Db, link: string, settings: Settings, signal?: AbortSignal): Promise<SiteReadResult> {
  const root = new URL(link);
  const result: SiteReadResult = { link, pages: 0, changed: 0, unchanged: 0, skipped: [], error: null };
  const gap = settings.websiteMinIntervalSec * 1000;
  const opts = chunkOptionsFrom(settings);

  let robots = '';
  try {
    await politeGap(`site:${root.host}`, gap, signal);
    const r = await fetchText(`${root.origin}/robots.txt`, { signal, timeoutMs: 8000, maxBytes: 200_000 });
    if (r.status === 200 && !/text\/html/i.test(r.contentType)) robots = r.text;
  } catch {
    /* no robots.txt reachable: allowed by default */
  }

  const start = inScope(link, root) ?? link;
  const queue = [start];
  const seen = new Set(queue);
  while (queue.length && result.pages < settings.websiteMaxPages) {
    if (signal?.aborted) break;
    const url = queue.shift()!;
    const path = new URL(url).pathname;
    if (!robotsAllows(robots, path)) {
      result.skipped.push({ url, why: 'robots.txt asks robots not to read it' });
      continue;
    }
    await politeGap(`site:${root.host}`, gap, signal);
    let page;
    try {
      page = await fetchText(url, { signal, timeoutMs: 15_000, maxBytes: 3_000_000 });
    } catch (err) {
      if (signal?.aborted) break;
      result.skipped.push({ url, why: (err as Error).message });
      continue;
    }
    result.pages++;
    if (page.status >= 400) {
      result.skipped.push({ url, why: `HTTP ${page.status}` });
      continue;
    }
    if (!/html/i.test(page.contentType)) {
      result.skipped.push({ url, why: `not a web page (${page.contentType || 'unknown type'})` });
      continue;
    }
    const finalUrl = inScope(page.url, root) ?? url;
    const { title, text, links } = htmlToText(page.text, page.url);
    for (const l of links) {
      const next = inScope(l, root);
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
    if (countWords(text) < MIN_WORDS) {
      result.skipped.push({ url, why: 'almost no readable text (the page may build its content with JavaScript)' });
      continue;
    }
    const r = await upsertPage(db, { url: finalUrl, siteRoot: link, title: title ?? finalUrl, text }, opts);
    if (r.changed) result.changed++;
    else result.unchanged++;
  }
  await recordUsage(db, 'websites', 'knowledge_page', { units: result.pages, detail: { host: root.host } });
  return result;
}

export const knowledgeHandlers: Record<string, TaskHandler> = {
  [TASK_READ_WEBSITES]: {
    // Reading public pages and replacing their text is safe to repeat.
    policy: { retrySafe: true, reviewIfOverdue: false },
    async run(task, { db, signal, settings, log }) {
      const links = ((task.payload as { links?: string[] }).links ?? settings.websiteLinks).filter((l) => settings.websiteLinks.includes(l));
      if (!links.length) return { skipped: 'no website links in Settings' };
      const results: SiteReadResult[] = [];
      for (const link of links) {
        if (signal.aborted) break;
        try {
          results.push(await readWebsite(db, link, settings, signal));
        } catch (err) {
          if (signal.aborted) throw err;
          results.push({ link, pages: 0, changed: 0, unchanged: 0, skipped: [], error: (err as Error).message });
        }
      }
      await setState(db, 'knowledge.lastRead', { at: new Date().toISOString(), results });
      const changed = results.reduce((n, r) => n + r.changed, 0);
      log.info(
        `Website reading: ${results.map((r) => `${r.link}: ${r.error ? `failed (${r.error})` : `${r.pages} page(s), ${r.changed} new or changed, ${r.skipped.length} skipped`}`).join('; ')}`,
      );
      if (changed) kickEmbedding(db);
      return { results: results.map((r) => ({ ...r, skipped: r.skipped.slice(0, 20) })) };
    },
  },
};

export const knowledgeRecurring: RecurringJob[] = [
  {
    type: TASK_READ_WEBSITES,
    everyMinutes: (s) => Math.max(1, s.websiteRefreshDays) * 1440,
    enabled: (s) => s.websiteRefreshDays > 0 && s.websiteLinks.length > 0,
  },
];
