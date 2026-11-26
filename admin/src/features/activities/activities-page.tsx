import { ListEmpty } from "@/components/common";
import { ManagementTable } from "@/components/management-table";
import {
  ErrorNotice,
  Loading,
  PageHeader,
  TableSearch,
} from "@/components/common";
import { SelectField } from "@/components/select-field";
import { DeleteSelection, useTableDelete } from "@/components/table-delete";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { scoped } from "@/lib/api";
import type { Activity, Course, Material, QuestionCandidate } from "@/lib/types";
import { useResource } from "@/lib/use-resource";
import { ListPlus, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { ActivityDialog } from "./editor-dialog";
import { kindName } from "./types";
import { useActivityEditor } from "./use-editor";
export function Activities({ courseId, teacherId }: { courseId: number; teacherId: number }) {
  const course = useResource<Course>(scoped("/teacher/catalog", courseId));
  const editor = useActivityEditor(courseId, course.reload, course.data);
  const { open, chapter, error, edit } = editor;
  const reading = editor.kind === "reading" || editor.kind === "lesson";
  const materials = useResource<Material[]>(open && reading ? scoped("/teacher/materials", courseId) : null);
  const questions = useResource<QuestionCandidate[]>(open && !reading && chapter ? scoped(`/teacher/chapters/${chapter}/question-candidates`, courseId) : null);

  const [query, setQuery] = useState(""),
    [chapterFilter, setChapterFilter] = useState("all"),
    [typeFilter, setTypeFilter] = useState("all");
  const deletion = useTableDelete<Activity>(
    (a) =>
      scoped(`/teacher/activities/${encodeURIComponent(a.id)}`, courseId),
    course.reload,
    { courseId, kind: () => "activity" },
  );
  const candidates = (questions.data ?? []).filter(
    (q) => q.status === "ready" &&
      (q.kind !== "interactive" || editor.kind === "practice"),
  );
  const practiceOwner = editor.editing ? editor.editing.owner_id : teacherId;
  const activities = (course.data?.activities ?? []).filter(
    (activity) =>
      activity.title.toLowerCase().includes(query.trim().toLowerCase()) &&
      (chapterFilter === "all" ||
        String(activity.chapter_id) === chapterFilter) &&
      (typeFilter === "all" || kindName[activity.kind] === typeFilter),
  );
  return (
    <>
      <PageHeader
        title="学习活动"
        description="把资料和题目组织成阅读、练习与测验。"
      >
        <Button
          onClick={() => edit(null)}
          disabled={!course.data?.chapters.length}
        >
          <Plus />
          新增活动
        </Button>
      </PageHeader>
      <ErrorNotice
        message={
          course.error ||
          materials.error ||
          questions.error ||
          (!open ? error : "")
        }
      />
      <div className="surface">
        <div className="toolbar">
          <TableSearch
            label="搜索活动"
            placeholder="搜索活动名称"
            value={query}
            onValueChange={setQuery}
          />
          <SelectField
            aria-label="活动所属章节"
            value={chapterFilter}
            onValueChange={setChapterFilter}
          >
            <option value="all">全部章节</option>
            {course.data?.chapters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </SelectField>
          <SelectField
            aria-label="活动类型"
            value={typeFilter}
            onValueChange={setTypeFilter}
          >
            <option value="all">全部类型</option>
            {["阅读", "练习", "测验"].map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </SelectField>
        <span id="activities-page-columns-0" className="ml-auto" /></div>
        {course.loading ? (
          <Loading />
        ) : course.error ? null : !activities.length ? (
          <ListEmpty title="尚无学习活动" filtered={Boolean(query.trim()) || chapterFilter !== "all" || typeFilter !== "all"} reset={() => { setQuery(""); setChapterFilter("all"); setTypeFilter("all"); }} action={course.data?.chapters.length ? <Button onClick={() => edit(null)}>创建第一个活动</Button> : undefined} description={!course.data?.chapters.length ? "先在内容列表创建章节，再添加活动。" : undefined} />
        ) : (
          <ManagementTable toolsId="activities-page-columns-0" paginate key={query + chapterFilter + typeFilter}>
            <TableHeader>
              <TableRow>
                <TableHead>活动名称</TableHead>
                <TableHead>章节</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>内容</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activities.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.title}</TableCell>
                  <TableCell>
                    {
                      course.data?.chapters.find((c) => c.id === a.chapter_id)
                        ?.title
                    }
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{kindName[a.kind]}{a.kind === "practice" && (a.practice_rules ? " · 按知识点出题" : " · 固定题单")}</Badge>
                  </TableCell>
                  <TableCell>
                    {a.kind === "lesson" || a.kind === "reading"
                      ? `${a.resources.length} 份资料 · ${a.resources.filter(row => row.required).length} 份必读`
                      : a.practice_rules
                        ? `${a.practice_rules.goals.length} 个知识点目标${a.published === false ? " · 草稿" : ""}`
                        : `${a.question_ids.length} 道题`}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {(a.kind === "practice" && !a.practice_rules) || a.kind === "assessment" ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`选题${a.title}`}
                          title="选题"
                          onClick={() => edit(a, true)}
                        >
                          <ListPlus />
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`编辑${a.title}`}
                        onClick={() => edit(a)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`删除${a.title}`}
                        title="删除活动"
                        onClick={() => deletion.ask([a])}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ManagementTable>
        )}
      </div>
      <DeleteSelection actions={deletion} />
      <ActivityDialog
        editor={editor}
        course={course}
        materials={materials}
        questions={questions}
        candidates={editor.goalPractice
          ? candidates.filter(q =>
              (q.owner_id === null || q.owner_id === practiceOwner) &&
              (q.kind !== "python" || q.has_samples))
          : candidates}
      />
    </>
  );
}
