import { api, errorMessage, scoped } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { newId } from "@/lib/id";
import type { Question } from "@/lib/types";
import { useState, type FormEvent } from "react";
import { Case } from "./types";
import { editorPayload, questionEditors, type EditorAnswer } from "./editor-registry";
export function useQuestionEditor(classroomId: number, onSaved: () => void) {
  const [editing, setEditing] = useState<Question | null>(null),
    [open, setOpen] = useState(false),
    [id, setId] = useState(""),
    [title, setTitle] = useState(""),
    [prompt, setPrompt] = useState(""),
    [hints, setHints] = useState(""),
    [starterCode, setStarterCode] = useState(""),
    [kind, setKind] = useState<Question["kind"]>("single_choice"),
    [status, setStatus] = useState<Question["status"]>("draft"),
    [options, setOptions] = useState<string[]>(["", ""]),
    [answer, setAnswer] = useState<EditorAnswer>(""),
    [chapterIds, setChapterIds] = useState<number[]>([]),
    [pointIds, setPointIds] = useState<number[]>([]),
    [referenceMaterial, setReferenceMaterial] = useState<number | null>(null),
    [referencePage, setReferencePage] = useState(""),
    [cases, setCases] = useState<Case[]>([]),
    [samples, setSamples] = useState<Case[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  useDraft(dirty);
  function edit(q: Question | null) {
    if (dirty && !window.confirm("放弃当前题目的未保存修改？")) return;
    setEditing(q);
    setId(q?.id ?? newId("question"));
    setTitle(q?.title ?? "");
    setPrompt(q?.prompt ?? "");
    setHints(q?.hints?.join("\n") ?? "");
    setStarterCode(q?.starter_code ?? "");
    setKind(q?.kind ?? "single_choice");
    setStatus(q?.status ?? "draft");
    setOptions(q?.options?.length ? q.options : ["", ""]);
    const value =
      q?.answer &&
      typeof q.answer === "object" &&
      !Array.isArray(q.answer) &&
      "value" in q.answer
        ? (q.answer as { value: unknown }).value
        : q?.answer;
    setAnswer(questionEditors[q?.kind ?? "single_choice"].restore(value));
    setChapterIds(q?.chapter_ids ?? []);
    setPointIds(q?.knowledge_point_ids ?? []);
    setReferenceMaterial(
      typeof q?.source.material_id === "number" ? q.source.material_id : null,
    );
    setReferencePage(
      typeof q?.source.page_no === "number" ? String(q.source.page_no) : "",
    );
    setCases(
      q?.hidden_cases?.map((c) => ({
        input: c.input,
        expected_output: c.expected_output ?? c.output ?? "",
      })) ?? [],
    );
    setSamples(
      q?.samples?.map((c) => ({
        input: c.input,
        expected_output: c.output ?? c.expected_output ?? "",
      })) ?? [],
    );
    setError("");
    setDirty(false);
    setOpen(true);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const source = { ...(editing?.source ?? {}) };
      delete source.material_id;
      delete source.page_no;
      if (referenceMaterial !== null) {
        source.material_id = referenceMaterial;
        if (referencePage) source.page_no = Number(referencePage);
      }
      const body = {
        title,
        kind,
        prompt,
        chapter_ids: chapterIds,
        knowledge_point_ids: pointIds,
        source_type: editing?.source_type ?? "imported",
        status,
        ...editorPayload(kind, { answer, options, hints, starterCode, samples, cases, editing }),
        source,
      };
      if (editing)
        await api.put(
          scoped(`/teacher/questions/${encodeURIComponent(id)}`, classroomId),
          body,
        );
      else
        await api.post(scoped("/teacher/questions", classroomId), {
          id,
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
    editing,
    setEditing,
    open,
    setOpen,
    id,
    setId,
    title,
    setTitle,
    prompt,
    setPrompt,
    hints,
    setHints,
    starterCode,
    setStarterCode,
    kind,
    setKind: (value: Question["kind"]) => { if (value !== kind) { setKind(value); setAnswer(questionEditors[value].restore(null)); } },
    status,
    setStatus,
    options,
    setOptions,
    answer,
    setAnswer,
    chapterIds,
    setChapterIds,
    pointIds,
    setPointIds,
    referenceMaterial,
    setReferenceMaterial,
    referencePage,
    setReferencePage,
    cases,
    setCases,
    samples,
    setSamples,
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
