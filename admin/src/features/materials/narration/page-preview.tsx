import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Network, RotateCcw, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { narrationApi } from "@/features/materials/narration/api";
import { useDraft } from "@/lib/drafts";
import { cleanGraphLabel } from "@/features/content-workspace/lectio-graph-layout";
import type { KnowledgePointItem } from "@/lib/lectio-api";
import type { usePageMedia } from "./use-page-media";
import type { useNarrationReview } from "./use-review";

function parseTags(raw: string): string[] {
  return raw
    .split(/[、,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(target.closest("[role='combobox'],[role='listbox'],[role='dialog']"));
}

export function NarrationSourceInspector({
  review,
  classroomId,
  materialId,
}: {
  review: ReturnType<typeof useNarrationReview>;
  classroomId: number;
  materialId: number;
}) {
  const { data, page, busy, run } = review;
  const digest = page?.digest ?? null;

  const savedTitle = digest?.title ?? page?.title ?? "";
  const savedTopic = digest?.topic ?? "";
  const savedTags = (digest?.tags ?? []).join("、");
  const savedText = digest?.text ?? "";

  const [title, setTitle] = useState(savedTitle);
  const [topic, setTopic] = useState(savedTopic);
  const [tagsText, setTagsText] = useState(savedTags);
  const [text, setText] = useState(savedText);

  useEffect(() => {
    setTitle(savedTitle);
    setTopic(savedTopic);
    setTagsText(savedTags);
    setText(savedText);
  }, [page?.page_no, savedTitle, savedTopic, savedTags, savedText]);

  const dirty =
    title !== savedTitle ||
    topic !== savedTopic ||
    tagsText !== savedTags ||
    text !== savedText;
  useDraft(dirty);

  if (!page || !data) return null;

  async function saveDigest() {
    if (!page || !text.trim() || busy) return;
    await run(
      "save-content",
      () =>
        narrationApi.saveContent(classroomId, materialId, page.page_no, {
          title: title.trim(),
          topic: topic.trim(),
          tags: parseTags(tagsText),
          text: text.trim(),
        }),
      "整理稿已保存",
    );
  }

  return (
    <aside
      aria-label="本页原文与整理稿"
      className="flex min-w-0 flex-col gap-2.5 rounded-md border bg-muted/15 p-3 text-sm lg:h-full lg:min-h-0 lg:overflow-y-auto overscroll-contain [scrollbar-width:thin]"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (dirty && text.trim()) void saveDigest();
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-b pb-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="font-semibold truncate">第 {page.page_no} 页整理稿</span>
          {digest?.source === "teacher" && (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
              已手改
            </Badge>
          )}
          {digest && digest.image_state !== "sent" && (
            <Badge
              variant="secondary"
              className="h-5 px-1.5 text-[10px]"
              title="整理这页时没有带页图，内容可能缺少图里的信息"
            >
              无图证据
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {dirty && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={Boolean(busy)}
              onClick={() => {
                setTitle(savedTitle);
                setTopic(savedTopic);
                setTagsText(savedTags);
                setText(savedText);
              }}
            >
              <RotateCcw /> 还原
            </Button>
          )}
          <Button
            type="button"
            size="xs"
            disabled={Boolean(busy) || !dirty || !text.trim()}
            onClick={() => void saveDigest()}
          >
            <Save /> {busy === "save-content" ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor="digest-title" className="text-xs text-muted-foreground">
            本页标题
          </Label>
          <Input
            id="digest-title"
            className="h-7 bg-background text-xs"
            value={title}
            maxLength={80}
            placeholder="本页主题标题"
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="digest-topic" className="text-xs text-muted-foreground">
            核心要点
          </Label>
          <Textarea
            id="digest-topic"
            rows={2}
            className="min-h-0 resize-y bg-background text-xs leading-relaxed"
            value={topic}
            maxLength={200}
            placeholder="一句话概括本页重点"
            onChange={(e) => setTopic(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="digest-tags" className="text-xs text-muted-foreground">
            标签（顿号或逗号分隔）
          </Label>
          <Input
            id="digest-tags"
            className="h-7 bg-background text-xs"
            value={tagsText}
            placeholder="例如：计算工具、计算思维"
            onChange={(e) => setTagsText(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="digest-text" className="text-xs text-muted-foreground">
              整理稿正文（{text.trim().length} 字）
            </Label>
            {dirty && <span className="text-[11px] text-amber-700">未保存</span>}
          </div>
          <Textarea
            id="digest-text"
            rows={7}
            className="bg-background text-xs leading-relaxed"
            value={text}
            maxLength={12000}
            placeholder="可点上方「一键梳理文本」生成，也可直接在此手工录入或编辑（Ctrl+S 保存）"
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      </div>

      <section className="space-y-1 border-t pt-2">
        <p className="text-xs font-medium text-muted-foreground">
          原始文本（{page.source_chars} 字）
        </p>
        <div className="max-h-36 overflow-y-auto rounded border bg-background p-2 text-xs leading-relaxed whitespace-pre-wrap break-words [scrollbar-width:thin]">
          {page.raw_text || page.source_text || "（无文本层，内容在页面图像里）"}
        </div>
      </section>
    </aside>
  );
}

export function NarrationPagePreview({
  review,
  media,
  layout = "stacked",
  pagePoints = [],
  totalMaterialPoints = 0,
  onOpenKnowledgeTab,
}: {
  review: ReturnType<typeof useNarrationReview>;
  media: ReturnType<typeof usePageMedia>;
  classroomId: number;
  materialId: number;
  layout?: "canvas" | "stacked";
  pagePoints?: KnowledgePointItem[];
  totalMaterialPoints?: number;
  onOpenKnowledgeTab?: () => void;
}) {
  const { data, setPageNo, page, previous, next } = review;
  const { imageFailed, setImageFailed, pageImage, pagePdf, pdfLoading } = media;
  const digest = page?.digest ?? null;
  const [jumpValue, setJumpValue] = useState("");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef({ previous, next, setPageNo });
  const wheelState = useRef({
    lastEventAt: 0,
    lastFlipAt: 0,
    lastEventDir: 0,
    lastFlipDir: 0,
    accum: 0,
    gestureConsumed: false,
  });

  const isCanvas = layout === "canvas";
  const hasStage = isCanvas && Boolean(page && data);

  useEffect(() => {
    navRef.current = { previous, next, setPageNo };
  }, [previous, next, setPageNo]);

  useEffect(() => {
    if (!isCanvas) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(event.target)) {
        return;
      }
      if ((event.key === "ArrowLeft" || event.key === "PageUp") && previous) {
        event.preventDefault();
        setPageNo(previous);
      } else if ((event.key === "ArrowRight" || event.key === "PageDown") && next) {
        event.preventDefault();
        setPageNo(next);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isCanvas, next, previous, setPageNo]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!hasStage || !stage) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      if (Math.abs(event.deltaY) < 1 || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      const target = event.target as HTMLElement | null;
      const scrollable = target?.closest("[data-slide-text-scroll='true']");
      if (scrollable && scrollable.scrollHeight > scrollable.clientHeight) return;
      event.preventDefault();

      const now = Date.now();
      const dir = event.deltaY > 0 ? 1 : -1;
      const state = wheelState.current;
      const sinceLastEvent = now - state.lastEventAt;
      state.lastEventAt = now;

      if (sinceLastEvent > 140 || dir !== state.lastEventDir) {
        state.accum = 0;
        state.gestureConsumed = false;
        state.lastEventDir = dir;
      }
      if (state.gestureConsumed) return;

      const cooldown = dir === state.lastFlipDir ? 300 : 120;
      if (now - state.lastFlipAt < cooldown) return;

      state.accum += event.deltaY;
      if (Math.abs(state.accum) < 30) return;

      const { next: nextNo, previous: prevNo, setPageNo: go } = navRef.current;
      const targetPage = dir > 0 ? nextNo : prevNo;
      state.accum = 0;
      state.gestureConsumed = true;
      state.lastFlipAt = now;
      state.lastFlipDir = dir;
      if (targetPage !== null) go(targetPage);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [hasStage]);

  if (!page || !data) return null;

  function commitJump() {
    if (!data) return;
    const target = Number(jumpValue.trim());
    if (Number.isInteger(target) && data.pages.some((item) => item.page_no === target)) {
      setPageNo(target);
      setJumpValue("");
    }
  }

  const jumpControl = (
    <div className="flex shrink-0 items-center gap-1">
      <Input
        type="text"
        inputMode="numeric"
        aria-label="跳到页码"
        className="h-7 w-14 shrink-0 px-2 text-center text-xs tabular-nums"
        placeholder="页码"
        value={jumpValue}
        onChange={(event) => setJumpValue(event.target.value.replace(/[^\d]/g, ""))}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commitJump();
        }}
      />
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={!jumpValue.trim()}
        onClick={commitJump}
      >
        跳页
      </Button>
    </div>
  );

  const stageBody = imageFailed ? (
    pagePdf ? (
      <iframe
        key={`${page.page_no}:${pagePdf}`}
        title={`第 ${page.page_no} 页课件预览`}
        src={`${pagePdf}#toolbar=0&navpanes=0&scrollbar=0&view=Fit`}
        className={
          isCanvas
            ? "h-[460px] w-full border-0 bg-background lg:h-full"
            : "h-[56vh] min-h-[340px] max-h-[520px] w-full rounded border-0 bg-background"
        }
      />
    ) : pdfLoading ? (
      <p className="hint px-4 text-center">正在加载第 {page.page_no} 页预览…</p>
    ) : page.source_text || page.raw_text ? (
      <div
        data-slide-text-scroll="true"
        className="h-full w-full self-start overflow-y-auto rounded bg-background p-4 text-sm leading-relaxed whitespace-pre-wrap"
      >
        <p className="mb-2 text-xs text-muted-foreground">
          当前资料尚未生成可视化页面预览，已展示本页课件文本（PPT 资料可切到「资料设置」点击「重新解析」生成幻灯片预览）：
        </p>
        {page.source_text || page.raw_text}
      </div>
    ) : (
      <p className="hint px-4 text-center">
        这一页没有可渲染的页面图像（文本资料或转换缺少预览）。
        <br />
        右侧仍可查看原文片段与讲解。
      </p>
    )
  ) : pageImage ? (
    <img
      src={pageImage}
      alt={`第 ${page.page_no} 页`}
      className={isCanvas ? "max-h-full max-w-full object-contain p-1.5 select-none" : "max-h-[60vh] w-auto max-w-full"}
      draggable={false}
      onError={() => setImageFailed(true)}
    />
  ) : (
    <p className="hint px-4 text-center">正在加载页面预览…</p>
  );

  if (isCanvas) {
    return (
      <div className="flex min-w-0 flex-col gap-1.5 lg:h-full lg:min-h-0 lg:overflow-hidden">
        <div className="flex shrink-0 items-center gap-1 text-xs">
          <Button
            size="xs"
            variant="ghost"
            disabled={!previous}
            onClick={() => previous && setPageNo(previous)}
          >
            <ChevronLeft /> 上一页
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!next}
            onClick={() => next && setPageNo(next)}
          >
            下一页 <ChevronRight />
          </Button>
          <span className="hint shrink-0 tabular-nums">
            第 {page.page_no} / {data.coverage.pages} 页
          </span>
          <span className="min-w-0 flex-1 truncate px-1 font-medium text-foreground/85">
            {digest?.title || page.title || ""}
          </span>
          <span className="hint hidden shrink-0 text-[11px] xl:inline">滚轮 / ← → 翻页</span>
          {jumpControl}
        </div>
        <div
          ref={stageRef}
          title="在此区域滚动鼠标滚轮可快速切换上 / 下一页"
          className="flex min-h-[360px] flex-1 items-center justify-center overflow-hidden rounded-md border bg-muted/25 lg:min-h-0"
        >
          {stageBody}
        </div>
        {(pagePoints.length > 0 || onOpenKnowledgeTab) && (
          <div
            aria-label="本页知识点"
            className="flex shrink-0 flex-wrap items-center gap-1.5 rounded-md border bg-muted/15 px-2.5 py-1.5 text-xs"
          >
            <span className="inline-flex shrink-0 items-center gap-1 font-medium text-muted-foreground">
              <Network size={13} className="text-primary" />
              本页知识点
            </span>
            {pagePoints.length > 0 ? (
              pagePoints.map((pt) => {
                const secLabel = pt.section.trim() ? cleanGraphLabel(pt.section) : "";
                const titleLabel = cleanGraphLabel(pt.title);
                return (
                  <button
                    key={pt.id}
                    type="button"
                    title={pt.brief || titleLabel}
                    onClick={onOpenKnowledgeTab}
                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-teal-300/80 bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-900 transition hover:bg-teal-100"
                  >
                    <span className="truncate">
                      {secLabel ? `${secLabel} · ${titleLabel}` : titleLabel}
                    </span>
                  </button>
                );
              })
            ) : totalMaterialPoints > 0 ? (
              <span className="text-muted-foreground">
                本页未单独标注
                {onOpenKnowledgeTab && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={onOpenKnowledgeTab}
                    >
                      查看本课件全部 {totalMaterialPoints} 个知识点
                    </button>
                  </>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">
                本课件暂未抽取知识点
                {onOpenKnowledgeTab && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={onOpenKnowledgeTab}
                    >
                      前往抽取
                    </button>
                  </>
                )}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button
          size="sm"
          variant="ghost"
          disabled={!previous}
          onClick={() => previous && setPageNo(previous)}
        >
          <ChevronLeft /> 上一页
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!next}
          onClick={() => next && setPageNo(next)}
        >
          下一页 <ChevronRight />
        </Button>
        <span className="hint">
          第 {page.page_no} / {data.coverage.pages} 页
        </span>
        <div className="ml-auto">{jumpControl}</div>
      </div>
      <div className="space-y-1 rounded border p-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">
            {digest?.title || page.title || `第 ${page.page_no} 页`}
          </span>
          {digest?.topic && <span className="hint">{digest.topic}</span>}
          {digest && digest.image_state !== "sent" && (
            <Badge
              variant="secondary"
              title="整理这页时没有带页图，内容可能缺少图里的信息"
            >
              本页无图证据
            </Badge>
          )}
        </div>
        {digest?.tags?.length ? (
          <p className="hint">标签：{digest.tags.join("、")}</p>
        ) : null}
        {!digest && (
          <p className="hint">
            这页还没有整理稿，点「一键梳理文本」生成；未整理时讲解会退回解析原文。
          </p>
        )}
      </div>
      <div className="flex max-h-[62vh] min-h-[280px] items-center justify-center overflow-hidden rounded border bg-muted/30 p-2">
        {stageBody}
      </div>
      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <section className="min-w-0 space-y-1 rounded border p-2">
          <p className="font-medium">整理稿（{digest?.text.length ?? 0} 字）</p>
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs">
            {digest?.text || "（这页还没有整理稿）"}
          </pre>
        </section>
        <section className="min-w-0 space-y-1 rounded border p-2">
          <p className="font-medium">原始文本（{page.source_chars} 字）</p>
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs">
            {page.raw_text || page.source_text || "（无文本层，内容在页面图像里）"}
          </pre>
        </section>
      </div>
    </div>
  );
}
