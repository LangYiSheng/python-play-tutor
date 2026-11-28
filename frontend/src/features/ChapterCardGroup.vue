<template>
  <section class="library-chapter" :aria-labelledby="headingId">
    <header class="library-chapter-heading">
      <h3 :id="headingId" class="game-card-title"><ChapterNumber v-if="number != null" :number="number"/><GameIcon v-else name="book"/> <span>{{ title }}</span></h3>
      <div v-if="progress" class="chapter-group-progress" :class="{ 'is-complete': progress.completed }">
        <span class="chapter-group-progress-label"><GameIcon v-if="progress.completed" name="check" />{{ summary }}</span>
        <progress class="support-progress-bar" :value="progress.value" :max="progress.max" :aria-label="progress.label" />
      </div>
      <span v-else-if="summary" class="chapter-group-summary">{{ summary }}</span>
    </header>
    <div class="library-list"><slot/></div>
  </section>
</template>
<script setup lang="ts">
import ChapterNumber from "../shared/ChapterNumber.vue";
import GameIcon from "../shared/GameIcon.vue";
export interface ChapterGroupProgress {
  value: number;
  max: number;
  label: string;
  completed?: boolean;
}
defineProps<{title:string; number?:number; headingId:string; summary?:string; progress?: ChapterGroupProgress}>();
</script>
<style scoped>
.library-chapter { margin-bottom:24px; }
.library-chapter:last-child { margin-bottom:0; }
.library-chapter-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px 16px; padding-bottom:10px; margin-bottom:12px; border-bottom:1px solid #d9c9ad; }
.library-chapter-heading h3 { margin:0; color:var(--game-forest); font-size:.9375rem; line-height:1.5; }
.chapter-group-summary { flex-shrink:0; color:var(--game-muted); font-size:var(--game-caption-size); }
.chapter-group-progress { display:flex; align-items:center; gap:10px; flex-shrink:0; }
.chapter-group-progress-label { display:inline-flex; align-items:center; gap:4px; color:var(--game-muted); font-size:var(--game-caption-size); font-variant-numeric:tabular-nums; white-space:nowrap; }
.chapter-group-progress-label .game-icon { width:14px; height:14px; color:var(--game-forest); }
.chapter-group-progress.is-complete .chapter-group-progress-label { color:var(--game-forest); font-weight:600; }
.chapter-group-progress .support-progress-bar { width:112px; --support-bar-height:7px; }
.library-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,290px),1fr)); gap:12px; }
@media(max-width:700px) { .library-list { grid-template-columns:minmax(0,1fr); } .chapter-group-progress .support-progress-bar { width:92px; } }
</style>
