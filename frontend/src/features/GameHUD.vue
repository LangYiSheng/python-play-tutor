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
      <h2 class="quest-heading"><GameIcon name="journal" /><span>{{ tracked.chapter.title }}</span></h2>
      <p class="quest-next">{{ tracked.title }}</p>
      <button v-if="goals.length > 1" class="quest-go" aria-label="切换追踪目标" @click="cycle">切换目标 {{ goals.indexOf(tracked) + 1 }} / {{ goals.length }}</button>
      <button class="quest-go" @click="$emit('guide', tracked.target)">立即前往<GameIcon name="compass" /></button>
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
import { computed } from "vue";
import { useSession } from "../shared/session";
import GameIcon from "../shared/GameIcon.vue";
import {chapterGoals} from "../shared/chapterTasks";
import { canUseDevTools } from "../shared/devTools";
defineProps<{ blocked?: boolean }>();
const session = useSession();

defineEmits<{ guide: [key: string] }>();
const goals = computed(() => chapterGoals(session.taskChapters, session.world?.npcs));
const tracked = computed(() => goals.value.find(g => g.id === session.trackedQuest) ?? goals.value[0]);
function cycle() {
  if (tracked.value) session.trackedQuest = goals.value[(goals.value.indexOf(tracked.value) + 1) % goals.value.length]!.id;
}
const classroomName = computed(
  () =>
    session.classes.find((c) => c.id === session.classroomId)?.name ??
    "我的班级",
);
</script>

<style scoped src="./world/hud.css"></style>
