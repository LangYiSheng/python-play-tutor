import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ErrorNotice, Loading, Pager } from "@/components/common";
import { scoped } from "@/lib/api";
import { useCatalogPage } from "@/lib/use-catalog-page";
import { useResource } from "@/lib/use-resource";
import type { Chapter, Point } from "@/lib/types";
import { X } from "lucide-react";
import { useId, useState } from "react";

export function KnowledgePointPicker({
  chapters,
  points = [],
  classroomId,
  selected,
  initialChapterId,
  chapterSelection,
  onChange,
}: {
  chapters: Chapter[];
  points?: Point[];
  classroomId?: number;
  selected: number[];
  initialChapterId: number;
  chapterSelection?: { ids: number[]; change: (ids: number[]) => void };
  onChange: (ids: number[]) => void;
}) {
  const id = useId();
  const [focused, setFocused] = useState(initialChapterId);
  const chapterId = chapters.some(c => c.id === focused) ? focused : initialChapterId;
  const remote = classroomId !== undefined;
  const page = useCatalogPage<Point>("/teacher/knowledge-points", classroomId ?? 0, "",
    { chapter_id: String(chapterId) }, remote && !!chapterId);
  const selectedIds = [...new Set(selected)];
  const params = new URLSearchParams(selectedIds.map(key => ["ids", String(key)]));
  const labels = useResource<Pick<Point, "id" | "chapter_id" | "title">[]>(
    remote && selectedIds.length ? scoped("/teacher/knowledge-point-labels?" + params, classroomId) : null);
  const uniquePoints = new Map([...points, ...page.rows, ...(labels.data ?? [])].map(point => [point.id, point]));
  const groups = [...chapters].sort((a, b) => a.order_index - b.order_index);
  const visible = remote ? page.rows : [...uniquePoints.values()].filter(point => point.chapter_id === chapterId);
  function focusChapter(next: number) {
    setFocused(next);
    page.firstPage();
  }

  return (
    <fieldset className="field">
      <legend>关联知识点</legend>
      <ErrorNotice message={page.error || labels.error} />
      <div className="editor-columns knowledge-columns">
        <ScrollArea label="章节"><div className="knowledge-rows">
          {groups.map(c => <div key={c.id} className="flex items-center gap-2">
            {chapterSelection && <Checkbox aria-label={`关联${c.title}`} checked={chapterSelection.ids.includes(c.id)}
              disabled={remote && selectedIds.length > 0 && (!labels.data || labels.loading)}
              onCheckedChange={checked => {
                chapterSelection.change(checked ? [...chapterSelection.ids, c.id] : chapterSelection.ids.filter(key => key !== c.id));
                if (!checked) onChange(selectedIds.filter(key => uniquePoints.get(key)?.chapter_id !== c.id));
                focusChapter(c.id);
              }} />}
            <button type="button" className="editor-list-item" aria-pressed={c.id === chapterId}
              onClick={() => focusChapter(c.id)}>{c.title}</button>
          </div>)}
        </div></ScrollArea>
        <ScrollArea label="知识点" key={chapterId}>
      {remote && page.loading ? <Loading /> : visible.length ? (
        <div className="knowledge-rows" role="group" aria-label="当前章节知识点">
          {visible.map((point) => (
            <Label
              key={point.id}
              htmlFor={`${id}-point-${point.id}`}
              className="min-h-10 cursor-pointer rounded-sm px-2 hover:bg-muted"
            >
              <Checkbox
                id={`${id}-point-${point.id}`}
                checked={selectedIds.includes(point.id)}
                disabled={
                  !selectedIds.includes(point.id) && selectedIds.length >= 65
                }
                onCheckedChange={(checked) => {
                  if (checked && chapterSelection && !chapterSelection.ids.includes(point.chapter_id)) chapterSelection.change([...chapterSelection.ids, point.chapter_id]);
                  onChange(
                    checked
                      ? [...new Set([...selectedIds, point.id])]
                      : selectedIds.filter((key) => key !== point.id),
                  );
                }}
              />
              {point.title}
            </Label>
          ))}
        </div>
      ) : (
        <p className="hint p-3">本章暂无知识点，可选择其他章节。</p>
      )}
        </ScrollArea>
      </div>
      {remote && page.pager.total > page.pager.size && <Pager {...page.pager} />}
      <div className="space-y-2" role="group" aria-label="已选知识点">
        <p className="text-sm text-muted-foreground">
          已选 {selectedIds.length} / 65
        </p>
        <div className="flex flex-wrap gap-2">
          {selectedIds.map((key) => {
            const point = uniquePoints.get(key);
            const chapter = groups.find(
              (item) => item.id === point?.chapter_id,
            );
            return (
              <span
                key={key}
                className="inline-flex max-w-full items-center gap-1 rounded-md border pl-2 text-sm"
              >
                <span>
                  {point?.title ?? "知识点已不可用"}
                  {chapter ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      · {chapter.title}
                    </span>
                  ) : null}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`移除${point?.title ?? "不可用知识点"}`}
                  onClick={() =>
                    onChange(selectedIds.filter((value) => value !== key))
                  }
                >
                  <X />
                </Button>
              </span>
            );
          })}
        </div>
      </div>
    </fieldset>
  );
}
