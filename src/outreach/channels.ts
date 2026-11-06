/**
 * The channels the agent drafts for. Email is sent by the agent (through Resend); every other channel is sent by
 * you: the agent drafts, you approve, then open the chat, paste or confirm the text, press send, and record it.
 * No social account is ever logged in to or automated.
 */
export const CHANNELS = ['email', 'whatsapp', 'instagram', 'facebook', 'tiktok', 'telegram', 'linkedin'] as const;
export type Channel = (typeof CHANNELS)[number];

export const SOCIAL_CHANNELS = ['instagram', 'facebook', 'tiktok', 'telegram', 'linkedin'] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];
export const isSocial = (c: string): c is SocialChannel => (SOCIAL_CHANNELS as readonly string[]).includes(c);

/** Channels you send yourself. */
export const isManual = (c: Channel) => c !== 'email';

export const CHANNEL_LABEL: Record<Channel, string> = {
  email: 'Email',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  telegram: 'Telegram',
  linkedin: 'LinkedIn',
};

/** Longest message we draft per channel (each platform's limit, or a sensible size for a first message). */
export const MAX_LENGTH: Record<Channel, number> = {
  email: 8000,
  whatsapp: 1500,
  instagram: 1000,
  facebook: 2000,
  tiktok: 1000,
  telegram: 4000,
  linkedin: 1900,
};

const HANDLE: Record<SocialChannel, RegExp> = {
  instagram: /^[a-z0-9._]{1,30}$/,
  facebook: /^([a-z0-9.]{5,50}|\d{5,20})$/,
  tiktok: /^[a-z0-9._]{2,24}$/,
  telegram: /^[a-z][a-z0-9_]{4,31}$/,
  /** A person (in/<slug>) or a company page (company/<slug>), kept with its prefix. */
  linkedin: /^(in|company)\/[a-z0-9_%-]{2,100}$/,
};
const HOSTS: Record<SocialChannel, string[]> = {
  instagram: ['instagram.com', 'instagr.am', 'ig.me'],
  facebook: ['facebook.com', 'fb.com', 'm.me', 'fb.me'],
  tiktok: ['tiktok.com'],
  telegram: ['t.me', 'telegram.me'],
  linkedin: ['linkedin.com'],
};
/** Paths on those sites that are not a business's profile. */
const NOT_PROFILES = new Set([
  'p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct', 'tv', // instagram
  'groups', 'marketplace', 'share', 'watch', 'events', 'hashtag', 'login', 'photo', 'photos', 'story.php', 'sharer', // facebook
  'video', 'tag', 'discover', 'music', // tiktok
  'joinchat', 's', 'c', 'addstickers', 'share', // telegram
]);

/**
 * The username on a platform, from a profile link or "@name", lower-cased. Null when it isn't a profile
 * (a post, a group, an invite link…) or doesn't look like a username on that platform.
 */
export function socialHandle(channel: SocialChannel, raw: string | null | undefined): string | null {
  let v = raw?.trim();
  if (!v) return null;
  if (/[/.]/.test(v) && /(^https?:\/\/)|(\.(com|me|am)\b)/i.test(v)) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^(www|m|mobile|web)\./, '');
    if (!HOSTS[channel].some((h) => host === h || host.endsWith(`.${h}`))) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (channel === 'facebook' && parts[0] === 'profile.php') {
      v = url.searchParams.get('id') ?? '';
    } else if (channel === 'linkedin') {
      v = parts[0] === 'in' || parts[0] === 'company' ? `${parts[0]}/${parts[1] ?? ''}` : '';
    } else if (channel === 'facebook' && parts[0] === 'pages') {
      v = parts.find((p) => /^\d{5,20}$/.test(p)) ?? '';
    } else {
      if (host === 'ig.me' && parts[0] === 'm') parts.shift();
      v = parts[0] ?? '';
      if (NOT_PROFILES.has(v.toLowerCase())) return null;
    }
  }
  const handle = decodeURIComponent(v).replace(/^@/, '').toLowerCase();
  return HANDLE[channel].test(handle) ? handle : null;
}

/** The link that opens a chat with them. Only WhatsApp can carry the message text; the others need a paste. */
export function chatLink(channel: Channel, address: string, body: string): { url: string; prefilled: boolean } | null {
  switch (channel) {
    case 'whatsapp':
      return { url: `https://wa.me/${address}?text=${encodeURIComponent(body)}`, prefilled: true };
    case 'instagram':
      return { url: `https://ig.me/m/${address}`, prefilled: false };
    case 'facebook':
      return { url: `https://m.me/${address}`, prefilled: false };
    case 'tiktok':
      return { url: `https://www.tiktok.com/@${address}`, prefilled: false };
    case 'telegram':
      return { url: `https://t.me/${address}`, prefilled: false };
    case 'linkedin':
      return { url: `https://www.linkedin.com/${address}/`, prefilled: false };
    default:
      return null;
  }
}
