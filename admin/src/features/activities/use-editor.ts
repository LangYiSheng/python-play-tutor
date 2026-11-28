import { api, errorMessage, scoped } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { newId } from "@/lib/id";
import type { Activity, Course, PracticeRules } from "@/lib/types";
import { useState, type FormEvent } from "react";
export function useActivityEditor(
  courseId: number,
  onSaved: () => void,
  course: Course | null,
  chapterId: number,
) {
  const [editing, setEditing] = useState<Activity | null>(null),
    [open, setOpen] = useState(false),
    [questionMode, setQuestionMode] = useState(false),
    [title, setTitle] = useState(""),
    [id, setId] = useState(""),
    [chapter, setChapter] = useState(0),
    [kind, setKind] = useState<Activity["kind"]>("practice"),
    [pointIds, setPointIds] = useState<number[]>([]),
    [rules, setRules] = useState<PracticeRules>({ goals: [] }),
    [practiceMode, setPracticeMode] = useState<"fixed" | "goals">("goals"),
    [published, setPublished] = useState(true),
    [practiceKind, setPracticeKind] = useState<"objective" | "programming">("objective"),
    [required, setRequired] = useState(true),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  useDraft(open && dirty);
  const goalPractice = kind === "practice" && practiceMode === "goals";
  function edit(a: Activity | null, pick = false, category: "objective" | "programming" | "assessment" = "objective") {
    setEditing(a);
    setId(a?.id ?? newId("activity"));
    const chapterTitle = course?.chapters.find(item => item.id === chapterId)?.title;
    const categoryLabel = { objective: "客观题练习", programming: "编程题练习", assessment: "测验" }[category];
    setTitle(a?.title ?? [chapterTitle, categoryLabel].filter(Boolean).join(" "));
    setChapter(chapterId);
    setKind(a?.kind ?? (category === "assessment" ? "assessment" : "practice"));
    setPointIds(a?.knowledge_point_ids ?? []);
    setRules(structuredClone(a?.practice_rules ?? { goals: [] }));
    setPracticeMode((a ? !a.practice_rules : category === "programming") ? "fixed" : "goals");
    setPublished(a?.published ?? true);
    setPracticeKind(a?.practice_kind ?? (category === "programming" ? "programming" : "objective"));
    setRequired(a?.required ?? true);
    setSelected(a?.question_ids ?? []);
    setQuestionMode(pick);
    setError("");
    setDirty(false);
    setOpen(true);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setError("请在「活动信息」中填写活动名称。"); return; }
    if (goalPractice) {
      if (!rules.goals.length) {
        setError("请至少选择一个本章知识点。");
        return;
      }
      const emptyGoal = rules.goals.find(goal => !goal.total && !Object.values(goal.by_kind).some(count => count > 0));
      if (emptyGoal) {
        const point = course?.knowledge_points.find(item => item.id === emptyGoal.knowledge_point_id);
        setError(`请为“${point?.title ?? "知识点"}”填写答对总数或题型数量。`);
        return;
      }
    }
    setBusy(true);
    setError("");
    try {
      const body = {
        title,
        ...(kind === "practice" && {practice_kind: practiceKind}),
        published, required: kind === "assessment" || required,
        ...((kind === "assessment" || (kind === "practice" && !goalPractice)) &&
          (!editing || selected.length !== editing.question_ids.length || selected.some((id,i) => id !== editing.question_ids[i])) &&
          { question_ids: selected }),
        knowledge_point_ids: goalPractice ? rules.goals.map(goal => goal.knowledge_point_id) : pointIds,
        ...(goalPractice && { practice_rules: rules, published }),
        ...(kind === "practice" && practiceMode === "fixed" && { practice_rules: null }),
      };
      if (editing)
        await api.put(
          scoped(
            `/teacher/activities/${encodeURIComponent(id)}`,
            courseId,
          ),
          body,
        );
      else
        await api.post(scoped("/teacher/activities", courseId), {
          id,
          chapter_id: chapter,
          kind,
          ...body,
        });
      setOpen(false);
      setDirty(false);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return {
    courseId,
    editing,
    setEditing,
    open,
    setOpen,
    questionMode,
    setQuestionMode,
    title,
    setTitle,
    id,
    setId,
    chapter,
    setChapter,
    kind,
    setKind,
    pointIds,
    setPointIds,
    goalPractice,
    practiceMode,
    setPracticeMode,
    rules,
    setRules,
    published,
    setPublished,
    practiceKind, required, setRequired,
    selected,
    setSelected,
    error,
    setError,
    busy,
    setBusy,
    dirty,
    setDirty,
    edit,
    save,
  };
}
