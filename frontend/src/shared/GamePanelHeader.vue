<template>
  <header class="game-panel-header" :class="{ 'game-panel-header--tabs': tabs }">
    <component :is="heading ? 'h2' : 'div'" v-if="title" class="game-panel-header-label" :title="title">
      <GameIcon v-if="icon" :name="icon" />
      <span>{{ title }}</span>
    </component>
    <slot />
    <div v-if="$slots.actions || detail" class="game-panel-header-actions">
      <span v-if="detail" class="game-panel-header-detail" :title="detail">{{ detail }}</span>
      <slot name="actions" />
    </div>
  </header>
</template>
<script setup lang="ts">
import GameIcon from './GameIcon.vue';
defineProps<{
  title?: string;
  icon?: InstanceType<typeof GameIcon>['$props']['name'];
  heading?: boolean;
  tabs?: boolean;
  detail?: string;
}>();
</script>
<style>
.game-workspace .game-panel-header {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  min-width: 0;
  height: var(--game-panel-header-height, 2.25rem);
  min-height: var(--game-panel-header-height, 2.25rem);
  margin: 0;
  padding: 0 12px;
  border-bottom: 1px solid var(--game-line);
  background: #e9e5da;
  color: var(--game-forest);
  font-family: inherit;
  font-size: var(--game-label-size, .875rem);
  font-weight: 600;
  line-height: 1.25;
}
.game-workspace .game-panel-header-label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  font: inherit;
}
.game-workspace .game-panel-header-label > span,
.game-workspace .game-panel-header-detail,
.game-workspace .game-panel-header-tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.game-workspace .game-panel-header .game-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.game-workspace .game-panel-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-left: auto;
}
.game-workspace .game-panel-header-detail {
  color: var(--game-muted);
  font-size: .75rem;
  font-weight: 400;
}
.game-workspace .game-panel-header--tabs {
  gap: 14px;
}
.game-workspace .game-panel-header--tabs button:not(.sidebar-toggle) {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  height: calc(var(--game-panel-header-height, 2.25rem) - 1px);
  min-height: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--game-muted);
  font: inherit;
  white-space: nowrap;
}
.game-workspace .game-panel-header--tabs button:is([aria-selected="true"], [aria-pressed="true"]) {
  box-shadow: inset 0 -2px var(--game-forest);
  color: var(--game-forest);
  font-weight: 700;
}
@media (pointer: coarse) {
  .game-workspace .game-panel-header {
    --game-panel-header-height: max(45px, 2.25rem);
  }
}
</style>
