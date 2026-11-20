import { EditorTabs } from "@/components/editor-tabs";
import { KnowledgePointPicker } from "@/features/curriculum/knowledge-point-picker";
import { Cases } from "./cases-editor";
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
  classroomId,
  course,
  materials,
}: {
  editor: ReturnType<typeof useQuestionEditor>;
  classroomId: number;
  course: { data: Pick<Course, "chapters"> | null };
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
      <DialogContent className="editor-dialog tabbed-editor">
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
            <EditorTabs pages={[
              { label: "题目信息", content: <>
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
              </> },
              { label: kind === "interactive" ? "编写与试答" : kind === "python" ? "初始代码与提示" : "答案", content: <TypeFields {...editor} /> },
              ...(kind === "python" ? [{ label: "测试用例", content: <Cases samples={editor.samples} hidden={editor.cases}
                onSamples={value => { editor.setSamples(value); setDirty(true); }}
                onHidden={value => { editor.setCases(value); setDirty(true); }} /> }] : []),
              { label: "内容关联", content: <>
                <KnowledgePointPicker chapters={course.data?.chapters ?? []} classroomId={classroomId}
                  initialChapterId={chapterIds[0] ?? course.data?.chapters[0]?.id ?? 0} selected={pointIds}
                  chapterSelection={{ ids: chapterIds, change: ids => { setChapterIds(ids); setDirty(true); } }}
                  onChange={ids => { setPointIds(ids); setDirty(true); }} />
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
              </> },
            ]} />
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
