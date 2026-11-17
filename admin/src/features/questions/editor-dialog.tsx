import { ErrorNotice } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Course, Material, Question } from "@/lib/types";
import { questionEditors } from "./editor-registry";
import { kinds, statuses } from "./types";
import type { useQuestionEditor } from "./use-editor";
export function QuestionDialog({
  editor,
  course,
  materials,
}: {
  editor: ReturnType<typeof useQuestionEditor>;
  course: { data: Course | null };
  materials: { data: Material[] | null };
}) {
  const {
    editing,
    open,
    setOpen,
    title,
    setTitle,
    prompt,
    setPrompt,
    kind,
    setKind,
    status,
    setStatus,
    chapterIds,
    setChapterIds,
    pointIds,
    setPointIds,
    referenceMaterial,
    setReferenceMaterial,
    referencePage,
    setReferencePage,
    error,
    busy,
    setDirty,
    save,
  } = editor;
  const TypeFields = questionEditors[kind].Fields;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) setOpen(v);
      }}
    >
      <DialogContent className="editor-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑题目" : "新增题目"}</DialogTitle>
          <DialogDescription>
            私有答案与用例仅用于教师维护和服务端判定。
          </DialogDescription>
        </DialogHeader>
        <form
          inert={busy}
          aria-busy={busy}
          onSubmit={save}
          onChange={() => setDirty(true)}
        >
          <div className="dialog-scroll">
            <ErrorNotice message={error} />
            <div className="field">
              <Label htmlFor="q-title">题目名称</Label>
              <Input
                id="q-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={200}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="field">
                <Label htmlFor="q-kind">题型</Label>
                <SelectField
                  id="q-kind"
                  value={kind}
                  onValueChange={(value) => {
                    setKind(value as Question["kind"]);
                    setDirty(true);
                  }}
                >
                  {Object.entries(kinds).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </SelectField>
              </div>
              <div className="field">
                <Label htmlFor="q-status">状态</Label>
                <SelectField
                  id="q-status"
                  value={status}
                  onValueChange={(value) => {
                    setStatus(value as Question["status"]);
                    setDirty(true);
                  }}
                >
                  {Object.entries(statuses).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </SelectField>
              </div>
            </div>
            <div className="field">
              <Label htmlFor="q-prompt">题干</Label>
              <Textarea
                id="q-prompt"
                rows={5}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                required
                maxLength={30000}
              />
            </div>
            <TypeFields {...editor} />
            <div className="field">
              <Label htmlFor="question-source">参考资料（可选）</Label>
              <SelectField
                id="question-source"
                value={referenceMaterial ?? ""}
                onValueChange={(value) => {
                  setDirty(true);
                  setReferenceMaterial(value ? Number(value) : null);
                  setReferencePage("");
                }}
              >
                <option value="">无参考资料</option>
                {materials.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </SelectField>
            </div>
            {referenceMaterial !== null && (
              <div className="field">
                <Label htmlFor="question-page">参考页码（可选）</Label>
                <Input
                  id="question-page"
                  type="number"
                  min={1}
                  step={1}
                  value={referencePage}
                  onChange={(e) => setReferencePage(e.target.value)}
                />
                <p className="hint">
                  按原始资料页码填写，保存时会检查页面是否存在。
                </p>
              </div>
            )}
            <fieldset className="field">
              <legend>关联章节</legend>
              <div className="check-list">
                {course.data?.chapters.map((c) => (
                  <label key={c.id}>
                    <input
                      type="checkbox"
                      checked={chapterIds.includes(c.id)}
                      onChange={() => {
                        setChapterIds((v) =>
                          v.includes(c.id)
                            ? v.filter((id) => id !== c.id)
                            : [...v, c.id],
                        );
                        setPointIds((v) =>
                          v.filter(
                            (id) =>
                              course.data?.knowledge_points.find(
                                (p) => p.id === id,
                              )?.chapter_id !== c.id,
                          ),
                        );
                      }}
                    />
                    {c.title}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="field">
              <legend>知识点（可选）</legend>
              <div className="check-list">
                {course.data?.knowledge_points
                  .filter((p) => chapterIds.includes(p.chapter_id))
                  .map((p) => (
                    <label key={p.id}>
                      <input
                        type="checkbox"
                        checked={pointIds.includes(p.id)}
                        onChange={() =>
                          setPointIds((v) =>
                            v.includes(p.id)
                              ? v.filter((id) => id !== p.id)
                              : [...v, p.id],
                          )
                        }
                      />
                      {p.title}
                    </label>
                  ))}
              </div>
            </fieldset>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "保存中…" : "保存题目"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
