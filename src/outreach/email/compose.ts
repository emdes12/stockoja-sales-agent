import { env } from '../../config.js';
import type { Settings } from '../../settings.js';
import type { OutgoingEmail } from './resend.js';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text → simple HTML: escaped, links clickable, paragraphs kept. No tracking pixels. */
export function textToHtml(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((p) =>
    escape(p)
      .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (url) => `<a href="${url}">${url}</a>`)
      .replace(/\n/g, '<br>'),
  );
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#17201c">${paragraphs
    .map((p) => `<p style="margin:0 0 14px">${p}</p>`)
    .join('')}</div>`;
}

/** Display name is a header field: strip anything that could break it. */
const displayName = (name: string) => name.replace(/["<>\r\n]/g, '').trim();

export interface EmailConfigProblem {
  field: string;
  message: string;
}

/** What is missing before real email can be sent. */
export function emailConfigProblems(settings: Settings): EmailConfigProblem[] {
  const p: EmailConfigProblem[] = [];
  if (!env.RESEND_API_KEY) p.push({ field: 'RESEND_API_KEY', message: 'Add your Resend API key to .env.' });
  if (!env.OUTREACH_FROM_ADDRESS) p.push({ field: 'OUTREACH_FROM_ADDRESS', message: 'Add the From address on your outreach subdomain to .env (e.g. hello@hello.stockoja.com).' });
  if (!env.OUTREACH_REPLY_TO) p.push({ field: 'OUTREACH_REPLY_TO', message: 'Add a mailbox you read to .env as OUTREACH_REPLY_TO; the sending subdomain cannot receive replies.' });
  if (!settings.senderName) p.push({ field: 'senderName', message: 'Set your name in Settings → Sender and links.' });
  return p;
}

export const fromDomain = () => env.OUTREACH_FROM_ADDRESS.split('@')[1] ?? '';

/** The exact email Resend receives for a message (also what a dry run records). */
export function composeEmail(
  msg: { id: number; lead_id: number | null; step: string | null; to_address: string; subject: string; body: string },
  settings: Settings,
  /** Message-ID of the email this answers, so it shows in the same conversation in their mail app. */
  inReplyTo: string | null = null,
): OutgoingEmail {
  const replyTo = env.OUTREACH_REPLY_TO || env.OUTREACH_FROM_ADDRESS;
  const thread: Record<string, string> = inReplyTo && /^<[^<>\s]+>$/.test(inReplyTo) ? { 'In-Reply-To': inReplyTo, References: inReplyTo } : {};
  return {
    from: `${displayName(settings.senderName) || 'StockOja'} <${env.OUTREACH_FROM_ADDRESS || 'not-configured@example.invalid'}>`,
    to: msg.to_address,
    replyTo,
    subject: msg.subject,
    text: msg.body,
    html: textToHtml(msg.body),
    // One-click unsubscribe by email (mail clients show an "Unsubscribe" button). Replies land in your mailbox.
    headers: { 'List-Unsubscribe': `<mailto:${replyTo}?subject=unsubscribe>`, ...thread },
    tags: [
      { name: 'source', value: 'sales_agent' },
      { name: 'lead_id', value: msg.lead_id === null ? 'none' : String(msg.lead_id) },
      { name: 'message_id', value: String(msg.id) },
      { name: 'step', value: msg.step ?? 'intro' },
    ],
    idempotencyKey: `stockoja-sales-msg-${msg.id}`,
  };
}
