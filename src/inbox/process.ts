import { tx, type Db, type Queryable } from '../db/pool.js';
import { env } from '../config.js';
import type { Settings } from '../settings.js';
import type { LeadRow } from '../leads/leads.js';
import { normalizeEmail } from '../leads/normalize.js';
import { cancelLeadTasks } from '../queue/queue.js';
import { cancelOpenMessages, CONTACT_TASK_TYPES, doNotContactIn, suppressionReason } from '../outreach/suppressions.js';
import { assertContactable, OutreachError, type MessageRow } from '../outreach/messages.js';
import { registrationLink, type Channel } from '../outreach/render.js';
import { searchKb, type KbEntry } from '../outreach/kb.js';
import { writeReplyAnswer, type AiSources, type ChatLine } from '../ai/write.js';
import { aiConfigured } from '../ai/gemini.js';
import { classify, questionsIn, type Classification, type Label } from './classify.js';
import { baseSubject, type InboundEmail } from './parse.js';
import { getContact, replyAddress, suppressContact } from './contacts.js';

const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com', 'yahoo.co.uk', 'googlemail.com']);
const BOOKING_SENDERS = /(^|\.)(cal\.com|calendly\.com)$/i;

export type InboundRow = MessageRow & {
  from_address: string | null;
  received_at: Date | null;
  external_message_id: string | null;
  in_reply_to_id: number | null;
  classification: Label | null;
  classification_reasons: string[];
  needs_attention: boolean;
  handled_at: Date | null;
  social_contact_id: number | null;
};

// ── Matching ─────────────────────────────────────────────────────────────────

/** The lead an address belongs to: its own email, an address we emailed, or (for a lead we emailed) its business domain. */
export async function matchLead(db: Queryable, from: string): Promise<number | null> {
  const email = normalizeEmail(from);
  if (!email) return null;
  const direct = await db.query<{ id: number }>(
    `SELECT id FROM (
       SELECT l.id, 0 AS pri, (SELECT max(sent_at) FROM messages m WHERE m.lead_id = l.id AND m.direction = 'outbound') AS last
       FROM leads l WHERE l.email = $1
       UNION ALL
       SELECT m.lead_id, 1, max(m.sent_at) FROM messages m WHERE m.direction = 'outbound' AND m.to_address = $1 GROUP BY m.lead_id
     ) x ORDER BY last DESC NULLS LAST, pri, id LIMIT 1`,
    [email],
  );
  if (direct.rows[0]) return direct.rows[0].id;
  const domain = email.split('@')[1]!;
  if (FREE_MAIL.has(domain)) return null;
  // Someone else at the business answering: only for leads we have actually emailed.
  const byDomain = await db.query<{ id: number }>(
    `SELECT l.id FROM leads l
     JOIN messages m ON m.lead_id = l.id AND m.direction = 'outbound' AND m.status = 'sent' AND m.channel = 'email'
     WHERE l.website_domain = $1 OR split_part(l.email, '@', 2) = $1
     GROUP BY l.id ORDER BY max(m.sent_at) DESC LIMIT 1`,
    [domain],
  );
  return byDomain.rows[0]?.id ?? null;
}

/** Does this subject answer one of our sent emails? ("Re: <our subject>") */
export async function answersOutreachSubject(db: Queryable, subject: string): Promise<boolean> {
  const base = baseSubject(subject);
  if (base.length < 6 || !/^(re|aw|sv)\s*:/i.test(subject.trim())) return false;
  const { rowCount } = await db.query(
    `SELECT 1 FROM messages WHERE direction = 'outbound' AND channel = 'email' AND status = 'sent'
       AND lower(btrim(regexp_replace(subject, '^\\s*((re|fw|fwd|aw|sv|tr)\\s*(\\[\\d+\\])?\\s*:\\s*)+', '', 'i'))) = $1 LIMIT 1`,
    [base],
  );
  return (rowCount ?? 0) > 0;
}

export type Triage = { kind: 'lead'; leadId: number } | { kind: 'booking' } | { kind: 'unmatched' } | { kind: 'ignore'; why: string };

/** Newsletters, receipts and system mail: not people writing to you. */
const NO_REPLY = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|newsletter|bounce[s]?)([+._-].*)?@/i;

/**
 * Decides from the envelope alone whether a message is ours to read. With `readAll`, mail from anyone (except you
 * and obvious no-reply senders) is kept as a message from a contact; without it, only leads and answers to outreach.
 */
export async function triage(db: Queryable, h: { from: string | null; subject: string }, readAll = false): Promise<Triage> {
  const from = normalizeEmail(h.from);
  if (!from) return { kind: 'ignore', why: 'no sender' };
  const own = [env.OUTREACH_FROM_ADDRESS, env.OUTREACH_REPLY_TO, env.IMAP_USER].map((a) => normalizeEmail(a)).filter(Boolean);
  if (own.includes(from)) return { kind: 'ignore', why: 'from you' };
  if (BOOKING_SENDERS.test(from.split('@')[1]!)) return { kind: 'booking' };
  const leadId = await matchLead(db, from);
  if (leadId) return { kind: 'lead', leadId };
  if (await answersOutreachSubject(db, h.subject)) return { kind: 'unmatched' };
  if (readAll && !NO_REPLY.test(from)) return { kind: 'unmatched' };
  return { kind: 'ignore', why: readAll ? 'automated sender' : 'not related to outreach' };
}

// ── Recording a reply and acting on it ───────────────────────────────────────

/** Pipeline order; a reply only ever moves a lead forward. Closed statuses are left alone. */
const FROM_FOR: Record<'replied' | 'interested' | 'declined', string[]> = {
  replied: ['discovered', 'qualified', 'unqualified', 'contacted'],
  interested: ['discovered', 'qualified', 'unqualified', 'contacted', 'replied'],
  declined: ['discovered', 'qualified', 'unqualified', 'contacted', 'replied', 'interested'],
};
async function advanceLead(db: Queryable, leadId: number, to: keyof typeof FROM_FOR) {
  await db.query(`UPDATE leads SET status = $2, status_set_by = 'auto', updated_at = now() WHERE id = $1 AND status = ANY($3)`, [leadId, to, FROM_FOR[to]]);
}

/** Labels whose reply deserves an answer from you (or a drafted one). */
export const NEEDS_ANSWER: Label[] = ['interested', 'demo_request', 'question', 'other'];

/**
 * What a label does: opt-outs go on the do-not-contact list at once; "not interested" closes the lead; any real
 * reply stops the follow-up sequence. Auto-replies change nothing. Runs inside the caller's transaction.
 */
export async function applyLabel(db: Queryable, msg: { id: number; lead_id: number | null; social_contact_id?: number | null }, label: Label) {
  if (label === 'auto_reply') {
    await db.query(`UPDATE messages SET needs_attention = false, handled_at = coalesce(handled_at, now()) WHERE id = $1`, [msg.id]);
    return;
  }
  const contact = await getContact(db, msg.social_contact_id);
  // STOP from any address blocks that address, whoever it belongs to.
  if (label === 'opt_out' && contact) await suppressContact(db, contact, 'Asked not to be contacted (reply)', 'reply_stop');
  if (msg.lead_id === null) {
    // Someone who isn't a lead: nothing to advance; it waits for you unless it is a STOP or from someone you ignore.
    const done = label === 'opt_out' || !!contact?.ignored_at;
    await db.query(
      `UPDATE messages SET needs_attention = $2, handled_at = CASE WHEN $3 THEN coalesce(handled_at, now()) ELSE NULL END WHERE id = $1`,
      [msg.id, !done, done],
    );
    return;
  }
  // A real reply ends the sequence: no more follow-ups, and unsent ones are withdrawn.
  await cancelLeadTasks(db, msg.lead_id, ['outreach.followup'], 'They replied');
  await db.query(
    `UPDATE messages SET status = 'cancelled', status_reason = 'They replied', updated_at = now()
     WHERE lead_id = $1 AND direction = 'outbound' AND step IN ('followup_1', 'followup_2') AND status IN ('draft', 'approved')`,
    [msg.lead_id],
  );
  if (label === 'opt_out') {
    await doNotContactIn(db, msg.lead_id, 'Asked not to be contacted (reply)', 'reply_stop');
  } else if (label === 'not_interested') {
    await advanceLead(db, msg.lead_id, 'declined');
    await cancelOpenMessages(db, msg.lead_id, 'Not interested');
    await cancelLeadTasks(db, msg.lead_id, CONTACT_TASK_TYPES, 'Not interested');
  } else if (label === 'interested' || label === 'demo_request') {
    await advanceLead(db, msg.lead_id, 'interested');
  } else {
    await advanceLead(db, msg.lead_id, 'replied');
  }
  const done = label === 'opt_out' || label === 'not_interested';
  await db.query(
    `UPDATE messages SET needs_attention = $2, handled_at = CASE WHEN $3 THEN coalesce(handled_at, now()) ELSE NULL END WHERE id = $1`,
    [msg.id, !done, done],
  );
}

export interface IncomingReply {
  channel: Channel;
  from: string | null;
  subject: string;
  text: string;
  date: Date | null;
  messageId: string | null;
  autoHeaders?: string[];
  source: 'imap' | 'manual' | 'meta' | 'telegram' | 'paste';
  /** Who wrote (any channel), so a reply can go back to them. Required for a message from someone who isn't a lead. */
  socialContactId?: number | null;
  /** Email: the folder it was read from. */
  folder?: string | null;
}

/**
 * Stores a message and acts on it, in one transaction: from a lead, or (leadId null) from a contact who isn't a lead
 * yet. The same message read twice is stored once (Message-ID / platform id), so re-reading after a crash is
 * harmless. Returns null for a duplicate.
 */
export async function recordReply(db: Db, leadId: number | null, reply: IncomingReply): Promise<{ msg: InboundRow; classification: Classification } | null> {
  if (leadId === null && !reply.socialContactId) throw new Error('A message without a lead needs a contact');
  const classification = classify({ subject: reply.subject, text: reply.text, autoHeaders: reply.autoHeaders });
  return tx(db, async (client) => {
    const lastOut = (
      await client.query<{ id: number }>(
        leadId !== null
          ? `SELECT id FROM messages WHERE lead_id = $1 AND direction = 'outbound' AND channel = $2 AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`
          : `SELECT id FROM messages WHERE social_contact_id = $1 AND direction = 'outbound' AND channel = $2 AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`,
        [leadId ?? reply.socialContactId, reply.channel],
      )
    ).rows[0];
    const { rows } = await client.query<InboundRow>(
      `INSERT INTO messages (lead_id, channel, direction, step, subject, body, status, created_by, from_address, received_at,
         external_message_id, in_reply_to_id, classification, classification_reasons, classified_by, source, social_contact_id, folder)
       VALUES ($1, $2, 'inbound', NULL, $3, $4, 'received', $5, $6, coalesce($7, now()), $8, $9, $10, $11, 'agent', $12, $13, $14)
       ON CONFLICT (external_message_id) WHERE direction = 'inbound' AND external_message_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        leadId, reply.channel, reply.subject || null, reply.text || '(no text)', reply.source === 'manual' ? 'user' : 'agent',
        reply.channel === 'email' ? normalizeEmail(reply.from) : reply.from, reply.date, reply.messageId, lastOut?.id ?? null, classification.label,
        JSON.stringify(classification.reasons), reply.source, reply.socialContactId ?? null, reply.folder ?? null,
      ],
    );
    const msg = rows[0];
    if (!msg) return null;
    await applyLabel(client, msg, classification.label);
    return { msg: (await client.query<InboundRow>('SELECT * FROM messages WHERE id = $1', [msg.id])).rows[0]!, classification };
  });
}

/** You correct a label: its effects apply (an opt-out you remove later is lifted on the Do not contact page). */
export async function relabel(db: Db, id: number, label: Label) {
  return tx(db, async (client) => {
    const msg = (await client.query<InboundRow>(`SELECT * FROM messages WHERE id = $1 AND direction = 'inbound'`, [id])).rows[0];
    if (!msg) throw new OutreachError('NOT_FOUND', 'Reply not found');
    await client.query(
      `UPDATE messages SET classification = $2, classification_reasons = $3, classified_by = 'user', updated_at = now() WHERE id = $1`,
      [id, label, JSON.stringify(['Set by you'])],
    );
    await applyLabel(client, msg, label);
    return (await client.query<InboundRow>('SELECT * FROM messages WHERE id = $1', [id])).rows[0]!;
  });
}

// ── Reply drafts ─────────────────────────────────────────────────────────────

/** Where a reply to a contact goes: their address or username, or `id:<platform id>` when that is all we know. */
export async function socialReplyAddress(db: Queryable, contactId: number): Promise<string | null> {
  const c = await getContact(db, contactId);
  return c ? replyAddress(c) : null;
}

const PLACEHOLDER = '{{your_answer}}';

/** Approved answers for the questions in a reply (at most three, best first). */
export async function answersFor(db: Queryable, text: string): Promise<KbEntry[]> {
  const seen = new Map<number, { entry: KbEntry; score: number }>();
  for (const q of questionsIn(text)) {
    for (const r of await searchKb(db, q)) {
      const prev = seen.get(r.entry.id);
      if (!prev || prev.score < r.score) seen.set(r.entry.id, r);
    }
  }
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 3).map((r) => r.entry);
}

/**
 * Drafts an answer to a reply. "kb" uses only approved knowledge-base answers, plus your booking or sign-up
 * link; with nothing approved to say to a question it drafts nothing and leaves the reply for you. "blank"
 * gives you a draft with a {{your_answer}} gap that blocks approval until you write it. "ai" has the model write the
 * answer from your knowledge (documents, website, approved answers); it is marked as AI-written and checked.
 * The agent never proposes a demo time: it shares your booking link or asks them to suggest one.
 */
/**
 * The conversation before a message: this person, this channel, both sides (what they wrote, and what was sent to
 * them), the last "limit" messages, oldest first. Drafts and messages that never went are left out. Also says whether
 * we wrote to them first.
 */
export async function conversationBefore(db: Db, inbound: InboundRow, limit: number): Promise<{ lines: ChatLine[]; weWroteFirst: boolean }> {
  const who = inbound.social_contact_id ? 'social_contact_id = $2' : inbound.lead_id ? 'lead_id = $2' : null;
  if (!who) return { lines: [], weWroteFirst: false };
  const params = [inbound.channel, inbound.social_contact_id ?? inbound.lead_id, inbound.id, inbound.received_at ?? inbound.created_at];
  const shown = `channel = $1 AND ${who} AND id <> $3 AND coalesce(received_at, sent_at, created_at) <= $4
    AND (direction = 'inbound' OR status IN ('sent', 'dry_run', 'delivered', 'opened', 'clicked'))`;
  const [rows, first] = await Promise.all([
    limit > 0
      ? db.query<{ direction: string; body: string }>(
          `SELECT direction, body FROM (
             SELECT id, direction, body, coalesce(received_at, sent_at, created_at) AS at FROM messages WHERE ${shown}
             ORDER BY at DESC, id DESC LIMIT ${Math.trunc(limit)}
           ) t ORDER BY at, id`,
          params,
        )
      : Promise.resolve({ rows: [] }),
    db.query<{ direction: string }>(`SELECT direction FROM messages WHERE ${shown} ORDER BY coalesce(received_at, sent_at, created_at), id LIMIT 1`, params),
  ]);
  return {
    lines: rows.rows.map((r) => ({ from: r.direction === 'inbound' ? 'them' : 'you', text: r.body })),
    weWroteFirst: first.rows[0]?.direction === 'outbound',
  };
}

export async function draftReply(
  db: Db,
  inboundId: number,
  settings: Settings,
  mode: 'kb' | 'blank' | 'ai',
  createdBy: 'agent' | 'user' = 'agent',
): Promise<{ drafted: MessageRow } | { skipped: string; message: string }> {
  const inbound = (await db.query<InboundRow>(`SELECT * FROM messages WHERE id = $1 AND direction = 'inbound'`, [inboundId])).rows[0];
  if (!inbound) throw new OutreachError('NOT_FOUND', 'Reply not found');
  const lead = inbound.lead_id ? (await db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [inbound.lead_id])).rows[0]! : null;
  if (!settings.senderName) throw new OutreachError('NO_SENDER', 'Set your name under Settings → Sender and links before drafting.');
  const existing = await db.query(
    `SELECT 1 FROM messages WHERE in_reply_to_id = $1 AND direction = 'outbound' AND status NOT IN ('rejected', 'cancelled', 'failed')`,
    [inboundId],
  );
  if (existing.rowCount) throw new OutreachError('ALREADY_EXISTS', 'There is already a reply to this message.');
  const channel = inbound.channel;
  // A message is answered in the same chat: to its sender, even when the lead has no profile saved.
  const contactAddress = inbound.social_contact_id ? await socialReplyAddress(db, inbound.social_contact_id) : null;
  let to = await assertContactable(db, lead, channel, settings, contactAddress);
  if (channel === 'email' && inbound.from_address) {
    // Answer the address that wrote, if it is not blocked itself.
    const blocked = await suppressionReason(db, { email: inbound.from_address });
    if (blocked) throw new OutreachError('SUPPRESSED', blocked);
    to = inbound.from_address;
  }

  const label = inbound.classification ?? 'other';
  const earlier = await conversationBefore(db, inbound, settings.aiReplyHistory);
  const parts: string[] = [];
  let ai: { text: string; sources: AiSources } | null = null;
  if (mode === 'kb') {
    const answers = await answersFor(db, inbound.body);
    if (!answers.length && label !== 'demo_request' && label !== 'interested') {
      return { skipped: 'NO_ANSWER', message: 'No approved knowledge-base answer matches this reply. Write the answer yourself.' };
    }
    parts.push(...answers.map((a) => a.answer.trim()));
  } else if (mode === 'ai') {
    ai = await writeReplyAnswer(db, settings, { lead, inbound: inbound.body, label, history: earlier.lines });
    parts.push(ai.text);
  } else {
    parts.push(PLACEHOLDER);
  }
  if (mode !== 'blank') {
    if (label === 'demo_request') {
      parts.push(
        settings.bookingUrl
          ? `Happy to show you around. Pick a time that suits you here: ${settings.bookingUrl}`
          : "Happy to show you around. Reply with a day and time that suit you and I'll confirm.",
      );
    } else if (label === 'interested') {
      parts.push(`You can start free here: ${registrationLink(settings, channel, 'reply', lead?.id ?? null)}`);
      if (settings.bookingUrl) parts.push(`If a short walkthrough would help, pick a time here: ${settings.bookingUrl}`);
    }
  }

  // "Thanks for getting back to me" only when we wrote first; in a chat already going, no fresh hello.
  const greeting = earlier.weWroteFirst
    ? channel === 'email' ? 'Hello,\n\nThanks for getting back to me.' : 'Hello, thanks for getting back to me.'
    : earlier.lines.length
      ? channel === 'email' ? 'Hello,' : ''
      : channel === 'email' ? 'Hello,\n\nThanks for your message.' : 'Hello, thanks for your message.';
  const signature = channel === 'email' ? `${settings.senderName}\n${settings.senderTitle}`.trim() : settings.senderName;
  // No opt-out line on an answer: they wrote to us. You can add one yourself.
  const body = [greeting, ...parts, signature].filter(Boolean).join('\n\n');

  let subject: string | null = null;
  if (channel === 'email') {
    const theirs = inbound.subject?.trim();
    const ours = theirs
      ? null
      : (await db.query<{ subject: string }>(`SELECT subject FROM messages WHERE id = $1`, [inbound.in_reply_to_id])).rows[0]?.subject;
    const base = theirs || ours || 'Your message';
    subject = /^re\s*:/i.test(base) ? base : `Re: ${base}`;
  }

  try {
    const { rows } = await db.query<MessageRow>(
      `INSERT INTO messages (lead_id, channel, step, to_address, subject, body, original_body, status, created_by, in_reply_to_id,
         ai_generated, ai_sources, status_reason, social_contact_id)
       VALUES ($1, $2, 'reply', $3, $4, $5, $5, 'draft', $6, $7, $8, $9, $10, $11) RETURNING *`,
      [inbound.lead_id, channel, to, subject, body, createdBy, inbound.id, !!ai, ai ? JSON.stringify(ai.sources) : null,
        ai ? 'Written by AI: check the facts before approving' : null, inbound.social_contact_id],
    );
    await db.query(`UPDATE messages SET needs_attention = false WHERE id = $1`, [inbound.id]);
    return { drafted: rows[0]! };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new OutreachError('ALREADY_EXISTS', 'There is already a reply to this message.');
    throw err;
  }
}

/**
 * After a message is recorded: draft an answer. With AI answers on, AI writes it from your knowledge (approved
 * answers, documents, website) for this person; if AI is unavailable or over budget, approved knowledge-base answers
 * are used instead. With AI answers off, only knowledge-base answers.
 */
export async function autoAnswer(db: Db, msg: InboundRow, settings: Settings) {
  if (!NEEDS_ANSWER.includes(msg.classification ?? 'other') || msg.classification === 'other') return null;
  if (settings.replyAutonomy[msg.channel] === 'off' || !settings.inboxAccess[msg.channel]) return null;
  if ((await getContact(db, msg.social_contact_id))?.ignored_at) return null;
  try {
    if (settings.aiDraftReplies && aiConfigured()) {
      try {
        return await draftReply(db, msg.id, settings, 'ai');
      } catch (err) {
        if (!(err instanceof OutreachError) || !err.code.startsWith('AI_')) throw err;
        if (!settings.autoDraftReplies) return { skipped: err.code, message: err.message };
        const kb = await draftReply(db, msg.id, settings, 'kb');
        if ('drafted' in kb) await db.query(`UPDATE messages SET status_reason = $2 WHERE id = $1`, [kb.drafted.id, `Knowledge-base answer used: ${err.message}`]);
        return kb;
      }
    }
    if (!settings.autoDraftReplies) return null;
    return await draftReply(db, msg.id, settings, 'kb');
  } catch (err) {
    if (err instanceof OutreachError) return { skipped: err.code, message: err.message };
    throw err;
  }
}

// ── Booking notices (Cal.com / Calendly) ─────────────────────────────────────

/**
 * A booking confirmation from your Cal.com or Calendly account names the person who booked. If that email
 * belongs to a lead, the lead becomes "Demo booked". The notice's subject (which states the time) is kept
 * as the note; the agent does not interpret or invent a time.
 */
export async function recordBookingNotice(db: Db, email: Pick<InboundEmail, 'subject' | 'text'>) {
  const addresses = [...new Set((email.text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []).map((a) => normalizeEmail(a)).filter(Boolean))] as string[];
  const ownDomains = /(^|\.)(cal\.com|calendly\.com)$/i;
  const candidates = addresses.filter((a) => !ownDomains.test(a.split('@')[1]!) && a !== normalizeEmail(env.OUTREACH_REPLY_TO));
  if (!candidates.length) return null;
  const lead = (await db.query<{ id: number; status: string; demo_source: string | null }>(
    `SELECT id, status, demo_source FROM leads WHERE email = ANY($1) ORDER BY updated_at DESC LIMIT 1`, [candidates],
  )).rows[0];
  if (!lead) return null;
  const cancelled = /\b(cancel(l)?ed|cancellation)\b/i.test(email.subject);
  if (cancelled) {
    if (lead.status === 'demo_booked' && lead.demo_source === 'booking_email') {
      await db.query(`UPDATE leads SET status = 'interested', demo_at = NULL, demo_note = $2, updated_at = now() WHERE id = $1`, [lead.id, email.subject.slice(0, 300)]);
    }
    return { leadId: lead.id, cancelled: true };
  }
  if (['do_not_contact', 'archived', 'registered', 'activated'].includes(lead.status)) return { leadId: lead.id, ignored: lead.status };
  await db.query(
    `UPDATE leads SET status = 'demo_booked', status_set_by = 'auto', demo_source = 'booking_email', demo_note = $2, updated_at = now() WHERE id = $1`,
    [lead.id, email.subject.slice(0, 300)],
  );
  await cancelLeadTasks(db, lead.id, ['outreach.followup'], 'Demo booked');
  return { leadId: lead.id, booked: true };
}

/** You mark a demo booked (from your calendar). */
export async function markDemoBooked(db: Db, leadId: number, at: Date | null, note: string | null) {
  const { rows } = await db.query<LeadRow>(
    `UPDATE leads SET status = 'demo_booked', status_set_by = 'user', demo_at = $2, demo_note = $3, demo_source = 'user', updated_at = now()
     WHERE id = $1 AND status <> 'do_not_contact' RETURNING *`,
    [leadId, at, note],
  );
  if (!rows[0]) return null;
  await cancelLeadTasks(db, leadId, ['outreach.followup'], 'Demo booked');
  return rows[0];
}
