<template>
  <section class="library-chapter" :aria-labelledby="headingId">
    <header class="library-chapter-heading">
      <h3 :id="headingId" class="game-card-title"><GameIcon name="book"/>{{ title }}</h3>
      <span v-if="summary">{{ summary }}</span>
    </header>
    <div class="library-list"><slot/></div>
  </section>
</template>
<script setup lang="ts">
import GameIcon from "../shared/GameIcon.vue";
defineProps<{title:string; headingId:string; summary?:string}>();
</script>
<style scoped>
.library-chapter { margin-bottom:20px; }
.library-chapter-heading { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:10px; padding-bottom:8px; margin-bottom:12px; border-bottom:1px solid #d9c9ad; }
.library-chapter-heading h3 { margin:0; color:#3b5147; font-size:.875rem; line-height:1.5; }
.library-chapter-heading > span { flex-shrink:0; color:#8a775c; font-size:.875rem; }
.library-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,270px),1fr)); gap:10px; }
@media(max-width:700px) { .library-list { grid-template-columns:minmax(0,1fr); } }
</style>
