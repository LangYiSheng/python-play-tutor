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
    [convertPractice, setConvertPractice] = useState(false),
    [published, setPublished] = useState(true),
    [npc, setNpc] = useState(""),
    [assistant, setAssistant] = useState(true),
    [selected, setSelected] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  useDraft(dirty);
  const goalPractice = kind === "practice" && (!editing || !!editing.practice_rules || convertPractice);
  function edit(a: Activity | null, pick = false) {
    if (dirty && !window.confirm("放弃当前活动的未保存修改？")) return;
    setEditing(a);
    setId(a?.id ?? newId("activity"));
    setTitle(a?.title ?? "");
    setChapter(a?.chapter_id ?? course?.chapters[0]?.id ?? 0);
    setKind(a?.kind ?? "lesson");
    setResources(structuredClone(a?.resources ?? []));
    setPointIds(a?.knowledge_point_ids ?? []);
    setRules(structuredClone(a?.practice_rules ?? { goals: [] }));
    setConvertPractice(false);
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
    if (goalPractice && !questionMode) {
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
      if (questionMode) {
        await api.put(
          scoped(
            `/teacher/activities/${encodeURIComponent(id)}/questions`,
            classroomId,
          ),
          { question_ids: selected },
        );
      } else {
        const body = {
          title,
          npc_key: npc || null,
          assistant_allowed: kind === "assessment" ? false : assistant,
          resources,
          knowledge_point_ids: goalPractice ? rules.goals.map(goal => goal.knowledge_point_id) : pointIds,
          ...(goalPractice && { practice_rules: rules, published }),
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
      }
      setOpen(false);
      setDirty(false);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function move(i: number, delta: number) {
    const next = [...selected];
    [next[i], next[i + delta]] = [next[i + delta], next[i]];
    setSelected(next);
    setDirty(true);
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
    convertPractice,
    setConvertPractice,
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
    move,
  };
}
