import { useEffect, useState } from "react";
import { ChevronRight, FileText, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { Empty, Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { kinds } from "@/features/questions/types";
import { api, scoped } from "@/lib/api";
import type { KnowledgeChapter, KnowledgeOverview, KnowledgePointItem } from "@/lib/lectio-api";
import { pageRanges, type QuestionNode } from "./graph-layout";
import { cleanGraphLabel, type GNode, type GraphNodeKind } from "./lectio-graph-layout";

const KIND_LABELS: Record<GraphNodeKind, string> = {
  course: "课程",
  chapter: "章",
  section: "节",
  point: "知识点",
};

function breadcrumbOf(n: GNode): string {
  const parts: string[] = [];
  let cur = n.parent;
  while (cur && cur.kind !== "course") {
    parts.unshift(cur.label);
    cur = cur.parent;
  }
  return parts.join(" · ");
}

export function LectioGraphInspector({
  classroomId,
  courseTitle,
  overview,
  selected,
  extractingChapterId,
  onSelectNode,
  onSelectChapterScope,
  onAddPoint,
  onEditPoint,
  onDeletePoint,
  onExtractChapter,
  onOpenMaterial,
}: {
  classroomId: number;
  courseTitle: string;
  overview: KnowledgeOverview | null;
  selected: GNode | null;
  extractingChapterId: number | null;
  onSelectNode: (node: GNode) => void;
  onSelectChapterScope: (chapterId: number) => void;
  onAddPoint: (chapterId?: number) => void;
  onEditPoint: (pointId: number) => void;
  onDeletePoint?: (point: KnowledgePointItem) => void;
  onExtractChapter: (chapterId: number) => void;
  onOpenMaterial: (materialId: number, pageNo?: number) => void;
}) {
  const [questions, setQuestions] = useState<QuestionNode[]>([]);
  const [qLoading, setQLoading] = useState(false);

  const selectedPointId = selected?.kind === "point" ? selected.pointId : null;

  useEffect(() => {
    if (!selectedPointId) return;
    const controller = new AbortController();
    Promise.resolve()
      .then(() => {
        if (!controller.signal.aborted) setQLoading(true);
        return api.get<{ items: QuestionNode[] }>(
          scoped(`/teacher/questions?knowledge_point_id=${selectedPointId}&page=1&size=10`, classroomId),
          controller.signal,
        );
      })
      .then((res) => {
        if (!controller.signal.aborted) {
          setQuestions(res.items ?? []);
          setQLoading(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setQuestions([]);
          setQLoading(false);
        }
      });
    return () => controller.abort();
  }, [classroomId, selectedPointId]);

  const chapters: KnowledgeChapter[] = overview?.chapters ?? [];
  const totalPoints = chapters.reduce((acc, ch) => acc + ch.points.length, 0);
  const totalSections = chapters.reduce((acc, ch) => {
    const secs = new Set(ch.points.map((p) => (p.section.trim() ? cleanGraphLabel(p.section) : cleanGraphLabel(ch.title))));
    return acc + secs.size;
  }, 0);

  if (selected && selected.kind === "point" && selected.point) {
    const pt = selected.point;
    const crumb = breadcrumbOf(selected);
    const pointTitle = cleanGraphLabel(pt.title);
    return (
      <div className="space-y-3">
        <div className="rounded-lg border p-3.5 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge>{KIND_LABELS.point}</Badge>
            {crumb && <span className="text-muted-foreground">{crumb}</span>}
          </div>
          <h3 className="text-base font-semibold leading-snug">{pointTitle}</h3>
          {pt.brief && <p className="text-sm text-muted-foreground leading-relaxed">{pt.brief}</p>}
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Button size="xs" variant="outline" onClick={() => onEditPoint(pt.id)}>
              <Pencil /> 编辑知识点
            </Button>
            {onDeletePoint && (
              <Button size="xs" variant="outline" className="text-destructive hover:text-destructive" onClick={() => onDeletePoint(pt)}>
                <Trash2 /> 删除知识点
              </Button>
            )}
            <ButtonLink
              size="xs"
              variant="outline"
              href={`/teacher/assessments?tab=bank&point=${pt.id}&pointName=${encodeURIComponent(pt.title)}`}
            >
              查看关联题目（{pt.question_count}）<ChevronRight />
            </ButtonLink>
          </div>
        </div>

        <div className="rounded-lg border p-3.5 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">PPT 课件来源</h4>
            <Badge variant="secondary">{pt.sources.length} 份</Badge>
          </div>
          {pt.sources.length === 0 ? (
            <p className="text-xs text-muted-foreground">暂无对应的课件页码标记。</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {pt.sources.map((src) => (
                <li key={src.material_id} className="flex items-center justify-between gap-2 rounded border px-2.5 py-1.5">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <FileText size={13} className="shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{src.material_title}</span>
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => onOpenMaterial(src.material_id, src.pages[0])}
                  >
                    第 {pageRanges(src.pages)} 页
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border p-3.5 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">相关题目</h4>
            <Badge variant="secondary">{pt.question_count}</Badge>
          </div>
          {qLoading ? (
            <Loading />
          ) : questions.length === 0 ? (
            <p className="text-xs text-muted-foreground">暂无关联题目，可在「题库与组卷」中 AI 出题或手动关联。</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {questions.map((q) => (
                <li key={q.id} className="rounded border px-2.5 py-2 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline">{kinds[q.kind as keyof typeof kinds] ?? q.kind}</Badge>
                    <span className="font-medium truncate">{q.title}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  if (selected && selected.kind !== "course") {
    const ch = chapters.find((c) => c.id === selected.chapterId) ?? null;
    const crumb = breadcrumbOf(selected);
    return (
      <div className="space-y-3">
        <div className="rounded-lg border p-3.5 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge>{KIND_LABELS[selected.kind]}</Badge>
            {crumb && <span className="text-muted-foreground">{crumb}</span>}
          </div>
          <h3 className="text-base font-semibold">{selected.full}</h3>
          <p className="text-xs text-muted-foreground">
            {selected.pages.length ? `覆盖课件第 ${pageRanges(selected.pages)} 页` : "暂无页码标记"}
          </p>
          {ch && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                size="xs"
                variant="outline"
                disabled={extractingChapterId === ch.id || ch.materials.length === 0}
                onClick={() => onExtractChapter(ch.id)}
              >
                <Sparkles /> {extractingChapterId === ch.id ? "提交中…" : ch.points.length ? "重新抽取知识点" : "AI 抽取知识点"}
              </Button>
              <Button size="xs" variant="outline" onClick={() => onAddPoint(ch.id)}>
                <Plus /> 新增知识点
              </Button>
            </div>
          )}
        </div>

        <div className="rounded-lg border p-3.5 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">{selected.kind === "chapter" ? "包含小节" : "包含知识点"}</h4>
            <Badge variant="secondary">{selected.children.length}</Badge>
          </div>
          {selected.children.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              本章尚无知识点。请先在「章节与课件」上传课件，再点击上方「AI 抽取知识点」自动从 PPT 中提取。
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {selected.children.map((child) => (
                <Button key={child.id} size="xs" variant="outline" onClick={() => onSelectNode(child)}>
                  {child.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border p-3.5 space-y-3">
        <div className="flex items-center justify-between">
          <Badge variant="outline">课程知识点总览</Badge>
        </div>
        <h3 className="text-base font-semibold">{courseTitle || "课程知识图谱"}</h3>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md bg-muted/40 py-2">
            <div className="text-lg font-bold">{chapters.length}</div>
            <div className="text-xs text-muted-foreground">章</div>
          </div>
          <div className="rounded-md bg-muted/40 py-2">
            <div className="text-lg font-bold">{totalSections}</div>
            <div className="text-xs text-muted-foreground">节</div>
          </div>
          <div className="rounded-md bg-muted/40 py-2">
            <div className="text-lg font-bold">{totalPoints}</div>
            <div className="text-xs text-muted-foreground">知识点</div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border p-3.5 space-y-2.5">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">各章 PPT 知识点</h4>
          <Badge variant="secondary">{chapters.length}</Badge>
        </div>
        {chapters.length === 0 ? (
          <Empty title="请先在「章节与课件」创建章节并上传 PPT/PDF" />
        ) : (
          <ul className="space-y-2">
            {chapters.map((ch) => (
              <li key={ch.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                  title={cleanGraphLabel(ch.title)}
                  onClick={() => onSelectChapterScope(ch.id)}
                >
                  {cleanGraphLabel(ch.title)}
                </button>
                <div className="flex shrink-0 items-center gap-1.5">
                  {ch.points.length > 0 && (
                    <Badge variant="secondary">{ch.points.length} 知识点</Badge>
                  )}
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={extractingChapterId === ch.id || ch.materials.length === 0}
                    onClick={() => onExtractChapter(ch.id)}
                  >
                    <Sparkles />
                    {extractingChapterId === ch.id
                      ? "抽取中…"
                      : ch.points.length > 0
                        ? "重新抽取"
                        : "AI 抽取"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
