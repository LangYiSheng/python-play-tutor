import { useEffect, useState } from "react";
import { Pencil, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { Empty, ErrorNotice, Loading } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { DeleteSelection, useTableDelete } from "@/components/table-delete";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { errorMessage, scoped } from "@/lib/api";
import { lectioApi, type KnowledgeOverview, type KnowledgePointItem } from "@/lib/lectio-api";
import { pageRanges } from "./graph-layout";
import { cleanGraphLabel } from "./lectio-graph-layout";

export function KnowledgeListView({
  classroomId,
  revision,
  onAddPoint,
  onEditPoint,
  onExtractChapter,
  onRefresh,
}: {
  classroomId: number;
  revision: number;
  onAddPoint: (chapterId?: number) => void;
  onEditPoint: (pointId: number) => void;
  onExtractChapter: (chapterId: number) => void;
  onRefresh: () => void;
}) {
  const [data, setData] = useState<KnowledgeOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [chapterFilter, setChapterFilter] = useState("all");
  const [extractingId, setExtractingId] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    lectioApi
      .listKnowledge(classroomId, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) {
          setData(res);
          setError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [classroomId, revision]);

  const deletion = useTableDelete<KnowledgePointItem>(
    (pt) => scoped(`/teacher/knowledge-points/${pt.id}`, classroomId),
    onRefresh,
    { classroomId, kind: () => "knowledge_point" },
  );

  async function extractFor(chapterId: number) {
    setExtractingId(chapterId);
    try {
      await lectioApi.extractKnowledge(classroomId, chapterId);
      toast.add({ title: "已加入知识点抽取队列", type: "success" });
      onExtractChapter(chapterId);
    } catch (e) {
      toast.add({ title: errorMessage(e), type: "error" });
    } finally {
      setExtractingId(null);
    }
  }

  if (loading && !data) return <div className="p-6"><Loading /></div>;
  if (error) return <div className="p-6"><ErrorNotice message={error} /></div>;

  const chapters = data?.chapters ?? [];
  const term = query.trim().toLowerCase();
  const visibleChapters = chapters
    .filter((ch) => chapterFilter === "all" || String(ch.id) === chapterFilter)
    .map((ch) => ({
      ...ch,
      points: ch.points.filter(
        (pt) =>
          !term ||
          pt.title.toLowerCase().includes(term) ||
          pt.section.toLowerCase().includes(term) ||
          pt.brief.toLowerCase().includes(term),
      ),
    }));

  return (
    <div
      className="min-h-0 overflow-y-auto p-5 space-y-4"
      aria-label="知识点列表视图"
    >
      <div className="surface p-4 space-y-4">
        <div className="toolbar">
          <div className="search">
            <Search size={16} />
            <Input
              aria-label="筛选知识点"
              placeholder="搜索知识点名称、小节或简介"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <SelectField
            aria-label="按章节筛选"
            value={chapterFilter}
            onValueChange={setChapterFilter}
          >
            <option value="all">全部章节</option>
            {chapters.map((ch) => (
              <option key={ch.id} value={ch.id}>
                {cleanGraphLabel(ch.title)}
              </option>
            ))}
          </SelectField>
        </div>
        <DeleteSelection actions={deletion} />

        {chapters.length === 0 ? (
          <Empty title="课程暂无章节，请先在「章节与课件」中创建章节" />
        ) : (
          <div className="space-y-4">
            {visibleChapters.map((ch) => (
              <section key={ch.id} className="rounded-md border bg-background">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-sm">
                      {cleanGraphLabel(ch.title)}
                    </h3>
                    <Badge variant="secondary">{ch.points.length} 知识点</Badge>
                    <Badge variant="outline">{ch.materials.length} 份资料</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="xs" variant="ghost" onClick={() => onAddPoint(ch.id)}>
                      <Plus /> 添加知识点
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={extractingId === ch.id || ch.materials.length === 0}
                      onClick={() => void extractFor(ch.id)}
                    >
                      <Sparkles /> {extractingId === ch.id ? "提交中…" : "AI 抽取知识点"}
                    </Button>
                  </div>
                </div>
                {ch.points.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-muted-foreground">
                    {term ? "没有匹配的知识点" : "本章暂无知识点，可点击右上角「AI 抽取知识点」或手动添加"}
                  </p>
                ) : (
                  <Table className="table-fixed w-full">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[34%]">知识点</TableHead>
                        <TableHead className="w-[16%]">所属小节</TableHead>
                        <TableHead className="w-[26%]">课件来源</TableHead>
                        <TableHead className="w-[14%]">关联题目</TableHead>
                        <TableHead className="w-[10%] text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ch.points.map((pt) => (
                        <TableRow key={pt.id}>
                          <TableCell className="whitespace-normal break-words align-top">
                            <p className="font-medium leading-snug">{cleanGraphLabel(pt.title)}</p>
                            {pt.brief && <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{pt.brief}</p>}
                          </TableCell>
                          <TableCell className="whitespace-normal break-words text-xs text-muted-foreground align-top">
                            {pt.section ? cleanGraphLabel(pt.section) : "—"}
                          </TableCell>
                          <TableCell className="whitespace-normal break-words text-xs align-top">
                            {pt.sources.length ? (
                              <div className="space-y-0.5">
                                {pt.sources.map((s) => (
                                  <div key={s.material_id} className="leading-snug">
                                    {s.material_title}（第 {pageRanges(s.pages)} 页）
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            <ButtonLink
                              size="xs"
                              variant="outline"
                              href={`/teacher/assessments?tab=bank&point=${pt.id}&pointName=${encodeURIComponent(pt.title)}`}
                            >
                              查看题目（{pt.question_count}）
                            </ButtonLink>
                          </TableCell>
                          <TableCell className="text-right align-top">
                            <div className="flex justify-end gap-1">
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={`编辑${pt.title}`}
                                onClick={() => onEditPoint(pt.id)}
                              >
                                <Pencil />
                              </Button>
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={`删除${pt.title}`}
                                onClick={() => deletion.ask([pt])}
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
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
