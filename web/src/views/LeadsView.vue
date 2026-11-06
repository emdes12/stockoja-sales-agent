<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, getOptions, qs, run, statusLabel, type Options } from '../api';

interface Lead {
  id: number; business_name: string; category: string; city: string | null; state: string | null; phone: string | null;
  email: string | null; website: string | null; socials: Record<string, string>; branch_count: number; is_chain_brand: boolean;
  source: string; score: number | null; status: string; status_set_by: string; discovered_at: string;
}

const route = useRoute();
const router = useRouter();
const options = ref<Options | null>(null);
const leads = ref<Lead[]>([]);
const meta = ref({ page: 1, pages: 1, total: 0, pageSize: 50 });
const loading = ref(false);

const f = reactive({
  q: String(route.query.q ?? ''),
  status: String(route.query.status ?? ''),
  category: String(route.query.category ?? ''),
  state: String(route.query.state ?? ''),
  contact: String(route.query.contact ?? ''),
  minScore: String(route.query.minScore ?? ''),
  sort: String(route.query.sort ?? 'score'),
  page: Number(route.query.page ?? 1),
});

const states = ref<string[]>([]);

async function load() {
  loading.value = true;
  const query = { ...f, page: f.page > 1 ? f.page : undefined, sort: f.sort === 'score' ? undefined : f.sort };
  await router.replace({ query: Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '' && v !== undefined)) });
  const res = await run(() => api<{ data: Lead[]; meta: typeof meta.value }>(`/leads${qs({ ...f, pageSize: 50 })}`));
  if (res) {
    leads.value = res.data;
    meta.value = res.meta;
  }
  loading.value = false;
}

let t: ReturnType<typeof setTimeout>;
watch(() => f.q, () => { clearTimeout(t); t = setTimeout(() => { f.page = 1; void load(); }, 300); });
watch(() => [f.status, f.category, f.state, f.contact, f.minScore, f.sort], () => { f.page = 1; void load(); });

onMounted(async () => {
  options.value = await getOptions().catch(() => null);
  states.value = [...new Set(options.value?.regions.map((r) => r.label.replace(/\s*\(.*\)$/, '')) ?? [])].sort();
  await load();
});

const catLabel = (id: string) => options.value?.categories.find((c) => c.id === id)?.label ?? id;
const scoreClass = (s: number | null) => (s === null ? 'low' : s >= 60 ? 'high' : s >= 40 ? 'mid' : 'low');
const statusClass: Record<string, string> = {
  qualified: 'ok', unqualified: '', discovered: 'info', archived: '', do_not_contact: 'danger', declined: 'danger',
  contacted: 'primary', replied: 'primary', interested: 'ok', demo_booked: 'ok', registered: 'ok', activated: 'ok',
};
const go = (p: number) => { f.page = p; void load(); };
</script>

<template>
  <div class="page-head">
    <div>
      <h1>Leads</h1>
      <p>{{ meta.total }} lead{{ meta.total === 1 ? '' : 's' }} match. Click one for its facts, assumptions and score.</p>
    </div>
    <RouterLink to="/discovery" class="btn primary">Find or add leads</RouterLink>
  </div>

  <div class="filters">
    <input v-model="f.q" type="search" placeholder="Search name, city, address, email, domain…" aria-label="Search leads" />
    <select v-model="f.status" aria-label="Status">
      <option value="">All statuses</option>
      <option v-for="s in options?.leadStatuses" :key="s" :value="s">{{ statusLabel[s] }}</option>
    </select>
    <select v-model="f.category" aria-label="Category">
      <option value="">All categories</option>
      <option v-for="c in options?.categories" :key="c.id" :value="c.id">{{ c.label }}</option>
    </select>
    <select v-model="f.state" aria-label="State">
      <option value="">All states</option>
      <option v-for="s in states" :key="s" :value="s">{{ s }}</option>
    </select>
    <select v-model="f.contact" aria-label="Contact">
      <option value="">Any contact info</option>
      <option value="email">Has email</option>
      <option value="phone">Has phone</option>
      <option value="any">Has some contact</option>
      <option value="none">No contact yet</option>
    </select>
    <select v-model="f.minScore" aria-label="Minimum score">
      <option value="">Any score</option>
      <option value="40">Score ≥ 40</option>
      <option value="50">Score ≥ 50</option>
      <option value="60">Score ≥ 60</option>
      <option value="70">Score ≥ 70</option>
    </select>
    <select v-model="f.sort" aria-label="Sort">
      <option value="score">Highest score</option>
      <option value="newest">Newest</option>
      <option value="name">Name A–Z</option>
    </select>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr><th class="num">Score</th><th>Business</th><th>Category</th><th>Location</th><th>Contact</th><th>Status</th><th>Source</th></tr>
      </thead>
      <tbody>
        <tr v-for="l in leads" :key="l.id" class="clickable" @click="router.push(`/leads/${l.id}`)">
          <td class="num"><span class="score" :class="scoreClass(l.score)">{{ l.score ?? '—' }}</span></td>
          <td>
            <RouterLink :to="`/leads/${l.id}`" @click.stop><strong>{{ l.business_name }}</strong></RouterLink>
            <div class="muted small" v-if="l.branch_count > 1 || l.is_chain_brand">
              {{ l.branch_count > 1 ? `${l.branch_count} locations` : '' }}{{ l.is_chain_brand ? ' · known brand' : '' }}
            </div>
          </td>
          <td class="nowrap">{{ catLabel(l.category) }}</td>
          <td>{{ [l.city, l.state].filter(Boolean).join(', ') || '—' }}</td>
          <td class="small">
            <div v-if="l.email">✉ {{ l.email }}</div>
            <div v-if="l.phone" class="nowrap">☎ {{ l.phone }}</div>
            <div v-if="l.website" class="muted">{{ l.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') }}</div>
            <div v-if="Object.keys(l.socials).length" class="muted">{{ Object.keys(l.socials).join(', ') }}</div>
            <span v-if="!l.email && !l.phone && !l.website && !Object.keys(l.socials).length" class="muted">None found</span>
          </td>
          <td>
            <span class="pill" :class="statusClass[l.status]">{{ statusLabel[l.status] }}</span>
            <div v-if="l.status_set_by === 'user'" class="muted small">set by you</div>
          </td>
          <td class="muted small">{{ l.source === 'osm' ? 'OpenStreetMap' : l.source === 'csv' ? 'CSV import' : 'Added by you' }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="!leads.length && !loading" class="empty">
      No leads yet. <RouterLink to="/discovery">Run a discovery search</RouterLink> or add some yourself.
    </div>
  </div>
  <div class="pager" v-if="meta.pages > 1">
    <button class="btn small" :disabled="meta.page <= 1" @click="go(meta.page - 1)">Previous</button>
    <span class="muted small">Page {{ meta.page }} of {{ meta.pages }}</span>
    <button class="btn small" :disabled="meta.page >= meta.pages" @click="go(meta.page + 1)">Next</button>
  </div>
</template>
