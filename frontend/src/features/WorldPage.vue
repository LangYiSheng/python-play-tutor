<template>
  <main class="world-page">
    <div v-if="loading" class="screen-message" :class="{ 'arrival-blackout': welcome }">正在连接小镇存档…</div>
    <section v-else-if="error" class="screen-message">
      <h1>暂时无法进入小镇</h1>
      <p>{{ error }}</p>
      <button @click="load">重试</button
      ><button @click="logout">返回入场</button>
    </section>
    <template v-else-if="session.classroomId && (session.world || session.resetBusy)"
      ><WorldCanvas
        v-if="session.world"
        :key="session.classroomId"
        ref="canvas"
        :paused="Boolean(session.workspace || line || welcome || busy || session.resetBusy)"
        @ready="onWorldReady"
        @position="positionChanged"
        @interact="interact" /><GameHUD
        v-if="!welcome"
        :blocked="Boolean(session.workspace || line || busy || session.resetBusy)"
        :class="{ 'is-entering': entered }"
        @guide="guide" /><DialogueLayer
        v-if="line" :line="line" @advance="advanceDialogue" @close="dismissDialogue"
        />
      <OverlayHost @close="closeWorkspace" @complete="closeWorkspace"
    /></template>
    <section v-else class="arrival-page">

      <strong class="arrival-brand">PYTHONTOPIA</strong>
      <div class="arrival-panel">
      <h1>加入班级</h1>
      <p>向老师领取班级加入码。</p>
      <form @submit.prevent="join">
        <label>班级加入码<input v-model="joinCode" required /></label>
        <button class="primary">加入班级</button>
      </form>
      <button class="text-button" @click="logout">退出账号</button>
      </div>
    </section>
    <ArrivalWelcome v-if="welcome && !proceeding && session.world && session.classroomId && !loading && !error" :ready="worldReady && backdropReady" :name="session.user?.name ?? ''" @continue="finishArrival" />
  </main>
</template>
<script setup lang="ts">
import {
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import { useRouter } from "vue-router";
import WorldCanvas from "./WorldCanvas.vue";
import GameHUD from "./GameHUD.vue";
import DialogueLayer from "./DialogueLayer.vue";
import OverlayHost from "./OverlayHost.vue";
import { useSession } from "../shared/session";
import { api, notify } from "../shared/api";
import type { Player, StoryDialogue } from "../shared/types";
import { isTextFocus } from "../game/pathfinding";
import { greeting, farewell, taskKinds, taskRoles, type TaskKind, type TaskChapter } from "../shared/chapterTasks";
import { arrivalActive, arrivalCamera, arrivalFinished, backdropReady, startArrival, endArrival, type ArrivalCamera } from "../app/arrival";
import ArrivalWelcome from "./ArrivalWelcome.vue";
const welcome = ref(true);
if (!arrivalActive.value) startArrival();
const worldReady = ref(false);
const entered = ref(false);
const proceeding = ref(false);
const playerCamera = ref<ArrivalCamera | null>(null);
function onWorldReady(camera: ArrivalCamera) {
  playerCamera.value = camera;
  worldReady.value = true;
}
watch(arrivalFinished, value => {
  if (!value || !proceeding.value) return;
  entered.value = true;
  welcome.value = false;
  sessionStorage.removeItem("reborn-arrival");
});
function finishArrival() {
  if (proceeding.value || !playerCamera.value || !backdropReady.value) return;
  proceeding.value = true;
  arrivalCamera.value = playerCamera.value;
}
const session = useSession(),
  router = useRouter(),
  loading = ref(true),
  error = ref(""),
  joinCode = ref(""),
  canvas = ref<InstanceType<typeof WorldCanvas>>();

let unregisterRestart: (() => void) | undefined;
watch(() => session.restartCompleted, () => {
  loading.value = true;
  window.location.reload();
}, { flush: "sync" });
const line = ref<StoryDialogue>();
const busy = ref(false);
let visit: { kind: TaskKind; before: TaskChapter[] } | undefined;
let visitGeneration = 0;
watch(() => [session.classroomId, session.user?.id], () => {
  visitGeneration++; visit = undefined; line.value = undefined; busy.value = false;
});
function say(kind: TaskKind, text: string, offer = false) {
  const npc = session.world?.npcs.find(n => n.key === taskRoles[kind].key);
  line.value = {id: String(++visitGeneration), speaker: npc?.name ?? taskRoles[kind].name, portrait: npc?.portrait,
    text, choices: offer ? [{id:"open", label: "查看" + taskRoles[kind].label}] : []};
}
function dismissDialogue() {line.value = undefined; visit = undefined;}
function advanceDialogue(choice?: string) {
  line.value = undefined;
  if (choice !== "open" || !visit) {visit = undefined; return;}
  session.open(visit.kind === "reading" ? {kind:"library"} : {kind:"taskList", category: visit.kind});
}
async function closeWorkspace() {
  if (busy.value) return;
  const generation = visitGeneration;
  busy.value = true;
  try {
    await session.flushParticipation();
    await session.refreshTasks();
    if (generation !== visitGeneration) return;
    session.open(null);
    if (visit) {
      const old = visit; visit = undefined;
      say(old.kind, farewell(old.before, session.taskChapters, old.kind, session.world?.npcs));
    }
  } catch (failure) {notify(failure instanceof Error ? failure.message : "无法保存学习进度，请重试。");}
  finally {busy.value = false;}
}
watch(() => session.navigationTarget, async target => {
  if (!target) return;
  session.navigationTarget = null;
  await guide(target);
});
async function load() {
  loading.value = true;
  error.value = "";
  try {
    if (!session.world) await session.load();
    await session.refreshTasks();
    if (!session.classroomId) endArrival();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "连接失败";
  } finally {
    loading.value = false;
  }
}
async function join() {
  try {
    await api.post("/classrooms/join", { join_code: joinCode.value });
    worldReady.value = false;
    startArrival();
    await session.load();
    await load();
  } catch (e) {
    endArrival();
    notify(e instanceof Error ? e.message : "加入失败");
  }
}
async function logout() {
  try {
    await api.post("/auth/logout", {});
  } finally {
    sessionStorage.removeItem("reborn-arrival");
    session.reset();
    await router.push("/");
  }
}
async function guide(key: string) {
  session.open(null);
  line.value = undefined; visit = undefined;
  await nextTick();
  canvas.value?.guide(key);
}
function positionChanged(player: Player) {
  if (session.world) session.world.player = player;
}
async function interact(target: string, type: "npc" | "object") {
  if (busy.value || session.workspace) return;
  if (type === "object") return;
  const kind = taskKinds.find(kind => taskRoles[kind].key === target);
  if (!kind) return;
  const generation = visitGeneration;
  busy.value = true;
  try {
    await session.refreshTasks();
    if (generation !== visitGeneration) return;
    const reply = greeting(session.taskChapters, kind);
    visit = reply.open ? {kind, before: JSON.parse(JSON.stringify(session.taskChapters))} : undefined;
    say(kind, reply.text, reply.open);
  } catch (failure) {notify(failure instanceof Error ? failure.message : "无法加载章节任务");}
  finally {busy.value = false;}
}
function worldShortcut(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    isTextFocus(document.activeElement) ||
    welcome.value ||
    session.workspace ||
    line.value ||
    busy.value ||
    session.resetBusy ||
    !session.world
  )
    return;
  if (event.key.toLowerCase() === "j" || event.key === "Escape") {
    event.preventDefault();
    session.open({ kind: event.key === "Escape" ? "settings" : "journal" });
  }
}
onMounted(() => {
  unregisterRestart = session.registerRestartPreparation(async () => {
    await canvas.value?.flushSaves();
    await session.flushParticipation();
  });
  void load();
  window.addEventListener("keydown", worldShortcut);
});
onBeforeUnmount(() => {
  unregisterRestart?.();
  window.removeEventListener("keydown", worldShortcut);
});
</script>

<style scoped>
.world-action-status {
  position: absolute;
  z-index: 30;
  bottom: max(24px, var(--safe-bottom));
  left: 50%;
  width: max-content;
  max-width: calc(100% - 32px);
  transform: translateX(-50%);
  padding: 12px 16px;
  border: 1px solid #af8b50;
  border-radius: 8px;
  color: #f0dfbb;
  background: #30291f;
}
.world-action-status p { margin: 0; }
.world-action-status button { min-height: 44px; margin: 8px 8px 0 0; }
</style>
