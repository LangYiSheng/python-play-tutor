import { api, errorMessage, scoped } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { newId } from "@/lib/id";
import type { Activity, ActivityResource, Course, PracticeRules } from "@/lib/types";
import { useState, type FormEvent } from "react";
export function useActivityEditor(
  classroomId: number,
  onSaved: () => void,
  course: Course | null,
) {
  const [editing, setEditing] = useState<Activity | null>(null),
    [open, setOpen] = useState(false),
    [questionMode, setQuestionMode] = useState(false),
    [title, setTitle] = useState(""),
    [id, setId] = useState(""),
    [chapter, setChapter] = useState(0),
    [kind, setKind] = useState<Activity["kind"]>("lesson"),
    [resources, setResources] = useState<ActivityResource[]>([]),
    [pointIds, setPointIds] = useState<number[]>([]),
    [rules, setRules] = useState<PracticeRules>({ goals: [] }),
    [practiceMode, setPracticeMode] = useState<"fixed" | "goals">("goals"),
    [published, setPublished] = useState(true),
    [npc, setNpc] = useState(""),
    [assistant, setAssistant] = useState(true),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  useDraft(open && dirty);
  const goalPractice = kind === "practice" && practiceMode === "goals";
  function edit(a: Activity | null, pick = false) {
    setEditing(a);
    setId(a?.id ?? newId("activity"));
    setTitle(a?.title ?? "");
    setChapter(a?.chapter_id ?? course?.chapters[0]?.id ?? 0);
    setKind(a?.kind ?? "lesson");
    setResources(structuredClone(a?.resources ?? []));
    setPointIds(a?.knowledge_point_ids ?? []);
    setRules(structuredClone(a?.practice_rules ?? { goals: [] }));
    setPracticeMode(a?.kind === "practice" && !a.practice_rules ? "fixed" : "goals");
    setPublished(a?.published ?? true);
    setNpc(a?.npc_key ?? "");
    setAssistant(a?.assistant_allowed ?? true);
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
        npc_key: npc || null,
        assistant_allowed: kind === "assessment" ? false : assistant,
        resources,
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
            classroomId,
          ),
          body,
        );
      else
        await api.post(scoped("/teacher/activities", classroomId), {
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
    classroomId,
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
    resources,
    setResources,
    pointIds,
    setPointIds,
    goalPractice,
    practiceMode,
    setPracticeMode,
    rules,
    setRules,
    published,
    setPublished,
    npc,
    setNpc,
    assistant,
    setAssistant,
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
