<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { api, channelIcon, channelLabel, channelLimit, fmtDate, getOptions, labelText, qs, run, toast, type Channel, type Options } from '../api';
import { refreshStatus, status } from '../status';

interface Msg {
  id: number; lead_id: number | null; business_name: string; category: string; score: number | null; lead_status: string;
  channel: Channel; step: string; to_address: string | null; subject: string | null; body: string;
  original_body: string | null; status: string; created_by: string; edited: boolean; status_reason: string | null;
  approved_at: string | null; sent_at: string | null; sent_by: string | null; created_at: string; chat_link: { url: string; prefilled: boolean } | null;
  /** Instagram/Facebook replies: whether approving sends it through Meta, and why (not). */
  meta_send: { api: boolean; why: string } | null;
  delivery_status: string | null; error: string | null; in_reply_to_body: string | null; in_reply_to_label: string | null;
  approved_by: 'user' | 'agent' | null; ai_generated: boolean;
  ai_sources: { knowledge: Array<{ chunkId: number; title: string; heading: string | null }>; kb: Array<{ id: number; question: string }>;
    warnings: Array<{ code: string; text: string; blocking: boolean }>; model?: string; usd?: number } | null;
  similar: { id: number; businessName: string; sameSubject: boolean; bodyOverlap: number } | null;
}

const tab = ref<'draft' | 'approved' | 'sent' | 'closed'>('draft');
const messages = ref<Msg[]>([]);
const options = ref<Options | null>(null);
const edits = reactive<Record<number, { subject: string | null; body: string }>>({});
const loading = ref(false);

async function load() {
  loading.value = true;
  const statuses = tab.value === 'closed' ? ['rejected', 'cancelled', 'failed'] : tab.value === 'sent' ? ['sending', 'sent', 'dry_run'] : [tab.value];
  const all = await Promise.all(statuses.map((s) => api<{ data: Msg[] }>(`/messages${qs({ status: s })}`).then((r) => r.data).catch(() => [])));
  messages.value = all.flat();
  for (const m of messages.value) edits[m.id] = { subject: m.subject, body: m.body };
  loading.value = false;
}
const ai = ref<{ configured: boolean } | null>(null);
void api<{ configured: boolean }>('/ai/status').then((s) => (ai.value = s), () => null);
onMounted(async () => {
  options.value = await getOptions().catch(() => null);
  await load();
});
watch(tab, load);

const catLabel = (id: string) => options.value?.categories.find((c) => c.id === id)?.label ?? id;
const dirty = (m: Msg) => edits[m.id] && (edits[m.id]!.body !== m.body || (edits[m.id]!.subject ?? '') !== (m.subject ?? ''));
const stepLabel: Record<string, string> = { intro: 'Introduction', followup_1: 'Follow-up 1', followup_2: 'Follow-up 2', reply: 'Reply to their message' };

async function save(m: Msg) {
  if (await run(() => api(`/messages/${m.id}`, { method: 'PATCH', body: edits[m.id] }), m.status === 'approved' ? 'Saved; it needs approving again' : 'Saved')) await load();
}
async function act(m: Msg, action: 'approve' | 'reject' | 'mark-sent' | 'requeue' | 'regenerate') {
  let body: unknown;
  if (action === 'reject') {
    const reason = prompt('Why reject it? (optional, helps you tune templates)');
    if (reason === null) return;
    body = { reason: reason || null };
  }
  if (action === 'approve' && dirty(m)) {
    if (!(await run(() => api(`/messages/${m.id}`, { method: 'PATCH', body: edits[m.id] })))) return;
  }
  if (action === 'requeue' && !confirm(`Send this email for real to ${m.to_address}?`)) return;
  if (action === 'regenerate' && (m.ai_generated || (ai.value?.configured && m.step !== 'reply' && !m.edited)) && !confirm('Write it again with AI? That is one more AI call, counted against your limits.')) return;
  const msg = {
    approve: m.channel === 'email' ? (status.value?.emailSendingMode === 'live' ? 'Approved; queued to send within sending hours' : 'Approved; it will be dry-run (not sent)') : 'Approved',
    reject: 'Rejected',
    'mark-sent': 'Recorded as sent',
    requeue: 'Queued to send',
    regenerate: 'Written again',
  }[action];
  if (await run(() => api(`/messages/${m.id}/${action}`, { method: 'POST', body }), msg)) {
    await load();
    void refreshStatus();
  }
}
/** For channels where the link can't carry the text: copy it, then open their chat in a new tab. */
async function copyAndOpen(m: Msg) {
  try {
    await navigator.clipboard.writeText(m.body);
    toast(`Text copied. Paste it into the ${channelLabel[m.channel]} chat, send it, then press "I've sent it".`);
  } catch {
    toast('Could not copy automatically: select the message text and copy it yourself.', 'error');
  }
  window.open(m.chat_link!.url, '_blank', 'noopener,noreferrer');
}
/** A Messenger contact with no public chat link: copy only, you paste it in Meta Business Suite. */
async function copyText(m: Msg) {
  try {
    await navigator.clipboard.writeText(m.body);
    toast('Text copied. Paste it into the chat, send it, then press "I\'ve sent it".');
  } catch {
    toast('Could not copy automatically: select the message text and copy it yourself.', 'error');
  }
}
const recipient = (m: Msg) =>
  m.channel === 'email' || m.channel === 'whatsapp' ? m.to_address : m.to_address?.startsWith('id:') ? 'their Messenger chat' : `@${m.to_address}`;
async function draftBatch() {
  const res = await run(() => api<{ created: number; skipped: Record<string, number>; remainingToday: number }>('/messages/auto-draft', { method: 'POST', body: { limit: 10 } }));
  if (!res) return;
  const skipped = Object.entries(res.skipped).map(([k, n]) => `${n} ${k.toLowerCase().replace(/_/g, ' ')}`).join(', ');
  toast(res.created ? `${res.created} draft(s) created${skipped ? `; skipped ${skipped}` : ''}` : `No new drafts${skipped ? ` (skipped ${skipped})` : ''}. ${res.remainingToday === 0 ? "Today's draft limit is reached." : 'Every qualified lead with an address already has one.'}`);
  tab.value = 'draft';
  await load();
  void refreshStatus();
}
const counts = computed(() => status.value?.outreach);
</script>

<template>
  <div class="page-head">
    <div>
      <h1>Approval queue</h1>
      <p>
        Nothing is sent without your approval. WhatsApp, Instagram, Facebook, TikTok and Telegram messages are sent by you. Approved emails
        <strong>{{ status?.emailSendingMode === 'live' ? 'are sent through Resend' : 'are dry-run only (not sent)' }}</strong>.
      </p>
    </div>
    <button class="btn primary" :disabled="status?.mode === 'research'" @click="draftBatch">Draft for top qualified leads</button>
  </div>

  <div v-if="status?.mode === 'research'" class="banner warn">Research Mode is on: drafting and approval are off. Change it in Settings.</div>

  <div class="chips" style="margin-bottom: 14px" role="tablist">
    <button class="chip" :class="{ on: tab === 'draft' }" @click="tab = 'draft'">To review <span v-if="counts?.awaitingApproval">({{ counts.awaitingApproval }})</span></button>
    <button class="chip" :class="{ on: tab === 'approved' }" @click="tab = 'approved'">Approved <span v-if="counts?.approvedWaiting">({{ counts.approvedWaiting }})</span></button>
    <button class="chip" :class="{ on: tab === 'sent' }" @click="tab = 'sent'">Sent and dry runs</button>
    <button class="chip" :class="{ on: tab === 'closed' }" @click="tab = 'closed'">Rejected and cancelled</button>
  </div>

  <div v-if="!messages.length && !loading" class="card empty">
    <template v-if="tab === 'draft'">No drafts waiting. Use “Draft for top qualified leads”, or open a lead and draft one.</template>
    <template v-else>Nothing here.</template>
  </div>

  <div v-for="m in messages" :key="m.id" class="card">
    <div class="card-head">
      <div>
        <RouterLink v-if="m.lead_id" :to="`/leads/${m.lead_id}`"><strong>{{ m.business_name }}</strong></RouterLink>
        <strong v-else>{{ m.business_name }}</strong>
        <span v-if="m.lead_id" class="muted small"> · {{ catLabel(m.category) }} · score {{ m.score ?? '—' }}</span>
        <span v-else class="pill" style="margin-left: 6px">Not a lead</span>
        <div class="muted small">
          {{ channelIcon[m.channel] }} {{ channelLabel[m.channel] }} to {{ recipient(m) }} · {{ stepLabel[m.step] ?? m.step }} ·
          {{ m.created_by === 'agent' ? 'drafted by the agent' : 'drafted at your request' }} {{ fmtDate(m.created_at) }}
          <span v-if="m.edited"> · edited by you</span>
          <span v-if="m.approved_by === 'agent'"> · approved by the agent (Controlled Autonomous Mode)</span>
        </div>
      </div>
      <span v-if="m.ai_generated" class="pill warn" title="Written by Gemini from your knowledge">AI-written</span>
      <span class="pill" :class="{ info: m.status === 'draft', ok: m.status === 'approved' || m.status === 'sent', warn: m.status === 'sending', danger: m.status === 'rejected' || m.status === 'failed' }">{{ m.status === 'dry_run' ? 'dry run' : m.status }}</span>
    </div>

    <div v-if="m.in_reply_to_body" class="quote">
      <div class="muted small">They wrote<span v-if="m.in_reply_to_label"> ({{ labelText[m.in_reply_to_label] ?? m.in_reply_to_label }})</span>:</div>
      <div class="small" style="white-space: pre-wrap">{{ m.in_reply_to_body }}</div>
    </div>

    <div v-if="m.ai_generated && m.ai_sources && m.status === 'draft'" class="banner warn small" style="margin-top: 0">
      Written by AI. Check every fact before approving.
      <ul v-if="m.ai_sources.warnings.length" style="margin: 4px 0 0; padding-left: 18px">
        <li v-for="w in m.ai_sources.warnings" :key="w.code"><strong v-if="w.blocking && !m.edited">Must fix: </strong>{{ w.text }}</li>
      </ul>
      <div class="muted" style="margin-top: 4px">
        Based on:
        <template v-if="m.ai_sources.kb.length || m.ai_sources.knowledge.length">
          <span v-for="k in m.ai_sources.kb" :key="`kb${k.id}`">answer "{{ k.question }}"; </span>
          <span v-for="k in m.ai_sources.knowledge" :key="k.chunkId">{{ k.title }}<template v-if="k.heading"> ({{ k.heading }})</template>; </span>
        </template>
        <template v-else>nothing in your knowledge matched, so it should only say you'll get back to them.</template>
        <span v-if="m.ai_sources.usd !== undefined"> Cost about ${{ m.ai_sources.usd.toFixed(4) }}.</span>
      </div>
    </div>

    <div v-if="m.similar && m.status === 'draft'" class="banner warn small" style="margin-top: 0">
      <template v-if="m.similar.sameSubject">Same subject as the message to {{ m.similar.businessName }} in the last 24 hours.</template>
      <template v-else>Reads almost the same ({{ Math.round(m.similar.bodyOverlap * 100) }}%) as the message to {{ m.similar.businessName }} in the last 24 hours.</template>
      Edit it, or regenerate it for a different version.
    </div>

    <template v-if="m.status === 'draft' || m.status === 'approved'">
      <label v-if="m.channel === 'email'" class="field" style="margin-bottom: 8px">Subject<input v-model="edits[m.id]!.subject" /></label>
      <label class="field">Message<textarea v-model="edits[m.id]!.body" :rows="m.channel === 'email' ? 14 : 7"></textarea>
        <small v-if="m.channel !== 'email'" :style="edits[m.id]!.body.length > channelLimit[m.channel]! ? 'color: var(--danger)' : ''">{{ edits[m.id]!.body.length }} of {{ channelLimit[m.channel] }} characters</small>
      </label>
      <div class="btn-row" style="margin-top: 10px">
        <template v-if="m.status === 'draft'">
          <button class="btn primary" @click="act(m, 'approve')">{{ dirty(m) ? 'Save and approve' : 'Approve' }}</button>
          <button class="btn" :disabled="!dirty(m)" @click="save(m)">Save edits</button>
          <button v-if="m.step !== 'reply' && !m.edited" class="btn" :disabled="dirty(m)" title="Write another version (another template or other phrasing)" @click="act(m, 'regenerate')">Regenerate</button>
          <button class="btn danger" @click="act(m, 'reject')">Reject</button>
          <span v-if="m.meta_send" class="muted small">{{ m.meta_send.why }}</span>
        </template>
        <template v-else>
          <span v-if="m.meta_send?.api" class="muted small">Approved. Sent through Meta in this chat when the agent runs.</span>
          <template v-else-if="m.channel !== 'email' && m.chat_link">
            <a v-if="m.chat_link.prefilled" class="btn primary" :href="m.chat_link.url" target="_blank" rel="noopener noreferrer">Open in {{ channelLabel[m.channel] }}</a>
            <button v-else class="btn primary" :disabled="dirty(m)" @click="copyAndOpen(m)">Copy text and open {{ channelLabel[m.channel] }}</button>
            <button class="btn" @click="act(m, 'mark-sent')">I've sent it</button>
            <span v-if="!m.chat_link.prefilled" class="muted small">{{ m.channel === 'tiktok' ? 'Opens their profile: press Message, paste, send.' : 'Paste into the chat, then send.' }}</span>
          </template>
          <template v-else-if="m.channel !== 'email'">
            <button class="btn primary" :disabled="dirty(m)" @click="copyText(m)">Copy text</button>
            <button class="btn" @click="act(m, 'mark-sent')">I've sent it</button>
            <span class="muted small">Paste it into this chat in Meta Business Suite (business.facebook.com → Inbox), send, then record it.</span>
          </template>
          <span v-else class="muted small">
            Approved. {{ status?.emailSendingMode === 'live' ? 'Queued: sends within sending hours and the daily limit (start the agent).' : 'Dry run is on: it will be logged, not sent.' }}
          </span>
          <button class="btn" :disabled="!dirty(m)" @click="save(m)">Save edits (needs re-approval)</button>
          <button class="btn danger" @click="act(m, 'reject')">Withdraw</button>
        </template>
      </div>
      <details v-if="m.edited && m.original_body" style="margin-top: 10px">
        <summary class="small muted">Show the agent's original draft</summary>
        <pre class="data">{{ m.original_body }}</pre>
      </details>
    </template>
    <template v-else>
      <div v-if="m.subject" class="small"><strong>{{ m.subject }}</strong></div>
      <pre class="data" style="color: var(--fg)">{{ m.body }}</pre>
      <div class="muted small" style="margin-top: 6px">
        <span v-if="m.sent_at">Sent {{ fmtDate(m.sent_at) }} {{ m.sent_by === 'user' ? 'by you' : m.channel === 'email' ? 'through Resend' : 'through Meta' }}</span>
        <span v-if="m.delivery_status"> · delivery: {{ m.delivery_status }}</span>
        <span v-if="m.status === 'sending'">Being handed to Resend. If this stays, check Tasks; a retry cannot send it twice.</span>
        <span v-if="m.status_reason"> {{ m.status_reason }}</span>
        <span v-if="m.error" style="color: var(--danger)"> {{ m.error }}</span>
      </div>
      <div v-if="m.status === 'dry_run' && status?.emailSendingMode === 'live'" class="btn-row" style="margin-top: 8px">
        <button class="btn small primary" @click="act(m, 'requeue')">Send for real</button>
      </div>
    </template>
  </div>
</template>
