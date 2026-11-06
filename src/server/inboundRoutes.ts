import type { Express } from 'express';
import { z } from 'zod';
import type { AppContext } from './app.js';
import { h, HttpError, idParam, notFound } from './http.js';
import { getSettings } from '../settings.js';
import { enqueue } from '../queue/queue.js';
import { logger } from '../log.js';
import { fetchSheet, lastImport, mapSheet, TASK_IMPORT_FORM } from '../inbound/form.js';
import { referralLinkFor } from '../inbound/referrals.js';

const log = logger('inbound');

export function registerInboundRoutes(app: Express, ctx: AppContext) {
  const { db } = ctx;

  app.get('/api/inbound/status', h(async (_req, res) => {
    const counts = (
      await db.query<{ responses: number; leads: number; referred: number; codes: number }>(
        `SELECT (SELECT count(*)::int FROM form_responses) AS responses,
                (SELECT count(*)::int FROM leads WHERE asked_to_hear_at IS NOT NULL) AS leads,
                (SELECT count(*)::int FROM leads WHERE referred_by_lead_id IS NOT NULL) AS referred,
                (SELECT count(*)::int FROM leads WHERE referral_code IS NOT NULL) AS codes`,
      )
    ).rows[0]!;
    res.json({ ...counts, lastImport: (await lastImport(db)) ?? null });
  }));

  /** Reads the sheet now and shows which columns were found, without importing anything. */
  app.post('/api/inbound/test', h(async (req, res) => {
    const settings = await getSettings(db);
    const { url } = z.object({ url: z.string().url().optional() }).parse(req.body ?? {});
    const target = url ?? settings.interestFormCsvUrl;
    if (!target) throw new HttpError(422, 'NO_LINK', "Paste the response sheet's CSV link first.");
    let csv: string;
    try {
      csv = await fetchSheet(db, target);
    } catch (err) {
      throw new HttpError(422, 'SHEET_UNREADABLE', (err as Error).message);
    }
    const sheet = mapSheet(csv, settings.interestFormColumns);
    res.json({ headers: sheet.headers, matched: sheet.matched, missing: sheet.missing, rows: sheet.rows.length });
  }));

  app.post('/api/inbound/check-now', h(async (_req, res) => {
    const settings = await getSettings(db);
    if (!settings.interestFormEnabled) throw new HttpError(422, 'FORM_OFF', 'Switch the interest form on first.');
    const task = await enqueue(db, TASK_IMPORT_FORM, {}, { idempotencyKey: `inbound:manual:${Date.now()}` });
    ctx.agent.nudge();
    res.status(202).json({ task, agentRunning: ctx.agent.state === 'running' });
  }));

  /** This merchant's personal form link (creates their code the first time). */
  app.post('/api/leads/:id/referral-link', h(async (req, res) => {
    const id = idParam(req);
    if (!(await db.query('SELECT 1 FROM leads WHERE id = $1', [id])).rowCount) throw notFound('Lead');
    const result = await referralLinkFor(db, id, await getSettings(db));
    log.info(`Referral link ready for lead #${id}`);
    res.json(result);
  }));
}
