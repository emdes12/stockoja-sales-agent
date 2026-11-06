<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import { api, fmtDate, qs, run, toast } from '../api';

interface Row { id: number; kind: string; value: string; reason: string | null; source: string; lead_id: number | null; business_name: string | null; created_at: string; lifted_at: string | null; lift_reason: string | null }
const rows = ref<Row[]>([]);
const showLifted = ref(false);
const form = reactive({ kind: 'email', value: '', reason: '' });

async function load() {
  const res = await api<{ data: Row[] }>(`/suppressions${qs({ lifted: showLifted.value ? 1 : undefined })}`).catch(() => null);
  if (res) rows.value = res.data;
}
onMounted(load);
watch(showLifted, load);

async function add() {
  const res = await run(() => api<{ cancelledMessages: number }>('/suppressions', { method: 'POST', body: { ...form, reason: form.reason || null } }));
  if (res) {
    toast(`Added${res.cancelledMessages ? `; ${res.cancelledMessages} open message(s) cancelled` : ''}`);
    form.value = '';
    form.reason = '';
    await load();
  }
}
async function lift(r: Row) {
  const warning = r.source === 'reply_stop' ? 'They asked not to be contacted. Only lift this if they have since asked to hear from you.\n\n' : '';
  const reason = prompt(`${warning}Why lift the block on ${r.value}?`);
  if (!reason?.trim()) return;
  if (await run(() => api(`/suppressions/${r.id}/lift`, { method: 'POST', body: { reason } }), 'Block lifted')) await load();
}
const sourceLabel: Record<string, string> = { user: 'Added by you', do_not_contact: 'Lead marked do not contact', reply_stop: 'Replied STOP', bounce: 'Email bounced' };
</script>

<template>
  <div class="page-head">
    <div>
      <h1>Do-not-contact list</h1>
      <p>Checked before every draft, approval and send, even if the business is found again from another source.</p>
    </div>
    <label class="check small"><input type="checkbox" v-model="showLifted" /> Show lifted entries</label>
  </div>

  <div class="card">
    <form class="btn-row" @submit.prevent="add">
      <select v-model="form.kind" aria-label="Type"><option value="email">Email</option><option value="phone">Phone</option><option value="domain">Domain</option><option value="handle">Social account</option></select>
      <input v-model="form.value" required :placeholder="{ email: 'name@example.com', phone: '0803 123 4567', domain: 'example.com', handle: 'instagram:@name, or a profile link' }[form.kind]" style="flex: 1 1 200px" />
      <input v-model="form.reason" placeholder="Reason (optional)" style="flex: 1 1 200px" />
      <button class="btn primary" type="submit">Add</button>
    </form>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr><th>Type</th><th>Value</th><th>Why</th><th>Lead</th><th>Added</th><th></th></tr></thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id" :style="{ opacity: r.lifted_at ? 0.55 : 1 }">
          <td>{{ r.kind }}</td>
          <td><strong>{{ r.value }}</strong></td>
          <td class="small">{{ sourceLabel[r.source] ?? r.source }}<div v-if="r.reason" class="muted">{{ r.reason }}</div></td>
          <td class="small"><RouterLink v-if="r.lead_id" :to="`/leads/${r.lead_id}`">{{ r.business_name }}</RouterLink><span v-else>—</span></td>
          <td class="small nowrap">{{ fmtDate(r.created_at) }}</td>
          <td class="small">
            <span v-if="r.lifted_at" class="muted">Lifted {{ fmtDate(r.lifted_at) }}: {{ r.lift_reason }}</span>
            <button v-else class="btn small" @click="lift(r)">Lift</button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="!rows.length" class="empty">The list is empty.</div>
  </div>
</template>
