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
import { api, errorMessage, scoped } from "@/lib/api";
import type { Course, Material, Point, Question } from "@/lib/types";
import { useResource } from "@/lib/use-resource";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { QuestionDialog } from "./editor-dialog";
import { kinds, statuses } from "./types";
import { useQuestionEditor } from "./use-editor";
import { useCatalogPage } from "@/lib/use-catalog-page";

type QuestionRow = Pick<Question, "id" | "title" | "kind" | "status" | "source_type" | "chapter_ids">;

export function Questions({ classroomId, pointId, clearPoint }: {
  classroomId: number; pointId?: string; clearPoint?: () => void;
}) {
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [sourceFilter, setSourceFilter] = useState("all"),
    [kindFilter, setKindFilter] = useState("all");
  const list = useCatalogPage<QuestionRow>("/teacher/questions", classroomId, query, {
    status: filter, source: sourceFilter, kind: kindFilter, knowledge_point_id: pointId ?? "all",
  });
  const point = useResource<Pick<Point, "id" | "title">[]>(pointId
    ? scoped("/teacher/knowledge-point-labels?ids=" + encodeURIComponent(pointId), classroomId) : null);
  const editor = useQuestionEditor(classroomId, list.reload);
  const { open, error } = editor;
  const chapters = useResource<Pick<Course, "chapters">>(scoped("/teacher/courses?view=chapters", classroomId));
  const materials = useResource<Material[]>(open ? scoped("/teacher/materials", classroomId) : null);
  const pending = useRef<AbortController | null>(null);
  const [detailError, setDetailError] = useState("");
  useEffect(() => () => pending.current?.abort(), [classroomId]);
  async function edit(row: QuestionRow | null) {
    pending.current?.abort();
    setDetailError("");
    if (!row) { editor.edit(null); return; }
    const controller = new AbortController();
    pending.current = controller;
    try {
      const question = await api.get<Question>(scoped("/teacher/questions/" + encodeURIComponent(row.id), classroomId), controller.signal);
      if (!controller.signal.aborted) editor.edit(question);
    } catch (cause) {
      if (!controller.signal.aborted) setDetailError(errorMessage(cause));
    }
  }
  const visible = list.rows;
  const deletion = useTableDelete<QuestionRow>(
    (q) =>
      scoped(`/teacher/questions/${encodeURIComponent(q.id)}`, classroomId),
    list.reload,
    { classroomId, kind: () => "question" },
  );
  return (
    <>
      <ErrorNotice
        message={list.error || detailError || chapters.error || materials.error || point.error || (!open ? error : "")}
      />
      {!open && editor.savedWarning && <p role="status" className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{editor.savedWarning}</p>}
      <div className="surface">
        {pointId && <div className="flex items-center gap-3 border-b px-4 py-2 text-sm">
          <span>知识点 · {point.data?.[0]?.title ?? (point.loading ? "加载中…" : "当前知识点")}</span>
          <Button size="sm" variant="ghost" onClick={clearPoint}>清除筛选</Button>
        </div>}
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
            value={filter}
            onValueChange={(value) => {
              setFilter(value);
              list.firstPage();
              deletion.clear();
            }}
          >
            <option value="all">全部状态</option>
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
          <div className="ml-auto"><Button onClick={() => edit(null)}><Plus />新增题目</Button></div>
        </div>
        <DeleteSelection actions={deletion} />
        {list.loading ? (
          <Loading />
        ) : !visible.length ? (
          <Empty title="没有匹配的题目" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">
                  <SelectTablePage actions={deletion} rows={visible} />
                </TableHead>
                <TableHead>题目</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
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
                    <p className="font-medium">{q.title}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {q.chapter_ids
                        .map(
                          (id) =>
                            chapters.data?.chapters.find((c) => c.id === id)
                              ?.title ?? "章节",
                        )
                        .join("、") || "未归类"}
                    </p>
                  </TableCell>
                  <TableCell>{kinds[q.kind]}</TableCell>
                  <TableCell>
                    {q.source_type === "ai_generated" ? "AI 生成" : "导入"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={q.status === "ready" ? "outline" : "secondary"}
                    >
                      {statuses[q.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`编辑${q.title}`}
                        onClick={() => edit(q)}
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
      <QuestionDialog editor={editor} classroomId={classroomId} course={chapters} materials={materials} />
    </>
  );
}
