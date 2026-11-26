import { computed, onBeforeUnmount, ref } from "vue";
import { api } from "../../shared/api";
import {
  migrateReadingPosition,
  pdfResumePage,
} from "../../shared/readingPosition";
import type { Material } from "../../shared/types";

interface LessonSourceContext {
  userId: number | undefined;
  classroomId: number | null;
  currentOwner: () => boolean;
  materialId: () => number;
  initialPage: () => number | undefined;
  beforeLoad: () => void;
  ready?: () => void;
}

/** Owns the current reading source, resume position and private media lifetime. */
export function useLessonSource(context: LessonSourceContext) {
  const material = ref<Material>();
  const loading = ref(true);
  const error = ref("");
  const pageIndex = ref(0);
  const pdfPage = ref(1);
  const mediaBlob = ref("");
  const mediaError = ref("");
  let generation = 0;
  let citationGeneration = 0;
  let disposed = false;
  let mediaController: AbortController | undefined;
  const currentOwner = () => !disposed && context.currentOwner();
  const current = (request: number) => currentOwner() && request === generation;
  const currentPage = computed(() => material.value?.pages[pageIndex.value]);
  const readingKey = computed(
    () =>
      `read:${context.userId}:${context.classroomId}:${`material-${material.value?.id ?? context.materialId()}`}`,
  );
  const fileUrl = computed(() =>
    material.value
      ? `/materials/${material.value.id}/file?classroom_id=${context.classroomId}`
      : "",
  );

  function releaseMedia() {
    mediaController?.abort();
    mediaController = undefined;
    if (mediaBlob.value) URL.revokeObjectURL(mediaBlob.value);
    mediaBlob.value = "";
    mediaError.value = "";
  }

  function selectPage(page: number) {
    const index =
      material.value?.pages.findIndex((item) => item.page_no === page) ?? -1;
    if (index >= 0) pageIndex.value = index;
    pdfPage.value = page;
  }

  function restorePosition(initial = false) {
    if (
      material.value &&
      context.userId !== undefined &&
      context.classroomId !== null
    )
      migrateReadingPosition(
        sessionStorage,
        context.userId,
        context.classroomId,
        material.value.id,
      );
    const saved = Number(sessionStorage.getItem(readingKey.value) ?? 0);
    const resumePage = (initial ? context.initialPage() : undefined);
    const requested = resumePage
      ? (material.value?.pages.findIndex(
          (page) => page.page_no === resumePage,
        ) ?? 0)
      : saved;
    pageIndex.value = Math.min(
      Math.max(0, Number.isFinite(requested) ? requested : 0),
      Math.max(0, (material.value?.pages.length ?? 1) - 1),
    );
    pdfPage.value = pdfResumePage(
      material.value?.pages ?? [],
      resumePage,
      sessionStorage.getItem(`${readingKey.value}:pdf`),
      pageIndex.value,
    );
  }

  async function loadMedia(request: number) {
    if (material.value?.kind !== "video") return;
    mediaController = new AbortController();
    try {
      const blob = await api.blob(fileUrl.value, mediaController.signal);
      if (current(request)) mediaBlob.value = URL.createObjectURL(blob);
    } catch (cause) {
      if (current(request))
        mediaError.value =
          cause instanceof Error ? cause.message : "视频不可用";
    }
  }

  async function load() {
    const request = ++generation;
    citationGeneration++;
    context.beforeLoad();
    loading.value = true;
    error.value = "";
    releaseMedia();
    try {
      const loaded = await api.get<Material>(`/materials/${context.materialId()}?classroom_id=${context.classroomId}`);
      if (!current(request)) return;
      material.value = loaded;
      restorePosition(true);
      await loadMedia(request);
    } catch (cause) {
      if (current(request))
        error.value = cause instanceof Error ? cause.message : "课程读取失败";
    } finally {
      if (current(request)) {
        loading.value = false;
        context.ready?.();
      }
    }
  }

  async function showCitation(id: number, page: number) {
    const request = generation;
    const citation = ++citationGeneration;
    if (id !== material.value?.id) {
      const loaded = await api.get<Material>(
        `/materials/${id}?classroom_id=${context.classroomId}`,
      );
      if (!current(request) || citation !== citationGeneration) return false;
      context.beforeLoad();
      releaseMedia();
      material.value = loaded;
      await loadMedia(request);
    }
    if (!current(request) || citation !== citationGeneration) return false;
    selectPage(page);
    return true;
  }

  onBeforeUnmount(() => {
    disposed = true;
    generation++;
    releaseMedia();
  });
  return {
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
    generation: () => generation,
    load,
    selectPage,
    showCitation,
  };
}
