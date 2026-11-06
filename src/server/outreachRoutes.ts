import type { Express } from 'express';
import { z } from 'zod';
import { getSettings } from '../settings.js';
import { logger } from '../log.js';
import { CATEGORY_IDS } from '../discovery/catalog.js';
import {
  approveMessage, autoDraft, createDraft, editMessage, markSentByYou, regenerateDraft, rejectMessage, chatLinkFor, OutreachError,
  type MessageRow,
} from '../outreach/messages.js';
import { findSimilar, personalLine, spin, spinCount } from '../outreach/variety.js';
import { CHANNELS } from '../outreach/channels.js';
import { STARTER_VARIANTS } from '../outreach/seed.js';
import { draftOutreach } from '../ai/write.js';
import { aiConfigured } from '../ai/gemini.js';
import { addSuppression, liftSuppression } from '../outreach/suppressions.js';
import { createKb, listKb, searchKb, setKbStatus, updateKb } from '../outreach/kb.js';
import { buildVars, render, PLACEHOLDERS } from '../outreach/render.js';
import type { LeadRow } from '../leads/leads.js';
import { h, HttpError, idParam, notFound } from './http.js';
import { env } from '../config.js';
import { recordUsage } from '../usage.js';
import { afterApprove, sendingDelay } from '../outreach/sending.js';
import { apiSendability } from '../meta/send.js';
import { composeEmail, emailConfigProblems, fromDomain } from '../outreach/email/compose.js';
import { checkDomain, sendEmail } from '../outreach/email/resend.js';
import { lagosDayStart } from '../outreach/email/window.js';
import type { AppContext } from './app.js';

const log = logger('outreach');
const channel = z.enum(CHANNELS);
const step = z.enum(['intro', 'followup_1', 'followup_2']);

export function registerOutreachRoutes(app: Express, ctx: AppContext) {
  const { db } = ctx;

  // ── Messages / approval queue ────────────────────────────────────────────
  app.get('/api/messages', h(async (req, res) => {
    const q = z
      .object({
        status: z.enum(['draft', 'approved', 'rejected', 'cancelled', 'sending', 'sent', 'failed', 'received', 'dry_run']).optional(),
        channel: channel.optional(),
        leadId: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    if (q.status) where.push(`m.status = ${p(q.status)}`);
    if (q.channel) where.push(`m.channel = ${p(q.channel)}`);
    if (q.leadId) where.push(`m.lead_id = ${p(q.leadId)}`);
    const { rows } = await db.query<MessageRow & { business_name: string; category: string; score: number | null; lead_status: string }>(
      `SELECT m.*, coalesce(l.business_name, c.name, c.username, c.external_id) AS business_name, l.category, l.score, l.status AS lead_status,
         i.body AS in_reply_to_body, i.classification AS in_reply_to_label
       FROM messages m LEFT JOIN leads l ON l.id = m.lead_id LEFT JOIN social_contacts c ON c.id = m.social_contact_id
       LEFT JOIN messages i ON i.id = m.in_reply_to_id AND m.direction = 'outbound'
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${q.leadId ? 'm.created_at ASC' : 'm.updated_at DESC'} LIMIT ${p(q.limit)}`,
      params,
    );
    // Drafts that read almost the same as another message from the last 24 hours are flagged (you decide).
    const drafts = rows.filter((m) => m.status === 'draft' && m.direction === 'outbound');
    const recent = drafts.length
      ? (
          await db.query<{ id: number; subject: string | null; body: string; business_name: string; channel: string }>(
            `SELECT m.id, m.subject, m.body, m.channel, l.business_name FROM messages m JOIN leads l ON l.id = m.lead_id
             WHERE m.direction = 'outbound' AND m.step IS DISTINCT FROM 'reply' AND m.created_at > now() - interval '24 hours'
               AND m.status NOT IN ('rejected', 'cancelled') ORDER BY m.id DESC LIMIT 300`,
          )
        ).rows
      : [];
    const settings = await getSettings(db);
    const metaSend = new Map<number, Awaited<ReturnType<typeof apiSendability>>>();
    for (const m of rows) {
      if (m.step === 'reply' && m.social_contact_id && (m.status === 'draft' || m.status === 'approved')) metaSend.set(m.id, await apiSendability(db, m, settings));
    }
    res.json({
      data: rows.map((m) => ({
        ...m,
        chat_link: chatLinkFor(m),
        meta_send: metaSend.get(m.id) ?? null,
        similar: m.status === 'draft' && m.step !== 'reply' ? findSimilar(m, recent.filter((r) => r.channel === m.channel)) : null,
      })),
    });
  }));

  app.post('/api/leads/:id/drafts', h(async (req, res) => {
    const body = z.object({ channel, step: step.default('intro'), templateId: z.number().int().positive().optional() }).parse(req.body);
    // A template you picked is used as it is; otherwise the message is written by AI for this lead (template if AI is unavailable).
    const settings = await getSettings(db);
    const msg = body.templateId
      ? await createDraft(db, idParam(req), body.channel, settings, { step: body.step, createdBy: 'user', templateId: body.templateId })
      : await draftOutreach(db, idParam(req), body.channel, settings, { step: body.step, createdBy: 'user' });
    log.info(`Draft #${msg.id} (${msg.channel}) created for lead #${msg.lead_id}`);
    res.status(201).json(msg);
  }));

  /** Drafts introductions for the best qualified leads now (same rules and daily limit as the agent). */
  app.post('/api/messages/auto-draft', h(async (req, res) => {
    const { limit } = z.object({ limit: z.number().int().min(1).max(100).default(10) }).parse(req.body ?? {});
    const settings = await getSettings(db);
    if (settings.mode === 'research') throw new OutreachError('RESEARCH_MODE', 'Research Mode is on: no messages are drafted.');
    if (!settings.senderName) throw new OutreachError('NO_SENDER', 'Set your name under Settings → Sender and links before drafting.');
    const result = await autoDraft(db, settings, { limit });
    log.info(`Drafted ${result.created} message(s) on request`, { skipped: result.skipped });
    res.json(result);
  }));

  app.patch('/api/messages/:id', h(async (req, res) => {
    const patch = z.object({ subject: z.string().max(200).nullable().optional(), body: z.string().min(1).max(8000).optional() }).strict().parse(req.body);
    res.json(await editMessage(db, idParam(req), patch));
  }));

  app.post('/api/messages/:id/:action', h(async (req, res) => {
    const id = idParam(req);
    const settings = await getSettings(db);
    let msg: MessageRow;
    switch (req.params.action) {
      case 'approve':
        msg = await approveMessage(db, id, settings);
        if (await afterApprove(db, msg, settings)) ctx.agent.nudge();
        break;
      case 'requeue': {
        // A dry-run email, sent for real now that sending is live. Goes through all the same checks again.
        if (settings.emailSendingMode !== 'live') throw new OutreachError('DRY_RUN', 'Switch email sending to live first.');
        const { rows } = await db.query<MessageRow>(
          `UPDATE messages SET status = 'approved', approved_at = now(), approved_by = 'user', status_reason = NULL, updated_at = now()
           WHERE id = $1 AND status = 'dry_run' RETURNING *`,
          [id],
        );
        if (!rows[0]) throw new OutreachError('NOT_DRY_RUN', 'Only dry-run emails can be queued for a real send.');
        msg = rows[0];
        await afterApprove(db, msg, settings);
        ctx.agent.nudge();
        break;
      }
      case 'regenerate': {
        const current = (await db.query<MessageRow>('SELECT * FROM messages WHERE id = $1', [id])).rows[0];
        const writeAgain = current && current.lead_id && current.step !== 'reply' && current.status === 'draft' && !current.edited
          && (current.ai_generated || (settings.aiDraftIntros && aiConfigured()));
        if (writeAgain) {
          // Outreach is written again by AI (one more call, within your limits; the template if AI is unavailable).
          // The old draft is kept as rejected.
          await rejectMessage(db, id, 'Regenerated');
          msg = await draftOutreach(db, current.lead_id!, current.channel, settings, { step: current.step as 'intro', createdBy: current.created_by as 'agent' | 'user' });
        } else {
          msg = await regenerateDraft(db, id, settings);
        }
        break;
      }
      case 'reject':
        msg = await rejectMessage(db, id, z.object({ reason: z.string().max(500).nullish() }).parse(req.body ?? {}).reason ?? null);
        break;
      case 'mark-sent':
        msg = await markSentByYou(db, id, settings);
        break;
      default:
        throw notFound('Action');
    }
    log.info(`Message #${id} ${req.params.action === 'mark-sent' ? 'recorded as sent by you' : req.params.action === 'requeue' ? 'queued for a real send' : `${req.params.action}d`}`);
    res.json({ ...msg, chat_link: chatLinkFor(msg) });
  }));

  // ── Email sending ────────────────────────────────────────────────────────
  app.get('/api/email/status', h(async (_req, res) => {
    const settings = await getSettings(db);
    const [queued, today, delay] = await Promise.all([
      db.query<{ approved: number; sending: number }>(
        `SELECT count(*) FILTER (WHERE status = 'approved')::int AS approved, count(*) FILTER (WHERE status = 'sending')::int AS sending
         FROM messages WHERE channel = 'email' AND direction = 'outbound'`,
      ),
      db.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE sent_by = 'provider' AND sent_at >= $1`, [lagosDayStart(new Date())]),
      sendingDelay(db, settings),
    ]);
    res.json({
      mode: settings.emailSendingMode,
      from: env.OUTREACH_FROM_ADDRESS || null,
      fromDomain: fromDomain() || null,
      replyTo: env.OUTREACH_REPLY_TO || null,
      apiKeySet: !!env.RESEND_API_KEY,
      problems: emailConfigProblems(settings),
      sentToday: today.rows[0]!.n,
      dailyLimit: settings.dailyEmailLimit,
      queued: queued.rows[0],
      nextSend: delay ? delay.why : 'Now',
    });
  }));

  app.post('/api/email/check-domain', h(async (_req, res) => {
    if (!env.RESEND_API_KEY) throw new HttpError(422, 'NOT_CONFIGURED', 'Add RESEND_API_KEY to .env first.');
    if (!fromDomain()) throw new HttpError(422, 'NOT_CONFIGURED', 'Add OUTREACH_FROM_ADDRESS to .env first.');
    const result = await checkDomain(fromDomain());
    await recordUsage(db, 'resend', 'domain_check');
    res.json(result);
  }));

  /** Sends one real test email to your own reply-to mailbox. Only ever on your click. */
  app.post('/api/email/test', h(async (_req, res) => {
    const settings = await getSettings(db);
    const problems = emailConfigProblems(settings);
    if (problems.length) throw new HttpError(422, 'NOT_CONFIGURED', problems.map((p) => p.message).join(' '));
    const email = composeEmail(
      {
        id: 0,
        lead_id: 0,
        step: 'test',
        to_address: env.OUTREACH_REPLY_TO,
        subject: 'StockỌja Sales Agent: test email',
        body: `This is a test from your local sales agent.\n\nIt was sent from ${env.OUTREACH_FROM_ADDRESS} through Resend. Reply to it to check that replies reach ${env.OUTREACH_REPLY_TO}.\n\nNo merchant received this. Reply STOP is how merchants opt out.`,
      },
      settings,
    );
    const { id } = await sendEmail({ ...email, tags: [{ name: 'source', value: 'sales_agent_test' }], idempotencyKey: `stockoja-sales-test-${Date.now()}` });
    await recordUsage(db, 'resend', 'test_email');
    log.info(`Test email sent to your reply-to mailbox (Resend id ${id})`);
    res.json({ ok: true, to: env.OUTREACH_REPLY_TO, id });
  }));

  // ── Templates ────────────────────────────────────────────────────────────
  const templateSchema = z.object({
    name: z.string().trim().min(1).max(120),
    channel,
    step,
    category: z.enum(CATEGORY_IDS as [string, ...string[]]).nullable(),
    subject: z.string().max(200).nullable(),
    body: z.string().min(1).max(8000),
    active: z.boolean().default(true),
  });
  const checkTemplate = (t: { channel: string; step?: string; subject: string | null; body: string }) => {
    const used = [...`${t.subject ?? ''} ${t.body}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]!);
    const unknown = [...new Set(used.filter((u) => !(u in PLACEHOLDERS)))];
    if (unknown.length) throw new HttpError(422, 'VALIDATION', `Unknown placeholder(s): ${unknown.join(', ')}`);
    if (t.channel === 'email' && !t.subject?.trim()) throw new HttpError(422, 'VALIDATION', 'Email templates need a subject.');
    if (t.step === 'intro' && !/\bSTOP\b/.test(t.body)) throw new HttpError(422, 'VALIDATION', 'Introduction templates need an opt-out line containing STOP.');
  };

  app.get('/api/templates', h(async (_req, res) => {
    const { rows } = await db.query<{ subject: string | null; body: string }>('SELECT * FROM templates ORDER BY channel, step, category NULLS FIRST, id');
    res.json({ data: rows.map((t) => ({ ...t, versions: spinCount(`${t.subject ?? ''} ${t.body}`) })), placeholders: PLACEHOLDERS });
  }));
  /** Adds the starter variants that aren't there yet, switched off, for you to read and switch on. */
  app.post('/api/templates/starter-variants', h(async (_req, res) => {
    let added = 0;
    for (const t of STARTER_VARIANTS) {
      const { rowCount } = await db.query(
        `INSERT INTO templates (name, channel, step, category, subject, body, active)
         SELECT $1, $2, $3, $4, $5, $6, false WHERE NOT EXISTS (SELECT 1 FROM templates WHERE name = $1)`,
        [t.name, t.channel, t.step, t.category, t.subject, t.body],
      );
      added += rowCount ?? 0;
    }
    log.info(`Added ${added} starter template variant(s), switched off for review`);
    res.json({ added });
  }));
  app.post('/api/templates', h(async (req, res) => {
    const t = templateSchema.parse(req.body);
    checkTemplate(t);
    const { rows } = await db.query(
      'INSERT INTO templates (name, channel, step, category, subject, body, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [t.name, t.channel, t.step, t.category, t.channel === 'email' ? t.subject : null, t.body, t.active],
    );
    res.status(201).json(rows[0]);
  }));
  app.put('/api/templates/:id', h(async (req, res) => {
    const t = templateSchema.parse(req.body);
    checkTemplate(t);
    const { rows } = await db.query(
      `UPDATE templates SET name=$2, channel=$3, step=$4, category=$5, subject=$6, body=$7, active=$8, updated_at=now() WHERE id=$1 RETURNING *`,
      [idParam(req), t.name, t.channel, t.step, t.category, t.channel === 'email' ? t.subject : null, t.body, t.active],
    );
    if (!rows[0]) throw notFound('Template');
    res.json(rows[0]);
  }));
  /** Shows a template filled in for a real lead, without saving anything. */
  app.post('/api/templates/preview', h(async (req, res) => {
    const b = z.object({ subject: z.string().nullable(), body: z.string(), channel, step, leadId: z.number().int().positive().optional() }).parse(req.body);
    const lead = b.leadId
      ? (await db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [b.leadId])).rows[0]
      : (await db.query<LeadRow>(`SELECT * FROM leads ORDER BY (status = 'qualified') DESC, score DESC NULLS LAST LIMIT 1`)).rows[0];
    if (!lead) throw new HttpError(422, 'NO_LEADS', 'Add or discover a lead first to preview with real details.');
    const vars = buildVars(lead, await getSettings(db), b.channel, b.step, { previous_subject: '(subject of your first email)', personal_line: personalLine(lead) });
    const body = render(spin(b.body), vars);
    const subject = b.subject ? render(spin(b.subject), vars) : null;
    res.json({
      lead: { id: lead.id, business_name: lead.business_name },
      subject: subject?.text ?? null,
      body: body.text,
      missing: [...new Set([...body.missing, ...(subject?.missing ?? [])])],
      versions: spinCount(`${b.subject ?? ''} ${b.body}`),
    });
  }));

  // ── Knowledge base ───────────────────────────────────────────────────────
  const kbSchema = z.object({ topic: z.string().trim().min(1).max(80), question: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(3000) });
  app.get('/api/kb', h(async (_req, res) => res.json({ data: await listKb(db) })));
  app.get('/api/kb/search', h(async (req, res) => {
    const q = z.string().trim().min(1).max(300).parse(req.query.q);
    res.json({ data: await searchKb(db, q) });
  }));
  app.post('/api/kb', h(async (req, res) => res.status(201).json(await createKb(db, kbSchema.parse(req.body)))));
  app.put('/api/kb/:id', h(async (req, res) => {
    const entry = await updateKb(db, idParam(req), kbSchema.partial().parse(req.body));
    if (!entry) throw notFound('Entry');
    res.json(entry);
  }));
  app.post('/api/kb/:id/:action', h(async (req, res) => {
    const status = ({ approve: 'approved', retire: 'retired', unapprove: 'draft' } as const)[req.params.action as 'approve'];
    if (!status) throw notFound('Action');
    const entry = await setKbStatus(db, idParam(req), status);
    if (!entry) throw notFound('Entry');
    log.info(`Knowledge base entry #${entry.id} ${status}`);
    res.json(entry);
  }));

  // ── Do-not-contact list ──────────────────────────────────────────────────
  app.get('/api/suppressions', h(async (req, res) => {
    const showLifted = req.query.lifted === '1';
    const { rows } = await db.query(
      `SELECT s.*, l.business_name FROM suppressions s LEFT JOIN leads l ON l.id = s.lead_id
       ${showLifted ? '' : 'WHERE s.lifted_at IS NULL'} ORDER BY s.created_at DESC LIMIT 1000`,
    );
    res.json({ data: rows });
  }));
  app.post('/api/suppressions', h(async (req, res) => {
    const b = z.object({ kind: z.enum(['email', 'phone', 'domain', 'handle']), value: z.string().trim().min(3).max(200), reason: z.string().max(300).nullish() }).parse(req.body);
    const result = await addSuppression(db, b.kind, b.value, { reason: b.reason ?? null, source: 'user' });
    if ('error' in result) throw new HttpError(422, 'VALIDATION', result.error);
    // Stop anything already drafted or approved for that address.
    const col = {
      email: 'lower(l.email) = $1',
      phone: 'l.phone_key = $1',
      domain: `(l.website_domain = $1 OR split_part(lower(l.email), '@', 2) = $1)`,
      handle: `(m.channel || ':' || m.to_address) = $1`,
    }[b.kind];
    const { rowCount } = await db.query(
      `UPDATE messages m SET status = 'cancelled', status_reason = 'Address added to the do-not-contact list', updated_at = now()
       FROM leads l WHERE l.id = m.lead_id AND m.status IN ('draft', 'approved') AND ${col}`,
      [result.value],
    );
    log.info(`Added ${b.kind} to the do-not-contact list; ${rowCount ?? 0} open message(s) cancelled`);
    res.status(201).json({ ...result, cancelledMessages: rowCount ?? 0 });
  }));
  app.post('/api/suppressions/:id/lift', h(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    if (!(await liftSuppression(db, idParam(req), reason))) throw notFound('Active entry');
    log.warn(`Do-not-contact entry #${req.params.id} lifted by you: ${reason}`);
    res.json({ ok: true });
  }));
}
