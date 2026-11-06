import { randomInt } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import type { Settings } from '../settings.js';
import { OutreachError } from '../outreach/messages.js';
import { SOCIAL_CHANNELS, socialHandle } from '../outreach/channels.js';
import { nameKey, normalizeEmail, phoneKey } from '../leads/normalize.js';

/** No 0/O or 1/I, so a code read out over the phone isn't misheard. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newReferralCode = () => Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

/**
 * A merchant's personal interest-form link: your form's pre-filled link with their code in place of REFCODE.
 * Whoever fills in the form from it is linked back to them. The code is created the first time it's needed.
 */
export async function referralLinkFor(db: Queryable, leadId: number, settings: Settings): Promise<{ code: string; link: string }> {
  if (!settings.referralLinksEnabled) {
    throw new OutreachError('REFERRAL_LINKS_OFF', 'Personal referral links are off. Switch them on under Settings → Interest form and referrals.');
  }
  if (!settings.referralPrefillUrl) {
    throw new OutreachError('NO_PREFILL_LINK', "Add your form's pre-filled link (with REFCODE in it) under Settings → Interest form and referrals.");
  }
  let code: string | null = null;
  for (let attempt = 0; attempt < 6 && !code; attempt++) {
    const cur = (await db.query<{ referral_code: string | null }>('SELECT referral_code FROM leads WHERE id = $1', [leadId])).rows[0];
    if (!cur) throw new OutreachError('NOT_FOUND', 'Lead not found.');
    if (cur.referral_code) {
      code = cur.referral_code;
      break;
    }
    try {
      code = (
        await db.query<{ referral_code: string }>(
          'UPDATE leads SET referral_code = $2 WHERE id = $1 AND referral_code IS NULL RETURNING referral_code',
          [leadId, newReferralCode()],
        )
      ).rows[0]?.referral_code ?? null;
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err; // another lead has that code: try a new one
    }
  }
  if (!code) throw new OutreachError('NO_CODE', 'Could not create a referral code; try again.');
  return { code, link: settings.referralPrefillUrl.replace('REFCODE', encodeURIComponent(code)) };
}

export interface ReferrerMatch {
  leadId: number;
  via: 'code' | 'phone' | 'email' | 'handle' | 'name';
}

/**
 * Who referred a new merchant. A personal-link code wins (when links are on); otherwise the "Who referred you?"
 * answer (when that's on) is matched by phone, email, social @handle, or an exact business name. A name has to
 * match exactly one lead; anything ambiguous is left for you.
 */
export async function findReferrer(
  db: Queryable,
  answer: { code?: string | null; text?: string | null },
  settings: Settings,
  excludeLeadId?: number,
): Promise<ReferrerMatch | null> {
  const not = (id: number | undefined) => (id && id !== excludeLeadId ? id : undefined);
  const code = answer.code?.trim().toUpperCase();
  if (settings.referralLinksEnabled && code && /^[A-Z0-9]{4,12}$/.test(code)) {
    const id = not((await db.query<{ id: number }>('SELECT id FROM leads WHERE referral_code = $1', [code])).rows[0]?.id);
    if (id) return { leadId: id, via: 'code' };
  }
  const text = answer.text?.trim();
  if (!settings.referralAskEnabled || !text) return null;

  const phone = phoneKey(text.match(/(\+?234|0)[\s-]?[789][01][\d\s-]{8,11}/)?.[0]);
  if (phone) {
    const id = not((await db.query<{ id: number }>('SELECT id FROM leads WHERE phone_key = $1 ORDER BY id LIMIT 1', [phone])).rows[0]?.id);
    if (id) return { leadId: id, via: 'phone' };
  }
  const email = normalizeEmail(text.match(/[^\s<>()]+@[^\s<>()]+/)?.[0]);
  if (email) {
    const id = not((await db.query<{ id: number }>('SELECT id FROM leads WHERE lower(email) = $1 ORDER BY id LIMIT 1', [email])).rows[0]?.id);
    if (id) return { leadId: id, via: 'email' };
  }
  const handleText = text.match(/@[\w.]+|\S*(instagram\.com|tiktok\.com|facebook\.com|t\.me)\/\S+/i)?.[0];
  if (handleText) {
    const wanted = new Set(SOCIAL_CHANNELS.map((c) => socialHandle(c, handleText)).filter(Boolean));
    if (wanted.size) {
      const { rows } = await db.query<{ id: number; socials: Record<string, string> }>(`SELECT id, socials FROM leads WHERE socials <> '{}'::jsonb ORDER BY id`);
      const hits = rows.filter((r) => SOCIAL_CHANNELS.some((c) => wanted.has(socialHandle(c, r.socials[c]))) && r.id !== excludeLeadId);
      if (hits.length === 1) return { leadId: hits[0]!.id, via: 'handle' };
    }
  }
  const key = nameKey(text);
  if (key) {
    const { rows } = await db.query<{ id: number }>('SELECT id FROM leads WHERE name_key = $1 AND id <> $2 LIMIT 2', [key, excludeLeadId ?? 0]);
    if (rows.length === 1) return { leadId: rows[0]!.id, via: 'name' };
  }
  return null;
}
