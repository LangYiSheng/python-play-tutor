import { useState, type FormEvent } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ErrorNotice } from "@/components/common";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/select-field";
import { useDraft } from "@/lib/drafts";
import { api, scoped, errorMessage } from "@/lib/api";
import type { Chapter, Point } from "@/lib/types";

export function CurriculumDialog({ classroomId, tab, chapters, editing, chapterId, onClose }: {
  classroomId: number; tab: "chapters" | "points"; chapters: Chapter[];
  editing: Chapter | Point | null; chapterId?: number; onClose: (saved: boolean) => void;
}) {
  const [title, setTitle] = useState(editing?.title ?? "");
  const [order, setOrder] = useState(editing && "order_index" in editing ? editing.order_index : chapters.length + 1);
  const [chapter, setChapter] = useState(editing && "chapter_id" in editing ? editing.chapter_id : chapterId ?? chapters[0]?.id ?? 0);
  const [summary, setSummary] = useState(editing && "content" in editing ? String(editing.content.summary_markdown ?? "") : "");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [dirty, setDirty] = useState(false);
  useDraft(dirty);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (tab === "points" && !chapter) {
      setError("请选择所属章节。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body =
        tab === "chapters"
          ? { title, order_index: order }
          : {
              title,
              content: {
                ...(editing && "content" in editing ? editing.content : {}),
                summary_markdown: summary,
              },
              ...(!editing ? { chapter_id: chapter } : {}),
            };
      const endpoint = `/teacher/${tab === "chapters" ? "chapters" : "knowledge-points"}${editing ? `/${editing.id}` : ""}`;
      await (editing ? api.put : api.post)(scoped(endpoint, classroomId), body);
      onClose(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
      <Dialog
        open
        onOpenChange={(value) => {
          if (!busy && !value) onClose(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? "编辑" : "新增"}
              {tab === "chapters" ? "章节" : "知识点"}
            </DialogTitle>
            <DialogDescription>修改仅作用于当前班级课程。</DialogDescription>
          </DialogHeader>
          <form inert={busy} aria-busy={busy} onSubmit={save} onChange={() => setDirty(true)}>
            <ErrorNotice message={error} />
            <div className="field">
              <Label htmlFor="curr-title">名称</Label>
              <Input
                id="curr-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                required
              />
            </div>
            {tab === "chapters" ? (
              <div className="field">
                <Label htmlFor="curr-order">章节顺序</Label>
                <Input
                  id="curr-order"
                  type="number"
                  min={1}
                  value={order}
                  onChange={(e) => setOrder(Number(e.target.value))}
                  required
                />
              </div>
            ) : (
              <>
                <div className="field">
                  <Label htmlFor="curr-chapter">所属章节</Label>
                  <SelectField
                    id="curr-chapter"
                    value={chapter}
                    disabled={Boolean(editing)}
                    onValueChange={(value) => { setChapter(Number(value)); setDirty(true); }}
                    required
                  >
                    <option value="">选择章节</option>
                    {chapters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </SelectField>
                </div>
                <div className="field">
                  <Label htmlFor="curr-summary">知识点说明</Label>
                  <Textarea
                    id="curr-summary"
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                  />
                </div>
              </>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => onClose(false)}
                disabled={busy}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
  );
}
