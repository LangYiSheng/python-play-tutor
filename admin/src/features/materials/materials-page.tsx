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
import { NarrationPlayer } from "@/features/materials/narration/player";
import { NarrationReview } from "@/features/materials/narration/review";
import { api, errorMessage, scoped } from "@/lib/api";
import type { Course, Material } from "@/lib/types";
import { useCatalogPage } from "@/lib/use-catalog-page";
import { useResource } from "@/lib/use-resource";
import {
  Eye,
  Headphones,
  NotebookPen,
  Pencil,
  Upload,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { MaterialDialog } from "./editor-dialog";
import { MaterialViewer } from "./material-viewer";
import { MaterialPreview } from "./types";
import { useMaterialEditor } from "./use-editor";
export function Materials({ courseId }: { courseId: number }) {
  const [query, setQuery] = useState(""), [kind, setKind] = useState("all"), [status, setStatus] = useState("all");
  const list = useCatalogPage<Material>("/teacher/materials", courseId, query, { kind, status });
  const course = useResource<Course>(scoped("/teacher/catalog?view=chapters", courseId));
  const editor = useMaterialEditor(courseId, list.reload);
  const { open, error, setError, busy, setBusy, edit } = editor;

  const [previewData, setPreviewData] = useState<MaterialPreview | null>(null),
    [narration, setNarration] = useState<Material | null>(null),
    [listening, setListening] = useState<Material | null>(null);
  useEffect(() => {
    if (
      list.data?.items.some((m) => m.status === "queued" || m.status === "processing")
    ) {
      const timer = window.setTimeout(list.reload, 2000);
      return () => window.clearTimeout(timer);
    }
  }, [list.data, list.reload]);
  const visible = list.rows;
  const deletion = useTableDelete<Material>(
    (m) => scoped(`/teacher/materials/${m.id}`, courseId),
    list.reload,
    { courseId, kind: () => "material" },
  );
  async function preview(m: Material) {
    setBusy(true);
    setError("");
    try {
      const result = await api.get<MaterialPreview>(
        scoped(`/teacher/materials/${m.id}`, courseId),
      );
      setPreviewData(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ErrorNotice
        message={list.error || course.error || (!open ? error : "")}
      />
      <div className="surface">
        <div className="toolbar">
          <div className="search">
            <Search size={16} />
            <Input
              aria-label="搜索资料"
              placeholder="搜索资料名称"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                list.firstPage();
                deletion.clear();
              }}
            />
          </div>
          <SelectField
            aria-label="资料类型"
            value={kind}
            onValueChange={(value) => {
              setKind(value);
              list.firstPage();
              deletion.clear();
            }}
          >
            <option value="all">全部资料</option>
            <option value="unassigned">未归类</option>
            <option value="pdf">PDF</option>
            <option value="presentation">演示文稿</option>
            <option value="text">文本</option>
            <option value="video">视频</option>
          </SelectField>
          <SelectField
            aria-label="资料状态"
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              list.firstPage();
              deletion.clear();
            }}
          >
            <option value="all">全部状态</option>
            <option value="ready">可用</option>
            <option value="converting">转换中</option>
            <option value="failed">转换失败</option>
          </SelectField>
          <div className="ml-auto"><Button onClick={() => edit(null)}><Upload />上传资料</Button></div>
        </div>
        <DeleteSelection actions={deletion} />
        {list.loading ? (
          <Loading />
        ) : !visible.length ? (
          <Empty title="没有匹配的资料" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">
                  <SelectTablePage actions={deletion} rows={visible} />
                </TableHead>
                <TableHead>资料名称</TableHead>
                <TableHead>章节</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((m) => (
                <TableRow
                  key={m.id}
                  data-state={deletion.isSelected(m) ? "selected" : undefined}
                >
                  <TableCell>
                    <SelectTableRow actions={deletion} row={m} />
                  </TableCell>
                  <TableCell>
                    <p className="font-medium">{m.title}</p>
                    <small className="text-muted-foreground uppercase">
                      {m.kind}
                    </small>
                  </TableCell>
                  <TableCell>
                    {m.chapter_ids
                      .map(
                        (id) =>
                          course.data?.chapters.find((c) => c.id === id)
                            ?.title ?? "章节",
                      )
                      .join("、") || "未归类"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={m.status === "ready" ? "outline" : "secondary"}
                    >
                      {m.status === "ready"
                        ? "可用"
                        : m.status === "failed"
                          ? "转换失败"
                          : m.status === "queued"
                            ? "等待处理"
                            : m.status === "processing"
                              ? "处理中"
                              : m.status}
                    </Badge>
                    {m.error ? (
                      <p className="text-xs text-destructive mt-1">{m.error}</p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`预览${m.title}`}
                        disabled={busy || m.status !== "ready"}
                        onClick={() => void preview(m)}
                      >
                        <Eye />
                      </Button>
                      {["pdf", "presentation"].includes(m.kind) && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`讲解${m.title}`}
                            disabled={busy || m.status !== "ready"}
                            onClick={() => setNarration(m)}
                          >
                            <NotebookPen />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`试听${m.title}`}
                            disabled={busy || m.status !== "ready"}
                            onClick={() => setListening(m)}
                          >
                            <Headphones />
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`编辑${m.title}`}
                        onClick={() => edit(m)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`删除${m.title}`}
                        onClick={() => deletion.ask([m])}
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
      <MaterialDialog editor={editor} course={course} />
      {previewData && (
        <MaterialViewer
          material={previewData}
          onClose={() => setPreviewData(null)}
        />
      )}
      {listening && (
        <NarrationPlayer
          key={`${courseId}:${listening.id}`}
          courseId={courseId}
          materialId={listening.id}
          title={listening.title}
          onClose={() => setListening(null)}
        />
      )}
      {narration && (
        <NarrationReview
          key={`${courseId}:${narration.id}`}
          courseId={courseId}
          materialId={narration.id}
          title={narration.title}
          onClose={() => setNarration(null)}
        />
      )}
    </>
  );
}
