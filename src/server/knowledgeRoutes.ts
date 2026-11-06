import express, { type Express } from 'express';
import { z } from 'zod';
import type { AppContext } from './app.js';
import { h, HttpError, idParam } from './http.js';
import { getSettings, getState } from '../settings.js';
import { enqueue } from '../queue/queue.js';
import { logger } from '../log.js';
import { extractText, MAX_UPLOAD_BYTES, SUPPORTED_EXTENSIONS } from '../knowledge/extract.js';
import {
  addSource, chunkOptionsFrom, deleteSite, deleteSource, getSource, kickEmbedding, knowledgeStatus, listSources, rechunkAll,
  rechunkSource, searchKnowledge, updateSource,
} from '../knowledge/store.js';
import { TASK_READ_WEBSITES } from '../knowledge/site.js';
import { aiStatus } from '../ai/budget.js';
import { createAiIntro } from '../ai/write.js';
import { autostartStatus, setAutostart } from '../system/autostart.js';

const log = logger('knowledge');

const chunkSchema = z.object({
  strategy: z.enum(['structure', 'fixed']).optional(),
  words: z.coerce.number().int().min(50).max(400).optional(),
  overlap: z.coerce.number().int().min(0).max(200).optional(),
});

export function registerKnowledgeRoutes(app: Express, ctx: AppContext) {
  const { db } = ctx;

  app.get('/api/knowledge/status', h(async (_req, res) => {
    const settings = await getSettings(db);
    res.json({
      ...(await knowledgeStatus(db)),
      supported: SUPPORTED_EXTENSIONS,
      maxUploadMb: MAX_UPLOAD_BYTES / 1_000_000,
      defaults: chunkOptionsFrom(settings),
      lastWebsiteRead: (await getState(db, 'knowledge.lastRead')) ?? null,
    });
  }));

  app.get('/api/knowledge/sources', h(async (req, res) => {
    const kind = z.enum(['file', 'text', 'web']).optional().parse(req.query.kind || undefined);
    res.json({ data: await listSources(db, kind) });
  }));

  app.get('/api/knowledge/sources/:id', h(async (req, res) => res.json(await getSource(db, idParam(req)))));

  // Upload: the file is the raw request body (no multipart), its name in the query string.
  app.post(
    '/api/knowledge/upload',
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    h(async (req, res) => {
      const q = chunkSchema.extend({ name: z.string().min(1).max(255), title: z.string().max(300).optional() }).parse(req.query);
      const data = req.body as Buffer;
      if (!Buffer.isBuffer(data) || !data.length) throw new HttpError(422, 'EMPTY', 'The file is empty.');
      const settings = await getSettings(db);
      const extracted = await extractText(q.name, data);
      const source = await addSource(
        db,
        { kind: 'file', title: q.title?.trim() || extracted.title, origin: q.name, mime: extracted.mime, text: extracted.text },
        chunkOptionsFrom(settings, q),
      );
      log.info(`Added document "${source.title}": ${source.word_count} words in ${source.chunk_count} chunk(s)`);
      kickEmbedding(db);
      res.status(201).json(source);
    }),
  );

  app.post('/api/knowledge/text', h(async (req, res) => {
    const body = chunkSchema.extend({ title: z.string().trim().min(1).max(300), text: z.string().min(1).max(3_000_000) }).strict().parse(req.body);
    const source = await addSource(db, { kind: 'text', title: body.title, text: body.text, origin: null }, chunkOptionsFrom(await getSettings(db), body));
    kickEmbedding(db);
    res.status(201).json(source);
  }));

  app.post('/api/knowledge/sources/:id/rechunk', h(async (req, res) => {
    const opts = chunkOptionsFrom(await getSettings(db), chunkSchema.strict().parse(req.body ?? {}));
    const source = await rechunkSource(db, idParam(req), opts);
    kickEmbedding(db);
    res.json(source);
  }));

  app.post('/api/knowledge/rechunk-all', h(async (req, res) => {
    const opts = chunkOptionsFrom(await getSettings(db), chunkSchema.strict().parse(req.body ?? {}));
    const n = await rechunkAll(db, opts);
    log.info(`Re-chunked ${n} source(s): ${opts.strategy}, ${opts.words} words, ${opts.overlap} overlap`);
    kickEmbedding(db);
    res.json({ sources: n, ...opts });
  }));

  app.patch('/api/knowledge/sources/:id', h(async (req, res) => {
    const patch = z.object({ title: z.string().trim().min(1).max(300).optional(), enabled: z.boolean().optional() }).strict().parse(req.body);
    res.json(await updateSource(db, idParam(req), patch));
  }));

  app.delete('/api/knowledge/sources/:id', h(async (req, res) => {
    await deleteSource(db, idParam(req));
    res.status(204).end();
  }));

  app.delete('/api/knowledge/sites', h(async (req, res) => {
    const root = z.string().url().parse(req.query.root);
    res.json({ deleted: await deleteSite(db, root) });
  }));

  app.get('/api/knowledge/search', h(async (req, res) => {
    const q = z.object({ q: z.string().trim().min(1).max(2000), limit: z.coerce.number().int().min(1).max(20).default(6) }).parse(req.query);
    res.json(await searchKnowledge(db, q.q, { limit: q.limit }));
  }));

  app.post('/api/knowledge/embed', h(async (_req, res) => {
    kickEmbedding(db);
    res.json({ started: true });
  }));

  /** Reads your website links now (as an agent task: it runs while the agent is running). */
  app.post('/api/knowledge/read-websites', h(async (req, res) => {
    const settings = await getSettings(db);
    const { link } = z.object({ link: z.string().url().optional() }).parse(req.body ?? {});
    if (!settings.websiteLinks.length) throw new HttpError(422, 'NO_LINKS', 'Add your website links under Settings → Knowledge first.');
    if (link && !settings.websiteLinks.includes(link)) throw new HttpError(422, 'UNKNOWN_LINK', 'That link is not in your website links.');
    const task = await enqueue(db, TASK_READ_WEBSITES, link ? { links: [link] } : {}, { idempotencyKey: `kread:manual:${Date.now()}` });
    ctx.agent.nudge();
    res.status(202).json({ task, agentRunning: ctx.agent.state === 'running' });
  }));

  // ── AI ──
  app.get('/api/ai/status', h(async (_req, res) => res.json(await aiStatus(db, await getSettings(db)))));

  app.post('/api/leads/:id/ai-intro', h(async (req, res) => {
    res.status(201).json(await createAiIntro(db, idParam(req), await getSettings(db), 'user'));
  }));

  // ── Start with Windows ──
  app.get('/api/system/autostart', h(async (_req, res) => res.json(await autostartStatus())));
  app.put('/api/system/autostart', h(async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    let status;
    try {
      status = await setAutostart(enabled);
    } catch (err) {
      throw new HttpError(422, 'NOT_SUPPORTED', (err as Error).message);
    }
    log.info(enabled ? `Start with Windows turned on (${status.path})` : 'Start with Windows turned off');
    res.json(status);
  }));
}
