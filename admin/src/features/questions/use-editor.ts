import { api, errorMessage, scoped } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { newId } from "@/lib/id";
import type { Question } from "@/lib/types";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Case } from "./types";
import { editorPayload, questionEditors, type EditorAnswer } from "./editor-registry";
import { interactiveExamples } from "../../../../shared/interactiveExamples";
import { isInteractiveValue } from "../../../../shared/interactiveValues";
import { validateInteractiveSource } from "./validate-interactive";

const emptyInteractiveSource = { html: "", css: "", js: "" };
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
    [interactive, setInteractive] = useState(emptyInteractiveSource),
    [interactiveAnswer, setInteractiveAnswer] = useState<EditorAnswer>(""),
    [chapterIds, setChapterIds] = useState<number[]>([]),
    [pointIds, setPointIds] = useState<number[]>([]),
    [referenceMaterial, setReferenceMaterial] = useState<number | null>(null),
    [referencePage, setReferencePage] = useState(""),
    [cases, setCases] = useState<Case[]>([]),
    [samples, setSamples] = useState<Case[]>([]),
    [error, setError] = useState(""),
    [savedWarning, setSavedWarning] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  useDraft(dirty);
  const activeSave = useRef<AbortController | null>(null);
  useEffect(() => () => activeSave.current?.abort(), [classroomId]);
  function edit(q: Question | null) {
    if (activeSave.current) return;
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
    setInteractive(q?.kind === "interactive" ? q.interactive ?? emptyInteractiveSource : emptyInteractiveSource);
    setInteractiveAnswer(q?.kind === "interactive" ? questionEditors.interactive.restore(q.answer) : "");
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
    setSavedWarning("");
    setDirty(false);
    setOpen(true);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (activeSave.current) return;
    if (!title.trim() || !prompt.trim()) { setError("请在「题目信息」中填写题目名称和题干。"); return; }
    const saving = new AbortController();
    activeSave.current = saving;
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
      const fields = editorPayload(kind, { answer: kind === "interactive" ? interactiveAnswer : answer,
        options, hints, starterCode, samples, cases, editing, interactive });
      if (kind === "interactive" && status === "ready" && fields.answer === null) {
        throw new Error("设为可用前，请填写非 null 的私有正确提交值。");
      }
      let warning = "";
      if (kind === "interactive") {
        if (!isInteractiveValue(fields.answer)) throw new Error("私有正确提交值须为有效 JSON。");
        try {
          await validateInteractiveSource(interactive, fields.answer, saving.signal);
        } catch (issue) {
          if (saving.signal.aborted || status === "ready") throw issue;
          const state = status === "draft" ? "草稿" : "停用题目";
          warning = `“${title}”已保存为${state}。设为可用前请修复：${errorMessage(issue)}`;
        }
      }
      if (saving.signal.aborted) return;
      const body = {
        title,
        kind,
        prompt,
        chapter_ids: chapterIds,
        knowledge_point_ids: pointIds,
        source_type: editing?.source_type ?? "imported",
        status,
        ...fields,
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
      if (saving.signal.aborted) return;
      setSavedWarning(warning);
      setOpen(false);
      setDirty(false);
      onSaved();
    } catch (e) {
      if (!saving.signal.aborted) setError(errorMessage(e));
    } finally {
      if (activeSave.current === saving) activeSave.current = null;
      if (!saving.signal.aborted) setBusy(false);
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
    setKind: (value: Question["kind"]) => {
      if (value === kind) return;
      setKind(value);
      if (value !== "interactive") setAnswer(questionEditors[value].restore(null));
    },
    status,
    setStatus,
    options,
    setOptions,
    answer: kind === "interactive" ? interactiveAnswer : answer,
    setAnswer: kind === "interactive" ? setInteractiveAnswer : setAnswer,
    interactive,
    setInteractive,
    applyInteractiveExample: (exampleId: string) => {
      const example = interactiveExamples.find(item => item.id === exampleId);
      if (!example || !window.confirm(`使用“${example.title}”替换当前题名、题干、源码和正确提交值？`)) return;
      setTitle(example.title);
      setPrompt(example.prompt);
      setInteractive(example.source);
      setInteractiveAnswer(JSON.stringify(example.target));
      setDirty(true);
    },
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
    savedWarning,
    setError,
    busy,
    setBusy,
    dirty,
    setDirty,
    edit,
    save,
  };
}
