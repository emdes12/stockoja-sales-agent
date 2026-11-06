<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { ApiError, api, connection, fmtDate, qs, run, toast } from '../api';

interface Entry { id: number; topic: string; question: string; answer: string; status: 'draft' | 'approved' | 'retired'; source: string | null; approved_at: string | null; updated_at: string }
interface Source {
  id: number; kind: 'file' | 'text' | 'web'; title: string; origin: string | null; site_root: string | null; strategy: 'structure' | 'fixed';
  chunk_words: number; chunk_overlap: number; enabled: boolean; word_count: number; chunk_count: number; embedded: number;
  fetched_at: string | null; updated_at: string;
}
interface Chunk { id: number; ord: number; heading: string | null; content: string; word_count: number; embedded_at: string | null }
interface Status {
  sources: number; files: number; pages: number; chunks: number; embedded: number; vector: boolean; model: string;
  embedder: { status: string; error: string | null; running: boolean }; supported: string[]; maxUploadMb: number;
  defaults: { strategy: 'structure' | 'fixed'; words: number; overlap: number };
  lastWebsiteRead: { at: string; results: Array<{ link: string; pages: number; changed: number; unchanged: number; skipped: Array<{ url: string; why: string }>; error: string | null }> } | null;
}
interface Hit { chunkId: number; sourceId: number; title: string; origin: string | null; kind: string; heading: string | null; content: string; similarity: number | null; matchedBy: string[] }

const tab = ref<'answers' | 'documents' | 'website' | 'search'>('answers');
const status = ref<Status | null>(null);

// ── Answers (FAQ) ──
const entries = ref<Entry[]>([]);
const edits = reactive<Record<number, { topic: string; question: string; answer: string }>>({});
const editingId = ref<number | null>(null);
const fresh = reactive({ topic: '', question: '', answer: '' });
const showNew = ref(false);
const testQ = ref('');
const testResults = ref<Array<{ entry: Entry; score: number }> | null>(null);

async function loadEntries() {
  const res = await api<{ data: Entry[] }>('/kb').catch(() => null);
  if (res) entries.value = res.data;
}
const counts = computed(() => ({
  draft: entries.value.filter((e) => e.status === 'draft').length,
  approved: entries.value.filter((e) => e.status === 'approved').length,
}));
function startEdit(e: Entry) {
  edits[e.id] = { topic: e.topic, question: e.question, answer: e.answer };
  editingId.value = e.id;
}
async function saveEdit(e: Entry) {
  if (await run(() => api<Entry>(`/kb/${e.id}`, { method: 'PUT', body: edits[e.id] }))) {
    editingId.value = null;
    await loadEntries();
  }
}
async function setStatus(e: Entry, action: 'approve' | 'retire' | 'unapprove') {
  if (await run(() => api(`/kb/${e.id}/${action}`, { method: 'POST' }), { approve: 'Approved', retire: 'Retired', unapprove: 'Back to draft' }[action])) await loadEntries();
}
async function add() {
  if (await run(() => api('/kb', { method: 'POST', body: fresh }), 'Added as a draft')) {
    Object.assign(fresh, { topic: '', question: '', answer: '' });
    showNew.value = false;
    await loadEntries();
  }
}
async function test() {
  testResults.value = (await run(() => api<{ data: Array<{ entry: Entry; score: number }> }>(`/kb/search${qs({ q: testQ.value })}`)))?.data ?? null;
}
const cls = { draft: 'warn', approved: 'ok', retired: '' } as const;

// ── Documents and website pages ──
const sources = ref<Source[]>([]);
const opened = ref<(Source & { chunks: Chunk[] }) | null>(null);
const chunkForm = reactive({ strategy: 'structure' as 'structure' | 'fixed', words: 200, overlap: 40 });
const uploading = ref<string | null>(null);
const pasted = reactive({ title: '', text: '', show: false });

async function loadStatus() {
  status.value = await api<Status>('/knowledge/status').catch(() => status.value);
}
async function loadSources() {
  sources.value = (await api<{ data: Source[] }>('/knowledge/sources').catch(() => ({ data: sources.value }))).data;
}
const documents = computed(() => sources.value.filter((s) => s.kind !== 'web'));
const sites = computed(() => {
  const by = new Map<string, Source[]>();
  for (const s of sources.value.filter((x) => x.kind === 'web')) by.set(s.site_root ?? '', [...(by.get(s.site_root ?? '') ?? []), s]);
  return [...by.entries()].map(([root, pages]) => ({ root, pages }));
});
const overlapTooBig = computed(() => chunkForm.overlap * 2 > chunkForm.words);

/** Uploads one file at a time as the raw request body (the server reads PDF, Word, text, Markdown, HTML and CSV). */
async function upload(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  for (const file of files) {
    if (status.value && file.size > status.value.maxUploadMb * 1_000_000) {
      toast(`${file.name} is larger than ${status.value.maxUploadMb} MB`, 'error');
      continue;
    }
    uploading.value = file.name;
    try {
      const res = await fetch(`/api/knowledge/upload${qs({ name: file.name, strategy: chunkForm.strategy, words: chunkForm.words, overlap: chunkForm.overlap })}`, {
        method: 'POST',
        headers: { 'X-Agent-Client': 'dashboard', 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? `Upload failed (${res.status})`);
      toast(`Added "${data.title}": ${data.chunk_count} chunk(s)`);
    } catch (err) {
      if (err instanceof TypeError) connection.down = true;
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }
  uploading.value = null;
  await Promise.all([loadSources(), loadStatus()]);
}
async function addPasted() {
  const body = { title: pasted.title, text: pasted.text, strategy: chunkForm.strategy, words: chunkForm.words, overlap: chunkForm.overlap };
  if (await run(() => api('/knowledge/text', { method: 'POST', body }), 'Text added')) {
    Object.assign(pasted, { title: '', text: '', show: false });
    await Promise.all([loadSources(), loadStatus()]);
  }
}
async function open(s: Source) {
  if (opened.value?.id === s.id) {
    opened.value = null;
    return;
  }
  opened.value = (await run(() => api<Source & { chunks: Chunk[] }>(`/knowledge/sources/${s.id}`))) ?? null;
}
async function rechunk(s: Source) {
  const body = { strategy: chunkForm.strategy, words: chunkForm.words, overlap: chunkForm.overlap };
  if (await run(() => api(`/knowledge/sources/${s.id}/rechunk`, { method: 'POST', body }), `Re-chunked "${s.title}"`)) {
    if (opened.value?.id === s.id) opened.value = null;
    await Promise.all([loadSources(), loadStatus()]);
  }
}
async function rechunkAll() {
  const how = chunkForm.strategy === 'structure' ? 'follow structure' : 'fixed window';
  if (!confirm(`Re-split every document and page with: ${how}, ${chunkForm.words} words, ${chunkForm.overlap} overlap?\n\nUses the saved text; nothing is uploaded or fetched again.`)) return;
  const body = { strategy: chunkForm.strategy, words: chunkForm.words, overlap: chunkForm.overlap };
  if (await run(() => api('/knowledge/rechunk-all', { method: 'POST', body }), 'Everything re-chunked')) await Promise.all([loadSources(), loadStatus()]);
}
async function toggle(s: Source) {
  if (await run(() => api(`/knowledge/sources/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }), s.enabled ? 'Left out of search' : 'Used in search')) await loadSources();
}
async function remove(s: Source) {
  if (!confirm(`Delete "${s.title}" and its ${s.chunk_count} chunk(s)? This can't be undone (you can upload it again).`)) return;
  if (await run(() => api(`/knowledge/sources/${s.id}`, { method: 'DELETE' }), 'Deleted')) {
    if (opened.value?.id === s.id) opened.value = null;
    await Promise.all([loadSources(), loadStatus()]);
  }
}
async function removeSite(root: string, n: number) {
  if (!confirm(`Delete all ${n} page(s) read from ${root}? Reading the link again brings them back.`)) return;
  if (await run(() => api(`/knowledge/sites${qs({ root })}`, { method: 'DELETE' }), 'Pages deleted')) await Promise.all([loadSources(), loadStatus()]);
}
async function readWebsites(link?: string) {
  const r = await run(() => api<{ agentRunning: boolean }>('/knowledge/read-websites', { method: 'POST', body: link ? { link } : {} }));
  if (r) toast(r.agentRunning ? 'Reading your website now; pages appear here as they are read' : 'Queued. It runs when you press Start (it fetches web pages)');
}
async function embedNow() {
  if (await run(() => api('/knowledge/embed', { method: 'POST' }), 'Preparing meaning search in the background')) setTimeout(loadStatus, 1500);
}

// ── Search ──
const q = ref('');
const searching = ref(false);
const results = ref<{ hits: Hit[]; mode: string } | null>(null);
async function search() {
  searching.value = true;
  results.value = (await run(() => api<{ hits: Hit[]; mode: string }>(`/knowledge/search${qs({ q: q.value, limit: 8 })}`))) ?? null;
  searching.value = false;
}

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(async () => {
  await Promise.all([loadEntries(), loadStatus(), loadSources()]);
  if (status.value) Object.assign(chunkForm, status.value.defaults);
  // While embedding runs in the background, keep the progress current.
  timer = setInterval(() => {
    if (tab.value !== 'answers' && (status.value?.embedder.running || status.value?.embedder.status === 'loading')) void Promise.all([loadStatus(), loadSources()]);
  }, 4000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
watch(tab, (t) => {
  if (t !== 'answers') void Promise.all([loadStatus(), loadSources()]);
});

const searchModeText = computed(() => {
  const s = status.value;
  if (!s) return '';
  if (!s.vector) return 'Word search only. Meaning search needs pgvector enabled once (see README, "Knowledge").';
  if (s.embedder.status === 'failed') return `Word search only: ${s.embedder.error}`;
  if (s.embedder.running || s.embedder.status === 'loading') return `Preparing meaning search: ${s.embedded} of ${s.chunks} chunks done…`;
  if (s.chunks && s.embedded < s.chunks) return `Meaning search covers ${s.embedded} of ${s.chunks} chunks.`;
  return 'Meaning + word search (hybrid), all on this laptop.';
});
const kindLabel: Record<string, string> = { file: 'File', text: 'Pasted text', web: 'Web page' };
</script>

<template>
  <div class="page-head">
    <div>
      <h1>Knowledge</h1>
      <p>What the agent knows about StockỌja: answers you approve, your documents, and your website. Everything is stored and searched on this laptop.</p>
    </div>
  </div>

  <div class="btn-row" style="margin-bottom: 14px">
    <button class="btn" :class="{ primary: tab === 'answers' }" @click="tab = 'answers'">Approved answers ({{ counts.approved }})</button>
    <button class="btn" :class="{ primary: tab === 'documents' }" @click="tab = 'documents'">Documents ({{ documents.length }})</button>
    <button class="btn" :class="{ primary: tab === 'website' }" @click="tab = 'website'">Website ({{ status?.pages ?? 0 }} pages)</button>
    <button class="btn" :class="{ primary: tab === 'search' }" @click="tab = 'search'">Search</button>
  </div>

  <!-- Answers -->
  <template v-if="tab === 'answers'">
    <div class="card">
      <div class="card-head">
        <p class="muted small" style="margin: 0">
          Short answers the agent may send <strong>word for word</strong> in replies (no AI needed). It uses <strong>approved</strong> entries only. Editing an approved entry sends it back to draft.
        </p>
        <button class="btn primary" @click="showNew = !showNew">Add an answer</button>
      </div>
      <div v-if="counts.draft" class="banner warn">
        {{ counts.draft }} entr{{ counts.draft === 1 ? 'y is' : 'ies are' }} waiting for your approval. Check each one is accurate before approving.
      </div>
      <div v-if="showNew" class="grid" style="gap: 10px; margin-top: 10px">
        <label class="field">Topic<input v-model="fresh.topic" placeholder="e.g. Pricing" /></label>
        <label class="field">Question<input v-model="fresh.question" placeholder="How a merchant might ask it" /></label>
        <label class="field">Answer<textarea v-model="fresh.answer" rows="4"></textarea></label>
        <div class="btn-row"><button class="btn primary" :disabled="!fresh.topic || !fresh.question || !fresh.answer" @click="add">Add as draft</button></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Try a question</h2><span class="muted small">See which approved answer the agent would use</span></div>
      <form class="btn-row" @submit.prevent="test">
        <input v-model="testQ" style="flex: 1" placeholder="e.g. Can I sell online? Does it work on my phone?" />
        <button class="btn" :disabled="!testQ.trim()">Search</button>
      </form>
      <div v-if="testResults" style="margin-top: 10px">
        <p v-if="!testResults.length" class="muted small" style="margin: 0">No approved answer matches. The agent passes this to you (or to AI, if you turned that on).</p>
        <ul v-else class="list">
          <li v-for="r in testResults" :key="r.entry.id"><strong>{{ r.entry.question }}</strong> <span class="muted small">match {{ Math.round(r.score * 100) }}%</span><div class="small">{{ r.entry.answer }}</div></li>
        </ul>
      </div>
    </div>

    <div v-for="e in entries" :key="e.id" class="card" :style="{ opacity: e.status === 'retired' ? 0.6 : 1 }">
      <template v-if="editingId === e.id">
        <div class="grid" style="gap: 10px">
          <label class="field">Topic<input v-model="edits[e.id]!.topic" /></label>
          <label class="field">Question<input v-model="edits[e.id]!.question" /></label>
          <label class="field">Answer<textarea v-model="edits[e.id]!.answer" rows="4"></textarea></label>
          <div class="btn-row"><button class="btn primary" @click="saveEdit(e)">Save</button><button class="btn" @click="editingId = null">Cancel</button></div>
        </div>
      </template>
      <template v-else>
        <div class="card-head" style="margin-bottom: 6px">
          <div><span class="muted small">{{ e.topic }}</span><h3>{{ e.question }}</h3></div>
          <span class="pill" :class="cls[e.status]">{{ e.status }}</span>
        </div>
        <p style="margin: 0 0 8px">{{ e.answer }}</p>
        <div class="btn-row" style="justify-content: space-between">
          <span class="muted small">Source: {{ e.source ?? '—' }}<span v-if="e.approved_at"> · approved {{ fmtDate(e.approved_at) }}</span></span>
          <div class="btn-row">
            <button v-if="e.status === 'draft'" class="btn small primary" @click="setStatus(e, 'approve')">Approve</button>
            <button v-if="e.status === 'approved'" class="btn small" @click="setStatus(e, 'unapprove')">Unapprove</button>
            <button v-if="e.status === 'retired'" class="btn small" @click="setStatus(e, 'unapprove')">Restore as draft</button>
            <button class="btn small" @click="startEdit(e)">Edit</button>
            <button v-if="e.status !== 'retired'" class="btn small danger" @click="setStatus(e, 'retire')">Retire</button>
          </div>
        </div>
      </template>
    </div>
  </template>

  <!-- Chunk settings, shared by Documents and Website -->
  <div v-if="tab === 'documents' || tab === 'website'" class="card">
    <div class="card-head">
      <h2>How text is split (chunking)</h2>
      <span class="muted small">{{ searchModeText }}</span>
    </div>
    <div class="grid grid-3">
      <label class="field">Strategy
        <select v-model="chunkForm.strategy">
          <option value="structure">Follow structure (headings, paragraphs)</option>
          <option value="fixed">Fixed window of words</option>
        </select>
        <small>Structure keeps each heading with its text: best for guides, FAQs and web pages.</small>
      </label>
      <label class="field">Words per chunk<input v-model.number="chunkForm.words" type="number" min="50" max="400" /><small>150–250 suits most documents. Smaller is more precise; larger keeps more context.</small></label>
      <label class="field">Overlap (words)<input v-model.number="chunkForm.overlap" type="number" min="0" max="200" /><small>Repeated between neighbouring chunks; 10–20% of the size is typical, at most half.</small></label>
    </div>
    <div v-if="overlapTooBig" class="banner warn">Overlap can be at most half the chunk size.</div>
    <div class="btn-row" style="margin-top: 10px">
      <span class="muted small" style="flex: 1">Used for uploads from this page. Your saved default (also used for website pages) is in Settings → Knowledge. Existing chunks change only when you re-chunk.</span>
      <button class="btn small" :disabled="overlapTooBig || !status?.sources" @click="rechunkAll">Re-chunk everything with these</button>
      <button v-if="status?.vector && status.embedded < status.chunks && !status.embedder.running" class="btn small" @click="embedNow">Prepare meaning search</button>
    </div>
  </div>

  <!-- Documents -->
  <template v-if="tab === 'documents'">
    <div class="card">
      <div class="card-head"><h2>Add documents</h2><span class="muted small">{{ status?.supported.map((e) => `.${e}`).join(' ') }} · up to {{ status?.maxUploadMb }} MB each</span></div>
      <p class="muted small" style="margin-top: 0">
        Product guides, price lists, FAQs, policies, onboarding steps… The agent searches them to suggest answers in the Inbox, and AI drafting (if on) uses them as its only source of facts.
        Text is extracted on this laptop; scanned PDFs (images only) have no text to read.
      </p>
      <div class="btn-row">
        <label class="btn primary" :style="{ opacity: overlapTooBig || uploading ? 0.6 : 1 }">
          {{ uploading ? `Reading ${uploading}…` : 'Upload files' }}
          <input type="file" multiple :accept="status?.supported.map((e) => `.${e}`).join(',')" style="display: none" :disabled="overlapTooBig || !!uploading" @change="upload" />
        </label>
        <button class="btn" @click="pasted.show = !pasted.show">Paste text</button>
      </div>
      <div v-if="pasted.show" class="grid" style="gap: 10px; margin-top: 10px">
        <label class="field">Title<input v-model="pasted.title" placeholder="e.g. Refund policy" /></label>
        <label class="field">Text<textarea v-model="pasted.text" rows="8" placeholder="Markdown headings (## Pricing) help the chunker follow the structure."></textarea></label>
        <div class="btn-row"><button class="btn primary" :disabled="!pasted.title.trim() || !pasted.text.trim() || overlapTooBig" @click="addPasted">Add</button></div>
      </div>
    </div>

    <div v-if="!documents.length" class="card muted">No documents yet.</div>
    <div v-for="s in documents" :key="s.id" class="card" :style="{ opacity: s.enabled ? 1 : 0.6 }">
      <div class="card-head" style="margin-bottom: 4px">
        <div>
          <strong>{{ s.title }}</strong>
          <div class="muted small">
            {{ kindLabel[s.kind] }}<template v-if="s.origin"> · {{ s.origin }}</template> · {{ s.word_count.toLocaleString() }} words ·
            {{ s.chunk_count }} chunks ({{ s.strategy }}, {{ s.chunk_words }} words, {{ s.chunk_overlap }} overlap)
            <template v-if="status?.vector"> · meaning search {{ s.embedded }}/{{ s.chunk_count }}</template> · updated {{ fmtDate(s.updated_at) }}
          </div>
        </div>
        <span class="pill" :class="s.enabled ? 'ok' : ''">{{ s.enabled ? 'in use' : 'left out' }}</span>
      </div>
      <div class="btn-row">
        <button class="btn small" @click="open(s)">{{ opened?.id === s.id ? 'Hide chunks' : 'View chunks' }}</button>
        <button class="btn small" :disabled="overlapTooBig" @click="rechunk(s)">Re-chunk with the settings above</button>
        <button class="btn small" @click="toggle(s)">{{ s.enabled ? 'Leave out of search' : 'Use in search' }}</button>
        <button class="btn small danger" @click="remove(s)">Delete</button>
      </div>
      <div v-if="opened?.id === s.id" style="margin-top: 10px">
        <div v-for="c in opened.chunks" :key="c.id" class="quote small" style="margin-bottom: 6px">
          <div class="muted">#{{ c.ord + 1 }} · {{ c.word_count }} words<template v-if="c.heading"> · {{ c.heading }}</template></div>
          <div style="white-space: pre-wrap">{{ c.content }}</div>
        </div>
      </div>
    </div>
  </template>

  <!-- Website -->
  <template v-if="tab === 'website'">
    <div class="card">
      <div class="card-head">
        <h2>Your website</h2>
        <RouterLink class="btn small" to="/settings">Edit links in Settings</RouterLink>
      </div>
      <p class="muted small" style="margin-top: 0">
        The agent reads the links you add in Settings → Knowledge (and pages they link to on the same site, up to your page limit), following robots.txt.
        It fetches web pages, so it runs while the agent is running. Unchanged pages keep their chunks.
      </p>
      <div class="btn-row"><button class="btn primary" @click="readWebsites()">Read website now</button></div>
      <div v-if="status?.lastWebsiteRead" class="small" style="margin-top: 10px">
        <div class="muted">Last read {{ fmtDate(status.lastWebsiteRead.at) }}:</div>
        <ul class="list">
          <li v-for="r in status.lastWebsiteRead.results" :key="r.link">
            <strong>{{ r.link }}</strong>:
            <span v-if="r.error" style="color: var(--danger)">{{ r.error }}</span>
            <template v-else>{{ r.pages }} page(s) fetched, {{ r.changed }} new or changed, {{ r.unchanged }} unchanged, {{ r.skipped.length }} skipped</template>
            <details v-if="r.skipped.length"><summary class="muted">Skipped pages</summary>
              <div v-for="s in r.skipped" :key="s.url" class="muted">{{ s.url }}: {{ s.why }}</div>
            </details>
          </li>
        </ul>
      </div>
    </div>
    <div v-if="!sites.length" class="card muted">No pages read yet.</div>
    <div v-for="site in sites" :key="site.root" class="card">
      <div class="card-head">
        <div><strong>{{ site.root }}</strong><div class="muted small">{{ site.pages.length }} page(s)</div></div>
        <div class="btn-row">
          <button class="btn small" @click="readWebsites(site.root)">Read again</button>
          <button class="btn small danger" @click="removeSite(site.root, site.pages.length)">Delete pages</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Page</th><th>Chunks</th><th>Read</th><th></th></tr></thead>
          <tbody>
            <tr v-for="p in site.pages" :key="p.id" :style="{ opacity: p.enabled ? 1 : 0.6 }">
              <td><a :href="p.origin ?? '#'" target="_blank" rel="noopener noreferrer">{{ p.title }}</a><div class="muted small">{{ p.origin }}</div></td>
              <td class="small nowrap">{{ p.chunk_count }}<template v-if="status?.vector"> ({{ p.embedded }} ready)</template></td>
              <td class="small nowrap">{{ fmtDate(p.fetched_at) }}</td>
              <td class="nowrap">
                <button class="btn small" @click="open(p)">{{ opened?.id === p.id ? 'Hide' : 'Chunks' }}</button>
                <button class="btn small" @click="toggle(p)">{{ p.enabled ? 'Leave out' : 'Use' }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="opened && opened.site_root === site.root" style="margin-top: 10px">
        <div class="muted small">{{ opened.title }}</div>
        <div v-for="c in opened.chunks" :key="c.id" class="quote small" style="margin-bottom: 6px">
          <div class="muted">#{{ c.ord + 1 }} · {{ c.word_count }} words<template v-if="c.heading"> · {{ c.heading }}</template></div>
          <div style="white-space: pre-wrap">{{ c.content }}</div>
        </div>
      </div>
    </div>
  </template>

  <!-- Search -->
  <template v-if="tab === 'search'">
    <div class="card">
      <div class="card-head"><h2>Search your knowledge</h2><span class="muted small">{{ searchModeText }}</span></div>
      <p class="muted small" style="margin-top: 0">The same search the agent uses for Inbox suggestions and for AI drafting.</p>
      <form class="btn-row" @submit.prevent="search">
        <input v-model="q" style="flex: 1" placeholder="e.g. Can my staff record sales without seeing profit?" />
        <button class="btn primary" :disabled="!q.trim() || searching">{{ searching ? 'Searching…' : 'Search' }}</button>
      </form>
    </div>
    <template v-if="results">
      <div v-if="!results.hits.length" class="card muted">Nothing matches. Add a document or page that covers it.</div>
      <div v-for="(h, i) in results.hits" :key="h.chunkId" class="card">
        <div class="card-head" style="margin-bottom: 4px">
          <div>
            <strong>{{ i + 1 }}. {{ h.title }}</strong><span v-if="h.heading" class="muted small"> · {{ h.heading }}</span>
            <div class="muted small">{{ kindLabel[h.kind] }}<template v-if="h.origin"> · {{ h.origin }}</template></div>
          </div>
          <span class="muted small">
            found by {{ h.matchedBy.join(' + ') }}<template v-if="h.similarity !== null"> · similarity {{ h.similarity.toFixed(2) }}</template>
          </span>
        </div>
        <div class="small" style="white-space: pre-wrap">{{ h.content }}</div>
      </div>
    </template>
  </template>
</template>
