import { ref } from 'vue';
import { api } from './api';

export interface Status {
  agent: { state: 'stopped' | 'running' | 'paused' | 'stopping'; since: string; current: { id: number; type: string; startedAt: string } | null; working?: Array<{ id: number; type: string; startedAt: string }> };
  mode: 'research' | 'approval' | 'autonomous';
  emailSendingMode: 'dry_run' | 'live';
  leads: { total: number; byStatus: Record<string, number>; withEmail: number; withPhone: number };
  tasks: Record<string, number>;
  errors24h: number;
  recovery: { requeued: number; heldInterrupted: number; heldOverdue: number; at: string; wasRunningAtShutdown: boolean };
  outreach: Record<string, number | null>;
}

/** Shared, polled status for the sidebar and the overview. */
export const status = ref<Status | null>(null);

let timer: ReturnType<typeof setInterval> | null = null;
export async function refreshStatus() {
  try {
    status.value = await api<Status>('/status');
  } catch {
    /* the offline banner covers it */
  }
}
export function startStatusPolling() {
  if (timer) return;
  void refreshStatus();
  timer = setInterval(refreshStatus, 3000);
}
