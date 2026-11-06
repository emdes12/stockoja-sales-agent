import type { Db } from '../db/pool.js';
import type { RecurringJob, TaskHandler } from '../agent/controller.js';
import type { Settings } from '../settings.js';
import { getState, setState } from '../settings.js';
import { env } from '../config.js';
import { HoldForReviewError, PermanentError } from '../queue/queue.js';
import { recordUsage } from '../usage.js';
import { OutreachError } from '../outreach/messages.js';
import { imapConfigProblems, MAX_DOWNLOAD_BYTES, openMailbox, type MailHeader, type Mailbox } from './mailbox.js';
import { parseEmail, type InboundEmail } from './parse.js';
import { autoAnswer, recordBookingNotice, recordReply, triage } from './process.js';
import { emailContact } from './contacts.js';
import { logger } from '../log.js';
import { maybeAutoApprove } from '../outreach/autonomy.js';

const log = logger('inbox');

export const TASK_CHECK_INBOX = 'inbox.check';

/** Replaceable in tests (a fake mailbox), so no test ever connects to a real server. */
export const inboxDeps: { openMailbox: () => Mailbox } = { openMailbox };

interface Cursor {
  mailbox: string;
  uidValidity: string;
  lastUid: number;
}

/** Most messages looked at per check; the rest wait for the next one. */
const BATCH = 200;

export interface CheckResult {
  looked: number;
  replies: number;
  duplicates: number;
  unmatched: number;
  bookings: number;
  ignored: number;
  drafted: number;
  autoApproved: number;
  skipped: number;
}

const tooLarge = (h: MailHeader): InboundEmail => ({
  messageId: h.messageId,
  inReplyTo: h.inReplyTo,
  from: h.from,
  subject: h.subject,
  date: h.date,
  text: '(This message is too large to download. Open it in your mailbox.)',
  autoHeaders: [],
});

/**
 * Reads new mail since the last check, read-only. Each message is decided on its envelope first; only those
 * from leads, booking notices and replies to outreach subjects are downloaded. The cursor moves after each
 * message, and the Message-ID makes a repeat harmless, so a crash mid-check neither loses nor doubles a reply.
 */
/** The folders to read: yours from Settings, or IMAP_MAILBOX from .env. */
export const emailFolders = (settings: Settings) => (settings.emailFolders.length ? settings.emailFolders : [env.IMAP_MAILBOX]);
/** The INBOX keeps the cursor key it always had, so upgrading doesn't re-read old mail. */
const cursorKey = (folder: string) => (folder === env.IMAP_MAILBOX ? 'inbox.cursor' : `inbox.cursor.${folder}`);

export async function checkInbox(db: Db, settings: Settings, opts: { signal?: AbortSignal } = {}): Promise<CheckResult> {
  const result: CheckResult = { looked: 0, replies: 0, duplicates: 0, unmatched: 0, bookings: 0, ignored: 0, drafted: 0, autoApproved: 0, skipped: 0 };
  const mailbox = inboxDeps.openMailbox();
  try {
    for (const folder of emailFolders(settings)) {
      if (opts.signal?.aborted) break;
      await checkFolder(folder);
    }
  } finally {
    await mailbox.close().catch(() => {});
  }
  await setState(db, 'inbox.lastCheck', { at: new Date().toISOString(), ...result });
  await recordUsage(db, 'imap', 'mailbox_check', { units: result.looked });
  return result;

  async function checkFolder(folder: string) {
    const { uidValidity, uidNext } = await mailbox.open(folder);
    const key = cursorKey(folder);
    const saved = await getState<Cursor>(db, key);
    const fresh = !saved || saved.uidValidity !== uidValidity || saved.mailbox !== folder;
    const since = new Date(Date.now() - settings.replyLookbackDays * 86_400_000);
    const headers = await mailbox.listHeaders({ afterUid: fresh ? null : saved.lastUid, since, limit: BATCH });
    let lastUid = fresh ? 0 : saved.lastUid;

    const failing = await getState<{ uid: number; count: number; folder?: string }>(db, 'inbox.failing');
    for (const h of headers) {
      if (opts.signal?.aborted) break;
      result.looked++;
      try {
        await handleOne(h);
      } catch (err) {
        // Retried on the next check. A message that fails three times is skipped (and logged) so it can't block the rest.
        const count = failing?.uid === h.uid && (failing.folder ?? env.IMAP_MAILBOX) === folder ? failing.count + 1 : 1;
        if (count < 3) {
          await setState(db, 'inbox.failing', { uid: h.uid, count, folder });
          throw err;
        }
        result.skipped++;
        log.error(`Could not process a message from ${h.from ?? 'unknown'} ("${h.subject}") after 3 tries; skipped. Read it in your mailbox.`, err);
      }
      lastUid = h.uid;
      await setState(db, key, { mailbox: folder, uidValidity, lastUid } satisfies Cursor);
    }

    async function handleOne(h: MailHeader) {
      const t = await triage(db, h, settings.emailReadAll);
      if (t.kind === 'ignore') {
        result.ignored++;
      } else {
        const email = h.size > MAX_DOWNLOAD_BYTES ? tooLarge(h) : await parseEmail(await mailbox.fetchRaw(h.uid));
        email.messageId ??= h.messageId ?? `uid:${uidValidity}:${h.uid}`;
        if (t.kind === 'booking') {
          if (await recordBookingNotice(db, email)) result.bookings++;
          else result.ignored++;
        } else {
          // Everyone who writes is a contact, so a reply can go back to them and their messages stay together.
          const contact = await emailContact(db, email.from ?? h.from ?? '', email.date);
          const leadId = t.kind === 'lead' ? t.leadId : contact?.lead_id ?? null;
          if (!leadId && !contact) {
            result.ignored++;
            return;
          }
          const recorded = await recordReply(db, leadId, {
            channel: 'email', from: email.from, subject: email.subject, text: email.text, date: email.date,
            messageId: email.messageId, autoHeaders: email.autoHeaders, source: 'imap', socialContactId: contact?.id ?? null, folder,
          });
          if (!recorded) result.duplicates++;
          else {
            if (leadId) result.replies++;
            else result.unmatched++;
            const answer = await autoAnswer(db, recorded.msg, settings);
            if (answer && 'drafted' in answer) {
              result.drafted++;
              if (await maybeAutoApprove(db, answer.drafted.id, settings)) result.autoApproved++;
            }
          }
        }
      }
    }
    // First check with nothing (more) to read: start from the newest message, never from the top of the mailbox.
    if (headers.length < BATCH && !opts.signal?.aborted) {
      lastUid = Math.max(lastUid, uidNext - 1);
      await setState(db, key, { mailbox: folder, uidValidity, lastUid } satisfies Cursor);
    }
    await mailbox.closeFolder?.();
  }
}

/** Turns IMAP library errors into ones you can act on. Never includes the password. */
export function explainImapError(err: unknown): Error {
  const e = err as { authenticationFailed?: boolean; code?: string; message?: string; responseText?: string };
  if (e.authenticationFailed) {
    // The server's own reason (e.g. Gmail's "Application-specific password required") never contains the password.
    const reason = e.responseText ? ` The server said: "${e.responseText.slice(0, 200)}".` : '';
    return new PermanentError(`Mailbox login failed.${reason} Check IMAP_USER and IMAP_PASSWORD (use an app password, and make sure IMAP is enabled for the mailbox).`);
  }
  if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') return new Error(`Cannot reach ${env.IMAP_HOST}:${env.IMAP_PORT} (${e.code}). Check IMAP_HOST and your connection.`);
  if (/mailbox|nonexistent|doesn't exist/i.test(e.responseText ?? e.message ?? '')) {
    return new PermanentError(`The folder "${env.IMAP_MAILBOX}" was not found. Check IMAP_MAILBOX.`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Connects and opens the folder read-only, to prove the settings work. Reads and stores nothing. */
export async function testMailbox(): Promise<{ ok: true; messages: number } | { ok: false; error: string }> {
  const problems = imapConfigProblems();
  if (problems.length) return { ok: false, error: problems.map((p) => p.message).join(' ') };
  const mailbox = inboxDeps.openMailbox();
  try {
    const { exists } = await mailbox.open();
    return { ok: true, messages: exists };
  } catch (err) {
    return { ok: false, error: explainImapError(err).message };
  } finally {
    await mailbox.close().catch(() => {});
  }
}

export const inboxHandlers: Record<string, TaskHandler> = {
  [TASK_CHECK_INBOX]: {
    // Read-only and de-duplicated by Message-ID: safe to repeat at any time.
    policy: { retrySafe: true, reviewIfOverdue: false },
    async run(_task, { db, signal, settings, log }) {
      if (!settings.readReplies) return { skipped: 'reading replies is off' };
      if (!settings.inboxAccess.email) return { skipped: 'Email is switched off under Inbox access' };
      const problems = imapConfigProblems();
      if (problems.length) throw new HoldForReviewError(`Mailbox is not set up: ${problems.map((p) => p.message).join(' ')}`);
      let r: CheckResult;
      try {
        r = await checkInbox(db, settings, { signal });
      } catch (err) {
        if (err instanceof OutreachError) throw err;
        throw explainImapError(err);
      }
      if (r.replies || r.unmatched || r.bookings) {
        log.info(
          `Mailbox: ${r.replies} new repl${r.replies === 1 ? 'y' : 'ies'}, ${r.drafted} answer draft(s), ${r.bookings} booking notice(s), ${r.unmatched} to match by hand`,
        );
      }
      return r;
    },
  },
};

export const inboxRecurring: RecurringJob[] = [
  {
    type: TASK_CHECK_INBOX,
    everyMinutes: (s) => s.replyCheckMinutes,
    enabled: (s) => s.readReplies && s.inboxAccess.email && imapConfigProblems().length === 0,
  },
];
