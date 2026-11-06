import { env } from '../config.js';
import { CATEGORIES, categoryForShopTag, regionStateName, type Category, type RegionCode } from './catalog.js';
import type { LeadCandidate } from '../leads/leads.js';
import type { Fact } from '../leads/qualify.js';
import { socialPlatform } from '../leads/normalize.js';
import { assertOk, fetchText } from './http.js';

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Overpass QL for shops of one category inside one Nigerian state. */
export function buildOverpassQuery(category: Category, region: RegionCode): string {
  const shops = CATEGORIES[category].osmShops.join('|');
  return `[out:json][timeout:90];
area["ISO3166-2"="${region}"]["admin_level"="4"]->.a;
nwr["shop"~"^(${shops})$"](area.a);
out center tags;`;
}

const pick = (t: Record<string, string>, ...keys: string[]) => {
  for (const k of keys) if (t[k]?.trim()) return t[k]!.trim();
  return null;
};

/**
 * Turns an OpenStreetMap element into a candidate. Only business details are kept:
 * personal tags (e.g. contact:person, operator names of individuals) are ignored.
 * Elements without a name are skipped: there is no way to identify or address them.
 */
export function elementToCandidate(el: OsmElement, region: RegionCode): LeadCandidate | null {
  const t = el.tags ?? {};
  const name = pick(t, 'name', 'name:en', 'brand');
  const category = categoryForShopTag(t.shop);
  if (!name || !category) return null;

  const lat = el.lat ?? el.center?.lat ?? null;
  const lon = el.lon ?? el.center?.lon ?? null;
  const osmUrl = `https://www.openstreetmap.org/${el.type}/${el.id}`;
  const street = [pick(t, 'addr:housenumber'), pick(t, 'addr:street')].filter(Boolean).join(' ');
  const address = [street, pick(t, 'addr:suburb', 'addr:district')].filter(Boolean).join(', ') || pick(t, 'addr:full');
  const city = pick(t, 'addr:city', 'addr:town');
  const state = regionStateName(region);

  const socials: Record<string, string> = {};
  for (const [key, platform] of [
    ['contact:instagram', 'instagram'],
    ['contact:facebook', 'facebook'],
    ['contact:tiktok', 'tiktok'],
    ['contact:twitter', 'x'],
    ['contact:whatsapp', 'whatsapp'],
  ] as const) {
    const v = pick(t, key);
    if (v) socials[platform] = v;
  }
  let website = pick(t, 'website', 'contact:website', 'url');
  // A "website" that is really an Instagram/Facebook page is a social profile, not a site.
  if (website && socialPlatform(website)) {
    socials[socialPlatform(website)!] ??= website;
    website = null;
  }

  const fact = (label: string, value: string | null): Fact[] =>
    value ? [{ label, value, source: 'OpenStreetMap', url: osmUrl }] : [];
  const facts: Fact[] = [
    ...fact('Business name', name),
    ...fact('Shop type', `shop=${t.shop}`),
    ...fact('State', state),
    ...fact('Address', address),
    ...fact('City', city),
    ...fact('Phone', pick(t, 'phone', 'contact:phone', 'contact:mobile')),
    ...fact('Email', pick(t, 'email', 'contact:email')),
    ...fact('Website', website),
    ...fact('Opening hours', pick(t, 'opening_hours')),
    ...fact('Brand', t['brand:wikidata'] ? pick(t, 'brand') : null),
    ...Object.entries(socials).map(([p, v]) => ({ label: `Profile (${p})`, value: v, source: 'OpenStreetMap', url: osmUrl })),
  ];

  return {
    business_name: name,
    category,
    source: 'osm',
    source_ref: `${el.type}/${el.id}`,
    source_url: osmUrl,
    source_tag: `shop=${t.shop}`,
    city,
    state,
    address,
    lat,
    lon,
    phone: pick(t, 'phone', 'contact:phone', 'contact:mobile'),
    email: pick(t, 'email', 'contact:email'),
    website,
    socials,
    // brand:wikidata marks a recognised national/international brand (e.g. a supermarket chain).
    is_chain_brand: !!t['brand:wikidata'],
    facts,
  };
}

export async function queryOverpass(category: Category, region: RegionCode, signal?: AbortSignal): Promise<OsmElement[]> {
  const res = await fetchText(env.OVERPASS_URL, {
    method: 'POST',
    body: `data=${encodeURIComponent(buildOverpassQuery(category, region))}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    signal,
    timeoutMs: 120_000,
    maxBytes: 25_000_000,
  });
  assertOk(res, 'OpenStreetMap (Overpass)');
  const json = JSON.parse(res.text) as { elements?: OsmElement[]; remark?: string };
  if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(`Overpass: ${json.remark}`);
  return json.elements ?? [];
}
