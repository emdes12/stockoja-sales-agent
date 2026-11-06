import type { Db } from '../db/pool.js';
import type { RecurringJob, TaskHandler } from '../agent/controller.js';
import type { Settings } from '../settings.js';
import { getState, setState } from '../settings.js';
import { HoldForReviewError } from '../queue/queue.js';
import { recordUsage } from '../usage.js';
import { socialHandle } from '../outreach/channels.js';
import { autoAnswer, recordReply } from '../inbox/process.js';
import { upsertContact } from '../inbox/contacts.js';
import { maybeAutoApprove } from '../outreach/autonomy.js';
import { explainTelegramError, telegram, TelegramApiError, telegramConfigProblems } from './bot.js';

/**
 * Reads new messages sent to your Telegram bot (private chats only; groups the bot is in are ignored). Each message
 * is stored once (by chat and message id). Telegram keeps undelivered messages for 24 hours, so the agent should
 * run at least once a day for nothing to be missed.
 */

export const TASK_CHECK_TELEGRAM = 'telegram.check_inbox';

interface Update {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    chat: { id: number; type: string };
    from?: { id: number; is_bot: boolean; first_name?: string; last_name?: string; username?: string };
    photo?: unknown;
    document?: unknown;
    voice?: unknown;
  };
}

export interface TelegramCheckResult {
  updates: number;
  messages: number;
  fromLeads: number;
  drafted: number;
  autoApproved: number;
}

/** A lead whose Telegram username is this one (one lead only; two would be ambiguous). */
async function leadForTelegram(db: Db, username: string): Promise<number | null> {
  const { rows } = await db.query<{ id: number; v: string }>(
    `SELECT id, socials->>'telegram' AS v FROM leads WHERE socials ? 'telegram' AND position($1 in lower(socials->>'telegram')) > 0`,
    [username.toLowerCase()],
  );
  const hits = rows.filter((r) => socialHandle('telegram', r.v) === username.toLowerCase());
  return hits.length === 1 ? hits[0]!.id : null;
}

export async function checkTelegram(db: Db, settings: Settings, opts: { signal?: AbortSignal } = {}): Promise<TelegramCheckResult> {
  const result: TelegramCheckResult = { updates: 0, messages: 0, fromLeads: 0, drafted: 0, autoApproved: 0 };
  const saved = await getState<{ offset: number }>(db, 'telegram.offset');
  for (let round = 0; round < 10 && !opts.signal?.aborted; round++) {
    const updates = await telegram<Update[]>('getUpdates', { offset: saved?.offset ?? undefined, timeout: 0, limit: 100, allowed_updates: ['message'] }, opts.signal);
    if (!updates.length) break;
    for (const u of updates) {
      result.updates++;
      const m = u.message;
      if (m && m.chat.type === 'private' && m.from && !m.from.is_bot) {
        const raw = (m.text ?? m.caption ?? '').trim();
        // "/start" is what Telegram sends when someone opens the bot: not a message to answer.
        if (!/^\/start\b/.test(raw) || raw.length > 20) {
          const text = raw || (m.photo || m.document || m.voice ? '(A photo, voice note or file: open the chat in Telegram to see it.)' : '(no text)');
          const at = new Date(m.date * 1000);
          const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || null;
          const contact = await upsertContact(db, 'telegram', String(m.chat.id), { username: m.from.username ?? null, name, at });
          let leadId = contact.lead_id;
          if (!leadId && contact.username) {
            leadId = await leadForTelegram(db, contact.username);
            if (leadId) await db.query(`UPDATE social_contacts SET lead_id = $2, updated_at = now() WHERE id = $1`, [contact.id, leadId]);
          }
          const recorded = await recordReply(db, leadId, {
            channel: 'telegram', from: contact.username ? `@${contact.username}` : name, subject: '', text, date: at,
            messageId: `telegram:${m.chat.id}:${m.message_id}`, source: 'telegram', socialContactId: contact.id,
          });
          if (recorded) {
            result.messages++;
            if (leadId) result.fromLeads++;
            const answer = await autoAnswer(db, recorded.msg, settings);
            if (answer && 'drafted' in answer) {
              result.drafted++;
              if (await maybeAutoApprove(db, answer.drafted.id, settings)) result.autoApproved++;
            }
          }
        }
      }
      // Confirming the update to Telegram only after it is stored: a crash re-reads it, and the id makes that harmless.
      await setState(db, 'telegram.offset', { offset: u.update_id + 1 });
      if (saved) saved.offset = u.update_id + 1;
    }
    if (!saved) break; // first run: one batch is enough
  }
  await setState(db, 'telegram.lastCheck', { at: new Date().toISOString(), ...result });
  await recordUsage(db, 'telegram', 'inbox_check', { units: result.updates });
  return result;
}

export const telegramHandlers: Record<string, TaskHandler> = {
  [TASK_CHECK_TELEGRAM]: {
    // Read-only and de-duplicated by message id: safe to repeat.
    policy: { retrySafe: true, reviewIfOverdue: false },
    async run(_task, { db, signal, settings, log }) {
      if (!settings.inboxAccess.telegram) return { skipped: 'Telegram is switched off under Inbox access' };
      const problems = telegramConfigProblems();
      if (problems.length) throw new HoldForReviewError(problems.join(' '));
      try {
        const r = await checkTelegram(db, settings, { signal });
        if (r.messages) log.info(`Telegram: ${r.messages} new message(s), ${r.fromLeads} from leads, ${r.drafted} draft(s)${r.autoApproved ? `, ${r.autoApproved} sent automatically` : ''}`);
        return r;
      } catch (err) {
        throw err instanceof TelegramApiError ? explainTelegramError(err) : err;
      }
    },
  },
};

export const telegramRecurring: RecurringJob[] = [
  {
    type: TASK_CHECK_TELEGRAM,
    everyMinutes: (s) => s.telegramCheckMinutes,
    enabled: (s) => s.inboxAccess.telegram && telegramConfigProblems().length === 0,
  },
];
