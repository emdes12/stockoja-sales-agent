import type { Queryable } from '../db/pool.js';
import { DEFAULT_AI_INSTRUCTIONS, type Settings } from '../settings.js';
import { env } from '../config.js';
import { OutreachError } from '../outreach/messages.js';
import { recordUsage } from '../usage.js';
import { lagosDayStart } from '../outreach/email/window.js';
import { aiConfigured, modelChain, type GenerateResult } from './gemini.js';

export const AI_PROVIDER = 'gemini';

export const estimateUsd = (s: Settings, inputTokens: number, outputTokens: number) =>
  (inputTokens * s.aiInputUsdPerMTok + outputTokens * s.aiOutputUsdPerMTok) / 1_000_000;

/** Rough token count before a call: about 3.5 characters per token for English. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 3.5);

export async function aiSpend(db: Queryable) {
  const { rows } = await db.query<{ month_usd: string; calls_today: number; calls_month: number }>(
    `SELECT coalesce(sum(estimated_usd) FILTER (WHERE at >= date_trunc('month', now())), 0)::numeric(12, 4)::text AS month_usd,
            count(*) FILTER (WHERE at >= $2)::int AS calls_today,
            count(*) FILTER (WHERE at >= date_trunc('month', now()))::int AS calls_month
     FROM usage_events WHERE provider = $1`,
    [AI_PROVIDER, lagosDayStart(new Date())],
  );
  return rows[0]!;
}

/**
 * Refuses a call that could take this month's spend over the cap (counting the worst case: the full output
 * allowance), or that goes over the daily call limit. Nothing is ever called without a key.
 */
export async function assertAiAllowed(db: Queryable, settings: Settings, promptChars: number, maxOutputTokens: number) {
  if (!aiConfigured()) throw new OutreachError('AI_NOT_CONFIGURED', 'AI drafting needs GEMINI_API_KEY in .env (then restart the app).');
  const spend = await aiSpend(db);
  if (spend.calls_today >= settings.aiDailyCallLimit) {
    throw new OutreachError('AI_LIMIT', `Today's limit of ${settings.aiDailyCallLimit} AI call(s) is reached. Raise it in Settings → AI drafting, or write this one yourself.`);
  }
  const worst = estimateUsd(settings, estimateTokens(promptChars), maxOutputTokens);
  if (Number(spend.month_usd) + worst > settings.aiMonthlyBudgetUsd) {
    throw new OutreachError(
      'AI_BUDGET',
      `This month's AI budget ($${settings.aiMonthlyBudgetUsd.toFixed(2)}) would be exceeded (spent about $${Number(spend.month_usd).toFixed(4)}). Raise it in Settings → AI drafting, or write this one yourself.`,
    );
  }
}

export async function recordAiCall(db: Queryable, settings: Settings, r: GenerateResult, purpose: string) {
  const usd = estimateUsd(settings, r.inputTokens, r.outputTokens);
  await recordUsage(db, AI_PROVIDER, purpose, {
    units: r.inputTokens + r.outputTokens,
    estimatedUsd: usd.toFixed(6),
    detail: { model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens },
  });
  return usd;
}

export async function aiStatus(db: Queryable, settings: Settings) {
  const spend = await aiSpend(db);
  // Which models are tried in order when one is busy (looked up only when a key is set; never billed).
  const chain = aiConfigured() ? await modelChain().catch(() => null) : null;
  return {
    configured: aiConfigured(),
    defaultInstructions: DEFAULT_AI_INSTRUCTIONS,
    model: env.GEMINI_MODEL,
    models: chain?.models ?? [env.GEMINI_MODEL],
    modelsSource: chain?.source ?? 'env',
    writesOutreach: settings.aiDraftIntros,
    writesAnswers: settings.aiDraftReplies,
    monthUsd: spend.month_usd,
    budgetUsd: settings.aiMonthlyBudgetUsd,
    callsToday: spend.calls_today,
    callsMonth: spend.calls_month,
    dailyCallLimit: settings.aiDailyCallLimit,
  };
}
