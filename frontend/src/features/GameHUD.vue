<template>
  <div class="world-ui" :inert="blocked" :aria-hidden="blocked || undefined">
    <header class="game-hud">
      <div class="resident-badge">

        <div>
          <strong>{{ session.user?.name }}</strong
          ><small :title="classroomName">{{ classroomName }}</small>
        </div>
      </div>
    </header>
    <aside v-if="tracked" class="quest-tracker" aria-label="当前目标">
      <h2 class="quest-heading"><ChapterNumber :number="tracked.chapter.order_index"/> <span>{{ tracked.chapter.title }}</span></h2>
      <p class="quest-next" aria-live="polite">{{ tracked.title }}</p>
      <div class="quest-actions">
        <div v-if="goals.length > 1" class="quest-pager" role="group" aria-label="追踪目标">
          <button aria-label="上一个追踪目标" title="上一个目标" @click="cycle(-1)"><GameIcon name="chevron" class="previous"/></button>
          <span>{{ goals.indexOf(tracked) + 1 }} / {{ goals.length }}</span>
          <button aria-label="切换追踪目标" title="下一个目标" @click="cycle(1)"><GameIcon name="chevron"/></button>
        </div>
        <button class="quest-go" @click="$emit('guide', tracked.target)"><GameIcon name="compass"/>立即前往</button>
      </div>
    </aside>
    <aside v-else-if="finished || pendingPaper" class="quest-tracker" aria-label="当前目标">
      <h2 class="quest-heading"><GameIcon :name="finished ? 'check' : 'journal'"/>{{ finished ? '任务已全部完成' : '测验已交卷' }}</h2>
      <p class="quest-next" aria-live="polite">{{ finished ? '可以逛逛小镇，等老师发布新任务。' : pendingPaper?.grading_status === 'attention' ? '等待老师核查测验结果。' : '正在批改，可以先逛逛小镇。' }}</p>
    </aside>
    <nav class="hud-dock" aria-label="小镇菜单">
      <button data-world-focus @click="session.open({ kind: 'journal' })">
        <GameIcon name="journal" /><span>任务日志</span><kbd>J</kbd>
      </button>
      <button @click="$emit('guide', 'librarian')">
        <GameIcon name="book" /><span>去图书馆</span>
      </button>
      <button @click="session.open({ kind: 'map' })">
        <GameIcon name="compass" /><span>地图</span>
      </button>
      <button @click="session.open({ kind: 'classroom' })">
        <GameIcon name="people" /><span>我的班级</span>
      </button>
      <button aria-label="打开设置" @click="session.open({ kind: 'settings' })">
        <GameIcon name="settings" /><span>设置</span><kbd>Esc</kbd>
      </button>
      <button v-if="canUseDevTools(session.user)" @click="session.open({ kind: 'developer' })">
        <GameIcon name="settings" /><span>开发工具</span>
      </button>
    </nav>
  </div>
</template>
<script setup lang="ts">
import ChapterNumber from "../shared/ChapterNumber.vue";
import { computed, watch } from "vue";
import { useSession } from "../shared/session";
import GameIcon from "../shared/GameIcon.vue";
import {chapterGoals} from "../shared/chapterTasks";
import { canUseDevTools } from "../shared/devTools";
const props = defineProps<{ blocked?: boolean }>();
const session = useSession();

defineEmits<{ guide: [key: string] }>();
const goals = computed(() => chapterGoals(session.taskChapters, session.world?.npcs));
const tracked = computed(() => goals.value.find(g => g.id === session.trackedQuest) ?? goals.value[0]);
const required = computed(() => session.taskChapters.flatMap(chapter => chapter.tasks.filter(task => task.required)));
const finished = computed(() => required.value.length > 0 && required.value.every(task => task.completed));
const pendingPaper = computed(() => required.value.find(task => task.handed_in && !task.completed));
watch(() => !props.blocked && required.value.some(task => task.grading_status === 'grading'), (pending, _, onCleanup) => {
  if (!pending) return;
  let stopped = false;
  let timer = setTimeout(refresh, 3000);
  async function refresh() {
    try { await session.refreshTasks(); }
    catch { /* The next refresh can recover a temporary connection failure. */ }
    if (!stopped) timer = setTimeout(refresh, 5000);
  }
  onCleanup(() => { stopped = true; clearTimeout(timer); });
}, { immediate: true });
function cycle(step: number) {
  if (tracked.value) session.trackedQuest = goals.value[(goals.value.indexOf(tracked.value) + step + goals.value.length) % goals.value.length]!.id;
}
const classroomName = computed(
  () =>
    session.classes.find((c) => c.id === session.classroomId)?.name ??
    "我的班级",
);
</script>

<style scoped src="./world/hud.css"></style>
