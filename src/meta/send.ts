import type { Db, Queryable } from '../db/pool.js';
import type { TaskHandler } from '../agent/controller.js';
import type { Settings } from '../settings.js';
import type { LeadRow } from '../leads/leads.js';
import { env } from '../config.js';
import { enqueue, HoldForReviewError, PermanentError } from '../queue/queue.js';
import { assertContactable, OutreachError, type MessageRow } from '../outreach/messages.js';
import { complianceProblems } from '../outreach/render.js';
import { explainMetaError, graph, MetaApiError, metaConfigProblems } from './graph.js';

/**
 * Sends an approved Instagram/Facebook reply through Meta's API, only when all of these hold:
 * - "Instagram & Facebook replies" is set to live in Settings (it starts as "you send them");
 * - it is a reply to someone who wrote to your Page or Instagram account, in the same chat;
 * - their last message is less than 24 hours old (Meta's standard messaging window);
 * - you approved it (the agent never approves these itself).
 * Anything else stays with you to send by hand, as with every other DM.
 */

export const TASK_SEND_META = 'meta.send_reply';
const WINDOW_MS = 24 * 3600_000;

type Contact = { id: number; platform: 'instagram' | 'facebook'; external_id: string; last_inbound_at: Date | null };

async function contactFor(db: Queryable, msg: Pick<MessageRow, 'social_contact_id' | 'channel'>) {
  if (!msg.social_contact_id) return null;
  const c = (await db.query<Contact>('SELECT id, platform, external_id, last_inbound_at FROM social_contacts WHERE id = $1', [msg.social_contact_id])).rows[0];
  return c && c.platform === msg.channel ? c : null;
}

export const insideWindow = (c: Pick<Contact, 'last_inbound_at'>, now = Date.now()) =>
  !!c.last_inbound_at && now - new Date(c.last_inbound_at).getTime() < WINDOW_MS;

/** Why an approved reply will (or won't) be sent by the API. Shown on the approval card. */
export async function apiSendability(db: Queryable, msg: MessageRow, settings: Settings): Promise<{ api: boolean; why: string } | null> {
  if (msg.channel !== 'instagram' && msg.channel !== 'facebook') return null;
  if ((msg.step !== 'reply' && msg.step !== 'message') || !msg.social_contact_id) return { api: false, why: 'Cold messages are always sent by you.' };
  if (settings.metaReplySending !== 'live') return { api: false, why: 'Instagram & Facebook replies are set to "you send them" in Settings.' };
  if (metaConfigProblems().length) return { api: false, why: 'The Meta app is not set up in .env.' };
  const c = await contactFor(db, msg);
  if (!c) return { api: false, why: 'This chat is not linked to a Meta contact.' };
  if (!insideWindow(c)) return { api: false, why: "Their last message is more than 24 hours old, so Meta won't accept an API reply. Send it yourself." };
  return { api: true, why: 'Sent through Meta when approved (inside the 24-hour window).' };
}

/** After you approve a reply: queue the API send when it qualifies; otherwise it waits for you. */
export async function enqueueMetaSend(db: Db, msg: MessageRow, settings: Settings) {
  const can = await apiSendability(db, msg, settings);
  if (!can?.api) return null;
  return enqueue(db, TASK_SEND_META, { messageId: msg.id }, {
    idempotencyKey: `meta-send:${msg.id}:${msg.approved_at ? new Date(msg.approved_at).getTime() : 0}`,
    leadId: msg.lead_id,
    maxAttempts: 3,
  });
}

/** Back to you: the reply stays approved, so "Copy text and open" and "I've sent it" still work. */
async function leaveForYou(db: Queryable, id: number, why: string) {
  await db.query(`UPDATE messages SET status = 'approved', status_reason = $2, updated_at = now() WHERE id = $1 AND status IN ('approved', 'sending')`, [id, why]);
}

export const metaSendHandlers: Record<string, TaskHandler> = {
  [TASK_SEND_META]: {
    // Meta's Send API has no idempotency key, so a send whose outcome is unknown is never retried blindly:
    // it is held for you to check the chat.
    policy: { retrySafe: false, reviewIfOverdue: true },
    async run(task, { db, settings, log }) {
      const { messageId } = task.payload as { messageId: number };
      const msg = (await db.query<MessageRow>('SELECT * FROM messages WHERE id = $1', [messageId])).rows[0];
      if (!msg) throw new PermanentError(`Message ${messageId} not found`);
      if (msg.status === 'sending') {
        // The last attempt never finished (the app stopped mid-send): unknown whether it went, so back to you.
        const why = `This reply may already have been sent (the last attempt did not finish). Check the chat, then press "I've sent it" or send it yourself.`;
        await leaveForYou(db, msg.id, why);
        throw new HoldForReviewError(why);
      }
      if (msg.status !== 'approved') return { skipped: `message is ${msg.status}` };

      const can = await apiSendability(db, msg, settings);
      if (!can?.api) {
        await leaveForYou(db, msg.id, can?.why ?? 'Send it yourself.');
        return { skipped: can?.why ?? 'not sendable by the API' };
      }
      const lead = msg.lead_id ? (await db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [msg.lead_id])).rows[0] ?? null : null;
      try {
        await assertContactable(db, lead, msg.channel, settings, msg.to_address);
      } catch (err) {
        if (!(err instanceof OutreachError)) throw err;
        await db.query(`UPDATE messages SET status = 'cancelled', status_reason = $2, updated_at = now() WHERE id = $1 AND status = 'approved'`, [msg.id, err.message]);
        return { skipped: err.code };
      }
      const problems = complianceProblems(msg.channel, msg.subject, msg.body, msg.step);
      if (problems.length) {
        await db.query(`UPDATE messages SET status = 'draft', approved_at = NULL, status_reason = $2, updated_at = now() WHERE id = $1 AND status = 'approved'`, [msg.id, problems.join(' ')]);
        return { skipped: 'not compliant; returned to draft' };
      }
      const contact = (await contactFor(db, msg))!;
      const claimed = await db.query(`UPDATE messages SET status = 'sending', send_started_at = now(), updated_at = now() WHERE id = $1 AND status = 'approved' RETURNING id`, [msg.id]);
      if (!claimed.rowCount) return { skipped: 'changed while sending' };

      try {
        const r = await graph<{ message_id?: string }>(db, `${env.META_PAGE_ID}/messages`, {
          method: 'POST',
          body: { recipient: { id: contact.external_id }, messaging_type: 'RESPONSE', message: { text: msg.body } },
          kind: `${msg.channel}_send`,
        });
        await db.query(
          `UPDATE messages SET status = 'sent', sent_at = now(), sent_by = 'provider', provider_message_id = $2, error = NULL, status_reason = NULL, updated_at = now()
           WHERE id = $1`,
          [msg.id, r.message_id ?? null],
        );
        log.info(`${msg.channel === 'instagram' ? 'Instagram' : 'Facebook'} reply #${msg.id} sent through Meta`);
        return { sent: true };
      } catch (err) {
        if (err instanceof MetaApiError) {
          // Meta answered with a refusal: nothing was sent, so it is safe to hand back to you.
          const outside = err.code === 10 && err.subcode === 2018278;
          const why = outside
            ? "Meta says the 24-hour reply window has closed. Send it yourself."
            : `Meta did not send it: ${explainMetaError(err).message} You can send it yourself.`;
          await leaveForYou(db, msg.id, why);
          await db.query(`UPDATE messages SET error = $2 WHERE id = $1`, [msg.id, err.message]);
          return { skipped: why };
        }
        // No answer (network): unknown whether it went. Back to you with a warning; never resent automatically.
        const why = `No answer from Meta while sending: it may or may not have gone. Check the chat before sending it yourself, or press "I've sent it" if it arrived.`;
        await leaveForYou(db, msg.id, why);
        await db.query(`UPDATE messages SET error = $2 WHERE id = $1`, [msg.id, (err as Error).message]);
        throw new PermanentError(why);
      }
    },
  },
};
