<script setup lang="ts">
/** One settings section: its changes stay local until you press Save; Cancel puts back what is saved. */
defineProps<{ title: string; dirty?: boolean; saving?: boolean; id?: string }>();
defineEmits<{ save: []; cancel: [] }>();
</script>

<template>
  <section :id="id" class="card settings-section" :class="{ dirty }">
    <div class="card-head">
      <div class="btn-row">
        <h2>{{ title }}</h2>
        <slot name="badge" />
      </div>
      <div class="btn-row">
        <slot name="actions" />
        <template v-if="dirty">
          <span class="muted small">Unsaved changes</span>
          <button class="btn" :disabled="saving" @click="$emit('cancel')">Cancel</button>
          <button class="btn primary" :disabled="saving" @click="$emit('save')">{{ saving ? 'Saving…' : 'Save' }}</button>
        </template>
      </div>
    </div>
    <slot />
  </section>
</template>
