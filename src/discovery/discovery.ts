import type { Db } from '../db/pool.js';
import type { TaskHandler } from '../agent/controller.js';
import { enqueue, PermanentError } from '../queue/queue.js';
import { applyEnrichment, upsertLead, type LeadRow } from '../leads/leads.js';
import { recordUsage } from '../usage.js';
import { CATEGORIES, REGIONS, type Category, type RegionCode } from './catalog.js';
import { elementToCandidate, queryOverpass } from './osm.js';
import { politeGap } from './http.js';
import { enrichFromWebsite } from './website.js';

export const TASK_OSM = 'discovery.osm';
export const TASK_ENRICH = 'lead.enrich_website';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Queues one OpenStreetMap search per category × state. The same search runs at most once a day
 * unless `force` is set, so pressing the button twice does not hit OpenStreetMap twice.
 */
export async function startDiscovery(db: Db, opts: { categories: Category[]; regions: RegionCode[]; force?: boolean }) {
  const queued: number[] = [];
  const skipped: string[] = [];
  for (const category of opts.categories) {
    for (const region of opts.regions) {
      const key = `osm:${category}:${region}:${today()}${opts.force ? `:${Date.now()}` : ''}`;
      const exists = await db.query('SELECT 1 FROM tasks WHERE idempotency_key = $1', [key]);
      if (exists.rowCount) {
        skipped.push(`${CATEGORIES[category].label} in ${REGIONS[region]}`);
        continue;
      }
      const run = await db.query<{ id: number }>(
        `INSERT INTO discovery_runs (source, params, status) VALUES ('osm', $1, 'running') RETURNING id`,
        [JSON.stringify({ category, region })],
      );
      const runId = run.rows[0]!.id;
      const task = await enqueue(db, TASK_OSM, { category, region, runId }, { idempotencyKey: key, maxAttempts: 3 });
      if (task) {
        await db.query('UPDATE discovery_runs SET task_id = $2 WHERE id = $1', [runId, task.id]);
        queued.push(task.id);
      }
    }
  }
  return { queued: queued.length, skipped };
}

/** Queues a website contact check for a lead, once (unless forced again from the lead page). */
export async function queueEnrichment(db: Db, lead: Pick<LeadRow, 'id'>, force = false) {
  return enqueue(db, TASK_ENRICH, { leadId: lead.id }, {
    idempotencyKey: `enrich:${lead.id}${force ? `:${Date.now()}` : ''}`,
    leadId: lead.id,
    maxAttempts: 2,
  });
}

export const discoveryHandlers: Record<string, TaskHandler> = {
  [TASK_OSM]: {
    // Re-running a search only re-reads public data and de-duplicates, so it is safe to repeat;
    // a search that is days late is still useful.
    policy: { retrySafe: true, reviewIfOverdue: false },
    async run(task, { db, signal, settings, log }) {
      const { category, region, runId } = task.payload as { category: Category; region: RegionCode; runId: number };
      if (!(category in CATEGORIES) || !(region in REGIONS)) throw new PermanentError('Unknown category or region');
      await db.query(`UPDATE discovery_runs SET status = 'running', error = NULL WHERE id = $1`, [runId]);
      try {
        await politeGap('overpass', settings.overpassMinIntervalSec * 1000, signal);
        const elements = await queryOverpass(category, region, signal);
        await recordUsage(db, 'openstreetmap', 'overpass_query', { detail: { category, region, elements: elements.length } });

        const counts = { found: elements.length, created: 0, merged: 0, skipped: 0 };
        for (const el of elements) {
          if (signal.aborted) throw signal.reason;
          const candidate = elementToCandidate(el, region);
          if (!candidate) {
            counts.skipped++;
            continue;
          }
          const { leadId, outcome } = await upsertLead(db, candidate, settings.qualifyThreshold);
          if (outcome === 'created') counts.created++;
          else counts.merged++;
          if (settings.enrichWebsites && outcome !== 'seen') {
            const lead = (await db.query<LeadRow>('SELECT id, email, website, status FROM leads WHERE id = $1', [leadId])).rows[0];
            if (lead && lead.website && !lead.email && lead.status !== 'do_not_contact') await queueEnrichment(db, lead);
          }
        }
        await db.query(
          `UPDATE discovery_runs SET status = 'done', found = $2, created = $3, merged = $4, skipped = $5, finished_at = now() WHERE id = $1`,
          [runId, counts.found, counts.created, counts.merged, counts.skipped],
        );
        log.info(`${CATEGORIES[category].label} in ${REGIONS[region]}: ${counts.found} found, ${counts.created} new, ${counts.merged} merged, ${counts.skipped} unnamed`);
        return counts;
      } catch (err) {
        // Stopped part-way: the task goes back to the queue, so the run is not a failure.
        if (signal.aborted) await db.query(`UPDATE discovery_runs SET error = 'Interrupted by Stop; resumes on next Start' WHERE id = $1`, [runId]);
        else
          await db.query(`UPDATE discovery_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [
            runId,
            (err as Error).message,
          ]);
        throw err;
      }
    },
  },

  [TASK_ENRICH]: {
    // Only reads a public page; safe to repeat and fine to run late.
    policy: { retrySafe: true, reviewIfOverdue: false },
    async run(task, { db, signal, settings, log }) {
      const { leadId } = task.payload as { leadId: number };
      const lead = (await db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
      if (!lead) throw new PermanentError(`Lead ${leadId} not found`);
      if (!lead.website) return { skipped: 'no website' };
      if (lead.status === 'do_not_contact') return { skipped: 'do not contact' };
      const found = await enrichFromWebsite(lead.website, settings.websiteMinIntervalSec * 1000, signal);
      await recordUsage(db, 'websites', 'page_fetch', { units: found.pagesFetched + 1, detail: { domain: lead.website_domain } });
      await applyEnrichment(db, leadId, found, settings.qualifyThreshold);
      const summary = {
        email: found.email ? 'found' : 'none',
        socials: Object.keys(found.socials),
        pages: found.pagesFetched,
        blockedByRobots: found.blockedByRobots,
      };
      log.info(`Website check for lead #${leadId}: email ${summary.email}, profiles ${summary.socials.join(', ') || 'none'}`);
      return summary;
    },
  },
};
