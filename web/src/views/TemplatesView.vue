<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api, CHANNELS, channelLabel, getOptions, run, toast, type Channel, type Options } from '../api';

interface Template { id: number; name: string; channel: Channel; step: string; category: string | null; subject: string | null; body: string; active: boolean; versions?: number }
type Form = Omit<Template, 'id'> & { id?: number };

const templates = ref<Template[]>([]);
const placeholders = ref<Record<string, string>>({});
const options = ref<Options | null>(null);
const editing = ref<Form | null>(null);
const preview = reactive<{ subject: string | null; body: string; missing: string[]; lead: string; versions: number } | Record<string, never>>({});

async function load() {
  const res = await api<{ data: Template[]; placeholders: Record<string, string> }>('/templates').catch(() => null);
  if (res) {
    templates.value = res.data;
    placeholders.value = res.placeholders;
  }
}
onMounted(async () => {
  options.value = await getOptions().catch(() => null);
  await load();
});

const blank = (): Form => ({ name: '', channel: 'email', step: 'intro', category: null, subject: '', body: '', active: true });
function edit(t?: Template) {
  editing.value = t ? { ...t } : blank();
  Object.keys(preview).forEach((k) => delete (preview as Record<string, unknown>)[k]);
}
async function save() {
  const f = editing.value!;
  const body = { name: f.name, channel: f.channel, step: f.step, category: f.category || null, subject: f.channel === 'email' ? f.subject : null, body: f.body, active: f.active };
  const ok = await run(() => (f.id ? api(`/templates/${f.id}`, { method: 'PUT', body }) : api('/templates', { method: 'POST', body })), 'Template saved');
  if (ok) {
    editing.value = null;
    await load();
  }
}
async function doPreview() {
  const f = editing.value!;
  const res = await run(() =>
    api<{ subject: string | null; body: string; missing: string[]; lead: { business_name: string }; versions: number }>('/templates/preview', {
      method: 'POST',
      body: { subject: f.channel === 'email' ? f.subject : null, body: f.body, channel: f.channel, step: f.step },
    }),
  );
  if (res) Object.assign(preview, { subject: res.subject, body: res.body, missing: res.missing, lead: res.lead.business_name, versions: res.versions });
}
async function addStarters() {
  const res = await run(() => api<{ added: number }>('/templates/starter-variants', { method: 'POST' }));
  if (!res) return;
  toast(res.added ? `${res.added} variant(s) added, switched off. Read each one and switch on the ones you like.` : 'All starter variants are already here.');
  await load();
}
const catLabel = (id: string | null) => (id ? (options.value?.categories.find((c) => c.id === id)?.label ?? id) : 'Any category');
const stepLabel: Record<string, string> = { intro: 'Introduction', followup_1: 'Follow-up 1', followup_2: 'Follow-up 2' };
</script>

<template>
  <div class="page-head">
    <div>
      <h1>Templates</h1>
      <p>
        With several active templates for a step, the agent rotates them: the lead's category first, then the one used least in the last 24 hours.
        Every template needs a STOP opt-out line.
      </p>
    </div>
    <div class="btn-row">
      <button class="btn" title="Adds ready-written variants, switched off, for you to read" @click="addStarters">Add starter variants</button>
      <button class="btn primary" @click="edit()">New template</button>
    </div>
  </div>

  <div v-if="editing" class="card">
    <div class="card-head"><h2>{{ editing.id ? 'Edit template' : 'New template' }}</h2></div>
    <div class="grid grid-3" style="gap: 10px">
      <label class="field">Name<input v-model="editing.name" /></label>
      <label class="field">Channel
        <select v-model="editing.channel"><option v-for="c in CHANNELS" :key="c" :value="c">{{ channelLabel[c] }}</option></select>
      </label>
      <label class="field">Step
        <select v-model="editing.step"><option value="intro">Introduction</option><option value="followup_1">Follow-up 1</option><option value="followup_2">Follow-up 2</option></select>
      </label>
      <label class="field">Category
        <select v-model="editing.category"><option :value="null">Any category</option><option v-for="c in options?.categories" :key="c.id" :value="c.id">{{ c.label }}</option></select>
      </label>
      <label class="check" style="align-self: end"><input type="checkbox" v-model="editing.active" /> Active</label>
    </div>
    <label v-if="editing.channel === 'email'" class="field" style="margin-top: 10px">Subject<input v-model="editing.subject" /></label>
    <label class="field" style="margin-top: 10px">Message<textarea v-model="editing.body" rows="14" style="font-family: ui-monospace, monospace; font-size: 12px"></textarea></label>
    <details style="margin-top: 8px">
      <summary class="small">Placeholders you can use</summary>
      <dl class="kv small" style="margin-top: 8px">
        <template v-for="(desc, key) in placeholders" :key="key"><dt><code v-text="`{{${key}}}`"></code></dt><dd>{{ desc }}</dd></template>
      </dl>
    </details>
    <details style="margin-top: 4px">
      <summary class="small">Phrase alternatives, so messages don't all read the same</summary>
      <p class="small" style="margin: 8px 0 0">
        Write options in single braces separated by <code>|</code>, for example <code>{Hello|Good day|Hi}</code>: each draft picks one at random.
        They can't be nested. <code v-text="'{{personal_line}}'"></code> adds one sentence about the shop from verified details (its branches,
        where it sells online), and is left out when we know nothing specific. Press Preview a few times to see different versions.
      </p>
    </details>
    <div class="btn-row" style="margin-top: 12px">
      <button class="btn primary" @click="save">Save</button>
      <button class="btn" @click="doPreview">Preview with a real lead</button>
      <button class="btn" @click="editing = null">Cancel</button>
    </div>
    <div v-if="'body' in preview" class="card" style="margin-top: 12px; background: var(--surface-2)">
      <div class="muted small">Preview for {{ preview.lead }}<template v-if="preview.versions > 1"> · one of {{ preview.versions.toLocaleString() }} possible versions</template></div>
      <div v-if="preview.missing.length" class="banner warn" style="margin: 8px 0">Missing values: {{ preview.missing.join(', ') }}. Drafts with this template would be blocked until they're set.</div>
      <div v-if="preview.subject"><strong>{{ preview.subject }}</strong></div>
      <pre class="data" style="color: var(--fg); font-size: 13px">{{ preview.body }}</pre>
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr><th>Name</th><th>Channel</th><th>Step</th><th>Category</th><th>Status</th><th></th></tr></thead>
      <tbody>
        <tr v-for="t in templates" :key="t.id">
          <td>
            <strong>{{ t.name }}</strong><div v-if="t.subject" class="muted small">{{ t.subject }}</div>
            <div v-if="(t.versions ?? 1) > 1" class="muted small">{{ t.versions!.toLocaleString() }} phrasings</div>
          </td>
          <td>{{ channelLabel[t.channel] }}</td>
          <td>{{ stepLabel[t.step] }}</td>
          <td>{{ catLabel(t.category) }}</td>
          <td><span class="pill" :class="{ ok: t.active }">{{ t.active ? 'Active' : 'Off' }}</span></td>
          <td><button class="btn small" @click="edit(t)">Edit</button></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
