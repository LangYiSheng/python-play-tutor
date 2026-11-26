import { ErrorNotice, Loading, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { DeleteSelection, useTableDelete } from "@/components/table-delete";
import { scoped } from "@/lib/api";
import type { Activity, Chapter, Course, QuestionCandidate } from "@/lib/types";
import { useResource } from "@/lib/use-resource";
import { ChevronLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { ActivityDialog } from "./editor-dialog";
import { useActivityEditor } from "./use-editor";
import { ChapterMaterials } from "./chapter-materials";

const sections = { objective: "客观题练习", programming: "编程题练习", assessment: "测验" } as const;
type Section = keyof typeof sections;

export function ChapterTasks({ courseId, chapter, onBack }: { courseId: number; chapter: Chapter; onBack: () => void }) {
  const course = useResource<Course>(scoped("/teacher/catalog", courseId));
  const editor = useActivityEditor(courseId, course.reload, course.data, chapter.id);
  const questions = useResource<QuestionCandidate[]>(editor.open ? scoped(`/teacher/chapters/${chapter.id}/question-candidates`, courseId) : null);
  const deletion = useTableDelete<Activity>(a => scoped(`/teacher/activities/${encodeURIComponent(a.id)}`, courseId), course.reload, {courseId, kind: () => "activity"});
  const candidates = (questions.data ?? []).filter(q => q.status === "ready" && (editor.kind === "assessment"
    ? q.kind !== "interactive" : (q.kind === "python") === (editor.practiceKind === "programming") && (q.kind !== "python" || q.has_samples)));
  const items = (course.data?.activities ?? []).filter(a => a.chapter_id === chapter.id)
    .sort((a,b) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.title.localeCompare(b.title, "zh-CN"));
  return <div className="space-y-5">
    <Button variant="ghost" onClick={onBack}><ChevronLeft/>返回章节</Button>
    <PageHeader title={chapter.title}/>
    <ChapterMaterials courseId={courseId} chapter={chapter}/>
    <ErrorNotice message={course.error || questions.error || (!editor.open ? editor.error : "")}/>
    {course.loading ? <Loading/> : (Object.keys(sections) as Section[]).map(key => {
      const rows = items.filter(a => key === "assessment" ? a.kind === "assessment" : a.kind === "practice" && a.practice_kind === key);
      return <section className="surface p-4" key={key}>
        <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">{sections[key]}</h2>
          <Button disabled={!course.data} variant="outline" onClick={() => editor.edit(null,false,key)}><Plus/>新增{sections[key]}</Button></div>
        {!rows.length && <p className="hint">本章暂无{sections[key]}。</p>}
        {rows.map(a => <div key={a.id} className="flex items-center gap-3 border-t py-2">
          <span className="flex-1">{a.title}</span><small>{a.required ? "必做" : "选做"} · {a.published === false ? "草稿" : "已发布"}</small>
          {!a.practice_rules && <Button variant="ghost" aria-label={`选题${a.title}`} onClick={() => editor.edit(a,true)}>选题</Button>}
          <Button variant="ghost" size="icon" aria-label={`编辑${a.title}`} onClick={() => editor.edit(a)}><Pencil/></Button>
          <Button variant="ghost" size="icon" aria-label={`删除${a.title}`} onClick={() => deletion.ask([a])}><Trash2/></Button>
        </div>)}
      </section>;
    })}
    <DeleteSelection actions={deletion}/>
    <ActivityDialog editor={editor} course={course} questions={questions} candidates={candidates}/>
  </div>;
}
