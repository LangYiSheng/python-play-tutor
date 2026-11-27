import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { BookOpen, Eye, Headphones, Link2, ListTodo, PanelLeftOpen, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { Empty, ErrorNotice } from "@/components/common";
import { WorkspaceSkeleton } from "@/components/skeletons";
import { SelectField } from "@/components/select-field";
import { DeleteSelection, useTableDelete } from "@/components/table-delete";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { CurriculumDialog } from "@/features/content-workspace/curriculum-dialog";
import { useTaskCommands } from "@/features/content-workspace/task-queue";
import type { TaskSnapshot } from "@/features/content-workspace/task-presentation";
import { useGraphData } from "@/features/content-workspace/use-graph-data";
import { MaterialDialog } from "@/features/materials/editor-dialog";
import { MaterialViewer } from "@/features/materials/material-viewer";
import { NarrationPlayer } from "@/features/materials/narration/player";
import type { MaterialPreview } from "@/features/materials/types";
import { useMaterialEditor } from "@/features/materials/use-editor";
import { api, errorMessage, scoped } from "@/lib/api";
import { courseStudioApi, useCourseStudioJobs, type KnowledgeOverview, type CourseStudioJob } from "@/lib/course-studio-api";
import { materialKindLabel } from "@/lib/material-kind";
import type { Chapter, Course, Material } from "@/lib/types";
import { useResource } from "@/lib/use-resource";
import { ChapterTree } from "./chapter-tree";
import { DropImportOverlay, uploadMaterialsBatch } from "./drop-import-overlay";
import { MaterialTasksDialog } from "./material-tasks-dialog";
import { MaterialWorkspace } from "./material-workspace";

type MaterialsPayload = Material[] | { items: Material[]; total: number; page: number };

function AttachMaterial({ courseId, chapter, materials, onClose, onAttached }: {
  courseId: number; chapter: Chapter; materials: Material[]; onClose: () => void; onAttached: () => void;
}) {
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choices = materials.filter(material => !material.chapter_ids.includes(chapter.id));
  async function attach(event: FormEvent) {
    event.preventDefault();
    if (!choice || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.put(scoped(`/teacher/chapters/${chapter.id}/material-tasks/${choice}`, courseId), {
        required: false, rule: {}, order_index: materials.length + 1,
      });
      onAttached();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>关联已有资料</DialogTitle>
        <DialogDescription>{chapter.title}</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={attach}>
        <ErrorNotice message={error} />
        {choices.length ? <SelectField aria-label="选择课程资料" value={choice} onValueChange={setChoice} disabled={busy}>
          <option value="">选择课程资料</option>
          {choices.map(material => <option key={material.id} value={material.id}>{material.title}</option>)}
        </SelectField> : <p className="hint">没有可关联的资料。</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="submit" disabled={!choice || busy}><Link2 />关联资料</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function CoursewarePage({ courseId }: { courseId: number }) {
  return <CoursewareInner key={courseId} courseId={courseId} />;
}

function CoursewareInner({ courseId }: { courseId: number }) {
  const course = useResource<Course>(scoped("/teacher/catalog?view=chapters", courseId));
  const matResource = useResource<MaterialsPayload>(scoped("/teacher/materials", courseId));
  const knowledge = useResource<KnowledgeOverview>(`/teacher/courses/${courseId}/course-studio/knowledge`);
  const [taskRev, setTaskRev] = useState(0);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [extractBusy, setExtractBusy] = useState(false);
  const taskList = useGraphData<TaskSnapshot[]>(scoped("/teacher/course-graph/tasks", courseId), taskRev, 4000);
  const refreshTasks = useCallback(() => setTaskRev((n) => n + 1), []);
  const taskCommands = useTaskCommands(courseId, refreshTasks);
  const handleCourseStudioJobDone = useCallback(
    (job: CourseStudioJob) => {
      if (job.kind === "knowledge_extract") {
        knowledge.reload();
        const created = typeof job.result?.created === "number" ? job.result.created : null;
        const updated = typeof job.result?.updated === "number" ? job.result.updated : 0;
        toast.add({
          title:
            created !== null
              ? `课件知识点已更新（新增 ${created} 个${updated > 0 ? `，更新 ${updated} 个` : ""}）`
              : "课件知识点抽取完成",
          type: "success",
        });
      }
    },
    [knowledge.reload],
  );
  const handleCourseStudioJobFailed = useCallback((job: CourseStudioJob) => {
    if (job.kind === "knowledge_extract") {
      toast.add({
        title: "课件知识点抽取失败",
        description: job.error || "请检查 AI 模型配置后重试",
        type: "error",
      });
    }
  }, []);
  const studioJobs = useCourseStudioJobs(courseId, handleCourseStudioJobDone, handleCourseStudioJobFailed);
  const [query, setQuery] = useState("");
  const [selectedChapterId, setSelectedChapterId] = useState<number | null>(null);
  const [selectedMaterialId, setSelectedMaterialId] = useState<number | null>(null);
  const [attachChapter, setAttachChapter] = useState<Chapter | null>(null);
  const [chapterDialog, setChapterDialog] = useState<{ open: boolean; editing: Chapter | null }>({
    open: false,
    editing: null,
  });
  const [previewData, setPreviewData] = useState<MaterialPreview | null>(null);
  const [listening, setListening] = useState<Material | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchSkipped, setBatchSkipped] = useState<{ filename: string; reason: string }[]>([]);
  const [treeOpen, setTreeOpen] = useState(true);
  const dragDepth = useRef(0);

  function toggleTree(next?: boolean) {
    setTreeOpen((prev) => (next === undefined ? !prev : next));
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.key !== "[") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
          Boolean(target.closest("[role='dialog']")))
      ) {
        return;
      }
      event.preventDefault();
      toggleTree();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const materials: Material[] = Array.isArray(matResource.data)
    ? matResource.data
    : matResource.data?.items ?? [];
  const chapters = course.data?.chapters ?? [];

  function reloadAll() {
    course.reload();
    matResource.reload();
    knowledge.reload();
  }

  const editor = useMaterialEditor(courseId, reloadAll);
  const chapterDelete = useTableDelete<Chapter>(
    (ch) => scoped(`/teacher/chapters/${ch.id}`, courseId),
    () => {
      setSelectedChapterId(null);
      setSelectedMaterialId(null);
      reloadAll();
    },
    { courseId, kind: () => "chapter" },
  );
  const deletingMaterialIds = useRef<Set<number>>(new Set());
  const materialDelete = useTableDelete<Material>(
    (m) => scoped(`/teacher/materials/${m.id}`, courseId),
    () => {
      setSelectedMaterialId((curr) => (curr !== null && deletingMaterialIds.current.has(curr) ? null : curr));
      deletingMaterialIds.current.clear();
      reloadAll();
    },
    { courseId, kind: () => "material" },
  );
  function askDeleteMaterial(m: Material) {
    deletingMaterialIds.current = new Set([m.id]);
    materialDelete.ask([m]);
  }

  useEffect(() => {
    if (materials.some((m) => m.status === "queued" || m.status === "processing")) {
      const timer = window.setTimeout(matResource.reload, 2500);
      return () => window.clearTimeout(timer);
    }
  }, [materials, matResource.reload]);

  const activeMaterial = materials.find((m) => m.id === selectedMaterialId) ?? null;
  const activeChapterId = selectedChapterId ?? chapters[0]?.id ?? null;
  const activeChapter = chapters.find((c) => c.id === activeChapterId) ?? null;

  const taskJobs = useMemo(
    () => (Array.isArray(taskList?.data) ? taskList.data : []),
    [taskList?.data],
  );
  const activePipelineKeys = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(
      taskJobs
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
      knowledge.reload();
    }
  }, [taskJobs, knowledge.reload]);
  const knowledgeChapters = useMemo(
    () => (Array.isArray(knowledge.data?.chapters) ? knowledge.data.chapters : []),
    [knowledge.data],
  );
  const materialPoints = useMemo(() => {
    if (!activeMaterial) return [];
    const seen = new Set<number>();
    const out = [];
    for (const ch of knowledgeChapters) {
      for (const pt of ch.points ?? []) {
        if (seen.has(pt.id)) continue;
        if (pt.sources.some((s) => s.material_id === activeMaterial.id)) {
          seen.add(pt.id);
          out.push(pt);
        }
      }
    }
    return out;
  }, [activeMaterial, knowledgeChapters]);
  const chapterPoints = useMemo(() => {
    if (!activeMaterial) return [];
    return knowledgeChapters
      .filter((ch) => activeMaterial.chapter_ids.includes(ch.id))
      .flatMap((ch) => ch.points ?? []);
  }, [activeMaterial, knowledgeChapters]);
  const extractingKnowledge =
    extractBusy ||
    studioJobs.jobs.some(
      (j) => j.kind === "knowledge_extract" && (j.status === "queued" || j.status === "running"),
    );

  async function extractMaterialKnowledge(mat: Material) {
    const chapterId = mat.chapter_ids[0];
    if (!chapterId) {
      toast.add({ title: "请先在「编辑资料」中关联章节后再抽取知识点", type: "warning" });
      return;
    }
    setExtractBusy(true);
    try {
      await courseStudioApi.extractKnowledge(courseId, chapterId, [mat.id]);
      toast.add({ title: `已提交「${mat.title}」知识点抽取，完成后自动刷新`, type: "success" });
      studioJobs.refresh();
    } catch (e) {
      toast.add({ title: errorMessage(e), type: "error" });
    } finally {
      setExtractBusy(false);
    }
  }

  async function previewMaterial(m: Material) {
    setPreviewBusy(true);
    setPreviewError("");
    try {
      const result = await api.get<MaterialPreview>(scoped(`/teacher/materials/${m.id}`, courseId));
      setPreviewData(result);
    } catch (e) {
      setPreviewError(errorMessage(e));
    } finally {
      setPreviewBusy(false);
    }
  }

  async function retryMaterial(m: Material) {
    setPreviewBusy(true);
    setPreviewError("");
    try {
      await api.post(scoped(`/teacher/materials/${m.id}/retry`, courseId), {});
      toast.add({ title: `已重新提交「${m.title}」解析`, type: "success" });
      reloadAll();
    } catch (e) {
      setPreviewError(errorMessage(e));
    } finally {
      setPreviewBusy(false);
    }
  }

  function openMaterial(mat: Material, cid?: number | null) {
    setSelectedMaterialId(mat.id);
    if (cid !== undefined && cid !== null) setSelectedChapterId(cid);
    if (["pdf", "presentation"].includes(mat.kind)) {
      toggleTree(false);
      knowledge.reload();
    }
  }

  function openUpload(chapterId?: number) {
    editor.edit(null);
    if (chapterId) editor.setChapterIds([chapterId]);
  }

  function hasDraggedFiles(e: DragEvent) {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }

  async function handleDroppedFiles(files: File[]) {
    if (files.length === 0 || batchBusy || editor.open) return;
    setBatchBusy(true);
    setPreviewError("");
    setBatchSkipped([]);
    try {
      const hasDeckOrZip = files.some((f) => /\.(ppt|pptx|pdf|zip)$/i.test(f.name));
      const targetIds = hasDeckOrZip ? [] : activeChapter ? [activeChapter.id] : [];
      const res = await uploadMaterialsBatch(courseId, files, targetIds);
      const chapterCount = res.created_chapters?.length ?? 0;
      const chapterNote = chapterCount > 0 ? `，自动新建 ${chapterCount} 个章节` : "";
      const skippedNote = res.skipped.length > 0 ? `（跳过 ${res.skipped.length} 项）` : "";
      toast.add({ title: `已导入 ${res.created.length} 份资料${chapterNote}${skippedNote}`, type: "success" });
      if (res.skipped.length > 0) setBatchSkipped(res.skipped);
      reloadAll();
    } catch (e) {
      const msg = errorMessage(e);
      setPreviewError(msg);
      toast.add({ title: msg, type: "error" });
    } finally {
      setBatchBusy(false);
    }
  }

  const chapterMaterials = activeChapter ? materials.filter((m) => m.chapter_ids.includes(activeChapter.id)) : [];
  const dropTargetLabel = activeChapter
    ? `PPT / PDF 自动按名称新建章节；其他资料归入「第 ${activeChapter.order_index} 章 · ${activeChapter.title}」`
    : "PPT / PDF 自动按名称新建章节；其他资料进入未归类";

  return (
    <div
      className="flex flex-1 min-h-0 flex-col gap-3 lg:h-full lg:overflow-hidden"
      onDragEnter={(e) => {
        if (editor.open || !hasDraggedFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragActive(true);
      }}
      onDragOver={(e) => {
        if (editor.open || !hasDraggedFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (editor.open || !hasDraggedFiles(e)) return;
        e.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      }}
      onDrop={(e) => {
        if (editor.open || !hasDraggedFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);
        const dropped = Array.from(e.dataTransfer.files);
        if (dropped.length > 0) void handleDroppedFiles(dropped);
      }}
    >
      <DropImportOverlay visible={dragActive} targetLabel={dropTargetLabel} />

      <ErrorNotice message={course.error || matResource.error || previewError || (!editor.open ? editor.error : "")} />
      {batchBusy && (
        <p role="status" className="shrink-0 rounded-md border bg-muted/30 px-4 py-2 text-sm">
          正在批量导入资料并解析文件，请稍候…
        </p>
      )}
      {batchSkipped.length > 0 && (
        <div role="status" className="shrink-0 rounded-md border bg-muted/30 px-4 py-2.5 text-xs space-y-1">
          <div className="flex items-center justify-between gap-2 font-medium text-sm">
            <span>以下 {batchSkipped.length} 个文件未导入（已自动跳过）</span>
            <Button size="icon-xs" variant="ghost" aria-label="关闭跳过提示" onClick={() => setBatchSkipped([])}>
              <X />
            </Button>
          </div>
          <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
            {batchSkipped.map((item, i) => (
              <li key={`${item.filename}-${i}`}>
                {item.filename}：{item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <DeleteSelection actions={chapterDelete} />
      <DeleteSelection actions={materialDelete} />

      {course.loading && matResource.loading ? (
        <WorkspaceSkeleton />
      ) : chapters.length === 0 && materials.length === 0 ? (
        <div className="surface p-8 text-center">
          <Empty
            title="当前课程还没有章节或课件"
            description="可直接将 PDF / PPTX / MD / MP4 或含课件的 .zip 压缩包拖入本页面导入。"
          />
          <div className="mt-4 flex justify-center gap-2">
            <Button onClick={() => setChapterDialog({ open: true, editing: null })}>
              <Plus /> 创建第一章
            </Button>
            <Button variant="outline" onClick={() => openUpload()}>
              <Upload /> 上传资料
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 flex-col gap-3 lg:flex-row lg:overflow-hidden">
          {treeOpen && (
            <ChapterTree
              chapters={chapters}
              materials={materials}
              query={query}
              onQueryChange={setQuery}
              selectedChapterId={activeMaterial ? null : activeChapterId}
              selectedMaterialId={activeMaterial?.id ?? null}
              onSelectChapter={(cid) => {
                setSelectedChapterId(cid);
                setSelectedMaterialId(null);
              }}
              onSelectMaterial={(mat, cid) => openMaterial(mat, cid)}
              onAddChapter={() => setChapterDialog({ open: true, editing: null })}
              onEditChapter={(ch) => setChapterDialog({ open: true, editing: ch })}
              onDeleteChapter={(ch) => chapterDelete.ask([ch])}
              onUploadMaterial={openUpload}
              onEditMaterial={editor.edit}
              onDeleteMaterial={askDeleteMaterial}
              onPreviewMaterial={(mat) => void previewMaterial(mat)}
              onListenMaterial={setListening}
              onExtractKnowledge={(mat) => void extractMaterialKnowledge(mat)}
              onRetryMaterial={(mat) => void retryMaterial(mat)}
              onCollapse={() => toggleTree(false)}
            />
          )}

          {activeMaterial ? (
            <MaterialWorkspace
              key={activeMaterial.id}
              courseId={courseId}
              material={activeMaterial}
              chapters={chapters}
              materialPoints={materialPoints}
              chapterPoints={chapterPoints}
              extractingKnowledge={extractingKnowledge}
              taskCount={taskJobs.length}
              busy={previewBusy}
              treeOpen={treeOpen}
              onToggleTree={() => toggleTree()}
              onOpenTasks={() => setTasksOpen(true)}
              onExtractKnowledge={() => void extractMaterialKnowledge(activeMaterial)}
              onKnowledgeUpdated={knowledge.reload}
              onPreview={previewMaterial}
              onListen={setListening}
              onEdit={editor.edit}
              onDelete={askDeleteMaterial}
              onRetry={(m) => void retryMaterial(m)}
            />
          ) : activeChapter ? (
            <section key={activeChapter.id} className="page-enter surface flex flex-1 min-w-0 min-h-0 flex-col gap-4 overflow-y-auto p-5" aria-label={activeChapter.title}>
              <header className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
                <div className="flex items-center gap-2">
                  {!treeOpen && (
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      aria-label="展开章节目录"
                      onClick={() => toggleTree(true)}
                    >
                      <PanelLeftOpen /> 展开目录
                    </Button>
                  )}
                  <BookOpen size={18} />
                  <h2 className="text-lg font-semibold">
                    第 {activeChapter.order_index} 章 · {activeChapter.title}
                  </h2>
                  <Badge variant="secondary">{chapterMaterials.length} 份资料</Badge>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={taskJobs.length > 0 ? "secondary" : "outline"}
                    onClick={() => setTasksOpen(true)}
                  >
                    <ListTodo /> 制作任务{taskJobs.length > 0 ? ` ${taskJobs.length}` : ""}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setChapterDialog({ open: true, editing: activeChapter })}>
                    <Pencil /> 编辑章节
                  </Button>
                  <ButtonLink size="sm" variant="outline" href={`/teacher/activities?course=${courseId}&chapter=${activeChapter.id}`}>管理本章学习任务</ButtonLink>
                  <Button size="sm" variant="outline" onClick={() => setAttachChapter(activeChapter)}><Link2 />关联已有资料</Button>
                  <Button size="sm" onClick={() => openUpload(activeChapter.id)}>
                    <Upload /> 上传资料到此章
                  </Button>
                </div>
              </header>
              {chapterMaterials.length === 0 ? (
                <Empty title="本章暂无资料，请在左上方上传课件或切换到已有课件" />
              ) : (
                <ul className="divide-y rounded-md border">
                  {chapterMaterials.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left hover:underline font-medium"
                        onClick={() => openMaterial(m)}
                      >
                        {m.title}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">{materialKindLabel(m.kind)}</span>
                      </button>
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="outline" onClick={() => openMaterial(m)}>
                          打开工作区
                        </Button>
                        <Button size="icon-sm" variant="ghost" aria-label={`预览${m.title}`} onClick={() => void previewMaterial(m)}>
                          <Eye />
                        </Button>
                        {["pdf", "presentation"].includes(m.kind) && m.status === "ready" && (
                          <Button size="icon-sm" variant="ghost" aria-label={`试听${m.title}`} onClick={() => setListening(m)}>
                            <Headphones />
                          </Button>
                        )}
                        <Button size="icon-sm" variant="ghost" aria-label={`编辑${m.title}`} onClick={() => editor.edit(m)}>
                          <Pencil />
                        </Button>
                        <Button size="icon-sm" variant="ghost" aria-label={`删除${m.title}`} onClick={() => askDeleteMaterial(m)}>
                          <Trash2 />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <section className="surface flex-1 space-y-3 p-6">
              {!treeOpen && (
                <Button type="button" size="xs" variant="secondary" onClick={() => toggleTree(true)}>
                  <PanelLeftOpen /> 展开目录
                </Button>
              )}
              <Empty title="请在左侧选择章节或课件" />
            </section>
          )}
        </div>
      )}

      {chapterDialog.open && (
        <CurriculumDialog
          courseId={courseId}
          tab="chapters"
          chapters={chapters}
          editing={chapterDialog.editing}
          onClose={(saved) => {
            setChapterDialog({ open: false, editing: null });
            if (saved) reloadAll();
          }}
        />
      )}
      <MaterialDialog editor={editor} course={course} />
      {attachChapter && <AttachMaterial courseId={courseId} chapter={attachChapter} materials={materials}
        onClose={() => setAttachChapter(null)} onAttached={() => { setAttachChapter(null); reloadAll(); }} />}
      {previewData && <MaterialViewer material={previewData} onClose={() => setPreviewData(null)} />}
      {listening && (
        <NarrationPlayer
          key={`${courseId}:${listening.id}`}
          courseId={courseId}
          materialId={listening.id}
          title={listening.title}
          onClose={() => setListening(null)}
        />
      )}
      {taskCommands.feedback}
      <MaterialTasksDialog
        open={tasksOpen}
        onOpenChange={setTasksOpen}
        jobs={taskJobs}
        error={taskList?.error}
        materials={materials}
        onSelectMaterial={(mid) => {
          const target = materials.find((m) => m.id === mid);
          if (target) openMaterial(target, target.chapter_ids[0] ?? null);
        }}
        request={taskCommands.request}
      />
    </div>
  );
}
