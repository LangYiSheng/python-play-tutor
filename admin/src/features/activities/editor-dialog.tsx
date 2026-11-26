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
import { KnowledgePointPicker } from "@/features/curriculum/knowledge-point-picker";
import type { Course, QuestionCandidate } from "@/lib/types";
import { PaperEditor } from "./paper-editor";
import { EditorTabs } from "@/components/editor-tabs";
import { PracticeGoalsEditor } from "./practice-goals-editor";
import type { useActivityEditor } from "./use-editor";
export function ActivityDialog({
  editor,
  course,
  questions,
  candidates,
}: {
  editor: ReturnType<typeof useActivityEditor>;
  course: { data: Course | null };
  questions: { data: QuestionCandidate[] | null };
  candidates: QuestionCandidate[];
}) {
  const {
    editing,
    open,
    setOpen,
    questionMode,
    title,
    setTitle,
    id,
    chapter,
    kind,
    pointIds,
    setPointIds,
    selected,
    setSelected,
    error,
    busy,
    setDirty,
    save,
  } = editor;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) setOpen(v);
      }}
    >
      <DialogContent className="editor-dialog tabbed-editor activity-editor">
        <DialogHeader>
          <DialogTitle>
            {editing ? "编辑" : "新增"}{kind === "assessment" ? "测验" : editor.practiceKind === "programming" ? "编程题练习" : "客观题练习"}
          </DialogTitle>
          <DialogDescription>
            完成条件由服务端依据真实学习记录判定。
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
            <EditorTabs initial={questionMode ? "按知识点选题" : "活动信息"} pages={[
              { label: "活动信息", content: <>
                <div className="field">
                  <Label htmlFor="a-title">活动名称</Label>
                  <Input
                    id="a-title"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="field">显示顺序<Input type="number" min={0} max={100000} required value={editor.order} onChange={e => editor.setOrder(Number(e.target.value))}/></label>
                  <label className="field">发布状态<SelectField value={editor.published ? "published" : "draft"} onValueChange={value => { editor.setPublished(value === "published"); setDirty(true); }}>
                    <option value="published">已发布</option><option value="draft">草稿</option></SelectField></label>
                </div>
                {kind === "practice" && <label className="flex gap-2"><input type="checkbox" checked={editor.required} onChange={e => editor.setRequired(e.target.checked)}/>必做练习</label>}
                {kind === "practice" && (
                  <fieldset className="field">
                    <legend>出题方式</legend>
                    <div className="flex gap-6">
                      <label className="flex items-center gap-2">
                        <input type="radio" name="practice-mode" value="fixed"
                          checked={editor.practiceMode === "fixed"} onChange={() => editor.setPracticeMode("fixed")} />
                        固定题单
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="radio" name="practice-mode" value="goals"
                          checked={editor.practiceMode === "goals"} onChange={() => editor.setPracticeMode("goals")} />
                        按知识点出题
                      </label>
                    </div>
                    {editor.goalPractice && editing && editing.question_ids.length > 0 && !editing.practice_rules &&
                      <p className="hint">保存后会移除原固定题单，按知识点目标分配题目。</p>}
                  </fieldset>
                )}
              </> },
              ...(editor.goalPractice ? [{label: "知识点目标", content: <>
                    <PracticeGoalsEditor practiceKind={editor.practiceKind} rules={editor.rules}
                      points={(course.data?.knowledge_points ?? []).filter(point => point.chapter_id === chapter)}
                      candidates={questions.data ? candidates : null}
                      onChange={value => { editor.setRules(value); setDirty(true); }} />
              </>}] : []),
              ...(kind === "assessment" || (kind === "practice" && !editor.goalPractice) ?
                ["按知识点选题", "题目顺序"].map(label => ({ label, content: <PaperEditor order={label === "题目顺序"} assessment={kind === "assessment"}
                  candidates={candidates} questions={questions.data ?? []} points={(course.data?.knowledge_points ?? []).filter(p => p.chapter_id === chapter)}
                  selected={selected} onChange={ids => { setSelected(ids); setDirty(true); }} /> })) : []),
              { label: "内容关联", content: editor.goalPractice ? <div className="space-y-2"><strong>关联知识点</strong>
                <p>{editor.rules.goals.map(g => course.data?.knowledge_points.find(p => p.id === g.knowledge_point_id)?.title).join("、") || "尚未选择"}</p>
                <p className="hint">在「知识点目标」中调整本章练习范围。</p></div> : <KnowledgePointPicker
                  key={id}
                  chapters={(course.data?.chapters ?? []).filter(c => c.id === chapter)}
                  points={(course.data?.knowledge_points ?? []).filter(p => p.chapter_id === chapter)}
                  selected={pointIds}
                  initialChapterId={chapter}
                  onChange={(ids) => {
                    setPointIds(ids);
                    setDirty(true);
                  }}
                /> },
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
              {busy ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
