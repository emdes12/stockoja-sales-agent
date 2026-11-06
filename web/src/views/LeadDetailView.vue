<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api, CHANNELS, channelLabel, fmtDate, getOptions, labelText, labelTone, run, SOCIALS, statusLabel, taskLabel, toast, type Channel, type Options } from '../api';

const props = defineProps<{ id: string }>();

interface Fact { label: string; value: string; source: string; url?: string | null }
interface InstagramProfile { username: string; name: string | null; biography: string | null; website: string | null; followers: number | null; posts: number | null; phonesInBio: string[]; checkedAt: string }
interface Lead {
  id: number; business_name: string; category: string; source_tag: string | null; city: string | null; state: string | null;
  address: string | null; lat: number | null; lon: number | null; phone: string | null; email: string | null; website: string | null;
  socials: Record<string, string>; branch_count: number; is_chain_brand: boolean; source: string; source_url: string | null; group_source?: string | null;
  discovered_at: string; score: number | null; score_breakdown: Array<{ label: string; points: number; basis: string }>;
  facts: Fact[]; assumptions: Array<{ label: string; reason: string }>;
  relevance: Array<{ feature: string; fit: string; why: string }>; status: string; status_set_by: string; notes: string | null;
  qualified_at: string | null; enriched_at: string | null;
  asked_to_hear_at: string | null; referral_code: string | null;
  instagram_profile: InstagramProfile | null; instagram_checked_at: string | null;
  referredBy: { id: number; business_name: string } | null;
  referrals: Array<{ id: number; business_name: string; status: string }>;
  demo_at: string | null; demo_note: string | null; demo_source: string | null;
  sources: Array<{ source: string; source_ref: string; source_url: string | null; first_seen: string; last_seen: string }>;
  tasks: Array<{ id: number; type: string; status: string; last_error: string | null; review_reason: string | null; updated_at: string }>;
}

const lead = ref<Lead | null>(null);
const options = ref<Options | null>(null);
const notes = ref('');
const notFound = ref(false);

interface Msg {
  id: number; channel: string; direction: string; step: string | null; subject: string | null; body: string; status: string; status_reason: string | null;
  created_at: string; sent_at: string | null; received_at: string | null; from_address: string | null; classification: string | null;
}
const messages = ref<Msg[]>([]);

async function draft(channel: Channel) {
  if (await run(() => api(`/leads/${props.id}/drafts`, { method: 'POST', body: { channel } }), 'Draft created; review it in the approval queue')) await load();
}
const aiReady = ref(false);
const aiBusy = ref(false);
async function draftWithAi() {
  aiBusy.value = true;
  const ok = await run(() => api(`/leads/${props.id}/ai-intro`, { method: 'POST' }), 'AI introduction drafted; check it in the approval queue');
  aiBusy.value = false;
  if (ok) await load();
}

const replyForm = ref({ channel: 'whatsapp' as Channel, text: '' });

// Social profiles: the send-it-yourself channels draft from these.
const profileForm = ref({ platform: 'instagram' as (typeof SOCIALS)[number], value: '' });
async function saveProfile() {
  const { platform, value } = profileForm.value;
  if (await run(() => api(`/leads/${props.id}`, { method: 'PATCH', body: { socials: { [platform]: value.trim() } } }), `${channelLabel[platform]} profile saved`)) {
    profileForm.value.value = '';
    await load();
  }
}
async function removeProfile(platform: string) {
  if (!confirm(`Remove the ${channelLabel[platform] ?? platform} profile from this lead?`)) return;
  if (await run(() => api(`/leads/${props.id}`, { method: 'PATCH', body: { socials: { [platform]: null } } }), 'Profile removed')) await load();
}
const profileHref = (url: string) => (/^https?:\/\//.test(url) ? url : undefined);

// Instagram lookup (Meta app, Business Discovery): only on your click.
const igBusy = ref(false);
async function lookUpInstagram() {
  igBusy.value = true;
  const r = await run(() => api(`/leads/${props.id}/instagram`, { method: 'POST', body: {} }), 'Instagram profile added to the lead');
  igBusy.value = false;
  if (r) await load();
}
const fmtCount = (n: number | null) => (n === null ? '—' : n.toLocaleString())

// Referrals: this merchant's personal form link.
const referral = ref<{ code: string; link: string } | null>(null);
async function getReferralLink() {
  referral.value = (await run(() => api<{ code: string; link: string }>(`/leads/${props.id}/referral-link`, { method: 'POST' }))) ?? null;
}
async function copyReferral() {
  try {
    await navigator.clipboard.writeText(referral.value!.link);
    toast('Link copied');
  } catch {
    toast('Could not copy automatically: select the link and copy it.', 'error');
  }
}
async function logReply() {
  const res = await run(() =>
    api<{ classification: { label: string }; answer: { drafted?: unknown; message?: string } | null }>(`/leads/${props.id}/replies`, {
      method: 'POST',
      body: { channel: replyForm.value.channel, text: replyForm.value.text },
    }),
  );
  if (!res) return;
  const label = labelText[res.classification.label] ?? res.classification.label;
  toast(res.answer && 'drafted' in res.answer ? `Logged as "${label}". An answer is drafted in the approval queue.` : `Logged as "${label}".`);
  replyForm.value.text = '';
  await load();
}

const demoForm = ref({ at: '', note: '' });
async function bookDemo() {
  const at = demoForm.value.at ? new Date(demoForm.value.at).toISOString() : null;
  if (await run(() => api(`/leads/${props.id}/demo`, { method: 'POST', body: { at, note: demoForm.value.note || null } }), 'Demo booked; follow-ups stopped')) {
    demoForm.value = { at: '', note: '' };
    await load();
  }
}
const stepText: Record<string, string> = { intro: 'introduction', followup_1: 'follow-up 1', followup_2: 'follow-up 2', reply: 'your reply' };

async function load() {
  try {
    lead.value = await api<Lead>(`/leads/${props.id}`);
    notes.value = lead.value.notes ?? '';
    messages.value = (await api<{ data: Msg[] }>(`/messages?leadId=${props.id}`).catch(() => ({ data: [] }))).data;
  } catch {
    notFound.value = true;
  }
}
onMounted(async () => {
  void api<{ configured: boolean }>('/ai/status').then((s) => (aiReady.value = s.configured), () => null);
  options.value = await getOptions().catch(() => null);
  await load();
});
watch(() => props.id, load);

const featureLabel: Record<string, string> = {
  inventory: 'Inventory management', sales_tracking: 'Sales tracking', expenses: 'Expense recording', online_store: 'Online store', ordering: 'Ordering',
};
const catLabel = computed(() => options.value?.categories.find((c) => c.id === lead.value?.category)?.label ?? lead.value?.category);
const fitClass: Record<string, string> = { high: 'ok', medium: 'warn', low: '' };
const sourceName = (s: string) => ({ osm: 'OpenStreetMap', csv: 'CSV import', form: 'your interest form', whatsapp_group: 'a WhatsApp group export' } as Record<string, string>)[s] ?? 'Added by you';

async function setStatus(status: string) {
  if (status === 'do_not_contact' && !confirm('Mark as do not contact? Their email, phone and social accounts go on the do-not-contact list, and open drafts are cancelled.')) return;
  const res = await run(() => api<Lead>(`/leads/${props.id}`, { method: 'PATCH', body: { status } }), 'Status updated');
  if (res) await load();
}
async function autoStatus() {
  if (await run(() => api(`/leads/${props.id}/auto-status`, { method: 'POST' }), 'Status handed back to scoring')) await load();
}
async function saveNotes() {
  await run(() => api(`/leads/${props.id}`, { method: 'PATCH', body: { notes: notes.value || null } }), 'Notes saved');
}
async function changeCategory(e: Event) {
  const category = (e.target as HTMLSelectElement).value;
  if (await run(() => api(`/leads/${props.id}`, { method: 'PATCH', body: { category } }), 'Category changed and lead re-scored')) await load();
}
async function enrich() {
  const res = await run(() => api<{ taskId: number; agentState: string }>(`/leads/${props.id}/enrich`, { method: 'POST' }));
  if (res) {
    toast(res.agentState === 'running' ? 'Website check queued' : 'Website check queued. It runs when you start the agent.');
    await load();
  }
}
</script>

<template>
  <div v-if="notFound" class="card empty">Lead not found. <RouterLink to="/leads">Back to leads</RouterLink></div>
  <template v-else-if="lead">
    <div class="page-head">
      <div>
        <RouterLink to="/leads" class="small">← Leads</RouterLink>
        <h1 style="margin-top: 4px">{{ lead.business_name }}</h1>
        <p>
          {{ catLabel }} · {{ [lead.city, lead.state].filter(Boolean).join(', ') || 'Location unknown' }} ·
          discovered {{ fmtDate(lead.discovered_at) }} via {{ sourceName(lead.source) }}
        </p>
        <p v-if="lead.group_source" class="small"><span class="pill warn">From the "{{ lead.group_source }}" WhatsApp group</span> You send every message yourself; no email. First messages open with your group first line.</p>
      </div>
      <div style="text-align: right">
        <div class="score" :class="(lead.score ?? 0) >= 60 ? 'high' : (lead.score ?? 0) >= 40 ? 'mid' : 'low'" style="font-size: 22px; padding: 6px 12px">{{ lead.score ?? '—' }}</div>
        <div class="muted small" style="margin-top: 4px">qualification score</div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 16px">
      <div class="btn-row" style="justify-content: space-between">
        <div class="btn-row">
          <span class="pill" :class="{ ok: lead.status === 'qualified', danger: lead.status === 'do_not_contact' }">{{ statusLabel[lead.status] }}</span>
          <span class="muted small">{{ lead.status_set_by === 'user' ? 'Set by you' : 'Set by scoring' }}</span>
          <span v-if="lead.asked_to_hear_at" class="pill info" :title="`Filled in the interest form ${fmtDate(lead.asked_to_hear_at)}`">Asked to hear from us</span>
          <span v-if="lead.referredBy" class="small">Referred by <RouterLink :to="`/leads/${lead.referredBy.id}`">{{ lead.referredBy.business_name }}</RouterLink></span>
          <button v-if="lead.status_set_by === 'user'" class="btn small" @click="autoStatus">Let scoring decide</button>
        </div>
        <div class="btn-row">
          <button class="btn small" v-if="lead.status !== 'qualified'" @click="setStatus('qualified')">Mark qualified</button>
          <button class="btn small" v-if="lead.status !== 'unqualified'" @click="setStatus('unqualified')">Not a fit</button>
          <button class="btn small" v-if="lead.status !== 'archived'" @click="setStatus('archived')">Archive</button>
          <button class="btn small" v-if="lead.status !== 'declined'" @click="setStatus('declined')">Declined</button>
          <button class="btn small danger" v-if="lead.status !== 'do_not_contact'" @click="setStatus('do_not_contact')">Do not contact</button>
          <button class="btn small" :disabled="!lead.website" :title="lead.website ? '' : 'No website to check'" @click="enrich">Check website for contacts</button>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 16px">
      <div class="card-head">
        <h2>Conversation</h2>
        <div class="btn-row">
          <button class="btn small" :disabled="!lead.email" :title="lead.email ? '' : 'No email address'" @click="draft('email')">Draft email</button>
          <button class="btn small" @click="draft('whatsapp')">Draft WhatsApp</button>
          <button v-for="c in SOCIALS.filter((p) => lead!.socials[p])" :key="c" class="btn small" :title="`You send it yourself on ${channelLabel[c]}`" @click="draft(c)">Draft {{ channelLabel[c] }}</button>
          <button v-if="aiReady" class="btn small" :disabled="!lead.email || aiBusy" title="Uses Gemini (paid per use, within your monthly cap)" @click="draftWithAi">{{ aiBusy ? 'Writing…' : 'Draft email with AI' }}</button>
          <RouterLink to="/approval" class="btn small">Approval queue</RouterLink>
        </div>
      </div>
      <ul v-if="messages.length" class="list">
        <li v-for="m in messages" :key="m.id">
          <div class="btn-row" style="justify-content: space-between">
            <span class="small">
              <strong>{{ m.direction === 'inbound' ? `They replied (${channelLabel[m.channel] ?? m.channel})` : channelLabel[m.channel] ?? m.channel }}</strong>
              <template v-if="m.step"> · {{ stepText[m.step] ?? m.step }}</template>
              · {{ fmtDate(m.received_at ?? m.sent_at ?? m.created_at) }}<span v-if="m.from_address" class="muted"> · {{ m.from_address }}</span>
            </span>
            <span v-if="m.direction === 'inbound'" class="pill" :class="labelTone[m.classification ?? 'other']">{{ labelText[m.classification ?? 'other'] }}</span>
            <span v-else class="pill" :class="{ info: m.status === 'draft', ok: m.status === 'approved' || m.status === 'sent', danger: ['rejected', 'cancelled', 'failed'].includes(m.status) }">{{ m.status === 'dry_run' ? 'dry run' : m.status }}</span>
          </div>
          <div v-if="m.subject" class="small" style="margin-top: 4px"><strong>{{ m.subject }}</strong></div>
          <pre class="data" style="color: var(--fg)">{{ m.body }}</pre>
          <div v-if="m.status_reason" class="muted small">{{ m.status_reason }}</div>
        </li>
      </ul>
      <p v-else class="muted small" style="margin: 0">No messages yet. Drafts wait in the approval queue; nothing is sent without your approval.</p>

      <div class="grid grid-2" style="margin-top: 14px">
        <div>
          <h3 style="margin: 0 0 6px">Log a reply</h3>
          <p class="muted small" style="margin: 0 0 8px">
            For replies on WhatsApp, Instagram, Facebook, TikTok, Telegram, by phone, or in another inbox. It's labelled like an email reply: STOP adds them to do not contact.
          </p>
          <div class="btn-row" style="margin-bottom: 6px">
            <select v-model="replyForm.channel" aria-label="Channel">
              <option v-for="c in CHANNELS" :key="c" :value="c">{{ channelLabel[c] }}</option>
            </select>
          </div>
          <textarea v-model="replyForm.text" rows="3" placeholder="Paste what they said"></textarea>
          <button class="btn small" style="margin-top: 6px" :disabled="!replyForm.text.trim()" @click="logReply">Log reply</button>
        </div>
        <div>
          <h3 style="margin: 0 0 6px">Demo</h3>
          <p v-if="lead.status === 'demo_booked'" class="small" style="margin: 0 0 8px">
            <strong>Booked</strong>{{ lead.demo_at ? ` for ${fmtDate(lead.demo_at)}` : '' }}
            <span class="muted">· {{ lead.demo_source === 'booking_email' ? 'from a booking notice' : 'set by you' }}</span>
            <span v-if="lead.demo_note" class="muted"><br />{{ lead.demo_note }}</span>
          </p>
          <p v-else class="muted small" style="margin: 0 0 8px">
            When they book (on your booking page or with you directly), record it here. The agent never proposes times.
          </p>
          <div class="btn-row">
            <input v-model="demoForm.at" type="datetime-local" aria-label="Demo date and time" />
            <input v-model="demoForm.note" placeholder="Note (optional)" style="max-width: 200px" />
            <button class="btn small" :disabled="lead.status === 'do_not_contact'" @click="bookDemo">{{ lead.status === 'demo_booked' ? 'Update' : 'Mark demo booked' }}</button>
          </div>
        </div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h2>Business details</h2>
          <select :value="lead.category" @change="changeCategory" aria-label="Category">
            <option v-for="c in options?.categories" :key="c.id" :value="c.id">{{ c.label }}</option>
          </select>
        </div>
        <dl class="kv">
          <dt>Phone</dt><dd>{{ lead.phone ?? '—' }}</dd>
          <dt>Email</dt><dd>{{ lead.email ?? '—' }}</dd>
          <dt>Website</dt><dd><a v-if="lead.website" :href="lead.website" target="_blank" rel="noopener noreferrer">{{ lead.website }}</a><span v-else>—</span></dd>
          <dt>Profiles</dt>
          <dd>
            <div v-for="(url, p) in lead.socials" :key="p" class="btn-row" style="gap: 6px">
              <span>{{ channelLabel[p] ?? p }}: <a :href="profileHref(String(url))" target="_blank" rel="noopener noreferrer">{{ url }}</a></span>
              <button class="btn small" :aria-label="`Remove ${p}`" @click="removeProfile(String(p))">✕</button>
            </div>
            <form class="btn-row" style="margin-top: 4px; gap: 6px" @submit.prevent="saveProfile">
              <select v-model="profileForm.platform" aria-label="Platform"><option v-for="p in SOCIALS" :key="p" :value="p">{{ channelLabel[p] }}</option></select>
              <input v-model="profileForm.value" placeholder="Profile link or @username" style="flex: 1 1 140px" aria-label="Profile link or username" />
              <button class="btn small" :disabled="!profileForm.value.trim()">{{ lead.socials[profileForm.platform] ? 'Replace' : 'Add' }}</button>
            </form>
          </dd>
          <dt>Instagram</dt>
          <dd>
            <template v-if="lead.instagram_profile">
              <strong>@{{ lead.instagram_profile.username }}</strong><span v-if="lead.instagram_profile.name"> · {{ lead.instagram_profile.name }}</span>
              · {{ fmtCount(lead.instagram_profile.followers) }} followers · {{ fmtCount(lead.instagram_profile.posts) }} posts
              <div v-if="lead.instagram_profile.biography" class="small" style="white-space: pre-wrap">{{ lead.instagram_profile.biography }}</div>
              <div class="muted small">Checked {{ fmtDate(lead.instagram_checked_at) }}</div>
            </template>
            <span v-else class="muted">Not looked up. </span>
            <div v-if="lead.socials.instagram" class="btn-row" style="margin-top: 4px">
              <button class="btn small" :disabled="igBusy" title="Reads the public business profile through your Meta app" @click="lookUpInstagram">{{ igBusy ? 'Looking up…' : lead.instagram_profile ? 'Look up again' : 'Look up on Instagram' }}</button>
            </div>
            <span v-else class="muted small">Add their Instagram profile above to look it up.</span>
          </dd>
          <dt>Address</dt><dd>{{ lead.address ?? '—' }}</dd>
          <dt>Locations</dt><dd>{{ lead.branch_count }}{{ lead.is_chain_brand ? ' (recognised brand)' : '' }}</dd>
          <dt>Map</dt><dd><a v-if="lead.lat && lead.lon" :href="`https://www.openstreetmap.org/?mlat=${lead.lat}&mlon=${lead.lon}#map=18/${lead.lat}/${lead.lon}`" target="_blank" rel="noopener noreferrer">View on OpenStreetMap</a><span v-else>—</span></dd>
          <dt>Website checked</dt><dd>{{ lead.enriched_at ? fmtDate(lead.enriched_at) : 'Not yet' }}</dd>
          <dt>Referrals</dt>
          <dd>
            <template v-if="lead.referrals.length">
              Referred {{ lead.referrals.length }}:
              <span v-for="r in lead.referrals" :key="r.id"><RouterLink :to="`/leads/${r.id}`">{{ r.business_name }}</RouterLink> ({{ statusLabel[r.status] ?? r.status }}); </span>
            </template>
            <span v-else class="muted">None yet. </span>
            <div class="btn-row" style="margin-top: 4px; gap: 6px">
              <button v-if="!referral" class="btn small" title="Personal interest-form link for this merchant to share" @click="getReferralLink">Personal referral link</button>
              <template v-else>
                <code class="small" style="word-break: break-all">{{ referral.link }}</code>
                <button class="btn small" @click="copyReferral">Copy</button>
              </template>
            </div>
          </dd>
        </dl>
      </div>

      <div class="card">
        <div class="card-head"><h2>Why this score</h2><span class="muted small">threshold in Settings</span></div>
        <table>
          <tbody>
            <tr v-for="(b, i) in lead.score_breakdown" :key="i">
              <td>{{ b.label }}</td>
              <td class="small"><span :class="b.basis === 'fact' ? 'tag-fact' : 'tag-assumption'">{{ b.basis === 'fact' ? 'fact' : 'assumption' }}</span></td>
              <td class="num"><strong>{{ b.points > 0 ? '+' : '' }}{{ b.points }}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-head"><h2><span class="tag-fact">●</span> Verified facts</h2><span class="muted small">what a source states</span></div>
        <ul class="list" v-if="lead.facts.length">
          <li v-for="(fct, i) in lead.facts" :key="i">
            <strong>{{ fct.label }}:</strong> {{ fct.value }}
            <div class="muted small">
              Source: <a v-if="fct.url" :href="fct.url" target="_blank" rel="noopener noreferrer">{{ fct.source }}</a><span v-else>{{ fct.source }}</span>
            </div>
          </li>
        </ul>
        <p v-else class="muted">No facts recorded.</p>
      </div>

      <div class="card">
        <div class="card-head"><h2><span class="tag-assumption">●</span> Assumptions</h2><span class="muted small">inferred, not verified</span></div>
        <ul class="list">
          <li v-for="(a, i) in lead.assumptions" :key="i"><strong>{{ a.label }}</strong><div class="muted small">{{ a.reason }}</div></li>
        </ul>
      </div>

      <div class="card">
        <div class="card-head"><h2>Where StockỌja could help</h2><span class="muted small">assumptions from the category</span></div>
        <ul class="list">
          <li v-for="r in lead.relevance" :key="r.feature">
            <div class="btn-row" style="justify-content: space-between"><strong>{{ featureLabel[r.feature] ?? r.feature }}</strong><span class="pill" :class="fitClass[r.fit]">{{ r.fit }} fit</span></div>
            <div class="muted small">{{ r.why }}</div>
          </li>
        </ul>
      </div>

      <div class="card">
        <div class="card-head"><h2>Notes</h2><button class="btn small" @click="saveNotes">Save</button></div>
        <textarea v-model="notes" rows="5" placeholder="Your notes about this business"></textarea>
        <h3 style="margin: 16px 0 8px">Seen in sources</h3>
        <ul class="list">
          <li v-for="s in lead.sources" :key="s.source + s.source_ref" class="small">
            {{ sourceName(s.source) }} <a v-if="s.source_url" :href="s.source_url" target="_blank" rel="noopener noreferrer">{{ s.source_ref }}</a>
            <span class="muted"> · first {{ fmtDate(s.first_seen) }}, last {{ fmtDate(s.last_seen) }}</span>
          </li>
        </ul>
        <h3 style="margin: 16px 0 8px" v-if="lead.tasks.length">Tasks</h3>
        <ul class="list" v-if="lead.tasks.length">
          <li v-for="t in lead.tasks" :key="t.id" class="small">
            {{ taskLabel[t.type] ?? t.type }} #{{ t.id }} · <span class="pill">{{ statusLabel[t.status] }}</span>
            <span class="muted"> {{ fmtDate(t.updated_at) }}</span>
            <div v-if="t.last_error || t.review_reason" class="muted">{{ t.review_reason ?? t.last_error }}</div>
          </li>
        </ul>
      </div>
    </div>
  </template>
</template>
