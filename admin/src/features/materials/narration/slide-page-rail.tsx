import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, Layers, List } from "lucide-react";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { cleanGraphLabel } from "@/features/content-workspace/studio-graph-layout";
import type { KnowledgePointItem } from "@/lib/course-studio-api";
import type { NarrationPage } from "./api";
import { StatusBadge } from "./status-badge";

export type SlideRailMode = "knowledge" | "page";

export type SlidePageGroup = {
  key: string;
  kind: "knowledge" | "ungrouped";
  section: string;
  title: string;
  point: KnowledgePointItem | null;
  pages: NarrationPage[];
  firstPageNo: number;
};

export function pageStatusDot(status?: string) {
  if (status === "accepted") return { color: "bg-emerald-500", label: "已接受" };
  if (status === "draft") return { color: "bg-amber-500", label: "待审" };
  if (status === "rejected" || status === "unavailable") return { color: "bg-destructive", label: "未通过" };
  if (status === "stale") return { color: "bg-orange-400", label: "已失效" };
  return { color: "bg-muted-foreground/30", label: "未生成" };
}

function groupStatusDot(pages: NarrationPage[]) {
  if (pages.length === 0) return pageStatusDot(undefined);
  const statuses = pages.map((p) => p.narration?.status);
  if (statuses.every((s) => s === "accepted")) return { color: "bg-emerald-500", label: "本组全部已接受" };
  if (statuses.some((s) => s === "rejected" || s === "unavailable")) return { color: "bg-destructive", label: "本组含未通过页" };
  if (statuses.some((s) => s === "stale")) return { color: "bg-orange-400", label: "本组含已失效页" };
  if (statuses.some((s) => s === "draft" || s === "accepted")) return { color: "bg-amber-500", label: "本组部分待审或已生成" };
  return { color: "bg-muted-foreground/30", label: "本组未生成" };
}

export function buildSlidePageGroups(
  pages: NarrationPage[],
  materialPoints: KnowledgePointItem[],
  materialId: number,
): { groups: SlidePageGroup[]; hasKnowledgeGroups: boolean } {
  const pageByNo = new Map(pages.map((p) => [p.page_no, p]));
  const sortedPoints = materialPoints
    .map((pt) => {
      const src = pt.sources.find((s) => s.material_id === materialId);
      const validPages = Array.from(new Set(src?.pages ?? []))
        .filter((n) => pageByNo.has(n))
        .sort((a, b) => a - b);
      return { pt, validPages };
    })
    .filter((entry) => entry.validPages.length > 0)
    .sort((a, b) => a.validPages[0] - b.validPages[0] || a.pt.id - b.pt.id);

  if (sortedPoints.length === 0) {
    return { groups: [], hasKnowledgeGroups: false };
  }

  const assigned = new Set<number>();
  const kpGroups: SlidePageGroup[] = [];
  for (const { pt, validPages } of sortedPoints) {
    const ownedPages: NarrationPage[] = [];
    for (const no of validPages) {
      if (assigned.has(no)) continue;
      const page = pageByNo.get(no);
      if (page) {
        assigned.add(no);
        ownedPages.push(page);
      }
    }
    if (ownedPages.length === 0) continue;
    kpGroups.push({
      key: `kp-${pt.id}`,
      kind: "knowledge",
      section: pt.section.trim() ? cleanGraphLabel(pt.section) : "",
      title: cleanGraphLabel(pt.title),
      point: pt,
      pages: ownedPages,
      firstPageNo: ownedPages[0].page_no,
    });
  }

  if (kpGroups.length === 0) {
    return { groups: [], hasKnowledgeGroups: false };
  }

  const minKpPage = Math.min(...kpGroups.map((g) => g.firstPageNo));
  const maxKpPage = Math.max(...kpGroups.flatMap((g) => g.pages.map((p) => p.page_no)));

  // Group remaining unassigned pages into contiguous page runs in chronological order
  const ungroupedRuns: NarrationPage[][] = [];
  for (const p of pages) {
    if (assigned.has(p.page_no)) continue;
    const prevRun = ungroupedRuns[ungroupedRuns.length - 1];
    if (prevRun && prevRun[prevRun.length - 1].page_no + 1 === p.page_no) {
      prevRun.push(p);
    } else {
      ungroupedRuns.push([p]);
    }
  }

  const ungroupedGroups: SlidePageGroup[] = ungroupedRuns.map((run) => {
    const first = run[0].page_no;
    const last = run[run.length - 1].page_no;
    const label = last < minKpPage ? "封面 / 导言" : first > maxKpPage ? "结语 / 其他页" : "过渡 / 其他页";
    return {
      key: `ungrouped-${first}`,
      kind: "ungrouped",
      section: "",
      title: label,
      point: null,
      pages: run,
      firstPageNo: first,
    };
  });

  const groups = [...kpGroups, ...ungroupedGroups].sort((a, b) => a.firstPageNo - b.firstPageNo);
  return { groups, hasKnowledgeGroups: true };
}

export function SlidePageRail({
  pages,
  pageNo,
  onSelectPage,
  pointsByPage,
  groups,
  hasKnowledgeGroups,
  railMode,
  onRailModeChange,
  fullHeight,
}: {
  pages: NarrationPage[];
  pageNo: number | null;
  onSelectPage: (pageNo: number) => void;
  pointsByPage: Map<number, KnowledgePointItem[]>;
  groups: SlidePageGroup[];
  hasKnowledgeGroups: boolean;
  railMode: SlideRailMode;
  onRailModeChange: (mode: SlideRailMode) => void;
  fullHeight: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  const grouped = hasKnowledgeGroups && railMode === "knowledge";

  const activeGroupKey = grouped
    ? groups.find((g) => g.pages.some((p) => p.page_no === pageNo))?.key ?? null
    : null;

  useEffect(() => {
    if (!activeGroupKey) return;
    setCollapsed((prev) => {
      if (!prev[activeGroupKey]) return prev;
      const next = { ...prev };
      delete next[activeGroupKey];
      return next;
    });
  }, [activeGroupKey]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLButtonElement>('button[aria-current="true"]');
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [pageNo, grouped]);

  const hasOtherGroups = grouped && groups.some((g) => g.key !== activeGroupKey);
  const othersCollapsed = hasOtherGroups && groups.every((g) => g.key === activeGroupKey || Boolean(collapsed[g.key]));

  function toggleAllGroups() {
    if (othersCollapsed) {
      setCollapsed({});
    } else {
      const next: Record<string, boolean> = {};
      for (const g of groups) {
        if (g.key !== activeGroupKey) next[g.key] = true;
      }
      setCollapsed(next);
    }
  }

  function renderPageButton(item: NarrationPage, indented: boolean) {
    const dot = pageStatusDot(item.narration?.status);
    const pts = pointsByPage.get(item.page_no) ?? [];
    const kpSuffix = pts.length ? ` · 知识点：${pts.map((p) => p.title).join("、")}` : "";
    const active = item.page_no === pageNo;
    return (
      <button
        key={item.page_no}
        type="button"
        aria-current={active}
        title={`第 ${item.page_no} 页 · ${dot.label}${kpSuffix}`}
        className={`flex shrink-0 items-center justify-between gap-1.5 rounded border px-2 py-1 text-left text-xs lg:w-full ${
          indented ? "pl-3" : ""
        } ${
          active ? "border-primary bg-primary/5 font-medium text-foreground" : "border-transparent hover:bg-muted"
        }`}
        onClick={() => onSelectPage(item.page_no)}
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 tabular-nums">第 {item.page_no} 页</span>
          {indented && pts.length > 1 && (
            <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">+{pts.length - 1}</span>
          )}
        </span>
        {fullHeight ? (
          <span className={`size-2 shrink-0 rounded-full ${dot.color}`} aria-label={dot.label} />
        ) : (
          <StatusBadge status={item.narration?.status} />
        )}
      </button>
    );
  }

  let lastSection = "";

  return (
    <div
      className={
        fullHeight
          ? "flex flex-col gap-1.5 lg:h-full lg:min-h-0"
          : "flex max-h-[66vh] flex-col gap-1.5"
      }
      aria-label="幻灯片页码概览"
    >
      {hasKnowledgeGroups && (
        grouped ? (
          <div className="flex shrink-0 items-center justify-between gap-1">
            <div
              role="group"
              aria-label="页码概览视图"
              className="inline-flex flex-1 rounded-md border bg-muted/40 p-0.5 text-[11px]"
            >
              <button
                type="button"
                aria-pressed
                title="按知识点分组查看页面"
                className="flex flex-1 items-center justify-center gap-1 rounded bg-background px-1.5 py-0.5 font-medium text-foreground shadow-xs"
                onClick={() => onRailModeChange("knowledge")}
              >
                <Layers size={11} />
                <span>知识点</span>
              </button>
              <button
                type="button"
                aria-pressed={false}
                title="按页码顺序平铺查看"
                className="flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => onRailModeChange("page")}
              >
                <List size={11} />
                <span>页码</span>
              </button>
            </div>
            {hasOtherGroups && (
              <button
                type="button"
                aria-label={othersCollapsed ? "展开全部分组" : "折叠其他分组"}
                title={othersCollapsed ? "展开全部分组" : "折叠其他分组"}
                className="flex size-6 shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
                onClick={toggleAllGroups}
              >
                {othersCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            title="切换回按知识点分组查看页面"
            className="flex w-full shrink-0 items-center justify-center gap-1 rounded-md border bg-muted/40 px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => onRailModeChange("knowledge")}
          >
            <Layers size={11} />
            <span className="truncate">按知识点</span>
          </button>
        )
      )}

      <div
        ref={listRef}
        className={
          grouped
            ? "min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain pr-1 max-h-44 lg:max-h-none [scrollbar-width:thin]"
            : fullHeight
              ? "flex gap-1 overflow-x-auto pb-1 lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto lg:pb-0 lg:pr-1 overscroll-contain [scrollbar-width:thin]"
              : "min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 [scrollbar-width:thin]"
        }
      >
        {grouped
          ? groups.map((group) => {
              const showSection = Boolean(group.section && group.section !== lastSection);
              if (group.section) lastSection = group.section;
              const isCollapsed = Boolean(collapsed[group.key]);
              const isActiveGroup = group.key === activeGroupKey;
              const gDot = groupStatusDot(group.pages);

              return (
                <div key={group.key} className="space-y-1">
                  {showSection && (
                    <div
                      className="truncate px-1 pt-1 text-[10px] font-semibold tracking-wide text-muted-foreground"
                      title={group.section}
                    >
                      {group.section}
                    </div>
                  )}
                  <div
                    className={`rounded-md border transition-colors ${
                      isActiveGroup
                        ? "border-primary/40 bg-primary/[0.03]"
                        : group.kind === "ungrouped"
                          ? "border-dashed border-border/70 bg-muted/20"
                          : "border-border/60 bg-background"
                    }`}
                  >
                    <button
                      type="button"
                      aria-expanded={!isCollapsed}
                      title={`${group.section ? `${group.section} · ` : ""}${group.title}（共 ${group.pages.length} 页 · ${gDot.label}）`}
                      className="flex w-full items-center gap-1 px-1.5 py-1.5 text-left text-[11px] hover:bg-muted/50 rounded-t-md"
                      onClick={() =>
                        setCollapsed((prev) => ({
                          ...prev,
                          [group.key]: !prev[group.key],
                        }))
                      }
                    >
                      <ChevronDown
                        size={12}
                        className={`shrink-0 text-muted-foreground transition-transform duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${isCollapsed ? "-rotate-90" : ""}`}
                      />
                      <span
                        className={`min-w-0 flex-1 truncate ${
                          group.kind === "ungrouped" ? "text-muted-foreground" : "font-medium text-foreground"
                        }`}
                      >
                        {group.title}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {group.pages.length}页
                      </span>
                      {isCollapsed && (
                        <span className={`size-1.5 shrink-0 rounded-full ${gDot.color}`} aria-label={gDot.label} />
                      )}
                    </button>
                    <Collapsible open={!isCollapsed}>
                      <CollapsibleContent>
                        <div className="space-y-0.5 border-t border-border/40 p-1">
                          {group.pages.map((item) => renderPageButton(item, true))}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>
                </div>
              );
            })
          : pages.map((item) => renderPageButton(item, false))}
      </div>
    </div>
  );
}
