import type { Queryable } from './db/pool.js';

/** Records one external call (free ones too, at cost 0) so the dashboard can show usage and spend. */
export async function recordUsage(
  db: Queryable,
  provider: string,
  kind: string,
  opts: { units?: number; estimatedUsd?: string; detail?: Record<string, unknown> } = {},
) {
  await db
    .query('INSERT INTO usage_events (provider, kind, units, estimated_usd, detail) VALUES ($1, $2, $3, $4, $5)', [
      provider,
      kind,
      opts.units ?? 1,
      opts.estimatedUsd ?? '0',
      opts.detail ? JSON.stringify(opts.detail) : null,
    ])
    .catch(() => {});
}

export async function usageSummary(db: Queryable) {
  const { rows } = await db.query<{ provider: string; kind: string; calls: number; units: number; usd: string }>(
    `SELECT provider, kind, count(*)::int AS calls, coalesce(sum(units), 0)::int AS units,
            coalesce(sum(estimated_usd), 0)::numeric(12, 4)::text AS usd
     FROM usage_events WHERE at >= date_trunc('month', now())
     GROUP BY provider, kind ORDER BY provider, kind`,
  );
  const total = await db.query<{ usd: string }>(
    `SELECT coalesce(sum(estimated_usd), 0)::numeric(12, 4)::text AS usd FROM usage_events WHERE at >= date_trunc('month', now())`,
  );
  return { month: rows, monthTotalUsd: total.rows[0]?.usd ?? '0.0000' };
}
