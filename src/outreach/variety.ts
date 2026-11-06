import type { LeadRow } from '../leads/leads.js';

/**
 * Message variety, so two merchants (or two emails in the same hour) don't get the same words. All free and
 * rule-based; nothing is invented. Pure; tested in tests/variety.test.ts.
 */

/** A {a|b} group; options may contain {{placeholders}} but not other groups. */
const GROUP = () => /(?<!\{)\{((?:\{\{\s*[a-z_]+\s*\}\}|[^{}])*)\}(?!\})/g;

/**
 * Phrase alternatives: "{Hello|Good day|Hi}" becomes one of the options. Double braces ({{placeholder}}) are left
 * alone, and can sit inside an option. Alternatives can't be nested. `rand` is injectable for tests.
 */
export function spin(text: string, rand: () => number = Math.random): string {
  return text.replace(GROUP(), (m, options: string) => {
    if (!options.includes('|')) return m;
    const parts = options.split('|');
    return parts[Math.floor(rand() * parts.length)] ?? parts[0]!;
  });
}

/** Every distinct way a template can come out (capped), for the template editor's preview count. */
export function spinCount(text: string): number {
  let n = 1;
  for (const m of text.matchAll(GROUP())) if (m[1]!.includes('|')) n *= m[1]!.split('|').length;
  return Math.min(n, 1_000_000);
}

type LeadFacts = Pick<LeadRow, 'business_name' | 'branch_count' | 'socials' | 'website'>;

/**
 * One sentence about this particular shop, built only from verified details (branches, where it sells online,
 * its website). Empty when we know nothing specific: the template then reads naturally without it.
 */
export function personalLines(lead: LeadFacts): string[] {
  const lines: string[] = [];
  const socials = lead.socials ?? {};
  if (lead.branch_count > 1) {
    lines.push(`With ${lead.branch_count} branches, keeping stock in sync between them is where StockỌja helps most: you can see every branch and move stock between them.`);
  }
  if (socials.instagram || socials.tiktok || socials.facebook) {
    const where = socials.instagram ? 'Instagram' : socials.tiktok ? 'TikTok' : 'Facebook';
    lines.push(`I noticed ${lead.business_name} also sells on ${where}. Your StockỌja online store sells from the same stock as your shop, so online orders never promise items you've already sold.`);
  }
  if (socials.whatsapp) {
    lines.push(`Since customers already reach ${lead.business_name} on WhatsApp, your StockỌja store link can go straight into those chats, with orders coming back to you.`);
  }
  if (lead.website) {
    lines.push(`You already have a website, so StockỌja can keep your shop's stock and your online sales on the same count.`);
  }
  return lines;
}

export function personalLine(lead: LeadFacts, rand: () => number = Math.random): string {
  const lines = personalLines(lead);
  return lines.length ? lines[Math.floor(rand() * lines.length)]! : '';
}

// ── Near-duplicate check ───────────────────────────────────────────────────────

const shingles = (text: string, n = 3) => {
  const w = text.toLowerCase().replace(/https?:\/\/\S+/g, ' ').split(/[^a-z0-9ọ₦]+/i).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
};

/** How much two texts share (0–1), on word triples, ignoring links and each lead's own name. */
export function similarity(a: string, b: string, ignore: string[] = []): number {
  const strip = (t: string) => ignore.reduce((s, x) => (x ? s.split(x).join(' ') : s), t);
  const A = shingles(strip(a));
  const B = shingles(strip(b));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const s of A) if (B.has(s)) common++;
  return common / Math.min(A.size, B.size);
}

export interface SimilarTo {
  id: number;
  businessName: string;
  sameSubject: boolean;
  bodyOverlap: number;
}

/** Above this share of word triples, two bodies count as near-identical. */
export const NEAR_DUPLICATE = 0.8;

export function findSimilar(
  msg: { id: number; subject: string | null; body: string; business_name: string },
  recent: Array<{ id: number; subject: string | null; body: string; business_name: string }>,
): SimilarTo | null {
  let best: SimilarTo | null = null;
  for (const r of recent) {
    if (r.id === msg.id) continue;
    const sameSubject = !!msg.subject && !!r.subject && msg.subject.trim().toLowerCase() === r.subject.trim().toLowerCase();
    const bodyOverlap = similarity(msg.body, r.body, [msg.business_name, r.business_name]);
    if ((sameSubject || bodyOverlap >= NEAR_DUPLICATE) && (!best || bodyOverlap > best.bodyOverlap)) {
      best = { id: r.id, businessName: r.business_name, sameSubject, bodyOverlap: Number(bodyOverlap.toFixed(2)) };
    }
  }
  return best;
}
