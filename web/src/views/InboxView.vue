<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { channelIcon, channelLabel, channelLimit, ago, api, fmtDate, getOptions, labelText, labelTone, qs, run, statusLabel, toast, type Channel, type Options } from '../api';
import { refreshStatus } from '../status';

interface Msg {
  id: number; lead_id: number | null; social_contact_id: number | null; business_name: string | null; lead_status: string | null; channel: Channel;
  from_address: string | null; subject: string | null; body: string; received_at: string | null; source: string | null; folder: string | null;
  classification: string | null; classification_reasons: string[]; classified_by: string | null;
  needs_attention: boolean; handled_at: string | null; read_at: string | null; reply_id: number | null; reply_status: string | null;
  contact_name: string | null; contact_username: string | null; contact_external_id: string | null; contact_ignored_at: string | null;
}
interface ThreadMsg { id: number; direction: 'inbound' | 'outbound'; body: string; subject: string | null; status: string; received_at: string | null; sent_at: string | null; created_at: string; created_by: string | null; ai_generated: boolean }
interface Counts { unread: number; attention: number; not_lead: number; total: number }
interface InboxStatus {
  problems: Array<{ field: string; message: string }>; enabled: boolean; user: string | null; folders: string[]; readAll: boolean;
  lastCheck: ({ at: string } & Record<string, number | string>) | null;
  telegram: { problems: string[]; lastCheck: ({ at: string } & Record<string, number | string>) | null };
}
interface InboxSettings {
  inboxAccess: Record<Channel, boolean>;
  replyAutonomy: Record<Channel, 'off' | 'draft' | 'auto_send'>;
  metaInboxEnabled: boolean;
  metaInboxPlatforms: string[];
  mode: string;
  emailSendingMode: 'dry_run' | 'live';
  metaReplySending: 'manual' | 'live';
}
interface LeadHit { id: number; business_name: string; email: string | null; state: string | null }
interface Hit { chunkId: number; title: string; heading: string | null; content: string; origin: string | null }
/** One person on one channel: the newest message, how many are listed, not opened yet, and waiting for an answer. */
interface Conversation { key: string; latest: Msg; count: number; unread: number; attention: number }

/** Tabs in the order people use them. */
const TAB_CHANNELS: Channel[] = ['email', 'instagram', 'facebook', 'whatsapp', 'telegram', 'tiktok', 'linkedin'];
/** Where the agent can't read messages itself: you paste them in. */
const PASTE_CHANNELS: Channel[] = ['tiktok', 'linkedin', 'whatsapp', 'instagram', 'facebook', 'telegram', 'email'];

const channel = ref<'all' | Channel>('all');
const view = ref<'attention' | 'all' | 'unread' | 'not_lead'>('all');
const search = ref('');
const items = ref<Msg[]>([]);
const counts = ref<Partial<Record<Channel, Counts>>>({});
const box = ref<InboxStatus | null>(null);
const cfg = ref<InboxSettings | null>(null);
const ai = ref<{ configured: boolean } | null>(null);
const loading = ref(false);
const selectedKey = ref<string | null>(null);

try {
  const c = localStorage.getItem('inbox.channel');
  if (c && (c === 'all' || TAB_CHANNELS.includes(c as Channel))) channel.value = c as 'all' | Channel;
  const v = localStorage.getItem('inbox.view');
  if (v === 'attention' || v === 'all' || v === 'unread' || v === 'not_lead') view.value = v;
} catch {
  /* storage unavailable */
}
watch([channel, view], ([c, v]) => {
  try {
    localStorage.setItem('inbox.channel', c);
    localStorage.setItem('inbox.view', v);
  } catch {
    /* ignore */
  }
});

async function load() {
  loading.value = true;
  const [list, c] = await Promise.all([
    api<{ data: Msg[] }>(`/inbox${qs({ view: view.value, channel: channel.value, q: search.value.trim() || undefined })}`).catch(() => ({ data: [] })),
    api<{ channels: Partial<Record<Channel, Counts>> }>('/inbox/counts').catch(() => ({ channels: {} })),
  ]);
  items.value = list.data;
  counts.value = c.channels;
  loading.value = false;
}
async function loadStatus() {
  const [b, s] = await Promise.all([api<InboxStatus>('/inbox/status').catch(() => null), api<InboxSettings>('/settings').catch(() => null)]);
  box.value = b;
  cfg.value = s;
}
async function reload() {
  await load();
  if (selected.value) await loadThread(selected.value.latest);
  void refreshStatus();
}
onMounted(() => {
  void load();
  void loadStatus();
  void api<{ configured: boolean }>('/ai/status').then((s) => (ai.value = s), () => null);
});
watch([channel, view], () => {
  selectedKey.value = null;
  void load();
});

const sum = (k: keyof Counts, c: 'all' | Channel) =>
  c === 'all' ? Object.values(counts.value).reduce((n, x) => n + (x?.[k] ?? 0), 0) : counts.value[c]?.[k] ?? 0;

// ── The list: one row per person per channel, newest first ──
const convKey = (m: Msg) => `${m.channel}:${m.lead_id ? `l${m.lead_id}` : m.social_contact_id ? `c${m.social_contact_id}` : `m${m.id}`}`;
const conversations = computed<Conversation[]>(() => {
  const byKey = new Map<string, Conversation>();
  for (const m of items.value) {
    const key = convKey(m);
    const c = byKey.get(key);
    const unread = m.read_at ? 0 : 1;
    const attention = m.needs_attention && !m.handled_at ? 1 : 0;
    if (c) {
      c.count++;
      c.unread += unread;
      c.attention += attention;
    } else byKey.set(key, { key, latest: m, count: 1, unread, attention });
  }
  return [...byKey.values()];
});
const selected = computed(() => conversations.value.find((c) => c.key === selectedKey.value) ?? null);

const who = (m: Msg) =>
  m.business_name ?? m.contact_name ?? (m.contact_username ? `@${m.contact_username}` : null) ?? m.from_address ?? m.contact_external_id ?? 'Unknown';
const initial = (m: Msg) => (who(m).replace(/^@/, '').trim()[0] ?? '?').toUpperCase();
const preview = (m: Msg) => m.body.replace(/\s+/g, ' ').trim();
/** Like a phone's inbox: the time today, the day this week, otherwise the date. */
function shortTime(d: string | null) {
  if (!d) return '';
  const t = new Date(d);
  const now = new Date();
  if (t.toDateString() === now.toDateString()) return t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = (now.getTime() - t.getTime()) / 86_400_000;
  if (days < 6) return t.toLocaleDateString(undefined, { weekday: 'short' });
  return t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(t.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

// ── Opening a conversation ──
const thread = ref<ThreadMsg[] | null>(null);
const threadEnd = ref<HTMLElement | null>(null);
async function loadThread(m: Msg) {
  const r = await run(() => api<{ data: ThreadMsg[] }>(`/inbox/${m.id}/thread`));
  thread.value = r?.data ?? [];
  await nextTick();
  threadEnd.value?.scrollIntoView({ block: 'end' });
}
async function open(c: Conversation) {
  newMsg.value = null;
  selectedKey.value = c.key;
  thread.value = null;
  composer.value = null;
  knowledge.value = null;
  linkSearch.q = '';
  linkSearch.hits = [];
  newLead.value = null;
  await Promise.all([loadThread(c.latest), markRead(c)]);
}
/** Opening a conversation reads it, like any inbox. */
async function markRead(c: Conversation) {
  if (!c.unread) return;
  const r = await api<{ changed: number }>(`/inbox/${c.latest.id}/read`, { method: 'POST', body: {} }).catch(() => null);
  if (!r) return;
  const now = new Date().toISOString();
  for (const m of items.value) if (convKey(m) === c.key && !m.read_at) m.read_at = now;
  const n = counts.value[c.latest.channel];
  if (n) n.unread = Math.max(0, n.unread - r.changed);
}
async function markUnread(c: Conversation) {
  if (!(await run(() => api(`/inbox/${c.latest.id}/read`, { method: 'POST', body: { read: false } }), 'Marked unread'))) return;
  selectedKey.value = null;
  await reload();
}
function closeReading() {
  selectedKey.value = null;
}

/** What is (or isn't) feeding the current tab. */
const sourceNote = computed(() => {
  const c = channel.value;
  const s = cfg.value;
  const b = box.value;
  if (!s || !b) return null;
  if (c !== 'all' && !s.inboxAccess[c]) return { tone: 'warn', text: `${channelLabel[c]} is switched off under Settings → Inbox, so the agent doesn't read or answer it.` };
  if (c === 'email') {
    if (b.problems.length) return { tone: 'warn', text: `The mailbox isn't set up: ${b.problems.map((p) => p.message).join(' ')}` };
    if (!b.enabled) return { tone: 'info', text: 'Reading the mailbox is off. Turn it on in Settings → Inbox.' };
    const last = b.lastCheck ? `${ago(b.lastCheck.at)}: ${b.lastCheck.looked} looked at` : 'never';
    return { tone: '', text: `Reading ${b.user} (${b.folders.join(', ')}) read-only, ${b.readAll ? 'every message' : 'only replies to outreach'} · last check ${last}` };
  }
  if (c === 'telegram') {
    if (b.telegram.problems.length) return { tone: 'info', text: `No Telegram bot yet: ${b.telegram.problems.join(' ')} Until then, paste messages in.` };
    return { tone: '', text: `Messages to your bot · last check ${b.telegram.lastCheck ? ago(b.telegram.lastCheck.at) : 'never'}` };
  }
  if (c === 'instagram' || c === 'facebook') {
    if (!s.metaInboxEnabled || !s.metaInboxPlatforms.includes(c)) return { tone: 'info', text: `Reading ${channelLabel[c]} messages is off (Settings → Instagram & Facebook). You can paste messages in.` };
    return null;
  }
  if (c === 'tiktok' || c === 'linkedin' || c === 'whatsapp') {
    return { tone: '', text: `The agent can't read ${channelLabel[c]} messages. Paste in the ones you want labelled and answered; you send the answers yourself.` };
  }
  return null;
});
const autonomyText = { off: 'The agent does not answer here', draft: 'The agent drafts answers here for you to approve', auto_send: 'The agent may send answers here itself' } as const;

async function checkNow() {
  const path = channel.value === 'telegram' ? '/telegram/check-now' : '/inbox/check';
  const r = await run(() => api<{ queued: boolean; agentRunning: boolean }>(path, { method: 'POST' }));
  if (r) toast(r.agentRunning ? 'Checking now' : 'Check queued. It runs when you press Start');
}
const canCheck = computed(() => {
  const b = box.value;
  if (!b || !cfg.value) return false;
  if (channel.value === 'telegram') return !b.telegram.problems.length && cfg.value.inboxAccess.telegram;
  if (channel.value === 'email' || channel.value === 'all') return b.enabled && !b.problems.length && cfg.value.inboxAccess.email;
  return false;
});

// ── Writing: an answer in a conversation, or a new message ──
type SendResult = { sent: boolean; chatLink?: { url: string; prefilled: boolean } | null };
/** After you press Send: sent by the agent, or the chat opened for you to paste and send. */
function afterSend(r: SendResult, send: boolean, text: string) {
  if (!send) toast('Saved as a draft in the approval queue');
  else if (r.sent) toast(cfg.value?.emailSendingMode === 'dry_run' && !r.chatLink ? 'Sending (email is in dry run: it is recorded, not really sent)' : 'Sending');
  else if (r.chatLink) {
    void navigator.clipboard?.writeText(text).catch(() => {});
    toast('Copied. Opening the chat: paste the message and send it, then mark it sent in the approval queue');
    window.open(r.chatLink.url, '_blank', 'noopener');
  } else toast('Send it yourself, then mark it sent in the approval queue');
}
/** How a message on this channel gets to them, said before you press Send. */
function deliveryNote(ch: Channel, toBot: boolean) {
  if (ch === 'email') return cfg.value?.emailSendingMode === 'live' ? 'Sent by the agent from your email address.' : 'Email is in dry run: it is recorded, not really sent (Settings → Email).';
  if (ch === 'telegram') return toBot ? 'Sent through your Telegram bot.' : 'They haven\'t written to your bot, so Telegram opens for you to send it.';
  if (ch === 'instagram' || ch === 'facebook') return cfg.value?.metaReplySending === 'live' ? `Sent through Meta if they wrote in the last 24 hours; otherwise ${channelLabel[ch]} opens for you to send it.` : `${channelLabel[ch]} opens for you to paste and send it.`;
  return `${channelLabel[ch]} opens for you to paste and send it.`;
}

const composer = ref<{ body: string; subject: string; optOut: boolean; busy: boolean } | null>(null);
function openComposer(m: Msg) {
  composer.value = { body: '', subject: m.subject ? `Re: ${m.subject.replace(/^Re:\s*/i, '')}` : '', optOut: false, busy: false };
}
/** An answer to their latest message while it has none; after that, a new message in the same conversation. */
async function sendReply(m: Msg, send: boolean) {
  const c = composer.value!;
  const subject = m.channel === 'email' ? c.subject.trim() || 'Re: Your message' : undefined;
  const answering = !m.reply_id || m.reply_status === 'draft' || m.reply_status === 'approved';
  c.busy = true;
  const r = await run(() =>
    answering
      ? api<SendResult>(`/inbox/${m.id}/reply`, { method: 'POST', body: { body: c.body, ...(subject ? { subject } : {}), optOut: c.optOut, send } })
      : api<SendResult>('/inbox/compose', {
          method: 'POST',
          body: { channel: m.channel, ...(m.social_contact_id ? { contactId: m.social_contact_id } : { leadId: m.lead_id }), body: c.body, ...(subject ? { subject } : {}), optOut: c.optOut, send },
        }),
  );
  c.busy = false;
  if (!r) return;
  composer.value = null;
  afterSend(r, send, c.body);
  await reload();
}

// ── An answer waiting for you (drafted by the agent, or by you with "Draft with AI") ──
const waitingDraft = computed(() => {
  const m = selected.value?.latest;
  if (!m?.reply_id || m.reply_status !== 'draft') return null;
  return thread.value?.find((t) => t.id === m.reply_id) ?? null;
});
const draftBusy = ref(false);
async function sendDraft(m: Msg, d: ThreadMsg) {
  draftBusy.value = true;
  const r = await run(() =>
    api<SendResult>(`/inbox/${m.id}/reply`, { method: 'POST', body: { body: d.body, ...(m.channel === 'email' && d.subject ? { subject: d.subject } : {}), send: true } }),
  );
  draftBusy.value = false;
  if (!r) return;
  afterSend(r, true, d.body);
  await reload();
}
function editDraft(m: Msg, d: ThreadMsg) {
  openComposer(m);
  composer.value!.body = d.body;
  if (d.subject) composer.value!.subject = d.subject;
}
async function discardDraft(d: ThreadMsg) {
  draftBusy.value = true;
  const r = await run(() => api(`/messages/${d.id}/reject`, { method: 'POST', body: { reason: 'Discarded in the Inbox' } }));
  draftBusy.value = false;
  if (r === undefined) return;
  toast('Draft discarded');
  await reload();
}

// ── New message ──
const NEW_CHANNELS: Channel[] = ['email', 'whatsapp', 'telegram', 'instagram', 'facebook', 'tiktok', 'linkedin'];
const toHint: Record<Channel, string> = {
  email: 'name@example.com',
  whatsapp: '0803 123 4567',
  telegram: '@username',
  instagram: '@username or profile link',
  facebook: 'Page or profile link',
  tiktok: '@username',
  linkedin: 'linkedin.com/in/…',
};
const newMsg = ref<{ channel: Channel; to: string; lead: LeadHit | null; hits: LeadHit[]; subject: string; body: string; optOut: boolean; busy: boolean } | null>(null);
function openNew() {
  selectedKey.value = null;
  newMsg.value = { channel: channel.value === 'all' ? 'email' : channel.value, to: '', lead: null, hits: [], subject: '', body: '', optOut: false, busy: false };
}
let findTimer: ReturnType<typeof setTimeout> | undefined;
/** Typing a name finds leads; typing an address or handle sends to that. */
function onToInput() {
  const n = newMsg.value!;
  n.lead = null;
  clearTimeout(findTimer);
  const q = n.to.trim();
  if (q.length < 2 || /[@\d/]/.test(q[0]!) || q.includes('@') || q.includes('/')) {
    n.hits = [];
    return;
  }
  findTimer = setTimeout(async () => {
    const res = await api<{ data: LeadHit[] }>(`/leads${qs({ q, pageSize: 6 })}`).catch(() => null);
    if (newMsg.value === n && n.to.trim() === q) n.hits = res?.data ?? [];
  }, 250);
}
function pickLead(l: LeadHit) {
  const n = newMsg.value!;
  n.lead = l;
  n.to = l.business_name;
  n.hits = [];
}
async function sendNew(send: boolean) {
  const n = newMsg.value!;
  n.busy = true;
  const r = await run(() =>
    api<SendResult>('/inbox/compose', {
      method: 'POST',
      body: {
        channel: n.channel,
        ...(n.lead ? { leadId: n.lead.id } : { to: n.to.trim() }),
        ...(n.channel === 'email' ? { subject: n.subject.trim() } : {}),
        body: n.body,
        optOut: n.optOut,
        send,
      },
    }),
  );
  n.busy = false;
  if (!r) return;
  newMsg.value = null;
  afterSend(r, send, n.body);
  await reload();
}
const replyToBot = computed(() => !!selected.value && selected.value.latest.channel === 'telegram' && /^-?\d+$/.test(selected.value.latest.contact_external_id ?? ''));

const draftDone = {
  kb: 'Answer drafted from your knowledge base; it is in the approval queue',
  ai: 'AI answer drafted; check it in the approval queue',
};
async function draft(m: Msg, mode: 'kb' | 'ai') {
  if (await run(() => api(`/inbox/${m.id}/draft-reply`, { method: 'POST', body: { mode } }), draftDone[mode])) await reload();
}
async function handled(m: Msg) {
  if (await run(() => api(`/inbox/${m.id}/handled`, { method: 'POST' }))) await reload();
}
async function relabel(m: Msg, label: string) {
  if (label === 'opt_out' && !confirm(`Mark as opted out? ${who(m)} goes on the do-not-contact list and nothing more is sent.`)) return;
  if (await run(() => api(`/inbox/${m.id}`, { method: 'PATCH', body: { classification: label } }), 'Label changed')) await reload();
}

const knowledge = ref<Hit[] | 'loading' | null>(null);
async function showKnowledge(m: Msg) {
  if (knowledge.value) {
    knowledge.value = null;
    return;
  }
  knowledge.value = 'loading';
  const res = await run(() => api<{ hits: Hit[] }>(`/knowledge/search${qs({ q: m.body.slice(0, 600), limit: 4 })}`));
  knowledge.value = res?.hits ?? [];
}

// ── People who aren't leads ──
const linkSearch = reactive<{ q: string; hits: LeadHit[] }>({ q: '', hits: [] });
async function searchLeads() {
  if (linkSearch.q.trim().length < 2) return;
  const res = await run(() => api<{ data: LeadHit[] }>(`/leads${qs({ q: linkSearch.q.trim(), pageSize: 8 })}`));
  linkSearch.hits = res?.data ?? [];
}
async function link(m: Msg, lead: LeadHit) {
  if (await run(() => api(`/inbox/contacts/${m.social_contact_id}/link`, { method: 'POST', body: { leadId: lead.id } }), `Linked to ${lead.business_name}`)) {
    linkSearch.q = '';
    linkSearch.hits = [];
    selectedKey.value = null;
    await reload();
  }
}
const options = ref<Options | null>(null);
const newLead = ref<{ business_name: string; category: string; city: string; state: string } | null>(null);
function startNewLead(m: Msg) {
  newLead.value = { business_name: (m.contact_name ?? m.contact_username ?? m.from_address ?? '').replace(/^@/, ''), category: '', city: '', state: '' };
  if (!options.value) void getOptions().then((o) => (options.value = o));
}
async function addAsLead(m: Msg) {
  const f = newLead.value!;
  const body = { business_name: f.business_name.trim(), category: f.category, city: f.city.trim() || null, state: f.state.trim() || null };
  if (await run(() => api(`/inbox/contacts/${m.social_contact_id}/new-lead`, { method: 'POST', body }), `${body.business_name} added as a lead`)) {
    newLead.value = null;
    selectedKey.value = null;
    await reload();
  }
}
async function ignore(m: Msg, on: boolean) {
  if (on && !confirm(`Ignore ${who(m)}?\n\nTheir messages stay here but leave "Needs you", and the agent drafts no answers to them. You can undo this.`)) return;
  if (await run(() => api(`/inbox/contacts/${m.social_contact_id}/ignore`, { method: 'POST', body: { ignore: on } }), on ? 'Ignored' : 'No longer ignored')) await reload();
}

// ── Paste in a message ──
const paste = ref<{ channel: Channel; from: string; name: string; text: string } | null>(null);
function openPaste() {
  const c = channel.value === 'all' ? 'tiktok' : channel.value;
  paste.value = { channel: c, from: '', name: '', text: '' };
}
const fromHint: Record<Channel, string> = {
  email: 'Their email address',
  whatsapp: 'Their WhatsApp number',
  instagram: '@username or profile link',
  facebook: 'Page or profile link, or their name',
  tiktok: '@username or profile link',
  telegram: '@username, or their name',
  linkedin: 'Profile link (linkedin.com/in/…) or their name',
};
async function submitPaste() {
  const p = paste.value!;
  const body = { channel: p.channel, from: p.from.trim(), name: p.name.trim() || null, text: p.text.trim() };
  const r = await run(() => api<{ classification: { label: string } }>('/inbox/paste', { method: 'POST', body }));
  if (!r) return;
  toast(`Added and labelled “${labelText[r.classification.label] ?? r.classification.label}”`);
  paste.value = null;
  if (channel.value !== 'all' && channel.value !== body.channel) channel.value = body.channel;
  else await reload();
}

const noAnswer = (m: Msg) => ['opt_out', 'not_interested', 'auto_reply'].includes(m.classification ?? '') || !!m.contact_ignored_at;
const emptyText = computed(() => {
  if (search.value.trim()) return 'Nothing matches your search.';
  if (view.value === 'attention') return 'Nothing needs you here.';
  if (view.value === 'unread') return 'All caught up: nothing unread.';
  if (view.value === 'not_lead') return 'Everyone who wrote here is already a lead.';
  return 'No messages yet.';
});
const whenOf = (t: ThreadMsg) => t.received_at ?? t.sent_at ?? t.created_at;
</script>

<template>
  <div class="page-head">
    <div>
      <h1>Inbox</h1>
      <p>Every message people send you, per channel. Open one to read it in full, answer it, or let the agent draft the answer.</p>
    </div>
    <div class="btn-row">
      <button class="btn primary" @click="openNew">New message</button>
      <button class="btn" @click="openPaste">Add a message you received</button>
      <button v-if="channel === 'all' || channel === 'email' || channel === 'telegram'" class="btn" :disabled="!canCheck" @click="checkNow">
        {{ channel === 'telegram' ? 'Check Telegram now' : 'Check mailbox now' }}
      </button>
    </div>
  </div>

  <nav class="tabs" role="tablist" aria-label="Channels">
    <button class="tab" :class="{ on: channel === 'all' }" role="tab" :aria-selected="channel === 'all'" @click="channel = 'all'">
      All <span v-if="sum('unread', 'all')" class="unread-badge">{{ sum('unread', 'all') }}</span>
    </button>
    <button v-for="c in TAB_CHANNELS" :key="c" class="tab" :class="{ on: channel === c }" role="tab" :aria-selected="channel === c" @click="channel = c">
      {{ channelIcon[c] }} {{ channelLabel[c] }}
      <span v-if="sum('unread', c)" class="unread-badge">{{ sum('unread', c) }}</span>
      <span v-else-if="cfg && !cfg.inboxAccess[c]" class="muted small">off</span>
    </button>
  </nav>

  <div v-if="sourceNote" :class="sourceNote.tone ? ['banner', sourceNote.tone] : ['muted', 'small']" style="margin-bottom: 12px">
    {{ sourceNote.text }} <RouterLink v-if="sourceNote.tone" to="/settings#inbox">Settings</RouterLink>
  </div>

  <form v-if="paste" class="card" @submit.prevent="submitPaste">
    <div class="card-head"><h2>Add a message you received</h2></div>
    <p class="muted small" style="margin-top: 0">
      For chats the agent can't read (TikTok, LinkedIn, WhatsApp…). It is labelled and answered like the rest, and matched to a lead by number, email or profile.
    </p>
    <div class="grid grid-3">
      <label class="field">Channel
        <select v-model="paste.channel"><option v-for="c in PASTE_CHANNELS" :key="c" :value="c">{{ channelLabel[c] }}</option></select>
      </label>
      <label class="field">From<input v-model="paste.from" required :placeholder="fromHint[paste.channel]" /></label>
      <label class="field">Name (optional)<input v-model="paste.name" placeholder="Business or person" /></label>
    </div>
    <label class="field" style="margin-top: 8px">Their message<textarea v-model="paste.text" required rows="4" maxlength="5000"></textarea></label>
    <div class="btn-row" style="margin-top: 10px">
      <button class="btn primary" :disabled="!paste.from.trim() || !paste.text.trim()">Add to inbox</button>
      <button type="button" class="btn" @click="paste = null">Cancel</button>
    </div>
  </form>

  <div class="inbox-layout" :class="{ reading: !!selected || !!newMsg }">
    <!-- ── The list ── -->
    <section class="inbox-list" aria-label="Conversations">
      <div class="inbox-list-head">
        <div class="chips" role="tablist" aria-label="Which messages">
          <button class="chip" :class="{ on: view === 'all' }" @click="view = 'all'">All</button>
          <button class="chip" :class="{ on: view === 'unread' }" @click="view = 'unread'">Unread <span v-if="sum('unread', channel)">({{ sum('unread', channel) }})</span></button>
          <button class="chip" :class="{ on: view === 'attention' }" @click="view = 'attention'">Needs you <span v-if="sum('attention', channel)">({{ sum('attention', channel) }})</span></button>
          <button class="chip" :class="{ on: view === 'not_lead' }" @click="view = 'not_lead'">Not a lead</button>
        </div>
        <form @submit.prevent="load">
          <input v-model="search" type="search" placeholder="Search names and messages" aria-label="Search messages" style="width: 100%" />
        </form>
      </div>
      <div v-if="!conversations.length && !loading" class="empty">{{ emptyText }}</div>
      <button
        v-for="c in conversations"
        :key="c.key"
        class="inbox-row"
        :class="{ on: c.key === selectedKey, unread: c.unread > 0 }"
        :aria-current="c.key === selectedKey"
        @click="open(c)"
      >
        <span class="avatar" aria-hidden="true">{{ initial(c.latest) }}</span>
        <span class="inbox-row-main">
          <span class="inbox-row-top">
            <span class="inbox-row-name">{{ who(c.latest) }}</span>
            <span class="inbox-row-time">{{ shortTime(c.latest.received_at) }}</span>
          </span>
          <span v-if="c.latest.channel === 'email' && c.latest.subject" class="inbox-row-subject">{{ c.latest.subject }}</span>
          <span class="inbox-row-bottom">
            <span class="inbox-row-preview"><span :title="channelLabel[c.latest.channel]">{{ channelIcon[c.latest.channel] }}</span> {{ preview(c.latest) }}</span>
            <span v-if="c.latest.reply_status === 'draft'" class="muted small">Draft</span>
            <span v-else-if="c.attention" class="pill warn small" title="Waiting for your answer">Needs reply</span>
            <span v-if="c.unread" class="unread-badge" :aria-label="`${c.unread} unread`">{{ c.unread }}</span>
          </span>
        </span>
      </button>
    </section>

    <!-- ── Reading one conversation ── -->
    <section class="inbox-reader" :aria-label="selected ? `Conversation with ${who(selected.latest)}` : 'No conversation open'">
      <form v-if="newMsg" class="new-message" @submit.prevent="sendNew(true)">
        <header class="reader-head">
          <button type="button" class="btn small reader-back" @click="newMsg = null">← Back</button>
          <strong style="flex: 1">New message</strong>
          <button type="button" class="btn small" @click="newMsg = null">Discard</button>
        </header>
        <div class="reader-body new-message-body">
          <label class="field">Channel
            <select v-model="newMsg.channel" @change="newMsg.lead = null">
              <option v-for="c in NEW_CHANNELS" :key="c" :value="c">{{ channelIcon[c] }} {{ channelLabel[c] }}</option>
            </select>
          </label>
          <label class="field" style="position: relative">To
            <input v-model="newMsg.to" required autocomplete="off" :placeholder="`A lead's name, or ${toHint[newMsg.channel]}`" @input="onToInput" />
            <small v-if="newMsg.lead" class="muted">Lead: {{ newMsg.lead.business_name }}<span v-if="newMsg.lead.state"> · {{ newMsg.lead.state }}</span></small>
            <ul v-if="newMsg.hits.length" class="to-suggest">
              <li v-for="l in newMsg.hits" :key="l.id"><button type="button" @click="pickLead(l)">{{ l.business_name }} <span class="muted small">{{ l.email ?? '' }} {{ l.state ?? '' }}</span></button></li>
            </ul>
          </label>
          <label v-if="newMsg.channel === 'email'" class="field">Subject<input v-model="newMsg.subject" required maxlength="300" /></label>
          <label class="field">Message
            <textarea v-model="newMsg.body" rows="8" required :maxlength="channelLimit[newMsg.channel]"></textarea>
            <small class="muted">{{ newMsg.body.length }} / {{ channelLimit[newMsg.channel] }}</small>
          </label>
          <label class="check"><input v-model="newMsg.optOut" type="checkbox" /> Include unsubscribe line (“reply STOP”)</label>
          <p class="muted small" style="margin: 0">{{ deliveryNote(newMsg.channel, newMsg.channel === 'telegram') }}</p>
        </div>
        <footer class="reader-foot btn-row" style="justify-content: flex-end">
          <button type="button" class="btn small" :disabled="newMsg.busy || !newMsg.body.trim() || !newMsg.to.trim()" @click="sendNew(false)">Save as draft</button>
          <button class="btn primary small" :disabled="newMsg.busy || !newMsg.body.trim() || !newMsg.to.trim() || (newMsg.channel === 'email' && !newMsg.subject.trim())">Send</button>
        </footer>
      </form>
      <div v-else-if="!selected" class="empty">Select a conversation to read it, or write a <button class="linklike" @click="openNew">new message</button>.</div>
      <template v-else>
        <header class="reader-head">
          <button class="btn small reader-back" @click="closeReading">← Back</button>
          <span class="avatar" aria-hidden="true">{{ initial(selected.latest) }}</span>
          <div style="flex: 1; min-width: 0">
            <RouterLink v-if="selected.latest.lead_id" :to="`/leads/${selected.latest.lead_id}`"><strong>{{ who(selected.latest) }}</strong></RouterLink>
            <strong v-else>{{ who(selected.latest) }}</strong>
            <span v-if="selected.latest.lead_id" class="muted small"> · {{ statusLabel[selected.latest.lead_status ?? ''] ?? selected.latest.lead_status }}</span>
            <span v-else class="pill" style="margin-left: 6px">{{ selected.latest.contact_ignored_at ? 'Ignored' : 'Not a lead' }}</span>
            <div class="muted small">
              {{ channelIcon[selected.latest.channel] }} {{ channelLabel[selected.latest.channel] }}<span v-if="selected.latest.from_address && selected.latest.from_address !== who(selected.latest)"> · {{ selected.latest.from_address }}</span>
              <span v-if="selected.latest.folder"> · {{ selected.latest.folder }}</span>
            </div>
          </div>
          <span class="pill" :class="labelTone[selected.latest.classification ?? 'other']">{{ labelText[selected.latest.classification ?? 'other'] }}</span>
        </header>

        <div class="reader-body">
          <p v-if="!thread" class="muted small">Loading…</p>
          <div v-else class="thread">
            <div v-for="t in thread" :key="t.id" class="bubble" :class="[t.direction, { current: t.id === selected.latest.id }]">
              <div v-if="t.subject && (t.direction === 'outbound' || selected.latest.channel === 'email')" class="small"><strong>{{ t.subject }}</strong></div>
              <div style="white-space: pre-wrap">{{ t.body }}</div>
              <div class="bubble-meta">
                {{ t.direction === 'inbound' ? '' : t.created_by === 'agent' ? 'Agent · ' : 'You · ' }}{{ fmtDate(whenOf(t)) }}
                <span v-if="t.direction === 'outbound'"> · {{ statusLabel[t.status] ?? t.status }}</span><span v-if="t.ai_generated"> · AI</span>
              </div>
            </div>
            <div ref="threadEnd" />
          </div>

          <p class="muted small" style="margin: 10px 0 0">
            {{ selected.latest.classified_by === 'user' ? 'Label set by you' : `Labelled because: ${selected.latest.classification_reasons.join(', ') || 'no clear signal'}` }}
            <span v-if="selected.latest.reply_id"> · your answer: {{ selected.latest.reply_status === 'draft' ? 'draft waiting in the approval queue' : statusLabel[selected.latest.reply_status ?? ''] ?? selected.latest.reply_status }}</span>
            <span v-if="selected.latest.handled_at"> · handled</span>
          </p>
          <p v-if="cfg" class="muted small" style="margin: 4px 0 0">
            {{ autonomyText[cfg.replyAutonomy[selected.latest.channel]] }}<template v-if="cfg.replyAutonomy[selected.latest.channel] === 'auto_send' && cfg.mode !== 'autonomous'"> (in Controlled Autonomous Mode, which is off)</template>.
          </p>

          <div v-if="knowledge" class="quote small" style="margin-top: 10px">
            <template v-if="knowledge === 'loading'">Searching…</template>
            <template v-else-if="!knowledge.length">Nothing in your documents or website matches this message.</template>
            <div v-for="h in (knowledge as Hit[])" v-else :key="h.chunkId" style="margin-bottom: 8px">
              <strong>{{ h.title }}</strong><span v-if="h.heading" class="muted"> · {{ h.heading }}</span>
              <div style="white-space: pre-wrap">{{ h.content.length > 500 ? `${h.content.slice(0, 500)}…` : h.content }}</div>
            </div>
          </div>

          <template v-if="!selected.latest.lead_id && selected.latest.social_contact_id">
            <div class="reader-section">
              <strong class="small">Not a lead yet</strong>
              <div class="btn-row" style="margin-top: 6px">
                <input v-model="linkSearch.q" placeholder="Link to a lead: name or email" style="max-width: 240px" aria-label="Find a lead to link" @keyup.enter="searchLeads" />
                <button class="btn small" @click="searchLeads">Find</button>
                <button v-if="!newLead" class="btn small" @click="startNewLead(selected.latest)">Add as a new lead</button>
                <button class="btn small" @click="ignore(selected.latest, !selected.latest.contact_ignored_at)">{{ selected.latest.contact_ignored_at ? 'Stop ignoring' : 'Ignore this person' }}</button>
              </div>
              <ul v-if="linkSearch.hits.length" class="list" style="margin-top: 8px">
                <li v-for="l in linkSearch.hits" :key="l.id">
                  {{ l.business_name }} <span class="muted small">{{ l.email ?? '' }} {{ l.state ?? '' }}</span>
                  <button class="btn small" style="margin-left: 8px" @click="link(selected.latest, l)">Link</button>
                </li>
              </ul>
              <form v-if="newLead" class="btn-row" style="margin-top: 8px; gap: 6px" @submit.prevent="addAsLead(selected.latest)">
                <input v-model="newLead.business_name" placeholder="Business name" required aria-label="Business name" />
                <select v-model="newLead.category" required aria-label="Category">
                  <option value="" disabled>Category</option>
                  <option v-for="o in options?.categories" :key="o.id" :value="o.id">{{ o.label }}</option>
                </select>
                <input v-model="newLead.city" placeholder="City" style="max-width: 110px" aria-label="City" />
                <input v-model="newLead.state" placeholder="State" style="max-width: 110px" aria-label="State" />
                <button class="btn small primary" :disabled="!newLead.business_name.trim() || !newLead.category">Add and link</button>
                <button type="button" class="btn small" @click="newLead = null">Cancel</button>
              </form>
            </div>
          </template>
        </div>

        <footer class="reader-foot">
          <div v-if="waitingDraft && !composer" class="draft-waiting">
            <span><strong>{{ waitingDraft.ai_generated ? 'An AI answer' : 'An answer' }} is waiting for you.</strong> It won't be sent until you press Send.</span>
            <div class="btn-row">
              <button class="btn small" :disabled="draftBusy" @click="discardDraft(waitingDraft)">Discard</button>
              <button class="btn small" :disabled="draftBusy" @click="editDraft(selected.latest, waitingDraft)">Edit</button>
              <button class="btn primary small" :disabled="draftBusy" @click="sendDraft(selected.latest, waitingDraft)">Send</button>
            </div>
          </div>
          <form v-if="composer" class="composer" @submit.prevent="sendReply(selected.latest, true)">
            <input v-if="selected.latest.channel === 'email'" v-model="composer.subject" maxlength="300" placeholder="Subject" aria-label="Subject" />
            <textarea v-model="composer.body" rows="4" required :maxlength="channelLimit[selected.latest.channel]" :placeholder="`Write to ${who(selected.latest)}`" aria-label="Your message"></textarea>
            <div class="btn-row" style="justify-content: space-between">
              <small class="muted">{{ deliveryNote(selected.latest.channel, replyToBot) }}</small>
              <div class="btn-row">
                <label class="check small"><input v-model="composer.optOut" type="checkbox" /> Include unsubscribe line</label>
                <button type="button" class="btn small" @click="composer = null">Cancel</button>
                <button type="button" class="btn small" :disabled="composer.busy || !composer.body.trim()" @click="sendReply(selected.latest, false)">Save as draft</button>
                <button class="btn primary small" :disabled="composer.busy || !composer.body.trim()">Send</button>
              </div>
            </div>
          </form>
          <div v-else class="btn-row">
            <button v-if="selected.latest.classification !== 'opt_out' && !waitingDraft" class="btn primary small" @click="openComposer(selected.latest)">
              {{ selected.latest.reply_id ? 'New message' : 'Reply' }}
            </button>
            <template v-if="!noAnswer(selected.latest) && !selected.latest.reply_id">
                <button v-if="ai?.configured" class="btn small" @click="draft(selected.latest, 'ai')">Draft with AI</button>
                <button class="btn small" @click="draft(selected.latest, 'kb')">Draft from knowledge base</button>
            </template>
            <button class="btn small" @click="showKnowledge(selected.latest)">{{ knowledge ? 'Hide knowledge' : 'Relevant knowledge' }}</button>
            <button v-if="!selected.latest.handled_at" class="btn small" @click="handled(selected.latest)">Mark handled</button>
            <button class="btn small" @click="markUnread(selected)">Mark unread</button>
            <label class="small muted" style="display: inline-flex; gap: 6px; align-items: center">
              Label
              <select :value="selected.latest.classification ?? 'other'" @change="relabel(selected.latest, ($event.target as HTMLSelectElement).value)">
                <option v-for="(t, k) in labelText" :key="k" :value="k">{{ t }}</option>
              </select>
            </label>
          </div>
        </footer>
      </template>
    </section>
  </div>
</template>
