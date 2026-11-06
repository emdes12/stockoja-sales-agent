import { env } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const pool = createPool(env.DATABASE_URL);
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Database is up to date.');
} finally {
  await pool.end();
}
