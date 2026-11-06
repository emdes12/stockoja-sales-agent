import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type pg from 'pg';
import { env, HOST, ROOT_DIR } from '../config.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { attachLogSink, logger } from '../log.js';
import { getSettings, getState } from '../settings.js';
import { Agent, type HandlerRegistry } from '../agent/controller.js';
import { recoverOnStartup } from '../queue/queue.js';
import { discoveryHandlers } from '../discovery/discovery.js';
import { outreachHandlers, outreachRecurring } from '../outreach/handlers.js';
import { seedOutreach } from '../outreach/seed.js';
import { sendingHandlers, sendingRecurring } from '../outreach/sending.js';
import { inboxHandlers, inboxRecurring } from '../inbox/inbox.js';
import { knowledgeHandlers, knowledgeRecurring } from '../knowledge/site.js';
import { formHandlers, formRecurring } from '../inbound/form.js';
import { metaInboxHandlers, metaInboxRecurring } from '../meta/inbox.js';
import { metaSendHandlers } from '../meta/send.js';
import { telegramHandlers, telegramRecurring } from '../telegram/inbox.js';
import { telegramSendHandlers } from '../telegram/send.js';
import { ensureVectorSupport, kickEmbedding, stopEmbedding } from '../knowledge/store.js';
import { createApp } from './app.js';

const log = logger('app');
const SINGLE_INSTANCE_LOCK = 724_100_000;

export const handlers: HandlerRegistry = { ...discoveryHandlers, ...outreachHandlers, ...sendingHandlers, ...inboxHandlers, ...knowledgeHandlers, ...formHandlers, ...metaInboxHandlers, ...metaSendHandlers, ...telegramHandlers, ...telegramSendHandlers };

async function main() {
  const db = createPool(env.DATABASE_URL);

  try {
    await db.query('SELECT 1');
  } catch (err) {
    console.error(`\nCannot reach PostgreSQL: ${(err as Error).message}\nCheck that the "postgresql-x64-15" service is running and DATABASE_URL in .env is right.\n`);
    process.exit(1);
  }

  // One copy of the agent at a time, so two windows can never work the same queue (or send twice later).
  const lockClient: pg.PoolClient = await db.connect();
  const locked = (await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [SINGLE_INSTANCE_LOCK])).rows[0]!.ok;
  if (!locked) {
    console.error(`\nThe sales agent is already running. Open http://${HOST}:${env.PORT} or close the other window first.\n`);
    lockClient.release();
    await db.end();
    process.exit(1);
  }

  const applied = await migrate(db);
  attachLogSink(db);
  if (applied.length) log.info(`Database migrated: ${applied.join(', ')}`);
  await db.query(`DELETE FROM logs WHERE at < now() - interval '30 days'`);
  await seedOutreach(db);
  if (!(await ensureVectorSupport(db))) {
    log.info('pgvector is not enabled in this database: knowledge search uses full-text only. See README, "Knowledge".');
  }

  const settings = await getSettings(db);
  const agent = new Agent(db, handlers, 1500, [...outreachRecurring, ...sendingRecurring, ...inboxRecurring, ...knowledgeRecurring, ...formRecurring, ...metaInboxRecurring, ...telegramRecurring]);

  // Recover before anything can run: nothing left over from last time executes blindly.
  const previous = await getState<{ state: string }>(db, 'agent');
  const wasRunningAtShutdown = previous?.state === 'running' || previous?.state === 'paused';
  const report = await recoverOnStartup(db, agent.policies, settings.overdueGraceMinutes);
  const recovery = { ...report, at: new Date(), wasRunningAtShutdown };
  log.info(
    `Start-up recovery: ${report.requeued} interrupted task(s) re-queued, ${report.heldInterrupted} held for review, ${report.heldOverdue} overdue held for review` +
      (wasRunningAtShutdown ? '. The agent was running when the app last closed; it stays stopped until you press Start.' : ''),
  );

  let server: Server | null = null;
  let shuttingDown = false;
  const shutdown = async (why = 'requested') => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Shutting down (${why})`);
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    // Stop the agent first: it records its state, so the next start knows it was stopped cleanly.
    await agent.stop().catch(() => {});
    stopEmbedding();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server?.closeAllConnections?.();
    attachLogSink(null);
    lockClient.release();
    await db.end().catch(() => {});
    console.log('Sales agent stopped. You can close this window.');
    process.exit(0);
  };

  const app = createApp({ db, agent, recovery, port: env.PORT, shutdown: () => shutdown('Quit pressed in the dashboard') });

  if (env.NODE_ENV === 'production') {
    const dist = path.join(ROOT_DIR, 'dist', 'web');
    if (!existsSync(path.join(dist, 'index.html'))) {
      console.error('Dashboard not built. Run `npm run build:web` (or use `npm start`, which builds it).');
      process.exit(1);
    }
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({
      configFile: path.join(ROOT_DIR, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { port: env.PORT + 1 } },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  server = app.listen(env.PORT, HOST);
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') console.error(`\nPort ${env.PORT} is in use. Change PORT in .env or close the program using it.\n`);
    else console.error(err);
    void shutdown('server error');
  });
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));

  const url = `http://${HOST}:${env.PORT}`;
  log.info(`Dashboard ready at ${url}`);
  console.log(`\n  StockỌja Sales Agent → ${url}\n  Press Ctrl+C here (or Quit in the dashboard) to stop.\n`);

  if (settings.autoStartAgentOnLaunch) await agent.start();
  // Chunks added while the app was closed (or whose embedding was interrupted) are embedded now, locally.
  kickEmbedding(db);
  if (process.argv.includes('--open')) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();

  // Ctrl+C, closing the console window (SIGHUP/SIGBREAK on Windows) and system shutdown all stop cleanly.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, () => void shutdown(sig));
  process.on('unhandledRejection', (err) => log.error('Unhandled rejection', err));
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
