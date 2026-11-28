<template>
  <section class="town-workspace">
    <div class="town-book">
      <aside class="town-sidebar"><nav class="town-directory" aria-label="章节目录">
        <button class="town-directory-item" :class="{ 'is-current': !selected }" :aria-pressed="!selected" @click="selected = 0">全部章节</button>
        <button v-for="chapter in chapters" :key="chapter.id" class="town-directory-item" :class="{ 'is-current': selected === chapter.id }" :aria-pressed="selected === chapter.id" @click="selected = chapter.id"><ChapterNumber :number="chapter.order_index"/> {{ chapter.title }}</button>
      </nav></aside>
      <main class="town-content">
        <ChapterCardGroup v-for="chapter in chapters.filter(c => !selected || c.id === selected)" :key="chapter.id"
          :number="chapter.order_index" :title="chapter.title" :heading-id="`activities-chapter-${chapter.id}`">
          <ChapterContentCard v-for="task in chapter.tasks" :key="task.id" class="task-row" :title="task.title"
            :icon="category === 'assessment' ? 'journal' : category === 'programming' ? 'code' : 'practice'"
            :badge="task.required ? '必做' : undefined" :disabled="task.locked" @click="start(task)"
            :action="task.locked ? '尚未解锁' : task.completed || task.handed_in ? '查看' : task.current ? '继续作答' : '开始作答'">
            {{ task.required ? '' : '选做 · ' }}{{ taskProgress(task) }}
          </ChapterContentCard>
        </ChapterCardGroup>
        <p v-if="!chapters.length" class="town-empty">暂时没有发布{{ taskRoles[category].label }}。</p>
      </main>
    </div>
  </section>
</template>
<script setup lang="ts">
import ChapterNumber from "../shared/ChapterNumber.vue";
import ChapterCardGroup from "./ChapterCardGroup.vue";
import ChapterContentCard from "./ChapterContentCard.vue";
import {computed, ref} from "vue";
import {useSession} from "../shared/session";
import {taskProgress, taskRoles, type ChapterTask, type TaskKind} from "../shared/chapterTasks";
const props = defineProps<{category: Exclude<TaskKind, "reading">}>();
const session = useSession(), selected = ref(0);
const chapters = computed(() => session.taskChapters.map(chapter => ({...chapter, tasks: chapter.tasks.filter(t => t.kind === props.category)})).filter(c => c.tasks.length));
function start(task: ChapterTask) { if (task.activity_id && !task.locked) session.navigate({kind:"practice",activity_id:task.activity_id}); }
</script>
