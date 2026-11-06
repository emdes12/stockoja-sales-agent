import 'dotenv/config';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';

/** Secrets and machine settings from `.env`. Tunables the user changes live in the `settings` table instead. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  DATABASE_URL_TEST: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(6400),
  OVERPASS_URL: z.string().url().default('https://overpass-api.de/api/interpreter'),
  CONTACT_EMAIL: z.string().optional().default(''),
  // Stage 4: email through Resend. Sending stays in dry-run until you switch it to live in Settings.
  RESEND_API_KEY: z.string().optional().default(''),
  /** Address on your outreach subdomain, e.g. hello@hello.stockoja.com. The display name is your name from Settings. */
  OUTREACH_FROM_ADDRESS: z.union([z.string().email(), z.literal('')]).optional().default(''),
  /** A real mailbox you read: the sending subdomain cannot receive mail, so replies go here. */
  OUTREACH_REPLY_TO: z.union([z.string().email(), z.literal('')]).optional().default(''),
  RESEND_API_URL: z.string().url().default('https://api.resend.com'),
  // Stage 5: reading replies (read-only) from the mailbox OUTREACH_REPLY_TO delivers to.
  IMAP_HOST: z.string().optional().default(''),
  IMAP_PORT: z.coerce.number().int().min(1).max(65535).default(993),
  /** TLS from the start (port 993). Set false only for a local test server. */
  IMAP_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  IMAP_USER: z.string().optional().default(''),
  /** An app password (Gmail, Outlook, Zoho…), never your main password. */
  IMAP_PASSWORD: z.string().optional().default(''),
  IMAP_MAILBOX: z.string().default('INBOX'),
  // Stage 6: optional AI drafting. Nothing is called unless the key is set and AI drafting is on in Settings.
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().regex(/^[a-z0-9.-]+$/).default('gemini-3.8-flash'),
  GEMINI_API_URL: z.string().url().default('https://generativelanguage.googleapis.com'),
  /**
   * Backup models, comma-separated, tried in order when GEMINI_MODEL is busy or out of quota. Empty: the agent picks
   * the newest Flash and Flash-Lite models your key can use (same free key).
   */
  GEMINI_FALLBACK_MODELS: z.string().regex(/^[a-z0-9.,\s-]*$/).optional().default(''),
  // Meta app (Instagram lookup, Instagram/Facebook inbox). Nothing is called until you switch a feature on in Settings.
  /** A long-lived Page access token for StockỌja's Facebook Page. Treat it like a password. */
  META_PAGE_ACCESS_TOKEN: z.string().optional().default(''),
  META_PAGE_ID: z.union([z.string().regex(/^\d+$/), z.literal('')]).optional().default(''),
  /** Optional: read from the Page when empty. */
  META_IG_USER_ID: z.union([z.string().regex(/^\d+$/), z.literal('')]).optional().default(''),
  /** Optional but recommended: every call then carries an appsecret_proof, so a leaked token alone is not enough. */
  META_APP_SECRET: z.string().optional().default(''),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v25.0'),
  META_GRAPH_URL: z.string().url().default('https://graph.facebook.com'),
  // Web search (optional). Each provider is used only when its key is set AND it is ticked in Settings.
  TAVILY_API_KEY: z.string().optional().default(''),
  TAVILY_API_URL: z.string().url().default('https://api.tavily.com'),
  BRAVE_SEARCH_API_KEY: z.string().optional().default(''),
  BRAVE_SEARCH_API_URL: z.string().url().default('https://api.search.brave.com'),
  // Telegram bot (optional): from @BotFather. Treat it like a password.
  TELEGRAM_BOT_TOKEN: z.union([z.string().regex(/^\d+:[\w-]{30,}$/), z.literal('')]).optional().default(''),
  TELEGRAM_API_URL: z.string().url().default('https://api.telegram.org'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  // Name the fields only; values may be secrets.
  console.error(`Invalid or missing settings in .env: ${fields}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

export const env = parsed.data;

/** The dashboard binds to loopback only; nothing on the network can reach it. */
export const HOST = '127.0.0.1';

export const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

export const userAgent = () =>
  `StockOjaSalesAgent/0.1 (local merchant research${env.CONTACT_EMAIL ? `; ${env.CONTACT_EMAIL}` : ''})`;
