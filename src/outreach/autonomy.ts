import type { Db, Queryable } from '../db/pool.js';
import type { Settings } from '../settings.js';
import { env } from '../config.js';
import { imapConfigProblems } from '../inbox/mailbox.js';
import { lagosDayStart } from './email/window.js';
import { approveMessage, OutreachError, type MessageRow } from './messages.js';
import { afterApprove } from './sending.js';
import { apiSendability } from '../meta/send.js';
import { telegramConfigProblems } from '../telegram/bot.js';
import type { Channel } from './channels.js';

/** Where the agent itself can deliver an answer (the rest are always sent by you). */
export const AUTO_SEND_CHANNELS: Channel[] = ['email', 'instagram', 'facebook', 'telegram'];

/** Instagram/Facebook: only inside Meta's 24 hours with Meta replies live. Telegram: only with the bot set up. */
async function apiSendable(db: Db, msg: MessageRow, settings: Settings) {
  if (msg.channel === 'telegram') return telegramConfigProblems().length === 0 && !!msg.social_contact_id;
  return (await apiSendability(db, msg, settings))?.api === true;
}
import { logger } from '../log.js';

const log = logger('autonomy');

/**
 * Controlled Autonomous Mode: the agent approves some of its own drafts so they send without waiting for you.
 * Only:
 * - introductions and follow-ups by email; answers on the channels you set to "auto-send" where the agent can
 *   deliver them (email; Instagram/Facebook inside Meta's 24 hours; Telegram through your bot). WhatsApp, TikTok and
 *   LinkedIn are always sent by you;
 * - drafted by the agent from your templates or approved knowledge-base answers (never AI-written text,
 *   never anything you wrote or edited);
 * - the kinds you allow (introductions, follow-ups, knowledge-base answers);
 * - to leads at or above the minimum score;
 * - up to the daily auto-approval limit.
 * Every usual check still applies at approval and again at send time (do-not-contact list, opt-out line,
 * sending hours, daily email limit, dry run).
 */
export async function maybeAutoApprove(db: Db, messageId: number, settings: Settings): Promise<MessageRow | null> {
  if (settings.mode !== 'autonomous') return null;
  const msg = (await db.query<MessageRow & { score: number | null }>(
    `SELECT m.*, l.score FROM messages m LEFT JOIN leads l ON l.id = m.lead_id WHERE m.id = $1`, [messageId],
  )).rows[0];
  if (!msg || msg.status !== 'draft' || msg.direction !== 'outbound') return null;
  if (msg.created_by !== 'agent' || msg.edited) return null;
  // AI-written outreach always waits for you. An AI answer to a message may go only with no warnings at all, and only
  // when it was grounded in your knowledge (approved answers, documents or website).
  if (msg.ai_generated) {
    const src = msg.ai_sources as { warnings?: unknown[]; kb?: unknown[]; knowledge?: unknown[] } | null;
    if (msg.step !== 'reply' || (src?.warnings?.length ?? 0) > 0 || !((src?.kb?.length ?? 0) + (src?.knowledge?.length ?? 0))) return null;
  }
  const isReply = msg.step === 'reply';
  // Introductions and follow-ups: email only. Answers: on the channels you set to auto-send that the agent can send on.
  if (!isReply && msg.channel !== 'email') return null;
  if (isReply && (settings.replyAutonomy[msg.channel] !== 'auto_send' || !AUTO_SEND_CHANNELS.includes(msg.channel))) return null;
  // A knowledge-base answer has no template; an answer with a gap for you ({{your_answer}}) never passes approval anyway.
  const allowed =
    (msg.step === 'intro' && settings.autoApproveIntros && msg.template_id !== null) ||
    ((msg.step === 'followup_1' || msg.step === 'followup_2') && settings.autoApproveFollowUps && msg.template_id !== null) ||
    isReply;
  if (!allowed) return null;
  // Leads need the minimum score; a person who isn't a lead wrote to you first, so there is no score to check.
  if (msg.lead_id !== null && (msg.score ?? 0) < settings.autoApproveMinScore) return null;
  if (isReply && msg.channel !== 'email' && !(await apiSendable(db, msg, settings))) return null;
  if ((await autoApprovedToday(db)) >= settings.autoApproveDailyLimit) return null;

  try {
    const approved = await approveMessage(db, msg.id, settings, 'agent');
    await afterApprove(db, approved, settings);
    log.info(`Auto-approved ${approved.channel} #${approved.id} (${approved.step?.replace('_', ' ')})${approved.lead_id ? ` for lead #${approved.lead_id}` : ''}`);
    return approved;
  } catch (err) {
    if (!(err instanceof OutreachError)) throw err;
    // Stays a draft for you, with the reason.
    await db.query(`UPDATE messages SET status_reason = $2 WHERE id = $1 AND status = 'draft'`, [msg.id, `Not auto-approved: ${err.message}`]);
    return null;
  }
}

export async function autoApprovedToday(db: Queryable) {
  return (
    await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE approved_by = 'agent' AND approved_at >= $1`, [lagosDayStart(new Date())])
  ).rows[0]!.n;
}

/** What must be in place before Controlled Autonomous Mode can be switched on. */
export function autonomyProblems(settings: Settings): string[] {
  const p: string[] = [];
  if (!settings.senderName) p.push('Set your name under Sender and links.');
  // Without reading replies, a follow-up could go to someone who already answered or said STOP.
  if (!settings.readReplies || imapConfigProblems().length) p.push('Turn on reading replies (Reply mailbox) first, so follow-ups stop when people answer.');
  if (!env.OUTREACH_REPLY_TO) p.push('Set OUTREACH_REPLY_TO in .env.');
  if (settings.autoApproveDailyLimit < 1) p.push('Set "most auto-approvals per day" above 0.');
  return p;
}

/** Leaving the mode: emails the agent approved but has not sent yet go back to you as drafts. */
export async function returnAgentApprovals(db: Queryable) {
  const { rowCount } = await db.query(
    `UPDATE messages SET status = 'draft', approved_at = NULL, approved_by = NULL,
       status_reason = 'Back for your review: Controlled Autonomous Mode was switched off before it was sent', updated_at = now()
     WHERE status = 'approved' AND approved_by = 'agent'`,
  );
  return rowCount ?? 0;
}
