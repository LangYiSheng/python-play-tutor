<template>
  <span v-if="number != null" class="chapter-number" role="img" :aria-label="`第 ${number} 章`">{{ number }}</span>
</template>
<script setup lang="ts">
defineProps<{ number?: number }>();
</script>
<style scoped>
.chapter-number {
  display: inline-grid;
  place-items: center;
  vertical-align: .08em;
  min-width: 1.6em;
  min-height: 1.6em;
  padding-inline: .2em;
  border: 1px solid currentColor;
  border-radius: .3em;
  font-size: .8em;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 1;
}
</style>
