import type { Express } from 'express';
import { z } from 'zod';
import type { AppContext } from './app.js';
import { h } from './http.js';
import { getSettings } from '../settings.js';
import { logger } from '../log.js';
import { CATEGORIES, CATEGORY_IDS } from '../discovery/catalog.js';
import { keyFor, limitFor, PROVIDERS, SCOPES, searchConfigProblems, suggestQueries, usedThisMonth, webSearch } from '../discovery/webSearch.js';
import { importExport, previewExport } from '../inbound/whatsappExport.js';

const log = logger('discovery');

export function registerSearchRoutes(app: Express, ctx: AppContext) {
  const { db } = ctx;

  app.get('/api/web-search/status', h(async (_req, res) => {
    const settings = await getSettings(db);
    const providers = [];
    for (const p of PROVIDERS) {
      providers.push({
        id: p,
        enabled: settings.webSearchProviders.includes(p),
        keySet: !!keyFor(p),
        problems: searchConfigProblems(p),
        usedThisMonth: await usedThisMonth(db, p),
        limit: limitFor(p, settings),
      });
    }
    res.json({
      providers,
      resultsPerQuery: settings.webSearchResultsPerQuery,
      country: settings.webSearchCountry,
      cacheDays: settings.webSearchCacheDays,
      suggestions: Object.fromEntries(CATEGORY_IDS.map((c) => [c, suggestQueries(CATEGORIES[c].label, 'Lagos')])),
    });
  }));

  /** Runs a search on the providers you choose. Only on your click: the agent never searches by itself. */
  app.post('/api/web-search', h(async (req, res) => {
    const body = z.object({
      query: z.string().trim().min(3).max(300),
      scope: z.enum(SCOPES).default('any'),
      providers: z.array(z.enum(PROVIDERS)).min(1).max(2),
      fresh: z.boolean().optional(),
    }).strict().parse(req.body);
    const outcomes = await webSearch(db, await getSettings(db), body);
    const summary = outcomes.map((o) => `${o.provider}: ${o.error ? 'failed' : `${o.results.length} results${o.cached ? ' (saved)' : ''}`}`).join(', ');
    log.info(`Web search "${body.query}" (${body.scope}): ${summary}`);
    res.json({ outcomes });
  }));

  app.get('/api/web-search/history', h(async (_req, res) => {
    const { rows } = await db.query(
      `SELECT id, provider, query, scope, jsonb_array_length(results) AS results, error, created_at
       FROM web_searches ORDER BY id DESC LIMIT 30`,
    );
    res.json({ items: rows });
  }));

  /** Reads an uploaded export and lists the senders. Stores nothing. */
  app.post('/api/whatsapp-export/preview', h(async (req, res) => {
    const { fileName, base64 } = z.object({
      fileName: z.string().trim().min(1).max(260),
      base64: z.string().min(1).max(5_000_000),
    }).strict().parse(req.body);
    const preview = await previewExport(db, fileName, Buffer.from(base64, 'base64'));
    res.json(preview);
  }));

  app.post('/api/whatsapp-export/import', h(async (req, res) => {
    const body = z.object({
      group: z.string().trim().min(1).max(120),
      /** You confirm these are vendors you may message yourself, with an opt-out. */
      consent: z.literal(true),
      rows: z.array(z.object({
        name: z.string().max(120),
        phone: z.string().min(5).max(40),
        category: z.enum(CATEGORY_IDS as [string, ...string[]]),
        sample: z.string().max(400).nullish(),
        city: z.string().max(80).nullish(),
        state: z.string().max(80).nullish(),
      }).strict()).min(1).max(1000),
    }).strict().parse(req.body);
    const summary = await importExport(db, await getSettings(db), body.group, body.rows as Parameters<typeof importExport>[3]);
    log.info(`WhatsApp group "${body.group}": ${summary.created} new leads, ${summary.merged + summary.seen} already known, ${summary.skipped.length} skipped`);
    res.json(summary);
  }));
}
