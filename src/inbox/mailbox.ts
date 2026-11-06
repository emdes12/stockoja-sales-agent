import { ImapFlow } from 'imapflow';
import { env } from '../config.js';

/** What the agent sees of a message before deciding whether to download it. */
export interface MailHeader {
  uid: number;
  from: string | null;
  subject: string;
  date: Date | null;
  messageId: string | null;
  inReplyTo: string | null;
  size: number;
}

/**
 * A mailbox opened read-only. The agent lists headers first and downloads a body only for mail it keeps: with
 * "read every message" on, everything in the folders you chose (except your own and automated bulk mail); off, only
 * mail from leads and answers to outreach. Nothing is ever marked read, moved or deleted.
 */
export interface Mailbox {
  /** Opens a folder (default: IMAP_MAILBOX); uidValidity changes if the server renumbered it (then the cursor restarts). */
  open(folder?: string): Promise<{ uidValidity: string; uidNext: number; exists: number }>;
  /** Closes the open folder so another can be opened on the same connection. */
  closeFolder?(): Promise<void>;
  /** Headers of messages with a UID above `afterUid`, or (first run) received since `since`. Oldest first. */
  listHeaders(opts: { afterUid: number | null; since: Date; limit: number }): Promise<MailHeader[]>;
  fetchRaw(uid: number): Promise<Buffer>;
  close(): Promise<void>;
}

export interface ImapConfigProblem {
  field: string;
  message: string;
}

export function imapConfigProblems(): ImapConfigProblem[] {
  const p: ImapConfigProblem[] = [];
  if (!env.IMAP_HOST) p.push({ field: 'IMAP_HOST', message: 'Add IMAP_HOST to .env (e.g. imap.gmail.com).' });
  if (!env.IMAP_USER) p.push({ field: 'IMAP_USER', message: 'Add IMAP_USER to .env (the mailbox login).' });
  if (!env.IMAP_PASSWORD) p.push({ field: 'IMAP_PASSWORD', message: 'Add IMAP_PASSWORD to .env (an app password).' });
  // Gmail refuses the normal account password over IMAP; an app password is always 16 letters. Catching it here
  // avoids failed logins, which can get the account temporarily locked.
  else if (/(^|\.)(gmail|googlemail)\.com$/i.test(env.IMAP_HOST) && !/^[a-z]{16}$/i.test(env.IMAP_PASSWORD.replace(/\s/g, ''))) {
    p.push({
      field: 'IMAP_PASSWORD',
      message:
        "IMAP_PASSWORD doesn't look like a Gmail app password (16 letters, shown as four groups of four). Gmail refuses your normal password here: turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords.",
    });
  }
  return p;
}

/** Messages larger than this are listed but never downloaded (attachments are not needed). */
export const MAX_DOWNLOAD_BYTES = 2_000_000;

export class ImapMailbox implements Mailbox {
  private client: ImapFlow;
  private release: (() => void) | null = null;

  constructor() {
    this.client = new ImapFlow({
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      secure: env.IMAP_SECURE,
      auth: { user: env.IMAP_USER, pass: env.IMAP_PASSWORD },
      logger: false, // its logs would include addresses and server chatter
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
  }

  private connected = false;

  async open(folder = env.IMAP_MAILBOX) {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
    this.release?.();
    // EXAMINE, not SELECT: the server will not let this session change flags, move or delete anything.
    const lock = await this.client.getMailboxLock(folder, { readOnly: true });
    this.release = () => lock.release();
    const mb = this.client.mailbox;
    if (!mb) throw new Error(`Could not open ${folder}`);
    return { uidValidity: String(mb.uidValidity), uidNext: mb.uidNext, exists: mb.exists };
  }

  async listHeaders({ afterUid, since, limit }: { afterUid: number | null; since: Date; limit: number }) {
    let range: string | number[];
    if (afterUid === null) {
      const found = await this.client.search({ since }, { uid: true });
      if (!found || !found.length) return [];
      range = found.slice(0, limit);
    } else {
      range = `${afterUid + 1}:*`;
    }
    const out: MailHeader[] = [];
    for await (const m of this.client.fetch(range, { uid: true, envelope: true, size: true }, { uid: true })) {
      // "n:*" always returns the newest message even when it is older than n; skip it.
      if (afterUid !== null && m.uid <= afterUid) continue;
      out.push({
        uid: m.uid,
        from: m.envelope?.from?.[0]?.address?.toLowerCase() ?? null,
        subject: m.envelope?.subject ?? '',
        date: m.envelope?.date ?? null,
        messageId: m.envelope?.messageId ?? null,
        inReplyTo: m.envelope?.inReplyTo ?? null,
        size: m.size ?? 0,
      });
    }
    return out.sort((a, b) => a.uid - b.uid).slice(0, limit);
  }

  async fetchRaw(uid: number) {
    // BODY.PEEK: reading the source does not mark the message as read.
    const m = await this.client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!m || !m.source) throw new Error(`Message ${uid} could not be downloaded`);
    return m.source;
  }

  async closeFolder() {
    this.release?.();
    this.release = null;
  }

  async close() {
    this.release?.();
    this.release = null;
    await this.client.logout().catch(() => this.client.close());
  }
}

export const openMailbox = (): Mailbox => new ImapMailbox();
