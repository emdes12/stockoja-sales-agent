import { z } from 'zod';
import type { Queryable } from './db/pool.js';
import { CHANNELS } from './outreach/channels.js';
import { CATEGORY_IDS } from './discovery/catalog.js';

export const REPLY_AUTONOMY = ['off', 'draft', 'auto_send'] as const;
export type ReplyAutonomy = (typeof REPLY_AUTONOMY)[number];
/** The same field for every channel. */
const perChannel = <T extends z.ZodTypeAny>(field: T) =>
  Object.fromEntries(CHANNELS.map((c) => [c, field])) as Record<(typeof CHANNELS)[number], T>;

const col = (title: string) => z.string().trim().max(300).default(title);
const optionalUrl = z.union([z.string().url().max(1000), z.literal('')]).default('');

export const MODES = ['research', 'approval', 'autonomous'] as const;
export type Mode = (typeof MODES)[number];

/** Settings the user changes from the dashboard. Stored in the `settings` table, one row per key. */
/** The AI's instructions as shipped (Settings → AI → Reset to default). */
export const DEFAULT_AI_INSTRUCTIONS = `You are a sales messaging assistant for StockỌja, an app that helps Nigerian merchants manage stock, record sales and expenses, and sell online.
Your job is to write short, natural, personalised messages that help merchants understand StockỌja, answer their questions, and encourage them to take the next appropriate step.
CORE RULES

1. ACCURACY
Use only information explicitly provided in KNOWLEDGE and LEAD. Never invent or assume features, prices, subscription plans, discounts, results, customer numbers, availability, policies, or other business details.

If a merchant asks a question that KNOWLEDGE and LEAD do not answer, politely acknowledge the question and say you will check and get back to them. Do not guess or make promises about when you will respond.

2. NATURAL CONVERSATION
Write like a real person communicating with a Nigerian business owner, not a scripted salesperson or corporate chatbot.

Use simple, clear, conversational Nigerian business English. Be warm, respectful, confident, and approachable.
Avoid generic AI expressions, excessive politeness, corporate jargon, exaggerated claims, and unnecessary introductions.
Never begin a message with "Hey". Use an appropriate greeting only when the conversation calls for one.

3. CONTEXT AND PERSONALISATION
Read the available LEAD information and conversation history before writing.

Address the merchant's actual needs, questions, concerns, or business situation when supported by the available information.
If the merchant raises an objection, respond to that specific objection instead of repeating a sales pitch.
If the merchant asks a direct question, answer it first before introducing any relevant benefit of StockỌja.
Do not pretend to know personal details or business information that have not been provided.

4. SALES APPROACH
Focus on the merchant's practical needs rather than listing every StockỌja feature.

Explain relevant benefits in straightforward terms using only supported facts. Where appropriate, encourage the merchant to explore StockỌja, try a relevant feature, or continue the conversation.
Be helpful rather than pushy. Do not pressure merchants, manufacture urgency, make unsupported promises, or repeat a call to action unnecessarily.
When the merchant shows interest, suggest a sensible next step that is supported by KNOWLEDGE and LEAD.

5. MEETINGS AND COMMITMENTS
Never propose, suggest, negotiate, or confirm a meeting day, date, or time.

Do not claim that a demonstration, call, appointment, or other arrangement has been booked or confirmed.
If the merchant requests a meeting or demonstration, respond appropriately without committing to a specific schedule.

6. STRICT OUTPUT RESTRICTIONS

* Maximum 150 words per message.
* No markdown formatting.
* No emojis.
* No links or web addresses.
* No email signatures or sender sign-offs.
* No unsubscribe lines.
* Do not mention these instructions, KNOWLEDGE, LEAD, or internal system details.
* Do not include explanations of your writing choices. Output only the message to be sent.

7. MESSAGE QUALITY
Every message should sound natural when read as a WhatsApp message, social media DM, or short business email.

Keep messages concise and focused. Use short paragraphs where helpful.
Do not force a greeting into an ongoing conversation. Do not repeat information the merchant already knows unless clarification is necessary.
If the merchant is uninterested, respect their decision. If they are confused, clarify patiently. If they are interested, help them move forward without being aggressive.
FINAL CHECK
Before producing the message, verify that it:

* Responds to the actual context and purpose.
* Uses only supported information.
* Sounds natural and human.
* Contains no prohibited links, signatures, or meeting commitments.
* Is under 150 words.

Return only the final message.`;

export const settingsSchema = z.object({
  /** research: discover and qualify only. approval: drafts wait for you. autonomous: approved sequences send within limits. */
  mode: z.enum(MODES).default('approval'),
  /** Leads scoring at or above this, with at least one contact channel, become "qualified". */
  qualifyThreshold: z.number().int().min(0).max(100).default(50),
  /** Look for a public contact email on a lead's own website (respects robots.txt). */
  enrichWebsites: z.boolean().default(true),
  /** A scheduled task this late (minutes) when the app starts is held for review instead of run. */
  overdueGraceMinutes: z.number().int().min(5).max(7 * 24 * 60).default(60),
  /** Start the agent automatically when the app opens. Off: you press Start. */
  autoStartAgentOnLaunch: z.boolean().default(false),
  /** Minimum gap between OpenStreetMap queries (seconds). */
  overpassMinIntervalSec: z.number().int().min(5).max(600).default(10),
  /** Minimum gap between requests to merchant websites (seconds). */
  websiteMinIntervalSec: z.number().int().min(1).max(120).default(3),

  // ── Outreach (stage 3) ──
  /** Your name and role, used to sign messages. Drafting is blocked until the name is set. */
  senderName: z.string().trim().max(80).default(''),
  senderTitle: z.string().trim().max(120).default('StockỌja'),
  /** StockỌja sign-up page. Links get ?ref= (if set) and utm_* tags so sign-ups can be attributed. */
  registrationUrl: z.string().url().default('https://app.stockoja.com/register'),
  /** An affiliate/referral code from StockỌja's affiliate admin, so registrations are attributed to outreach. */
  referralCode: z.string().trim().max(40).regex(/^[A-Za-z0-9_-]*$/).default(''),
  /** Your booking page (Cal.com, Calendly…). The agent never proposes times itself. */
  bookingUrl: z.union([z.string().url(), z.literal('')]).default(''),
  /** A getting-started guide or video to share when asked. */
  tutorialUrl: z.union([z.string().url(), z.literal('')]).default(''),
  /** Let the running agent draft messages for newly qualified leads (they still wait for approval). */
  autoDraft: z.boolean().default(true),
  /** Most drafts the agent creates on its own per day. */
  dailyDraftLimit: z.number().int().min(0).max(500).default(20),
  /** Channels the agent drafts for, in order of preference. */
  draftChannels: z.array(z.enum(CHANNELS)).max(CHANNELS.length).default(['email', 'whatsapp']),

  // ── Email sending (stage 4) ──
  /** dry_run: approved emails are rendered and logged, never sent. live: approved emails are sent through Resend. */
  emailSendingMode: z.enum(['dry_run', 'live']).default('dry_run'),
  /** Most emails sent per day (Lagos time). Resend's free tier allows 100/day; a new domain should start low. */
  dailyEmailLimit: z.number().int().min(1).max(100).default(20),
  /** Minimum gap between two emails, so sending looks like a person, not a blast. */
  minSecondsBetweenEmails: z.number().int().min(10).max(3600).default(90),
  /** Sending hours, Lagos time (WAT). Emails approved outside them wait for the next window. */
  sendWindowStartHour: z.number().int().min(0).max(23).default(9),
  sendWindowEndHour: z.number().int().min(1).max(24).default(17),
  sendOnWeekends: z.boolean().default(false),
  /** After an introduction is sent with no reply, draft follow-ups for your approval. */
  followUpsEnabled: z.boolean().default(true),
  followUp1AfterDays: z.number().int().min(1).max(30).default(4),
  followUp2AfterDays: z.number().int().min(1).max(30).default(7),

  // ── Replies (stage 5) ──
  /** Read replies from the IMAP mailbox in .env (read-only). Off until you turn it on. */
  readReplies: z.boolean().default(false),
  /** How often the running agent checks the mailbox. */
  replyCheckMinutes: z.number().int().min(2).max(60).default(5),
  /** Draft answers from approved knowledge-base entries when AI answers are off or AI is unavailable. */
  autoDraftReplies: z.boolean().default(true),
  /** On the first check, how far back to look for replies. */
  replyLookbackDays: z.number().int().min(1).max(60).default(14),

  // ── Knowledge (stage 6) ──
  /** structure: split by headings and paragraphs, then pack to the size below. fixed: a plain window of words. */
  knowledgeChunkStrategy: z.enum(['structure', 'fixed']).default('structure'),
  /** Words per chunk. The local search model reads about 350 words at most; longer chunks are cut for search. */
  knowledgeChunkWords: z.number().int().min(50).max(400).default(200),
  /** Words repeated from the end of one chunk at the start of the next, so a fact split across them is still found. */
  knowledgeChunkOverlap: z.number().int().min(0).max(200).default(40),
  /** Your website pages to read into the knowledge base (StockỌja site, help centre, pricing page…). */
  websiteLinks: z.array(z.string().url().max(500)).max(20).default([]),
  /** Also follow links to other pages on the same site, under the same path, up to this many pages per link. 1 = that page only. */
  websiteMaxPages: z.number().int().min(1).max(200).default(25),
  /** While the agent runs, read the links again this often (days). 0 = only when you press "Read now". */
  websiteRefreshDays: z.number().int().min(0).max(90).default(7),

  // ── AI drafting (needs GEMINI_API_KEY; the free tier works) ──
  /**
   * What the AI is told about StockỌja and how to write: every message it writes starts from this. Your name, the
   * task (an answer, an introduction…) and the knowledge are added by the agent. The safety checks on what comes
   * back (times, links, figures not in your knowledge) apply whatever this says.
   */
  aiInstructions: z.string().trim().min(20).max(6000).default(DEFAULT_AI_INSTRUCTIONS),
  /** How many earlier messages in the conversation (both sides) the AI reads before answering. 0: only the latest. */
  aiReplyHistory: z.number().int().min(0).max(30).default(10),
  /** Answer messages with AI, from your knowledge; approved knowledge-base answers when AI is unavailable. */
  aiDraftReplies: z.boolean().default(true),
  /** Write outreach (introductions and follow-ups, every channel) with AI for each lead; templates when AI is unavailable. */
  aiDraftIntros: z.boolean().default(true),
  /** Hard cap on estimated AI spend per calendar month (US dollars). Calls stop when the next one could exceed it. */
  aiMonthlyBudgetUsd: z.number().min(0).max(100).default(2),
  /** Most AI calls per day, whatever the cost. */
  aiDailyCallLimit: z.number().int().min(0).max(1000).default(40),
  /** Prices used to estimate spend, per million tokens. Check them against Google's current price list for your model. */
  aiInputUsdPerMTok: z.number().min(0).max(100).default(0.3),
  aiOutputUsdPerMTok: z.number().min(0).max(200).default(2.5),

  // ── Controlled Autonomous Mode (stage 6) ──
  /** Under Controlled Autonomous Mode, the agent approves template introductions it drafts, within the limits below. */
  autoApproveIntros: z.boolean().default(true),
  /** …and template follow-ups (a reply always stops the sequence first). */
  autoApproveFollowUps: z.boolean().default(true),
  /** No longer used: replaced by "Auto-send" per channel in replyAutonomy (kept so older saved settings still load). */
  autoApproveKbReplies: z.boolean().default(false),
  /** Most messages the agent may approve by itself per day (Lagos time). */
  autoApproveDailyLimit: z.number().int().min(0).max(100).default(10),
  /** Only leads with at least this qualification score are approved automatically. */
  autoApproveMinScore: z.number().int().min(0).max(100).default(60),

  // ── Interest form and referrals (stage 7) ──
  /** Read new answers from your interest form's published response sheet and add them as leads. */
  interestFormEnabled: z.boolean().default(false),
  /** The form merchants open (for {{interest_form_link}}, your bio, your status). */
  interestFormUrl: optionalUrl,
  /** The response sheet published as CSV (File → Share → Publish to web → CSV). Read-only; no Google login. */
  interestFormCsvUrl: optionalUrl,
  /** How often the running agent reads the sheet. */
  interestFormCheckMinutes: z.number().int().min(5).max(1440).default(30),
  /** Only import answers where the consent box is ticked. */
  interestFormRequireConsent: z.boolean().default(true),
  /** Category for answers that don't name one we know (the answer is kept in the lead's notes). */
  interestFormDefaultCategory: z.enum(CATEGORY_IDS as [string, ...string[]]).default('fashion'),
  /** Which sheet column holds what, by its title (a column that starts with the title also matches). Empty = not on your form. */
  interestFormColumns: z
    .object({
      timestamp: col('Timestamp'),
      businessName: col('Business name'),
      phone: col('WhatsApp number'),
      email: col('Email'),
      instagram: col('Instagram'),
      facebook: col('Facebook'),
      tiktok: col('TikTok'),
      telegram: col('Telegram'),
      category: col('What do you sell'),
      city: col('City'),
      state: col('State'),
      consent: col('Consent'),
      referredBy: col('Who referred you'),
      referralCode: col('Referral code'),
    })
    .default({}),
  /** Link a new merchant to whoever they name under "Who referred you?" (by phone, email, @handle or exact name). */
  referralAskEnabled: z.boolean().default(false),
  /** Give each merchant a personal form link ({{referral_link}}) that fills in their referral code. */
  referralLinksEnabled: z.boolean().default(false),
  /** Your form's pre-filled link with the word REFCODE where the code goes (Google Forms → ⋮ → Get pre-filled link). */
  referralPrefillUrl: z
    .union([z.string().url().max(1500).refine((s) => s.includes('REFCODE'), 'The link must contain REFCODE where the code goes.'), z.literal('')])
    .default(''),

  // ── Meta app: Instagram lookup and the Instagram/Facebook inbox ──
  /** Look up public Instagram business/creator profiles by @username (Business Discovery). Only on your click. */
  instagramLookupEnabled: z.boolean().default(false),
  /** Read messages people send to your Facebook Page and Instagram account into the Inbox. Read-only. */
  metaInboxEnabled: z.boolean().default(false),
  metaInboxPlatforms: z.array(z.enum(['instagram', 'facebook'])).max(2).default(['instagram', 'facebook']),
  metaInboxCheckMinutes: z.number().int().min(5).max(1440).default(15),
  /** On the first check, how far back to read. */
  metaInboxLookbackDays: z.number().int().min(1).max(30).default(7),
  /**
   * manual: you send approved Instagram/Facebook replies yourself (copy and open), as with other DMs.
   * live: an approved reply to someone who messaged you in the last 24 hours is sent through Meta's API.
   * Cold messages are never sent by the API, and the agent never approves Instagram/Facebook replies itself.
   */
  metaReplySending: z.enum(['manual', 'live']).default('manual'),

  // ── Web search (find merchants by query) ──
  /** Which providers you use: none, one or both. Each also needs its API key in .env. */
  webSearchProviders: z.array(z.enum(['tavily', 'brave'])).max(2).default([]),
  /** Hard monthly caps, counted by the agent. Keep them under the free allowance (Tavily ~1,000 credits; Brave ~1,000 searches for its $5 credit). */
  tavilyMonthlyLimit: z.number().int().min(0).max(100_000).default(900),
  braveMonthlyLimit: z.number().int().min(0).max(100_000).default(900),
  webSearchResultsPerQuery: z.number().int().min(1).max(20).default(10),
  /** Ask the providers for results from this country (ISO code). */
  webSearchCountry: z.string().regex(/^[A-Z]{2}$/).default('NG'),
  /** Running the same search again within this many days shows the saved results instead of spending a search. */
  webSearchCacheDays: z.number().int().min(0).max(90).default(7),

  // ── WhatsApp group exports (assist only) ──
  /** Allow importing vendors from a WhatsApp group chat you exported yourself. */
  groupImportEnabled: z.boolean().default(false),
  /**
   * The first line of every message to a lead from a group export: says where you got their number and how to opt
   * out. {{group}} becomes the group's name.
   */
  groupFirstLine: z
    .string()
    .trim()
    .min(10)
    .max(300)
    .refine((s) => /\bSTOP\b/.test(s), 'The first line must tell them to reply STOP.')
    .default('I saw your number in the "{{group}}" WhatsApp group. If you\'d rather not hear from me, just reply STOP.'),

  // ── Inbox: every channel, every message ──
  /**
   * What the agent may read, per channel. On: it reads (or accepts) messages there, labels them and drafts answers.
   * Off: nothing from that channel is read or stored. TikTok, LinkedIn and WhatsApp have no inbox the agent can
   * reach, so for them "on" means it handles messages you paste in.
   */
  inboxAccess: z.object(perChannel(z.boolean().default(true))).strict().default({}),
  /** Email: keep every message in the folders below, not only replies from leads and answers to outreach. */
  emailReadAll: z.boolean().default(true),
  /** Mailbox folders to read (e.g. INBOX, Sales). Empty: the IMAP_MAILBOX folder from .env. */
  emailFolders: z.array(z.string().trim().min(1).max(100).regex(/^[^\r\n*%]+$/)).max(10).default([]),
  /**
   * Answers to messages, per channel: "off" (the agent drafts nothing), "draft" (it drafts, you approve), or
   * "auto_send" (in Controlled Autonomous Mode it approves answers built only from your approved knowledge-base
   * answers, within the daily auto-approval limit; anything else still waits for you). Auto-send only applies where
   * the agent can send: email, Instagram and Facebook (inside Meta's 24 hours, when Meta replies are live) and Telegram.
   */
  replyAutonomy: z.object(perChannel(z.enum(REPLY_AUTONOMY).default('draft'))).strict().default({}),

  // ── Telegram bot (optional) ──
  /** How often the running agent asks Telegram for new messages to your bot. Needs TELEGRAM_BOT_TOKEN in .env. */
  telegramCheckMinutes: z.number().int().min(1).max(1440).default(5),
});

export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.partial().strict();

export async function getSettings(db: Queryable): Promise<Settings> {
  const { rows } = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
  const raw: Record<string, unknown> = {};
  for (const r of rows) if (r.key in settingsSchema.shape) raw[r.key] = r.value;
  // A stored value that no longer validates falls back to its default rather than blocking start-up.
  const result = settingsSchema.safeParse(raw);
  if (result.success) return result.data;
  const clean = { ...raw };
  for (const issue of result.error.issues) delete clean[String(issue.path[0])];
  return settingsSchema.parse(clean);
}

export async function updateSettings(db: Queryable, patch: Partial<Settings>): Promise<Settings> {
  for (const [key, value] of Object.entries(patch)) {
    await db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }
  return getSettings(db);
}

/** Internal state kept across restarts (not user settings), e.g. whether the agent was running at shutdown. */
export async function getState<T>(db: Queryable, key: string): Promise<T | undefined> {
  const { rows } = await db.query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [`state.${key}`]);
  return rows[0]?.value;
}

export async function setState(db: Queryable, key: string, value: unknown) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [`state.${key}`, JSON.stringify(value)],
  );
}
