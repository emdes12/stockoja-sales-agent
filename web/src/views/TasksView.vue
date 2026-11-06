<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { api, fmtDate, qs, run, statusLabel, taskLabel } from '../api';

interface TaskRow {
  id: number; type: string; payload: Record<string, unknown>; status: string; run_at: string; attempts: number; max_attempts: number;
  last_error: string | null; review_reason: string | null; lead_id: number | null; lead_name: string | null; updated_at: string; finished_at: string | null;
}
const tasks = ref<TaskRow[]>([]);
const filter = ref('');

async function load() {
  const res = await api<{ data: TaskRow[] }>(`/tasks${qs({ status: filter.value })}`).catch(() => null);
  if (res) tasks.value = res.data;
}
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void load();
  timer = setInterval(load, 3000);
});
onUnmounted(() => clearInterval(timer));
watch(filter, load);

async function act(t: TaskRow, action: 'retry' | 'cancel') {
  if (await run(() => api(`/tasks/${t.id}/${action}`, { method: 'POST' }), action === 'retry' ? 'Task queued again' : 'Task cancelled')) await load();
}
const cls: Record<string, string> = { pending: 'info', running: 'ok', needs_review: 'warn', failed: 'danger', done: '', cancelled: '' };
const describe = (t: TaskRow) => {
  const p = t.payload as { category?: string; region?: string };
  if (t.type === 'discovery.osm') return `${p.category} · ${p.region}`;
  return t.lead_name ?? '';
};
</script>

<template>
  <div class="page-head">
    <div>
      <h1>Tasks</h1>
      <p>The agent's queue, saved in the database. Tasks only run while the app is open and the agent is running.</p>
    </div>
    <select v-model="filter" aria-label="Filter by status">
      <option value="">All</option>
      <option value="needs_review">Needs review</option>
      <option value="pending">Waiting</option>
      <option value="running">Running</option>
      <option value="failed">Failed</option>
      <option value="done">Done</option>
      <option value="cancelled">Cancelled</option>
    </select>
  </div>

  <div class="banner info" v-if="tasks.some((t) => t.status === 'needs_review')">
    “Needs review” tasks were interrupted or found overdue when the app started. They are not run until you choose Retry.
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr><th>#</th><th>Task</th><th>Status</th><th>Due / updated</th><th class="num">Attempts</th><th></th></tr></thead>
      <tbody>
        <tr v-for="t in tasks" :key="t.id">
          <td class="muted">{{ t.id }}</td>
          <td>
            {{ taskLabel[t.type] ?? t.type }}
            <div class="muted small">
              <RouterLink v-if="t.lead_id" :to="`/leads/${t.lead_id}`">{{ describe(t) }}</RouterLink><span v-else>{{ describe(t) }}</span>
            </div>
          </td>
          <td>
            <span class="pill" :class="cls[t.status]">{{ statusLabel[t.status] }}</span>
            <div v-if="t.review_reason || t.last_error" class="muted small" style="max-width: 420px">{{ t.review_reason ?? t.last_error }}</div>
          </td>
          <td class="small nowrap">
            <div v-if="t.status === 'pending'">due {{ fmtDate(t.run_at) }}</div>
            <div class="muted">updated {{ fmtDate(t.updated_at) }}</div>
          </td>
          <td class="num">{{ t.attempts }}/{{ t.max_attempts }}</td>
          <td class="nowrap">
            <div class="btn-row">
              <button v-if="['needs_review', 'failed', 'cancelled'].includes(t.status)" class="btn small" @click="act(t, 'retry')">Retry</button>
              <button v-if="['pending', 'needs_review', 'failed'].includes(t.status)" class="btn small danger" @click="act(t, 'cancel')">Cancel</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="!tasks.length" class="empty">No tasks{{ filter ? ' with this status' : '' }}.</div>
  </div>
</template>
