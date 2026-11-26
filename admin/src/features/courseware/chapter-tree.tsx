import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  Film,
  FolderOpen,
  Headphones,
  PanelLeftClose,
  Pencil,
  Plus,
  Presentation,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { materialKindLabel } from "@/lib/material-kind";
import type { Chapter, Material } from "@/lib/types";

function MaterialIcon({ kind }: { kind: string }) {
  if (kind === "presentation") return <Presentation size={14} className="shrink-0 text-muted-foreground" />;
  if (kind === "video") return <Film size={14} className="shrink-0 text-muted-foreground" />;
  return <FileText size={14} className="shrink-0 text-muted-foreground" />;
}

const kindBadge = materialKindLabel;

function statusLabel(status: string) {
  if (status === "ready") return "可用";
  if (status === "failed") return "失败";
  if (status === "queued") return "排队中";
  if (status === "processing") return "处理中";
  return status;
}

export function ChapterTree({
  chapters,
  materials,
  query,
  onQueryChange,
  selectedChapterId,
  selectedMaterialId,
  onSelectChapter,
  onSelectMaterial,
  onAddChapter,
  onEditChapter,
  onDeleteChapter,
  onUploadMaterial,
  onEditMaterial,
  onDeleteMaterial,
  onPreviewMaterial,
  onListenMaterial,
  onExtractKnowledge,
  onRetryMaterial,
  onCollapse,
}: {
  chapters: Chapter[];
  materials: Material[];
  query: string;
  onQueryChange: (value: string) => void;
  selectedChapterId: number | null;
  selectedMaterialId: number | null;
  onSelectChapter: (chapterId: number) => void;
  onSelectMaterial: (material: Material, chapterId: number | null) => void;
  onAddChapter: () => void;
  onEditChapter: (chapter: Chapter) => void;
  onDeleteChapter: (chapter: Chapter) => void;
  onUploadMaterial: (chapterId?: number) => void;
  onEditMaterial?: (material: Material) => void;
  onDeleteMaterial?: (material: Material) => void;
  onPreviewMaterial?: (material: Material) => void;
  onListenMaterial?: (material: Material) => void;
  onExtractKnowledge?: (material: Material) => void;
  onRetryMaterial?: (material: Material) => void;
  onCollapse?: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const term = query.trim().toLowerCase();

  function matchesMaterial(m: Material) {
    return !term || m.title.toLowerCase().includes(term);
  }

  function renderMaterialRow(m: Material, chapterId: number | null) {
    const matActive = selectedMaterialId === m.id;
    const narratable = ["pdf", "presentation"].includes(m.kind);
    const isBusy = m.status === "queued" || m.status === "processing";
    const isReady = m.status === "ready";
    const canRetry = Boolean(onRetryMaterial && (m.status === "failed" || m.kind === "presentation"));
    return (
      <li key={m.id}>
        <ContextMenu>
          <ContextMenuTrigger>
            <button
              type="button"
              aria-current={matActive ? "true" : undefined}
              className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs ${
                matActive ? "bg-primary text-primary-foreground" : "hover:bg-muted"
              }`}
              onClick={() => onSelectMaterial(m, chapterId)}
              title={`${m.title}（${kindBadge(m.kind)}，右键可编辑或删除）`}
            >
              <MaterialIcon kind={m.kind} />
              <span className="min-w-0 flex-1 truncate">{m.title}</span>
              <span
                className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-medium ${
                  matActive
                    ? "bg-primary-foreground/20 text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {kindBadge(m.kind)}
              </span>
              {m.status !== "ready" && (
                <Badge variant={m.status === "failed" ? "destructive" : "secondary"} className="h-4 px-1 text-[10px]">
                  {statusLabel(m.status)}
                </Badge>
              )}
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => onSelectMaterial(m, chapterId)}>
              <FolderOpen /> 打开工作区
            </ContextMenuItem>
            {onEditMaterial && (
              <ContextMenuItem onClick={() => onEditMaterial(m)}>
                <Pencil /> 编辑资料
              </ContextMenuItem>
            )}
            {onPreviewMaterial && (
              <ContextMenuItem disabled={!isReady} onClick={() => onPreviewMaterial(m)}>
                <Eye /> 预览原件
              </ContextMenuItem>
            )}
            {onListenMaterial && narratable && (
              <ContextMenuItem disabled={!isReady} onClick={() => onListenMaterial(m)}>
                <Headphones /> 试听配音
              </ContextMenuItem>
            )}
            {onExtractKnowledge && narratable && (
              <ContextMenuItem disabled={!isReady} onClick={() => onExtractKnowledge(m)}>
                <Sparkles /> AI 抽取知识点
              </ContextMenuItem>
            )}
            {canRetry && (
              <ContextMenuItem disabled={isBusy} onClick={() => onRetryMaterial?.(m)}>
                <RefreshCw /> 重新解析
              </ContextMenuItem>
            )}
            {onDeleteMaterial && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onClick={() => onDeleteMaterial(m)}>
                  <Trash2 /> 删除资料
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      </li>
    );
  }

  const uncategorized = materials.filter((m) => m.chapter_ids.length === 0 && matchesMaterial(m));

  return (
    <aside
      className="surface flex flex-col gap-2 p-2.5 lg:h-full lg:min-h-0 lg:w-56 shrink-0"
      aria-label="章节与资料目录"
    >
      <div className="flex items-center justify-between gap-1 shrink-0">
        <span className="px-0.5 text-xs font-medium text-muted-foreground">章节目录</span>
        {onCollapse && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label="收起左侧目录"
            title="收起左侧目录（快捷键 [）"
            onClick={onCollapse}
          >
            <PanelLeftClose /> 收起
          </Button>
        )}
      </div>
      <div className="flex gap-1.5 shrink-0">
        <Button size="xs" className="flex-1" onClick={onAddChapter}>
          <Plus /> 新增章节
        </Button>
        <Button size="xs" variant="outline" className="flex-1" onClick={() => onUploadMaterial()}>
          <Upload /> 上传资料
        </Button>
      </div>
      <div className="relative shrink-0">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-muted-foreground" />
        <Input
          aria-label="筛选章节或资料"
          placeholder="搜索章节或资料"
          className="h-8 pl-8 text-xs"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain pr-1 [scrollbar-width:thin]">
        {chapters.map((ch) => {
          const chMaterials = materials.filter((m) => m.chapter_ids.includes(ch.id));
          const visibleMats = chMaterials.filter(matchesMaterial);
          const chMatch = !term || ch.title.toLowerCase().includes(term);
          if (!chMatch && visibleMats.length === 0) return null;
          const isOpen = term ? true : !collapsed[ch.id];
          const active = selectedChapterId === ch.id && selectedMaterialId === null;

          return (
            <div key={ch.id} className="rounded-md border border-border/60 bg-background">
              <ContextMenu>
                <ContextMenuTrigger>
                  <div
                    className={`group flex items-center gap-1 px-2 py-1.5 text-sm ${
                      active ? "bg-accent font-medium text-accent-foreground" : "hover:bg-muted/60"
                    }`}
                  >
                    <button
                      type="button"
                      aria-label={`${isOpen ? "折叠" : "展开"}${ch.title}`}
                      className="p-0.5 text-muted-foreground hover:text-foreground"
                      onClick={() => setCollapsed((prev) => ({ ...prev, [ch.id]: isOpen }))}
                    >
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <button
                      type="button"
                      aria-current={active ? "true" : undefined}
                      className="min-w-0 flex-1 truncate text-left"
                      onClick={() => onSelectChapter(ch.id)}
                      title={`第 ${ch.order_index} 章 ${ch.title}`}
                    >
                      <span className="mr-1 text-xs text-muted-foreground">{ch.order_index}.</span>
                      {ch.title}
                    </button>
                    <span className="text-xs text-muted-foreground tabular-nums">{chMaterials.length}</span>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`编辑${ch.title}`}
                      onClick={() => onEditChapter(ch)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`删除${ch.title}`}
                      onClick={() => onDeleteChapter(ch)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => onUploadMaterial(ch.id)}>
                    <Upload /> 上传资料到此章
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => onEditChapter(ch)}>
                    <Pencil /> 编辑章节
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onClick={() => onDeleteChapter(ch)}>
                    <Trash2 /> 删除章节
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              {isOpen && (
                <ul className="space-y-0.5 border-t border-border/50 px-1.5 py-1">
                  {visibleMats.length === 0 ? (
                    <li className="px-2 py-1 text-xs text-muted-foreground">暂无关联资料</li>
                  ) : (
                    visibleMats.map((m) => renderMaterialRow(m, ch.id))
                  )}
                </ul>
              )}
            </div>
          );
        })}

        {uncategorized.length > 0 && (
          <div className="rounded-md border border-dashed border-border p-2">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <FolderOpen size={13} /> 未归类资料（{uncategorized.length}）
            </p>
            <ul className="space-y-0.5">
              {uncategorized.map((m) => renderMaterialRow(m, null))}
            </ul>
          </div>
        )}
      </div>
      <p className="shrink-0 border-t pt-2 text-[11px] leading-relaxed text-muted-foreground">
        上传或拖入 PPT / PDF 默认按名称独立成章；右键资料或章节可快捷编辑、删除。
      </p>
    </aside>
  );
}
