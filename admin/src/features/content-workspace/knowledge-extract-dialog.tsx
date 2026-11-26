import { useEffect, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { ErrorNotice } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api";
import { lectioApi, type KnowledgeChapter } from "@/lib/lectio-api";
import { materialKindLabel } from "@/lib/material-kind";

export function KnowledgeExtractDialog({
  open,
  courseId,
  chapters,
  initialChapterId,
  onOpenChange,
  onSubmitted,
}: {
  open: boolean;
  courseId: number;
  chapters: KnowledgeChapter[];
  initialChapterId?: number;
  onOpenChange: (open: boolean) => void;
  onSubmitted: () => void;
}) {
  const defaultChapterId = useMemo(() => {
    if (initialChapterId && chapters.some((c) => c.id === initialChapterId)) {
      return String(initialChapterId);
    }
    const withMats = chapters.find((c) => c.materials.some((m) => m.pages > 0));
    return String((withMats ?? chapters[0])?.id ?? "");
  }, [chapters, initialChapterId]);

  const [chapterId, setChapterId] = useState(defaultChapterId);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setChapterId(defaultChapterId);
    setError("");
  }, [open, defaultChapterId]);

  const activeChapter = chapters.find((c) => String(c.id) === chapterId) ?? null;
  const usableMaterials = useMemo(
    () => (activeChapter?.materials ?? []).filter((m) => m.pages > 0),
    [activeChapter],
  );

  useEffect(() => {
    if (!open) return;
    setSelectedIds(usableMaterials.map((m) => m.id));
  }, [open, usableMaterials]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!activeChapter || submitting) return;
    if (selectedIds.length === 0) {
      setError("请至少勾选一份包含页面内容的 PPT / PDF 课件。");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const allChosen = selectedIds.length === usableMaterials.length;
      await lectioApi.extractKnowledge(
        courseId,
        activeChapter.id,
        allChosen ? undefined : selectedIds,
      );
      toast.add({
        title: `已提交「${activeChapter.title}」AI 知识图谱抽取任务`,
        type: "success",
      });
      onSubmitted();
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>AI 生成知识图谱</DialogTitle>
          <DialogDescription>
            从已上传的 PPT / PDF 课件自动抽取小节与知识点结构，记录对应页码出处并合并到课程图谱中（不会删除已有知识点）。
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(e) => void submit(e)}>
          <ErrorNotice message={error} />
          {chapters.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              当前课程还没有章节，请先在「章节与课件」创建章节并上传 PPT / PDF。
            </p>
          ) : (
            <>
              <div className="field !mb-0">
                <Label htmlFor="kg-extract-chapter">目标章节</Label>
                <SelectField
                  id="kg-extract-chapter"
                  value={chapterId}
                  disabled={submitting}
                  onValueChange={(value) => {
                    setChapterId(value);
                    setError("");
                  }}
                >
                  {chapters.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {ch.title}（{ch.materials.length} 份资料 / {ch.points.length} 知识点）
                    </option>
                  ))}
                </SelectField>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>参与抽取的课件</Label>
                  {usableMaterials.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      已选 {selectedIds.length} / {usableMaterials.length} 份
                    </span>
                  )}
                </div>
                {usableMaterials.length === 0 ? (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    本章暂无已解析的 PPT / PDF 课件。请先前往「章节与课件」上传课件并等待解析完成。
                  </p>
                ) : (
                  <div className="max-h-52 space-y-1.5 overflow-y-auto rounded-md border p-2.5 [scrollbar-width:thin]">
                    {usableMaterials.map((mat) => {
                      const checked = selectedIds.includes(mat.id);
                      return (
                        <label
                          key={mat.id}
                          className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <Checkbox
                              checked={checked}
                              disabled={submitting}
                              onCheckedChange={(next) => {
                                setSelectedIds((prev) =>
                                  next
                                    ? [...new Set([...prev, mat.id])]
                                    : prev.filter((id) => id !== mat.id),
                                );
                              }}
                            />
                            <span className="truncate font-medium">{mat.title}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                            <Badge variant="outline">
                              {materialKindLabel(mat.kind)}
                            </Badge>
                            <span>{mat.pages} 页</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <p className="hint">
                  若课件已执行「一键梳理文本」，将优先基于整理稿抽取，准确率更高。
                </p>
              </div>
            </>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={submitting || !activeChapter || selectedIds.length === 0}
            >
              <Sparkles /> {submitting ? "提交中…" : "开始生成知识图谱"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
