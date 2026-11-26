<template>
  <section class="town-workspace">
    <div class="town-book">
      <aside class="town-sidebar"><nav class="town-directory" aria-label="章节目录">
        <button class="town-directory-item" :class="{ 'is-current': !selected }" @click="selected = 0">全部章节</button>
        <button v-for="chapter in chapters" :key="chapter.id" class="town-directory-item" :class="{ 'is-current': selected === chapter.id }" @click="selected = chapter.id">{{ chapter.title }}</button>
      </nav></aside>
      <main class="town-content"><section v-for="chapter in chapters.filter(c => !selected || c.id === selected)" :key="chapter.id" class="town-section task-group">
        <h3 class="game-card-title">{{ chapter.title }}</h3>
        <button v-for="task in chapter.tasks" :key="task.id" :disabled="task.locked" class="town-directory-item task-row" @click="start(task)">
          <span>{{ task.title }}</span><small>{{ task.required ? '必做' : '选做' }} · {{ taskProgress(task) }}</small>
        </button>
      </section><p v-if="!chapters.length" class="town-empty">暂时没有发布{{ taskRoles[category].label }}。</p></main>
    </div>
  </section>
</template>
<script setup lang="ts">
import {computed, ref} from "vue";
import {useSession} from "../shared/session";
import {taskProgress, taskRoles, type ChapterTask, type TaskKind} from "../shared/chapterTasks";
const props = defineProps<{category: Exclude<TaskKind, "reading">}>();
const session = useSession(), selected = ref(0);
const chapters = computed(() => session.taskChapters.map(chapter => ({...chapter, tasks: chapter.tasks.filter(t => t.kind === props.category)})).filter(c => c.tasks.length));
function start(task: ChapterTask) { if (task.activity_id && !task.locked) session.navigate({kind:"practice",activity_id:task.activity_id}); }
</script>
<style scoped>
.task-group { margin-bottom: 12px; }
.task-row { width:100%; display:flex; align-items:center; justify-content:space-between; gap:12px; text-align:left; margin-top:8px; }
.task-row small {color:var(--game-muted);}
</style>
