<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ago, api, fmtDate, statusLabel, taskLabel } from '../api';
import { status } from '../status';
import AgentControls from '../components/AgentControls.vue';

interface TaskRow { id: number; type: string; status: string; run_at: string; lead_name: string | null; review_reason: string | null; last_error: string | null }
interface LogRow { id: number; at: string; level: string; scope: string; message: string }
interface Usage { month: Array<{ provider: string; kind: string; calls: number; units: number; usd: string }>; monthTotalUsd: string }

const upcoming = ref<TaskRow[]>([]);
const review = ref<TaskRow[]>([]);
const errors = ref<LogRow[]>([]);
const usage = ref<Usage | null>(null);

async function load() {
  const [p, r, e, u] = await Promise.allSettled([
    api<{ data: TaskRow[] }>('/tasks?status=pending'),
    api<{ data: TaskRow[] }>('/tasks?status=needs_review'),
    api<{ data: LogRow[] }>('/logs?level=warn&limit=8'),
    api<Usage>('/usage'),
  ]);
  if (p.status === 'fulfilled') upcoming.value = p.value.data.slice(0, 8);
  if (r.status === 'fulfilled') review.value = r.value.data;
  if (e.status === 'fulfilled') errors.value = e.value.data;
  if (u.status === 'fulfilled') usage.value = u.value;
}
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void load();
  timer = setInterval(load, 5000);
});
onUnmounted(() => clearInterval(timer));

const s = computed(() => status.value);
const recoveryNote = computed(() => {
  const r = s.value?.recovery;
  if (!r) return null;
  const parts: string[] = [];
  if (r.wasRunningAtShutdown) parts.push('The agent was running when the app last closed. It stays stopped until you press Start.');
  if (r.requeued) parts.push(`${r.requeued} interrupted task(s) were safe to repeat and are queued again.`);
  if (r.heldInterrupted + r.heldOverdue) parts.push(`${r.heldInterrupted + r.heldOverdue} task(s) are held for your review.`);
  return parts.length ? parts.join(' ') : null;
});
const modeText: Record<string, string> = {
  research: 'Research: discovers and qualifies leads only.',
  approval: 'Approval: nothing is sent without your approval.',
  autonomous: 'Controlled autonomous: approved sequences send within limits.',
};
</script>

<template>
  <div class="page-head">
    <div>
      <h1>Overview</h1>
      <p>Online tasks only run while this laptop is on, connected, and the agent is running.</p>
    </div>
  </div>

  <div v-if="recoveryNote" class="banner info">
    {{ recoveryNote }} <RouterLink v-if="review.length" to="/tasks">Review tasks</RouterLink>
  </div>

  <div class="grid grid-2" style="margin-bottom: 16px">
    <div class="card">
      <div class="card-head"><h2>Agent</h2><span class="muted small" v-if="s">since {{ fmtDate(s.agent.since) }}</span></div>
      <AgentControls />
      <p class="muted small" style="margin: 12px 0 0">
        Pause finishes the current task and takes no new ones. Stop interrupts it; safe tasks go back to the queue, others wait for your review.
      </p>
    </div>
    <div class="card">
      <div class="card-head">
        <h2>Operating mode</h2>
        <RouterLink to="/settings" class="small">Change</RouterLink>
      </div>
      <span class="pill primary" v-if="s">{{ s.mode === 'approval' ? 'Approval Mode' : s.mode === 'research' ? 'Research Mode' : 'Controlled Autonomous' }}</span>
      <p class="muted" style="margin: 10px 0 0" v-if="s">{{ modeText[s.mode] }}</p>
      <p class="muted small" style="margin: 6px 0 0">The agent only drafts. You approve every message. Approved emails go out within your sending limits; you send WhatsApp messages yourself.</p>
    </div>
  </div>

  <h2 style="margin: 8px 0 10px">Pipeline</h2>
  <div class="stats" v-if="s">
    <div class="stat"><div class="label">Leads discovered</div><div class="value">{{ s.leads.total }}</div><div class="hint">{{ s.leads.withEmail }} with email · {{ s.leads.withPhone }} with phone</div></div>
    <div class="stat"><div class="label">Qualified</div><div class="value">{{ s.leads.byStatus.qualified ?? 0 }}</div><div class="hint">{{ s.leads.byStatus.unqualified ?? 0 }} not qualified</div></div>
    <div class="stat"><div class="label">Do not contact</div><div class="value">{{ s.leads.byStatus.do_not_contact ?? 0 }}</div></div>
    <RouterLink to="/approval" class="stat" style="color: inherit; text-decoration: none">
      <div class="label">Awaiting approval</div><div class="value">{{ s.outreach.awaitingApproval ?? 0 }}</div>
      <div class="hint">{{ s.outreach.approvedWaiting ?? 0 }} approved, not yet sent</div>
    </RouterLink>
    <div class="stat"><div class="label">Messages sent</div><div class="value">{{ s.outreach.sent ?? 0 }}</div><div class="hint">{{ s.outreach.dryRuns ?? 0 }} dry runs · email is {{ s.emailSendingMode === 'live' ? 'live' : 'in dry run' }}</div></div>
    <RouterLink to="/inbox" class="stat" style="color: inherit; text-decoration: none">
      <div class="label">Replies · interested</div><div class="value">{{ s.outreach.replies ?? 0 }} · {{ s.outreach.interested ?? 0 }}</div>
      <div class="hint">{{ s.outreach.needsAttention ?? 0 }} need you · mailbox {{ s.outreach.readReplies ? 'read' : 'not read (off)' }}</div>
    </RouterLink>
    <div class="stat"><div class="label">Demos booked</div><div class="value">{{ s.outreach.demosBooked ?? 0 }}</div><div class="hint">Leads marked “Demo booked”</div></div>
    <div class="stat muted"><div class="label">Registrations · activated</div><div class="value">Not verifiable yet</div><div class="hint">Needs an authorised StockỌja integration</div></div>
  </div>

  <div class="grid grid-2" style="margin-top: 16px">
    <div class="card">
      <div class="card-head"><h2>Task queue</h2><RouterLink to="/tasks" class="small">All tasks</RouterLink></div>
      <div class="btn-row" v-if="s" style="margin-bottom: 10px">
        <span class="pill info">{{ s.tasks.pending ?? 0 }} waiting</span>
        <span class="pill ok">{{ s.tasks.running ?? 0 }} running</span>
        <span class="pill warn">{{ s.tasks.needs_review ?? 0 }} need review</span>
        <span class="pill danger">{{ s.tasks.failed ?? 0 }} failed</span>
      </div>
      <ul class="list" v-if="review.length || upcoming.length">
        <li v-for="t in review.slice(0, 4)" :key="`r${t.id}`">
          <span class="pill warn">{{ statusLabel[t.status] }}</span> {{ taskLabel[t.type] ?? t.type }} #{{ t.id }}
          <div class="muted small">{{ t.review_reason }}</div>
        </li>
        <li v-for="t in upcoming" :key="t.id">
          {{ taskLabel[t.type] ?? t.type }} #{{ t.id }}<span v-if="t.lead_name" class="muted"> · {{ t.lead_name }}</span>
          <div class="muted small">due {{ fmtDate(t.run_at) }}<span v-if="t.last_error"> · last error: {{ t.last_error }}</span></div>
        </li>
      </ul>
      <p v-else class="muted">Nothing queued. Start a search from <RouterLink to="/discovery">Discovery</RouterLink>.</p>
      <p class="muted small" style="margin: 10px 0 0">Scheduled follow-ups show here with their due date. They become drafts for your approval.</p>
    </div>
    <div class="card">
      <div class="card-head"><h2>Recent warnings and errors</h2><RouterLink to="/logs" class="small">Logs</RouterLink></div>
      <ul class="list" v-if="errors.length">
        <li v-for="l in errors" :key="l.id">
          <span class="pill" :class="l.level === 'error' ? 'danger' : 'warn'">{{ l.level }}</span>
          <span class="small"> {{ l.message }}</span>
          <div class="muted small">{{ l.scope }} · {{ ago(l.at) }}</div>
        </li>
      </ul>
      <p v-else class="muted">No warnings or errors.</p>
    </div>
  </div>

  <div class="card" style="margin-top: 16px" v-if="usage">
    <div class="card-head"><h2>Usage this month</h2><span class="pill">Estimated spend ${{ usage.monthTotalUsd }}</span></div>
    <table v-if="usage.month.length">
      <thead><tr><th>Service</th><th>Kind</th><th class="num">Calls</th><th class="num">Units</th><th class="num">Est. USD</th></tr></thead>
      <tbody>
        <tr v-for="u in usage.month" :key="u.provider + u.kind">
          <td>{{ u.provider }}</td><td>{{ u.kind }}</td><td class="num">{{ u.calls }}</td><td class="num">{{ u.units }}</td><td class="num">{{ u.usd }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="muted">No external calls yet this month.</p>
    <p class="muted small" style="margin: 10px 0 0">Everything used so far is free. Paid services (AI drafting, extra email volume) will show their estimated cost here once added, and need your approval first.</p>
  </div>
</template>
