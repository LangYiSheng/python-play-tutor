<template>
  <div class="pdf-reader" :aria-busy="loading || rendering">
    <div class="pdf-page-surface" :class="{ 'with-narration': materialId && hasNarration }">
      <GamePanelHeader class="reader-card-title" :title="kind === 'presentation' ? 'PPT 浏览' : 'PDF 浏览'" icon="description" heading />
      <div ref="stage" class="pdf-page-stage">
        <canvas
          v-show="rendered && !error"
          ref="canvas"
          aria-label="PDF课件当前页"
          aria-describedby="pdf-reading-position"
          role="img"
        ></canvas>
      </div>
      <LectureStage v-if="materialId" :key="materialId" @availability="hasNarration = $event" :material-id="materialId" :page-no="page" :total-pages="count" :page-ready="rendered && !rendering && !loading && !error" @page="emit('page', $event)" @timeline="emit('timeline', $event)" />
      <div v-if="error" class="pdf-reader-state" role="alert">
        <p>{{ error }}</p>
        <button @click="load">重新加载课件</button>
      </div>
      <p v-else-if="loading" class="pdf-reader-state" role="status">
        正在加载 PDF 课件…
      </p>
    </div>
    <nav class="reader-toolbar pdf-pagination" aria-label="PDF 分页">
      <button
        :disabled="loading || page <= 1"
        aria-label="上一页 PDF"
        @click="turn(-1)"
      >
        <GameIcon name="arrowLeft" /> 上一页
      </button>
      <div id="pdf-reading-position" class="reader-position" aria-live="polite">
        <span class="pdf-document-title" :title="title">{{ title || "PDF 课件" }}</span>
        <span>第 <strong>{{ page }}</strong> / {{ loading ? "…" : count }} 页</span>
        <progress class="reader-position-progress" :value="loading ? 0 : page" :max="count" aria-label="阅读位置" :aria-valuetext="`第 ${page} / ${count} 页`" />
      </div>
      <button
        :disabled="loading || page >= count"
        aria-label="下一页 PDF"
        @click="turn(1)"
      >
        下一页 <GameIcon name="arrowRight" />
      </button>
    </nav>
  </div>
</template>
<script setup lang="ts">
import LectureStage from "./LectureStage.vue";
import type { LectureSegment } from "../../shared/lectureTimeline";
import GameIcon from "../../shared/GameIcon.vue";
import GamePanelHeader from "../../shared/GamePanelHeader.vue";
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { api } from "../../shared/api";
import { pdfCache } from "../../shared/pdfCache";
import { fitPdfPage } from "../../shared/pdfPageLayout";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import "./pdfReader.css";

const hasNarration = ref(false);

const props = defineProps<{ url: string; page: number; title?: string; kind?: string; materialId?: number }>(),
  emit = defineEmits<{ page: [value: number]; ready: [page: number | null]; timeline: [value: LectureSegment[]] }>(),
  canvas = ref<HTMLCanvasElement>(),
  stage = ref<HTMLElement>(),
  count = ref(1),
  error = ref(""),
  loading = ref(true),
  rendering = ref(false),
  rendered = ref(false);
let doc: PDFDocumentProxy | undefined,
  docUrl = "",
  documentTask: PDFDocumentLoadingTask | undefined,
  task: RenderTask | undefined,
  resizeObserver: ResizeObserver | undefined,
  resizeFrame = 0,
  lastSize = "",
  loadGeneration = 0,
  renderGeneration = 0,
  disposed = false;

function ignoreCancellation(error: unknown) {
  return error instanceof Error && ["AbortError", "RenderingCancelledException"].includes(error.name);
}
async function fileSize(url: string, headers: Record<string, string>) {
  try {
    const response = await fetch(url, { headers: { ...headers, Range: "bytes=0-0" } });
    const total = Number(response.headers.get("content-range")?.split("/").pop());
    void response.body?.cancel().catch(() => undefined);
    return Number.isFinite(total) && total > 0 ? total : Number(response.headers.get("content-length")) || 0;
  } catch {
    return 0;
  }
}
async function load() {
  const generation = ++loadGeneration;
  ++renderGeneration;
  task?.cancel();
  task = undefined;
  const previousUrl = docUrl;
  const previous = doc;
  doc = undefined;
  docUrl = "";
  if (previous) pdfCache.release(previousUrl);
  void documentTask?.destroy().catch(() => undefined);
  documentTask = undefined;
  loading.value = true;
  rendering.value = false;
  rendered.value = false;
  error.value = "";
  const current = () => !disposed && generation === loadGeneration;
  try {
    const [{ getDocument, GlobalWorkerOptions }, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);
    if (!current()) return;
    GlobalWorkerOptions.workerSrc = worker.default;
    const token = api.token();
    const url = props.url.startsWith("/api") ? props.url : `/api${props.url}`;
    const httpHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;
    const total = pdfCache.has(url) ? 0 : await fileSize(url, httpHeaders ?? {});
    const loaded = await pdfCache.acquire(url, () => {
      const pending = getDocument({
        url,
        length: total || undefined,
        isEvalSupported: false,
        httpHeaders,
        // PDF.js 的说明：关闭流式读取后，disableAutoFetch 才会真正按需取 Range。
        // 首屏只拉当前页所需的 256 KiB 区块，不再整份下载后交给 pdf.js。
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: 256 * 1024,
      });
      documentTask = pending;
      return pending.promise;
    }, total);
    documentTask = undefined;
    if (!current()) {
      pdfCache.release(url);
      return;
    }
    doc = loaded;
    docUrl = url;
    count.value = loaded.numPages;
    const valid = Math.min(count.value, Math.max(1, props.page));
    if (valid !== props.page) emit("page", valid);
    await render();
  } catch (cause) {
    if (current() && !ignoreCancellation(cause))
      error.value = cause instanceof Error ? cause.message : "PDF加载失败";
  } finally {
    if (current()) loading.value = false;
  }
}
async function render() {
  if (!doc || !canvas.value || !stage.value) return;
  const generation = ++renderGeneration,
    document = doc,
    previous = task;
  task = undefined;
  previous?.cancel();
  emit("ready", null);
  rendering.value = true;
  rendered.value = false;
  const current = () => !disposed && generation === renderGeneration && document === doc;
  try {
    // PDF.js must finish cancelling before reusing the same canvas.
    await previous?.promise.catch(() => undefined);
    if (!current()) return;
    const page = await document.getPage(Math.min(Math.max(1, props.page), document.numPages));
    if (!current() || !canvas.value || !stage.value) return;
    const natural = page.getViewport({ scale: 1 }),
      fitted = fitPdfPage(natural.width, natural.height, stage.value.clientWidth, stage.value.clientHeight, window.devicePixelRatio);
    // Hidden tabs have no dimensions; their ResizeObserver renders on reveal.
    if (!fitted) return;
    const view = page.getViewport({ scale: fitted.renderScale }),
      context = canvas.value.getContext("2d");
    if (!context) throw new Error("无法显示课件，请重新加载。");
    canvas.value.width = Math.ceil(view.width);
    canvas.value.height = Math.ceil(view.height);
    canvas.value.style.width = `${fitted.width}px`;
    canvas.value.style.height = `${fitted.height}px`;
    error.value = "";
    const pending = page.render({ canvasContext: context, viewport: view });
    task = pending;
    await pending.promise;
    if (current()) {rendered.value = true; emit("ready", props.page);}
  } catch (cause) {
    if (current() && !ignoreCancellation(cause))
      error.value = cause instanceof Error ? cause.message : "课件显示失败";
  } finally {
    if (current()) rendering.value = false;
  }
}
function turn(delta: number) {
  emit("page", Math.min(count.value, Math.max(1, props.page + delta)));
}
watch(() => props.page, render);
watch(() => props.url, load);
onMounted(() => {
  if (typeof ResizeObserver !== "undefined" && stage.value) {
    resizeObserver = new ResizeObserver((entries) => {
      const size = entries[0]?.contentRect,
        key = `${Math.floor(size?.width ?? 0)}:${Math.floor(size?.height ?? 0)}`;
      if (key === lastSize) return;
      lastSize = key;
      cancelAnimationFrame(resizeFrame);
      if (size && size.width > 0 && size.height > 0)
        resizeFrame = requestAnimationFrame(() => void render());
    });
    resizeObserver.observe(stage.value);
  }
  void load();
});
onBeforeUnmount(() => {
  disposed = true;
  ++loadGeneration;
  ++renderGeneration;
  if (doc && docUrl) pdfCache.release(docUrl);
  doc = undefined;
  docUrl = "";
  task?.cancel();
  resizeObserver?.disconnect();
  cancelAnimationFrame(resizeFrame);
  void documentTask?.destroy().catch(() => undefined);
});
</script>
