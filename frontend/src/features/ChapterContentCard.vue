<template>
  <button type="button" class="library-card" :disabled="disabled">
    <span class="library-material-icon" :class="{ 'is-video':icon === 'video' }" aria-hidden="true"><GameIcon :name="icon"/></span>
    <span class="library-card-copy">
      <span class="library-card-title"><span v-if="badge" class="required-label">{{ badge }}</span><strong>{{ title }}</strong></span>
      <small><slot/></small>
    </span>
    <span class="library-card-action">{{ action }}<GameIcon v-if="!disabled" name="arrowRight"/></span>
  </button>
</template>
<script setup lang="ts">
import GameIcon from "../shared/GameIcon.vue";
defineProps<{title:string; badge?:string; action:string; disabled:boolean; icon:"video"|"book"|"practice"|"code"|"journal"}>();
</script>
<style scoped>
button.library-card { display:grid; grid-template-columns:32px minmax(0,1fr); gap:10px; align-items:start; min-height:112px; padding:12px; text-align:left; color:#354d42; border:1px solid #dbcbb1; border-radius:var(--game-radius); background:var(--game-paper-raised); box-shadow:none; }
button.library-card:hover:not(:disabled) { background:#fffdf5; border-color:#ad9972; box-shadow:none; }
.library-material-icon { display:grid; place-items:center; width:32px; height:36px; background:#e1e8d7; border:1px solid #c1cdb2; border-radius:7px; color:#5d7953; }
.library-material-icon.is-video { color:#9b7143; background:#f0dfbe; border-color:#d9c19a; }
.library-material-icon svg { width:18px; height:18px; }
.library-card-title { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 7px; }
.required-label { padding:1px 7px; border-radius:var(--game-control-radius); background:var(--game-forest); color:var(--game-paper-raised); font-size:var(--game-caption-size); font-weight:700; }
.library-card-copy { display:flex; flex-direction:column; gap:6px; min-width:0; }
.library-card strong { font-size:.9375rem; line-height:1.6; overflow-wrap:anywhere; }
.library-card small { color:#88775d; font-size:.875rem; line-height:1.5; }
.library-card .library-card-action { grid-column:1/-1; display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-top:auto; color:#6c7d57; font-size:.875rem; }
.library-card-action svg { width:18px; height:18px; }
</style>
