import type { Db, Queryable } from '../db/pool.js';
import type { Channel } from '../outreach/channels.js';
import { normalizeEmail } from '../leads/normalize.js';
import { addSuppression } from '../outreach/suppressions.js';

/**
 * Everyone who writes to you, on any channel, is a contact: an email address, a Meta id (Instagram/Facebook), a
 * Telegram chat, or someone whose message you pasted in (TikTok, LinkedIn, WhatsApp). A contact may be tied to a
 * lead; until then their messages are in the inbox without a lead, and you can reply, link them, add them as a
 * lead, or ignore them.
 */

export interface ContactRow {
  id: number;
  platform: Channel;
  external_id: string;
  username: string | null;
  name: string | null;
  lead_id: number | null;
  thread_id: string | null;
  last_inbound_at: Date | null;
  ignored_at: Date | null;
}

/** The contact for a sender, created or refreshed. */
export async function upsertContact(
  db: Queryable,
  platform: Channel,
  externalId: string,
  info: { username?: string | null; name?: string | null; threadId?: string | null; at?: Date | null } = {},
): Promise<ContactRow> {
  const { rows } = await db.query<ContactRow>(
    `INSERT INTO social_contacts (platform, external_id, username, name, thread_id, last_inbound_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (platform, external_id) DO UPDATE SET
       username = coalesce(EXCLUDED.username, social_contacts.username), name = coalesce(EXCLUDED.name, social_contacts.name),
       thread_id = coalesce(EXCLUDED.thread_id, social_contacts.thread_id),
       last_inbound_at = greatest(social_contacts.last_inbound_at, EXCLUDED.last_inbound_at), updated_at = now()
     RETURNING *`,
    [platform, externalId, info.username?.toLowerCase() ?? null, info.name ?? null, info.threadId ?? null, info.at ?? null],
  );
  return rows[0]!;
}

export async function emailContact(db: Queryable, address: string, at: Date | null) {
  const email = normalizeEmail(address);
  if (!email) return null;
  return upsertContact(db, 'email', email, { at });
}

/** Where a reply to this contact goes: the email address, their username, or `id:<id>` when only the platform's id is known. */
export function replyAddress(c: Pick<ContactRow, 'platform' | 'external_id' | 'username'>): string {
  if (c.platform === 'email') return c.external_id;
  if (c.platform === 'whatsapp' && /^234\d{10}$/.test(c.external_id)) return c.external_id;
  return c.username ?? `id:${c.external_id}`;
}

/** A person who said STOP goes on the do-not-contact list by the address they wrote from. */
export async function suppressContact(db: Queryable, c: ContactRow, reason: string, source: string) {
  const opts = { reason, source, leadId: c.lead_id };
  if (c.platform === 'email') await addSuppression(db, 'email', c.external_id, opts);
  else if (c.platform === 'whatsapp' && /^234\d{10}$/.test(c.external_id)) await addSuppression(db, 'phone', c.external_id, opts);
  else await addSuppression(db, 'handle', `${c.platform}:${replyAddress(c)}`, opts);
}

export async function getContact(db: Queryable, id: number | null | undefined) {
  if (!id) return null;
  return (await db.query<ContactRow>('SELECT * FROM social_contacts WHERE id = $1', [id])).rows[0] ?? null;
}

/**
 * Ties a contact to a lead: their earlier messages (and your replies to them) move to the lead, and future ones go
 * there directly. An Instagram/Telegram/TikTok/LinkedIn username is saved on the lead if it has none for that
 * platform. Returns the newest inbound message, so an answer can be drafted.
 */
export async function linkContact(db: Db, contactId: number, leadId: number) {
  const contact = await getContact(db, contactId);
  if (!contact) return null;
  await db.query(`UPDATE social_contacts SET lead_id = $2, ignored_at = NULL, updated_at = now() WHERE id = $1`, [contactId, leadId]);
  if (['instagram', 'telegram', 'tiktok', 'linkedin'].includes(contact.platform) && contact.username) {
    const value = contact.platform === 'instagram' || contact.platform === 'telegram' || contact.platform === 'tiktok' ? `@${contact.username}` : contact.username;
    await db.query(
      `UPDATE leads SET socials = socials || jsonb_build_object($2::text, $3::text), updated_at = now() WHERE id = $1 AND NOT socials ? $2`,
      [leadId, contact.platform, value],
    );
  }
  if (contact.platform === 'email') {
    await db.query(`UPDATE leads SET email = $2, updated_at = now() WHERE id = $1 AND email IS NULL`, [leadId, contact.external_id]);
  }
  const moved = await db.query(`UPDATE messages SET lead_id = $2, updated_at = now() WHERE social_contact_id = $1 AND lead_id IS NULL`, [contactId, leadId]);
  const newest = (await db.query<{ id: number }>(
    `SELECT id FROM messages WHERE social_contact_id = $1 AND direction = 'inbound' ORDER BY received_at DESC NULLS LAST, id DESC LIMIT 1`, [contactId],
  )).rows[0];
  return { moved: moved.rowCount ?? 0, newestInboundId: newest?.id ?? null };
}
