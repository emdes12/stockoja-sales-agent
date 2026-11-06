import { CATEGORIES, type Category } from '../discovery/catalog.js';
import type { Settings } from '../settings.js';
import { MAX_LENGTH, type Channel } from './channels.js';

export type { Channel } from './channels.js';
/** intro and follow-ups: outreach; reply: an answer to a message; message: one you write yourself from the Inbox. */
export type Step = 'intro' | 'followup_1' | 'followup_2' | 'reply' | 'message';
export type OutreachStep = Exclude<Step, 'reply' | 'message'>;

/** Placeholders a template may use, with what they mean (shown in the template editor). */
export const PLACEHOLDERS: Record<string, string> = {
  business_name: "The lead's business name",
  city: 'City, if known',
  in_city: '" in <city>", or nothing if the city is unknown',
  category_label: 'e.g. "Fashion & clothing"',
  category_label_lower: 'e.g. "fashion & clothing"',
  sender_name: 'Your name (Settings)',
  sender_title: 'Your role (Settings)',
  registration_link: 'Sign-up link with referral code and tracking tags',
  booking_line: 'Offers a demo: your booking link if set, otherwise asks them to reply. Never proposes times',
  booking_link: 'Your booking link (draft is blocked if not set)',
  tutorial_link: 'Your getting-started guide (draft is blocked if not set)',
  previous_subject: 'Subject of the earlier email (follow-ups)',
  interest_form_link: 'Your interest form (Settings → Interest form; draft is blocked if not set)',
  referral_link: "This merchant's personal interest-form link, for sharing with other vendors (needs personal referral links on)",
  personal_line: "One sentence about this shop from verified details (branches, where it sells online); empty when we know nothing specific",
};

/** Sign-up link tagged so a registration can be traced back to this lead and message. */
export function registrationLink(settings: Settings, channel: Channel, step: Step, leadId: number | null): string {
  const url = new URL(settings.registrationUrl);
  if (settings.referralCode) url.searchParams.set('ref', settings.referralCode);
  url.searchParams.set('utm_source', 'sales_agent');
  url.searchParams.set('utm_medium', channel);
  url.searchParams.set('utm_campaign', `outreach_${step}`);
  if (leadId !== null) url.searchParams.set('utm_content', `lead_${leadId}`);
  return url.toString();
}

export interface LeadForRender {
  id: number;
  business_name: string;
  category: Category;
  city: string | null;
}

export function buildVars(
  lead: LeadForRender,
  settings: Settings,
  channel: Channel,
  step: Step,
  extra: Record<string, string> = {},
): Record<string, string> {
  const label = CATEGORIES[lead.category]?.label ?? lead.category;
  const city = lead.city?.trim() ?? '';
  return {
    business_name: lead.business_name,
    city,
    in_city: city ? ` in ${city}` : '',
    category_label: label,
    category_label_lower: label.toLowerCase(),
    sender_name: settings.senderName,
    sender_title: settings.senderTitle,
    registration_link: registrationLink(settings, channel, step, lead.id),
    booking_line: settings.bookingUrl
      ? `If you'd like a short walkthrough, pick a time that suits you here: ${settings.bookingUrl}`
      : "If you'd like a short walkthrough, reply and we'll arrange a time that suits you.",
    booking_link: settings.bookingUrl,
    tutorial_link: settings.tutorialUrl,
    interest_form_link: settings.interestFormUrl,
    ...extra,
  };
}

/**
 * Fills {{placeholders}}. Any placeholder that is unknown or empty is reported as missing, and callers refuse
 * to create the message: a draft never goes out with a gap or a guessed value.
 */
const OPTIONAL = new Set(['in_city', 'city', 'personal_line']);

export function render(text: string, vars: Record<string, string>): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const out = text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined || (v === '' && !OPTIONAL.has(name))) {
      missing.add(name);
      return `{{${name}}}`;
    }
    return v;
  });
  return { text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), missing: [...missing] };
}

/**
 * Compliance checks on a message before approval. A first message (intro) must say how to opt out; after that the
 * STOP line is yours to include or leave out.
 */
export function complianceProblems(channel: Channel, subject: string | null, body: string, step: Step | null = 'intro'): string[] {
  const problems: string[] = [];
  if (/\{\{[^}]*\}\}/.test(body) || (subject && /\{\{[^}]*\}\}/.test(subject))) problems.push('It still contains an unfilled {{placeholder}}.');
  if (step === 'intro' && !/\bSTOP\b/.test(body)) problems.push('It needs an opt-out line (e.g. "reply STOP and we won\'t contact you again").');
  if (channel === 'email' && !subject?.trim()) problems.push('An email needs a subject.');
  if (body.length > MAX_LENGTH[channel]) problems.push(`It is too long for ${channel} (${body.length} of at most ${MAX_LENGTH[channel]} characters).`);
  return problems;
}

/** A Nigerian mobile number WhatsApp can reach (234 + 7/8/9 + 0/1 …), or null. */
export function whatsappNumber(phoneKey: string | null, socials: Record<string, string>): string | null {
  if (phoneKey && /^234[789][01]\d{8}$/.test(phoneKey)) return phoneKey;
  const wa = socials.whatsapp?.replace(/\D/g, '') ?? '';
  if (/^234\d{10}$/.test(wa)) return wa;
  if (/^0[789][01]\d{8}$/.test(wa)) return `234${wa.slice(1)}`;
  return null;
}

/** Click-to-chat link: opens WhatsApp with the text filled in; you press send yourself. */
export const waLink = (number: string, text: string) => `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
