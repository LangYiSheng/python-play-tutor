<template>
  <section class="town-workspace">
    <div class="chapter-book">
      <aside class="chapter-index-panel">
        <GamePanelHeader :icon="categoryIcon" title="章节目录" />
        <div class="chapter-index-body">
          <nav class="town-directory" aria-label="章节目录">
            <button class="town-directory-item chapter-nav-card" :class="{ 'is-current': !selected }" :aria-pressed="!selected" @click="selected = 0">
              <span class="chapter-nav-head">
                <GameIcon name="grid" />
                <span class="chapter-nav-title">全部章节</span>
                <small class="chapter-nav-count">{{ totalTaskCount }} 项</small>
              </span>
            </button>
            <button v-for="chapter in chapters" :key="chapter.id" class="town-directory-item chapter-nav-card" :class="{ 'is-current': selected === chapter.id }" :aria-pressed="selected === chapter.id" @click="selected = chapter.id">
              <span class="chapter-nav-head">
                <ChapterNumber :number="chapter.order_index"/> <span class="chapter-nav-title">{{ chapter.title }}</span>
                <small class="chapter-nav-count">{{ chapter.tasks.length }} 项</small>
              </span>
              <span v-if="chapter.progress" class="chapter-nav-meta">
                <span class="chapter-nav-progress-text" :class="{ 'is-complete': chapter.progress.completed }">
                  <span>{{ chapter.summary }}</span>
                </span>
                <progress class="support-progress-bar" :value="chapter.progress.value" :max="chapter.progress.max" :aria-label="chapter.progress.label" />
              </span>
            </button>
          </nav>
        </div>
      </aside>
      <section class="chapter-main-panel">
        <GamePanelHeader :icon="categoryIcon" :title="activeChapterTitle">
          <template #actions>
            <span class="chapter-panel-count">{{ visibleTaskCount }} 项</span>
          </template>
        </GamePanelHeader>
        <main class="chapter-main-body town-content activity-list-content">
          <ChapterCardGroup v-for="chapter in visibleChapters" :key="chapter.id"
            :number="chapter.order_index" :title="chapter.title" :heading-id="`activities-chapter-${chapter.id}`"
            :summary="chapter.summary" :progress="chapter.progress">
            <ChapterContentCard v-for="task in chapter.tasks" :key="task.id" class="task-row" :title="task.title"
              :icon="categoryIcon"
              :badge="task.required ? '必做' : undefined"
              :completed="task.completed"
              :progress="cardProgress(task)"
              :disabled="task.locked" @click="start(task)"
              :action="task.locked ? '尚未解锁' : task.completed || task.handed_in ? '查看' : task.current ? '继续作答' : '开始作答'">
              {{ task.required ? '' : '选做 · ' }}{{ taskProgress(task) }}
            </ChapterContentCard>
          </ChapterCardGroup>
          <p v-if="!chapters.length" class="town-empty">暂时没有发布{{ taskRoles[category].label }}。</p>
        </main>
      </section>
    </div>
  </section>
</template>
<script setup lang="ts">
import ChapterNumber from "../shared/ChapterNumber.vue";
import ChapterCardGroup, { type ChapterGroupProgress } from "./ChapterCardGroup.vue";
import ChapterContentCard, { type CardProgress } from "./ChapterContentCard.vue";
import GamePanelHeader from "../shared/GamePanelHeader.vue";
import GameIcon from "../shared/GameIcon.vue";
import { computed, ref } from "vue";
import { useSession } from "../shared/session";
import { taskProgress, taskRoles, type ChapterTask, type TaskKind } from "../shared/chapterTasks";
const props = defineProps<{ category: Exclude<TaskKind, "reading"> }>();
const session = useSession(), selected = ref(0);
const categoryIcon = computed<"journal" | "code" | "practice">(() => props.category === "assessment" ? "journal" : props.category === "programming" ? "code" : "practice");
const chapters = computed(() => session.taskChapters
  .map(chapter => {
    const tasks = chapter.tasks.filter(t => t.kind === props.category);
    const required = tasks.filter(t => t.required);
    const completedRequired = required.filter(t => t.completed).length;
    let summary: string | undefined;
    let progress: ChapterGroupProgress | undefined;
    if (required.length === 1) {
      const only = required[0]!;
      summary = `必做进度 · ${taskProgress(only)}`;
      const max = only.total > 0 ? only.total : 1;
      const value = only.completed ? max : Math.min(max, Math.max(0, only.current));
      progress = { value, max, label: `${chapter.title}必做进度`, completed: only.completed };
    } else if (required.length > 1) {
      summary = `必做已完成 ${completedRequired} / ${required.length} 项`;
      progress = { value: completedRequired, max: required.length, label: `${chapter.title}必做进度`, completed: completedRequired === required.length };
    }
    return { ...chapter, tasks, summary, progress };
  })
  .filter(c => c.tasks.length));
const visibleChapters = computed(() => chapters.value.filter(c => !selected.value || c.id === selected.value));
const totalTaskCount = computed(() => chapters.value.reduce((sum, chapter) => sum + chapter.tasks.length, 0));
const visibleTaskCount = computed(() => visibleChapters.value.reduce((sum, chapter) => sum + chapter.tasks.length, 0));
const activeChapterTitle = computed(() => !selected.value ? `全部${taskRoles[props.category].label}` : chapters.value.find(c => c.id === selected.value)?.title ?? taskRoles[props.category].label);
function cardProgress(task: ChapterTask): CardProgress | undefined {
  if (task.total <= 0) return undefined;
  return { value: task.completed ? task.total : Math.min(task.total, Math.max(0, task.current)), max: task.total, label: `${task.title}进度` };
}
function start(task: ChapterTask) { if (task.activity_id && !task.locked) session.navigate({ kind: "practice", activity_id: task.activity_id }); }
</script>
<style scoped>
.activity-list-content { border: 0; border-radius: 0; }
</style>
