<template>
  <section class="town-workspace library-workspace">
    <div class="chapter-book">
      <aside class="chapter-index-panel library-sidebar">
        <GamePanelHeader icon="book" title="章节目录" />
        <div class="chapter-index-body">
          <nav class="town-directory" aria-label="资料章节">
            <button class="town-directory-item chapter-nav-card" :class="{ 'is-current': chapter === 'all' }" :aria-pressed="chapter === 'all'" @click="selectChapter('all')">
              <span class="chapter-nav-head">
                <GameIcon name="grid"/>
                <span class="chapter-nav-title">全部章节</span>
                <small class="chapter-nav-count">{{ materials.length }} 份</small>
              </span>
            </button>
            <button v-for="item in chapters" :key="item.id" class="town-directory-item chapter-nav-card" :class="{ 'is-current': chapter === item.id }" :aria-pressed="chapter === item.id" @click="selectChapter(item.id)">
              <span class="chapter-nav-head">
                <ChapterNumber v-if="item.number != null" :number="item.number"/><GameIcon v-else name="book"/>
                <span class="chapter-nav-title">{{ item.title }}</span>
                <small class="chapter-nav-count">{{ item.materials.length }} 份</small>
              </span>
              <span v-if="item.progress" class="chapter-nav-meta">
                <span class="chapter-nav-progress-text" :class="{ 'is-complete': item.progress.completed }">
                  <span>{{ item.readingProgress }}</span>
                </span>
                <progress class="support-progress-bar" :value="item.progress.value" :max="item.progress.max" :aria-label="item.progress.label" />
              </span>
            </button>
          </nav>
        </div>
      </aside>
      <section class="chapter-main-panel">
        <GamePanelHeader icon="book" :title="activeChapterTitle">
          <template #actions>
            <span class="library-result-count chapter-panel-count" role="status" aria-live="polite">{{ filteredCount }} 份资料</span>
          </template>
        </GamePanelHeader>
        <main ref="content" class="chapter-main-body town-content library-content" :aria-busy="loading">
          <div class="town-toolbar library-toolbar">
            <div class="library-search">
              <GameIcon name="search" class="library-search-icon" />
              <input v-model="query" type="search" aria-label="搜索资料" placeholder="搜索资料名称或章节" autocomplete="off" @input="resetScroll"/>
            </div>
          </div>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <p v-else-if="loading" class="town-empty" role="status">正在加载资料…</p>
          <template v-else>
            <ChapterCardGroup v-for="group in filteredChapters" :key="group.id" :number="group.number" :title="group.title" :heading-id="`library-chapter-${group.id}`" :summary="group.readingProgress" :progress="group.progress">
              <ChapterContentCard v-for="material in group.materials" :key="material.id" :title="material.title"
                :icon="material.kind === 'video' ? 'video' : 'book'" :badge="group.tasks.get(material.id)?.required ? '必读' : undefined"
                :completed="Boolean(group.tasks.get(material.id)?.completed)"
                :progress="cardProgress(material, group.tasks.get(material.id))"
                :disabled="material.status !== 'ready'" @click="open(material, group.id)"
                :action="material.status === 'ready' ? material.kind === 'video' ? '观看' : '阅读' : material.status === 'failed' ? '处理失败' : '处理中'">
                {{ kindLabels[material.kind] ?? '课程资料' }}<template v-if="group.tasks.has(material.id)">{{ group.tasks.get(material.id)!.required ? '' : ' · 选读' }} · {{ taskProgress(group.tasks.get(material.id)!) }}</template><template v-if="duration(material)"> · {{ duration(material) }}</template>
              </ChapterContentCard>
            </ChapterCardGroup>
            <div v-if="!filteredCount" class="town-empty library-empty"><GameIcon name="book"/><p>{{ materials.length ? '没有找到匹配的资料' : '当前班级还没有开放资料' }}</p><button v-if="materials.length" class="town-secondary" @click="clearFilters">清除筛选</button></div>
          </template>
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
import { taskProgress, type ChapterTask } from "../shared/chapterTasks";
import GameIcon from "../shared/GameIcon.vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { api } from "../shared/api";
import { useSession } from "../shared/session";
import type { Material } from "../shared/types";

type ChapterSelection = "all" | number;
interface SavedView { query?: string; chapter?: ChapterSelection; scroll?: number; }
const session = useSession(), content = ref<HTMLElement>(), materials = ref<Material[]>([]), error = ref(""), loading = ref(true);
const query = ref(""), chapter = ref<ChapterSelection>("all");
const kindLabels: Record<string, string> = { text: "文本课件", pdf: "PDF 课件", presentation: "演示课件", video: "课程视频" };
let ownerKey = "", generation = 0, disposed = false, scrollPosition = 0;
const chapters = computed(() => {
  const groups = new Map<number, Material[]>((session.taskChapters ?? []).map(c => [c.id, []]));
  for (const material of materials.value) {
    const ids = material.chapter_ids?.length ? material.chapter_ids : [material.chapter_id ?? 0];
    for (const id of ids) {
      const list = groups.get(id) ?? [];
      list.push(material);
      groups.set(id, list);
    }
  }
  return [...groups].map(([id, items]) => {
    const details = session.taskChapters.find(c => c.id === id) ?? session.world?.chapters.find(item => item.id === id);
    const entries = session.taskChapters.find(c => c.id === id)?.tasks.filter(t => t.kind === "reading") ?? [];
    const tasks = new Map(entries.map(task => [task.material_id, task]));
    const required = entries.filter(task => task.required);
    const completedRequired = required.filter(task => task.completed).length;
    const title = details?.title ?? "其他资料";
    const readingProgress = !required.length ? "无必读资料" : required.length === 1
      ? `必读进度 · ${taskProgress(required[0]!)}`
      : `必读已完成 ${completedRequired} / ${required.length} 份`;
    let progress: ChapterGroupProgress | undefined;
    if (required.length === 1) {
      const only = required[0]!;
      const max = only.total > 0 ? only.total : 1;
      const value = only.completed ? max : Math.min(max, Math.max(0, only.current));
      progress = { value, max, label: `${title}必读进度`, completed: only.completed };
    } else if (required.length > 1) {
      progress = { value: completedRequired, max: required.length, label: `${title}必读进度`, completed: completedRequired === required.length };
    }
    return { id, number: details?.order_index, title, order: details?.order_index ?? Number.MAX_SAFE_INTEGER, tasks, readingProgress, progress,
      materials: items.sort((a, b) => entries.findIndex(t => t.material_id === a.id) - entries.findIndex(t => t.material_id === b.id)) };
  }).sort((a, b) => a.order - b.order || a.id - b.id);
});
const activeChapterTitle = computed(() => chapter.value === "all" ? "全部资料" : chapters.value.find(item => item.id === chapter.value)?.title ?? "课程资料");
function cardProgress(material: Material, task?: ChapterTask): CardProgress | undefined {
  if (!task || task.total <= 0) return undefined;
  return { value: task.completed ? task.total : Math.min(task.total, Math.max(0, task.current)), max: task.total, label: `${material.title}阅读进度` };
}
const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, "");
const filteredChapters = computed(() => chapters.value.filter(group => chapter.value === "all" || group.id === chapter.value).map(group => ({
  ...group,
  materials: group.materials.filter(material =>
    normalize(`${material.title} ${group.title} ${kindLabels[material.kind] ?? ""}`).includes(normalize(query.value))),
})).filter(group => group.materials.length));
const filteredCount = computed(() => new Set(filteredChapters.value.flatMap(group => group.materials.map(material => material.id))).size);
function duration(material: Material) {
  const seconds = material.duration_seconds;
  if (material.kind !== "video" || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
function saveView() {
  if (!ownerKey) return;
  try {
    const scroll = loading.value ? scrollPosition : content.value?.scrollTop ?? scrollPosition;
    scrollPosition = scroll;
    sessionStorage.setItem(`library-view:${ownerKey}`, JSON.stringify({ query: query.value, chapter: chapter.value, scroll }));
    sessionStorage.setItem(`library-scroll:${ownerKey}`, String(scroll));
  } catch { /* Browsing also works when optional device storage is unavailable. */ }
}
function resetScroll() { scrollPosition = 0; if (content.value) content.value.scrollTop = 0; }
function selectChapter(id: ChapterSelection) { chapter.value = id; resetScroll(); }
function clearFilters() { query.value = ""; chapter.value = "all"; resetScroll(); }
function open(material: Material, chapterId: number) { saveView(); session.navigate({ kind: "material", material_id: material.id, chapter_id: chapterId }); }
watch([query, chapter], saveView, { flush: "post" });
watch(() => [session.user?.id, session.classroomId] as const, async ([userId, classroomId]) => {
  saveView();
  const current = ++generation;
  ownerKey = userId !== undefined && classroomId !== null ? `${userId}:${classroomId}` : "";
  materials.value = [];
  error.value = "";
  loading.value = true;
  let saved: SavedView = {};
  try {
    const parsed = JSON.parse(sessionStorage.getItem(`library-view:${ownerKey}`) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed;
  } catch { /* Ignore invalid optional preferences. */ }
  query.value = typeof saved.query === "string" ? saved.query : "";
  chapter.value = saved.chapter === "all" || typeof saved.chapter === "number" ? saved.chapter : "all";
  const restoredScroll = Number(saved.scroll ?? sessionStorage.getItem(`library-scroll:${ownerKey}`) ?? 0);
  scrollPosition = Number.isFinite(restoredScroll) ? Math.max(0, restoredScroll) : 0;
  if (!ownerKey) { loading.value = false; return; }
  try {
    const result = await api.get<Material[]>(`/library?classroom_id=${classroomId}`);
    if (disposed || current !== generation || session.user?.id !== userId || session.classroomId !== classroomId) return;
    materials.value = result;
    if (chapter.value !== "all" && !chapters.value.some(item => item.id === chapter.value)) chapter.value = "all";
  } catch (reason) {
    if (!disposed && current === generation) error.value = reason instanceof Error ? reason.message : "资料加载失败";
  } finally {
    if (!disposed && current === generation) {
      loading.value = false;
      await nextTick();
      if (!disposed && current === generation && content.value) content.value.scrollTop = scrollPosition;
    }
  }
}, { immediate: true });
onBeforeUnmount(() => { saveView(); disposed = true; generation++; });
</script>
<style scoped>
.library-content { border: 0; border-radius: 0; }
.library-toolbar { align-items: center; gap: 10px; margin-bottom: 16px; }
.library-search { position: relative; flex: 1; min-width: min(240px, 100%); max-width: 480px; }
.library-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; color: var(--game-muted); pointer-events: none; }
.library-search > input { width: 100%; padding-left: 34px; }
.library-empty { padding: 32px 16px; }
.library-empty > svg { width: 28px; height: 28px; color: #9e8b68; }
.library-empty p { margin: 16px 0 20px; }
@media (max-width: 700px) { .library-search { max-width: none; flex-basis: 100%; } }
</style>
