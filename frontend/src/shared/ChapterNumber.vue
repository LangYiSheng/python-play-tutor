<template>
  <span v-if="number != null" class="chapter-number">第 {{ number }} 章</span>
</template>
<script setup lang="ts">
defineProps<{ number?: number }>();
</script>
<style scoped>
.chapter-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  flex-shrink: 0;
  padding: .2em .62em;
  border: 1px solid var(--chapter-badge-border, #c1ceb6);
  border-radius: 999px;
  background: var(--chapter-badge-bg, #e4ebdc);
  color: var(--chapter-badge-color, var(--game-forest, #284b43));
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
  font-size: .75rem;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 1.25;
  white-space: nowrap;
  text-shadow: none;
  vertical-align: middle;
}
</style>
