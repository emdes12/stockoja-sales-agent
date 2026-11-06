import { simpleParser, type HeaderValue } from 'mailparser';

export interface InboundEmail {
  messageId: string | null;
  inReplyTo: string | null;
  from: string | null;
  subject: string;
  date: Date | null;
  /** Their new text only: quoted history and signatures removed. */
  text: string;
  /** Mail clients and servers mark auto-replies with these headers. */
  autoHeaders: string[];
}

/** Longest reply text kept. A sales reply is short; anything longer is mostly quoting. */
const MAX_TEXT = 5000;

/**
 * Cuts what they quoted from us (and anything after it). Our own outreach contains "reply STOP", so the quote
 * must go before classifying, or every reply would look like an opt-out.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (t.startsWith('>')) break;
    if (/^On .{4,200}wrote:?$/i.test(t)) break;
    // "On Mon, 3 Nov 2026 at 10:02, Ada <ada@x.ng>" + "wrote:" split over two lines (Gmail wraps it).
    if (/^On .{4,200}$/i.test(t) && /^.{0,120}wrote:?$/i.test(lines[i + 1]?.trim() ?? '') && /@|\d{4}/.test(t)) break;
    if (/^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}$/i.test(t)) break;
    if (/^_{8,}$/.test(t)) break; // Outlook separator before the quoted header block
    if (/^From:\s.+/i.test(t) && /^(Sent|Date|To):\s/i.test(lines[i + 1]?.trim() ?? '')) break;
    if (/^Sent from my (iPhone|iPad|Android|Samsung|BlackBerry|mobile)|^Get Outlook for /i.test(t)) break;
    if (t === '--' || t === '-- ') break; // signature delimiter
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
}

const headerText = (v: HeaderValue | undefined): string =>
  v === undefined ? '' : typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : typeof v === 'object' && v && 'value' in v ? String((v as { value: unknown }).value) : String(v);

export async function parseEmail(raw: Buffer | string): Promise<InboundEmail> {
  const m = await simpleParser(raw, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true });
  const auto: string[] = [];
  const autoSubmitted = headerText(m.headers.get('auto-submitted')).toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') auto.push(`Auto-Submitted: ${autoSubmitted}`);
  const precedence = headerText(m.headers.get('precedence')).toLowerCase();
  if (['bulk', 'auto_reply', 'junk', 'list'].includes(precedence)) auto.push(`Precedence: ${precedence}`);
  for (const h of ['x-autoreply', 'x-autorespond', 'x-auto-response-suppress']) {
    const v = headerText(m.headers.get(h));
    if (v && !(h === 'x-auto-response-suppress' && /^(none)?$/i.test(v))) auto.push(h);
  }
  const from = m.from?.value?.[0]?.address?.toLowerCase() ?? null;
  return {
    messageId: m.messageId ?? null,
    inReplyTo: typeof m.inReplyTo === 'string' ? m.inReplyTo : null,
    from,
    subject: (m.subject ?? '').trim(),
    date: m.date ?? null,
    text: stripQuoted(m.text ?? ''),
    autoHeaders: auto,
  };
}

/** "Re: Fwd: RE: Hello" → "hello", for matching a reply to the email it answers. */
export const baseSubject = (s: string | null | undefined) =>
  (s ?? '').replace(/^\s*((re|fw|fwd|aw|sv|tr)\s*(\[\d+\])?\s*:\s*)+/i, '').trim().toLowerCase();
