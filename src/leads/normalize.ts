/** Normalisation used for de-duplication. Pure functions; covered by tests/normalize.test.ts. */

const LEGAL_SUFFIXES =
  /\b(ltd|limited|plc|nig|nigeria|enterprises?|ent|ventures?|global|intl|international|co|company|and sons|& sons)\b/g;

/** "Mama Ngozi Fashion Ventures Ltd." → "mama ngozi fashion" */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first Nigerian number in a field, as 234XXXXXXXXXX; null if it is not a plausible Nigerian number. */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const first = raw.split(/[;,/]|\bor\b/)[0] ?? '';
  let digits = first.replace(/\D/g, '');
  if (digits.startsWith('00234')) digits = digits.slice(2);
  if (digits.startsWith('2340')) digits = `234${digits.slice(4)}`;
  if (digits.startsWith('0') && digits.length === 11) digits = `234${digits.slice(1)}`;
  if (/^[789]\d{9}$/.test(digits)) digits = `234${digits}`;
  return /^234\d{10}$/.test(digits) ? digits : null;
}

/** Display form: +234 803 123 4567 */
export function formatPhone(key: string | null): string | null {
  if (!key) return null;
  return `+234 ${key.slice(3, 6)} ${key.slice(6, 9)} ${key.slice(9)}`;
}

const SOCIAL_HOSTS: Record<string, string> = {
  'instagram.com': 'instagram',
  'facebook.com': 'facebook',
  'fb.com': 'facebook',
  'tiktok.com': 'tiktok',
  'x.com': 'x',
  'twitter.com': 'x',
  'wa.me': 'whatsapp',
  'api.whatsapp.com': 'whatsapp',
  't.me': 'telegram',
  'telegram.me': 'telegram',
  'linktr.ee': 'linktree',
  'jumia.com.ng': 'jumia',
  'konga.com': 'konga',
};

export function hostOf(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  } catch {
    return null;
  }
}

/** Which social/marketplace platform a URL belongs to, if any. */
export function socialPlatform(url: string): string | null {
  const host = hostOf(url);
  if (!host) return null;
  for (const [h, platform] of Object.entries(SOCIAL_HOSTS)) if (host === h || host.endsWith(`.${h}`)) return platform;
  return null;
}

/** The business's own domain, or null for social/marketplace links (those are not the business's site). */
export function websiteDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  if (socialPlatform(url)) return null;
  return hostOf(url);
}

export function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).toString();
  } catch {
    return null;
  }
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().split(/[;,\s]/)[0]?.toLowerCase() ?? '';
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) ? e : null;
}

/** Distance in metres between two coordinates (haversine). */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
