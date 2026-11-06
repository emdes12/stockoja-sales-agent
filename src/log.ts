import type { Db } from './db/pool.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const SECRET_KEY = /key|secret|token|password|passwd|authorization|cookie|credential/i;
const SECRET_VALUE = [
  /\bre_[A-Za-z0-9_]{16,}\b/g, // Resend
  /\bAIza[0-9A-Za-z_-]{20,}\b/g, // Google
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / Anthropic style
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, // password inside a connection string
];
const EMAIL = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
// Nigerian mobile/landline numbers (+234… or 0…), not dates or ids.
const PHONE = /(?<![\d+])(\+?234|0)[\s-]?([789][01])[\d\s-]{6,10}(\d{2})(?!\d)/g;

/** Masks secrets, email addresses and phone numbers so logs never hold them in full. */
export function redactText(text: string): string {
  let out = text;
  for (const re of SECRET_VALUE) {
    out = out.replace(re, (_m, prefix?: string) =>
      typeof prefix === 'string' && prefix.includes('://') ? `${prefix}***@` : '[redacted]',
    );
  }
  out = out.replace(EMAIL, '$1***@$2');
  out = out.replace(PHONE, '$1$2***$3');
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

let sink: Db | null = null;

/** Once the database is up, logs are also stored there for the dashboard. */
export function attachLogSink(db: Db | null) {
  sink = db;
}

function write(level: Level, scope: string, message: string, data?: unknown) {
  const msg = redactText(message);
  const safe = data === undefined ? undefined : redact(data instanceof Error ? { error: data.message } : data);
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(
    safe === undefined ? line : `${line} ${JSON.stringify(safe)}`,
  );
  if (sink && level !== 'debug') {
    sink
      .query('INSERT INTO logs (level, scope, message, data) VALUES ($1, $2, $3, $4)', [
        level,
        scope,
        msg,
        safe === undefined ? null : JSON.stringify(safe),
      ])
      .catch(() => {}); // logging must never break the work it describes
  }
}

export const logger = (scope: string) => ({
  debug: (m: string, d?: unknown) => write('debug', scope, m, d),
  info: (m: string, d?: unknown) => write('info', scope, m, d),
  warn: (m: string, d?: unknown) => write('warn', scope, m, d),
  error: (m: string, d?: unknown) => write('error', scope, m, d),
});
