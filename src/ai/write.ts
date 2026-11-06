import type { Db } from '../db/pool.js';
import type { Settings } from '../settings.js';
import type { LeadRow } from '../leads/leads.js';
import { CATEGORIES } from '../discovery/catalog.js';
import { searchKb, type KbEntry } from '../outreach/kb.js';
import { assertContactable, createDraft, OutreachError, withGroupFirstLine, type MessageRow } from '../outreach/messages.js';
import { buildVars, type OutreachStep } from '../outreach/render.js';
import { CHANNEL_LABEL, MAX_LENGTH, type Channel } from '../outreach/channels.js';
import { aiConfigured } from './gemini.js';
import { searchKnowledge, type SearchHit } from '../knowledge/store.js';
import { generateResilient } from './gemini.js';
import { assertAiAllowed, recordAiCall } from './budget.js';

/**
 * AI drafting, grounded in your knowledge. The model sees only: approved knowledge-base answers, the most relevant
 * chunks of your documents and website, and the lead's business details (name, category, city; never phone numbers
 * or email addresses). Links, the signature and the opt-out line are added by the agent, not the model. Every AI
 * draft is checked (times, links, figures). Outreach written by AI always waits for your approval; an AI answer to a
 * message may be sent automatically only on a channel you set to auto-send, and only with no warnings.
 */

export interface AiWarning {
  code: 'time' | 'link' | 'figures' | 'placeholder';
  text: string;
  /** Blocking warnings must be fixed (by editing the draft) before it can be approved. */
  blocking: boolean;
}

export interface AiSources {
  knowledge: Array<{ chunkId: number; sourceId: number; title: string; heading: string | null }>;
  kb: Array<{ id: number; question: string }>;
  warnings: AiWarning[];
  model?: string;
  usd?: number;
}

const MAX_OUTPUT_TOKENS = 1200;

/** Your instructions (Settings → AI), who you write as, and the task at hand. */
const systemPrompt = (settings: Settings, extra: string) =>
  `${settings.aiInstructions.trim()}

You write on behalf of ${settings.senderName}${settings.senderTitle ? `, ${settings.senderTitle}` : ''}.

FOR THIS MESSAGE
${extra}`;

/** One earlier message in the conversation, for the AI to read. */
export interface ChatLine {
  from: 'them' | 'you';
  text: string;
}

function contextBlock(knowledge: SearchHit[], kb: KbEntry[]) {
  const parts: string[] = [];
  kb.forEach((e, i) => parts.push(`[A${i + 1}] Approved answer. Q: ${e.question}\nA: ${e.answer}`));
  knowledge.forEach((h, i) => parts.push(`[D${i + 1}] From "${h.title}"${h.heading ? ` (${h.heading})` : ''}:\n${h.content}`));
  return parts.length ? parts.join('\n\n') : '(no knowledge found for this; do not state facts about StockỌja beyond the one-line description above)';
}

function leadBlock(lead: LeadRow | null) {
  if (!lead) return 'Not a lead yet: someone who wrote to StockỌja. Nothing is known about their business.';
  const label = CATEGORIES[lead.category as keyof typeof CATEGORIES]?.label ?? lead.category;
  const safeFacts = (lead.facts ?? [])
    .filter((f) => !/email|phone|address|whatsapp|person/i.test(f.label))
    .slice(0, 8)
    .map((f) => `${f.label}: ${f.value}`);
  return [`Business: ${lead.business_name}`, `Category: ${label}`, lead.city ? `City: ${lead.city}` : null, lead.state ? `State: ${lead.state}` : null, ...safeFacts]
    .filter(Boolean)
    .join('\n');
}

/** Checks AI text for things the agent must not let through unnoticed. Pure; tested. */
export function reviewAiText(text: string, context: string): AiWarning[] {
  const w: AiWarning[] = [];
  const time = text.match(/\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\btomorrow\b|\bnext week\b|\bthis (morning|afternoon|evening)\b/i);
  if (time) w.push({ code: 'time', text: `It names a day or time ("${time[0]}"). The agent never proposes times; edit it out or confirm it yourself.`, blocking: true });
  const link = text.match(/https?:\/\/\S+|\bwww\.\S+/i);
  if (link) w.push({ code: 'link', text: `It contains a link the agent did not add (${link[0]}).`, blocking: true });
  const ph = text.match(/\[[^\]\n]{2,40}\]/);
  if (ph) w.push({ code: 'placeholder', text: `It contains a placeholder (${ph[0]}).`, blocking: true });
  const ctx = context.replace(/,/g, '');
  const figures = [...new Set((text.match(/[₦$]\s?\d[\d,.]*|\b\d[\d,.]*\s?(%|k\b|naira\b)|\b\d{2,}[\d,.]*/gi) ?? []).map((f) => f.trim()))].filter((f) => {
    const digits = f.replace(/[^\d.]/g, '').replace(/\.$/, '');
    return digits && !ctx.includes(digits);
  });
  if (figures.length) w.push({ code: 'figures', text: `Check these figures; they are not in your knowledge: ${figures.join(', ')}.`, blocking: false });
  return w;
}

async function gather(db: Db, query: string) {
  const [knowledge, kbHits] = await Promise.all([searchKnowledge(db, query, { limit: 6 }), searchKb(db, query)]);
  const kb = kbHits.map((h) => h.entry);
  return { knowledge: knowledge.hits, kb };
}

/**
 * AI calls take turns, even when several kinds of task run at once, so the daily limit and monthly cap are checked
 * against every call before it (two lanes can't both slip under the limit).
 */
let aiTurn: Promise<unknown> = Promise.resolve();

async function callAi(db: Db, settings: Settings, system: string, prompt: string, purpose: string, json = false) {
  const turn = aiTurn.then(async () => {
    await assertAiAllowed(db, settings, system.length + prompt.length, MAX_OUTPUT_TOKENS);
    const r = await generateResilient({ system, prompt, maxOutputTokens: MAX_OUTPUT_TOKENS, json });
    return { r, usd: await recordAiCall(db, settings, r, purpose) };
  });
  aiTurn = turn.catch(() => {});
  const { r, usd } = await turn;
  if (!r.text) throw new OutreachError('AI_FAILED', `Gemini returned no text${r.finishReason ? ` (${r.finishReason})` : ''}. Try again or write it yourself.`);
  return { ...r, usd };
}

const tidy = (s: string) =>
  s
    .replace(/\*\*|__|^#+\s*/gm, '')
    .replace(/^.*\breply stop\b.*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** The middle of a reply email: the answer to what they wrote. */
export async function writeReplyAnswer(db: Db, settings: Settings, input: { lead: LeadRow | null; inbound: string; label: string; history?: ChatLine[] }) {
  const { knowledge, kb } = await gather(db, input.inbound);
  const history = input.history ?? [];
  const context = contextBlock(knowledge, kb);
  const system = systemPrompt(
    settings,
    [
      '- Write only the answer paragraphs: no greeting ("Hello"), no sign-off. A greeting, links and signature are added around your text.',
      ...(history.length ? ['- Read the conversation so far. Answer their latest message in that light: do not repeat what was already said, and do not introduce StockỌja again if you already did.'] : []),
    ].join('\n'),
  );
  const chat = history.length
    ? `\n\nCONVERSATION SO FAR (oldest first; "You" is us):\n${history.map((h) => `${h.from === 'you' ? 'You' : 'Them'}: ${h.text.replace(/\s+/g, ' ').slice(0, 800)}`).join('\n')}`
    : '';
  const prompt = `KNOWLEDGE:\n${context}\n\nLEAD:\n${leadBlock(input.lead)}${chat}\n\nTHEIR LATEST MESSAGE (classified as: ${input.label}):\n"""\n${input.inbound.slice(0, 4000)}\n"""\n\nWrite the answer to their latest message.`;
  const r = await callAi(db, settings, system, prompt, 'draft_reply');
  const text = tidy(r.text);
  const sources: AiSources = {
    knowledge: knowledge.map((h) => ({ chunkId: h.chunkId, sourceId: h.sourceId, title: h.title, heading: h.heading })),
    kb: kb.map((e) => ({ id: e.id, question: e.question })),
    warnings: reviewAiText(text, `${context}\n${leadBlock(input.lead)}\n${input.inbound}`),
    model: r.model,
    usd: Number(r.usd.toFixed(6)),
  };
  return { text, sources };
}

/** Words to aim for per channel, so the finished message (with link, name and opt-out) fits the platform. */
const WORDS: Record<Channel, number> = { email: 140, whatsapp: 80, instagram: 60, facebook: 80, tiktok: 60, telegram: 90, linkedin: 90 };

const STEP_BRIEF: Record<OutreachStep, string> = {
  intro: 'This is a first, unsolicited introduction: be brief and specific to their kind of business, with one clear benefit and a soft invitation to try it.',
  followup_1: 'This is a short, polite follow-up to your earlier message (under PREVIOUS), which got no answer. Add one new, specific benefit; do not repeat the earlier wording or guilt them.',
  followup_2: 'This is a last, very short follow-up. Say you will not keep messaging, and leave the door open. No pressure.',
};

/**
 * An outreach message written by AI for one lead, on any channel and step: an introduction, or a follow-up that
 * builds on what was already sent. Same guards as a template draft (mode, do-not-contact, one live message per lead,
 * channel and step; a follow-up needs a sent introduction). The agent adds the sign-up link, booking line, your name
 * and the opt-out; the model never writes links. Waits for your approval.
 */
export async function createAiDraft(
  db: Db,
  leadId: number,
  channel: Channel,
  settings: Settings,
  opts: { step?: OutreachStep; createdBy?: 'agent' | 'user' } = {},
): Promise<MessageRow> {
  const step = opts.step ?? 'intro';
  const createdBy = opts.createdBy ?? 'user';
  const lead = (await db.query<LeadRow>('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
  if (!lead) throw new OutreachError('NOT_FOUND', 'Lead not found');
  if (!settings.senderName) throw new OutreachError('NO_SENDER', 'Set your name under Settings → Sender and links before drafting.');
  const to = await assertContactable(db, lead, channel, settings);
  const live = await db.query(
    `SELECT 1 FROM messages WHERE lead_id = $1 AND channel = $2 AND step = $3 AND direction = 'outbound' AND status NOT IN ('rejected', 'cancelled', 'failed')`,
    [leadId, channel, step],
  );
  if (live.rowCount) throw new OutreachError('ALREADY_EXISTS', `There is already a ${CHANNEL_LABEL[channel]} ${step.replace('_', ' ')} for this lead.`);
  const previous = step === 'intro' ? [] : (await db.query<{ subject: string | null; body: string }>(
    `SELECT subject, body FROM messages WHERE lead_id = $1 AND channel = $2 AND direction = 'outbound' AND status = 'sent' ORDER BY sent_at`,
    [leadId, channel],
  )).rows;
  if (step !== 'intro' && !previous.length) throw new OutreachError('NO_INTRO', 'A follow-up needs a sent introduction first.');

  const label = CATEGORIES[lead.category as keyof typeof CATEGORIES]?.label ?? lead.category;
  const { knowledge, kb } = await gather(db, `How StockỌja helps ${label} businesses: inventory, stock, sales, expenses, online store`);
  const context = contextBlock(knowledge, kb);
  const isEmail = channel === 'email';
  const greeting = isEmail ? `Start with "Hello ${lead.business_name} team,".` : `Start with a short greeting to ${lead.business_name}.`;
  const format = isEmail
    ? 'Reply with a JSON object: {"subject": "...", "body": "..."}. The subject is under 60 characters, not salesy, no emojis.'
    : `Reply with the message text only. It is a ${CHANNEL_LABEL[channel]} direct message: conversational, short paragraphs.`;
  const system = systemPrompt(settings, `- ${STEP_BRIEF[step]}\n- ${greeting}\n- At most ${WORDS[channel]} words.\n- ${format}`);
  const prev = previous.length ? `\n\nPREVIOUS (what you already sent them, oldest first):\n${previous.map((m) => `"""\n${m.body.slice(0, 1500)}\n"""`).join('\n')}` : '';
  const prompt = `KNOWLEDGE:\n${context}\n\nLEAD:\n${leadBlock(lead)}${prev}\n\nWrite the ${step === 'intro' ? 'introduction' : 'follow-up'} ${isEmail ? 'email' : 'message'}.`;
  const r = await callAi(db, settings, system, prompt, `draft_${step}_${channel}`, isEmail);

  let subject: string | null = null;
  let middle: string;
  if (isEmail) {
    let parsed: { subject?: unknown; body?: unknown };
    try {
      parsed = JSON.parse(r.text.replace(/^```(json)?|```$/g, '').trim());
    } catch {
      throw new OutreachError('AI_FAILED', 'Gemini did not return the expected format. Try again, or use the template.');
    }
    subject = typeof parsed.subject === 'string' ? parsed.subject.replace(/\s+/g, ' ').trim().slice(0, 150) : '';
    middle = typeof parsed.body === 'string' ? tidy(parsed.body) : '';
    if (step !== 'intro' && previous[0]?.subject) subject = `Re: ${previous[0].subject.replace(/^Re:\s*/i, '')}`;
    if (!subject) throw new OutreachError('AI_FAILED', 'Gemini returned an empty subject. Try again, or use the template.');
  } else {
    middle = tidy(r.text.replace(/^```\w*|```$/g, ''));
  }
  if (!middle) throw new OutreachError('AI_FAILED', 'Gemini returned an empty message. Try again, or use the template.');

  const vars = buildVars(lead, settings, channel, step);
  // The opt-out line goes on the first message only.
  const footer = step !== 'intro' ? '' : isEmail
    ? `You're receiving this because ${lead.business_name} is publicly listed as a business. If you'd rather not hear from us, reply STOP and we won't contact you again.`
    : "If you'd rather I didn't message you again, just reply STOP.";
  const link = isEmail ? `You can try StockỌja free here: ${vars.registration_link}` : `Try it free: ${vars.registration_link}`;
  const signature = isEmail ? `${settings.senderName}\n${settings.senderTitle}`.trim() : settings.senderName;
  let body = [middle, link, isEmail ? vars.booking_line : '', signature, footer].filter(Boolean).join('\n\n');
  if (lead.group_source && step === 'intro') body = withGroupFirstLine(body, lead.group_source, settings);
  if (body.length > MAX_LENGTH[channel]) throw new OutreachError('AI_TOO_LONG', `The AI message is too long for ${CHANNEL_LABEL[channel]}; the template was used instead.`);

  const sources: AiSources = {
    knowledge: knowledge.map((h) => ({ chunkId: h.chunkId, sourceId: h.sourceId, title: h.title, heading: h.heading })),
    kb: kb.map((e) => ({ id: e.id, question: e.question })),
    warnings: reviewAiText(`${subject ?? ''}\n${middle}`, `${context}\n${leadBlock(lead)}${prev}`),
    model: r.model,
    usd: Number(r.usd.toFixed(6)),
  };
  try {
    const { rows } = await db.query<MessageRow>(
      `INSERT INTO messages (lead_id, channel, step, to_address, subject, body, original_body, status, created_by, ai_generated, ai_sources, status_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $6, 'draft', $7, true, $8, 'Written by AI for this lead: check the facts before approving')
       RETURNING *`,
      [leadId, channel, step, to, subject, body, createdBy, JSON.stringify(sources)],
    );
    return rows[0]!;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new OutreachError('ALREADY_EXISTS', `There is already a ${CHANNEL_LABEL[channel]} ${step.replace('_', ' ')} for this lead.`);
    throw err;
  }
}

/** An introduction email written by AI (the "Write with AI" button on a lead). */
export const createAiIntro = (db: Db, leadId: number, settings: Settings, createdBy: 'agent' | 'user' = 'user') =>
  createAiDraft(db, leadId, 'email', settings, { step: 'intro', createdBy });

/**
 * The draft the agent makes for outreach: written by AI for this lead when AI drafting is on and Gemini answers
 * (after retries and backup models); otherwise from your templates, marked with why, so outreach never stalls.
 */
export async function draftOutreach(
  db: Db,
  leadId: number,
  channel: Channel,
  settings: Settings,
  opts: { step?: OutreachStep; createdBy?: 'agent' | 'user'; useAi?: boolean; onAiError?: (err: OutreachError) => void } = {},
): Promise<MessageRow> {
  let why: string | null = null;
  if ((opts.useAi ?? true) && settings.aiDraftIntros && aiConfigured()) {
    try {
      return await createAiDraft(db, leadId, channel, settings, opts);
    } catch (err) {
      if (!(err instanceof OutreachError) || !err.code.startsWith('AI_')) throw err;
      why = err.message;
      opts.onAiError?.(err);
    }
  }
  const msg = await createDraft(db, leadId, channel, settings, opts);
  if (!why) return msg;
  const { rows } = await db.query<MessageRow>(`UPDATE messages SET status_reason = $2 WHERE id = $1 RETURNING *`, [msg.id, `Template used: ${why}`]);
  return rows[0]!;
}
