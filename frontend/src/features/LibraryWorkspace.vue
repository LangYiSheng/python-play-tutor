<template>
  <section class="town-workspace library-workspace">
    <div class="town-book">
      <aside class="town-sidebar library-sidebar">
        <p class="library-directory-label game-card-title"><GameIcon name="book"/>章节目录</p>
        <nav class="town-directory" aria-label="资料章节">
          <button class="town-directory-item" :class="{ 'is-current': chapter === 'all' }" :aria-pressed="chapter === 'all'" @click="selectChapter('all')">
            <GameIcon name="grid"/><span>全部章节</span><small>{{ materials.length }}</small>
          </button>
          <button v-for="item in chapters" :key="item.id" class="town-directory-item" :class="{ 'is-current': chapter === item.id }" :aria-pressed="chapter === item.id" @click="selectChapter(item.id)">
            <ChapterNumber v-if="item.number != null" :number="item.number"/><GameIcon v-else name="book"/>
            <span>{{ item.title }}</span><small>{{ item.materials.length }}</small>
          </button>
        </nav>
      </aside>
      <main ref="content" class="town-content library-content" :aria-busy="loading">
        <div class="town-toolbar library-toolbar">
          <label class="town-field library-search"><span>搜索资料</span><input v-model="query" type="search" placeholder="搜索资料名称或章节" autocomplete="off" @input="resetScroll"/></label>
          <span class="library-result-count" role="status" aria-live="polite">{{ filteredCount }} 份资料</span>
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-else-if="loading" class="town-empty" role="status">正在加载资料…</p>
        <template v-else>
          <ChapterCardGroup v-for="group in filteredChapters" :key="group.id" :number="group.number" :title="group.title" :heading-id="`library-chapter-${group.id}`" :summary="group.readingProgress">
            <ChapterContentCard v-for="material in group.materials" :key="material.id" :title="material.title"
              :icon="material.kind === 'video' ? 'video' : 'book'" :badge="group.tasks.get(material.id)?.required ? '必读' : undefined"
              :disabled="material.status !== 'ready'" @click="open(material, group.id)"
              :action="material.status === 'ready' ? material.kind === 'video' ? '观看' : '阅读' : material.status === 'failed' ? '处理失败' : '处理中'">
              {{ kindLabels[material.kind] ?? '课程资料' }}<template v-if="group.tasks.has(material.id)">{{ group.tasks.get(material.id)!.required ? '' : ' · 选读' }} · {{ taskProgress(group.tasks.get(material.id)!) }}</template><template v-if="duration(material)"> · {{ duration(material) }}</template>
            </ChapterContentCard>
          </ChapterCardGroup>
          <div v-if="!filteredCount" class="town-empty library-empty"><GameIcon name="book"/><p>{{ materials.length ? '没有找到匹配的资料' : '当前班级还没有开放资料' }}</p><button v-if="materials.length" class="town-secondary" @click="clearFilters">清除筛选</button></div>
        </template>
      </main>
    </div>
  </section>
</template>
<script setup lang="ts">
import ChapterNumber from "../shared/ChapterNumber.vue";
import ChapterCardGroup from "./ChapterCardGroup.vue";
import ChapterContentCard from "./ChapterContentCard.vue";
import { taskProgress } from "../shared/chapterTasks";
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
    const readingProgress = !required.length ? "无必读资料" : required.length === 1
      ? `必读进度 · ${taskProgress(required[0]!)}`
      : `必读已完成 ${required.filter(task => task.completed).length} / ${required.length} 份`;
    return { id, number: details?.order_index, title: details?.title ?? "其他资料", order: details?.order_index ?? Number.MAX_SAFE_INTEGER, tasks, readingProgress,
      materials: items.sort((a, b) => entries.findIndex(t => t.material_id === a.id) - entries.findIndex(t => t.material_id === b.id)) };
  }).sort((a, b) => a.order - b.order || a.id - b.id);
});
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
.library-directory-label { margin:0 0 12px; color:var(--game-muted); font-size:.875rem; letter-spacing:.04em; }
.library-sidebar .town-directory-item { display:grid; grid-template-columns:22px minmax(0,1fr) auto; align-items:center; gap:8px; text-align:left; }
.library-sidebar .town-directory-item > span:nth-child(2) { line-height:1.6; }
.library-sidebar .town-directory-item > small { align-self:center; font-size:.875rem; opacity:.7; }
.library-sidebar .town-directory-item > svg { width:16px; height:16px; }
.library-toolbar { align-items:flex-end; gap:10px; margin-bottom:16px; }
.library-search { flex:1; min-width:min(240px,100%); max-width:520px; }
.library-search > span { display:block; margin-bottom:8px; font-size:.875rem; color:#76604c; }
.library-search > input { width:100%; }
.library-result-count { align-self:center; margin-left:auto; padding-top:22px; font-size:.875rem; color:#8a775c; white-space:nowrap; }
.library-empty { padding:32px 16px; }
.library-empty > svg { width:28px; height:28px; color:#9e8b68; }
.library-empty p { margin:16px 0 20px; }
@media(max-width:1000px) { .library-toolbar { gap:14px; }.library-result-count { padding-top:0; } }
@media(max-width:700px) { .library-directory-label { display:none; }.library-sidebar .town-directory-item { display:flex; align-items:center; min-width:max-content; }.library-sidebar .town-directory-item > span:nth-child(2) { max-width:200px; white-space:normal; }.library-sidebar .town-directory-item > svg { display:none; }.library-search { max-width:none; flex-basis:100%; }.library-toolbar { margin-bottom:16px; }.library-result-count { margin-left:auto; } }
</style>
