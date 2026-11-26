import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { api } from "../api";

import type {
  Activity,
  Classroom,
  User,
  World,
} from "../types";
import { createWorkspaceNavigation } from "./navigation";
import { createWorldPosition } from "./position";
import type { TaskChapter } from "../chapterTasks";
import { createExperienceCoordinator } from "./experience";
import { mediaCache } from "../mediaCache";
import { pdfCache } from "../pdfCache";

// The session owns identity and classroom. Feature coordinators receive these
// refs explicitly; they never create competing stores or initialize each other.
export const useSession = defineStore("session", () => {
  const user = ref<User | null>(null);
  const classes = ref<Classroom[]>([]),
    classroomId = ref<number | null>(null);
  const world = ref<World | null>(null),
    trackedQuest = ref("");
  const drafts = ref<Record<string, string>>({}),
    audioEnabled = ref(false);
  const navigationTarget = ref<string | null>(null);
  let loadGeneration = 0,
    classroomSwitchGeneration = 0;
  const navigation = createWorkspaceNavigation(user, classroomId);
  const position = createWorldPosition(user, classroomId, world);
  let participation: (() => Promise<void>) | undefined;
  function registerParticipation(save: () => Promise<void>) { participation = save; return () => { if (participation === save) participation = undefined; }; }
  async function flushParticipation() { await participation?.(); }
  const taskChapters = ref<TaskChapter[]>([]);
  let taskGeneration = 0;
  async function refreshTasks() {
    const id = classroomId.value, owner = user.value?.id, generation = ++taskGeneration;
    if (!id) return;
    const data = await api.get<{chapters: TaskChapter[]}>(`/chapter-tasks?classroom_id=${id}`);
    if (id === classroomId.value && owner === user.value?.id && generation === taskGeneration)
      taskChapters.value = data.chapters;
  }
  const experience = createExperienceCoordinator({
    user,
    classes,
    classroomId,
    world,
    invalidateRequests,
    resetClientState() {
      mediaCache.clear();
      pdfCache.clear();
      taskGeneration++; taskChapters.value = [];
      navigationTarget.value = null;
      trackedQuest.value = "";
      drafts.value = {};
      navigation.clearHistory();
      position.clearMapPosition();
    },
  });
  function invalidateRequests() {
    loadGeneration++;
    classroomSwitchGeneration++;
  }
  async function load() {
    if (experience.resetBusy.value) return;
    const generation = ++loadGeneration;
    const token = api.token();
    const current = () =>
      generation === loadGeneration && api.token() === token;
    const loadedUser = await api.get<User>("/auth/me");
    if (!current()) return;
    const loadedClasses = await api.get<Classroom[]>("/classrooms");
    if (!current()) return;
    let selectedId =
      user.value?.id === loadedUser.id ? classroomId.value : null;
    if (selectedId === null) {
      const saved = Number(
        sessionStorage.getItem(`classroom:${loadedUser.id}`),
      );
      if (loadedClasses.some((c) => c.id === saved)) selectedId = saved;
    }
    if (!loadedClasses.some((c) => c.id === selectedId))
      selectedId = loadedClasses[0]?.id ?? null;
    const loadedWorld = selectedId
      ? await api.get<World>(`/world?classroom_id=${selectedId}`)
      : null;
    if (!current()) return;
    user.value = loadedUser;
    classes.value = loadedClasses;
    classroomId.value = selectedId;
    world.value = loadedWorld;
  }
  async function refresh() {
    const id = classroomId.value,
      owner = user.value?.id,
      generation = experience.generation;
    if (!id || experience.resetBusy.value) return;
    const result = await api.get<World>(`/world?classroom_id=${id}`);
    if (
      classroomId.value === id &&
      user.value?.id === owner &&
      generation === experience.generation &&
      !experience.resetBusy.value
    )
      world.value = result;
  }
  async function switchClassroom(id: number) {
    if (experience.resetBusy.value) throw new Error("正在重新开始，请稍候。");
    if (!classes.value.some((item) => item.id === id))
      throw new Error("请先加入这个班级。");
    if (id === classroomId.value) return true;
    const generation = ++classroomSwitchGeneration;
    const owner = user.value?.id,
      previous = classroomId.value,
      token = api.token();
    const loadingGeneration = ++loadGeneration;
    const current = () =>
      generation === classroomSwitchGeneration &&
      loadingGeneration === loadGeneration &&
      owner === user.value?.id &&
      previous === classroomId.value &&
      token === api.token();
    await flushParticipation();
    if (!current()) return false;
    const result = await api.get<World>(`/world?classroom_id=${id}`);
    if (!current()) return false;
    classroomId.value = id;
    world.value = result;
    drafts.value = {};
    trackedQuest.value = "";
    navigation.clearHistory();
    await refreshTasks();
    return true;
  }
  async function activity(id: string) {
    return api.get<Activity>(
      `/activities/${id}?classroom_id=${classroomId.value}`,
    );
  }

  function guideTo(key: string) {
    navigation.open(null);
    navigationTarget.value = key;
  }
  watch(
    [() => user.value?.id, classroomId],
    () => {
      mediaCache.clear();
      pdfCache.clear();
      experience.invalidate();
      taskGeneration++; taskChapters.value = [];
      navigationTarget.value = null;
    },
    { flush: "sync" },
  );
  watch(classroomId, (id) => {
    if (user.value && id)
      sessionStorage.setItem(`classroom:${user.value.id}`, String(id));
  });
  function reset() {
    mediaCache.clear();
    pdfCache.clear();
    invalidateRequests();
    experience.invalidate();
    user.value = null;
    classes.value = [];
    classroomId.value = null;
    world.value = null;
    position.clearMapPosition();
    navigation.reset();
    drafts.value = {};
    trackedQuest.value = "";
    audioEnabled.value = false;
    taskGeneration++; taskChapters.value = [];
    navigationTarget.value = null;
    api.setToken(null);
  }
  return {
    user,
    classes,
    classroomId,
    world,
    trackedQuest,
    drafts,
    audioEnabled,
    navigationTarget,
    mapPosition: position.mapPosition,
    setMapPosition: position.setMapPosition,
    clearMapPosition: position.clearMapPosition,
    workspace: navigation.workspace,
    open: navigation.open,
    navigate: navigation.navigate,
    back: navigation.back,
    canGoBack: navigation.canGoBack,
    previousWorkspace: navigation.previousWorkspace,
    taskChapters, refreshTasks, registerParticipation, flushParticipation,
    replace: navigation.replace,
    resetBusy: experience.resetBusy,
    restartCompleted: experience.restartCompleted,
    registerRestartPreparation: experience.registerRestartPreparation,
    prepareExperience: experience.prepareExperience,
    restartCurrentClassroom: experience.restartCurrentClassroom,
    load,
    refresh,
    switchClassroom,
    activity,
    guideTo,
    reset,
  };
});
