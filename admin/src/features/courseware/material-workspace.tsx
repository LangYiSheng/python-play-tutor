import { useState } from "react";
import { Eye, Headphones, ListTodo, PanelLeftClose, PanelLeftOpen, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NarrationWorkbench } from "@/features/materials/narration/workbench";
import type { KnowledgePointItem } from "@/lib/course-studio-api";
import { materialKindLabel } from "@/lib/material-kind";
import type { Chapter, Material } from "@/lib/types";
import { MaterialKnowledgePanel } from "./material-knowledge-panel";

function statusText(status: string) {
  if (status === "ready") return "可用";
  if (status === "failed") return "转换失败";
  if (status === "queued") return "等待处理";
  if (status === "processing") return "处理中";
  return status;
}

export function MaterialWorkspace({
  courseId,
  material,
  chapters,
  materialPoints = [],
  chapterPoints = [],
  extractingKnowledge = false,
  taskCount = 0,
  busy,
  treeOpen = true,
  onToggleTree,
  onOpenTasks,
  onExtractKnowledge,
  onKnowledgeUpdated,
  onPreview,
  onListen,
  onEdit,
  onDelete,
  onRetry,
}: {
  courseId: number;
  material: Material;
  chapters: Chapter[];
  materialPoints?: KnowledgePointItem[];
  chapterPoints?: KnowledgePointItem[];
  extractingKnowledge?: boolean;
  taskCount?: number;
  busy: boolean;
  treeOpen?: boolean;
  onToggleTree?: () => void;
  onOpenTasks?: () => void;
  onExtractKnowledge?: () => void;
  onKnowledgeUpdated?: () => void;
  onPreview: (m: Material) => void;
  onListen: (m: Material) => void;
  onEdit: (m: Material) => void;
  onDelete: (m: Material) => void;
  onRetry?: (m: Material) => void;
}) {
  const [activeTab, setActiveTab] = useState("source");
  const [jumpTarget, setJumpTarget] = useState<{ pageNo: number; seq: number } | null>(null);
  const narratable = ["pdf", "presentation"].includes(material.kind);
  const readyNarratable = narratable && material.status === "ready";
  const chapterNames = material.chapter_ids
    .map((id) => chapters.find((c) => c.id === id)?.title)
    .filter((v): v is string => Boolean(v));

  function jumpToSlide(pageNo: number) {
    setJumpTarget((prev) => ({ pageNo, seq: (prev?.seq ?? 0) + 1 }));
    setActiveTab("source");
  }

  const settingsPane = (
    <div className="space-y-4 rounded-md border p-4 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs text-muted-foreground">资料类型</p>
          <p className="font-medium">{materialKindLabel(material.kind)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">当前状态</p>
          <div className="mt-0.5 flex items-center gap-2">
            <Badge variant={material.status === "ready" ? "outline" : "secondary"}>
              {statusText(material.status)}
            </Badge>
            {material.error && <span className="text-xs text-destructive">{material.error}</span>}
          </div>
        </div>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">关联章节</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {chapterNames.length ? (
            chapterNames.map((name) => (
              <Badge key={name} variant="secondary">
                {name}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">尚未关联任何章节</span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pt-2 border-t">
        {onRetry && (material.status === "failed" || material.kind === "presentation") && (
          <Button
            variant={material.status === "failed" ? "default" : "outline"}
            size="sm"
            disabled={busy || material.status === "queued" || material.status === "processing"}
            onClick={() => onRetry(material)}
          >
            <RefreshCw /> 重新解析
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy || material.status !== "ready"} onClick={() => onPreview(material)}>
          <Eye /> 预览原件
        </Button>
        <Button variant="outline" size="sm" onClick={() => onEdit(material)}>
          <Pencil /> 编辑与替换文件
        </Button>
        <Button variant="destructive" size="sm" onClick={() => onDelete(material)}>
          <Trash2 /> 删除资料
        </Button>
      </div>
    </div>
  );

  return (
    <section
      className="flex flex-1 min-w-0 min-h-0 flex-col gap-2 p-3 lg:h-full lg:overflow-hidden"
      aria-label={material.title}
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b pb-2">
        <div className="flex min-w-0 items-center gap-2">
          {onToggleTree && (
            <Button
              type="button"
              size="xs"
              variant={treeOpen ? "outline" : "secondary"}
              aria-label={treeOpen ? "收起章节目录" : "展开章节目录"}
              title={treeOpen ? "收起左侧章节目录（快捷键 [）" : "展开左侧章节目录（快捷键 [）"}
              onClick={onToggleTree}
            >
              {treeOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
              <span>{treeOpen ? "收起目录" : "展开目录"}</span>
            </Button>
          )}
          <h2 className="truncate text-base font-semibold">{material.title}</h2>
          <Badge variant="outline">{materialKindLabel(material.kind)}</Badge>
          <Badge variant={material.status === "ready" ? "secondary" : "destructive"}>
            {statusText(material.status)}
          </Badge>
          {chapterNames.length > 0 && (
            <span className="hidden truncate text-xs text-muted-foreground xl:inline">
              · {chapterNames.join("、")}
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {onOpenTasks && (
            <Button size="xs" variant={taskCount > 0 ? "secondary" : "outline"} onClick={onOpenTasks}>
              <ListTodo /> 制作任务{taskCount > 0 ? ` ${taskCount}` : ""}
            </Button>
          )}
          <Button size="xs" variant="outline" disabled={busy || material.status !== "ready"} onClick={() => onPreview(material)}>
            <Eye /> 预览原件
          </Button>
          {readyNarratable && (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => onListen(material)}>
              <Headphones /> 试听配音
            </Button>
          )}
          <Button size="xs" variant="outline" onClick={() => onEdit(material)}>
            <Pencil /> 编辑资料
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label={`删除${material.title}`} onClick={() => onDelete(material)}>
            <Trash2 />
          </Button>
        </div>
      </header>

      {readyNarratable ? (
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(String(value))}
          className="flex flex-1 min-h-0 flex-col gap-2 overflow-hidden"
        >
          <TabsList variant="line" aria-label="课件工作区" className="shrink-0">
            <TabsTrigger value="source">原文整理</TabsTrigger>
            <TabsTrigger value="script">口播与配音</TabsTrigger>
            <TabsTrigger value="knowledge">
              知识点{materialPoints.length > 0 ? `（${materialPoints.length}）` : ""}
            </TabsTrigger>
            <TabsTrigger value="settings">资料设置</TabsTrigger>
          </TabsList>
          <div
            hidden={activeTab !== "source" && activeTab !== "script"}
            className={
              activeTab === "source" || activeTab === "script"
                ? "min-h-0 flex-1 overflow-hidden flex flex-col"
                : "hidden"
            }
          >
            <NarrationWorkbench
              key={`${courseId}:${material.id}`}
              courseId={courseId}
              materialId={material.id}
              title={material.title}
              initialPage={jumpTarget?.pageNo}
              jumpTarget={jumpTarget}
              materialPoints={materialPoints}
              onOpenKnowledgeTab={() => setActiveTab("knowledge")}
              onKnowledgeUpdated={onKnowledgeUpdated}
              mode={activeTab === "script" ? "script" : "source"}
            />
          </div>
          <TabsContent value="knowledge" className="min-h-0 flex-1 overflow-hidden [&:not([hidden])]:flex [&:not([hidden])]:flex-col">
            <MaterialKnowledgePanel
              courseId={courseId}
              material={material}
              materialPoints={materialPoints}
              chapterPoints={chapterPoints}
              extracting={extractingKnowledge}
              onExtract={() => onExtractKnowledge?.()}
              onJumpPage={jumpToSlide}
            />
          </TabsContent>
          <TabsContent value="settings" className="flex-1 min-h-0 overflow-y-auto">
            {settingsPane}
          </TabsContent>
        </Tabs>
      ) : (
        <div className="flex-1 min-h-0 space-y-3 overflow-y-auto">
          {narratable && (
            <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
              {material.status === "failed"
                ? "资料转换失败，请检查错误或重新上传后再进行原文整理与口播制作。"
                : "资料正在转换处理中，就绪后将开放原文整理与口播配音工作区。"}
            </p>
          )}
          {settingsPane}
        </div>
      )}
    </section>
  );
}
