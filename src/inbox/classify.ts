/**
 * Rule-based reply classification: free, predictable, and explainable (each label comes with the phrase that
 * triggered it). Anything unclear is labelled "other" and goes to you. You can correct any label in the Inbox.
 */

export const LABELS = ['interested', 'demo_request', 'question', 'not_interested', 'opt_out', 'auto_reply', 'other'] as const;
export type Label = (typeof LABELS)[number];

export interface Classification {
  label: Label;
  /** True when the text also asks something (an interested reply can still need an answer). */
  hasQuestion: boolean;
  reasons: string[];
}

type Rule = [RegExp, string];

const AUTO_SUBJECT: Rule[] = [
  [/\b(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|auto[- ]?response|on (annual )?leave|away from (the )?office|vacation)\b/i, 'auto-reply subject'],
  [/^(undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail)/i, 'delivery failure notice'],
];
const AUTO_BODY: Rule[] = [
  [/\b(i am|i'm|i will be) (currently )?(out of (the )?office|away|on leave)\b/i, 'away message'],
  [/\b(this is an automated (reply|response|message)|do not reply to this (email|message))\b/i, 'automated message'],
  [/\b(thank you for (your email|contacting us|reaching out)[,.]? (we|our team) (will|shall) (get back|respond|reply))/i, 'acknowledgement message'],
];

// Opt-out is checked on their own words only (quotes are stripped first). A false positive only means we stop.
const OPT_OUT: Rule[] = [
  [/^\s*(stop|unsubscribe|remove|stop\.|stop!)\s*$/im, '"STOP" on its own'],
  [/\bunsubscribe\b/i, '"unsubscribe"'],
  [/\b(remove|take) (me|us|my (email|number|address)|our (email|number|address))\b.{0,30}\b(from|off)\b/i, '"remove me from…"'],
  [/\b(do not|don't|dont|never) (contact|email|message|text|call|write to) (me|us)\b/i, '"don\'t contact me"'],
  [/\b(stop|quit) (sending|emailing|messaging|contacting|spamming)\b/i, '"stop sending"'],
  [/\bno more (emails|messages)\b/i, '"no more emails"'],
  [/\bopt(ed)?[- ]?out\b/i, '"opt out"'],
];
const NOT_INTERESTED: Rule[] = [
  [/\b(not|no longer|isn't|isnt|aren't) interested\b/i, '"not interested"'],
  [/\bno,? thanks?\b|\bno thank you\b/i, '"no thanks"'],
  [/\b(we|i) (already )?(use|have) (a|an|our own|another) (system|app|software|pos|tool|inventory)/i, 'already has a system'],
  [/\b(not for us|we('re| are) (ok|okay|fine|good)( for now)?|we don'?t need (it|this|that))\b/i, '"we don\'t need it"'],
  [/\b(no need|e no concern (me|us)|i no need am)\b/i, '"no need"'],
];
const DEMO: Rule[] = [
  [/\b(demo|walk ?through|show me how|show us how|presentation)\b/i, 'asks for a demo'],
  [/\b(call me|give me a call|phone me|let'?s (talk|speak|chat|meet)|book a (call|meeting|time)|schedule a (call|meeting))\b/i, 'asks for a call'],
  [/\b(when (are|can) (you|we) (meet|talk)|meet (up|in person))\b/i, 'asks to meet'],
];
const INTERESTED: Rule[] = [
  [/\b(i'?m|i am|we'?re|we are|very|quite|really|definitely) interested\b|\binterested in\b/i, '"interested"'],
  [/\b(sounds (good|great|interesting)|tell me more|send (me )?(more )?(details|info|information)|i('d| would) like to (try|know|start|see)|sign (me|us) up|let'?s (do it|go|start))\b/i, 'positive response'],
  [/\b(how (do|can) (i|we) (start|sign up|register|get started|join))\b/i, 'asks how to start'],
  [/\b(i dey interested|e go work|i go like|make we (try|start))\b/i, 'positive response (Pidgin)'],
  [/^\s*(yes|yes please|ok(ay)?|sure)[.!]*\s*$/im, 'short "yes"'],
  // Last, and safe because "not interested" is checked before any of these.
  [/\binterested\b/i, '"interested"'],
];
const QUESTION_WORDS = /^\s*(how|what|which|who|when|where|why|is|are|can|could|do|does|will|would|price|cost|abeg)\b/im;
const PRICE = /\b(how much|price|pricing|cost|fee|charge|subscription|per month|monthly|naira|₦)\b/i;

const first = (rules: Rule[], text: string) => rules.find(([re]) => re.test(text))?.[1] ?? null;

export function classify(input: { subject: string; text: string; autoHeaders?: string[] }): Classification {
  const text = input.text.trim();
  const subject = input.subject.trim();
  const hasQuestion = /\?/.test(text) || QUESTION_WORDS.test(text) || PRICE.test(text);
  const result = (label: Label, ...reasons: string[]): Classification => ({ label, hasQuestion, reasons });

  if (input.autoHeaders?.length) return result('auto_reply', `Auto-reply headers: ${input.autoHeaders.join(', ')}`);
  const autoS = first(AUTO_SUBJECT, subject);
  if (autoS) return result('auto_reply', autoS);
  // The List-Unsubscribe button sends an email with subject "unsubscribe".
  if (/^\s*(unsubscribe|stop)\s*$/i.test(subject)) return result('opt_out', `subject "${subject}"`);
  const opt = first(OPT_OUT, text);
  if (opt) return result('opt_out', opt);
  const autoB = first(AUTO_BODY, text);
  if (autoB) return result('auto_reply', autoB);
  if (!text) return result('other', 'empty reply');
  const no = first(NOT_INTERESTED, text);
  if (no) return result('not_interested', no);
  const demo = first(DEMO, text);
  if (demo) return result('demo_request', demo);
  const yes = first(INTERESTED, text);
  if (yes) return result('interested', yes);
  if (hasQuestion) return result('question', PRICE.test(text) ? 'asks about price' : 'asks a question');
  return result('other', 'no clear signal');
}

/** Splits a reply into the parts worth looking up in the knowledge base (questions first). */
export function questionsIn(text: string): string[] {
  const sentences = text
    .replace(/\n+/g, ' ')
    .split(/(?<=[?.!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
  const qs = sentences.filter((s) => /\?$/.test(s) || QUESTION_WORDS.test(s) || PRICE.test(s));
  return qs.length ? qs : sentences.slice(0, 3);
}
