import { env } from '../config.js';
import { HoldForReviewError, PermanentError, RateLimitedError } from '../queue/queue.js';

/**
 * StockỌja's Telegram bot (a free bot you create with @BotFather). Merchants who open your bot and write to it
 * appear in Inbox → Telegram, and answers you approve go back through the bot. Your personal Telegram account is
 * never read or used. The Bot API puts the token in the URL path (Telegram's design), so URLs are never logged.
 */

/** Replaceable in tests, so no test ever calls Telegram. */
export const telegramDeps: { fetch: (url: string, init: RequestInit) => Promise<Response> } = {
  fetch: (url, init) => fetch(url, init),
};

export function telegramConfigProblems(): string[] {
  return env.TELEGRAM_BOT_TOKEN ? [] : ['Create a bot with @BotFather in Telegram and put its token in .env as TELEGRAM_BOT_TOKEN, then restart the app.'];
}

export class TelegramApiError extends Error {
  constructor(readonly status: number, readonly description: string, readonly retryAfter: number | null) {
    super(`Telegram: ${description}`);
  }
}

/** One Bot API call. Throws TelegramApiError when Telegram answers with a refusal; network errors pass through. */
export async function telegram<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(20_000);
  const res = await telegramDeps.fetch(`${env.TELEGRAM_API_URL.replace(/\/$/, '')}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } } | null;
  if (!json?.ok) {
    throw new TelegramApiError(json?.error_code ?? res.status, json?.description ?? `HTTP ${res.status}`, json?.parameters?.retry_after ?? null);
  }
  return json.result as T;
}

/** A refusal turned into what the task queue understands. */
export function explainTelegramError(err: TelegramApiError): Error {
  if (err.status === 401 || err.status === 404) return new PermanentError('Telegram refused the bot token. Check TELEGRAM_BOT_TOKEN in .env.');
  if (err.status === 429) return new RateLimitedError(`Telegram asks to slow down: ${err.description}`, (err.retryAfter ?? 30) * 1000);
  if (err.status === 409) return new HoldForReviewError('Another program is reading this bot (a webhook or a second copy of the agent). Only one can read it at a time.');
  return new Error(err.message);
}

/** Proves the token works. Only on your click; reads and stores nothing. */
export async function testTelegram(): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  const problems = telegramConfigProblems();
  if (problems.length) return { ok: false, error: problems.join(' ') };
  try {
    const me = await telegram<{ username: string }>('getMe');
    return { ok: true, username: me.username };
  } catch (err) {
    return { ok: false, error: err instanceof TelegramApiError ? explainTelegramError(err).message : `Cannot reach Telegram: ${(err as Error).message}` };
  }
}
