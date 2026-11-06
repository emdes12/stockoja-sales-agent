import type { Db, Queryable } from '../db/pool.js';
import type { RecurringJob, TaskHandler } from '../agent/controller.js';
import type { Settings } from '../settings.js';
import type { LeadRow } from '../leads/leads.js';
import { enqueue, HoldForReviewError, PermanentError, RateLimitedError } from '../queue/queue.js';
import { recordUsage } from '../usage.js';
import { assertContactable, OutreachError, type MessageRow } from './messages.js';
import { draftOutreach } from '../ai/write.js';
import { complianceProblems } from './render.js';
import { maybeAutoApprove } from './autonomy.js';
import { addSuppression, applyDoNotContact, cancelOpenMessages, CONTACT_TASK_TYPES } from './suppressions.js';
import { cancelLeadTasks } from '../queue/queue.js';
import { composeEmail, emailConfigProblems } from './email/compose.js';
import { AmbiguousSendError, getEmail, sendEmail } from './email/resend.js';
import { enqueueMetaSend } from '../meta/send.js';
import { enqueueTelegramSend } from '../telegram/send.js';
import { inSendWindow, lagosDayStart, nextWindowStart, tomorrowWindowStart } from './email/window.js';

export const TASK_SEND_EMAIL = 'outreach.send_email';
export const TASK_FOLLOWUP = 'outreach.followup';
export const TASK_CHECK_DELIVERY = 'outreach.check_delivery';

/** Resend keeps idempotency keys for 24 hours; after that a retry could send twice, so we stop and ask. */
const IDEMPOTENCY_WINDOW_MS = 23 * 3600_000;

type EmailMessage = MessageRow & { send_started_at: Date | null; in_reply_to_id: number | null };

/** Queues the send for an approved email. Re-approving after an edit queues a fresh task (new key). */
export async function enqueueSend(db: Queryable, msg: Pick<MessageRow, 'id' | 'lead_id' | 'approved_at' | 'channel'>) {
  if (msg.channel !== 'email') return null;
  return enqueue(db, TASK_SEND_EMAIL, { messageId: msg.id }, {
    idempotencyKey: `send:${msg.id}:${msg.approved_at ? new Date(msg.approved_at).getTime() : 0}`,
    leadId: msg.lead_id,
    maxAttempts: 4,
  });
}

/** Schedules the next follow-up draft after an email is sent (intro → follow-up 1 → follow-up 2). */
async function scheduleNextFollowUp(db: Queryable, msg: EmailMessage, settings: Settings) {
  const next = msg.step === 'intro' ? 'followup_1' : msg.step === 'followup_1' ? 'followup_2' : null;
  if (!next || !settings.followUpsEnabled) return;
  const days = next === 'followup_1' ? settings.followUp1AfterDays : settings.followUp2AfterDays;
  await enqueue(db, TASK_FOLLOWUP, { leadId: msg.lead_id, step: next }, {
    idempotencyKey: `followup:${msg.lead_id}:${next}`,
    runAt: new Date(Date.now() + days * 86_400_000),
    leadId: msg.lead_id,
    maxAttempts: 2,
  });
}

/** How long until another email may go out (0 = now), and why. */
export async function sendingDelay(db: Queryable, settings: Settings, now = new Date(), opts: { yours?: boolean } = {}): Promise<{ ms: number; why: string } | null> {
  // Sending hours are for outreach. A message or answer you wrote yourself in the Inbox goes now.
  if (!opts.yours && !inSendWindow(now, settings)) {
    const at = nextWindowStart(now, settings);
    return { ms: at.getTime() - now.getTime(), why: `Outside sending hours; waits until ${at.toISOString()}` };
  }
  const today = (
    await db.query<{ n: number; last: Date | null }>(
      `SELECT count(*) FILTER (WHERE sent_at >= $1)::int AS n, max(sent_at) AS last FROM messages WHERE sent_by = 'provider' AND channel = 'email'`,
      [lagosDayStart(now)],
    )
  ).rows[0]!;
  if (today.n >= settings.dailyEmailLimit) {
    const at = tomorrowWindowStart(now, settings);
    return { ms: at.getTime() - now.getTime(), why: `Daily limit of ${settings.dailyEmailLimit} reached; waits until ${at.toISOString()}` };
  }
  if (today.last) {
    const wait = new Date(today.last).getTime() + settings.minSecondsBetweenEmails * 1000 - now.getTime();
    if (wait > 0) return { ms: wait, why: `Spacing emails ${settings.minSecondsBetweenEmails}s apart` };
  }
  return null;
}

export const sendingHandlers: Record<string, TaskHandler> = {
  [TASK_SEND_EMAIL]: {
    // Safe to repeat: the message row is claimed atomically and Resend's idempotency key blocks a second send
    // within 24h. Sends found overdue at start-up are held for your review rather than sent late.
    policy: { retrySafe: true, reviewIfOverdue: true },
    async run(task, { db, signal, settings, log }) {
      const { messageId } = task.payload as { messageId: number };
      const msg = (await db.query<EmailMessage>('SELECT * FROM messages WHERE id = $1', [messageId])).rows[0];
      if (!msg) throw new PermanentError(`Message ${messageId} not found`);
      if (msg.channel !== 'email' || msg.direction !== 'outbound') throw new PermanentError('Not an outbound email');
      // Already handled, withdrawn, or edited back to draft: nothing to do (this is what makes repeats harmless).
      if (msg.status !== 'approved' && msg.status !== 'sending') return { skipped: `message is ${msg.status}` };

      const lead = msg.lead_id ? (await db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [msg.lead_id])).rows[0] ?? null : null;
      try {
        await assertContactable(db, lead, 'email', settings, lead ? null : msg.to_address);
      } catch (err) {
        if (!(err instanceof OutreachError)) throw err;
        if (msg.status === 'approved') {
          await db.query(`UPDATE messages SET status = 'cancelled', status_reason = $2, updated_at = now() WHERE id = $1`, [msg.id, err.message]);
        }
        log.info(`Email #${msg.id} not sent: ${err.message}`);
        return { skipped: err.code };
      }
      const problems = complianceProblems('email', msg.subject, msg.body, msg.step);
      if (problems.length) {
        await db.query(`UPDATE messages SET status = 'draft', approved_at = NULL, status_reason = $2, updated_at = now() WHERE id = $1 AND status = 'approved'`, [msg.id, problems.join(' ')]);
        return { skipped: 'not compliant; returned to draft' };
      }
      const inReplyTo = msg.in_reply_to_id
        ? (await db.query<{ external_message_id: string | null }>('SELECT external_message_id FROM messages WHERE id = $1', [msg.in_reply_to_id])).rows[0]?.external_message_id ?? null
        : null;
      const email = composeEmail({ ...msg, to_address: msg.to_address!, subject: msg.subject! }, settings, inReplyTo);

      if (settings.emailSendingMode === 'dry_run' && msg.status === 'sending') {
        throw new HoldForReviewError('This email was being sent when sending was switched to dry run. Check Resend, then retry in live mode or cancel.');
      }
      if (settings.emailSendingMode === 'dry_run') {
        await db.query(
          `UPDATE messages SET status = 'dry_run', dry_run_at = now(), status_reason = 'Dry run: rendered and logged, not sent', updated_at = now()
           WHERE id = $1 AND status = 'approved'`,
          [msg.id],
        );
        log.info(`Dry run: email #${msg.id} to ${email.to} would be sent now`, { from: email.from, replyTo: email.replyTo, subject: email.subject });
        return { dryRun: true };
      }

      const missing = emailConfigProblems(settings);
      if (missing.length) throw new HoldForReviewError(`Email is not set up for live sending: ${missing.map((m) => m.message).join(' ')}`);

      const delay = await sendingDelay(db, settings, new Date(), { yours: msg.created_by === 'user' && (msg.step === 'reply' || msg.step === 'message') });
      if (delay) throw new RateLimitedError(delay.why, Math.max(delay.ms, 1000));

      // Claim the message. A message already "sending" was handed to Resend before (crash or network error):
      // retrying with the same idempotency key is safe only inside Resend's 24-hour window.
      if (msg.status === 'sending' && msg.send_started_at && Date.now() - new Date(msg.send_started_at).getTime() > IDEMPOTENCY_WINDOW_MS) {
        await db.query(
          `UPDATE messages SET status = 'failed', error = 'Unknown whether this was sent (more than 24h since the attempt). Check Resend before sending again.', updated_at = now() WHERE id = $1`,
          [msg.id],
        );
        throw new PermanentError('Send outcome unknown after 24h; marked failed for you to check');
      }
      const claimed = await db.query(
        `UPDATE messages SET status = 'sending', send_started_at = coalesce(send_started_at, now()), updated_at = now()
         WHERE id = $1 AND status IN ('approved', 'sending') RETURNING id`,
        [msg.id],
      );
      if (!claimed.rowCount) return { skipped: 'changed while sending' };

      try {
        const { id: providerId } = await sendEmail(email, signal);
        await db.query(
          `UPDATE messages SET status = 'sent', sent_at = now(), sent_by = 'provider', provider_message_id = $2, error = NULL,
             status_reason = NULL, updated_at = now() WHERE id = $1`,
          [msg.id, providerId],
        );
        await db.query(
          `UPDATE leads SET status = 'contacted', updated_at = now() WHERE id = $1 AND status IN ('discovered', 'qualified', 'unqualified')`,
          [msg.lead_id],
        );
        await recordUsage(db, 'resend', 'email_sent', { detail: { messageId: msg.id } });
        await scheduleNextFollowUp(db, msg, settings);
        log.info(`Email #${msg.id} sent to ${email.to}`);
        return { sent: true, providerId };
      } catch (err) {
        if (err instanceof RateLimitedError) {
          await db.query(`UPDATE messages SET status = 'approved', updated_at = now() WHERE id = $1 AND status = 'sending'`, [msg.id]);
        } else if (err instanceof PermanentError) {
          // Resend refused it (e.g. invalid address): it was not sent.
          await db.query(`UPDATE messages SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [msg.id, err.message]);
        } else if (err instanceof AmbiguousSendError) {
          // Stays "sending"; the retry reuses the idempotency key.
          await db.query(`UPDATE messages SET error = $2, updated_at = now() WHERE id = $1`, [msg.id, err.message]);
        }
        throw err;
      }
    },
  },

  [TASK_FOLLOWUP]: {
    // Only drafts a follow-up for your approval, so running it late or twice is harmless.
    policy: { retrySafe: true, reviewIfOverdue: false },
    async run(task, { db, settings, log }) {
      const { leadId, step } = task.payload as { leadId: number; step: 'followup_1' | 'followup_2' };
      if (!settings.followUpsEnabled) return { skipped: 'follow-ups are off' };
      const lead = (await db.query<{ status: string }>('SELECT status FROM leads WHERE id = $1', [leadId])).rows[0];
      if (!lead) throw new PermanentError(`Lead ${leadId} not found`);
      // Any reply, or any status change by you, ends the sequence.
      if (lead.status !== 'contacted') return { skipped: `lead is ${lead.status}` };
      // Out-of-office replies don't count: the sequence goes on.
      const replied = await db.query(
        `SELECT 1 FROM messages WHERE lead_id = $1 AND direction = 'inbound' AND coalesce(classification, 'other') <> 'auto_reply' LIMIT 1`,
        [leadId],
      );
      if (replied.rowCount) return { skipped: 'they replied' };
      try {
        const msg = await draftOutreach(db, leadId, 'email', settings, { step, createdBy: 'agent' });
        if (await maybeAutoApprove(db, msg.id, settings)) {
          log.info(`Follow-up #${msg.id} (${step.replace('_', ' ')}) for lead #${leadId} approved automatically (Controlled Autonomous Mode)`);
          return { drafted: msg.id, autoApproved: true };
        }
        log.info(`Follow-up draft #${msg.id} (${step.replace('_', ' ')}) for lead #${leadId} is waiting for approval`);
        return { drafted: msg.id };
      } catch (err) {
        if (err instanceof OutreachError) return { skipped: err.code };
        throw err;
      }
    },
  },

  [TASK_CHECK_DELIVERY]: {
    policy: { retrySafe: true, reviewIfOverdue: false },
    async run(_task, { db, log }) {
      const { rows } = await db.query<{ id: number; lead_id: number; provider_message_id: string; to_address: string }>(
        `SELECT id, lead_id, provider_message_id, to_address FROM messages
         WHERE sent_by = 'provider' AND channel = 'email' AND provider_message_id IS NOT NULL AND sent_at > now() - interval '7 days'
           AND coalesce(delivery_status, '') NOT IN ('bounced', 'complained')
           AND (delivery_checked_at IS NULL OR delivery_checked_at < now() - interval '25 minutes')
         ORDER BY sent_at DESC LIMIT 50`,
      );
      let bounced = 0;
      let complained = 0;
      for (const m of rows) {
        let lastEvent: string | null;
        try {
          ({ lastEvent } = await getEmail(m.provider_message_id));
        } catch (err) {
          if (err instanceof PermanentError && /Resend 40[13]/.test(err.message)) {
            return { skipped: 'This Resend key cannot read delivery status (sending-only key). Bounces will not be detected.' };
          }
          throw err;
        }
        await recordUsage(db, 'resend', 'delivery_check');
        await db.query('UPDATE messages SET delivery_status = $2, delivery_checked_at = now() WHERE id = $1', [m.id, lastEvent]);
        if (lastEvent === 'bounced') {
          bounced++;
          await addSuppression(db, 'email', m.to_address, { reason: 'Email bounced', source: 'bounce', leadId: m.lead_id });
          await cancelOpenMessages(db, m.lead_id, 'Email bounced');
          await cancelLeadTasks(db, m.lead_id, CONTACT_TASK_TYPES, 'Email bounced');
        } else if (lastEvent === 'complained') {
          complained++;
          await applyDoNotContact(db, m.lead_id, 'Marked our email as spam', 'complaint');
        }
      }
      if (bounced || complained) log.warn(`Delivery check: ${bounced} bounce(s), ${complained} spam complaint(s); addresses added to the do-not-contact list`);
      return { checked: rows.length, bounced, complained };
    },
  },
};

export const sendingRecurring: RecurringJob[] = [
  { type: TASK_CHECK_DELIVERY, everyMinutes: 30, enabled: (s) => s.emailSendingMode === 'live' },
];

/** On approval: queue an email's send, an Instagram/Facebook reply's API send when that is live, or a Telegram bot reply. */
export async function afterApprove(db: Db, msg: MessageRow, settings: Settings) {
  if (msg.channel === 'email') return enqueueSend(db, msg);
  if (msg.channel === 'instagram' || msg.channel === 'facebook') return enqueueMetaSend(db, msg, settings);
  if (msg.channel === 'telegram') return enqueueTelegramSend(db, msg);
  return null;
}
