import type { Express } from 'express';
import { z } from 'zod';
import type { AppContext } from './app.js';
import { h, HttpError, idParam, notFound } from './http.js';
import { env } from '../config.js';
import { getSettings, getState } from '../settings.js';
import { enqueue } from '../queue/queue.js';
import { logger } from '../log.js';
import { upsertLead, type LeadRow } from '../leads/leads.js';
import { manualToCandidate } from '../discovery/csvImport.js';
import { autoAnswer } from '../inbox/process.js';
import { metaConfigProblems, testMeta } from '../meta/graph.js';
import { applyInstagramProfile, leadInstagram, lookupInstagram } from '../meta/instagram.js';
import { TASK_CHECK_META } from '../meta/inbox.js';

const log = logger('meta');

export function registerMetaRoutes(app: Express, ctx: AppContext) {
  const { db, agent } = ctx;

  app.get('/api/meta/status', h(async (_req, res) => {
    const settings = await getSettings(db);
    const counts = (await db.query<{ contacts: number; linked: number; looked_up: number }>(
      `SELECT (SELECT count(*)::int FROM social_contacts) AS contacts,
              (SELECT count(*)::int FROM social_contacts WHERE lead_id IS NOT NULL) AS linked,
              (SELECT count(*)::int FROM leads WHERE instagram_checked_at IS NOT NULL) AS looked_up`,
    )).rows[0]!;
    res.json({
      problems: metaConfigProblems(),
      pageId: env.META_PAGE_ID || null,
      appSecretProof: !!env.META_APP_SECRET,
      graphVersion: env.META_GRAPH_VERSION,
      lookupEnabled: settings.instagramLookupEnabled,
      inboxEnabled: settings.metaInboxEnabled,
      replySending: settings.metaReplySending,
      lastCheck: (await getState(db, 'meta.lastCheck')) ?? null,
      ...counts,
    });
  }));

  /** Calls Meta once to prove the token and Page work. Only on your click; stores nothing. */
  app.post('/api/meta/test', h(async (_req, res) => {
    const r = await testMeta(db);
    log.info(r.ok ? `Meta test: connected to Page "${r.page}"${r.instagram ? ` and Instagram @${r.instagram}` : ' (no Instagram account linked)'}` : `Meta test failed: ${r.error}`);
    res.json(r);
  }));

  app.post('/api/meta/check-now', h(async (_req, res) => {
    const settings = await getSettings(db);
    if (!settings.metaInboxEnabled) throw new HttpError(422, 'OFF', 'Turn on the Instagram & Facebook inbox in Settings first.');
    const problems = metaConfigProblems();
    if (problems.length) throw new HttpError(422, 'NOT_CONFIGURED', problems.map((p) => p.message).join(' '));
    const task = await enqueue(db, TASK_CHECK_META, { manual: true }, { idempotencyKey: `${TASK_CHECK_META}:manual:${Math.floor(Date.now() / 10_000)}`, maxAttempts: 1 });
    agent.nudge();
    res.status(202).json({ queued: !!task, agentRunning: agent.state === 'running' });
  }));

  /** Looks up a public business/creator profile, without saving anything (Discovery → Instagram lookup). */
  app.post('/api/meta/instagram/lookup', h(async (req, res) => {
    const { username } = z.object({ username: z.string().trim().min(1).max(300) }).strict().parse(req.body);
    const profile = await lookupInstagram(db, await getSettings(db), username);
    log.info(`Instagram lookup: @${profile.username}`);
    res.json(profile);
  }));

  /** Looks up the lead's Instagram profile (or the username given) and adds what it shows to the lead. */
  app.post('/api/leads/:id/instagram', h(async (req, res) => {
    const { username } = z.object({ username: z.string().trim().max(300).optional() }).strict().parse(req.body ?? {});
    const id = idParam(req);
    const lead = (await db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [id])).rows[0];
    if (!lead) throw notFound('Lead');
    const handle = username || leadInstagram(lead);
    if (!handle) throw new HttpError(422, 'NO_USERNAME', 'This lead has no Instagram profile. Add the @username first.');
    const settings = await getSettings(db);
    const profile = await lookupInstagram(db, settings, handle);
    const updated = await applyInstagramProfile(db, id, profile, settings.qualifyThreshold);
    log.info(`Instagram profile @${profile.username} added to lead #${id}`);
    res.json({ profile, lead: updated });
  }));
}
