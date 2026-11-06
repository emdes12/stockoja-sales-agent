import express, { type NextFunction, type Request, type Response } from 'express';
import { h, HttpError, idParam, notFound } from './http.js';
import { registerOutreachRoutes } from './outreachRoutes.js';
import { registerInboxRoutes } from './inboxRoutes.js';
import { registerKnowledgeRoutes } from './knowledgeRoutes.js';
import { registerInboundRoutes } from './inboundRoutes.js';
import { registerMetaRoutes } from './metaRoutes.js';
import { registerSearchRoutes } from './searchRoutes.js';
import { searchConfigProblems } from '../discovery/webSearch.js';
import { telegramConfigProblems } from '../telegram/bot.js';
import { metaConfigProblems } from '../meta/graph.js';
import { KnowledgeError } from '../knowledge/extract.js';
import { autonomyProblems, autoApprovedToday, returnAgentApprovals } from '../outreach/autonomy.js';
import { aiConfigured } from '../ai/gemini.js';
import { aiSpend } from '../ai/budget.js';
import { imapConfigProblems } from '../inbox/mailbox.js';
import { OutreachError, messageCounts } from '../outreach/messages.js';
import { applyDoNotContact, cancelOpenMessages, CONTACT_TASK_TYPES } from '../outreach/suppressions.js';
import { cancelLeadTasks, PermanentError } from '../queue/queue.js';
import { emailConfigProblems, fromDomain } from '../outreach/email/compose.js';
import { AmbiguousSendError, checkDomain } from '../outreach/email/resend.js';
import { env } from '../config.js';
import { z, ZodError } from 'zod';
import type { Db } from '../db/pool.js';
import type { Agent } from '../agent/controller.js';
import type { RecoveryReport } from '../queue/queue.js';
import { cancelTask, retryTask } from '../queue/queue.js';
import { getSettings, settingsPatchSchema, updateSettings, MODES } from '../settings.js';
import {
  getLead, leadCounts, listLeads, requalifyAll, resetLeadStatus, updateLead, upsertLead, LEAD_STATUSES,
} from '../leads/leads.js';
import { CATEGORIES, CATEGORY_IDS, REGIONS, REGION_CODES, type Category, type RegionCode } from '../discovery/catalog.js';
import { queueEnrichment, startDiscovery } from '../discovery/discovery.js';
import { CSV_COLUMNS, manualToCandidate, parseCsv } from '../discovery/csvImport.js';
import { usageSummary } from '../usage.js';
import { logger } from '../log.js';

export interface AppContext {
  db: Db;
  agent: Agent;
  recovery: RecoveryReport & { at: Date; wasRunningAtShutdown: boolean };
  port: number;
  shutdown: () => Promise<void>;
}

const log = logger('api');

export function createApp(ctx: AppContext) {
  const { db, agent } = ctx;
  const app = express();
  app.disable('x-powered-by');

  // Local-only guard. The server binds to 127.0.0.1; these checks also stop other websites open in your
  // browser from driving it (DNS rebinding via the Host header, cross-site POSTs via the custom header).
  const allowedHosts = new Set([`127.0.0.1:${ctx.port}`, `localhost:${ctx.port}`]);
  app.use('/api', (req, res, next) => {
    if (!allowedHosts.has(String(req.headers.host))) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Local access only' } });
    if (req.method !== 'GET' && req.headers['x-agent-client'] !== 'dashboard') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Missing dashboard header' } });
    }
    next();
  });
  app.use('/api', express.json({ limit: '5mb' }));

  // ── Status & agent controls ──────────────────────────────────────────────
  app.get('/api/status', h(async (_req, res) => {
    const [settings, leads, tasks, messages] = await Promise.all([
      getSettings(db),
      leadCounts(db),
      db.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM tasks GROUP BY status'),
      messageCounts(db),
    ]);
    const taskCounts = Object.fromEntries(tasks.rows.map((r) => [r.status, r.n]));
    const errors24h = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM logs WHERE level = 'error' AND at > now() - interval '24 hours'`)).rows[0]!.n;
    res.json({
      agent: {
        state: agent.state,
        since: agent.since,
        current: agent.current && { id: agent.current.task.id, type: agent.current.task.type, startedAt: agent.current.startedAt },
        working: agent.currentTasks.map((c) => ({ id: c.task.id, type: c.task.type, startedAt: c.startedAt })),
      },
      mode: settings.mode,
      emailSendingMode: settings.emailSendingMode,
      leads,
      tasks: taskCounts,
      errors24h,
      recovery: ctx.recovery,
      // Null means "not tracked yet" (registrations need a StockỌja integration), never zero.
      outreach: {
        awaitingApproval: messages.draft ?? 0,
        approvedWaiting: messages.approved ?? 0,
        sent: messages.sent ?? 0,
        dryRuns: messages.dry_run ?? 0,
        failed: messages.failed ?? 0,
        replies: messages.replies ?? 0,
        needsAttention: messages.needsAttention ?? 0,
        unmatched: messages.unmatched ?? 0,
        interested: leads.byStatus.interested ?? 0,
        demosBooked: leads.byStatus.demo_booked ?? 0,
        readReplies: settings.readReplies ? 1 : 0,
        autoApprovedToday: await autoApprovedToday(db),
        autoApproveDailyLimit: settings.autoApproveDailyLimit,
        registrations: null,
        activated: null,
      },
    });
  }));

  app.post('/api/agent/:action', h(async (req, res) => {
    const action = req.params.action;
    if (action === 'start') await agent.start();
    else if (action === 'pause') await agent.pause();
    else if (action === 'resume') await agent.resume();
    else if (action === 'stop') await agent.stop();
    else throw notFound('Action');
    res.json({ state: agent.state, since: agent.since });
  }));

  app.post('/api/app/shutdown', (_req, res) => {
    res.json({ ok: true });
    setTimeout(() => void ctx.shutdown(), 100);
  });

  // ── Options ──────────────────────────────────────────────────────────────
  app.get('/api/options', (_req, res) => {
    res.json({
      categories: CATEGORY_IDS.map((id) => ({ id, label: CATEGORIES[id].label, osmShops: CATEGORIES[id].osmShops })),
      regions: REGION_CODES.map((code) => ({ code, label: REGIONS[code] })),
      leadStatuses: LEAD_STATUSES,
      modes: MODES,
      csvColumns: CSV_COLUMNS,
    });
  });

  // ── Leads ────────────────────────────────────────────────────────────────
  const leadQuery = z.object({
    q: z.string().trim().max(100).optional(),
    status: z.enum(LEAD_STATUSES).optional(),
    category: z.enum(CATEGORY_IDS as [Category, ...Category[]]).optional(),
    state: z.string().max(60).optional(),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    contact: z.enum(['email', 'phone', 'any', 'none']).optional(),
    sort: z.enum(['score', 'newest', 'name']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  });
  app.get('/api/leads', h(async (req, res) => {
    const clean = Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== ''));
    res.json(await listLeads(db, leadQuery.parse(clean)));
  }));

  app.get('/api/leads/:id', h(async (req, res) => {
    const lead = await getLead(db, idParam(req));
    if (!lead) throw notFound('Lead');
    res.json(lead);
  }));

  const manualSchema = z.object({
    business_name: z.string().trim().min(1).max(200),
    category: z.string().min(1),
    city: z.string().max(100).nullish(),
    state: z.string().max(100).nullish(),
    address: z.string().max(300).nullish(),
    phone: z.string().max(60).nullish(),
    email: z.string().max(200).nullish(),
    website: z.string().max(300).nullish(),
    instagram: z.string().max(300).nullish(),
    facebook: z.string().max(300).nullish(),
    tiktok: z.string().max(300).nullish(),
    telegram: z.string().max(300).nullish(),
    whatsapp: z.string().max(300).nullish(),
    source_url: z.string().max(500).nullish(),
    notes: z.string().max(2000).nullish(),
  });
  app.post('/api/leads', h(async (req, res) => {
    const input = manualSchema.parse(req.body);
    const candidate = manualToCandidate(input, 'manual');
    if ('error' in candidate) throw new HttpError(422, 'VALIDATION', candidate.error);
    const settings = await getSettings(db);
    const result = await upsertLead(db, candidate, settings.qualifyThreshold);
    log.info(`Lead #${result.leadId} added manually (${result.outcome})`);
    res.status(result.outcome === 'created' ? 201 : 200).json(result);
  }));

  app.post('/api/leads/import', h(async (req, res) => {
    const { csv } = z.object({ csv: z.string().min(1).max(4_000_000) }).parse(req.body);
    const parsed = parseCsv(csv);
    if (parsed.error) throw new HttpError(422, 'VALIDATION', parsed.error);
    const settings = await getSettings(db);
    const summary = { rows: parsed.rows.length, created: 0, merged: 0, seen: 0, errors: [] as Array<{ row: number; error: string }> };
    for (const [i, row] of parsed.rows.entries()) {
      const candidate = manualToCandidate(row, 'csv');
      if ('error' in candidate) {
        summary.errors.push({ row: i + 2, error: candidate.error });
        continue;
      }
      const { outcome } = await upsertLead(db, candidate, settings.qualifyThreshold);
      summary[outcome]++;
    }
    log.info(`CSV import: ${summary.rows} rows, ${summary.created} new, ${summary.merged + summary.seen} matched existing, ${summary.errors.length} errors`);
    res.json(summary);
  }));

  app.patch('/api/leads/:id', h(async (req, res) => {
    const patch = z
      .object({
        status: z.enum(LEAD_STATUSES).optional(),
        notes: z.string().max(5000).nullable().optional(),
        category: z.enum(CATEGORY_IDS as [Category, ...Category[]]).optional(),
        socials: z.record(z.enum(['instagram', 'facebook', 'tiktok', 'telegram', 'whatsapp']), z.string().trim().max(300).nullable()).optional(),
      })
      .strict()
      .parse(req.body);
    const settings = await getSettings(db);
    const id = idParam(req);
    if (patch.status === 'do_not_contact') {
      // Blocks the email/phone everywhere and stops open messages and contact tasks.
      const done = await applyDoNotContact(db, id, 'Marked do not contact by you');
      if (!done) throw notFound('Lead');
      log.info(`Lead #${id} marked do not contact; ${done.cancelledMessages} open message(s) cancelled`);
    }
    const lead = await updateLead(db, id, patch, settings.qualifyThreshold);
    if (!lead) throw notFound('Lead');
    if (patch.status === 'declined' || patch.status === 'archived') await cancelOpenMessages(db, id, `Lead ${patch.status}`);
    // Any status that means "they responded" or "stop" ends the follow-up sequence.
    if (patch.status && !['qualified', 'contacted', 'discovered', 'unqualified'].includes(patch.status)) {
      await cancelLeadTasks(db, id, CONTACT_TASK_TYPES, `Lead marked ${patch.status.replace(/_/g, ' ')}`);
    }
    if (patch.status) log.info(`Lead #${lead.id} status set to ${patch.status} by you`);
    res.json(lead);
  }));

  app.post('/api/leads/:id/auto-status', h(async (req, res) => {
    const settings = await getSettings(db);
    const lead = await resetLeadStatus(db, idParam(req), settings.qualifyThreshold);
    if (!lead) throw notFound('Lead');
    res.json(lead);
  }));

  app.post('/api/leads/:id/enrich', h(async (req, res) => {
    const lead = await getLead(db, idParam(req));
    if (!lead) throw notFound('Lead');
    if (!lead.website) throw new HttpError(422, 'NO_WEBSITE', 'This lead has no website to check.');
    const task = await queueEnrichment(db, lead, true);
    agent.nudge();
    res.status(202).json({ taskId: task?.id ?? null, agentState: agent.state });
  }));

  // ── Discovery ────────────────────────────────────────────────────────────
  app.post('/api/discovery/runs', h(async (req, res) => {
    const body = z
      .object({
        categories: z.array(z.enum(CATEGORY_IDS as [Category, ...Category[]])).min(1),
        regions: z.array(z.enum(REGION_CODES as [RegionCode, ...RegionCode[]])).min(1).max(10),
        force: z.boolean().optional(),
      })
      .parse(req.body);
    const result = await startDiscovery(db, body);
    agent.nudge();
    res.status(202).json({ ...result, agentState: agent.state });
  }));

  app.get('/api/discovery/runs', h(async (_req, res) => {
    const { rows } = await db.query(
      `SELECT r.*, t.status AS task_status FROM discovery_runs r LEFT JOIN tasks t ON t.id = r.task_id ORDER BY r.id DESC LIMIT 100`,
    );
    res.json({ data: rows });
  }));

  // ── Tasks ────────────────────────────────────────────────────────────────
  app.get('/api/tasks', h(async (req, res) => {
    const status = z.enum(['pending', 'running', 'done', 'failed', 'cancelled', 'needs_review']).optional().parse(req.query.status || undefined);
    const { rows } = await db.query(
      `SELECT t.id, t.type, t.payload, t.status, t.run_at, t.attempts, t.max_attempts, t.last_error, t.review_reason,
              t.lead_id, l.business_name AS lead_name, t.created_at, t.updated_at, t.finished_at
       FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id
       ${status ? 'WHERE t.status = $1' : ''}
       ORDER BY CASE t.status WHEN 'needs_review' THEN 0 WHEN 'running' THEN 1 WHEN 'pending' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
                t.run_at DESC, t.id DESC
       LIMIT 200`,
      status ? [status] : [],
    );
    res.json({ data: rows });
  }));

  app.post('/api/tasks/:id/:action', h(async (req, res) => {
    const id = idParam(req);
    const action = req.params.action;
    let ok = false;
    if (action === 'retry') ok = await retryTask(db, id);
    else if (action === 'cancel') {
      ok = await cancelTask(db, id);
      if (ok) await db.query(`UPDATE discovery_runs SET status = 'failed', error = 'Cancelled', finished_at = now() WHERE task_id = $1 AND status = 'running'`, [id]);
    } else throw notFound('Action');
    if (!ok) throw new HttpError(409, 'CONFLICT', `This task cannot be ${action === 'retry' ? 'retried' : 'cancelled'} in its current state.`);
    agent.nudge();
    res.json({ ok });
  }));

  // ── Logs, usage, settings, integrations ──────────────────────────────────
  app.get('/api/logs', h(async (req, res) => {
    const q = z
      .object({ level: z.enum(['info', 'warn', 'error']).optional(), scope: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) })
      .parse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.level) {
      params.push(q.level === 'info' ? ['info', 'warn', 'error'] : q.level === 'warn' ? ['warn', 'error'] : ['error']);
      where.push(`level = ANY($${params.length})`);
    }
    if (q.scope) {
      params.push(`${q.scope}%`);
      where.push(`scope LIKE $${params.length}`);
    }
    params.push(q.limit);
    const { rows } = await db.query(
      `SELECT id, at, level, scope, message, data FROM logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    res.json({ data: rows });
  }));

  app.get('/api/usage', h(async (_req, res) => res.json(await usageSummary(db))));

  app.get('/api/settings', h(async (_req, res) => res.json(await getSettings(db))));
  app.put('/api/settings', h(async (req, res) => {
    const patch = settingsPatchSchema.parse(req.body);
    if (patch.readReplies === true) {
      const problems = imapConfigProblems();
      if (problems.length) throw new HttpError(422, 'NOT_CONFIGURED', problems.map((p) => p.message).join(' '));
    }
    if (patch.websiteLinks) patch.websiteLinks = [...new Set(patch.websiteLinks.map((l) => l.trim()))];
    if ((patch.aiDraftReplies || patch.aiDraftIntros) && !aiConfigured()) {
      throw new HttpError(422, 'NOT_CONFIGURED', 'AI drafting needs GEMINI_API_KEY in .env (then restart the app).');
    }
    const before = await getSettings(db);
    const merged = { ...before, ...patch };
    if (merged.sendWindowStartHour >= merged.sendWindowEndHour) {
      throw new HttpError(422, 'VALIDATION', 'Sending hours must start before they end.');
    }
    if (patch.interestFormEnabled && !merged.interestFormCsvUrl) {
      throw new HttpError(422, 'VALIDATION', "Add the response sheet's CSV link before switching the interest form on.");
    }
    if (patch.instagramLookupEnabled || patch.metaInboxEnabled || patch.metaReplySending === 'live') {
      const problems = metaConfigProblems();
      if (problems.length) throw new HttpError(422, 'NOT_CONFIGURED', `${problems.map((p) => p.message).join(' ')} Then restart the app.`);
    }
    if (patch.metaInboxEnabled && !merged.metaInboxPlatforms.length) {
      throw new HttpError(422, 'VALIDATION', 'Choose Instagram, Facebook or both before switching the inbox on.');
    }
    if (patch.metaReplySending === 'live' && !merged.metaInboxEnabled) {
      throw new HttpError(422, 'VALIDATION', 'Switch on the Instagram & Facebook inbox first: replies can only go to people whose messages it has read.');
    }
    for (const p of patch.webSearchProviders ?? []) {
      if (before.webSearchProviders.includes(p)) continue;
      const problems = searchConfigProblems(p);
      if (problems.length) throw new HttpError(422, 'NOT_CONFIGURED', problems.join(' '));
    }
    if (patch.referralLinksEnabled && !merged.referralPrefillUrl) {
      throw new HttpError(422, 'VALIDATION', "Add your form's pre-filled link (with REFCODE) before switching personal referral links on.");
    }
    if (merged.knowledgeChunkOverlap * 2 > merged.knowledgeChunkWords) {
      throw new HttpError(422, 'VALIDATION', 'Chunk overlap can be at most half the chunk size.');
    }
    if (patch.mode === 'autonomous' && before.mode !== 'autonomous') {
      const problems = autonomyProblems(merged);
      if (problems.length) throw new HttpError(422, 'NOT_READY', `Before Controlled Autonomous Mode: ${problems.join(' ')}`);
      log.warn(
        `Controlled Autonomous Mode ON: up to ${merged.autoApproveDailyLimit} agent approval(s) a day ` +
          `(intros ${merged.autoApproveIntros ? 'yes' : 'no'}, follow-ups ${merged.autoApproveFollowUps ? 'yes' : 'no'}, answers auto-sent on ${Object.entries(merged.replyAutonomy).filter(([, v]) => v === 'auto_send').map(([k]) => k).join(', ') || 'no channel'}; min score ${merged.autoApproveMinScore}; sending ${merged.emailSendingMode})`,
      );
    }
    if (patch.mode && patch.mode !== 'autonomous' && before.mode === 'autonomous') {
      const n = await returnAgentApprovals(db);
      log.info(`Controlled Autonomous Mode off${n ? `; ${n} unsent agent-approved email(s) returned to you as drafts` : ''}`);
    }
    if (patch.emailSendingMode === 'live' && before.emailSendingMode !== 'live') {
      // Real sending only with everything in place, and only to a verified domain.
      const problems = emailConfigProblems(merged);
      if (problems.length) throw new HttpError(422, 'NOT_CONFIGURED', problems.map((p) => p.message).join(' '));
      let check;
      try {
        check = await checkDomain(fromDomain());
      } catch (err) {
        throw new HttpError(422, 'DOMAIN_CHECK_FAILED', `Could not confirm ${fromDomain()} with Resend: ${(err as Error).message}`);
      }
      if (check.status === 'not_found') throw new HttpError(422, 'DOMAIN_NOT_VERIFIED', `${check.domain} is not added in Resend yet.`);
      if (check.status === 'not_verified') throw new HttpError(422, 'DOMAIN_NOT_VERIFIED', `${check.domain} is not verified in Resend yet (status: ${check.detail}).`);
      log.warn(`Email sending switched to LIVE from ${env.OUTREACH_FROM_ADDRESS} (domain ${check.status})`);
    }
    if (patch.emailSendingMode === 'dry_run' && before.emailSendingMode === 'live') log.info('Email sending switched to dry run');
    const next = await updateSettings(db, patch);
    if (patch.qualifyThreshold !== undefined && patch.qualifyThreshold !== before.qualifyThreshold) {
      const n = await requalifyAll(db, next.qualifyThreshold);
      log.info(`Qualification threshold ${before.qualifyThreshold} → ${next.qualifyThreshold}; re-scored ${n} leads`);
    }
    log.info('Settings changed', { changed: Object.keys(patch) });
    res.json(next);
  }));

  app.get('/api/integrations', h(async (_req, res) => {
    const form = await getSettings(db);
    const db_ok = await db.query('SELECT 1').then(() => true, () => false);
    res.json({
      items: [
        { id: 'postgres', name: 'Local PostgreSQL', status: db_ok ? 'working' : 'error', note: 'Leads, tasks, settings and logs.' },
        { id: 'openstreetmap', name: 'OpenStreetMap (Overpass)', status: 'available', cost: 'Free', note: 'Shop listings by category and state. Coverage in Nigeria is thin; most listings have no email.' },
        { id: 'websites', name: 'Business websites', status: 'available', cost: 'Free', note: 'Public contact details from a lead’s own site. Honors robots.txt.' },
        { id: 'csv', name: 'CSV import and manual entry', status: 'available', cost: 'Free', note: 'Leads you find yourself, e.g. Instagram or Jumia profiles.' },
        {
          id: 'resend',
          name: 'Resend email',
          status: emailConfigProblems(await getSettings(db)).length ? 'not_configured' : (await getSettings(db)).emailSendingMode === 'live' ? 'working' : 'dry_run',
          cost: 'Free tier 3,000/month, 100/day',
          note: `From ${env.OUTREACH_FROM_ADDRESS || '(not set)'}, replies to ${env.OUTREACH_REPLY_TO || '(not set)'}. Dry run until you switch to live.`,
        },
        {
          id: 'imap',
          name: 'Reply mailbox (IMAP)',
          status: imapConfigProblems().length ? 'not_configured' : (await getSettings(db)).readReplies ? 'working' : 'off',
          cost: 'Free',
          note: `Read-only. ${env.IMAP_USER ? `${env.IMAP_USER} on ${env.IMAP_HOST}` : 'Not set in .env'}. Only mail from leads, or answering an outreach subject, is downloaded.`,
        },
        await (async () => {
          const s = await getSettings(db);
          const spend = await aiSpend(db);
          return {
            id: 'gemini',
            name: `Gemini (optional AI drafting, ${env.GEMINI_MODEL})`,
            status: !aiConfigured() ? 'not_configured' : s.aiDraftReplies || s.aiDraftIntros ? 'working' : 'available',
            cost: `Free tier or paid per use; this month about $${Number(spend.month_usd).toFixed(4)} of your $${s.aiMonthlyBudgetUsd.toFixed(2)} cap`,
            note: aiConfigured()
              ? 'Writes drafts from your knowledge when you ask (or when switched on). Every AI draft waits for your approval.'
              : 'Off: no GEMINI_API_KEY in .env. Templates and knowledge-base answers work without it.',
          };
        })(),
        {
          id: 'knowledge',
          name: 'Knowledge search (local)',
          status: 'available',
          cost: 'Free',
          note: 'Your documents and website pages, chunked and searched on this laptop (Postgres full-text, plus pgvector and a local model when enabled).',
        },
        {
          id: 'booking',
          name: 'Demo booking link',
          status: (await getSettings(db)).bookingUrl ? 'available' : 'not_configured',
          cost: 'Free (Cal.com/Calendly)',
          note: 'Shared in replies; the agent never proposes times. Booking notices that reach the reply mailbox mark the lead "Demo booked".',
        },
        { id: 'whatsapp_manual', name: 'WhatsApp (sent by you)', status: 'available', cost: 'Free', note: 'Approved drafts open in WhatsApp with the text filled in; you press send, then record it here.' },
        { id: 'social_manual', name: 'Instagram, Facebook, TikTok, Telegram (sent by you)', status: 'available', cost: 'Free', note: 'Drafted from the profile link or @username on a lead. You copy the text, open the chat, press send, then record it. No account is logged in to or automated.' },
        {
          id: 'meta', name: 'Meta app: Instagram lookup and Instagram/Facebook inbox', cost: 'Free',
          status: metaConfigProblems().length ? 'not_configured' : form.instagramLookupEnabled || form.metaInboxEnabled ? 'working' : 'available',
          note: metaConfigProblems().length
            ? 'Not set up. Follow docs/META_SETUP.md, then put the Page token and Page id in .env.'
            : `Lookup ${form.instagramLookupEnabled ? 'on' : 'off'}; inbox ${form.metaInboxEnabled ? `on (every ${form.metaInboxCheckMinutes} min)` : 'off'}; replies ${form.metaReplySending === 'live' ? 'sent through Meta inside 24 hours, after your approval' : 'sent by you'}. Only works for people with a role on the app until Meta approves it for live use.`,
        },
        {
          id: 'telegram', name: 'Telegram bot (inbox and answers)', cost: 'Free',
          status: telegramConfigProblems().length ? 'not_configured' : form.inboxAccess.telegram ? 'working' : 'off',
          note: telegramConfigProblems().length
            ? 'Optional. Create a bot with @BotFather and put TELEGRAM_BOT_TOKEN in .env.'
            : `Reads messages to your bot every ${form.telegramCheckMinutes} min while the agent runs; answers go back through the bot after approval. Your personal account is never used.`,
        },
        ...(['tavily', 'brave'] as const).map((p) => ({
          id: p,
          name: p === 'tavily' ? 'Tavily web search' : 'Brave Search API',
          cost: p === 'tavily' ? 'Free plan: 1,000 credits a month (1 per search)' : '$5 per 1,000 searches, $5 monthly credit; card required',
          status: searchConfigProblems(p).length ? 'not_configured' : form.webSearchProviders.includes(p) ? 'working' : 'off',
          note: searchConfigProblems(p).length
            ? `No key in .env. Optional: only needed for Discovery → Web search.`
            : `${form.webSearchProviders.includes(p) ? 'On' : 'Off'}; limit ${p === 'tavily' ? form.tavilyMonthlyLimit : form.braveMonthlyLimit} searches a month, counted by the agent. Searches run only when you click.`,
        })),
        {
          id: 'interest_form', name: 'Interest form (Google Forms)', cost: 'Free',
          status: form.interestFormEnabled && form.interestFormCsvUrl ? 'working' : 'available',
          note: form.interestFormEnabled ? `Reads the published response sheet every ${form.interestFormCheckMinutes} minutes while the agent runs.` : 'Off. Set it up under Settings → Interest form and referrals.',
        },
      ],
    });
  }));

  registerOutreachRoutes(app, ctx);
  registerInboxRoutes(app, ctx);
  registerKnowledgeRoutes(app, ctx);
  registerInboundRoutes(app, ctx);
  registerMetaRoutes(app, ctx);
  registerSearchRoutes(app, ctx);

  app.use('/api', (_req, _res, next) => next(notFound('Endpoint')));

  // Errors: field details for validation, plain message otherwise; never stack traces.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(422).json({
        error: { code: 'VALIDATION', message: 'Some fields are invalid.', fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err instanceof KnowledgeError) return res.status(err.code === 'NOT_FOUND' ? 404 : 422).json({ error: { code: err.code, message: err.message } });
    if ((err as { type?: string }).type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'That file is too large (20 MB at most).' } });
    }
    if (err instanceof OutreachError) {
      const status =
        err.code === 'NOT_FOUND' ? 404
        : err.code === 'AI_FAILED' ? 502
        : err.code === 'AI_RATE_LIMITED' ? 429
        : ['MISSING_VALUES', 'NOT_COMPLIANT', 'NO_SENDER', 'NO_ADDRESS'].includes(err.code) || err.code.startsWith('AI_') ? 422
        : 409;
      return res.status(status).json({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof PermanentError || err instanceof AmbiguousSendError) {
      return res.status(502).json({ error: { code: 'PROVIDER_ERROR', message: err.message } });
    }
    if (err instanceof SyntaxError) return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
    log.error('Unhandled API error', err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. See Logs.' } });
  });

  return app;
}
