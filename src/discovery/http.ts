import { userAgent } from '../config.js';
import { sleep } from '../agent/controller.js';
import { PermanentError, RateLimitedError } from '../queue/queue.js';

const lastCall = new Map<string, number>();

/** Waits so calls sharing `key` are at least `minGapMs` apart (politeness towards free services). */
export async function politeGap(key: string, minGapMs: number, signal?: AbortSignal) {
  const wait = (lastCall.get(key) ?? 0) + minGapMs - Date.now();
  if (wait > 0) await sleep(wait, signal);
  lastCall.set(key, Date.now());
}

export interface FetchTextResult {
  status: number;
  url: string;
  contentType: string;
  text: string;
}

/** GET/POST with our User-Agent, a timeout, a size cap, and rate-limit/permanent errors mapped for the queue. */
export async function fetchText(
  url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string> } = {},
): Promise<FetchTextResult> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    body: opts.body,
    redirect: 'follow',
    signal,
    headers: { 'User-Agent': userAgent(), Accept: 'text/html,application/json;q=0.9,*/*;q=0.5', ...opts.headers },
  });
  if (res.status === 429 || res.status === 503 || res.status === 504) {
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new RateLimitedError(`${new URL(url).host} asked us to slow down (HTTP ${res.status})`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 120_000);
  }
  const max = opts.maxBytes ?? 1_500_000;
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
  return { status: res.status, url: res.url || url, contentType: res.headers.get('content-type') ?? '', text };
}

export function assertOk(r: FetchTextResult, what: string) {
  if (r.status >= 500) throw new Error(`${what}: server error HTTP ${r.status}`);
  if (r.status >= 400) throw new PermanentError(`${what}: HTTP ${r.status}`);
}
