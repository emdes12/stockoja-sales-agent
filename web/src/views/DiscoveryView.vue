<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { api, fmtDate, getOptions, run, statusLabel, toast, ApiError, type Options } from '../api';
import { status } from '../status';

interface Run { id: number; params: { category: string; region: string }; status: string; found: number; created: number; merged: number; skipped: number; error: string | null; task_status: string | null; started_at: string; finished_at: string | null }

const options = ref<Options | null>(null);
const runs = ref<Run[]>([]);
const sel = reactive({ categories: [] as string[], regions: ['NG-LA'] as string[], force: false });

const manual = reactive<Record<string, string>>({ business_name: '', category: '', city: '', state: '', phone: '', email: '', website: '', instagram: '', facebook: '', tiktok: '', telegram: '', source_url: '', notes: '' });
const manualErrors = ref<Record<string, string>>({});

// Instagram lookup (Meta app): fills the form below from a public business profile.
interface InstagramProfile { username: string; name: string | null; biography: string | null; website: string | null; followers: number | null; posts: number | null; phonesInBio: string[] }
const igUsername = ref('');
const igProfile = ref<InstagramProfile | null>(null);
const igBusy = ref(false);
/** Set when the form was filled from a lookup, so the new lead also gets the profile as facts. */
const igPrefill = ref<string | null>(null);
async function lookUpInstagram() {
  igBusy.value = true;
  igProfile.value = (await run(() => api<InstagramProfile>('/meta/instagram/lookup', { method: 'POST', body: { username: igUsername.value.trim() } }))) ?? null;
  igBusy.value = false;
}
function useProfile(p: InstagramProfile) {
  manual.business_name = p.name ?? p.username;
  manual.instagram = `https://www.instagram.com/${p.username}/`;
  manual.website = p.website ?? manual.website;
  manual.phone = p.phonesInBio[0] ?? manual.phone;
  manual.source_url = `https://www.instagram.com/${p.username}/`;
  igPrefill.value = p.username;
  toast('Form filled from Instagram. Choose a category, check the details, then add the lead');
}
// Web search (Tavily / Brave): only on your click.
type Provider = 'tavily' | 'brave';
type Scope = 'any' | 'instagram' | 'facebook' | 'tiktok';
interface SearchResult { title: string; url: string; snippet: string; kind: 'website' | 'profile' | 'other'; platform: string | null; handle: string | null; domain: string | null; leadId: number | null }
interface ProviderOutcome { provider: Provider; cached: boolean; results: SearchResult[]; error: string | null; usedThisMonth: number; limit: number }
interface SearchStatus { providers: Array<{ id: Provider; enabled: boolean; keySet: boolean; usedThisMonth: number; limit: number }> }
const PROVIDER_NAME: Record<Provider, string> = { tavily: 'Tavily', brave: 'Brave' };
const SCOPE_LABEL: Record<Scope, string> = { any: 'Anywhere', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok' };
const searchStatus = ref<SearchStatus | null>(null);
const ws = reactive({ query: '', scope: 'any' as Scope, providers: [] as Provider[], fresh: false });
const wsBusy = ref(false);
const wsOutcomes = ref<ProviderOutcome[]>([]);
const usableProviders = () => searchStatus.value?.providers.filter((p) => p.enabled && p.keySet) ?? [];
async function loadSearchStatus() {
  searchStatus.value = await api<SearchStatus>('/web-search/status').catch(() => null);
  if (!ws.providers.length) ws.providers = usableProviders().map((p) => p.id).slice(0, 1);
}
async function runWebSearch() {
  wsBusy.value = true;
  const r = await run(() => api<{ outcomes: ProviderOutcome[] }>('/web-search', { method: 'POST', body: { ...ws, query: ws.query.trim() } }));
  wsBusy.value = false;
  if (r) wsOutcomes.value = r.outcomes;
  void loadSearchStatus();
}
/** Both providers' results together, each URL once. */
function mergedResults() {
  const seen = new Map<string, SearchResult & { from: Provider[] }>();
  for (const o of wsOutcomes.value) {
    for (const r of o.results) {
      const k = r.url.replace(/\/$/, '').toLowerCase();
      const hit = seen.get(k);
      if (hit) hit.from.push(o.provider);
      else seen.set(k, { ...r, from: [o.provider] });
    }
  }
  return [...seen.values()];
}
function useResult(r: SearchResult) {
  for (const k of Object.keys(manual)) manual[k] = '';
  manual.business_name = r.title.split(/\s[|•·–-]\s|\s\(@/)[0]!.replace(/\s*\(@[^)]*\)?$/, '').trim().slice(0, 120);
  if (r.kind === 'profile' && r.platform) manual[r.platform] = r.url;
  else manual.website = r.url;
  manual.source_url = r.url;
  manual.notes = r.snippet.slice(0, 300);
  igPrefill.value = null;
  toast('Form filled from the search result. Choose a category, check the details, then add the lead');
}
async function lookUpResult(handle: string) {
  igUsername.value = handle;
  await lookUpInstagram();
}

// WhatsApp group export (assist only).
interface ExportCandidate { key: string; name: string; phone: string | null; phoneKey: string | null; phoneFrom: 'sender' | 'message' | null; messages: number; sample: string | null; category: string | null; existingLeadId: number | null; blocked: string | null }
interface ExportRow extends ExportCandidate { include: boolean; pickedCategory: string }
const groupEnabled = ref(false);
const gx = reactive({ group: '', defaultCategory: '', consent: false, busy: false, fileName: '' });
const gxRows = ref<ExportRow[]>([]);
const gxLines = ref(0);
const gxResult = ref<{ created: number; merged: number; seen: number; skipped: Array<{ name: string; reason: string }> } | null>(null);
async function loadExport(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 3_500_000) {
    toast('That file is too large. Export the chat "Without media".', 'error');
    input.value = '';
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  gx.busy = true;
  gxResult.value = null;
  const r = await run(() => api<{ group: string | null; lines: number; candidates: ExportCandidate[] }>('/whatsapp-export/preview', { method: 'POST', body: { fileName: file.name, base64: btoa(bin) } }));
  gx.busy = false;
  input.value = '';
  if (!r) return;
  gx.fileName = file.name;
  gx.group = r.group ?? gx.group;
  gxLines.value = r.lines;
  gxRows.value = r.candidates.map((c) => ({ ...c, include: false, pickedCategory: c.category ?? '' }));
}
const gxSelected = () => gxRows.value.filter((r) => r.include);
async function importGroup() {
  const rows = gxSelected().map((r) => ({ name: r.name.trim(), phone: r.phoneKey!, category: r.pickedCategory || gx.defaultCategory, sample: r.sample }));
  gxResult.value = (await run(() => api<NonNullable<typeof gxResult.value>>('/whatsapp-export/import', { method: 'POST', body: { group: gx.group.trim(), consent: true, rows } }))) ?? null;
  if (gxResult.value) {
    toast(`Imported: ${gxResult.value.created} new, ${gxResult.value.merged + gxResult.value.seen} already known`);
    gxRows.value = [];
    gx.consent = false;
  }
}

const csvText = ref('');
const importResult = ref<{ rows: number; created: number; merged: number; seen: number; errors: Array<{ row: number; error: string }> } | null>(null);

async function loadRuns() {
  const res = await api<{ data: Run[] }>('/discovery/runs').catch(() => null);
  if (res) runs.value = res.data;
}
let timer: ReturnType<typeof setInterval>;
onMounted(async () => {
  options.value = await getOptions().catch(() => null);
  sel.categories = options.value?.categories.map((c) => c.id) ?? [];
  await loadRuns();
  void loadSearchStatus();
  groupEnabled.value = (await api<{ groupImportEnabled: boolean }>('/settings').catch(() => null))?.groupImportEnabled ?? false;
  timer = setInterval(loadRuns, 4000);
});
onUnmounted(() => clearInterval(timer));

const toggle = (list: string[], v: string) => {
  const i = list.indexOf(v);
  if (i >= 0) list.splice(i, 1);
  else list.push(v);
};
const catLabel = (id: string) => options.value?.categories.find((c) => c.id === id)?.label ?? id;
const regionLabel = (code: string) => options.value?.regions.find((r) => r.code === code)?.label ?? code;

async function startSearch() {
  const res = await run(() =>
    api<{ queued: number; skipped: string[]; agentState: string }>('/discovery/runs', { method: 'POST', body: { ...sel } }),
  );
  if (!res) return;
  const parts = [`${res.queued} search${res.queued === 1 ? '' : 'es'} queued`];
  if (res.skipped.length) parts.push(`${res.skipped.length} already ran today (tick "Run again" to repeat)`);
  if (res.queued && res.agentState !== 'running') parts.push('press Start to run them');
  toast(parts.join('; '));
  await loadRuns();
}

async function addManual() {
  manualErrors.value = {};
  const body = Object.fromEntries(Object.entries(manual).map(([k, v]) => [k, v.trim() || null]));
  try {
    const res = await api<{ leadId: number; outcome: string }>('/leads', { method: 'POST', body });
    toast(res.outcome === 'created' ? 'Lead added' : 'Matched an existing lead; details merged');
    if (igPrefill.value) await run(() => api(`/leads/${res.leadId}/instagram`, { method: 'POST', body: { username: igPrefill.value } }));
    igPrefill.value = null;
    igProfile.value = null;
    for (const k of Object.keys(manual)) manual[k] = '';
  } catch (err) {
    if (err instanceof ApiError && err.fields.length) for (const f of err.fields) manualErrors.value[f.path] = f.message;
    toast(err instanceof Error ? err.message : 'Could not add lead', 'error');
  }
}

async function importCsv() {
  importResult.value = (await run(() => api<NonNullable<typeof importResult.value>>('/leads/import', { method: 'POST', body: { csv: csvText.value } }))) ?? null;
  if (importResult.value) toast(`Imported: ${importResult.value.created} new, ${importResult.value.merged + importResult.value.seen} matched existing`);
}
async function loadFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) csvText.value = await file.text();
}
/** The task's state wins over the run's: a failed attempt that will retry is not a failure yet. */
function runState(r: Run): { text: string; cls: string } {
  if (r.task_status === 'needs_review') return { text: 'Needs review', cls: 'warn' };
  if (r.task_status === 'running') return { text: 'Running', cls: 'info' };
  if (r.task_status === 'pending') return r.error ? { text: 'Retrying soon', cls: 'warn' } : { text: 'Queued', cls: 'info' };
  if (r.status === 'done') return { text: 'Done', cls: 'ok' };
  if (r.status === 'failed') return { text: 'Failed', cls: 'danger' };
  return { text: statusLabel[r.status] ?? r.status, cls: '' };
}
</script>

<template>
  <div class="page-head">
    <div>
      <h1>Discovery</h1>
      <p>Find merchants from free, permitted sources. Only business details are stored.</p>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <h2>Search OpenStreetMap</h2>
      <span class="pill ok">Free</span>
    </div>
    <p class="muted" style="margin-top: 0">
      One search per category and state, spaced out to respect OpenStreetMap's fair-use rules. Coverage in Nigeria is thin and most listings
      have no email, so expect a modest number of leads. Websites found are then checked for a public contact email.
    </p>
    <h3 style="margin: 12px 0 8px">Categories</h3>
    <div class="chips">
      <button v-for="c in options?.categories" :key="c.id" class="chip" :class="{ on: sel.categories.includes(c.id) }" :aria-pressed="sel.categories.includes(c.id)" @click="toggle(sel.categories, c.id)">{{ c.label }}</button>
    </div>
    <h3 style="margin: 14px 0 8px">States <span class="muted small">(up to 10 per batch)</span></h3>
    <div class="chips">
      <button v-for="r in options?.regions" :key="r.code" class="chip" :class="{ on: sel.regions.includes(r.code) }" :aria-pressed="sel.regions.includes(r.code)" @click="toggle(sel.regions, r.code)">{{ r.label }}</button>
    </div>
    <div class="btn-row" style="margin-top: 14px">
      <button class="btn primary" :disabled="!sel.categories.length || !sel.regions.length || sel.regions.length > 10" @click="startSearch">
        Queue {{ sel.categories.length * sel.regions.length }} search{{ sel.categories.length * sel.regions.length === 1 ? '' : 'es' }}
      </button>
      <label class="check small"><input type="checkbox" v-model="sel.force" /> Run again even if already searched today</label>
      <span v-if="status && status.agent.state !== 'running'" class="muted small">The agent is {{ status.agent.state }}; searches run once you press Start.</span>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Search history</h2></div>
    <div class="table-wrap" v-if="runs.length">
      <table>
        <thead><tr><th>Search</th><th>Status</th><th class="num">Found</th><th class="num">New</th><th class="num">Merged</th><th class="num">Unnamed</th><th>Started</th></tr></thead>
        <tbody>
          <tr v-for="r in runs" :key="r.id">
            <td>{{ catLabel(r.params.category) }} · {{ regionLabel(r.params.region) }}</td>
            <td>
              <span class="pill" :class="runState(r).cls">{{ runState(r).text }}</span>
              <div v-if="r.error" class="muted small">{{ r.error }}</div>
            </td>
            <td class="num">{{ r.found }}</td><td class="num">{{ r.created }}</td><td class="num">{{ r.merged }}</td><td class="num">{{ r.skipped }}</td>
            <td class="small nowrap">{{ fmtDate(r.started_at) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="muted">No searches yet.</p>
  </div>

  <div class="card" style="margin-top: 16px">
    <div class="card-head"><h2>Instagram lookup</h2><span class="pill">Meta app · business and creator accounts</span></div>
    <p class="muted small" style="margin-top: 0">
      Type an @username you found while scrolling. The agent asks Instagram for that account's public profile (name, bio, website, followers, posts).
      It can't search Instagram. Switch it on in Settings → Instagram &amp; Facebook.
    </p>
    <form class="btn-row" @submit.prevent="lookUpInstagram">
      <input v-model="igUsername" placeholder="@username or profile link" style="max-width: 320px" aria-label="Instagram username" />
      <button class="btn" :disabled="!igUsername.trim() || igBusy">{{ igBusy ? 'Looking up…' : 'Look up' }}</button>
    </form>
    <div v-if="igProfile" class="banner info small" style="margin-top: 10px">
      <strong>@{{ igProfile.username }}</strong><span v-if="igProfile.name"> · {{ igProfile.name }}</span>
      · {{ igProfile.followers?.toLocaleString() ?? '—' }} followers · {{ igProfile.posts?.toLocaleString() ?? '—' }} posts
      <div v-if="igProfile.biography" style="white-space: pre-wrap; margin-top: 4px">{{ igProfile.biography }}</div>
      <div v-if="igProfile.website">Website: {{ igProfile.website }}</div>
      <div v-if="igProfile.phonesInBio.length">Phone in bio: {{ igProfile.phonesInBio.join(', ') }}</div>
      <button class="btn small" style="margin-top: 6px" @click="useProfile(igProfile)">Use in "Add a lead yourself"</button>
    </div>
  </div>

  <div class="card" style="margin-top: 16px">
    <div class="card-head"><h2>Web search</h2><span class="pill">Tavily · Brave · only when you press Search</span></div>
    <p class="muted small" style="margin-top: 0">
      Finds shops' websites and Instagram, Facebook and TikTok profiles through an official search API. Pick a result to fill "Add a lead yourself", or look up an
      Instagram profile. Choose providers, limits and country in Settings → Web search &amp; groups.
    </p>
    <div v-if="searchStatus && !usableProviders().length" class="banner warn small">
      No search provider is ready. Add a key to <code>.env</code> (TAVILY_API_KEY or BRAVE_SEARCH_API_KEY), restart, then tick it in Settings → Web search &amp; groups.
    </div>
    <form class="grid" style="gap: 8px" @submit.prevent="runWebSearch">
      <div class="btn-row">
        <input v-model="ws.query" placeholder="e.g. fabric shop Balogun Lagos" style="flex: 1; min-width: 220px" aria-label="Search words" />
        <select v-model="ws.scope" aria-label="Where to search" style="max-width: 160px">
          <option v-for="(label, k) in SCOPE_LABEL" :key="k" :value="k">{{ label }}</option>
        </select>
      </div>
      <div class="btn-row">
        <label v-for="p in searchStatus?.providers ?? []" :key="p.id" class="check small" :title="!p.keySet ? 'No API key in .env' : !p.enabled ? 'Off in Settings' : ''">
          <input type="checkbox" :value="p.id" v-model="ws.providers" :disabled="!p.enabled || !p.keySet" />
          {{ PROVIDER_NAME[p.id] }} <span class="muted">({{ p.usedThisMonth }}/{{ p.limit }} this month)</span>
        </label>
        <label class="check small"><input type="checkbox" v-model="ws.fresh" /> Search again even if saved</label>
        <button class="btn primary" :disabled="wsBusy || ws.query.trim().length < 3 || !ws.providers.length">{{ wsBusy ? 'Searching…' : 'Search' }}</button>
      </div>
    </form>
    <div v-for="o in wsOutcomes.filter((x) => x.error || x.cached)" :key="o.provider" class="small" :class="o.error ? 'banner warn' : 'muted'" style="margin-top: 8px">
      {{ PROVIDER_NAME[o.provider] }}: {{ o.error ?? 'saved results shown (no search spent)' }}
    </div>
    <div v-if="wsOutcomes.length" class="table-wrap" style="margin-top: 10px">
      <table v-if="mergedResults().length">
        <thead><tr><th>Result</th><th>What it is</th><th></th></tr></thead>
        <tbody>
          <tr v-for="r in mergedResults()" :key="r.url">
            <td>
              <a :href="r.url" target="_blank" rel="noopener noreferrer">{{ r.title || r.url }}</a>
              <div class="muted small">{{ r.snippet }}</div>
            </td>
            <td class="small nowrap">
              <template v-if="r.kind === 'profile'">{{ r.platform }} @{{ r.handle }}</template>
              <template v-else-if="r.kind === 'website'">Website · {{ r.domain }}</template>
              <template v-else>Page</template>
              <div class="muted">{{ r.from.map((p) => PROVIDER_NAME[p]).join(' + ') }}</div>
            </td>
            <td class="small nowrap">
              <RouterLink v-if="r.leadId" :to="`/leads/${r.leadId}`">Already a lead</RouterLink>
              <template v-else-if="r.kind !== 'other'">
                <button class="btn small" @click="useResult(r)">Use in "Add a lead"</button>
                <button v-if="r.platform === 'instagram' && r.handle" class="btn small" style="margin-left: 4px" @click="lookUpResult(r.handle)">Look up</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted small">No results.</p>
    </div>
  </div>

  <div class="card" style="margin-top: 16px">
    <div class="card-head"><h2>WhatsApp group export</h2><span class="pill">Assist only · you send every message</span></div>
    <p class="muted small" style="margin-top: 0">
      In a WhatsApp group you're in: ⋮ → More → Export chat → <strong>Without media</strong>, then upload the .txt or .zip here. You see each sender and tick
      the vendors to add. Only their name, number and one short sample are kept; the chat itself is not stored.
    </p>
    <div v-if="!groupEnabled" class="banner info small">Off. Switch it on in Settings → Web search &amp; groups.</div>
    <template v-else>
      <input type="file" accept=".txt,.zip,text/plain,application/zip" :disabled="gx.busy" aria-label="WhatsApp chat export" @change="loadExport" />
      <span v-if="gx.busy" class="muted small"> Reading…</span>
      <template v-if="gxRows.length">
        <p class="small">{{ gx.fileName }}: {{ gxLines }} messages from {{ gxRows.length }} people. Tick only vendors who sell things StockỌja helps with.</p>
        <div class="grid grid-2" style="gap: 10px">
          <label class="field">Group name *<input v-model="gx.group" maxlength="120" /><small>Shown in the first line of your messages.</small></label>
          <label class="field">Category for ticked rows without one
            <select v-model="gx.defaultCategory"><option value="">Choose…</option><option v-for="c in options?.categories" :key="c.id" :value="c.id">{{ c.label }}</option></select>
          </label>
        </div>
        <div class="table-wrap" style="margin-top: 8px">
          <table>
            <thead><tr><th></th><th>Name</th><th>Number</th><th>Category</th><th>What they posted</th></tr></thead>
            <tbody>
              <tr v-for="r in gxRows" :key="r.key">
                <td><input type="checkbox" v-model="r.include" :disabled="!r.phoneKey || !!r.blocked" :aria-label="`Add ${r.name || r.phone}`" /></td>
                <td><input v-model="r.name" :placeholder="r.phone ?? 'Name'" style="min-width: 140px" /></td>
                <td class="small nowrap">
                  {{ r.phone ?? 'No number' }}
                  <div v-if="r.phoneFrom === 'message'" class="muted">from a message</div>
                  <div v-if="r.blocked" style="color: var(--danger)">On do-not-contact</div>
                  <RouterLink v-else-if="r.existingLeadId" :to="`/leads/${r.existingLeadId}`">Already a lead</RouterLink>
                </td>
                <td>
                  <select v-model="r.pickedCategory"><option value="">{{ gx.defaultCategory ? 'As above' : 'Choose…' }}</option><option v-for="c in options?.categories" :key="c.id" :value="c.id">{{ c.label }}</option></select>
                </td>
                <td class="small muted" style="max-width: 360px">{{ r.sample ?? '—' }} <span v-if="r.messages > 1">({{ r.messages }} messages)</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <label class="check small" style="margin-top: 10px">
          <input type="checkbox" v-model="gx.consent" />
          I'll message these people myself, one at a time, only about StockỌja, and stop if they reply STOP. Each first message opens with my group first line.
        </label>
        <div class="btn-row" style="margin-top: 8px">
          <button class="btn primary" :disabled="!gx.consent || !gx.group.trim() || !gxSelected().length || gxSelected().some((r) => !r.pickedCategory && !gx.defaultCategory)" @click="importGroup">
            Add {{ gxSelected().length }} lead{{ gxSelected().length === 1 ? '' : 's' }}
          </button>
          <span v-if="gxSelected().some((r) => !r.pickedCategory && !gx.defaultCategory)" class="muted small">Choose a category for every ticked row.</span>
        </div>
      </template>
      <div v-if="gxResult" class="banner info small" style="margin-top: 10px">
        {{ gxResult.created }} new lead(s), {{ gxResult.merged + gxResult.seen }} already known, {{ gxResult.skipped.length }} skipped.
        <ul v-if="gxResult.skipped.length" style="margin: 6px 0 0; padding-left: 18px"><li v-for="sk in gxResult.skipped.slice(0, 10)" :key="sk.name">{{ sk.name }}: {{ sk.reason }}</li></ul>
      </div>
    </template>
  </div>

  <div class="grid grid-2" style="margin-top: 16px">
    <div class="card">
      <div class="card-head"><h2>Add a lead yourself</h2><span class="pill">Recorded as “Added by you”</span></div>
      <p class="muted small" style="margin-top: 0">
        For businesses you find on Instagram, Jumia, Google Maps and similar. Paste the public profile link; the agent doesn't scrape those sites.
      </p>
      <form class="grid" style="gap: 10px" @submit.prevent="addManual">
        <label class="field">Business name *<input v-model="manual.business_name" required /><small v-if="manualErrors.business_name" style="color: var(--danger)">{{ manualErrors.business_name }}</small></label>
        <label class="field">Category *
          <select v-model="manual.category" required>
            <option value="" disabled>Choose…</option>
            <option v-for="c in options?.categories" :key="c.id" :value="c.id">{{ c.label }}</option>
          </select>
        </label>
        <div class="grid grid-2" style="gap: 10px">
          <label class="field">City<input v-model="manual.city" /></label>
          <label class="field">State<input v-model="manual.state" placeholder="e.g. Lagos" /></label>
          <label class="field">Business phone<input v-model="manual.phone" inputmode="tel" /></label>
          <label class="field">Business email<input v-model="manual.email" type="email" /></label>
          <label class="field">Website<input v-model="manual.website" /></label>
          <label class="field">Instagram<input v-model="manual.instagram" placeholder="https://instagram.com/…" /></label>
          <label class="field">Facebook<input v-model="manual.facebook" /></label>
          <label class="field">TikTok<input v-model="manual.tiktok" placeholder="@username" /></label>
          <label class="field">Telegram<input v-model="manual.telegram" placeholder="@username or t.me/…" /></label>
        </div>
        <label class="field">Where you found it<input v-model="manual.source_url" placeholder="Link to the public profile or listing" /></label>
        <label class="field">Notes<textarea v-model="manual.notes" rows="2"></textarea></label>
        <div><button class="btn primary" type="submit">Add lead</button></div>
      </form>
    </div>

    <div class="card">
      <div class="card-head"><h2>Import a CSV</h2><span class="pill">Recorded as “Imported by you”</span></div>
      <p class="muted small" style="margin-top: 0">
        Columns (header row): <code>{{ options?.csvColumns.join(', ') }}</code>. Only <code>business_name</code> and <code>category</code> are required.
        Rows matching an existing lead are merged, not duplicated.
      </p>
      <input type="file" accept=".csv,text/csv" @change="loadFile" aria-label="CSV file" />
      <textarea v-model="csvText" rows="8" placeholder="…or paste CSV here" style="margin-top: 8px; font-family: ui-monospace, monospace; font-size: 12px"></textarea>
      <div class="btn-row" style="margin-top: 8px"><button class="btn primary" :disabled="!csvText.trim()" @click="importCsv">Import</button></div>
      <div v-if="importResult" class="banner info" style="margin: 12px 0 0">
        {{ importResult.rows }} rows: {{ importResult.created }} new, {{ importResult.merged + importResult.seen }} matched existing leads, {{ importResult.errors.length }} skipped.
        <ul v-if="importResult.errors.length" class="small" style="margin: 6px 0 0; padding-left: 18px">
          <li v-for="e in importResult.errors.slice(0, 10)" :key="e.row">Row {{ e.row }}: {{ e.error }}</li>
        </ul>
      </div>
    </div>
  </div>

  <div class="card" style="margin-top: 16px">
    <div class="card-head"><h2>Sources not used</h2></div>
    <ul class="small muted" style="margin: 0; padding-left: 18px">
      <li><strong>Instagram, Facebook, TikTok, Jumia, Konga:</strong> their terms forbid scraping. Add businesses you find there by hand; Instagram business profiles can be looked up above.</li>
      <li><strong>Google Places:</strong> needs a billing account. Off unless you approve the cost.</li>
      <li><strong>WhatsApp itself:</strong> never read or automated. Group members come only from an export you make and upload.</li>
    </ul>
  </div>
</template>
