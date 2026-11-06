import { reactive } from 'vue';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
  }
}

/** Connection state, shown as a banner when the local server is unreachable. */
export const connection = reactive({ down: false });

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        'X-Agent-Client': 'dashboard',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    connection.down = true;
    throw new ApiError(0, 'OFFLINE', 'The sales agent is not running. Start it with start-agent.bat.');
  }
  connection.down = false;
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Request failed (${res.status})`, e.fields);
  }
  return data as T;
}

export const qs = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export interface Options {
  categories: Array<{ id: string; label: string; osmShops: string[] }>;
  regions: Array<{ code: string; label: string }>;
  leadStatuses: string[];
  modes: string[];
  csvColumns: string[];
}

let optionsCache: Promise<Options> | null = null;
export const getOptions = () => (optionsCache ??= api<Options>('/options'));

/** Toasts for action results. */
export const toasts = reactive<{ items: Array<{ id: number; kind: 'ok' | 'error'; text: string }> }>({ items: [] });
let toastId = 0;
export function toast(text: string, kind: 'ok' | 'error' = 'ok') {
  const id = ++toastId;
  toasts.items.push({ id, kind, text });
  setTimeout(() => (toasts.items = toasts.items.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500);
}

/** Runs an action, toasting errors (except offline, which the banner covers). */
export async function run<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await fn();
    if (success) toast(success);
    return result;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'OFFLINE') return undefined;
    toast(err instanceof Error ? err.message : String(err), 'error');
    return undefined;
  }
}

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

export const ago = (d: string | null | undefined) => {
  if (!d) return '—';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export const statusLabel: Record<string, string> = {
  discovered: 'Discovered',
  qualified: 'Qualified',
  unqualified: 'Not qualified',
  archived: 'Archived',
  do_not_contact: 'Do not contact',
  contacted: 'Contacted',
  replied: 'Replied',
  interested: 'Interested',
  demo_booked: 'Demo booked',
  registered: 'Registered',
  activated: 'Activated',
  declined: 'Declined',
  pending: 'Waiting',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  needs_review: 'Needs review',
};

export const taskLabel: Record<string, string> = {
  'discovery.osm': 'OpenStreetMap search',
  'lead.enrich_website': 'Website contact check',
  'outreach.auto_draft': 'Draft messages for qualified leads',
  'outreach.send_email': 'Send approved email',
  'outreach.followup': 'Draft follow-up',
  'outreach.check_delivery': 'Check email delivery (bounces)',
  'inbox.check': 'Check the reply mailbox',
  'telegram.check_inbox': 'Check Telegram messages',
  'telegram.send_reply': 'Send a Telegram answer',
  'knowledge.read_websites': 'Read your website into the knowledge base',
  'inbound.import_form': 'Read new interest-form answers',
};

/** Channels the agent drafts for. Email is sent by the agent; the rest you send yourself. */
export const CHANNELS = ['email', 'whatsapp', 'instagram', 'facebook', 'tiktok', 'telegram', 'linkedin'] as const;
export type Channel = (typeof CHANNELS)[number];
export const SOCIALS = ['instagram', 'facebook', 'tiktok', 'telegram', 'linkedin'] as const;
export const channelLabel: Record<string, string> = {
  email: 'Email', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', telegram: 'Telegram', linkedin: 'LinkedIn',
};
export const channelIcon: Record<string, string> = {
  email: '✉', whatsapp: '💬', instagram: '📷', facebook: '📘', tiktok: '🎵', telegram: '✈', linkedin: '💼',
};
/** Longest message per channel (matches the server's limits). */
export const channelLimit: Record<string, number> = {
  email: 8000, whatsapp: 1500, instagram: 1000, facebook: 2000, tiktok: 1000, telegram: 4000, linkedin: 1900,
};

/** Reply labels, as the classifier and you set them. */
export const labelText: Record<string, string> = {
  interested: 'Interested',
  demo_request: 'Wants a demo',
  question: 'Question',
  not_interested: 'Not interested',
  opt_out: 'Opted out (STOP)',
  auto_reply: 'Auto-reply',
  other: 'Unclear',
};
export const labelTone: Record<string, string> = {
  interested: 'ok', demo_request: 'ok', question: 'info', not_interested: 'warn', opt_out: 'danger', auto_reply: '', other: 'warn',
};
