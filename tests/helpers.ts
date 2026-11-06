import 'dotenv/config';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

export const TEST_DB_URL = process.env.DATABASE_URL_TEST;
/** Database tests are skipped (not failed) when no test database is configured. */
export const hasTestDb = !!TEST_DB_URL;

export async function testDb(): Promise<Db> {
  if (!TEST_DB_URL) throw new Error('DATABASE_URL_TEST is not set');
  const db = createPool(TEST_DB_URL);
  await migrate(db);
  return db;
}

export async function resetDb(db: Db) {
  await db.query(
    'TRUNCATE web_searches, social_contacts, form_responses, knowledge_chunks, knowledge_sources, inbox_unmatched, messages, suppressions, templates, kb_entries, tasks, lead_sources, leads, discovery_runs, logs, settings, usage_events RESTART IDENTITY CASCADE',
  );
}
