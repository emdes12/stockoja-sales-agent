import { tx, type Db, type Queryable } from '../db/pool.js';
import { normalizeEmail, phoneKey as toPhoneKey, hostOf, socialPlatform } from '../leads/normalize.js';
import { isSocial, SOCIAL_CHANNELS, socialHandle } from './channels.js';
import { cancelLeadTasks } from '../queue/queue.js';

export type SuppressionKind = 'email' | 'phone' | 'domain' | 'handle';

const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com', 'yahoo.co.uk']);

/** Normalises a value so lookups match however it was typed. Null if it is not a valid value of that kind. */
export function normalizeSuppression(kind: SuppressionKind, value: string): string | null {
  if (kind === 'email') return normalizeEmail(value);
  if (kind === 'phone') return toPhoneKey(value);
  if (kind === 'handle') {
    // "instagram:adastyles", "instagram:@adastyles", or a profile link.
    const m = /^(instagram|facebook|tiktok|telegram):\s*(.+)$/i.exec(value.trim());
    const platform = m ? m[1]!.toLowerCase() : socialPlatform(value);
    if (!platform || !isSocial(platform)) return null;
    const handle = socialHandle(platform, m ? m[2] : value);
    return handle ? `${platform}:${handle}` : null;
  }
  const host = hostOf(value.includes('@') ? value.split('@')[1]! : value);
  return host && host.includes('.') ? host : null;
}

/** Why this address may not be contacted, or null if it may. Checks the email, its domain, and the phone. */
export async function suppressionReason(
  db: Queryable,
  target: { email?: string | null; phoneKey?: string | null; websiteDomain?: string | null; handle?: string | null },
): Promise<string | null> {
  const checks: Array<[SuppressionKind, string]> = [];
  const email = normalizeEmail(target.email);
  if (email) {
    checks.push(['email', email]);
    checks.push(['domain', email.split('@')[1]!]);
  }
  if (target.phoneKey) checks.push(['phone', target.phoneKey]);
  if (target.websiteDomain) checks.push(['domain', target.websiteDomain]);
  if (target.handle) checks.push(['handle', target.handle]);
  for (const [kind, value] of checks) {
    const { rows } = await db.query<{ reason: string | null; source: string }>(
      'SELECT reason, source FROM suppressions WHERE kind = $1 AND value = $2 AND lifted_at IS NULL LIMIT 1',
      [kind, value],
    );
    if (rows[0]) return `${{ domain: 'Domain', email: 'Email', phone: 'Phone', handle: 'Account' }[kind]} is on the do-not-contact list (${rows[0].reason ?? rows[0].source})`;
  }
  return null;
}

export async function addSuppression(
  db: Queryable,
  kind: SuppressionKind,
  rawValue: string,
  opts: { reason?: string | null; source?: string; leadId?: number | null } = {},
): Promise<{ id: number | null; value: string } | { error: string }> {
  const value = normalizeSuppression(kind, rawValue);
  if (!value) return { error: `"${rawValue}" is not a valid ${kind}` };
  if (kind === 'domain' && FREE_MAIL.has(value)) return { error: `${value} is shared by millions of people; block the single address instead.` };
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO suppressions (kind, value, reason, source, lead_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (kind, value) WHERE lifted_at IS NULL DO NOTHING RETURNING id`,
    [kind, value, opts.reason ?? null, opts.source ?? 'user', opts.leadId ?? null],
  );
  return { id: rows[0]?.id ?? null, value };
}

/** Stops every open message for a lead (drafts and approved-but-unsent). Returns how many. */
export async function cancelOpenMessages(db: Queryable, leadId: number, reason: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE messages SET status = 'cancelled', status_reason = $2, updated_at = now()
     WHERE lead_id = $1 AND direction = 'outbound' AND status IN ('draft', 'approved')`,
    [leadId, reason],
  );
  return rowCount ?? 0;
}

/** Task types that would contact a lead; cancelled when they opt out or decline. */
export const CONTACT_TASK_TYPES = ['outreach.send_email', 'outreach.followup'];

/**
 * Do not contact: blocks the lead's email and phone everywhere (even if the business is found again
 * from another source), cancels open messages and any waiting contact tasks.
 */
export async function applyDoNotContact(db: Db, leadId: number, reason: string, source = 'do_not_contact') {
  return tx(db, (client) => doNotContactIn(client, leadId, reason, source));
}

/** The same, inside a transaction you already hold. */
export async function doNotContactIn(client: Queryable, leadId: number, reason: string, source = 'do_not_contact') {
  const lead = (
    await client.query<{ email: string | null; phone_key: string | null; socials: Record<string, string> }>('SELECT email, phone_key, socials FROM leads WHERE id = $1', [leadId])
  ).rows[0];
  if (!lead) return null;
  if (lead.email) await addSuppression(client, 'email', lead.email, { reason, source, leadId });
  if (lead.phone_key) await addSuppression(client, 'phone', lead.phone_key, { reason, source, leadId });
  for (const c of SOCIAL_CHANNELS) {
    const handle = socialHandle(c, lead.socials[c]);
    if (handle) await addSuppression(client, 'handle', `${c}:${handle}`, { reason, source, leadId });
  }
  await client.query(`UPDATE leads SET status = 'do_not_contact', status_set_by = 'user', updated_at = now() WHERE id = $1`, [leadId]);
  const cancelledMessages = await cancelOpenMessages(client, leadId, reason);
  const cancelledTasks = await cancelLeadTasks(client, leadId, CONTACT_TASK_TYPES, reason);
  return { cancelledMessages, cancelledTasks };
}

export async function liftSuppression(db: Queryable, id: number, reason: string): Promise<boolean> {
  const { rowCount } = await db.query('UPDATE suppressions SET lifted_at = now(), lift_reason = $2 WHERE id = $1 AND lifted_at IS NULL', [id, reason]);
  return (rowCount ?? 0) > 0;
}
