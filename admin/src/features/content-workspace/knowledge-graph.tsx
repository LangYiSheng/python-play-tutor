import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardCheck,
  Download,
  GitBranch,
  LayoutList,
  ListTodo,
  Orbit,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { Empty, ErrorNotice, Loading } from "@/components/common";
import { ContentDeleteDialog } from "@/components/content-delete-dialog";
import { SelectField } from "@/components/select-field";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { errorMessage, scoped } from "@/lib/api";
import { courseStudioApi, useCourseStudioJobs, type KnowledgeOverview, type KnowledgePointItem, type CourseStudioJob } from "@/lib/course-studio-api";
import { ContentActionDialog, type ContentAction } from "./action-dialog";
import type { GraphData } from "./graph-layout";
import { KnowledgeExtractDialog } from "./knowledge-extract-dialog";
import { KnowledgeListView } from "./knowledge-list-view";
import { StudioGraphCanvas } from "./studio-graph-canvas";
import { StudioGraphInspector } from "./studio-graph-inspector";
import { buildKnowledgeTree, cleanGraphLabel, type GNode } from "./studio-graph-layout";
import { StudioJobList } from "./studio-job-list";
import type { TaskSnapshot } from "./task-presentation";
import { useGraphData } from "./use-graph-data";
import "./inspector-content.css";
import "./studio-graph.css";

const ContentReviewPanel = lazy(() =>
  import("@/pages/content-review").then((m) => ({ default: m.ContentReviewPanel })),
);

type ReviewBookmark = { materialId?: number };
type GraphProps = { courseId: number; initialReview?: ReviewBookmark };
type ViewMode = "tree" | "radial" | "list";
type SideOverlay = "review" | "tasks" | null;

const VIEW_STORAGE_KEY = "courseStudio.graphView";

function readInitialView(): ViewMode {
  if (new URLSearchParams(location.search).get("view") === "list") return "list";
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "radial" ? "radial" : "tree";
  } catch {
    return "tree";
  }
}

export function KnowledgeGraph({ courseId, initialReview }: GraphProps) {
  return <GraphPage key={courseId} courseId={courseId} initialReview={initialReview} />;
}

function GraphPage({ courseId, initialReview }: GraphProps) {
  const [viewMode, setViewMode] = useState<ViewMode>(readInitialView);
  const [scope, setScope] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string>("");
  const [overlay, setOverlay] = useState<SideOverlay>(initialReview ? "review" : null);
  const [reviewScope, setReviewScope] = useState(initialReview);
  const [bookmarkNotice, setBookmarkNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [reviewRevision, setReviewRevision] = useState(0);
  const [action, setAction] = useState<ContentAction | null>(null);
  const [extractingChapterId, setExtractingChapterId] = useState<number | null>(null);
  const [extractOpen, setExtractOpen] = useState(false);
  const [deletingPoint, setDeletingPoint] = useState<KnowledgePointItem | null>(null);
  const [exportingGraph, setExportingGraph] = useState(false);

  const panelRef = useRef<HTMLElement>(null);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);

  const endpoint = (suffix: string) => scoped("/teacher/course-graph" + suffix, courseId);
  const catalog = useGraphData<GraphData>(endpoint(""), revision);
  const overview = useGraphData<KnowledgeOverview>(
    `/teacher/courses/${courseId}/course-studio/knowledge`,
    revision,
  );
  const pending = useGraphData<{ material_count: number; question_count: number }>(
    `/teacher/courses/${courseId}/content-review/summary`,
    revision + reviewRevision,
  );
  const pipelineTasks = useGraphData<TaskSnapshot[]>(endpoint("/tasks"), revision, 4000);
  const activePipelineKeys = useRef<Set<string>>(new Set());
  useEffect(() => {
    const jobs = Array.isArray(pipelineTasks?.data) ? pipelineTasks.data : [];
    const current = new Set(
      jobs
        .filter((job) => job.kind === "pipeline" && (job.running || job.queued))
        .map((job) => `${job.material_id}:${job.started_at ?? ""}`),
    );
    let finishedAny = false;
    for (const prevKey of activePipelineKeys.current) {
      if (!current.has(prevKey)) {
        finishedAny = true;
        break;
      }
    }
    activePipelineKeys.current = current;
    if (finishedAny) {
      refresh();
    }
  }, [pipelineTasks?.data, refresh]);
  const handleJobDone = useCallback(
    (job: CourseStudioJob) => {
      refresh();
      if (job.kind === "knowledge_extract") {
        const created = typeof job.result?.created === "number" ? job.result.created : null;
        const updated = typeof job.result?.updated === "number" ? job.result.updated : 0;
        const msg =
          created !== null
            ? `AI 知识图谱已更新（新增 ${created} 个知识点${updated > 0 ? `，更新 ${updated} 个` : ""}）`
            : "AI 知识图谱抽取完成，已刷新图谱";
        toast.add({ title: msg, type: "success" });
      }
    },
    [refresh],
  );
  const studioJobs = useCourseStudioJobs(courseId, handleJobDone);

  useEffect(() => {
    const updateCount = () => setReviewRevision((n) => n + 1);
    window.addEventListener("focus", updateCount);
    return () => window.removeEventListener("focus", updateCount);
  }, []);

  useEffect(() => {
    const id = reviewScope?.materialId;
    if (!id || overlay !== "review" || !catalog?.data) return;
    const deck = catalog.data.materials.find((m) => m.id === id);
    const timer = window.setTimeout(() => {
      setReviewScope({});
      history.replaceState({ ...history.state, initialReview: {} }, "");
      if (deck && ["presentation", "pdf"].includes(deck.kind)) {
        setAction({ kind: "material", mode: "narration", id });
      } else {
        setBookmarkNotice("这份资料在当前课程无法审校。");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reviewScope, overlay, catalog?.data]);

  const chapters = useMemo(() => overview?.data?.chapters ?? [], [overview?.data]);
  const courseTitle = catalog?.data?.title || "课程知识图谱";
  const totalPoints = useMemo(
    () => chapters.reduce((acc, ch) => acc + ch.points.length, 0),
    [chapters],
  );
  const treeRoot = useMemo(
    () => buildKnowledgeTree(overview?.data ?? null, courseTitle, scope),
    [overview?.data, courseTitle, scope],
  );

  const selectedNode = useMemo<GNode | null>(() => {
    if (!treeRoot || !selectedId) return null;
    const find = (n: GNode): GNode | null => {
      if (n.id === selectedId) return n;
      for (const child of n.children) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    return find(treeRoot);
  }, [treeRoot, selectedId]);

  const graphJobs = useMemo(
    () => studioJobs.jobs.filter((j) => j.kind === "knowledge_extract"),
    [studioJobs.jobs],
  );
  const activeGraphJobs = useMemo(
    () => graphJobs.filter((j) => j.status === "queued" || j.status === "running").length,
    [graphJobs],
  );
  const pendingEntries =
    pending?.data && pending.data.material_count + Number(pending.data.question_count > 0);
  const totalTaskCount = activeGraphJobs > 0 ? activeGraphJobs : graphJobs.length;

  function changeViewMode(next: ViewMode) {
    setViewMode(next);
    if (next === "tree" || next === "radial") {
      try {
        localStorage.setItem(VIEW_STORAGE_KEY, next);
      } catch {
        // ignore storage errors
      }
    }
    const url = new URL(location.href);
    if (next === "list") url.searchParams.set("view", "list");
    else url.searchParams.delete("view");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }

  async function extractForChapter(chapterId: number) {
    setExtractingChapterId(chapterId);
    try {
      await courseStudioApi.extractKnowledge(courseId, chapterId);
      toast.add({ title: "已提交 AI 知识点抽取任务", type: "success" });
      studioJobs.refresh();
      setOverlay("tasks");
    } catch (e) {
      toast.add({ title: errorMessage(e), type: "error" });
    } finally {
      setExtractingChapterId(null);
    }
  }

  async function exportGraph(fmt: "xmind" | "xlsx" | "docx") {
    setExportingGraph(true);
    try {
      const scopeChapterId = scope !== "all" ? Number(scope) : undefined;
      const scopeChapter = scopeChapterId ? chapters.find((c) => c.id === scopeChapterId) : undefined;
      await courseStudioApi.exportKnowledge(
        courseId,
        fmt,
        scopeChapterId,
        scopeChapter ? scopeChapter.title : courseTitle,
      );
      toast.add({ title: "图谱导出已开始", type: "success" });
    } catch (e) {
      toast.add({ title: errorMessage(e), type: "error" });
    } finally {
      setExportingGraph(false);
    }
  }

  const showSidePanel = viewMode !== "list" || overlay !== null;
  const bodyClass =
    viewMode === "list"
      ? `lg-body lg-list-mode${overlay ? " lg-list-with-panel" : ""}`
      : "lg-body";

  return (
    <>
      <section className="lg-workspace" aria-label="课程知识图谱">
        <header className="lg-toolbar">
          <div className="lg-toolbar-left">
            <div className="lg-title-group">
              <h1>知识图谱</h1>
              {overview?.data && (
                <span className="lg-title-stats">
                  {chapters.length} 章 · {totalPoints} 知识点
                </span>
              )}
            </div>
            {viewMode !== "list" && chapters.length > 0 && (
              <SelectField
                aria-label="图谱章节范围"
                value={scope}
                onValueChange={(v) => {
                  setScope(v);
                  setSelectedId("");
                }}
              >
                <option value="all">整门课程（{chapters.length} 章）</option>
                {chapters.map((ch) => (
                  <option key={ch.id} value={String(ch.id)}>
                    {cleanGraphLabel(ch.title)}
                  </option>
                ))}
              </SelectField>
            )}
            <div className="inline-flex rounded-md border bg-background p-0.5" role="group" aria-label="视图切换">
              <Button
                size="xs"
                variant={viewMode === "tree" ? "secondary" : "ghost"}
                aria-pressed={viewMode === "tree"}
                onClick={() => changeViewMode("tree")}
              >
                <GitBranch /> 树形
              </Button>
              <Button
                size="xs"
                variant={viewMode === "radial" ? "secondary" : "ghost"}
                aria-pressed={viewMode === "radial"}
                onClick={() => changeViewMode("radial")}
              >
                <Orbit /> 环形
              </Button>
              <Button
                size="xs"
                variant={viewMode === "list" ? "secondary" : "ghost"}
                aria-pressed={viewMode === "list"}
                onClick={() => changeViewMode("list")}
              >
                <LayoutList /> 列表
              </Button>
            </div>
          </div>

          <div className="lg-toolbar-right">
            <Button
              size="sm"
              disabled={chapters.length === 0}
              onClick={() => setExtractOpen(true)}
            >
              <Sparkles /> AI 生成知识图谱
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setAction({
                  kind: "point",
                  mode: "create",
                  chapterId: scope !== "all" ? Number(scope) : chapters[0]?.id,
                })
              }
            >
              <Plus /> 新增知识点
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={exportingGraph} />}>
                <Download /> 导出图谱
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void exportGraph("xmind")}>
                  XMind 思维导图 (.xmind)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void exportGraph("xlsx")}>
                  学习通知识图谱表格 (.xlsx)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void exportGraph("docx")}>
                  Word 大纲 (.docx)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant={overlay === "review" ? "secondary" : "outline"}
              size="sm"
              aria-expanded={overlay === "review"}
              onClick={() => setOverlay((cur) => (cur === "review" ? null : "review"))}
            >
              <ClipboardCheck />
              待审批{pendingEntries !== undefined ? ` ${pendingEntries} 项` : ""}
            </Button>

            <Button
              variant={overlay === "tasks" ? "secondary" : "outline"}
              size="sm"
              aria-expanded={overlay === "tasks"}
              onClick={() => setOverlay((cur) => (cur === "tasks" ? null : "tasks"))}
            >
              <ListTodo />
              抽取任务{activeGraphJobs > 0 ? ` 进行中 ${activeGraphJobs}` : totalTaskCount > 0 ? ` ${totalTaskCount} 项` : ""}
            </Button>
          </div>
        </header>

        <div className={bodyClass}>
          {viewMode === "list" ? (
            <KnowledgeListView
              courseId={courseId}
              revision={revision}
              onAddPoint={(cid) => setAction({ kind: "point", mode: "create", chapterId: cid })}
              onEditPoint={(pid) => setAction({ kind: "point", mode: "edit", id: pid })}
              onExtractChapter={() => {
                studioJobs.refresh();
                setOverlay("tasks");
              }}
              onRefresh={refresh}
            />
          ) : overview?.error ? (
            <div className="flex flex-col items-center justify-center gap-3 p-8">
              <ErrorNotice message={overview.error} />
              <Button variant="outline" onClick={refresh}>
                重新加载
              </Button>
            </div>
          ) : !overview?.data ? (
            <div className="flex items-center justify-center p-8">
              <Loading />
            </div>
          ) : !treeRoot ? (
            <div className="flex items-center justify-center p-8">
              <Empty
                title="暂无课程章节与知识点"
                description="请先在「章节与课件」创建章节并上传 PPT/PDF，再回到这里抽取或添加知识点。"
              />
            </div>
          ) : (
            <StudioGraphCanvas
              root={treeRoot}
              mode={viewMode}
              selectedId={selectedId}
              onSelect={(node) => {
                setOverlay(null);
                setSelectedId((prev) => (prev === node.id ? "" : node.id));
                panelRef.current?.scrollTo?.(0, 0);
              }}
            />
          )}

          {showSidePanel && (
            <aside ref={panelRef} className="lg-panel" aria-label={overlay === "review" ? "待审批" : overlay === "tasks" ? "知识图谱抽取任务" : "知识点详情"}>
              {overlay === "review" ? (
                <>
                  <div className="flex items-center justify-between border-b pb-2">
                    <strong className="text-sm">待审批</strong>
                    <Button size="icon-xs" variant="ghost" aria-label="关闭待审批" onClick={() => setOverlay(null)}>
                      <X />
                    </Button>
                  </div>
                  <Suspense fallback={<Loading />}>
                    {bookmarkNotice && (
                      <p className="text-xs text-muted-foreground" role="status">
                        {bookmarkNotice}
                      </p>
                    )}
                    <ContentReviewPanel
                      courseId={courseId}
                      revision={revision + reviewRevision}
                      onOpenMaterial={(id, pageNo) => setAction({ kind: "material", mode: "narration", id, pageNo })}
                    />
                  </Suspense>
                </>
              ) : overlay === "tasks" ? (
                <>
                  <div className="flex items-center justify-between border-b pb-2">
                    <strong className="text-sm">知识图谱抽取任务</strong>
                    <Button size="icon-xs" variant="ghost" aria-label="关闭抽取任务" onClick={() => setOverlay(null)}>
                      <X />
                    </Button>
                  </div>
                  {studioJobs.error ? (
                    <ErrorNotice message={studioJobs.error} />
                  ) : graphJobs.length === 0 ? (
                    <Empty
                      title="暂无知识图谱抽取任务"
                      description="点击上方「AI 生成知识图谱」或右侧章节「AI 抽取」后，这里会展示抽取进度。语音合成与课件梳理任务请在「章节与课件」查看。"
                    />
                  ) : (
                    <StudioJobList jobs={graphJobs} onCancel={studioJobs.cancel} />
                  )}
                </>
              ) : (
                <StudioGraphInspector
                  courseId={courseId}
                  courseTitle={courseTitle}
                  overview={overview?.data ?? null}
                  selected={selectedNode}
                  extractingChapterId={extractingChapterId}
                  onSelectNode={(node) => setSelectedId(node.id)}
                  onSelectChapterScope={(cid) => {
                    setScope(String(cid));
                    setSelectedId("");
                  }}
                  onAddPoint={(cid) => setAction({ kind: "point", mode: "create", chapterId: cid })}
                  onEditPoint={(pid) => setAction({ kind: "point", mode: "edit", id: pid })}
                  onDeletePoint={(pt) => setDeletingPoint(pt)}
                  onExtractChapter={(cid) => void extractForChapter(cid)}
                  onOpenMaterial={(mid, pageNo) => setAction({ kind: "material", mode: "narration", id: mid, pageNo })}
                />
              )}
            </aside>
          )}
        </div>
      </section>

      {action && (
        <ContentActionDialog
          courseId={courseId}
          action={action}
          onClose={(changed) => {
            if (changed || action.mode === "narration" || action.mode === "audio") refresh();
            setAction(null);
          }}
        />
      )}

      <KnowledgeExtractDialog
        open={extractOpen}
        courseId={courseId}
        chapters={chapters}
        initialChapterId={scope !== "all" ? Number(scope) : undefined}
        onOpenChange={setExtractOpen}
        onSubmitted={() => {
          studioJobs.refresh();
          setOverlay("tasks");
        }}
      />

      {deletingPoint && (
        <ContentDeleteDialog
          courseId={courseId}
          targets={[{ kind: "knowledge_point", id: String(deletingPoint.id) }]}
          onClose={() => setDeletingPoint(null)}
          onDone={() => {
            const title = deletingPoint.title;
            setDeletingPoint(null);
            setSelectedId("");
            toast.add({ title: `已删除知识点「${title}」`, type: "success" });
            refresh();
          }}
        />
      )}
    </>
  );
}
