import type { Db, Queryable } from '../db/pool.js';
import type { TaskHandler } from '../agent/controller.js';
import type { LeadRow } from '../leads/leads.js';
import { enqueue, HoldForReviewError, PermanentError } from '../queue/queue.js';
import { assertContactable, OutreachError, type MessageRow } from '../outreach/messages.js';
import { complianceProblems } from '../outreach/render.js';
import { getContact } from '../inbox/contacts.js';
import { explainTelegramError, telegram, TelegramApiError, telegramConfigProblems } from './bot.js';

/**
 * Sends an approved Telegram answer through your bot, to someone who wrote to the bot (a bot can't start a chat).
 * Cold Telegram messages to a lead's username are still sent by you. Telegram's API has no idempotency key, so a
 * send whose outcome is unknown is never retried: it comes back to you.
 */

export const TASK_SEND_TELEGRAM = 'telegram.send_reply';

/** Can the bot deliver this message? Only to a chat that wrote to the bot. */
async function botChat(db: Queryable, msg: Pick<MessageRow, 'social_contact_id' | 'channel' | 'step'>) {
  if (msg.channel !== 'telegram' || (msg.step !== 'reply' && msg.step !== 'message') || telegramConfigProblems().length) return null;
  const c = await getContact(db, msg.social_contact_id);
  return c && c.platform === 'telegram' && /^-?\d+$/.test(c.external_id) ? c : null;
}

export async function enqueueTelegramSend(db: Db, msg: MessageRow) {
  if (!(await botChat(db, msg))) return null;
  return enqueue(db, TASK_SEND_TELEGRAM, { messageId: msg.id }, {
    idempotencyKey: `telegram-send:${msg.id}:${msg.approved_at ? new Date(msg.approved_at).getTime() : 0}`,
    leadId: msg.lead_id,
    maxAttempts: 3,
  });
}

async function leaveForYou(db: Queryable, id: number, why: string) {
  await db.query(`UPDATE messages SET status = 'approved', status_reason = $2, updated_at = now() WHERE id = $1 AND status IN ('approved', 'sending')`, [id, why]);
}

export const telegramSendHandlers: Record<string, TaskHandler> = {
  [TASK_SEND_TELEGRAM]: {
    policy: { retrySafe: false, reviewIfOverdue: true },
    async run(task, { db, settings, log }) {
      const { messageId } = task.payload as { messageId: number };
      const msg = (await db.query<MessageRow>('SELECT * FROM messages WHERE id = $1', [messageId])).rows[0];
      if (!msg) throw new PermanentError(`Message ${messageId} not found`);
      if (msg.status === 'sending') {
        const why = 'This answer may already have been sent (the last attempt did not finish). Check the chat in Telegram, then press "I\'ve sent it" or send it yourself.';
        await leaveForYou(db, msg.id, why);
        throw new HoldForReviewError(why);
      }
      if (msg.status !== 'approved') return { skipped: `message is ${msg.status}` };
      const chat = await botChat(db, msg);
      if (!chat) {
        await leaveForYou(db, msg.id, 'The bot can only answer people who wrote to it. Send it yourself.');
        return { skipped: 'not a bot chat' };
      }
      const lead = msg.lead_id ? (await db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [msg.lead_id])).rows[0] ?? null : null;
      try {
        await assertContactable(db, lead, 'telegram', settings, msg.to_address);
      } catch (err) {
        if (!(err instanceof OutreachError)) throw err;
        await db.query(`UPDATE messages SET status = 'cancelled', status_reason = $2, updated_at = now() WHERE id = $1 AND status = 'approved'`, [msg.id, err.message]);
        return { skipped: err.code };
      }
      const problems = complianceProblems('telegram', msg.subject, msg.body, msg.step);
      if (problems.length) {
        await db.query(`UPDATE messages SET status = 'draft', approved_at = NULL, status_reason = $2, updated_at = now() WHERE id = $1 AND status = 'approved'`, [msg.id, problems.join(' ')]);
        return { skipped: 'not compliant; returned to draft' };
      }
      const claimed = await db.query(`UPDATE messages SET status = 'sending', send_started_at = now(), updated_at = now() WHERE id = $1 AND status = 'approved' RETURNING id`, [msg.id]);
      if (!claimed.rowCount) return { skipped: 'changed while sending' };
      try {
        const r = await telegram<{ message_id: number }>('sendMessage', { chat_id: Number(chat.external_id), text: msg.body });
        await db.query(
          `UPDATE messages SET status = 'sent', sent_at = now(), sent_by = 'provider', provider_message_id = $2, error = NULL, status_reason = NULL, updated_at = now() WHERE id = $1`,
          [msg.id, String(r.message_id)],
        );
        log.info(`Telegram answer #${msg.id} sent through your bot`);
        return { sent: true };
      } catch (err) {
        if (err instanceof TelegramApiError) {
          // Telegram refused: nothing was sent.
          const why = err.status === 403 ? 'They have blocked your bot, so it cannot answer. Send it another way if appropriate.' : `Telegram did not send it: ${explainTelegramError(err).message}`;
          await leaveForYou(db, msg.id, why);
          await db.query(`UPDATE messages SET error = $2 WHERE id = $1`, [msg.id, err.message]);
          return { skipped: why };
        }
        const why = 'No answer from Telegram while sending: it may or may not have gone. Check the chat before sending again, or press "I\'ve sent it" if it arrived.';
        await leaveForYou(db, msg.id, why);
        await db.query(`UPDATE messages SET error = $2 WHERE id = $1`, [msg.id, (err as Error).message]);
        throw new PermanentError(why);
      }
    },
  },
};
