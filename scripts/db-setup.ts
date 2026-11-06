/**
 * One-time setup: creates the agent's login role and databases on your local Postgres, then migrates.
 * Needs ADMIN_DATABASE_URL (a superuser, used only here). Safe to run again: it skips what exists.
 *
 *   npm run db:setup
 */
import 'dotenv/config';
import pg from 'pg';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const admin = process.env.ADMIN_DATABASE_URL;
const targets = [process.env.DATABASE_URL, process.env.DATABASE_URL_TEST].filter((u): u is string => !!u);

if (!admin) {
  console.error('Set ADMIN_DATABASE_URL in .env (e.g. postgres://postgres:<password>@localhost:5432/postgres).');
  process.exit(1);
}
if (targets.length === 0) {
  console.error('Set DATABASE_URL in .env first.');
  process.exit(1);
}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Use lowercase letters, digits and _ only: ${s}`);
  return `"${s}"`;
};
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

const client = new pg.Client({ connectionString: admin });
await client.connect();
try {
  for (const url of targets) {
    const u = new URL(url);
    const role = decodeURIComponent(u.username);
    const password = decodeURIComponent(u.password);
    const database = u.pathname.replace(/^\//, '');

    const roleExists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount;
    if (!roleExists) {
      // Least privilege: can log in and own its own databases; not a superuser, cannot create roles or databases.
      await client.query(`CREATE ROLE ${ident(role)} LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      console.log(`Created role ${role}`);
    }
    const dbExists = (await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount;
    if (!dbExists) {
      await client.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(role)} ENCODING 'UTF8'`);
      console.log(`Created database ${database}`);
    }
    await client.query(`REVOKE ALL ON DATABASE ${ident(database)} FROM PUBLIC`);

    // pgvector (knowledge search) can only be enabled by a superuser; the agent's role then just uses it.
    // Without it, knowledge search still works on Postgres full-text search.
    const adminUrl = new URL(admin);
    adminUrl.pathname = `/${database}`;
    const inDb = new pg.Client({ connectionString: adminUrl.toString() });
    await inDb.connect();
    try {
      await inDb.query('CREATE EXTENSION IF NOT EXISTS vector');
      console.log(`${database}: pgvector enabled`);
    } catch (err) {
      console.warn(`${database}: pgvector not available (${(err as Error).message}). Knowledge search will use full-text only. See README, "Knowledge".`);
    } finally {
      await inDb.end();
    }

    const pool = createPool(url);
    const applied = await migrate(pool);
    await pool.end();
    console.log(`${database}: ${applied.length ? `applied ${applied.join(', ')}` : 'up to date'}`);
  }
  console.log('Done. You can now remove ADMIN_DATABASE_URL from .env.');
} finally {
  await client.end();
}
