<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, run, taskLabel } from '../api';
import { refreshStatus, status } from '../status';

defineProps<{ compact?: boolean }>();
const busy = ref(false);
const state = computed(() => status.value?.agent.state ?? 'stopped');

const pill = computed(
  () =>
    ({
      running: { cls: 'ok', text: 'Running' },
      paused: { cls: 'warn', text: 'Paused' },
      stopping: { cls: 'warn', text: 'Stopping…' },
      stopped: { cls: '', text: 'Stopped' },
    })[state.value],
);

async function act(action: 'start' | 'pause' | 'resume' | 'stop') {
  busy.value = true;
  await run(() => api(`/agent/${action}`, { method: 'POST' }));
  await refreshStatus();
  busy.value = false;
}
</script>

<template>
  <div class="agent-controls" :class="{ compact }">
    <div class="btn-row" style="justify-content: space-between">
      <span class="pill" :class="pill.cls"><span class="dot" :class="{ live: state === 'running' }" />{{ pill.text }}</span>
      <span v-if="!compact && status?.agent.working?.length" class="muted small">
        Working on: {{ status.agent.working.map((w) => `${taskLabel[w.type] ?? w.type} #${w.id}`).join(', ') }}
      </span>
    </div>
    <div class="btn-row" style="margin-top: 8px">
      <button v-if="state === 'stopped'" class="btn primary" :class="{ small: compact }" :disabled="busy" @click="act('start')">Start</button>
      <button v-if="state === 'running'" class="btn" :class="{ small: compact }" :disabled="busy" @click="act('pause')">Pause</button>
      <button v-if="state === 'paused'" class="btn primary" :class="{ small: compact }" :disabled="busy" @click="act('resume')">Resume</button>
      <button v-if="state === 'running' || state === 'paused'" class="btn danger" :class="{ small: compact }" :disabled="busy" @click="act('stop')">Stop</button>
    </div>
  </div>
</template>
