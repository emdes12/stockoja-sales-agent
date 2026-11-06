import { tx, type Db, type Queryable } from '../db/pool.js';
import type { Settings } from '../settings.js';
import type { LeadRow } from '../leads/leads.js';
import { requalify } from '../leads/leads.js';
import type { Fact } from '../leads/qualify.js';
import { formatPhone, normalizeUrl, phoneKey, websiteDomain } from '../leads/normalize.js';
import { socialHandle } from '../outreach/channels.js';
import { OutreachError } from '../outreach/messages.js';
import { PermanentError } from '../queue/queue.js';
import { explainMetaError, graph, igUserId, MetaApiError, metaConfigProblems } from './graph.js';

/**
 * Instagram profile lookup through Business Discovery: you give an @username, Meta returns that account's public
 * profile, if it is a professional (business or creator) account. It cannot search Instagram; you supply names.
 */

export interface InstagramProfile {
  username: string;
  name: string | null;
  biography: string | null;
  website: string | null;
  followers: number | null;
  following: number | null;
  posts: number | null;
  /** Nigerian mobile numbers written in the bio (the business's own public contact). */
  phonesInBio: string[];
  checkedAt: string;
}

const IG_SOURCE = 'Instagram profile (Business Discovery)';
const FIELDS = 'username,name,biography,website,followers_count,follows_count,media_count';

/** Mobile numbers in a bio: 0803 123 4567, +234 803 123 4567, 234-803-123-4567… */
export function phonesIn(text: string | null): string[] {
  if (!text) return [];
  const found = text.match(/(?:\+?234|0)[\s-]?[789][01]\d(?:[\s-]?\d){7}/g) ?? [];
  return [...new Set(found.map((p) => phoneKey(p)).filter((k): k is string => !!k).map((k) => formatPhone(k)!))];
}

export function assertLookupReady(settings: Settings) {
  if (!settings.instagramLookupEnabled) throw new OutreachError('LOOKUP_OFF', 'Instagram lookup is off. Turn it on in Settings → Instagram & Facebook.');
  const problems = metaConfigProblems();
  if (problems.length) throw new OutreachError('NOT_CONFIGURED', problems.map((p) => p.message).join(' '));
}

export async function lookupInstagram(db: Queryable, settings: Settings, raw: string): Promise<InstagramProfile> {
  assertLookupReady(settings);
  const username = socialHandle('instagram', raw);
  if (!username) throw new OutreachError('BAD_USERNAME', 'Enter an Instagram @username or profile link.');
  try {
    const me = await igUserId(db);
    const r = await graph<{ business_discovery?: Record<string, unknown> }>(db, me, {
      params: { fields: `business_discovery.username(${username}){${FIELDS}}` },
      kind: 'instagram_lookup',
    });
    const b = r.business_discovery;
    if (!b) throw new OutreachError('IG_NOT_FOUND', `Instagram returned nothing for @${username}.`);
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return {
      username: str(b.username) ?? username,
      name: str(b.name),
      biography: str(b.biography),
      website: normalizeUrl(str(b.website)),
      followers: num(b.followers_count),
      following: num(b.follows_count),
      posts: num(b.media_count),
      phonesInBio: phonesIn(str(b.biography)),
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof MetaApiError) {
      // 110 / 2207013: the account doesn't exist or isn't a business/creator account.
      if (err.subcode === 2207013 || err.code === 110 || /cannot be found|does not exist/i.test(err.message)) {
        throw new OutreachError('IG_NOT_FOUND', `@${username} was not found, or is a personal account. Lookup only sees business and creator accounts.`);
      }
      const e = explainMetaError(err);
      throw new OutreachError('META_ERROR', e.message);
    }
    if (err instanceof PermanentError) throw new OutreachError('META_ERROR', err.message);
    throw err;
  }
}

/** Facts from a profile, each credited to Instagram. */
export function profileFacts(p: InstagramProfile): Fact[] {
  const url = `https://www.instagram.com/${p.username}/`;
  const f = (label: string, value: string | number | null): Fact[] => (value === null || value === '' ? [] : [{ label, value: String(value), source: IG_SOURCE, url }]);
  return [
    ...f('Instagram name', p.name),
    ...f('Instagram bio', p.biography),
    ...f('Instagram followers', p.followers),
    ...f('Instagram posts', p.posts),
    ...f('Website (Instagram)', p.website),
    ...p.phonesInBio.flatMap((n) => f('Phone (Instagram bio)', n)),
  ];
}

/**
 * Adds a looked-up profile to a lead: the snapshot, facts, the handle, and the website and phone only where the
 * lead has none (nothing you entered is overwritten). Re-qualifies the lead.
 */
export async function applyInstagramProfile(db: Db, leadId: number, p: InstagramProfile, threshold: number) {
  return tx(db, async (client) => {
    const cur = (await client.query<LeadRow>('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [leadId])).rows[0];
    if (!cur) return null;
    // Old Instagram facts are replaced by the new snapshot (follower counts change).
    const facts = [...cur.facts.filter((x) => x.source !== IG_SOURCE), ...profileFacts(p)];
    const website = !cur.website && p.website && websiteDomain(p.website) ? p.website : null;
    const pk = !cur.phone_key && p.phonesInBio[0] ? phoneKey(p.phonesInBio[0]) : null;
    await client.query(
      `UPDATE leads SET instagram_profile = $2, instagram_checked_at = now(), facts = $3,
         socials = jsonb_build_object('instagram', $4::text) || socials,
         website = coalesce(website, $5), website_domain = coalesce(website_domain, $6),
         phone_key = coalesce(phone_key, $7), phone = coalesce(phone, $8), updated_at = now()
       WHERE id = $1`,
      [leadId, JSON.stringify(p), JSON.stringify(facts), `@${p.username}`, website, websiteDomain(website), pk, pk ? formatPhone(pk) : null],
    );
    return requalify(client, leadId, threshold);
  });
}

/** The lead's own Instagram username, if it has one we can read. */
export const leadInstagram = (lead: Pick<LeadRow, 'socials'>) => socialHandle('instagram', lead.socials.instagram);
