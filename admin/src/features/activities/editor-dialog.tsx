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
import type { Activity, Course, Material, QuestionCandidate } from "@/lib/types";
import { PaperEditor } from "./paper-editor";
import { EditorTabs } from "@/components/editor-tabs";
import { ResourceEditor } from "./resource-editor";
import { PracticeGoalsEditor } from "./practice-goals-editor";
import type { useActivityEditor } from "./use-editor";
export function ActivityDialog({
  editor,
  course,
  materials,
  questions,
  candidates,
}: {
  editor: ReturnType<typeof useActivityEditor>;
  course: { data: Course | null };
  materials: { data: Material[] | null };
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
    setChapter,
    kind,
    setKind,
    resources,
    setResources,
    pointIds,
    setPointIds,
    npc,
    setNpc,
    assistant,
    setAssistant,
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
            {editing ? "编辑活动" : "新增活动"}
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
                <div className="grid grid-cols-2 gap-4">
                  <div className="field">
                    <Label htmlFor="a-chapter">章节</Label>
                    <SelectField
                      id="a-chapter"
                      disabled={Boolean(editing)}
                      value={chapter}
                      onValueChange={(value) => {
                        setChapter(Number(value));
                        setSelected([]);
                        setResources([]);
                        editor.setRules({ ...editor.rules, goals: [] });
                        setDirty(true);
                      }}
                    >
                      {course.data?.chapters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                    </SelectField>
                  </div>
                  <div className="field">
                    <Label htmlFor="a-kind">类型</Label>
                    <SelectField
                      id="a-kind"
                      disabled={Boolean(editing)}
                      value={kind}
                      onValueChange={(value) => {
                        setKind(value as Activity["kind"]);
                        if (value === "assessment") setSelected(ids => ids.filter(id => questions.data?.find(q => q.id === id)?.kind !== "interactive"));
                        setResources([]);
                        setDirty(true);
                      }}
                    >
                      <option value="lesson">阅读</option>
                      {kind === "reading" && (
                        <option value="reading">阅读</option>
                      )}
                      <option value="practice">练习</option>
                      <option value="assessment">测验</option>
                    </SelectField>
                  </div>
                </div>
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
              ...(kind === "reading" || kind === "lesson" ? [{label: "资料与阅读要求", content: <ResourceEditor classroomId={editor.classroomId} resources={resources} materials={materials.data ?? []} chapterId={chapter}
                    onChange={(value) => { setResources(value); setDirty(true); }} />}] : []),
              ...(editor.goalPractice ? [{label: "知识点目标", content: <>
                    <PracticeGoalsEditor rules={editor.rules}
                      points={(course.data?.knowledge_points ?? []).filter(point => point.chapter_id === chapter)}
                      candidates={questions.data ? candidates : null}
                      onChange={value => { editor.setRules(value); setDirty(true); }} />
                    <div className="field">
                      <Label htmlFor="practice-status">发布状态</Label>
                      <SelectField id="practice-status" value={editor.published ? "published" : "draft"}
                        onValueChange={value => { editor.setPublished(value === "published"); setDirty(true); }}>
                        <option value="published">已发布</option>
                        <option value="draft">草稿</option>
                      </SelectField>
                      <p className="hint">发布时会按整场练习检查题量，多个知识点共享的题目只分配一次。</p>
                    </div>
              </>}] : []),
              ...(kind === "assessment" || (kind === "practice" && !editor.goalPractice) ?
                ["按知识点选题", "题目顺序"].map(label => ({ label, content: <PaperEditor order={label === "题目顺序"} assessment={kind === "assessment"}
                  candidates={candidates} questions={questions.data ?? []} points={(course.data?.knowledge_points ?? []).filter(p => p.chapter_id === chapter)}
                  selected={selected} onChange={ids => { setSelected(ids); setDirty(true); }} /> })) : []),
              ...(kind !== "assessment" ? [{ label: "答疑设置", content: <>
                <div className="field">
                  <Label htmlFor="a-npc">答疑角色</Label>
                  <SelectField
                    id="a-npc"
                    placeholder="使用课程默认角色"
                    value={npc}
                    onValueChange={(value) => {
                      setNpc(value);
                      setDirty(true);
                    }}
                  >
                    <option value="">使用课程默认角色</option>
                    {course.data?.npcs.map((n) => (
                      <option key={n.key} value={n.key}>
                        {n.name}
                      </option>
                    ))}
                  </SelectField>
                </div>
                  <label className="flex items-center gap-2 mb-4">
                    <input
                      type="checkbox"
                      checked={assistant}
                      onChange={(e) => setAssistant(e.target.checked)}
                    />
                    允许学生主动向助教提问
                  </label>
              </> }] : []),
              { label: "内容关联", content: editor.goalPractice ? <div className="space-y-2"><strong>关联知识点</strong>
                <p>{editor.rules.goals.map(g => course.data?.knowledge_points.find(p => p.id === g.knowledge_point_id)?.title).join("、") || "尚未选择"}</p>
                <p className="hint">在「知识点目标」中调整本章练习范围。</p></div> : <KnowledgePointPicker
                  key={id}
                  chapters={course.data?.chapters ?? []}
                  points={course.data?.knowledge_points ?? []}
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
