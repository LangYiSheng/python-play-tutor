<template>
  <button type="button" class="library-card" :class="{ 'is-complete': completed, 'is-disabled': disabled }" :disabled="disabled">
    <span class="library-material-icon" :class="{ 'is-video': icon === 'video', 'is-complete': completed }" aria-hidden="true">
      <GameIcon :name="completed ? 'check' : icon"/>
    </span>
    <span class="library-card-copy">
      <span class="library-card-title">
        <span v-if="badge" class="required-label">{{ badge }}</span>
        <strong>{{ title }}</strong>
      </span>
      <small><slot/></small>
      <progress v-if="progress && progress.max > 0" class="support-progress-bar card-progress-bar" :value="progress.value" :max="progress.max" :aria-label="progress.label" />
    </span>
    <span class="library-card-footer">
      <span v-if="completed" class="card-done-pill"><GameIcon name="check" />已完成</span>
      <span class="library-card-action">{{ action }}<GameIcon v-if="!disabled" name="arrowRight"/></span>
    </span>
  </button>
</template>
<script setup lang="ts">
import GameIcon from "../shared/GameIcon.vue";
export interface CardProgress {
  value: number;
  max: number;
  label: string;
}
defineProps<{
  title: string;
  badge?: string;
  action: string;
  disabled: boolean;
  completed?: boolean;
  progress?: CardProgress;
  icon: "video" | "book" | "practice" | "code" | "journal";
}>();
</script>
<style scoped>
button.library-card { display:grid; grid-template-columns:36px minmax(0,1fr); gap:10px 12px; align-items:start; min-height:118px; padding:14px; text-align:left; color:#31473d; border:1px solid #d5c3a3; border-radius:var(--game-radius); background:var(--game-paper-raised); box-shadow:none; transition:border-color .14s, background-color .14s; }
button.library-card:hover:not(:disabled) { background:#fffdf7; border-color:var(--game-forest); }
button.library-card.is-complete { background:#eef3e7; border-color:#bfd0b1; }
button.library-card.is-complete:hover:not(:disabled) { background:#e7efe0; border-color:var(--game-forest); }
button.library-card.is-disabled { background:#f3eee3; border-color:#ddd2bc; }
.library-material-icon { display:grid; place-items:center; width:36px; height:36px; background:#e1e8d7; border:1px solid #c1cdb2; border-radius:8px; color:var(--game-forest); }
.library-material-icon.is-video { color:#9b7143; background:#f0dfbe; border-color:#d9c19a; }
.library-material-icon.is-complete { background:var(--game-forest); border-color:var(--game-forest); color:var(--game-paper-raised); }
.library-material-icon svg { width:18px; height:18px; }
.library-card-title { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 7px; }
.required-label { padding:1px 7px; border-radius:999px; background:var(--game-forest); color:var(--game-paper-raised); font-size:var(--game-caption-size); font-weight:600; line-height:1.4; }
.library-card-copy { display:flex; flex-direction:column; gap:6px; min-width:0; }
.library-card strong { font-size:.9375rem; line-height:1.5; color:#2b4137; overflow-wrap:anywhere; }
.library-card small { color:#7a6a52; font-size:var(--game-caption-size); line-height:1.5; }
.card-progress-bar { margin-top:2px; --support-bar-height:5px; --support-bar-track:#e2d7be; }
.library-card-footer { grid-column:1/-1; display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:auto; padding-top:6px; border-top:1px solid #e6dac2; }
.library-card.is-complete .library-card-footer { border-top-color:#cddbc1; }
.card-done-pill { display:inline-flex; align-items:center; gap:4px; color:var(--game-forest); font-size:var(--game-caption-size); font-weight:600; }
.card-done-pill svg { width:14px; height:14px; }
.library-card-action { margin-left:auto; display:inline-flex; align-items:center; gap:5px; color:var(--game-forest); font-size:.875rem; font-weight:600; }
.library-card.is-disabled .library-card-action { color:var(--game-muted); font-weight:500; }
.library-card-action svg { width:16px; height:16px; }
@media (prefers-reduced-motion: reduce) { button.library-card { transition:none; } }
:global(html[data-reduced-motion="true"]) button.library-card { transition:none; }
</style>
