import { env } from '../../config.js';
import { PermanentError, RateLimitedError } from '../../queue/queue.js';

/** Resend REST client: only the three calls the agent needs. The key never appears in logs or errors. */

export interface OutgoingEmail {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  tags: Array<{ name: string; value: string }>;
  /** Resend keeps this for 24 hours: a second request with the same key returns the first result instead of sending again. */
  idempotencyKey: string;
}

/** Network failure or 5xx: we cannot know whether Resend accepted it. Safe to retry with the same idempotency key. */
export class AmbiguousSendError extends Error {}

async function call(path: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  if (!env.RESEND_API_KEY) throw new PermanentError('RESEND_API_KEY is not set in .env');
  let res: Response;
  try {
    res = await fetch(`${env.RESEND_API_URL}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'StockOjaSalesAgent/0.1',
        ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
      },
    });
  } catch (err) {
    throw new AmbiguousSendError(`Could not reach Resend: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return body;
  const message = `Resend ${res.status}: ${String(body.message ?? body.name ?? 'error')}`;
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after'));
    throw new RateLimitedError(message, Number.isFinite(after) && after > 0 ? after * 1000 : 60_000);
  }
  if (res.status >= 500) throw new AmbiguousSendError(message);
  throw new PermanentError(message);
}

export async function sendEmail(email: OutgoingEmail, signal?: AbortSignal): Promise<{ id: string }> {
  const body = await call('/emails', {
    method: 'POST',
    signal,
    idempotencyKey: email.idempotencyKey,
    body: JSON.stringify({
      from: email.from,
      to: [email.to],
      reply_to: email.replyTo,
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: email.headers,
      tags: email.tags,
    }),
  });
  if (typeof body.id !== 'string') throw new AmbiguousSendError('Resend did not return an email id');
  return { id: body.id };
}

/** Delivery state of a sent email (needs a full-access key; a sending-only key gets 401/403). */
export async function getEmail(id: string): Promise<{ lastEvent: string | null }> {
  const body = await call(`/emails/${encodeURIComponent(id)}`);
  return { lastEvent: typeof body.last_event === 'string' ? body.last_event : null };
}

export type DomainCheck =
  | { status: 'verified'; domain: string }
  | { status: 'not_verified'; domain: string; detail: string }
  | { status: 'not_found'; domain: string }
  | { status: 'unknown'; domain: string; detail: string };

/** Is the From domain verified in Resend? A sending-only key cannot list domains, which is reported as unknown. */
export async function checkDomain(domain: string): Promise<DomainCheck> {
  try {
    const body = await call('/domains');
    const list = (body.data as Array<{ name: string; status: string }>) ?? [];
    const found = list.find((d) => d.name.toLowerCase() === domain.toLowerCase());
    if (!found) return { status: 'not_found', domain };
    return found.status === 'verified' ? { status: 'verified', domain } : { status: 'not_verified', domain, detail: found.status };
  } catch (err) {
    if (err instanceof PermanentError && /Resend 40[13]/.test(err.message)) {
      return { status: 'unknown', domain, detail: 'This API key cannot list domains (a sending-only key). Check the domain in the Resend dashboard.' };
    }
    throw err;
  }
}
