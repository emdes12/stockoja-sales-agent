import type { Fact } from '../leads/qualify.js';
import { hostOf, socialPlatform } from '../leads/normalize.js';
import { fetchText, politeGap } from './http.js';

/** Minimal robots.txt check: the `*` group (and ours), Disallow/Allow prefixes, longest match wins. */
export function robotsAllows(robotsTxt: string, path: string, agent = 'stockojasalesagent'): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; prefix: string }> }> = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (field === 'disallow' || field === 'allow') && value) current.rules.push({ allow: field === 'allow', prefix: value });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const applicable = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; prefix: string } | null = null;
  for (const rule of applicable.flatMap((g) => g.rules)) {
    const prefix = rule.prefix.replace(/\*.*$/, '').replace(/\$$/, '');
    if (path.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { ...rule, prefix };
  }
  return best ? best.allow : true;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IGNORED_EMAIL = /\.(png|jpe?g|gif|webp|svg)$|@(example|domain|email|sentry|wixpress|sentry-next)\.|^(you|your|name|user)@/i;

/** Pulls public contact details out of a page's HTML. Pure; tested in tests/website.test.ts. */
export function extractContacts(html: string, pageUrl: string) {
  const siteHost = hostOf(pageUrl);
  const decoded = html.replace(/&#64;|&commat;|\[at\]|\(at\)/gi, '@');
  const emails = new Set<string>();
  for (const m of decoded.matchAll(/mailto:([^"'?>\s]+)/gi)) emails.add(decodeURIComponent(m[1]!).toLowerCase());
  const text = decoded.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
  for (const m of text.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());
  const cleanEmails = [...emails].filter((e) => !IGNORED_EMAIL.test(e));
  // Prefer an address on the shop's own domain, then a role address (info@, sales@…), then anything else.
  cleanEmails.sort((a, b) => rankEmail(b, siteHost) - rankEmail(a, siteHost));

  const socials: Record<string, string> = {};
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = m[1]!;
    const platform = socialPlatform(href);
    if (!platform || socials[platform]) continue;
    // Skip share buttons and the platform's own pages.
    if (/sharer|share\?|intent\/tweet|\/plugins\/|\/dialog\//i.test(href)) continue;
    try {
      const u = new URL(href, pageUrl);
      if (u.pathname.length > 1 || platform === 'whatsapp') socials[platform] = u.toString();
    } catch {
      /* ignore malformed links */
    }
  }

  const contactPath = html.match(/href=["']((?:https?:\/\/[^"']+)?\/?[^"']*contact[^"']*)["']/i)?.[1] ?? null;
  return { emails: cleanEmails, socials, contactPath };
}

function rankEmail(email: string, siteHost: string | null) {
  const domain = email.split('@')[1] ?? '';
  let r = 0;
  if (siteHost && (domain === siteHost || siteHost.endsWith(`.${domain}`) || domain.endsWith(`.${siteHost}`))) r += 2;
  if (/^(info|sales|hello|contact|support|enquir|order|shop|admin)/.test(email)) r += 1;
  return r;
}

export interface EnrichmentResult {
  email: string | null;
  socials: Record<string, string>;
  facts: Fact[];
  pagesFetched: number;
  blockedByRobots: boolean;
}

/**
 * Looks for a public contact email and social links on the business's own website:
 * the home page, then one contact page if needed. Honors robots.txt and spaces requests out.
 */
export async function enrichFromWebsite(website: string, minGapMs: number, signal?: AbortSignal): Promise<EnrichmentResult> {
  const base = new URL(website);
  const origin = base.origin;
  const result: EnrichmentResult = { email: null, socials: {}, facts: [], pagesFetched: 0, blockedByRobots: false };

  await politeGap(`site:${base.host}`, minGapMs, signal);
  let robots = '';
  try {
    const r = await fetchText(`${origin}/robots.txt`, { signal, timeoutMs: 8000, maxBytes: 200_000 });
    if (r.status === 200 && !/text\/html/i.test(r.contentType)) robots = r.text;
  } catch {
    /* no robots.txt reachable: the default is allowed */
  }

  const pages = [base.pathname || '/'];
  for (let i = 0; i < pages.length && i < 2; i++) {
    const path = pages[i]!;
    if (!robotsAllows(robots, path)) {
      result.blockedByRobots = true;
      continue;
    }
    await politeGap(`site:${base.host}`, minGapMs, signal);
    const page = await fetchText(new URL(path, origin).toString(), { signal, timeoutMs: 12_000 });
    result.pagesFetched++;
    if (page.status >= 400 || !/html/i.test(page.contentType)) continue;
    const found = extractContacts(page.text, page.url);
    for (const [p, url] of Object.entries(found.socials)) {
      if (!result.socials[p]) {
        result.socials[p] = url;
        result.facts.push({ label: `Profile (${p})`, value: url, source: 'Business website', url: page.url });
      }
    }
    if (!result.email && found.emails[0]) {
      result.email = found.emails[0];
      result.facts.push({ label: 'Email', value: found.emails[0], source: 'Business website', url: page.url });
    }
    if (!result.email && found.contactPath && pages.length === 1) {
      try {
        const next = new URL(found.contactPath, page.url);
        if (next.host === base.host) pages.push(next.pathname);
      } catch {
        /* ignore */
      }
    }
  }
  return result;
}
