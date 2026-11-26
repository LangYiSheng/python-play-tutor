import {
  Empty,
  ErrorNotice,
  Loading,
  Pager,
} from "@/components/common";
import { SelectField } from "@/components/select-field";
import {
  DeleteSelection,
  SelectTablePage,
  SelectTableRow,
  useTableDelete,
} from "@/components/table-delete";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { api, errorMessage, scoped } from "@/lib/api";
import type { Course, Material, Point, Question } from "@/lib/types";
import { useCatalogPage } from "@/lib/use-catalog-page";
import { useResource } from "@/lib/use-resource";
import { Check, CheckCheck, Pencil, Plus, Search, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { QuestionDialog, type QuestionReviewQueue } from "./editor-dialog";
import "./questions.css";
import { kinds, statuses } from "./types";
import { useQuestionEditor } from "./use-editor";

type QuestionRow = Pick<
  Question,
  "id" | "title" | "kind" | "status" | "source_type" | "chapter_ids"
>;

function statusBadgeClass(status: Question["status"]) {
  if (status === "ready") return "border-emerald-300 bg-emerald-50 text-emerald-800";
  if (status === "draft") return "border-amber-300 bg-amber-50 text-amber-800";
  return "border-border bg-muted text-muted-foreground";
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(target.closest("[role='combobox'],[role='listbox'],[role='dialog']"));
}

export function Questions({
  courseId,
  pointId,
  clearPoint,
  status,
  onStatusChange,
  toolbarExtra,
  reloadRef,
}: {
  courseId: number;
  pointId?: string;
  clearPoint: () => void;
  status: string;
  onStatusChange: (value: string) => void;
  toolbarExtra?: ReactNode;
  reloadRef?: MutableRefObject<(() => void) | null>;
}) {
  const [query, setQuery] = useState(""),
    [chapterFilter, setChapterFilter] = useState("all"),
    [sourceFilter, setSourceFilter] = useState("all"),
    [kindFilter, setKindFilter] = useState("all");
  const list = useCatalogPage<QuestionRow>("/teacher/questions", courseId, query, {
    status: status === "reviewable" ? "draft" : status,
    reviewable: status === "reviewable" ? "true" : "all",
    source: sourceFilter,
    kind: kindFilter,
    chapter_id: chapterFilter,
    knowledge_point_id: pointId ?? "all",
  });
  useEffect(() => {
    if (!reloadRef) return;
    reloadRef.current = list.reload;
    return () => {
      reloadRef.current = null;
    };
  }, [reloadRef, list.reload]);

  const point = useResource<Pick<Point, "id" | "title">[]>(
    pointId
      ? scoped("/teacher/knowledge-point-labels?ids=" + encodeURIComponent(pointId), courseId)
      : null,
  );
  const editor = useQuestionEditor(courseId, list.reload);
  const { open, error, edit: openEditor, setOpen } = editor;
  const chapters = useResource<Pick<Course, "chapters">>(
    scoped("/teacher/catalog?view=chapters", courseId),
  );
  const materials = useResource<Material[]>(
    open ? scoped("/teacher/materials", courseId) : null,
  );
  const pending = useRef<AbortController | null>(null);
  const [detailError, setDetailError] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [batchApproving, setBatchApproving] = useState(false);

  useEffect(() => () => pending.current?.abort(), [courseId]);

  const edit = useCallback(
    async (row: QuestionRow | null) => {
      pending.current?.abort();
      setDetailError("");
      if (!row) {
        openEditor(null);
        return;
      }
      const controller = new AbortController();
      pending.current = controller;
      setLoadingDetail(true);
      try {
        const question = await api.get<Question>(
          scoped("/teacher/questions/" + encodeURIComponent(row.id), courseId),
          controller.signal,
        );
        if (!controller.signal.aborted) openEditor(question);
      } catch (cause) {
        if (!controller.signal.aborted) setDetailError(errorMessage(cause));
      } finally {
        if (pending.current === controller) setLoadingDetail(false);
      }
    },
    [courseId, openEditor],
  );

  const visible = list.rows;
  const draftRows = useMemo(
    () => visible.filter((row) => row.status === "draft"),
    [visible],
  );
  const deletion = useTableDelete<QuestionRow>(
    (q) => scoped(`/teacher/questions/${encodeURIComponent(q.id)}`, courseId),
    list.reload,
    { courseId, kind: () => "question" },
  );

  const selectedApprovable = deletion.selected.filter((row) => row.status !== "ready");

  async function quickApprove(row: QuestionRow) {
    if (approvingId || batchApproving) return;
    setApprovingId(row.id);
    setDetailError("");
    try {
      await api.put(scoped(`/teacher/questions/${encodeURIComponent(row.id)}`, courseId), {
        status: "ready",
      });
      toast.add({ title: `已通过审核：${row.title.slice(0, 24)}`, type: "success" });
      list.reload();
    } catch (cause) {
      const msg = errorMessage(cause);
      setDetailError(msg);
      toast.add({ title: msg, type: "error" });
    } finally {
      setApprovingId(null);
    }
  }

  async function batchApprove(rows: QuestionRow[]) {
    if (!rows.length || batchApproving) return;
    setBatchApproving(true);
    setDetailError("");
    let okCount = 0;
    const failures: string[] = [];
    try {
      for (const row of rows) {
        try {
          await api.put(scoped(`/teacher/questions/${encodeURIComponent(row.id)}`, courseId), {
            status: "ready",
          });
          okCount += 1;
        } catch (cause) {
          failures.push(`${row.title.slice(0, 18)}：${errorMessage(cause)}`);
        }
      }
      if (okCount > 0) {
        deletion.clear();
        list.reload();
      }
      if (failures.length === 0) {
        toast.add({ title: `已批量通过审核 ${okCount} 道题目`, type: "success" });
      } else {
        setDetailError(`已通过 ${okCount} 道，以下 ${failures.length} 道未通过：${failures[0]}`);
        toast.add({
          title: `已通过 ${okCount} 道，${failures.length} 道失败`,
          type: "error",
        });
      }
    } finally {
      setBatchApproving(false);
    }
  }

  const startFastReview = useCallback(() => {
    const firstTarget = draftRows[0] ?? visible[0];
    if (firstTarget) void edit(firstTarget);
  }, [draftRows, edit, visible]);

  useEffect(() => {
    if (open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableElement(event.target)) return;
      if (event.key.toLowerCase() === "r" && visible.length > 0) {
        event.preventDefault();
        startFastReview();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, startFastReview, visible.length]);

  const activeIndex = editor.editing
    ? visible.findIndex((row) => row.id === editor.editing?.id)
    : -1;

  const queue: QuestionReviewQueue | undefined =
    activeIndex >= 0
      ? {
          index: activeIndex,
          total: visible.length,
          hasPrev: activeIndex > 0,
          hasNext: activeIndex < visible.length - 1,
          loading: loadingDetail,
          onPrev: () => {
            if (activeIndex > 0) void edit(visible[activeIndex - 1]);
          },
          onNext: () => {
            if (activeIndex < visible.length - 1) void edit(visible[activeIndex + 1]);
          },
          onApproved: () => {
            const currentId = visible[activeIndex]?.id;
            const nextDraft =
              visible.slice(activeIndex + 1).find((row) => row.status === "draft") ??
              visible.slice(0, activeIndex).find((row) => row.status === "draft" && row.id !== currentId);
            const fallbackNext = visible[activeIndex + 1];
            const target = nextDraft ?? fallbackNext;
            if (target) {
              toast.add({ title: "已通过审核，已切至下一题", type: "success" });
              void edit(target);
            } else {
              setOpen(false);
              toast.add({ title: "本页待审题目已审核完成", type: "success" });
            }
          },
        }
      : undefined;

  return (
    <>
      <ErrorNotice
        message={
          list.error ||
          detailError ||
          chapters.error ||
          materials.error ||
          point.error ||
          (!open ? error : "")
        }
      />
      {!open && editor.savedWarning && (
        <p
          role="status"
          className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {editor.savedWarning}
        </p>
      )}
      <div className="surface">
        {pointId && (
          <div className="flex items-center gap-3 border-b px-4 py-2 text-sm">
            <span>
              知识点 · {point.data?.[0]?.title ?? (point.loading ? "加载中…" : "当前知识点")}
            </span>
            <Button size="sm" variant="ghost" onClick={clearPoint}>
              清除筛选
            </Button>
          </div>
        )}
        <div className="toolbar">
          <div className="search">
            <Search size={16} />
            <Input
              aria-label="搜索题目"
              placeholder="搜索题目或题干"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                list.firstPage();
                deletion.clear();
              }}
            />
          </div>
          <SelectField
            aria-label="所属章节"
            value={chapterFilter}
            onValueChange={(value) => {
              setChapterFilter(value);
              list.firstPage();
              deletion.clear();
            }}
          >
            <option value="all">全部章节</option>
            {(chapters.data?.chapters ?? []).map((ch) => (
              <option key={ch.id} value={String(ch.id)}>
                第 {ch.order_index} 章 · {ch.title}
              </option>
            ))}
          </SelectField>
          <SelectField
            aria-label="题目类型"
            value={kindFilter}
            onValueChange={(value) => {
              setKindFilter(value);
              list.firstPage();
              deletion.clear();
            }}
          >
            <option value="all">全部题型</option>
            {Object.entries(kinds).map(([key, value]) => (
              <option key={key} value={key}>
                {value}
              </option>
            ))}
          </SelectField>
          <SelectField
            aria-label="题目状态"
            value={status}
            onValueChange={(value) => {
              onStatusChange(value);
              list.firstPage();
              deletion.clear();
            }}
          >
            <option value="all">全部状态</option>
            <option value="reviewable">待我审核</option>
            {Object.entries(statuses).map(([key, value]) => (
              <option key={key} value={key}>
                {value}
              </option>
            ))}
          </SelectField>
          <SelectField
            aria-label="题目来源"
            value={sourceFilter}
            onValueChange={(value) => {
              setSourceFilter(value);
              list.firstPage();
              deletion.clear();
            }}
          >
            <option value="all">全部来源</option>
            <option value="imported">导入</option>
            <option value="ai_generated">AI 生成</option>
          </SelectField>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {draftRows.length > 0 && (
              <Button
                type="button"
                variant="secondary"
                title="按 R 打开首道待审题，支持快捷键连续审核"
                onClick={startFastReview}
              >
                <CheckCheck /> 快速审题（{draftRows.length}）
              </Button>
            )}
            {toolbarExtra}
            <Button onClick={() => void edit(null)}>
              <Plus /> 新增题目
            </Button>
          </div>
        </div>
        {draftRows.length > 0 && deletion.selected.length === 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-amber-50/50 px-5 py-2 text-xs text-amber-900">
            <span>
              本页有 <strong>{draftRows.length}</strong> 道待审核题目：可直接点行尾「通过」、勾选后批量通过，或按{" "}
              <kbd className="rounded border bg-background px-1 py-0.5 font-mono text-[11px]">R</kbd>{" "}
              进入连续审校（弹窗内{" "}
              <kbd className="rounded border bg-background px-1 py-0.5 font-mono text-[11px]">A</kbd> /{" "}
              <kbd className="rounded border bg-background px-1 py-0.5 font-mono text-[11px]">Ctrl+Enter</kbd>{" "}
              通过并下一题）。
            </span>
          </div>
        )}
        <DeleteSelection
          actions={deletion}
          extraActions={
            selectedApprovable.length > 0 ? (
              <Button
                type="button"
                size="sm"
                disabled={batchApproving || deletion.busy}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                onClick={() => void batchApprove(selectedApprovable)}
              >
                <CheckCheck />
                {batchApproving
                  ? "正在通过…"
                  : `批量通过审核（${selectedApprovable.length}）`}
              </Button>
            ) : null
          }
        />
        {list.loading ? (
          <Loading />
        ) : !visible.length ? (
          <Empty title="没有匹配的题目" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-11">
                  <SelectTablePage actions={deletion} rows={visible} />
                </TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead>题目</TableHead>
                <TableHead className="w-24">类型</TableHead>
                <TableHead className="w-20">来源</TableHead>
                <TableHead className="w-40 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((q) => (
                <TableRow
                  key={q.id}
                  data-state={deletion.isSelected(q) ? "selected" : undefined}
                >
                  <TableCell>
                    <SelectTableRow actions={deletion} row={q} />
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={statusBadgeClass(q.status)}>
                      {statuses[q.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-0">
                    <button
                      type="button"
                      className="block max-w-full truncate text-left font-medium hover:underline"
                      onClick={() => void edit(q)}
                    >
                      {q.title}
                    </button>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {q.chapter_ids
                        .map(
                          (id) =>
                            chapters.data?.chapters.find((c) => c.id === id)?.title ?? "章节",
                        )
                        .join("、") || "未归类"}
                    </p>
                  </TableCell>
                  <TableCell>{kinds[q.kind]}</TableCell>
                  <TableCell>
                    {q.source_type === "ai_generated" ? "AI 生成" : "导入"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {q.status !== "ready" && (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={approvingId === q.id || batchApproving}
                          aria-label={`通过${q.title}`}
                          className="border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                          onClick={() => void quickApprove(q)}
                        >
                          <Check /> {approvingId === q.id ? "处理中" : "通过"}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`编辑${q.title}`}
                        onClick={() => void edit(q)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`删除${q.title}`}
                        onClick={() => deletion.ask([q])}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pager {...list.pager} />
      </div>
      <QuestionDialog
        editor={editor}
        courseId={courseId}
        course={chapters}
        materials={materials}
        queue={queue}
      />
    </>
  );
}
