<template>
  <nav v-if="chapter" class="activity-reading-goals" :aria-label="chapter.title">
    <header class="activity-reading-summary">
      <strong><ChapterNumber :number="chapter.order_index"/> {{ chapter.title }}</strong>
      <div class="activity-reading-summary-line">
        <span>{{ required.length ? `必读 ${completedCount} / ${required.length} 份` : '本章资料均为选读' }}</span>
        <span v-if="required.length && completedCount === required.length">已完成</span>
      </div>
      <progress v-if="required.length" :value="completedCount" :max="required.length" aria-label="本章已完成必读资料"/>
    </header>
    <section v-for="task in tasks" :key="task.id" class="activity-reading-resource" :class="{'is-optional': !task.required}">
      <button class="activity-resource-heading" :aria-current="task.id === current ? 'page' : undefined" :disabled="task.locked" @click="select(task)">
        <GameIcon :name="task.completed ? 'check' : 'description'"/>
        <span class="activity-resource-title" :title="task.title">{{ task.title }}</span>
        <small>{{ task.required ? '必读' : '选读' }}</small>
        <GameIcon v-if="task.id !== current" name="arrowRight"/>
      </button>
      <div class="activity-resource-progress">
        <span>{{ task.total ? `${task.current} / ${task.total} ${task.unit}` : taskProgress(task) }}<template v-if="task.completed && task.total"> · 已完成</template></span>
        <progress v-if="task.total" :value="task.completed ? task.total : task.current" :max="task.total" :aria-label="task.title + '学习进度'"/>
      </div>
      <details v-if="readingRequirement(task)" class="activity-resource-requirements">
        <summary>完成要求 <GameIcon name="chevronDown"/></summary>
        <p>{{ readingRequirement(task) }}</p>
      </details>
    </section>
  </nav>
</template>
<script setup lang="ts">
import ChapterNumber from "../shared/ChapterNumber.vue";
import {computed} from "vue";
import GameIcon from "../shared/GameIcon.vue";
import {useSession} from "../shared/session";
import {notify} from "../shared/api";
import {readingRequirement, taskProgress, type ChapterTask} from "../shared/chapterTasks";
const props = defineProps<{chapterId: number; current?: string}>();
const session = useSession();
const chapter = computed(() => session.taskChapters.find(c => c.id === props.chapterId));
const tasks = computed(() => chapter.value?.tasks.filter(t => t.kind === "reading") ?? []);
const required = computed(() => tasks.value.filter(task => task.required));
const completedCount = computed(() => required.value.filter(task => task.completed).length);
async function select(task: ChapterTask) {
  if (task.id === props.current || task.locked) return;
  try {
    await session.flushParticipation();
    if (task.material_id) session.replace({kind:"material", material_id:task.material_id, chapter_id:props.chapterId});
  } catch (error) {notify(error instanceof Error ? error.message : "进度保存失败，请重试。");}
}
</script>
