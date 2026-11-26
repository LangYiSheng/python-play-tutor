<template>
  <nav v-if="chapter" class="chapter-goals" :aria-label="chapter.title">
    <h4>{{ chapter.title }}</h4>
    <button v-for="task in tasks" :key="task.id" :disabled="task.locked || (task.id === current)" :aria-current="task.id === current ? 'step' : undefined" @click="select(task)">
      <strong>{{ task.title }}</strong><small>{{ task.kind === 'reading' ? task.required ? '必读' : '选读' : task.required ? '必做' : '选做' }} · {{ taskProgress(task) }}</small><small v-if="readingRequirement(task)">{{ readingRequirement(task) }}</small>
    </button>
  </nav>
</template>
<script setup lang="ts">
import {computed} from "vue";
import {useSession} from "../shared/session";
import {notify} from "../shared/api";
import {readingRequirement, taskProgress, type TaskKind, type ChapterTask} from "../shared/chapterTasks";
const props = defineProps<{chapterId: number; kind: TaskKind; current?: string}>();
const session = useSession();
const chapter = computed(() => session.taskChapters.find(c => c.id === props.chapterId));
const tasks = computed(() => chapter.value?.tasks.filter(t => t.kind === props.kind) ?? []);
async function select(task: ChapterTask) {
  try {
    await session.flushParticipation();
    if (task.kind === "reading" && task.material_id) session.replace({kind:"material", material_id:task.material_id, chapter_id:props.chapterId});
    else if (task.activity_id) session.replace({kind:"practice", activity_id:task.activity_id});
  } catch (error) {notify(error instanceof Error ? error.message : "进度保存失败，请重试。");}
}
</script>
<style scoped>
.chapter-goals {display:grid; gap:6px; margin-bottom:12px;}
.chapter-goals h4 {margin:0 0 6px;}
.chapter-goals button {display:grid; gap:4px; text-align:left;}
.chapter-goals button[aria-current] {border-color:var(--game-forest); opacity:1;}
.chapter-goals small {color:var(--game-muted);}
</style>
