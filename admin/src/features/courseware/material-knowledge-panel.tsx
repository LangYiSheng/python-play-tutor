import { ChevronRight, ExternalLink, FileText, Network, Sparkles } from "lucide-react";
import { Empty } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { pageRanges } from "@/features/content-workspace/graph-layout";
import { cleanGraphLabel } from "@/features/content-workspace/studio-graph-layout";
import type { KnowledgePointItem } from "@/lib/course-studio-api";
import type { Material } from "@/lib/types";

export function MaterialKnowledgePanel({
  courseId,
  material,
  materialPoints,
  chapterPoints,
  extracting,
  onExtract,
  onJumpPage,
}: {
  courseId: number;
  material: Material;
  materialPoints: KnowledgePointItem[];
  chapterPoints: KnowledgePointItem[];
  extracting: boolean;
  onExtract: () => void;
  onJumpPage: (pageNo: number) => void;
}) {
  const canExtract = material.chapter_ids.length > 0 && material.status === "ready";
  const sections = new Map<string, KnowledgePointItem[]>();
  for (const pt of materialPoints) {
    const key = pt.section.trim() ? cleanGraphLabel(pt.section) : "未分节知识点";
    const list = sections.get(key) ?? [];
    list.push(pt);
    sections.set(key, list);
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto pr-1 [scrollbar-width:thin]">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Network size={15} className="text-primary shrink-0" />
          <span className="font-medium">
            {materialPoints.length > 0
              ? `本课件已关联 ${materialPoints.length} 个知识点（${sections.size} 个小节）`
              : "本课件暂未抽取知识点"}
          </span>
          {materialPoints.length === 0 && chapterPoints.length > 0 && (
            <span className="text-muted-foreground">
              · 所在章节已有 {chapterPoints.length} 个知识点（来自同章其他课件）
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant={materialPoints.length === 0 ? "default" : "outline"}
            disabled={extracting || !canExtract}
            title={
              material.chapter_ids.length === 0
                ? "请先点击「编辑资料」关联章节后再抽取"
                : undefined
            }
            onClick={onExtract}
          >
            <Sparkles />
            {extracting
              ? "正在抽取…"
              : materialPoints.length > 0
                ? "重新抽取本课件知识点"
                : "AI 抽取本课件知识点"}
          </Button>
          <ButtonLink size="xs" variant="outline" href={`/teacher/content-graph?course=${courseId}`}>
            打开知识图谱 <ExternalLink />
          </ButtonLink>
        </div>
      </div>

      {materialPoints.length === 0 ? (
        <div className="rounded-md border p-6 text-center space-y-3">
          <Empty
            title="这份课件还没有抽取知识点"
            description="点击上方「AI 抽取本课件知识点」，系统会自动识别本 PPT/PDF 的小节结构、核心知识点及对应页码，并在翻页时同步显示。"
          />
          {chapterPoints.length > 0 && (
            <p className="text-xs text-muted-foreground">
              提示：如果你在知识图谱中抽取的是同名另一份格式（例如 .pptx 与 .pdf 两个文件），点一次本课件抽取即可将页码绑定到当前文件。
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {Array.from(sections.entries()).map(([section, points]) => (
            <section key={section} className="rounded-md border bg-background">
              <header className="flex items-center justify-between border-b bg-muted/20 px-3 py-2">
                <h3 className="text-sm font-semibold">{section}</h3>
                <Badge variant="secondary" className="text-[11px]">
                  {points.length} 个知识点
                </Badge>
              </header>
              <ul className="divide-y">
                {points.map((pt) => {
                  const src = pt.sources.find((s) => s.material_id === material.id);
                  const pages = src?.pages ?? [];
                  return (
                    <li key={pt.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5 text-sm">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{cleanGraphLabel(pt.title)}</span>
                          {pages.length > 0 && (
                            <Button
                              type="button"
                              size="xs"
                              variant="secondary"
                              className="h-5 px-2 text-[11px]"
                              title={`跳转到第 ${pages[0]} 页查看幻灯片`}
                              onClick={() => onJumpPage(pages[0])}
                            >
                              <FileText /> 第 {pageRanges(pages)} 页
                            </Button>
                          )}
                        </div>
                        {pt.brief && (
                          <p className="text-xs text-muted-foreground leading-relaxed">{pt.brief}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <ButtonLink
                          size="xs"
                          variant="ghost"
                          href={`/teacher/assessments?course=${courseId}&tab=bank&point=${pt.id}&pointName=${encodeURIComponent(pt.title)}`}
                        >
                          关联题目（{pt.question_count}）<ChevronRight />
                        </ButtonLink>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
