<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, connection, run, toasts } from './api';
import { refreshStatus, startStatusPolling, status } from './status';
import AgentControls from './components/AgentControls.vue';

onMounted(startStatusPolling);
const quitting = ref(false);

async function quit() {
  if (!confirm('Quit the sales agent? The agent stops, and the dashboard closes until you start it again.')) return;
  quitting.value = true;
  await run(() => api('/app/shutdown', { method: 'POST' }));
  setTimeout(refreshStatus, 800);
}
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">SA</div>
        <div>
          <strong>Sales Agent</strong>
          <small>StockỌja · local</small>
        </div>
      </div>
      <nav class="nav">
        <RouterLink to="/" exact-active-class="router-link-active">Overview</RouterLink>
        <RouterLink to="/leads">
          Leads <span v-if="status" class="pill">{{ status.leads.total }}</span>
        </RouterLink>
        <RouterLink to="/discovery">Discovery</RouterLink>
        <RouterLink to="/inbox">
          Inbox <span v-if="status?.outreach.needsAttention || status?.outreach.unmatched" class="pill warn">{{ (status?.outreach.needsAttention ?? 0) + (status?.outreach.unmatched ?? 0) }}</span>
        </RouterLink>
        <RouterLink to="/approval">
          Approval queue <span v-if="status?.outreach.awaitingApproval" class="pill info">{{ status.outreach.awaitingApproval }}</span>
        </RouterLink>
        <RouterLink to="/templates">Templates</RouterLink>
        <RouterLink to="/knowledge">Knowledge base</RouterLink>
        <RouterLink to="/do-not-contact">Do not contact</RouterLink>
        <RouterLink to="/tasks">
          Tasks
          <span v-if="status?.tasks.needs_review" class="pill warn">{{ status.tasks.needs_review }}</span>
        </RouterLink>
        <RouterLink to="/logs">
          Logs <span v-if="status?.errors24h" class="pill danger">{{ status.errors24h }}</span>
        </RouterLink>
        <RouterLink to="/settings">Settings</RouterLink>
      </nav>
      <div class="sidebar-foot">
        <AgentControls compact />
        <button class="btn small" :disabled="quitting || connection.down" @click="quit">Quit app</button>
      </div>
    </aside>
    <main>
      <div v-if="connection.down" class="banner danger">
        {{ quitting ? 'The sales agent has been shut down. Start it again with start-agent.bat.' : 'Cannot reach the sales agent. Is its window still open? Start it with start-agent.bat.' }}
      </div>
      <RouterView />
    </main>
  </div>
  <div class="toasts" aria-live="polite">
    <div v-for="t in toasts.items" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
  </div>
</template>
