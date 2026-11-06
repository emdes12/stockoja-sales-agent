<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { api, fmtDate, qs } from '../api';

interface LogRow { id: number; at: string; level: string; scope: string; message: string; data: unknown }
const logs = ref<LogRow[]>([]);
const level = ref('');
const scope = ref('');

async function load() {
  const res = await api<{ data: LogRow[] }>(`/logs${qs({ level: level.value, scope: scope.value, limit: 300 })}`).catch(() => null);
  if (res) logs.value = res.data;
}
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void load();
  timer = setInterval(load, 4000);
});
onUnmounted(() => clearInterval(timer));
watch([level, scope], load);
const cls: Record<string, string> = { error: 'danger', warn: 'warn', info: 'info' };
</script>

<template>
  <div class="page-head">
    <div>
      <h1>Logs</h1>
      <p>Kept for 30 days. Keys and passwords are removed; emails and phone numbers are partly masked.</p>
    </div>
    <div class="btn-row">
      <select v-model="level" aria-label="Level">
        <option value="">All levels</option>
        <option value="warn">Warnings and errors</option>
        <option value="error">Errors only</option>
      </select>
      <select v-model="scope" aria-label="Area">
        <option value="">All areas</option>
        <option value="agent">Agent</option>
        <option value="task:">Tasks</option>
        <option value="app">App</option>
        <option value="api">API</option>
      </select>
    </div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Time</th><th>Level</th><th>Area</th><th>Message</th></tr></thead>
      <tbody>
        <tr v-for="l in logs" :key="l.id">
          <td class="small nowrap muted">{{ fmtDate(l.at) }}</td>
          <td><span class="pill" :class="cls[l.level]">{{ l.level }}</span></td>
          <td class="small nowrap">{{ l.scope }}</td>
          <td class="small">{{ l.message }}<pre v-if="l.data" class="data">{{ JSON.stringify(l.data) }}</pre></td>
        </tr>
      </tbody>
    </table>
    <div v-if="!logs.length" class="empty">No log entries.</div>
  </div>
</template>
