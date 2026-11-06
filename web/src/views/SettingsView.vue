<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import { api, CHANNELS, channelLabel, getOptions, run, toast, type Channel, type Options } from '../api';
import { refreshStatus, status } from '../status';
import SettingsSection from '../components/SettingsSection.vue';

type FormField =
  | 'timestamp' | 'businessName' | 'phone' | 'email' | 'instagram' | 'facebook' | 'tiktok' | 'telegram'
  | 'category' | 'city' | 'state' | 'consent' | 'referredBy' | 'referralCode';

interface Settings {
  mode: 'research' | 'approval' | 'autonomous';
  qualifyThreshold: number;
  enrichWebsites: boolean;
  overdueGraceMinutes: number;
  autoStartAgentOnLaunch: boolean;
  overpassMinIntervalSec: number;
  websiteMinIntervalSec: number;
  senderName: string;
  senderTitle: string;
  registrationUrl: string;
  referralCode: string;
  bookingUrl: string;
  tutorialUrl: string;
  autoDraft: boolean;
  dailyDraftLimit: number;
  draftChannels: Channel[];
  emailSendingMode: 'dry_run' | 'live';
  dailyEmailLimit: number;
  minSecondsBetweenEmails: number;
  sendWindowStartHour: number;
  sendWindowEndHour: number;
  sendOnWeekends: boolean;
  followUpsEnabled: boolean;
  followUp1AfterDays: number;
  followUp2AfterDays: number;
  readReplies: boolean;
  replyCheckMinutes: number;
  autoDraftReplies: boolean;
  replyLookbackDays: number;
  knowledgeChunkStrategy: 'structure' | 'fixed';
  knowledgeChunkWords: number;
  knowledgeChunkOverlap: number;
  websiteLinks: string[];
  websiteMaxPages: number;
  websiteRefreshDays: number;
  aiDraftReplies: boolean;
  aiInstructions: string;
  aiReplyHistory: number;
  aiDraftIntros: boolean;
  aiMonthlyBudgetUsd: number;
  aiDailyCallLimit: number;
  aiInputUsdPerMTok: number;
  aiOutputUsdPerMTok: number;
  autoApproveIntros: boolean;
  autoApproveFollowUps: boolean;
  autoApproveDailyLimit: number;
  autoApproveMinScore: number;
  interestFormEnabled: boolean;
  interestFormUrl: string;
  interestFormCsvUrl: string;
  interestFormCheckMinutes: number;
  interestFormRequireConsent: boolean;
  interestFormDefaultCategory: string;
  interestFormColumns: Record<FormField, string>;
  referralAskEnabled: boolean;
  referralLinksEnabled: boolean;
  referralPrefillUrl: string;
  instagramLookupEnabled: boolean;
  metaInboxEnabled: boolean;
  metaInboxPlatforms: Array<'instagram' | 'facebook'>;
  metaInboxCheckMinutes: number;
  metaInboxLookbackDays: number;
  metaReplySending: 'manual' | 'live';
  webSearchProviders: Array<'tavily' | 'brave'>;
  tavilyMonthlyLimit: number;
  braveMonthlyLimit: number;
  webSearchResultsPerQuery: number;
  webSearchCountry: string;
  webSearchCacheDays: number;
  groupImportEnabled: boolean;
  groupFirstLine: string;
  inboxAccess: Record<Channel, boolean>;
  emailReadAll: boolean;
  emailFolders: string[];
  replyAutonomy: Record<Channel, 'off' | 'draft' | 'auto_send'>;
  telegramCheckMinutes: number;
}
type Key = keyof Settings;

// ── Sections: each saves only its own fields ──────────────────────────────────
const SECTIONS = {
  mode: ['mode'],
  sender: ['senderName', 'senderTitle', 'registrationUrl', 'referralCode', 'bookingUrl', 'tutorialUrl'],
  drafting: ['autoDraft', 'dailyDraftLimit', 'draftChannels'],
  sending: ['dailyEmailLimit', 'minSecondsBetweenEmails', 'sendWindowStartHour', 'sendWindowEndHour', 'sendOnWeekends'],
  followups: ['followUpsEnabled', 'followUp1AfterDays', 'followUp2AfterDays'],
  replies: ['replyCheckMinutes', 'replyLookbackDays', 'emailReadAll', 'emailFolders'],
  inbox: ['inboxAccess'],
  answers: ['replyAutonomy', 'autoDraftReplies'],
  telegram: ['telegramCheckMinutes'],
  knowledge: ['knowledgeChunkStrategy', 'knowledgeChunkWords', 'knowledgeChunkOverlap', 'websiteLinks', 'websiteMaxPages', 'websiteRefreshDays'],
  qualification: ['qualifyThreshold', 'overpassMinIntervalSec', 'websiteMinIntervalSec', 'overdueGraceMinutes', 'enrichWebsites'],
  form: ['interestFormEnabled', 'interestFormUrl', 'interestFormCsvUrl', 'interestFormCheckMinutes', 'interestFormRequireConsent', 'interestFormDefaultCategory', 'interestFormColumns'],
  referrals: ['referralAskEnabled', 'referralLinksEnabled', 'referralPrefillUrl'],
  webSearch: ['webSearchProviders', 'tavilyMonthlyLimit', 'braveMonthlyLimit', 'webSearchResultsPerQuery', 'webSearchCountry', 'webSearchCacheDays'],
  groups: ['groupImportEnabled', 'groupFirstLine'],
  meta: ['instagramLookupEnabled', 'metaInboxEnabled', 'metaInboxPlatforms', 'metaInboxCheckMinutes', 'metaInboxLookbackDays'],
  ai: ['aiInstructions', 'aiReplyHistory', 'aiDraftReplies', 'aiDraftIntros', 'aiMonthlyBudgetUsd', 'aiDailyCallLimit', 'aiInputUsdPerMTok', 'aiOutputUsdPerMTok'],
  autonomy: ['autoApproveIntros', 'autoApproveFollowUps', 'autoApproveDailyLimit', 'autoApproveMinScore'],
  startup: ['autoStartAgentOnLaunch'],
} as const satisfies Record<string, readonly Key[]>;
type Section = keyof typeof SECTIONS;

const TABS: Array<{ id: string; label: string; sections: Section[] }> = [
  { id: 'general', label: 'General', sections: ['mode', 'sender'] },
  { id: 'outreach', label: 'Outreach', sections: ['drafting'] },
  { id: 'email', label: 'Email', sections: ['sending', 'followups'] },
  { id: 'inbox', label: 'Inbox & answers', sections: ['inbox', 'replies', 'telegram', 'answers'] },
  { id: 'knowledge', label: 'Knowledge', sections: ['knowledge'] },
  { id: 'leads', label: 'Leads & form', sections: ['qualification', 'form', 'referrals'] },
  { id: 'meta', label: 'Instagram & Facebook', sections: ['meta'] },
  { id: 'search', label: 'Web search & groups', sections: ['webSearch', 'groups'] },
  { id: 'ai', label: 'AI & autonomy', sections: ['ai', 'autonomy'] },
  { id: 'system', label: 'System', sections: ['startup'] },
];

const saved = ref<Settings | null>(null);
const draft = ref<Settings | null>(null);
const saving = ref<Section | null>(null);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const changedKeys = (s: Section) => (saved.value && draft.value ? SECTIONS[s].filter((k) => !same(saved.value![k], draft.value![k])) : []);
function dirty(s: Section) {
  if (s === 'startup' && autostart.value?.supported && startWithWindows.value !== autostart.value.enabled) return true;
  return changedKeys(s).length > 0;
}
const anyDirty = computed(() => (Object.keys(SECTIONS) as Section[]).some(dirty));
const tabDirty = (t: (typeof TABS)[number]) => t.sections.some(dirty);

function cancel(s: Section) {
  for (const k of SECTIONS[s]) (draft.value as Record<string, unknown>)[k] = clone(saved.value![k]);
  if (s === 'startup') startWithWindows.value = autostart.value?.enabled ?? false;
}
function accept(next: Settings, keys: readonly Key[]) {
  // Take the server's values for the saved keys; leave other sections' unsaved edits alone.
  for (const k of keys) (draft.value as Record<string, unknown>)[k] = clone(next[k]);
  saved.value = next;
}
async function save(s: Section) {
  const keys = changedKeys(s);
  const patch = Object.fromEntries(keys.map((k) => [k, draft.value![k]])) as Partial<Settings>;
  if (patch.mode === 'autonomous' && !confirmAutonomous()) return;
  saving.value = s;
  try {
    if (keys.length) {
      const msg = keys.includes('qualifyThreshold') ? 'Saved; leads re-scored' : keys.includes('mode') ? 'Mode changed' : 'Saved';
      const next = await run(() => api<Settings>('/settings', { method: 'PUT', body: patch }), msg);
      if (!next) return;
      accept(next, SECTIONS[s]);
    }
    if (s === 'startup' && autostart.value?.supported && startWithWindows.value !== autostart.value.enabled) await applyAutostart(startWithWindows.value);
    void refreshStatus();
    if (s === 'ai' || s === 'answers') void loadAi();
    if (s === 'inbox' || s === 'replies' || s === 'telegram') void loadMailbox();
    if (s === 'form' || s === 'referrals') void loadInbound();
    if (s === 'meta') void loadMeta();
    if (s === 'webSearch') void loadSearch();
  } finally {
    saving.value = null;
  }
}
/** Explicit action buttons (each with its own confirmation) apply at once. */
async function applyNow(patch: Partial<Settings>, message: string) {
  const next = await run(() => api<Settings>('/settings', { method: 'PUT', body: patch }), message);
  if (next) accept(next, Object.keys(patch) as Key[]);
  void refreshStatus();
  return !!next;
}

// ── Tabs, and not losing unsaved changes ──────────────────────────────────────
const tab = ref(TABS[0]!.id);
/** Links like /settings#knowledge open the tab holding that section. */
const HASH_TAB: Record<string, string> = { inbox: 'inbox', telegram: 'inbox', knowledge: 'knowledge', 'interest-form': 'leads', referrals: 'leads', ai: 'ai', email: 'email', meta: 'meta', 'web-search': 'search', groups: 'search' };
const route = useRoute();
try {
  const remembered = localStorage.getItem('settings.tab');
  if (remembered && TABS.some((t) => t.id === remembered)) tab.value = remembered;
} catch {
  /* storage unavailable: start on General */
}
const fromHash = () => {
  const t = HASH_TAB[route.hash.replace('#', '')];
  if (t) tab.value = t;
};
fromHash();
watch(() => route.hash, fromHash);
watch(tab, (t) => {
  try {
    localStorage.setItem('settings.tab', t);
  } catch {
    /* ignore */
  }
});
onBeforeRouteLeave(() => !anyDirty.value || confirm('You have unsaved settings. Leave without saving them?'));
const beforeUnload = (e: BeforeUnloadEvent) => {
  if (anyDirty.value) e.preventDefault();
};
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));

// ── Status panels ─────────────────────────────────────────────────────────────
interface AiStatus {
  defaultInstructions?: string;
  configured: boolean; model: string; models: string[]; modelsSource: 'env' | 'auto';
  monthUsd: string; budgetUsd: number; callsToday: number; callsMonth: number; dailyCallLimit: number;
}
const ai = ref<AiStatus | null>(null);
async function loadAi() {
  ai.value = await api<AiStatus>('/ai/status').catch(() => null);
}

const autostart = ref<{ supported: boolean; enabled: boolean; path: string | null } | null>(null);
const startWithWindows = ref(false);
async function applyAutostart(enabled: boolean) {
  const r = await run(() => api<{ supported: boolean; enabled: boolean; path: string | null }>('/system/autostart', { method: 'PUT', body: { enabled } }), enabled ? 'The app will start with Windows' : 'The app will no longer start with Windows');
  autostart.value = r ?? (await api<{ supported: boolean; enabled: boolean; path: string | null }>('/system/autostart').catch(() => autostart.value));
  startWithWindows.value = autostart.value?.enabled ?? false;
}

const newLink = ref('');
function addLink() {
  let url = newLink.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!draft.value!.websiteLinks.includes(url)) draft.value!.websiteLinks.push(url);
  newLink.value = '';
}
function removeLink(url: string) {
  draft.value!.websiteLinks = draft.value!.websiteLinks.filter((l) => l !== url);
}
async function readWebsiteNow() {
  const r = await run(() => api<{ agentRunning: boolean }>('/knowledge/read-websites', { method: 'POST', body: {} }));
  if (r) toast(r.agentRunning ? 'Reading your website now. See Knowledge → Website' : 'Queued. It runs when you press Start');
}

function confirmAutonomous() {
  const s = draft.value!;
  const kinds = [s.autoApproveIntros && 'introductions', s.autoApproveFollowUps && 'follow-ups'].filter(Boolean).join(' and ') || 'nothing (both off)';
  const answers = AUTO_SEND_CHANNELS.filter((c) => s.replyAutonomy[c] === 'auto_send').map((c) => channelLabel[c]).join(', ');
  return confirm(
    `Switch to Controlled Autonomous Mode?\n\nThe agent will approve its own template email ${kinds}, up to ${s.autoApproveDailyLimit} a day, for leads scoring ${s.autoApproveMinScore}+. ` +
      `They then send ${s.emailSendingMode === 'live' ? 'for real (live sending is on)' : 'as dry runs (sending is in dry run)'}, within your sending hours and daily email limit.\n\n` +
      (answers ? `It will also send its own answers to messages on: ${answers} (only answers with no warnings, built from your knowledge).\n\n` : 'It sends no answers to messages by itself (no channel is set to auto-send).\n\n') +
      'AI-written outreach, and messages you send yourself (WhatsApp, TikTok, LinkedIn…), always wait for you. Switching back returns unsent agent approvals to you.',
  );
}

interface MailboxStatus {
  problems: Array<{ field: string; message: string }>; enabled: boolean; host: string | null; user: string | null; mailbox: string;
  folders: string[]; readAll: boolean;
  replyTo: string | null; lastCheck: ({ at: string } & Record<string, number | string>) | null;
  telegram: { problems: string[]; lastCheck: ({ at: string } & Record<string, number | string>) | null };
}
/** Channels the agent can send answers on by itself; the rest you always send. */
const AUTO_SEND_CHANNELS: Channel[] = ['email', 'instagram', 'facebook', 'telegram'];
const INBOX_CHANNELS: Channel[] = ['email', 'instagram', 'facebook', 'whatsapp', 'telegram', 'tiktok', 'linkedin'];
const accessHint: Record<Channel, string> = {
  email: 'reads your mailbox (below)',
  instagram: 'reads Instagram DMs (needs the Meta app)',
  facebook: 'reads Facebook Page messages (needs the Meta app)',
  whatsapp: 'messages you paste in',
  telegram: 'reads messages to your bot (below)',
  tiktok: 'messages you paste in',
  linkedin: 'messages you paste in',
};
const newFolder = ref('');
function addFolder() {
  const f = newFolder.value.trim();
  if (f && !draft.value!.emailFolders.includes(f)) draft.value!.emailFolders.push(f);
  newFolder.value = '';
}
function removeFolder(f: string) {
  draft.value!.emailFolders = draft.value!.emailFolders.filter((x) => x !== f);
}
const telegramTest = ref<string | null>(null);
async function testTelegramBot() {
  telegramTest.value = 'Connecting…';
  const r = await run(() => api<{ ok: boolean; username?: string; error?: string }>('/telegram/test', { method: 'POST' }));
  telegramTest.value = !r ? null : r.ok ? `Connected as @${r.username}. People can message it at t.me/${r.username}.` : r.error ?? 'Failed';
}
async function checkTelegramNow() {
  const r = await run(() => api<{ agentRunning: boolean }>('/telegram/check-now', { method: 'POST' }));
  if (r) toast(r.agentRunning ? 'Checking Telegram now' : 'Queued. It runs when you press Start');
}
const mailbox = ref<MailboxStatus | null>(null);
const mailboxTest = ref<string | null>(null);
async function loadMailbox() {
  mailbox.value = await api<MailboxStatus>('/inbox/status').catch(() => null);
}
async function testMailbox() {
  mailboxTest.value = 'Connecting…';
  const r = await run(() => api<{ ok: boolean; messages?: number; error?: string }>('/inbox/test', { method: 'POST' }));
  mailboxTest.value = !r ? null : r.ok ? `Connected. ${r.messages} message(s) in ${mailbox.value?.mailbox}; nothing was read or changed.` : r.error ?? 'Failed';
}
async function setReadReplies(on: boolean) {
  const what = saved.value?.emailReadAll
    ? 'Every message in the chosen folders is downloaded and shown in the Inbox (newsletters and no-reply senders are skipped).'
    : 'Only mail from leads, or answering an outreach subject, is downloaded; the rest is never fetched.';
  if (on && !confirm(`Start reading ${mailbox.value?.user}?\n\nRead-only: nothing is marked read, moved or deleted. ${what}`)) return;
  await applyNow({ readReplies: on }, on ? 'Reading replies is on' : 'Reading replies is off');
  await loadMailbox();
}

interface EmailStatus {
  mode: 'dry_run' | 'live'; from: string | null; fromDomain: string | null; replyTo: string | null; apiKeySet: boolean;
  problems: Array<{ field: string; message: string }>; sentToday: number; dailyLimit: number;
  queued: { approved: number; sending: number }; nextSend: string;
}
const email = ref<EmailStatus | null>(null);
const domainResult = ref<string | null>(null);
async function loadEmail() {
  email.value = await api<EmailStatus>('/email/status').catch(() => null);
}
async function checkDomain() {
  const r = await run(() => api<{ status: string; domain: string; detail?: string }>('/email/check-domain', { method: 'POST' }));
  if (r) domainResult.value = { verified: `${r.domain} is verified in Resend.`, not_verified: `${r.domain} is added but not verified yet (${r.detail}).`, not_found: `${r.domain} is not added in Resend yet.`, unknown: r.detail ?? 'Unknown' }[r.status] ?? r.status;
}
async function sendTest() {
  if (!email.value?.replyTo || !confirm(`Send one real test email from ${email.value.from} to your own mailbox ${email.value.replyTo}?`)) return;
  await run(() => api('/email/test', { method: 'POST' }), `Test email sent to ${email.value.replyTo}. Reply to it to check replies arrive.`);
}
async function setSendingMode(mode: 'dry_run' | 'live') {
  if (mode === 'live' && !confirm('Switch to LIVE sending?\n\nApproved emails will be sent to real merchants through Resend, within your daily limit and sending hours. Nothing unapproved is ever sent.')) return;
  await applyNow({ emailSendingMode: mode }, mode === 'live' ? 'Email sending is live' : 'Back to dry run');
  await loadEmail();
}

// Channels: tried in the order listed; you can move one up.
const channelHint: Record<Channel, string> = {
  email: 'when the lead has an address; sent by the agent',
  whatsapp: "when there's a mobile number; you send it",
  instagram: 'when the lead has an Instagram profile; you send it',
  facebook: 'when the lead has a Facebook page; you send it',
  tiktok: 'when the lead has a TikTok profile; you send it',
  telegram: 'when the lead has a Telegram username; you send it',
  linkedin: 'when the lead has a LinkedIn profile; you send it',
};
const channelRows = computed(() => {
  const on = draft.value?.draftChannels ?? [];
  return [...on, ...CHANNELS.filter((c) => !on.includes(c))];
});
function toggleChannel(c: Channel, enabled: boolean) {
  const list = draft.value!.draftChannels.filter((x) => x !== c);
  draft.value!.draftChannels = enabled ? [...list, c] : list;
}
function moveUp(c: Channel) {
  const list = [...draft.value!.draftChannels];
  const i = list.indexOf(c);
  if (i > 0) [list[i - 1], list[i]] = [list[i]!, list[i - 1]!];
  draft.value!.draftChannels = list;
}

// Interest form and referrals.
interface LastImport { at: string; error?: string; rows?: number; created?: number; merged?: number; alreadyImported?: number; referrals?: number; skipped?: Record<string, number>; missingColumns?: string[] }
interface InboundStatus { responses: number; leads: number; referred: number; codes: number; lastImport: LastImport | null }
const inbound = ref<InboundStatus | null>(null);
const sheetTest = ref<{ headers: string[]; matched: Partial<Record<FormField, string>>; missing: FormField[]; rows: number } | null>(null);
const testingSheet = ref(false);
async function loadInbound() {
  inbound.value = await api<InboundStatus>('/inbound/status').catch(() => null);
}
async function testSheet() {
  testingSheet.value = true;
  sheetTest.value = (await run(() => api<NonNullable<typeof sheetTest.value>>('/inbound/test', { method: 'POST', body: draft.value!.interestFormCsvUrl ? { url: draft.value!.interestFormCsvUrl } : {} }))) ?? null;
  testingSheet.value = false;
}
async function checkFormNow() {
  const r = await run(() => api<{ agentRunning: boolean }>('/inbound/check-now', { method: 'POST' }));
  if (r) toast(r.agentRunning ? 'Reading the form answers now' : 'Queued. It runs when you press Start');
  setTimeout(loadInbound, 3000);
}
const formFieldLabel: Record<FormField, string> = {
  timestamp: 'Timestamp', businessName: 'Business name (required)', phone: 'WhatsApp / phone number', email: 'Email',
  instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', telegram: 'Telegram', category: 'What they sell',
  city: 'City', state: 'State', consent: 'Consent box', referredBy: 'Who referred you?', referralCode: 'Referral code (from personal links)',
};
const skipText: Record<string, string> = { NO_CONSENT: 'without consent', NO_BUSINESS_NAME: 'without a business name', NO_CONTACT: 'without any contact', INVALID: 'unreadable' };

// Meta app: Instagram lookup and the Instagram/Facebook inbox.
interface MetaStatus {
  problems: Array<{ key: string; message: string }>; pageId: string | null; appSecretProof: boolean; graphVersion: string;
  replySending: 'manual' | 'live'; contacts: number; linked: number; looked_up: number;
  lastCheck: ({ at: string; replies: number; unmatched: number; conversations: number }) | null;
}
const meta = ref<MetaStatus | null>(null);
const metaTest = ref<string | null>(null);
async function loadMeta() {
  meta.value = await api<MetaStatus>('/meta/status').catch(() => null);
}
async function testMetaConnection() {
  metaTest.value = 'Connecting…';
  const r = await run(() => api<{ ok: boolean; page?: string; instagram?: string | null; error?: string }>('/meta/test', { method: 'POST' }));
  metaTest.value = !r ? null : r.ok ? `Connected to the Page "${r.page}"${r.instagram ? ` and Instagram @${r.instagram}` : ', but no Instagram account is linked to it'}. Nothing was read or changed.` : r.error ?? 'Failed';
}
async function checkMetaNow() {
  const r = await run(() => api<{ agentRunning: boolean }>('/meta/check-now', { method: 'POST' }));
  if (r) toast(r.agentRunning ? 'Reading Instagram and Facebook messages now' : 'Queued. It runs when you press Start');
  setTimeout(loadMeta, 4000);
}
async function setMetaReplySending(mode: 'manual' | 'live') {
  if (mode === 'live' && !confirm('Send approved Instagram and Facebook replies through Meta?\n\nOnly replies you approve, to someone who messaged you in the last 24 hours, in the same chat. Cold messages are never sent this way, and the agent never approves these replies itself.')) return;
  await applyNow({ metaReplySending: mode }, mode === 'live' ? 'Approved replies now go through Meta' : 'You send Instagram and Facebook replies yourself');
  await loadMeta();
}
function togglePlatform(p: 'instagram' | 'facebook', on: boolean) {
  const list = draft.value!.metaInboxPlatforms.filter((x) => x !== p);
  draft.value!.metaInboxPlatforms = on ? [...list, p] : list;
}

// Web search (Tavily / Brave) and WhatsApp group exports.
type SearchProvider = 'tavily' | 'brave';
interface SearchStatus { providers: Array<{ id: SearchProvider; enabled: boolean; keySet: boolean; problems: string[]; usedThisMonth: number; limit: number }> }
const search = ref<SearchStatus | null>(null);
async function loadSearch() {
  search.value = await api<SearchStatus>('/web-search/status').catch(() => null);
}
const SEARCH_PROVIDERS = ['tavily', 'brave'] as const;
const providerInfo: Record<SearchProvider, { name: string; env: string; cost: string }> = {
  tavily: { name: 'Tavily', env: 'TAVILY_API_KEY', cost: 'Free plan: 1,000 credits a month, no card. One basic search uses 1 credit.' },
  brave: { name: 'Brave Search', env: 'BRAVE_SEARCH_API_KEY', cost: 'About $5 per 1,000 searches, with a $5 credit each month. Needs a card and has no spending cap of its own, so keep the limit below 1,000.' },
};
const providerState = (p: SearchProvider) => search.value?.providers.find((x) => x.id === p);
function toggleProvider(p: SearchProvider, on: boolean) {
  const list = draft.value!.webSearchProviders.filter((x) => x !== p);
  draft.value!.webSearchProviders = on ? [...list, p] : list;
}
const firstLinePreview = computed(() => (draft.value?.groupFirstLine ?? '').replace(/\{\{\s*group\s*\}\}/g, 'Lagos Fabric Sellers'));

interface Integration { id: string; name: string; status: string; cost?: string; note: string }
const integrations = ref<Integration[]>([]);
const options = ref<Options | null>(null);

onMounted(async () => {
  const s = await api<Settings>('/settings').catch(() => null);
  saved.value = s;
  draft.value = s ? clone(s) : null;
  void loadEmail();
  void loadMailbox();
  void loadAi();
  void loadInbound();
  void loadMeta();
  void loadSearch();
  options.value = await getOptions().catch(() => null);
  autostart.value = await api<{ supported: boolean; enabled: boolean; path: string | null }>('/system/autostart').catch(() => null);
  startWithWindows.value = autostart.value?.enabled ?? false;
  integrations.value = (await api<{ items: Integration[] }>('/integrations').catch(() => ({ items: [] }))).items;
});

const modes = [
  { id: 'research', name: 'Research Mode', text: 'Discovers and qualifies leads. Never drafts or sends anything.' },
  { id: 'approval', name: 'Approval Mode (default)', text: 'Drafts wait in a queue for you to edit, approve or reject. Nothing is sent without your approval.' },
  { id: 'autonomous', name: 'Controlled Autonomous Mode', text: 'The agent approves its own template emails within the limits under AI & autonomy, and sends answers on the channels you set to auto-send (Inbox & answers). AI-written outreach and messages you send yourself always wait for you.' },
] as const;
const statusCls: Record<string, string> = { off: '', working: 'ok', available: 'ok', dry_run: 'info', not_configured: 'warn', not_built: '', unsupported: 'warn', error: 'danger' };
const statusText: Record<string, string> = { off: 'Off', working: 'Working', available: 'Available', dry_run: 'Dry run', not_configured: 'Needs set-up', not_built: 'Not built yet', unsupported: 'Not supported', error: 'Error' };
</script>

<template>
  <div class="page-head">
    <div>
      <h1>Settings</h1>
      <p>Saved in the local database when you press Save in each section. Secrets (API keys, passwords) stay in <code>.env</code> and are never shown here.</p>
    </div>
  </div>

  <template v-if="draft && saved">
    <nav class="tabs" role="tablist" aria-label="Settings sections">
      <button v-for="t in TABS" :key="t.id" class="tab" :class="{ on: tab === t.id }" role="tab" :aria-selected="tab === t.id" @click="tab = t.id">
        {{ t.label }}<span v-if="tabDirty(t)" class="dot" title="Unsaved changes"></span>
      </button>
    </nav>

    <!-- ── General ── -->
    <template v-if="tab === 'general'">
      <SettingsSection title="Operating mode" :dirty="dirty('mode')" :saving="saving === 'mode'" @save="save('mode')" @cancel="cancel('mode')">
        <div class="grid grid-3">
          <label v-for="m in modes" :key="m.id" class="card check" style="align-items: flex-start; margin: 0">
            <input v-model="draft.mode" type="radio" name="mode" :value="m.id" />
            <span><strong>{{ m.name }}</strong><br /><span class="muted small">{{ m.text }}</span></span>
          </label>
        </div>
      </SettingsSection>

      <SettingsSection title="Sender and links" :dirty="dirty('sender')" :saving="saving === 'sender'" @save="save('sender')" @cancel="cancel('sender')">
        <div v-if="!saved.senderName" class="banner warn" style="margin-top: 0">Set your name to start drafting messages.</div>
        <div class="grid grid-2">
          <label class="field">Your name<input v-model.trim="draft.senderName" placeholder="e.g. Muritala Alawiye" /><small>Signs every message.</small></label>
          <label class="field">Your role<input v-model.trim="draft.senderTitle" /><small>e.g. "Founder, StockỌja".</small></label>
          <label class="field">Registration page<input v-model.trim="draft.registrationUrl" type="url" /><small>Links get tracking tags (utm_*) and your referral code.</small></label>
          <label class="field">Referral code<input v-model.trim="draft.referralCode" placeholder="optional" /><small>An affiliate code from StockỌja's admin, so sign-ups are attributed to outreach.</small></label>
          <label class="field">Demo booking link<input v-model.trim="draft.bookingUrl" type="url" placeholder="https://cal.com/…" /><small>Your Cal.com or Calendly page. Without it, messages ask the merchant to reply to arrange a time; the agent never proposes times itself.</small></label>
          <label class="field">Tutorial link<input v-model.trim="draft.tutorialUrl" type="url" placeholder="optional" /><small>A getting-started guide to share when asked.</small></label>
        </div>
      </SettingsSection>
    </template>

    <!-- ── Outreach ── -->
    <template v-if="tab === 'outreach'">
      <SettingsSection title="Drafting" :dirty="dirty('drafting')" :saving="saving === 'drafting'" @save="save('drafting')" @cancel="cancel('drafting')">
        <label class="check"><input v-model="draft.autoDraft" type="checkbox" /> While running, draft introductions for newly qualified leads (every 30 minutes)</label>
        <label class="field" style="margin-top: 12px; max-width: 320px">Most drafts per day<input v-model.number="draft.dailyDraftLimit" type="number" min="0" max="500" /><small>Keeps the approval queue a size you can review.</small></label>
        <h3 style="margin: 16px 0 6px">Channels</h3>
        <p class="muted small" style="margin-top: 0">For each lead the agent uses the first ticked channel it has an address for, in this order.</p>
        <ul class="list">
          <li v-for="c in channelRows" :key="c" class="btn-row" style="justify-content: space-between">
            <label class="check" style="margin: 0">
              <input type="checkbox" :checked="draft.draftChannels.includes(c)" @change="toggleChannel(c, ($event.target as HTMLInputElement).checked)" />
              <span><strong>{{ channelLabel[c] }}</strong> <span class="muted small">({{ channelHint[c] }})</span></span>
            </label>
            <button v-if="draft.draftChannels.indexOf(c) > 0" class="btn small" :aria-label="`Move ${channelLabel[c]} up`" @click="moveUp(c)">↑ Earlier</button>
          </li>
        </ul>
        <p class="muted small" style="margin: 10px 0 0">
          Drafts always wait in the approval queue. For Instagram, Facebook, TikTok and Telegram you copy the approved text, open their chat and send it
          yourself; no account is logged in to or automated. Leads on the do-not-contact list, or without an address on a channel, are skipped.
        </p>
      </SettingsSection>
    </template>

    <!-- ── Email ── -->
    <template v-if="tab === 'email'">
      <SettingsSection title="Email sending" :dirty="dirty('sending')" :saving="saving === 'sending'" @save="save('sending')" @cancel="cancel('sending')">
        <template #badge><span class="pill" :class="saved.emailSendingMode === 'live' ? 'danger' : 'info'">{{ saved.emailSendingMode === 'live' ? 'LIVE' : 'Dry run' }}</span></template>
        <p class="muted small" style="margin-top: 0">
          <template v-if="saved.emailSendingMode === 'dry_run'">Approved emails are rendered and logged exactly as they would be sent, but nothing leaves your laptop.</template>
          <template v-else>Approved emails are sent through Resend, within the limits below. Nothing unapproved is ever sent.</template>
        </p>
        <dl class="kv small" v-if="email">
          <dt>From</dt><dd>{{ saved.senderName || '(your name)' }} &lt;{{ email.from ?? 'not set' }}&gt;</dd>
          <dt>Replies go to</dt><dd>{{ email.replyTo ?? 'not set' }}</dd>
          <dt>Resend API key</dt><dd>{{ email.apiKeySet ? 'Set in .env' : 'Not set' }}</dd>
          <dt>Today</dt><dd>{{ email.sentToday }} of {{ email.dailyLimit }} sent · {{ email.queued.approved }} approved and waiting<span v-if="email.queued.sending"> · {{ email.queued.sending }} being sent</span></dd>
          <dt>Next send</dt><dd>{{ email.nextSend }}</dd>
        </dl>
        <div v-if="email?.problems.length" class="banner warn" style="margin: 10px 0 0">
          Before live sending:
          <ul style="margin: 4px 0 0; padding-left: 18px"><li v-for="p in email.problems" :key="p.field">{{ p.message }}</li></ul>
          <div class="small" style="margin-top: 4px">Values in .env are read when the app starts: restart it after editing.</div>
        </div>
        <div class="btn-row" style="margin-top: 12px">
          <button class="btn" :disabled="!email?.apiKeySet || !email?.fromDomain" @click="checkDomain">Check domain in Resend</button>
          <button class="btn" :disabled="!!email?.problems.length" @click="sendTest">Send a test email to me</button>
          <button v-if="saved.emailSendingMode === 'dry_run'" class="btn primary" :disabled="!!email?.problems.length" @click="setSendingMode('live')">Switch to live sending</button>
          <button v-else class="btn danger" @click="setSendingMode('dry_run')">Back to dry run</button>
        </div>
        <p v-if="domainResult" class="small" style="margin: 8px 0 0">{{ domainResult }}</p>
        <div class="grid grid-2" style="margin-top: 16px">
          <label class="field">Most emails per day<input v-model.number="draft.dailyEmailLimit" type="number" min="1" max="100" /><small>Resend's free tier allows 100 a day. Start low on a new domain (10–20) and raise it slowly.</small></label>
          <label class="field">Seconds between emails<input v-model.number="draft.minSecondsBetweenEmails" type="number" min="10" max="3600" /></label>
          <label class="field">Sending starts (hour, Lagos time)<input v-model.number="draft.sendWindowStartHour" type="number" min="0" max="23" /></label>
          <label class="field">Sending ends (hour, Lagos time)<input v-model.number="draft.sendWindowEndHour" type="number" min="1" max="24" /></label>
        </div>
        <label class="check" style="margin-top: 10px"><input v-model="draft.sendOnWeekends" type="checkbox" /> Also send on Saturdays and Sundays</label>
      </SettingsSection>

      <SettingsSection title="Follow-ups" :dirty="dirty('followups')" :saving="saving === 'followups'" @save="save('followups')" @cancel="cancel('followups')">
        <label class="check"><input v-model="draft.followUpsEnabled" type="checkbox" /> Draft follow-ups when an introduction email gets no reply</label>
        <div class="grid grid-2" style="margin-top: 10px">
          <label class="field">Follow-up 1 after (days)<input v-model.number="draft.followUp1AfterDays" type="number" min="1" max="30" /></label>
          <label class="field">Follow-up 2 after follow-up 1 (days)<input v-model.number="draft.followUp2AfterDays" type="number" min="1" max="30" /></label>
        </div>
        <p class="muted small" style="margin: 8px 0 0">Follow-ups are drafts for your approval too. A reply, or any status you set on the lead, cancels them. Only emails actually sent (not dry runs) start a sequence.</p>
      </SettingsSection>
    </template>

    <!-- ── Inbox & answers ── -->
    <template v-if="tab === 'inbox'">
      <SettingsSection id="inbox" title="Inbox access" :dirty="dirty('inbox')" :saving="saving === 'inbox'" @save="save('inbox')" @cancel="cancel('inbox')">
        <p class="muted small" style="margin-top: 0">
          Which channels the agent may read and answer. Off: it doesn't fetch, label or draft anything there (messages already in the Inbox stay).
        </p>
        <label v-for="c in INBOX_CHANNELS" :key="c" class="check">
          <input v-model="draft.inboxAccess[c]" type="checkbox" /> {{ channelLabel[c] }} <span class="muted small">· {{ accessHint[c] }}</span>
        </label>
      </SettingsSection>

      <SettingsSection title="Email mailbox" :dirty="dirty('replies')" :saving="saving === 'replies'" @save="save('replies')" @cancel="cancel('replies')">
        <template #badge><span class="pill" :class="saved.readReplies ? 'ok' : ''">{{ saved.readReplies ? 'Reading' : 'Off' }}</span></template>
        <p class="muted small" style="margin-top: 0">
          Reads your mailbox over IMAP, <strong>read-only</strong> (nothing is marked read, moved or deleted). Messages are labelled, STOP goes on the
          do-not-contact list, follow-ups stop, and answers are drafted for you as set under Answers below.
        </p>
        <dl class="kv" v-if="mailbox">
          <dt>Mailbox</dt><dd>{{ mailbox.user ? `${mailbox.user} on ${mailbox.host} (${mailbox.mailbox})` : 'Not set in .env' }}</dd>
          <dt>Replies go to</dt><dd>{{ mailbox.replyTo ?? 'not set' }}</dd>
          <dt>Last check</dt>
          <dd>
            <template v-if="mailbox.lastCheck">{{ new Date(mailbox.lastCheck.at).toLocaleString() }}: {{ mailbox.lastCheck.looked }} looked at, {{ mailbox.lastCheck.replies }} from leads, {{ mailbox.lastCheck.unmatched ?? 0 }} from others</template>
            <template v-else>Never</template>
          </dd>
        </dl>
        <div v-if="mailbox?.problems.length" class="banner warn">
          <div v-for="p in mailbox.problems" :key="p.field">{{ p.message }}</div>
          <div class="small">Values in .env are read when the app starts: restart it after editing.</div>
        </div>
        <div v-if="mailbox?.user && mailbox.replyTo && mailbox.user.toLowerCase() !== mailbox.replyTo.toLowerCase()" class="banner info">
          The mailbox login ({{ mailbox.user }}) differs from the Reply-To address ({{ mailbox.replyTo }}). That's fine if replies are delivered or forwarded there.
        </div>
        <div class="btn-row" style="margin: 10px 0">
          <button class="btn" :disabled="!!mailbox?.problems.length" @click="testMailbox">Test connection</button>
          <button v-if="!saved.readReplies" class="btn primary" :disabled="!!mailbox?.problems.length" @click="setReadReplies(true)">Start reading the mailbox</button>
          <button v-else class="btn" @click="setReadReplies(false)">Stop reading the mailbox</button>
        </div>
        <p v-if="mailboxTest" class="small">{{ mailboxTest }}</p>
        <div class="grid grid-2">
          <label class="field">Check every (minutes)<input v-model.number="draft.replyCheckMinutes" type="number" min="2" max="60" /><small>Only while the agent is running.</small></label>
          <label class="field">First check looks back (days)<input v-model.number="draft.replyLookbackDays" type="number" min="1" max="60" /><small>Later checks read only new mail.</small></label>
        </div>
        <label class="check"><input v-model="draft.emailReadAll" type="checkbox" /> Show every message in the Inbox, not only replies to outreach <span class="muted small">(no-reply senders and newsletters are skipped)</span></label>
        <h3 style="margin: 14px 0 6px">Folders to read</h3>
        <p class="muted small" style="margin-top: 0">Folder names as your mail provider shows them (e.g. INBOX, Sales). Empty: {{ mailbox?.mailbox ?? 'INBOX' }} from .env.</p>
        <ul v-if="draft.emailFolders.length" class="list">
          <li v-for="f in draft.emailFolders" :key="f" class="btn-row" style="justify-content: space-between">
            <span>{{ f }}</span><button class="btn small danger" @click="removeFolder(f)">Remove</button>
          </li>
        </ul>
        <form class="btn-row" @submit.prevent="addFolder">
          <input v-model="newFolder" style="max-width: 240px" placeholder="Folder name" aria-label="Folder name" />
          <button class="btn" :disabled="!newFolder.trim() || draft.emailFolders.length >= 10">Add folder</button>
        </form>
      </SettingsSection>

      <SettingsSection id="telegram" title="Telegram bot" :dirty="dirty('telegram')" :saving="saving === 'telegram'" @save="save('telegram')" @cancel="cancel('telegram')">
        <template #badge>
          <span class="pill" :class="mailbox?.telegram.problems.length ? '' : saved.inboxAccess.telegram ? 'ok' : 'info'">
            {{ mailbox?.telegram.problems.length ? 'No bot token' : saved.inboxAccess.telegram ? 'Reading' : 'Ready, off' }}
          </span>
        </template>
        <p class="muted small" style="margin-top: 0">
          People who message your bot appear in the Inbox; answers go back through the bot once approved. Your personal Telegram account is never used.
        </p>
        <div v-if="mailbox?.telegram.problems.length" class="banner info">
          To use it: in Telegram, message <strong>@BotFather</strong>, send <code>/newbot</code>, and put the token it gives you in <code>.env</code> as
          <code>TELEGRAM_BOT_TOKEN=…</code>, then restart the app. Free.
        </div>
        <dl v-else class="kv small">
          <dt>Last check</dt><dd>{{ mailbox?.telegram.lastCheck ? new Date(mailbox.telegram.lastCheck.at).toLocaleString() : 'Never' }}</dd>
        </dl>
        <div class="btn-row" style="margin: 10px 0">
          <button class="btn" :disabled="!!mailbox?.telegram.problems.length" @click="testTelegramBot">Test the bot</button>
          <button class="btn" :disabled="!!mailbox?.telegram.problems.length || !saved.inboxAccess.telegram" @click="checkTelegramNow">Check now</button>
        </div>
        <p v-if="telegramTest" class="small">{{ telegramTest }}</p>
        <label class="field" style="max-width: 260px">Check every (minutes)<input v-model.number="draft.telegramCheckMinutes" type="number" min="1" max="1440" /><small>Only while the agent is running.</small></label>
      </SettingsSection>

      <SettingsSection title="Answers" :dirty="dirty('answers')" :saving="saving === 'answers'" @save="save('answers')" @cancel="cancel('answers')">
        <p class="muted small" style="margin-top: 0">
          What the agent does when someone writes to you, per channel.
          <strong>Off</strong>: nothing; you answer from the Inbox.
          <strong>Draft</strong>: it drafts an answer{{ ai?.configured && saved.aiDraftReplies ? ' with AI, from your knowledge' : ' from your approved knowledge base' }}, for you to approve.
          <strong>Auto-send</strong>: in Controlled Autonomous Mode it sends answers itself, but only ones with no warnings, built from your knowledge; anything else waits for you.
        </p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Channel</th><th>Answers</th></tr></thead>
            <tbody>
              <tr v-for="c in INBOX_CHANNELS" :key="c">
                <td>{{ channelLabel[c] }}<span v-if="!saved.inboxAccess[c]" class="muted small"> · switched off above</span></td>
                <td>
                  <select v-model="draft.replyAutonomy[c]" :aria-label="`Answers on ${channelLabel[c]}`">
                    <option value="off">Off</option>
                    <option value="draft">Draft for my approval</option>
                    <option v-if="AUTO_SEND_CHANNELS.includes(c)" value="auto_send">Auto-send</option>
                  </select>
                  <small v-if="!AUTO_SEND_CHANNELS.includes(c)" class="muted"> You send these yourself.</small>
                  <small v-else-if="(c === 'instagram' || c === 'facebook') && draft.replyAutonomy[c] === 'auto_send'" class="muted"> Only within Meta's 24 hours, with Meta replies set to live.</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="saved.mode !== 'autonomous' && INBOX_CHANNELS.some((c) => draft!.replyAutonomy[c] === 'auto_send')" class="banner info small" style="margin-top: 10px">
          Auto-send only works in Controlled Autonomous Mode (General → Operating mode). Until then these answers wait for you.
        </p>
        <label class="check" style="margin-top: 10px"><input v-model="draft.autoDraftReplies" type="checkbox" /> When AI isn't available, draft answers from approved knowledge-base entries</label>
      </SettingsSection>
    </template>

    <!-- ── Knowledge ── -->
    <template v-if="tab === 'knowledge'">

      <SettingsSection id="knowledge" title="Knowledge" :dirty="dirty('knowledge')" :saving="saving === 'knowledge'" @save="save('knowledge')" @cancel="cancel('knowledge')">
        <template #actions><RouterLink class="btn small" to="/knowledge">Open Knowledge</RouterLink></template>
        <p class="muted small" style="margin-top: 0">Default chunking for new documents and for website pages. Re-chunk existing ones from the Knowledge page.</p>
        <div class="grid grid-3">
          <label class="field">Strategy
            <select v-model="draft.knowledgeChunkStrategy">
              <option value="structure">Follow structure (headings, paragraphs)</option>
              <option value="fixed">Fixed window of words</option>
            </select>
          </label>
          <label class="field">Words per chunk<input v-model.number="draft.knowledgeChunkWords" type="number" min="50" max="400" /><small>150–250 suits most text.</small></label>
          <label class="field">Overlap (words)<input v-model.number="draft.knowledgeChunkOverlap" type="number" min="0" max="200" /><small>At most half the chunk size.</small></label>
        </div>
        <h3 style="margin: 16px 0 8px">Your website links</h3>
        <p class="muted small" style="margin-top: 0">StockỌja pages to read into the knowledge base: home, pricing, features, help centre, FAQ… The agent follows links under each one on the same site, honours robots.txt, and only reads public pages.</p>
        <ul v-if="draft.websiteLinks.length" class="list">
          <li v-for="l in draft.websiteLinks" :key="l" class="btn-row" style="justify-content: space-between">
            <a :href="l" target="_blank" rel="noopener noreferrer">{{ l }}</a>
            <button class="btn small danger" @click="removeLink(l)">Remove</button>
          </li>
        </ul>
        <form class="btn-row" @submit.prevent="addLink">
          <input v-model="newLink" type="url" style="flex: 1" placeholder="https://stockoja.com/pricing" />
          <button class="btn" :disabled="!newLink.trim() || draft.websiteLinks.length >= 20">Add link</button>
          <button type="button" class="btn primary" :disabled="!saved.websiteLinks.length || dirty('knowledge')" :title="dirty('knowledge') ? 'Save your changes first' : ''" @click="readWebsiteNow">Read now</button>
        </form>
        <div class="grid grid-2" style="margin-top: 10px">
          <label class="field">Most pages per link<input v-model.number="draft.websiteMaxPages" type="number" min="1" max="200" /><small>1 = only that page.</small></label>
          <label class="field">Read again every (days)<input v-model.number="draft.websiteRefreshDays" type="number" min="0" max="90" /><small>While the agent runs. 0 = only when you press Read now.</small></label>
        </div>
      </SettingsSection>
    </template>

    <!-- ── Leads & form ── -->
    <template v-if="tab === 'leads'">
      <SettingsSection title="Qualification and discovery" :dirty="dirty('qualification')" :saving="saving === 'qualification'" @save="save('qualification')" @cancel="cancel('qualification')">
        <div class="grid grid-2">
          <label class="field">Qualification threshold<input v-model.number="draft.qualifyThreshold" type="number" min="0" max="100" /><small>Leads at or above this score, with a contact channel, become “Qualified”. Changing it re-scores every lead you have not set yourself.</small></label>
          <label class="field">Gap between OpenStreetMap searches (seconds)<input v-model.number="draft.overpassMinIntervalSec" type="number" min="5" max="600" /><small>Keeps us within OpenStreetMap's fair-use policy.</small></label>
          <label class="field">Gap between website requests (seconds)<input v-model.number="draft.websiteMinIntervalSec" type="number" min="1" max="120" /></label>
          <label class="field">Overdue grace (minutes)<input v-model.number="draft.overdueGraceMinutes" type="number" min="5" /><small>Time-sensitive tasks this late at start-up are held for review instead of sent late.</small></label>
        </div>
        <label class="check" style="margin-top: 14px"><input v-model="draft.enrichWebsites" type="checkbox" /> Check each lead's own website for a public contact email (follows the site's robots.txt rules)</label>
      </SettingsSection>

      <SettingsSection id="interest-form" title="Interest form" :dirty="dirty('form')" :saving="saving === 'form'" @save="save('form')" @cancel="cancel('form')">
        <template #badge><span class="pill" :class="saved.interestFormEnabled ? 'ok' : ''">{{ saved.interestFormEnabled ? 'On' : 'Off' }}</span></template>
        <p class="muted small" style="margin-top: 0">
          Merchants who want to hear from us fill in a Google Form (free, always online). While the agent runs it reads the form's published response
          sheet and adds each new answer as a lead, marked "asked to hear from us". Nothing is written back to Google and no Google login is stored.
        </p>
        <label class="check"><input v-model="draft.interestFormEnabled" type="checkbox" /> Import new answers from the form</label>
        <div class="grid grid-2" style="margin-top: 10px">
          <label class="field">Form link (what merchants open)<input v-model.trim="draft.interestFormUrl" type="url" placeholder="https://forms.gle/…" /><small>For your bio and status, and <code v-text="'{{interest_form_link}}'"></code> in templates.</small></label>
          <label class="field">Response sheet, published as CSV<input v-model.trim="draft.interestFormCsvUrl" type="url" placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?output=csv" /><small>Read-only. See "How to set it up" below.</small></label>
          <label class="field">Read the sheet every (minutes)<input v-model.number="draft.interestFormCheckMinutes" type="number" min="5" max="1440" /><small>Only while the agent runs.</small></label>
          <label class="field">When "What do you sell" doesn't match a category
            <select v-model="draft.interestFormDefaultCategory"><option v-for="c in options?.categories" :key="c.id" :value="c.id">{{ c.label }}</option></select>
            <small>Their own answer is kept in the lead's notes.</small>
          </label>
        </div>
        <label class="check" style="margin-top: 10px"><input v-model="draft.interestFormRequireConsent" type="checkbox" /> Only import answers where the consent box is ticked (recommended)</label>

        <details style="margin-top: 12px">
          <summary class="small">Column titles in your sheet</summary>
          <p class="muted small">Each field is found by its column title (ignoring case). A column that starts with the title also matches, so a long question works. Leave a field empty if your form doesn't ask it.</p>
          <div class="grid grid-3" style="gap: 10px">
            <label v-for="(label, f) in formFieldLabel" :key="f" class="field">{{ label }}<input v-model="draft.interestFormColumns[f]" /></label>
          </div>
        </details>

        <div class="btn-row" style="margin-top: 12px">
          <button class="btn" :disabled="!draft.interestFormCsvUrl || testingSheet" @click="testSheet">{{ testingSheet ? 'Reading…' : 'Test the sheet' }}</button>
          <button class="btn primary" :disabled="!saved.interestFormEnabled || dirty('form')" :title="dirty('form') ? 'Save your changes first' : ''" @click="checkFormNow">Check for new answers now</button>
        </div>
        <div v-if="sheetTest" class="banner info small" style="margin-top: 10px">
          Found {{ sheetTest.rows }} answer(s). Nothing was imported.
          <div>Matched: <span v-for="(h, f) in sheetTest.matched" :key="f">{{ formFieldLabel[f] }} → "{{ h }}"; </span></div>
          <div v-if="sheetTest.missing.length"><strong>Not found:</strong> {{ sheetTest.missing.map((f) => formFieldLabel[f]).join(', ') }}. Fix the titles under "Column titles", or clear the ones your form doesn't ask.</div>
          <div v-if="!sheetTest.matched.businessName"><strong>The business name column is needed.</strong></div>
        </div>
        <dl v-if="inbound" class="kv small" style="margin-top: 12px">
          <dt>From the form</dt><dd>{{ inbound.leads }} lead(s) · {{ inbound.responses }} answer(s) read</dd>
          <dt>Last read</dt>
          <dd>
            <template v-if="!inbound.lastImport">Never</template>
            <template v-else-if="inbound.lastImport.error">{{ new Date(inbound.lastImport.at).toLocaleString() }}: <span style="color: var(--danger)">{{ inbound.lastImport.error }}</span></template>
            <template v-else>
              {{ new Date(inbound.lastImport.at).toLocaleString() }}: {{ inbound.lastImport.created }} new, {{ inbound.lastImport.merged }} matched existing leads, {{ inbound.lastImport.referrals }} referral(s) linked
              <span v-for="(n, k) in inbound.lastImport.skipped" :key="k">· {{ n }} skipped {{ skipText[k] ?? k }} </span>
            </template>
          </dd>
        </dl>

        <details style="margin-top: 12px">
          <summary class="small">How to set it up (Google Forms, free)</summary>
          <ol class="small" style="margin: 8px 0 0; padding-left: 18px">
            <li>Create a form at forms.google.com with these questions: <em>Business name</em>, <em>WhatsApp number</em>, <em>Email</em>, <em>Instagram</em>, <em>What do you sell?</em>, <em>City</em>, <em>State</em>, and a required checkbox <em>Consent</em> ("StockỌja may contact me about its app by WhatsApp, email or DM"). Add <em>Who referred you?</em> and a short-answer <em>Referral code</em> if you use referrals.</li>
            <li>In the form: Responses → Link to Sheets.</li>
            <li>In the sheet: File → Share → Publish to web → choose the responses sheet and "Comma-separated values (.csv)" → Publish, then copy the link into "Response sheet" above.</li>
            <li>Press "Test the sheet" to check the columns, then switch the import on and Save.</li>
          </ol>
          <p class="muted small" style="margin: 6px 0 0">Anyone with the published link can read the responses, so keep the link to yourself, and ask only for what you need.</p>
        </details>
      </SettingsSection>

      <SettingsSection id="referrals" title="Referrals" :dirty="dirty('referrals')" :saving="saving === 'referrals'" @save="save('referrals')" @cancel="cancel('referrals')">
        <p class="muted small" style="margin-top: 0">
          Merchants who know StockỌja can send other vendors to the form. Switch on what you want; both are off by default.
          <span v-if="inbound"> So far: {{ inbound.referred }} referred lead(s), {{ inbound.codes }} personal link(s) handed out.</span>
        </p>
        <label class="check"><input v-model="draft.referralAskEnabled" type="checkbox" /> Read "Who referred you?" and link the new lead to the merchant they name (by phone, email, @handle, or exact business name; anything unclear is left for you)</label>
        <label class="check"><input v-model="draft.referralLinksEnabled" type="checkbox" /> Give each merchant a personal form link that fills in their referral code</label>
        <label class="field" style="margin-top: 10px">Your form's pre-filled link, with REFCODE where the code goes
          <input v-model.trim="draft.referralPrefillUrl" type="url" placeholder="https://docs.google.com/forms/d/e/…/viewform?usp=pp_url&entry.123456=REFCODE" />
          <small>In the form: ⋮ → Get pre-filled link → type REFCODE in the "Referral code" question → Get link → Copy. A merchant's link shows on their lead page, and <code v-text="'{{referral_link}}'"></code> puts it in a template.</small>
        </label>
      </SettingsSection>
    </template>

    <!-- ── Instagram & Facebook (Meta app) ── -->
    <template v-if="tab === 'meta'">
      <SettingsSection id="meta" title="Meta app" :dirty="dirty('meta')" :saving="saving === 'meta'" @save="save('meta')" @cancel="cancel('meta')">
        <template #badge><span class="pill" :class="meta?.problems.length ? 'warn' : 'ok'">{{ meta?.problems.length ? 'Needs set-up' : 'Connected in .env' }}</span></template>
        <p class="muted small" style="margin-top: 0">
          Uses StockỌja's own Facebook Page and the Instagram account linked to it, through a free Meta app you own. The Page token stays in
          <code>.env</code>. Nothing is posted, and no cold message is ever sent through Meta.
        </p>
        <div v-if="meta?.problems.length" class="banner warn">
          <div v-for="p in meta.problems" :key="p.key">{{ p.message }}</div>
          <div class="small">Step-by-step: <code>docs/META_SETUP.md</code>. Values in .env are read when the app starts: restart it after editing.</div>
        </div>
        <dl v-if="meta" class="kv small">
          <dt>Page id</dt><dd>{{ meta.pageId ?? 'not set' }}</dd>
          <dt>App secret proof</dt><dd>{{ meta.appSecretProof ? 'On (META_APP_SECRET set)' : 'Off. Recommended: set META_APP_SECRET' }}</dd>
          <dt>Graph API</dt><dd>{{ meta.graphVersion }}</dd>
        </dl>
        <div class="btn-row" style="margin: 10px 0">
          <button class="btn" :disabled="!!meta?.problems.length" @click="testMetaConnection">Test connection</button>
        </div>
        <p v-if="metaTest" class="small">{{ metaTest }}</p>

        <h3 style="margin: 16px 0 8px">Instagram profile lookup</h3>
        <label class="check"><input v-model="draft.instagramLookupEnabled" type="checkbox" /> Look up public Instagram business and creator profiles by @username</label>
        <p class="muted small">Only when you press "Look up" on a lead or in Discovery. Shows the bio, website, followers and posts, and adds them to the lead as facts credited to Instagram. Personal accounts can't be looked up. It can't search Instagram; you supply the usernames. <span v-if="meta">{{ meta.looked_up }} lead(s) looked up so far.</span></p>

        <h3 style="margin: 16px 0 8px">Inbox</h3>
        <label class="check"><input v-model="draft.metaInboxEnabled" type="checkbox" /> Read messages people send to your Page and Instagram account (read-only)</label>
        <div class="btn-row" style="margin: 6px 0">
          <label class="check"><input type="checkbox" :checked="draft.metaInboxPlatforms.includes('instagram')" @change="togglePlatform('instagram', ($event.target as HTMLInputElement).checked)" /> Instagram</label>
          <label class="check"><input type="checkbox" :checked="draft.metaInboxPlatforms.includes('facebook')" @change="togglePlatform('facebook', ($event.target as HTMLInputElement).checked)" /> Facebook Messenger</label>
        </div>
        <div class="grid grid-2">
          <label class="field">Check every (minutes)<input v-model.number="draft.metaInboxCheckMinutes" type="number" min="5" max="1440" /><small>Only while the agent runs.</small></label>
          <label class="field">First check looks back (days)<input v-model.number="draft.metaInboxLookbackDays" type="number" min="1" max="30" /></label>
        </div>
        <p class="muted small">Messages from a lead (matched by their Instagram username, or someone you linked) become replies on that lead: labelled, STOP respected, and answered with a draft for your approval. Everyone else waits in Inbox → Not matched to a lead.</p>
        <div class="btn-row">
          <button class="btn primary" :disabled="!saved.metaInboxEnabled || dirty('meta')" :title="dirty('meta') ? 'Save your changes first' : ''" @click="checkMetaNow">Check messages now</button>
        </div>
        <dl v-if="meta" class="kv small" style="margin-top: 10px">
          <dt>Last check</dt>
          <dd>
            <template v-if="meta.lastCheck">{{ new Date(meta.lastCheck.at).toLocaleString() }}: {{ meta.lastCheck.conversations }} conversation(s), {{ meta.lastCheck.replies }} from leads, {{ meta.lastCheck.unmatched }} to match</template>
            <template v-else>Never</template>
          </dd>
          <dt>People</dt><dd>{{ meta.contacts }} wrote to you · {{ meta.linked }} linked to leads</dd>
        </dl>

        <h3 style="margin: 16px 0 8px">Sending replies</h3>
        <p class="small" style="margin-top: 0">
          Now: <strong>{{ saved.metaReplySending === 'live' ? 'approved replies go through Meta (inside 24 hours)' : 'you send replies yourself (copy and open)' }}</strong>.
          Meta allows an API reply only within 24 hours of the person's last message; older ones are always yours to send.
        </p>
        <div class="btn-row">
          <button v-if="saved.metaReplySending !== 'live'" class="btn" :disabled="!!meta?.problems.length || !saved.metaInboxEnabled" :title="!saved.metaInboxEnabled ? 'Switch the inbox on first' : ''" @click="setMetaReplySending('live')">Send approved replies through Meta</button>
          <button v-else class="btn" @click="setMetaReplySending('manual')">Back to sending them myself</button>
        </div>
        <p class="muted small">Until Meta approves the app for live use (App Review), only people with a role on the app (you, testers) can be read or answered through it.</p>
      </SettingsSection>
    </template>

    <!-- ── Web search and WhatsApp group exports ── -->
    <template v-if="tab === 'search'">
      <SettingsSection id="web-search" title="Web search" :dirty="dirty('webSearch')" :saving="saving === 'webSearch'" @save="save('webSearch')" @cancel="cancel('webSearch')">
        <template #badge><span class="pill" :class="saved.webSearchProviders.length ? 'ok' : ''">{{ saved.webSearchProviders.length ? saved.webSearchProviders.map((p) => providerInfo[p].name).join(' + ') : 'Off' }}</span></template>
        <p class="muted small" style="margin-top: 0">
          Finds shops' websites and Instagram, Facebook and TikTok profiles through an official search API, from Discovery → Web search. Only when you press
          Search; the agent never searches by itself. Tick none, one or both. API keys stay in <code>.env</code>; everything else is here.
        </p>
        <div v-for="p in SEARCH_PROVIDERS" :key="p" style="margin-bottom: 10px">
          <label class="check"><input type="checkbox" :checked="draft.webSearchProviders.includes(p)" @change="toggleProvider(p, ($event.target as HTMLInputElement).checked)" /> <strong>{{ providerInfo[p].name }}</strong></label>
          <div class="small" style="margin-left: 24px">
            <div>Key: <span class="pill" :class="providerState(p)?.keySet ? 'ok' : 'warn'">{{ providerState(p)?.keySet ? `${providerInfo[p].env} is set` : `add ${providerInfo[p].env} to .env, then restart` }}</span></div>
            <div class="muted">{{ providerInfo[p].cost }}</div>
            <div v-if="providerState(p)">Used this month: {{ providerState(p)!.usedThisMonth }} of {{ providerState(p)!.limit }}</div>
          </div>
        </div>
        <div class="grid grid-2" style="margin-top: 10px">
          <label class="field">Tavily: most searches a month<input v-model.number="draft.tavilyMonthlyLimit" type="number" min="0" max="100000" /><small>Counted by the agent; at the limit, Tavily searches stop until next month.</small></label>
          <label class="field">Brave: most searches a month<input v-model.number="draft.braveMonthlyLimit" type="number" min="0" max="100000" /><small>900 keeps you inside the $5 monthly credit.</small></label>
          <label class="field">Results per search<input v-model.number="draft.webSearchResultsPerQuery" type="number" min="1" max="20" /><small>Costs the same for 1 or 20.</small></label>
          <label class="field">Country (2-letter code)<input v-model.trim="draft.webSearchCountry" maxlength="2" @input="draft.webSearchCountry = draft.webSearchCountry.toUpperCase()" /><small>NG for Nigeria. Brave uses it; for Tavily, put the place in your search words.</small></label>
          <label class="field">Reuse results for (days)<input v-model.number="draft.webSearchCacheDays" type="number" min="0" max="90" /><small>The same search again within this time shows the saved results and spends nothing. 0 always searches.</small></label>
        </div>
      </SettingsSection>

      <SettingsSection id="groups" title="WhatsApp group exports" :dirty="dirty('groups')" :saving="saving === 'groups'" @save="save('groups')" @cancel="cancel('groups')">
        <template #badge><span class="pill" :class="saved.groupImportEnabled ? 'ok' : ''">{{ saved.groupImportEnabled ? 'On' : 'Off' }}</span></template>
        <p class="muted small" style="margin-top: 0">
          Turn vendors from a WhatsApp group you're in into leads: export the chat yourself ("Export chat" → Without media) and upload it in Discovery.
          Only each sender's name, number and one short sample of what they posted are kept; the chat itself is not stored.
        </p>
        <label class="check"><input v-model="draft.groupImportEnabled" type="checkbox" /> Allow importing vendors from WhatsApp group exports</label>
        <label class="field" style="margin-top: 10px">First line of every first message to these leads
          <textarea v-model="draft.groupFirstLine" rows="2" maxlength="300"></textarea>
          <small><code v-text="'{{group}}'"></code> becomes the group's name. It must say how to opt out (reply STOP). Preview: "{{ firstLinePreview }}"</small>
        </label>
        <div class="banner info small" style="margin-top: 10px">
          These people never asked to hear from you, so their leads are handled strictly: only messages you send yourself on WhatsApp (never email, never by the agent),
          every first message opens with the line above, and a STOP puts them on your do-not-contact list for good. Message only people who sell things StockỌja helps with,
          and don't message a whole group at once.
        </div>
      </SettingsSection>
    </template>

    <!-- ── AI & autonomy ── -->
    <template v-if="tab === 'ai'">
      <SettingsSection title="AI writing" :dirty="dirty('ai')" :saving="saving === 'ai'" @save="save('ai')" @cancel="cancel('ai')">
        <template #badge><span class="pill" :class="ai?.configured ? (saved.aiDraftReplies || saved.aiDraftIntros ? 'ok' : 'info') : ''">{{ ai?.configured ? (saved.aiDraftReplies || saved.aiDraftIntros ? 'On' : 'Ready, off') : 'No API key' }}</span></template>
        <p class="muted small" style="margin-top: 0">
          Gemini writes each message for the person it goes to, using only your knowledge (approved answers, documents, website) and their business details;
          never phone numbers or emails. Every AI draft is checked (times, links, figures). If Gemini is busy it retries, then tries a backup model;
          if it still can't, or a limit is reached, the agent uses your templates (outreach) or knowledge-base answers (messages) and says so on the draft.
        </p>
        <div v-if="ai && !ai.configured" class="banner info">
          To use it: create a key at aistudio.google.com, add <code>GEMINI_API_KEY=…</code> to <code>.env</code>, and restart. Google's free tier has daily limits; beyond them it's paid per use (and on the free tier Google may use prompts to improve its products).
        </div>
        <dl v-if="ai?.configured" class="kv small">
          <dt>Models</dt>
          <dd>
            {{ ai.models.join(' → ') }}
            <span class="muted">· {{ ai.models.length > 1 ? (ai.modelsSource === 'auto' ? 'backups picked automatically for your key' : 'backups from GEMINI_FALLBACK_MODELS') : 'no backup found' }}</span>
          </dd>
          <dt>This month</dt><dd>about ${{ Number(ai.monthUsd).toFixed(4) }} of ${{ ai.budgetUsd.toFixed(2) }} · {{ ai.callsMonth }} call(s)</dd>
          <dt>Today</dt><dd>{{ ai.callsToday }} of {{ ai.dailyCallLimit }} call(s)</dd>
        </dl>
        <label class="check"><input v-model="draft.aiDraftIntros" type="checkbox" :disabled="!ai?.configured" /> Write outreach with AI: introductions and follow-ups, on every channel, for each lead</label>
        <label class="check"><input v-model="draft.aiDraftReplies" type="checkbox" :disabled="!ai?.configured" /> Write answers to messages with AI, from your knowledge</label>
        <label class="field" style="margin-top: 10px">Instructions for the AI
          <textarea v-model="draft.aiInstructions" rows="10" maxlength="6000" spellcheck="true"></textarea>
          <small>
            Every message the AI writes starts from this. The agent adds your name, the task (an answer or an introduction), your knowledge, the lead, and the conversation so far.
            Whatever this says, drafts that name a day or time, contain a link, or use figures not in your knowledge are still flagged or blocked.
            <button v-if="ai?.defaultInstructions && draft.aiInstructions !== ai.defaultInstructions" type="button" class="linklike" @click="draft.aiInstructions = ai.defaultInstructions">Reset to default</button>
          </small>
        </label>
        <label class="field">Earlier messages the AI reads before answering
          <input v-model.number="draft.aiReplyHistory" type="number" min="0" max="30" />
          <small>From the same conversation, both sides. 0: only their latest message. More costs a little more per answer.</small>
        </label>
        <div class="grid grid-2" style="margin-top: 10px">
          <label class="field">Monthly budget cap (US$)<input v-model.number="draft.aiMonthlyBudgetUsd" type="number" min="0" max="100" step="0.5" /><small>Calls stop before the estimate could pass it.</small></label>
          <label class="field">Most AI calls per day<input v-model.number="draft.aiDailyCallLimit" type="number" min="0" max="1000" /></label>
          <label class="field">Input price (US$ per million tokens)<input v-model.number="draft.aiInputUsdPerMTok" type="number" min="0" step="0.01" /></label>
          <label class="field">Output price (US$ per million tokens)<input v-model.number="draft.aiOutputUsdPerMTok" type="number" min="0" step="0.01" /><small>Check Google's current prices for your model; the cost estimate uses these.</small></label>
        </div>
      </SettingsSection>

      <SettingsSection title="Controlled Autonomous Mode limits" :dirty="dirty('autonomy')" :saving="saving === 'autonomy'" @save="save('autonomy')" @cancel="cancel('autonomy')">
        <p class="muted small" style="margin-top: 0">
          Applies only in that mode (General → Operating mode). Needs reading replies on, so follow-ups stop the moment someone answers. Only template emails are approved by the agent;
          AI-written outreach always waits for you. Answers to messages are set per channel under Inbox & answers.
          <span v-if="status?.outreach">Approved by the agent today: {{ status.outreach.autoApprovedToday ?? 0 }} of {{ saved.autoApproveDailyLimit }}.</span>
        </p>
        <label class="check"><input v-model="draft.autoApproveIntros" type="checkbox" /> Approve template introductions</label>
        <label class="check"><input v-model="draft.autoApproveFollowUps" type="checkbox" /> Approve template follow-ups</label>
        <div class="grid grid-2" style="margin-top: 10px">
          <label class="field">Most approvals by the agent per day<input v-model.number="draft.autoApproveDailyLimit" type="number" min="0" max="100" /></label>
          <label class="field">Only leads scoring at least<input v-model.number="draft.autoApproveMinScore" type="number" min="0" max="100" /><small>Lower-scoring leads still get drafts, for you to approve.</small></label>
        </div>
      </SettingsSection>
    </template>

    <!-- ── System ── -->
    <template v-if="tab === 'system'">
      <SettingsSection title="Start-up" :dirty="dirty('startup')" :saving="saving === 'startup'" @save="save('startup')" @cancel="cancel('startup')">
        <label class="check"><input v-model="draft.autoStartAgentOnLaunch" type="checkbox" /> Start the agent automatically when I open the app</label>
        <label v-if="autostart?.supported" class="check" style="margin-top: 8px"><input v-model="startWithWindows" type="checkbox" /> Start the app when I sign in to Windows</label>
        <p class="muted small" style="margin: 8px 0 0">
          Both off by default. "Start with Windows" adds a small launcher to your Startup folder<span v-if="autostart?.enabled"> ({{ autostart.path }})</span>; it opens the app minimised without the browser.
          The agent itself then starts only if the first option is on. The laptop must be on and online for anything to run.
        </p>
      </SettingsSection>

      <div class="card">
        <div class="card-head"><h2>Integrations</h2></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Integration</th><th>Status</th><th>Cost</th><th>Notes</th></tr></thead>
            <tbody>
              <tr v-for="i in integrations" :key="i.id">
                <td><strong>{{ i.name }}</strong></td>
                <td><span class="pill" :class="statusCls[i.status]">{{ statusText[i.status] ?? i.status }}</span></td>
                <td class="small nowrap">{{ i.cost ?? '—' }}</td>
                <td class="small muted">{{ i.note }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </template>
</template>
