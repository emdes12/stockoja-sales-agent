import pg from 'pg';

// int8 (ids, counts) as JS numbers: they stay far below 2^53 here. NUMERIC stays a string (money/costs).
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string): Db {
  // Room for every task lane running at once, plus the dashboard.
  const pool = new pg.Pool({ connectionString, max: 25, idleTimeoutMillis: 30_000 });
  // An idle client losing its connection (e.g. Postgres restarted) must not crash the app.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  return pool;
}

/** Runs `fn` in a transaction on one client. */
export async function tx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
