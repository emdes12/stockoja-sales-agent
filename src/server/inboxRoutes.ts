import type { Express } from 'express';
import { z } from 'zod';
import { CHANNELS, socialHandle, isSocial, type Channel } from '../outreach/channels.js';
import { env } from '../config.js';
import { tx } from '../db/pool.js';
import { getSettings, getState } from '../settings.js';
import { logger } from '../log.js';
import { enqueue } from '../queue/queue.js';
import { LABELS } from '../inbox/classify.js';
import { imapConfigProblems } from '../inbox/mailbox.js';
import { emailFolders, TASK_CHECK_INBOX, testMailbox } from '../inbox/inbox.js';
import { applyLabel, autoAnswer, draftReply, markDemoBooked, recordReply, relabel, type InboundRow } from '../inbox/process.js';
import { getContact, linkContact, replyAddress, upsertContact } from '../inbox/contacts.js';
import type { LeadRow } from '../leads/leads.js';
import { approveMessage, assertContactable, chatLinkFor, editMessage, type MessageRow } from '../outreach/messages.js';
import { afterApprove } from '../outreach/sending.js';
import { maybeAutoApprove } from '../outreach/autonomy.js';
import { phoneKey } from '../leads/normalize.js';
import { upsertLead } from '../leads/leads.js';
import { manualToCandidate } from '../discovery/csvImport.js';
import { TASK_CHECK_TELEGRAM } from '../telegram/inbox.js';
import { telegramConfigProblems, testTelegram } from '../telegram/bot.js';
import { h, HttpError, idParam, notFound } from './http.js';
import type { AppContext } from './app.js';

const log = logger('inbox');

const OPT_OUT = "If you'd rather I didn't contact you again, just reply STOP.";

export function registerInboxRoutes(app: Express, ctx: AppContext) {
  const { db, agent } = ctx;

  /**
   * Every message people sent you, newest first: one channel or all, and "needs attention", "everything" or only
   * people who aren't leads yet. Each row says who wrote (lead or contact) and where your answer stands.
   */
  app.get('/api/inbox', h(async (req, res) => {
    const q = z.object({
      view: z.enum(['attention', 'all', 'unread', 'not_lead', 'unmatched']).default('attention'),
      channel: z.enum(['all', ...CHANNELS]).default('all'),
      q: z.string().trim().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));
    const where = [`m.direction = 'inbound'`];
    const params: unknown[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    if (q.view === 'attention') where.push('m.needs_attention AND m.handled_at IS NULL');
    if (q.view === 'unread') where.push('m.read_at IS NULL');
    if (q.view === 'not_lead' || q.view === 'unmatched') where.push('m.lead_id IS NULL AND c.ignored_at IS NULL');
    if (q.channel !== 'all') where.push(`m.channel = ${p(q.channel)}`);
    if (q.q) {
      const like = p(`%${q.q.toLowerCase()}%`);
      where.push(`(lower(m.body) LIKE ${like} OR lower(coalesce(m.subject, '')) LIKE ${like} OR lower(coalesce(l.business_name, c.name, c.username, c.external_id, m.from_address, '')) LIKE ${like})`);
    }
    const { rows } = await db.query(
      `SELECT m.*, l.business_name, l.status AS lead_status, r.id AS reply_id, r.status AS reply_status,
              c.name AS contact_name, c.username AS contact_username, c.external_id AS contact_external_id, c.ignored_at AS contact_ignored_at
       FROM messages m LEFT JOIN leads l ON l.id = m.lead_id LEFT JOIN social_contacts c ON c.id = m.social_contact_id
       LEFT JOIN LATERAL (SELECT id, status FROM messages o WHERE o.in_reply_to_id = m.id AND o.direction = 'outbound'
                          ORDER BY (o.status IN ('rejected', 'cancelled', 'failed')), o.id DESC LIMIT 1) r ON true
       WHERE ${where.join(' AND ')}
       ORDER BY m.received_at DESC NULLS LAST, m.id DESC LIMIT ${p(q.limit)}`,
      params,
    );
    res.json({ data: rows });
  }));

  /** Per channel: not opened yet, waiting for your answer, from people who aren't leads, and in total. */
  app.get('/api/inbox/counts', h(async (_req, res) => {
    const { rows } = await db.query<{ channel: Channel; unread: number; attention: number; not_lead: number; total: number }>(
      `SELECT m.channel,
              count(*) FILTER (WHERE m.read_at IS NULL)::int AS unread,
              count(*) FILTER (WHERE m.needs_attention AND m.handled_at IS NULL)::int AS attention,
              count(*) FILTER (WHERE m.lead_id IS NULL AND c.ignored_at IS NULL)::int AS not_lead,
              count(*)::int AS total
       FROM messages m LEFT JOIN social_contacts c ON c.id = m.social_contact_id
       WHERE m.direction = 'inbound' GROUP BY m.channel`,
    );
    res.json({ channels: Object.fromEntries(rows.map((r) => [r.channel, r])) });
  }));

  /** The whole conversation a message belongs to (this lead or contact, on this channel), oldest first. */
  app.get('/api/inbox/:id/thread', h(async (req, res) => {
    const m = (await db.query<MessageRow>(`SELECT * FROM messages WHERE id = $1`, [idParam(req)])).rows[0];
    if (!m) throw notFound('Message');
    const { rows } = await db.query(
      m.lead_id
        ? `SELECT * FROM messages WHERE lead_id = $1 AND channel = $2 AND status NOT IN ('rejected', 'cancelled') ORDER BY coalesce(received_at, sent_at, created_at), id LIMIT 200`
        : `SELECT * FROM messages WHERE social_contact_id = $1 AND channel = $2 AND status NOT IN ('rejected', 'cancelled') ORDER BY coalesce(received_at, sent_at, created_at), id LIMIT 200`,
      [m.lead_id ?? m.social_contact_id, m.channel],
    );
    res.json({ data: rows });
  }));

  app.get('/api/inbox/status', h(async (_req, res) => {
    const settings = await getSettings(db);
    res.json({
      problems: imapConfigProblems(),
      enabled: settings.readReplies,
      host: env.IMAP_HOST || null,
      user: env.IMAP_USER || null,
      mailbox: env.IMAP_MAILBOX,
      folders: emailFolders(settings),
      readAll: settings.emailReadAll,
      replyTo: env.OUTREACH_REPLY_TO || null,
      lastCheck: (await getState(db, 'inbox.lastCheck')) ?? null,
      telegram: {
        problems: telegramConfigProblems(),
        lastCheck: (await getState(db, 'telegram.lastCheck')) ?? null,
      },
    });
  }));

  /** Connects read-only and counts messages. Only on your click. */
  app.post('/api/inbox/test', h(async (_req, res) => {
    const r = await testMailbox();
    log.info(r.ok ? `Mailbox test: connected to ${env.IMAP_HOST}, ${r.messages} message(s) in ${env.IMAP_MAILBOX}` : `Mailbox test failed: ${r.error}`);
    res.json(r);
  }));

  app.post('/api/inbox/check', h(async (_req, res) => {
    const settings = await getSettings(db);
    if (!settings.readReplies) throw new HttpError(422, 'OFF', 'Turn on reading the mailbox in Settings first.');
    if (!settings.inboxAccess.email) throw new HttpError(422, 'OFF', 'Email is switched off under Inbox access in Settings.');
    const problems = imapConfigProblems();
    if (problems.length) throw new HttpError(422, 'NOT_CONFIGURED', problems.map((p) => p.message).join(' '));
    const task = await enqueue(db, TASK_CHECK_INBOX, { manual: true }, { idempotencyKey: `${TASK_CHECK_INBOX}:manual:${Math.floor(Date.now() / 10_000)}`, maxAttempts: 1 });
    agent.nudge();
    res.status(202).json({ queued: !!task, agentRunning: agent.state === 'running' });
  }));

  /** Telegram: proves the bot token works (only on your click), and checks for messages now. */
  app.post('/api/telegram/test', h(async (_req, res) => {
    const r = await testTelegram();
    log.info(r.ok ? `Telegram test: connected as @${r.username}` : `Telegram test failed: ${r.error}`);
    res.json(r);
  }));
  app.post('/api/telegram/check-now', h(async (_req, res) => {
    const settings = await getSettings(db);
    if (!settings.inboxAccess.telegram) throw new HttpError(422, 'OFF', 'Telegram is switched off under Inbox access in Settings.');
    const problems = telegramConfigProblems();
    if (problems.length) throw new HttpError(422, 'NOT_CONFIGURED', problems.join(' '));
    const task = await enqueue(db, TASK_CHECK_TELEGRAM, { manual: true }, { idempotencyKey: `${TASK_CHECK_TELEGRAM}:manual:${Math.floor(Date.now() / 10_000)}`, maxAttempts: 1 });
    agent.nudge();
    res.status(202).json({ queued: !!task, agentRunning: agent.state === 'running' });
  }));

  /**
   * Opening a conversation marks every message in it read (this person, this channel). "read: false" marks the
   * message unread again, like "Mark as unread" in a mail app.
   */
  app.post('/api/inbox/:id/read', h(async (req, res) => {
    const { read } = z.object({ read: z.boolean().default(true) }).strict().parse(req.body ?? {});
    const m = (await db.query<MessageRow>(`SELECT * FROM messages WHERE id = $1 AND direction = 'inbound'`, [idParam(req)])).rows[0];
    if (!m) throw notFound('Message');
    if (!read) {
      await db.query(`UPDATE messages SET read_at = NULL WHERE id = $1`, [m.id]);
      return res.json({ changed: 1 });
    }
    const { rowCount } = await db.query(
      m.lead_id
        ? `UPDATE messages SET read_at = now() WHERE lead_id = $1 AND channel = $2 AND direction = 'inbound' AND read_at IS NULL`
        : `UPDATE messages SET read_at = now() WHERE social_contact_id = $1 AND channel = $2 AND direction = 'inbound' AND read_at IS NULL`,
      [m.lead_id ?? m.social_contact_id, m.channel],
    );
    res.json({ changed: rowCount ?? 0 });
  }));

  app.patch('/api/inbox/:id', h(async (req, res) => {
    const { classification } = z.object({ classification: z.enum(LABELS) }).strict().parse(req.body);
    const msg = await relabel(db, idParam(req), classification);
    log.info(`Message #${msg.id} relabelled ${classification} by you`);
    res.json(msg);
  }));

  app.post('/api/inbox/:id/draft-reply', h(async (req, res) => {
    const { mode } = z.object({ mode: z.enum(['kb', 'blank', 'ai']).default('kb') }).parse(req.body ?? {});
    const r = await draftReply(db, idParam(req), await getSettings(db), mode, 'user');
    if ('skipped' in r) throw new HttpError(422, r.skipped, r.message);
    res.status(201).json(r.drafted);
  }));

  /**
   * Your own answer, written in the inbox. "send" approves it at once: the agent sends it where it can (email; Instagram
   * and Facebook inside Meta's 24 hours when Meta replies are live; Telegram through your bot); otherwise you get the
   * chat link to send it yourself. Without "send" it waits in the approval queue. The opt-out line is added only when you tick it.
   */
  app.post('/api/inbox/:id/reply', h(async (req, res) => {
    const body = z.object({
      body: z.string().trim().min(1).max(8000),
      subject: z.string().trim().max(300).optional(),
      send: z.boolean().default(false),
      /** Add the "reply STOP" line: only when you tick it. */
      optOut: z.boolean().default(false),
    }).strict().parse(req.body);
    const inboundId = idParam(req);
    const settings = await getSettings(db);
    const text = body.optOut && !/\bSTOP\b/.test(body.body) ? `${body.body}\n\n${OPT_OUT}` : body.body;
    // Reuse a waiting draft answer (yours or the agent's) instead of creating a second one.
    const waiting = (await db.query<MessageRow>(
      `SELECT * FROM messages WHERE in_reply_to_id = $1 AND direction = 'outbound' AND status IN ('draft', 'approved') ORDER BY id DESC LIMIT 1`, [inboundId],
    )).rows[0];
    let draft: MessageRow;
    if (waiting) {
      draft = await editMessage(db, waiting.id, { body: text, ...(body.subject !== undefined && waiting.channel === 'email' ? { subject: body.subject } : {}) });
    } else {
      const r = await draftReply(db, inboundId, settings, 'blank', 'user');
      if ('skipped' in r) throw new HttpError(422, r.skipped, r.message);
      draft = (await db.query<MessageRow>(
        `UPDATE messages SET body = $2, original_body = $2, subject = coalesce($3, subject), edited = true, updated_at = now() WHERE id = $1 RETURNING *`,
        [r.drafted.id, text, r.drafted.channel === 'email' ? body.subject ?? null : null],
      )).rows[0]!;
    }
    await db.query(`UPDATE messages SET needs_attention = false, handled_at = coalesce(handled_at, now()) WHERE id = $1`, [inboundId]);
    if (!body.send) return res.status(201).json({ message: draft, sent: false });
    const approved = await approveMessage(db, draft.id, settings, 'user');
    const queued = await afterApprove(db, approved, settings);
    agent.nudge();
    log.info(`Answer #${approved.id} (${approved.channel}) approved by you${queued ? ' and queued to send' : '; you send it'}`);
    res.status(201).json({ message: approved, sent: !!queued, chatLink: queued ? null : chatLinkFor(approved) });
  }));

  app.post('/api/inbox/:id/handled', h(async (req, res) => {
    const { rowCount } = await db.query(
      `UPDATE messages SET handled_at = now(), needs_attention = false WHERE id = $1 AND direction = 'inbound'`,
      [idParam(req)],
    );
    if (!rowCount) throw notFound('Message');
    res.status(204).end();
  }));

  // ── People who aren't leads (contacts) ──

  /** After a contact is tied to a lead: the newest message's label moves the lead on, and an answer is drafted. */
  async function afterLink(contactId: number, leadId: number) {
    const r = await linkContact(db, contactId, leadId);
    if (!r?.newestInboundId) return r;
    const newest = (await db.query<InboundRow>('SELECT * FROM messages WHERE id = $1', [r.newestInboundId])).rows[0]!;
    await tx(db, (client) => applyLabel(client, newest, newest.classification ?? 'other'));
    const answered = await db.query(`SELECT 1 FROM messages WHERE in_reply_to_id = $1 AND direction = 'outbound' AND status NOT IN ('rejected', 'cancelled', 'failed')`, [newest.id]);
    if (!answered.rowCount) await autoAnswer(db, (await db.query<InboundRow>('SELECT * FROM messages WHERE id = $1', [newest.id])).rows[0]!, await getSettings(db));
    return r;
  }

  async function openContact(id: number) {
    const c = await getContact(db, id);
    if (!c) throw notFound('Contact');
    return c;
  }

  /** Someone you recognise: their messages (now and later) belong to this lead. */
  app.post('/api/inbox/contacts/:id/link', h(async (req, res) => {
    const { leadId } = z.object({ leadId: z.number().int().positive() }).strict().parse(req.body);
    const c = await openContact(idParam(req));
    if (!(await db.query('SELECT 1 FROM leads WHERE id = $1', [leadId])).rowCount) throw notFound('Lead');
    const r = await afterLink(c.id, leadId);
    log.info(`${c.platform} contact #${c.id} linked to lead #${leadId} (${r?.moved ?? 0} message(s))`);
    res.json({ leadId, moved: r?.moved ?? 0 });
  }));

  /** Someone new wrote to you: add them as a lead, then link their messages. */
  app.post('/api/inbox/contacts/:id/new-lead', h(async (req, res) => {
    const body = z.object({
      business_name: z.string().trim().min(1).max(200),
      category: z.string().trim().min(1).max(60),
      city: z.string().trim().max(100).nullish(),
      state: z.string().trim().max(100).nullish(),
    }).strict().parse(req.body);
    const c = await openContact(idParam(req));
    const handle = c.username ? (c.platform === 'linkedin' ? `https://www.linkedin.com/${c.username}/` : `@${c.username}`) : null;
    const candidate = manualToCandidate(
      {
        ...body,
        email: c.platform === 'email' ? c.external_id : null,
        phone: c.platform === 'whatsapp' ? c.external_id : null,
        ...(isSocial(c.platform) && handle ? { [c.platform]: handle } : {}),
        notes: `Wrote to you first on ${c.platform}.`,
      },
      'manual',
    );
    if ('error' in candidate) throw new HttpError(422, 'VALIDATION', candidate.error);
    const settings = await getSettings(db);
    const { leadId, outcome } = await upsertLead(db, candidate, settings.qualifyThreshold);
    const r = await afterLink(c.id, leadId);
    log.info(`Lead #${leadId} ${outcome} from a ${c.platform} contact (${r?.moved ?? 0} message(s) linked)`);
    res.status(outcome === 'created' ? 201 : 200).json({ leadId, outcome, moved: r?.moved ?? 0 });
  }));

  /** Not someone to answer (spam, personal, a supplier): kept out of "Needs attention", no drafts. Reversible. */
  app.post('/api/inbox/contacts/:id/ignore', h(async (req, res) => {
    const { ignore } = z.object({ ignore: z.boolean().default(true) }).strict().parse(req.body ?? {});
    const c = await openContact(idParam(req));
    await db.query(`UPDATE social_contacts SET ignored_at = ${ignore ? 'now()' : 'NULL'}, updated_at = now() WHERE id = $1`, [c.id]);
    if (ignore) {
      await db.query(`UPDATE messages SET needs_attention = false, handled_at = coalesce(handled_at, now()) WHERE social_contact_id = $1 AND direction = 'inbound'`, [c.id]);
      // Drafts the agent wrote that nobody will send.
      await db.query(`UPDATE messages SET status = 'cancelled', status_reason = 'You ignored this contact', updated_at = now()
                      WHERE social_contact_id = $1 AND direction = 'outbound' AND status IN ('draft', 'approved') AND created_by = 'agent'`, [c.id]);
    }
    res.status(204).end();
  }));

  /**
   * Who someone is, from what you typed: a number (WhatsApp), an email address, or a profile/username. They become
   * a contact (or the one they already are), tied to the lead with that number, email or profile when there is one.
   */
  async function resolvePerson(channel: Channel, from: string, name: string | null, at: Date | null = null) {
    let externalId: string;
    let username: string | null = null;
    if (channel === 'whatsapp') {
      const key = phoneKey(from);
      if (!key) throw new HttpError(422, 'VALIDATION', 'Type their WhatsApp number (e.g. 0803 123 4567).');
      externalId = key;
    } else if (channel === 'email') {
      const e = from.toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)) throw new HttpError(422, 'VALIDATION', 'Type their email address.');
      externalId = e;
    } else {
      username = socialHandle(channel, from);
      // Telegram: someone who wrote to your bot is known by their chat, so find them by username first.
      const known = username
        ? (await db.query<{ id: number }>(`SELECT id FROM social_contacts WHERE platform = $1 AND lower(username) = $2 ORDER BY last_inbound_at DESC NULLS LAST LIMIT 1`, [channel, username])).rows[0]
        : undefined;
      if (known) {
        const c = (await getContact(db, known.id))!;
        return { contact: c, username };
      }
      externalId = username ?? `paste:${from.toLowerCase().replace(/\s+/g, ' ')}`;
    }
    let contact = await upsertContact(db, channel, externalId, { username, name: name ?? (username ? null : from), at });
    if (!contact.lead_id) {
      const match = channel === 'whatsapp'
        ? (await db.query<{ id: number }>('SELECT id FROM leads WHERE phone_key = $1 ORDER BY id LIMIT 1', [externalId])).rows[0]
        : channel === 'email'
          ? (await db.query<{ id: number }>('SELECT id FROM leads WHERE lower(email) = $1 ORDER BY id LIMIT 1', [externalId])).rows[0]
          : username
            ? (await db.query<{ id: number; v: string }>(`SELECT id, socials->>$1 AS v FROM leads WHERE socials ? $1`, [channel])).rows
                .find((r) => socialHandle(channel, r.v) === username)
            : undefined;
      if (match) {
        await linkContact(db, contact.id, match.id);
        contact = (await getContact(db, contact.id))!;
      }
    }
    return { contact, username };
  }

  /**
   * A new message you write in the Inbox, on any channel: to a lead, to someone who wrote to you, or to an address
   * you type. "send" approves it at once: the agent sends it where it can (email; Telegram to people who wrote to
   * your bot; Instagram and Facebook inside Meta's 24 hours when Meta replies are live); otherwise you get the chat
   * link to send it yourself. Without "send" it waits in the approval queue. The opt-out line is added only when you tick it.
   */
  app.post('/api/inbox/compose', h(async (req, res) => {
    const body = z.object({
      channel: z.enum(CHANNELS),
      leadId: z.number().int().positive().nullish(),
      contactId: z.number().int().positive().nullish(),
      to: z.string().trim().min(1).max(300).nullish(),
      subject: z.string().trim().max(300).optional(),
      body: z.string().trim().min(1).max(8000),
      send: z.boolean().default(false),
      /** Add the "reply STOP" line: only when you tick it. */
      optOut: z.boolean().default(false),
    }).strict().parse(req.body);
    const settings = await getSettings(db);
    if (!settings.senderName) throw new HttpError(422, 'NO_SENDER', 'Set your name under Settings → Sender and links first.');
    if (body.channel === 'email' && !body.subject) throw new HttpError(422, 'VALIDATION', 'An email needs a subject.');

    let contact = body.contactId ? await openContact(body.contactId) : null;
    if (!contact && !body.leadId && body.to) contact = (await resolvePerson(body.channel, body.to, null)).contact;
    if (contact && contact.platform !== body.channel) throw new HttpError(422, 'VALIDATION', `That person wrote on ${contact.platform}, not ${body.channel}.`);
    const leadId = body.leadId ?? contact?.lead_id ?? null;
    if (!leadId && !contact) throw new HttpError(422, 'VALIDATION', 'Choose a lead, or type who to send it to.');
    const lead = leadId ? (await db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0] : null;
    if (leadId && !lead) throw notFound('Lead');

    const to = await assertContactable(db, lead ?? null, body.channel, settings, contact ? replyAddress(contact) : null);
    const text = body.optOut && !/\bSTOP\b/.test(body.body) ? `${body.body}\n\n${OPT_OUT}` : body.body;
    const draft = (await db.query<MessageRow>(
      `INSERT INTO messages (lead_id, channel, step, to_address, subject, body, original_body, status, created_by, social_contact_id)
       VALUES ($1, $2, 'message', $3, $4, $5, $5, 'draft', 'user', $6) RETURNING *`,
      [lead?.id ?? null, body.channel, to, body.channel === 'email' ? body.subject : null, text, contact?.id ?? null],
    )).rows[0]!;
    if (!body.send) return res.status(201).json({ message: draft, sent: false });
    const approved = await approveMessage(db, draft.id, settings, 'user');
    const queued = await afterApprove(db, approved, settings);
    agent.nudge();
    log.info(`Message #${approved.id} (${approved.channel}) written and approved by you${queued ? ' and queued to send' : '; you send it'}`);
    res.status(201).json({ message: approved, sent: !!queued, chatLink: queued ? null : chatLinkFor(approved) });
  }));

  /**
   * A message you received somewhere the agent can't read (TikTok, LinkedIn, WhatsApp, or any other chat): paste it
   * in and it is labelled and answered like the rest. You send the answer yourself.
   */
  app.post('/api/inbox/paste', h(async (req, res) => {
    const body = z.object({
      channel: z.enum(CHANNELS),
      from: z.string().trim().min(1).max(300),
      name: z.string().trim().max(120).nullish(),
      text: z.string().trim().min(1).max(5000),
      leadId: z.number().int().positive().nullish(),
    }).strict().parse(req.body);
    const settings = await getSettings(db);
    if (!settings.inboxAccess[body.channel]) throw new HttpError(422, 'OFF', `${body.channel} is switched off under Inbox access in Settings.`);
    if (body.leadId && !(await db.query('SELECT 1 FROM leads WHERE id = $1', [body.leadId])).rowCount) throw notFound('Lead');

    const { contact, username } = await resolvePerson(body.channel, body.from, body.name ?? null, new Date());
    const leadId = body.leadId ?? contact.lead_id;
    if (leadId && contact.lead_id !== leadId) await linkContact(db, contact.id, leadId);
    const recorded = (await recordReply(db, leadId, {
      channel: body.channel, from: username ? `@${username}` : body.from, subject: '', text: body.text, date: null, messageId: null,
      source: 'paste', socialContactId: contact.id,
    }))!;
    const answer = await autoAnswer(db, recorded.msg, settings);
    if (answer && 'drafted' in answer) await maybeAutoApprove(db, answer.drafted.id, settings);
    log.info(`${body.channel} message pasted by you${leadId ? ` for lead #${leadId}` : ''}: ${recorded.classification.label}`);
    res.status(201).json({ message: recorded.msg, classification: recorded.classification, answer });
  }));

  /** A reply you received elsewhere (WhatsApp, a call, another inbox): recorded and handled like an email reply. */
  app.post('/api/leads/:id/replies', h(async (req, res) => {
    const body = z
      .object({ channel: z.enum(CHANNELS), text: z.string().trim().min(1).max(5000), subject: z.string().trim().max(300).optional() })
      .strict()
      .parse(req.body);
    const leadId = idParam(req);
    const lead = (await db.query('SELECT id FROM leads WHERE id = $1', [leadId])).rows[0];
    if (!lead) throw notFound('Lead');
    const recorded = (await recordReply(db, leadId, {
      channel: body.channel, from: null, subject: body.subject ?? '', text: body.text, date: null, messageId: null, source: 'manual',
    }))!;
    const answer = await autoAnswer(db, recorded.msg, await getSettings(db));
    log.info(`Reply logged by you for lead #${leadId}: ${recorded.classification.label}`);
    res.status(201).json({ message: recorded.msg, classification: recorded.classification, answer });
  }));

  app.post('/api/leads/:id/demo', h(async (req, res) => {
    const body = z
      .object({ at: z.string().datetime({ offset: true }).nullable().optional(), note: z.string().trim().max(500).nullable().optional() })
      .strict()
      .parse(req.body);
    const lead = await markDemoBooked(db, idParam(req), body.at ? new Date(body.at) : null, body.note || null);
    if (!lead) throw new HttpError(409, 'LEAD_CLOSED', 'Lead not found, or it is on the do-not-contact list.');
    log.info(`Demo booked for lead #${lead.id} (set by you)`);
    res.json(lead);
  }));
}
