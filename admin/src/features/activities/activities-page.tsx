import { useId, useMemo, useState } from "react";
import { BookOpen, CirclePause, ClipboardList, Clock3, Code2, FileCheck2, ListChecks, Lock, LockOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { Empty, ErrorNotice, PageHeader } from "@/components/common";
import { WorkspaceSkeleton } from "@/components/skeletons";
import { DeleteSelection, useTableDelete } from "@/components/table-delete";
import { Button } from "@/components/ui/button";
import { scoped } from "@/lib/api";
import { chapterReleaseState, type ChapterRelease } from "@/lib/chapter-release";
import type { Activity, Chapter, Course, QuestionCandidate } from "@/lib/types";
import { useResource } from "@/lib/use-resource";
import { ChapterMaterials } from "./chapter-materials";
import { ActivityDialog } from "./editor-dialog";
import { useActivityEditor } from "./use-editor";
import { SortableActivities } from "./sortable-activities";
import "./workspace.css";

const categories = [
  { key: "objective", label: "客观题练习", icon: ClipboardList },
  { key: "programming", label: "编程题练习", icon: Code2 },
  { key: "assessment", label: "测验", icon: FileCheck2 },
] as const;

const releaseIcons = {
  published: { icon: LockOpen, label: "已开放" },
  unpublished: { icon: Lock, label: "未开放" },
  scheduled: { icon: Clock3, label: "等待开放" },
  paused: { icon: CirclePause, label: "已暂停" },
};

export function LearningTasks({ courseId, classroomId }: { courseId: number; classroomId?: number | null }) {
  const id = useId();
  const course = useResource<Course>(scoped("/teacher/catalog", courseId));
  const releases = useResource<ChapterRelease[]>(classroomId ? `/teacher/classrooms/${classroomId}/releases` : null);
  const [selected, setSelected] = useState(() => Number(new URLSearchParams(location.search).get("chapter")));
  const chapters = course.data?.chapters ?? [];
  const chapter = chapters.find(item => item.id === selected) ?? chapters[0];
  const chapterNumber = chapter ? chapter.order_index ?? chapters.indexOf(chapter) + 1 : null;
  const releaseByChapter = releases.data && new Map(releases.data.map(release => [release.chapter_id, release]));

  function selectChapter(id: number) {
    setSelected(id);
    const url = new URL(location.href);
    url.searchParams.set("chapter", String(id));
    history.replaceState(history.state, "", url);
  }

  return <div className="space-y-4">
    <PageHeader title="学习任务" />
    <ErrorNotice message={course.error} />
    <ErrorNotice message={releases.error} />
    {course.loading ? <WorkspaceSkeleton /> : chapter && course.data ? <div className="activity-workspace">
      <nav aria-label="选择章节" className="activity-chapters">
        <h2>课程章节</h2>
        <div>{chapters.map(item => {
          const state = releaseByChapter && chapterReleaseState(releaseByChapter.get(item.id));
          const status = state ? releaseIcons[state] : null;
          const statusId = `${id}-release-${item.id}`;
          return <button type="button" key={item.id} aria-current={item.id === chapter.id ? "page" : undefined}
            aria-describedby={status ? statusId : undefined} onClick={() => selectChapter(item.id)}>
            <BookOpen size={16} aria-hidden="true"/><span>{item.title}</span>
            {status && <span className="activity-chapter-status" data-state={state} title={status.label}>
              <status.icon size={15} aria-hidden="true" />
              <span id={statusId} hidden>{status.label}</span>
            </span>}
          </button>;
        })}</div>
      </nav>
      <div key={chapter.id} className="page-enter min-w-0 space-y-4">
        <h2 className="activity-chapter-heading text-xl font-semibold" aria-label={`第 ${chapterNumber} 章 ${chapter.title}`}>
          <span className="activity-chapter-number" aria-hidden="true">{chapterNumber}</span>
          {chapter.title}
        </h2>
        <ChapterMaterials courseId={courseId} chapter={chapter}/>
        <ChapterActivities courseId={courseId} chapter={chapter} course={course.data} reload={course.reload}/>
      </div>
    </div> : !course.error && <Empty title="暂无章节" description="请先在「章节与课件」中创建章节。" />}
  </div>;
}

function ChapterActivities({ courseId, chapter, course, reload }: {
  courseId: number; chapter: Chapter; course: Course; reload: () => void;
}) {
  const editor = useActivityEditor(courseId, reload, course, chapter.id);
  const questions = useResource<QuestionCandidate[]>(editor.open ? scoped(`/teacher/chapters/${chapter.id}/question-candidates`, courseId) : null);
  const deletion = useTableDelete<Activity>(a => scoped(`/teacher/activities/${encodeURIComponent(a.id)}`, courseId), reload, {courseId, kind: () => "activity"});
  const candidates = (questions.data ?? []).filter(q => q.status === "ready" && (editor.kind === "assessment"
    ? q.kind !== "interactive" : q.usage !== "assessment" && (q.kind === "python") === (editor.practiceKind === "programming") && (q.kind !== "python" || q.has_samples)));
  const items = useMemo(() => course.activities.filter(a => a.chapter_id === chapter.id && (a.kind === "practice" || a.kind === "assessment"))
    .sort((a,b) => (a.order_index ?? 0) - (b.order_index ?? 0)), [course.activities, chapter.id]);
  return <section className="surface min-w-0 self-start">
    <header className="activity-panel-heading">
      <h3 className="text-lg font-semibold">练习与测验</h3>
      <div className="flex flex-wrap gap-2">{categories.map(({key, label}) =>
        <Button key={key} variant="outline" onClick={() => editor.edit(null, false, key)}><Plus/>新增{label}</Button>)}</div>
    </header>
    <ErrorNotice message={!editor.open ? editor.error : ""}/>
    {items.length ? <SortableActivities items={items} courseId={courseId} chapterId={chapter.id} reload={reload} renderRow={a => {
      const category = categories.find(c => c.key === (a.kind === "assessment" ? a.kind : a.practice_kind)) ?? categories[0];
      const Icon = category.icon;
      return <><span className="activity-icon"><Icon size={19}/></span>
        <div className="min-w-0"><h3 className="break-words font-medium">{a.title}</h3>
          <div className="hint">{category.label} · {a.kind === "assessment" || a.required !== false ? "必做" : "选做"} · {a.practice_rules ? `${a.practice_rules.goals.length} 个知识点目标` : `${a.question_ids.length} 道题`}</div></div>
        <span className="activity-status" data-published={a.published !== false}>{a.published === false ? "草稿" : "已发布"}</span>
        <div className="activity-actions">
          {!a.practice_rules && <Button variant="ghost" size="sm" aria-label={`选题${a.title}`} onClick={() => editor.edit(a,true)}><ListChecks/>选题</Button>}
          <Button variant="ghost" size="sm" aria-label={`编辑${a.title}`} onClick={() => editor.edit(a)}><Pencil/>编辑</Button>
          <Button variant="ghost" size="icon" title={`删除${a.title}`} aria-label={`删除${a.title}`} onClick={() => deletion.ask([a])}><Trash2/></Button>
        </div></>;
    }}/> : <Empty title="本章暂无活动" description="选择上方的活动类型，添加本章的第一组练习或测验。" />}
    <DeleteSelection actions={deletion}/>
    <ActivityDialog editor={editor} course={{data:course}} questions={questions} candidates={candidates}/>
  </section>;
}
