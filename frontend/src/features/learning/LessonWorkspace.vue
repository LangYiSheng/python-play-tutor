<template>
  <LearningSplitLayout
    class="lesson-workspace"
    :has-support="true"
    :compact="compact"
  >
    <nav
      v-if="compact"
      class="workspace-view-switch game-segmented"
      aria-label="课程与助教视图"
    >
      <button
        :aria-pressed="!showAssistant"
        aria-controls="lesson-reading-region"
        @click="switchView(false)"
      >
        课程内容
      </button>
      <button
        :aria-pressed="showAssistant"
        aria-controls="lesson-assistant-region"
        @click="switchView(true)"
      >
        目标与助教
      </button>
    </nav>
    <section
      id="lesson-reading-region"
      class="lesson-content"
      tabindex="-1"
      aria-label="课程内容"
      :hidden="compact && showAssistant"
      :inert="compact && showAssistant"
      :aria-busy="loading"
    >
      <p v-if="error" class="error lesson-state-card" role="alert">
        {{ error }}
      </p>
      <p v-if="loading" class="learning-empty lesson-state-card" role="status">
        正在读取课程内容…
      </p>
      <LessonMaterial
        v-else-if="material"
        :key="material.id"
        :material="material"
        :file-url="fileUrl"
        :pdf-page="pdfPage"
        :page-index="pageIndex"
        :media-blob="mediaBlob"
        :media-error="mediaError"
        :video="video"
        @video-element="video.videoElement.value = $event"
        @page="pdfPage = $event"
        @page-ready="renderedPage = $event"
        @index="pageIndex = $event"
        @timeline="lectureSegments = $event"
      />
    </section>
    <LearningSupportPanel
      ref="supportPanel"
      v-if="material"
      :key="material.id"
      id="lesson-assistant-region"
      tabindex="-1"
      :hidden="compact && !showAssistant"
      :inert="compact && !showAssistant"
      :aria-hidden="compact && !showAssistant"
      :material-id="material.id"
      :allowed="material.status === 'ready'"
      :page-no="currentContext.page_no"
      :video-time="currentContext.video_time"
      :assistant-state="{ ...currentContext, material_id: material?.id }"
      :role-name="roleName"
      :portrait-url="rolePortrait"
      :sprite="session.world?.default_role?.sprite"
      :goals="learningGoals"
      :outline="documentOutline"
      :time-outline="videoOutline"
      @cite="cite"
      @select-page="readRequiredPage"
      @select-time="seekVideo"
    >
      <template v-if="chapterTask" #goals>
        <ChapterGoals :chapter-id="resolvedChapterId!" kind="reading" :current="chapterTask.id" />
        <p v-if="chapterError" class="error" role="alert">{{ chapterError }} <button @click="retryChapter">重试保存</button></p>
      </template>
      <template #goals-footer><p v-if="material?.notice" class="notice">{{ material.notice }}</p></template>
    </LearningSupportPanel>
  </LearningSplitLayout>
</template>
<script setup lang="ts">
import {
  computed,
  onMounted,
  onBeforeUnmount,
  nextTick,
  ref,
  watch,
} from "vue";
import { useSession } from "../../shared/session";
import { useWorkspaceSidebar } from "../../shared/workspaceSidebar";
import { notify } from "../../shared/api";
import { learningContext } from "../../shared/learningContext";
import LearningSupportPanel from "../support/LearningSupportPanel.vue";
import LearningSplitLayout from "../support/LearningSplitLayout.vue";
import { useLessonVideo } from "./useLessonVideo";
import "../support/learningUi.css";
import "./lessonUi.css";
import ChapterGoals from "../ChapterGoals.vue";
import {useChapterParticipation, type ParticipationSample} from "./useChapterParticipation";
import LessonMaterial from "./LessonMaterial.vue";
import { useLessonSource } from "./useLessonSource";
const props = defineProps<{
  initialPage?: number;
  initialVideoTime?: number;
  materialId: number;
  chapterId?: number;
}>();

const session = useSession();
const contextUserId = session.user?.id;
const contextClassroomId = session.classroomId;
const showAssistant = ref(false);
const compact = ref(false);
const { collapsed: sidebarCollapsed } = useWorkspaceSidebar();
watch(sidebarCollapsed, (value) => {
  if (value) showAssistant.value = false;
});
let compactMedia: MediaQueryList | undefined;
const {
  material,
  loading,
  error,
  pageIndex,
  pdfPage,
  mediaBlob,
  mediaError,
  currentPage,
  readingKey,
  fileUrl,
  currentOwner,
  load,
  selectPage,
  showCitation,
} = useLessonSource({
  userId: contextUserId,
  classroomId: contextClassroomId,
  currentOwner: () =>
    session.user?.id === contextUserId &&
    session.classroomId === contextClassroomId,
  materialId: () => props.materialId,
  initialPage: () => props.initialPage,
  beforeLoad: () => video.resetVideo(),
});
const lectureSegments = ref<import("../../shared/lectureTimeline").LectureSegment[]>([]);
watch(() => material.value?.id, () => {lectureSegments.value=[];});
const documentOutline = computed(() => (material.value?.pages ?? []).map(p => ({pageNo:p.page_no, title:p.title,
  timeSeconds:lectureSegments.value.find(s=>s.pageNo===p.page_no)?.start})));
const videoOutline = computed(() => material.value?.kind === "video" ? [{timeSeconds:0,title:"视频开始"}] : []);
const learningGoals = computed(() => [{title:material.value?.title ?? "当前资料"}]);
const roleName = computed(() => session.world?.default_role?.name ?? "图书管理员");
const rolePortrait = computed(() => session.world?.default_role?.portrait);
const video = useLessonVideo({readingKey, initialTime:() => props.initialVideoTime, onSeek:() => {if(compact.value) void switchView(false);}});
const renderedPage = ref<number | null>(null);
const resolvedChapterId = computed(() => props.chapterId ?? session.taskChapters.find(c => c.tasks.some(t => t.material_id === props.materialId))?.id);
const chapterTask = computed(() => session.taskChapters.find(c => c.id === resolvedChapterId.value)?.tasks.find(t => t.material_id === props.materialId));
const playing = ref(false), playbackRate = ref(1);
watch(video.videoElement, (el, _, cleanup) => {
  if (!el) { playing.value = false; return; }
  const state = () => { playing.value = !el.paused && !el.seeking && el.readyState >= 3; playbackRate.value = el.playbackRate; };
  const events = ["play","playing","pause","ended","waiting","seeking","seeked","ratechange"];
  events.forEach(name => el.addEventListener(name,state));
  cleanup(() => events.forEach(name => el.removeEventListener(name,state)));
  state();
});
const sample = computed<ParticipationSample | null>(() => {
  const item = material.value;
  if (loading.value || item?.status !== "ready" || item.id !== props.materialId || (compact.value && showAssistant.value)) return null;
  if (item.kind === "video") return video.videoElement.value ? {visible:true,position:video.videoTime.value,playing:playing.value,playback_rate:playbackRate.value} : null;
  const page = item.kind === "text" ? currentPage.value : item.pages.find(p => p.page_no === renderedPage.value && p.page_no === pdfPage.value);
  return page ? {visible:true,page_id:Number(page.id)} : null;
});
const {error: chapterError, retry: retryChapter} = useChapterParticipation(resolvedChapterId.value, props.materialId, sample);
const {videoTime, seekVideo} = video;
const currentContext = computed(() =>
  ({ ...learningContext(
    material.value,
    material.value && ["pdf", "presentation"].includes(material.value.kind)
      ? pdfPage.value
      : currentPage.value?.page_no,
    videoTime.value,
  ), material_id: material.value?.id }),
);
function updateCompact() {
  if (!compactMedia) return;
  if (compactMedia.matches && !compact.value)
    showAssistant.value = Boolean(
      document
        .getElementById("lesson-assistant-region")
        ?.contains(document.activeElement),
    );
  compact.value = compactMedia.matches;
}
const supportPanel = ref<InstanceType<typeof LearningSupportPanel>>();
async function switchView(assistant: boolean) {
  if (assistant) sidebarCollapsed.value = false;
  showAssistant.value = assistant;
  await nextTick();
  document
    .getElementById(
      assistant ? "lesson-assistant-region" : "lesson-reading-region",
    )
    ?.focus({ preventScroll: true });
}
function readRequiredPage(page: number) {
  selectPage(page);
  if (compact.value) void switchView(false);
}
async function cite(id: number, page: number) {
  try {
    await session.flushParticipation();
    const target = session.taskChapters.find(c => c.id === resolvedChapterId.value && c.tasks.some(t => t.material_id === id));
    if (target && material.value?.id !== id) {session.replace({kind:"material", material_id:id, chapter_id:target.id, page_no:page});return;}
    if (await showCitation(id, page)) await switchView(false);
  } catch (cause) {
    if (currentOwner())
      notify(cause instanceof Error ? cause.message : "无法访问引用");
  }
}
watch(pageIndex, (value) => {
  if (currentOwner() && !loading.value) {
    sessionStorage.setItem(readingKey.value, String(value));
  }
});
watch(pdfPage, (value) => {
  if (currentOwner() && !loading.value) {
    sessionStorage.setItem(`${readingKey.value}:pdf`, String(value));
  }
});
watch(() => props.materialId, load);
watch(
  () => props.initialPage,
  (page) => {
    if (page) selectPage(page);
  },
);
onMounted(() => {
  compactMedia = window.matchMedia?.("(max-width: 900px), (max-height: 540px)");
  updateCompact();
  compactMedia?.addEventListener("change", updateCompact);
  void load();
});
onBeforeUnmount(() => {
  compactMedia?.removeEventListener("change", updateCompact);
});
</script>
