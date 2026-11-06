import type { Db, Queryable } from '../db/pool.js';
import type { Settings } from '../settings.js';
import type { LeadRow } from '../leads/leads.js';
import { suppressionReason } from './suppressions.js';
import { buildVars, complianceProblems, render, whatsappNumber, type Channel, type Step } from './render.js';
import { CHANNEL_LABEL, chatLink, isManual, isSocial, socialHandle } from './channels.js';
import { referralLinkFor } from '../inbound/referrals.js';
import { personalLine, spin } from './variety.js';

/** A refusal with a reason you can act on (shown in the dashboard). */
export class OutreachError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface MessageRow {
  id: number;
  /** Null for a message to or from someone who isn't a lead (then social_contact_id says who). */
  lead_id: number | null;
  channel: Channel;
  direction: 'outbound' | 'inbound';
  step: Step | null;
  template_id: number | null;
  to_address: string | null;
  subject: string | null;
  body: string;
  original_body: string | null;
  status: 'draft' | 'approved' | 'rejected' | 'cancelled' | 'sending' | 'sent' | 'failed' | 'received' | 'dry_run';
  created_by: 'agent' | 'user';
  edited: boolean;
  status_reason: string | null;
  approved_at: Date | null;
  sent_at: Date | null;
  sent_by: 'provider' | 'user' | null;
  approved_by: 'user' | 'agent' | null;
  /** Instagram/Facebook replies: the person in the chat (social_contacts). */
  social_contact_id?: number | null;
  ai_generated: boolean;
  ai_sources: { warnings?: Array<{ text: string; blocking: boolean }> } | null;
  created_at: Date;
  updated_at: Date;
}

/** Lead statuses that end outreach. */
const CLOSED = new Set(['do_not_contact', 'archived', 'declined']);

/** Where a message on this channel would go, or why it can't. */
export function addressFor(lead: Pick<LeadRow, 'email' | 'phone_key' | 'socials'>, channel: Channel): string | null {
  if (channel === 'email') return lead.email;
  if (channel === 'whatsapp') return whatsappNumber(lead.phone_key, lead.socials);
  return socialHandle(channel, lead.socials[channel]);
}

/** Everything that must be true before a message to this lead may be drafted, approved or sent. */
export async function assertContactable(db: Queryable, lead: LeadRow | null, channel: Channel, settings: Settings, address?: string | null) {
  if (settings.mode === 'research') throw new OutreachError('RESEARCH_MODE', 'Research Mode is on: no messages are drafted or approved.');
  if (!lead) {
    // A reply to someone who isn't a lead: only to the address they wrote from, and only if it isn't blocked.
    if (!address) throw new OutreachError('NO_ADDRESS', 'There is no address to reply to.');
    const blocked = await suppressionReason(db, {
      email: channel === 'email' ? address : null,
      phoneKey: channel === 'whatsapp' ? address : null,
      handle: channel !== 'email' && channel !== 'whatsapp' ? `${channel}:${address}` : null,
    });
    if (blocked) throw new OutreachError('SUPPRESSED', blocked);
    return address;
  }
  if (CLOSED.has(lead.status)) throw new OutreachError('LEAD_CLOSED', `This lead is marked "${lead.status.replace(/_/g, ' ')}".`);
  // Numbers from a WhatsApp group never agreed to anything: only messages you send yourself, never email.
  if (lead.group_source && channel === 'email') {
    throw new OutreachError('GROUP_LEAD', `This lead came from the "${lead.group_source}" WhatsApp group export, so it is contacted only by messages you send yourself (WhatsApp or a social chat), never by email.`);
  }
  // A reply in an Instagram/Facebook chat goes to whoever wrote (see socialReplyAddress), not the lead's saved profile.
  const to = address || addressFor(lead, channel);
  if (!to) {
    throw new OutreachError(
      'NO_ADDRESS',
      channel === 'email'
        ? 'This lead has no email address.'
        : channel === 'whatsapp'
          ? 'This lead has no WhatsApp-capable mobile number.'
          : `This lead has no ${CHANNEL_LABEL[channel]} profile we can read a username from. Add their profile link or @username on the lead.`,
    );
  }
  const blocked = await suppressionReason(db, {
    email: lead.email,
    phoneKey: channel === 'whatsapp' ? to : lead.phone_key,
    websiteDomain: lead.website_domain,
    handle: isSocial(channel) ? `${channel}:${to}` : null,
  });
  if (blocked) throw new OutreachError('SUPPRESSED', blocked);
  return to;
}

/** Puts your group first line (where you got their number, and how to opt out) at the top of a first message. */
export function withGroupFirstLine(body: string, group: string, settings: Pick<Settings, 'groupFirstLine'>) {
  const line = settings.groupFirstLine.replace(/\{\{\s*group\s*\}\}/g, group);
  return body.startsWith(line) ? body : `${line}\n\n${body}`;
}

/**
 * Picks a template. With several active variants, it rotates: templates for the lead's category first (any
 * category only when there are none), then the one used least in the last 24 hours, ties at random. So
 * neighbouring drafts don't share a subject.
 */
async function pickTemplate(db: Queryable, channel: Channel, step: Step, category: string, opts: { templateId?: number; avoidId?: number } = {}) {
  if (opts.templateId) {
    const { rows } = await db.query<{ id: number; subject: string | null; body: string }>(
      'SELECT id, subject, body FROM templates WHERE id = $1 AND channel = $2 AND step = $3', [opts.templateId, channel, step],
    );
    return rows[0] ?? null;
  }
  const { rows } = await db.query<{ id: number; subject: string | null; body: string; specific: boolean; uses: number }>(
    `SELECT t.id, t.subject, t.body, t.category IS NOT NULL AS specific,
            (SELECT count(*)::int FROM messages m WHERE m.template_id = t.id AND m.created_at > now() - interval '24 hours') AS uses
     FROM templates t WHERE t.active AND t.channel = $1 AND t.step = $2 AND (t.category = $3 OR t.category IS NULL)`,
    [channel, step, category],
  );
  const pool = rows.some((r) => r.specific) ? rows.filter((r) => r.specific) : rows;
  const choices = pool.length > 1 && opts.avoidId ? pool.filter((r) => r.id !== opts.avoidId) : pool;
  if (!choices.length) return null;
  const least = Math.min(...choices.map((r) => r.uses));
  const best = choices.filter((r) => r.uses === least);
  return best[Math.floor(Math.random() * best.length)]!;
}

/** Fills a template for one lead: phrase alternatives, a lead-specific line, then the placeholders. */
async function composeFromTemplate(
  db: Queryable, lead: LeadRow, channel: Channel, step: Step, settings: Settings, opts: { templateId?: number; avoidId?: number } = {},
) {
  const template = await pickTemplate(db, channel, step, lead.category, opts);
  if (!template) throw new OutreachError('NO_TEMPLATE', `No active ${channel} template for this step. Add one under Templates.`);

  const extra: Record<string, string> = { personal_line: personalLine(lead) };
  if (/\{\{\s*referral_link\s*\}\}/.test(`${template.subject ?? ''} ${template.body}`) && settings.referralLinksEnabled && settings.referralPrefillUrl) {
    extra.referral_link = (await referralLinkFor(db, lead.id, settings)).link;
  }
  if (step !== 'intro') {
    const prev = (
      await db.query<{ subject: string | null }>(
        `SELECT subject FROM messages WHERE lead_id = $1 AND channel = $2 AND step = 'intro' AND status = 'sent' ORDER BY id LIMIT 1`,
        [lead.id, channel],
      )
    ).rows[0];
    if (!prev) throw new OutreachError('NO_INTRO', 'A follow-up needs a sent introduction first.');
    if (prev.subject) extra.previous_subject = prev.subject.replace(/^Re:\s*/i, '');
  }
  const vars = buildVars(lead, settings, channel, step, extra);
  const body = render(spin(template.body), vars);
  const subject = channel === 'email' && template.subject ? render(spin(template.subject), vars) : null;
  const missing = [...new Set([...body.missing, ...(subject?.missing ?? [])])];
  if (missing.length) {
    throw new OutreachError('MISSING_VALUES', `The template needs values that aren't set: ${missing.join(', ')}. Fill them in Settings or edit the template.`);
  }
  return { templateId: template.id, subject: subject?.text ?? null, body: body.text };
}

/**
 * Drafts a message for one lead from the best matching template. It waits in the approval queue;
 * nothing is sent. At most one live message per lead, channel and step (a database rule), so a
 * second request or a restart cannot create a duplicate.
 */
export async function createDraft(
  db: Db,
  leadId: number,
  channel: Channel,
  settings: Settings,
  opts: { step?: Step; createdBy?: 'agent' | 'user'; templateId?: number } = {},
): Promise<MessageRow> {
  const step = opts.step ?? 'intro';
  const lead = (await db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
  if (!lead) throw new OutreachError('NOT_FOUND', 'Lead not found');
  if (!settings.senderName) throw new OutreachError('NO_SENDER', 'Set your name under Settings → Sender and links before drafting.');
  const to = await assertContactable(db, lead, channel, settings);
  const draft = await composeFromTemplate(db, lead, channel, step, settings, { templateId: opts.templateId });
  if (lead.group_source && step === 'intro') draft.body = withGroupFirstLine(draft.body, lead.group_source, settings);

  try {
    const { rows } = await db.query<MessageRow>(
      `INSERT INTO messages (lead_id, channel, step, template_id, to_address, subject, body, original_body, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'draft', $8) RETURNING *`,
      [leadId, channel, step, draft.templateId, to, draft.subject, draft.body, opts.createdBy ?? 'agent'],
    );
    return rows[0]!;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new OutreachError('ALREADY_EXISTS', `There is already a ${channel} ${step.replace('_', ' ')} for this lead.`);
    }
    throw err;
  }
}

/**
 * Re-writes a template draft with another variant (a different template when there is one, and new phrase
 * choices). Only drafts you haven't edited; AI drafts are regenerated through AI instead.
 */
export async function regenerateDraft(db: Db, id: number, settings: Settings) {
  const { msg, lead } = await getMessageWithLead(db, id);
  if (msg.status !== 'draft' || msg.direction !== 'outbound') throw new OutreachError('NOT_DRAFT', 'Only drafts can be regenerated.');
  if (msg.edited) throw new OutreachError('EDITED', 'You have edited this draft; regenerating would lose your changes. Reject it and draft again instead.');
  if (msg.step === 'reply' || !msg.step || !lead) throw new OutreachError('NOT_SUPPORTED', 'Reply drafts are not regenerated; draft the reply again from the Inbox.');
  await assertContactable(db, lead, msg.channel, settings);
  const draft = await composeFromTemplate(db, lead, msg.channel, msg.step, settings, { avoidId: msg.template_id ?? undefined });
  const { rows } = await db.query<MessageRow>(
    `UPDATE messages SET template_id = $2, subject = $3, body = $4, original_body = $4, status_reason = 'Regenerated', updated_at = now()
     WHERE id = $1 AND status = 'draft' AND NOT edited RETURNING *`,
    [id, draft.templateId, draft.subject, draft.body],
  );
  if (!rows[0]) throw new OutreachError('CONFLICT', 'The draft changed meanwhile; reload and try again.');
  return rows[0];
}

async function getMessageWithLead(db: Queryable, id: number) {
  const msg = (await db.query<MessageRow>('SELECT * FROM messages WHERE id = $1', [id])).rows[0];
  if (!msg) throw new OutreachError('NOT_FOUND', 'Message not found');
  const lead = msg.lead_id ? (await db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [msg.lead_id])).rows[0] ?? null : null;
  return { msg, lead };
}

/** Edits a draft or an approved message. Editing an approved message sends it back for approval. */
export async function editMessage(db: Db, id: number, patch: { subject?: string | null; body?: string }) {
  const { msg } = await getMessageWithLead(db, id);
  if (msg.status !== 'draft' && msg.status !== 'approved') throw new OutreachError('NOT_EDITABLE', `A ${msg.status} message can't be edited.`);
  const { rows } = await db.query<MessageRow>(
    `UPDATE messages SET subject = $2, body = $3, edited = true, status = 'draft', approved_at = NULL, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, patch.subject !== undefined ? patch.subject : msg.subject, patch.body ?? msg.body],
  );
  return rows[0]!;
}

/**
 * Approves a draft after re-checking everything: mode, lead status, do-not-contact list, and the
 * message itself (no gaps, an opt-out line, a subject). Approval never sends by itself.
 */
export async function approveMessage(db: Db, id: number, settings: Settings, by: 'user' | 'agent' = 'user') {
  const { msg, lead } = await getMessageWithLead(db, id);
  if (msg.status !== 'draft') throw new OutreachError('NOT_DRAFT', `Only drafts can be approved (this one is ${msg.status}).`);
  await assertContactable(db, lead, msg.channel, settings, msg.social_contact_id || !lead ? msg.to_address : null);
  const problems = complianceProblems(msg.channel, msg.subject, msg.body, msg.step);
  // An AI draft that names a time, adds a link or leaves a placeholder must be edited first.
  if (msg.ai_generated && !msg.edited) {
    problems.push(...(msg.ai_sources?.warnings ?? []).filter((w) => w.blocking).map((w) => `${w.text} Edit the draft first.`));
  }
  if (problems.length) throw new OutreachError('NOT_COMPLIANT', problems.join(' '));
  const { rows } = await db.query<MessageRow>(
    `UPDATE messages SET status = 'approved', approved_at = now(), approved_by = $2, status_reason = NULL, updated_at = now()
     WHERE id = $1 AND status = 'draft' RETURNING *`,
    [id, by],
  );
  if (!rows[0]) throw new OutreachError('CONFLICT', 'The message changed while approving; reload and try again.');
  return rows[0];
}

export async function rejectMessage(db: Db, id: number, reason: string | null) {
  const { rows } = await db.query<MessageRow>(
    `UPDATE messages SET status = 'rejected', status_reason = $2, updated_at = now()
     WHERE id = $1 AND status IN ('draft', 'approved') RETURNING *`,
    [id, reason],
  );
  if (!rows[0]) throw new OutreachError('NOT_REJECTABLE', 'Only drafts and approved, unsent messages can be rejected.');
  return rows[0];
}

/**
 * WhatsApp, Instagram, Facebook, TikTok and Telegram are sent by you, not the agent: open the chat, paste (or
 * confirm) the text, press send, then record it here. Only approved messages can be recorded as sent.
 */
export async function markSentByYou(db: Db, id: number, settings: Settings) {
  const { msg, lead } = await getMessageWithLead(db, id);
  if (!isManual(msg.channel)) throw new OutreachError('WRONG_CHANNEL', 'Emails are sent by the email integration, not marked by hand.');
  if (msg.status !== 'approved') throw new OutreachError('NOT_APPROVED', 'Approve the message first.');
  await assertContactable(db, lead, msg.channel, settings, msg.social_contact_id || !lead ? msg.to_address : null);
  const { rows } = await db.query<MessageRow>(
    `UPDATE messages SET status = 'sent', sent_at = now(), sent_by = 'user', updated_at = now()
     WHERE id = $1 AND status = 'approved' RETURNING *`,
    [id],
  );
  await db.query(
    `UPDATE leads SET status = 'contacted', updated_at = now() WHERE id = $1 AND status IN ('discovered', 'qualified', 'unqualified')`,
    [msg.lead_id],
  );
  return rows[0]!;
}

/** Where you send an approved message yourself: the chat link, and whether it already carries the text. */
export function chatLinkFor(msg: Pick<MessageRow, 'channel' | 'to_address' | 'body' | 'status'>) {
  // A Messenger contact known only by Meta's id has no public chat link: reply in Meta Business Suite.
  return msg.status === 'approved' && msg.to_address && !msg.to_address.startsWith('id:') ? chatLink(msg.channel, msg.to_address, msg.body) : null;
}

export interface AutoDraftResult {
  created: number;
  /** The drafts created, so Controlled Autonomous Mode can consider them. */
  messageIds: number[];
  skipped: Record<string, number>;
  remainingToday: number;
}

/**
 * Drafts introductions for the best qualified leads that have none yet, within today's limit.
 * Leads it can't draft for (no address, blocked…) are skipped and counted by reason.
 */
export async function autoDraft(
  db: Db,
  settings: Settings,
  opts: { limit?: number; draftIntro?: (leadId: number, channel: Channel) => Promise<MessageRow> } = {},
): Promise<AutoDraftResult> {
  const today = (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE created_by = 'agent' AND direction = 'outbound' AND step <> 'reply' AND created_at >= date_trunc('day', now())`,
    )
  ).rows[0]!.n;
  let budget = Math.max(0, Math.min(opts.limit ?? Infinity, settings.dailyDraftLimit - today));
  const result: AutoDraftResult = { created: 0, messageIds: [], skipped: {}, remainingToday: budget };
  if (budget === 0 || settings.mode === 'research' || !settings.senderName || settings.draftChannels.length === 0) return result;

  const { rows: leads } = await db.query<{ id: number }>(
    `SELECT l.id FROM leads l
     WHERE l.status = 'qualified'
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id AND m.direction = 'outbound' AND m.step = 'intro'
                       AND m.status NOT IN ('cancelled', 'failed'))
     ORDER BY l.score DESC NULLS LAST, l.id
     LIMIT $1`,
    [Math.min(budget * 3, 500)],
  );
  for (const { id } of leads) {
    if (budget === 0) break;
    let lastError: string | null = null;
    for (const channel of settings.draftChannels) {
      try {
        const msg = opts.draftIntro ? await opts.draftIntro(id, channel) : await createDraft(db, id, channel, settings, { createdBy: 'agent' });
        result.messageIds.push(msg.id);
        result.created++;
        budget--;
        lastError = null;
        break;
      } catch (err) {
        if (!(err instanceof OutreachError)) throw err;
        lastError = err.code;
        if (!['NO_ADDRESS', 'ALREADY_EXISTS'].includes(err.code)) break; // other reasons apply to every channel
      }
    }
    if (lastError) result.skipped[lastError] = (result.skipped[lastError] ?? 0) + 1;
  }
  result.remainingToday = budget;
  return result;
}

export async function messageCounts(db: Queryable) {
  const { rows } = await db.query<{ k: string; n: number }>(
    `SELECT status AS k, count(*)::int AS n FROM messages WHERE direction = 'outbound' GROUP BY status
     UNION ALL SELECT 'replies', count(*)::int FROM messages WHERE direction = 'inbound' AND coalesce(classification, 'other') <> 'auto_reply'
     UNION ALL SELECT 'needsAttention', count(*)::int FROM messages WHERE direction = 'inbound' AND needs_attention AND handled_at IS NULL
     UNION ALL SELECT 'unmatched', count(*)::int FROM messages m LEFT JOIN social_contacts c ON c.id = m.social_contact_id
       WHERE m.direction = 'inbound' AND m.lead_id IS NULL AND c.ignored_at IS NULL AND m.needs_attention AND m.handled_at IS NULL`,
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.n])) as Record<string, number>;
}
