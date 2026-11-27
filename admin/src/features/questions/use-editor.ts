import { api, errorMessage, scoped } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { newId } from "@/lib/id";
import type { Question } from "@/lib/types";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Case, type CodingType, type CodingUsage } from "./types";
import { editorPayload, questionEditors, type EditorAnswer } from "./editor-registry";
import { readCodingType, readCodingUsage, readReferenceSolution } from "../../../../shared/codingQuestions";
import { interactiveExamples } from "../../../../shared/interactiveExamples";
import { isInteractiveValue } from "../../../../shared/interactiveValues";
import { validateInteractiveSource } from "./validate-interactive";

const emptyInteractiveSource = { html: "", css: "", js: "" };

function deriveTitle(promptText: string): string {
  const first = promptText.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return first.slice(0, 120);
}

export function useQuestionEditor(courseId: number, onSaved: () => void) {
  const [editing, setEditing] = useState<Question | null>(null),
    [open, setOpen] = useState(false),
    [id, setId] = useState(""),
    [title, setTitle] = useState(""),
    [titleTouched, setTitleTouched] = useState(false),
    [prompt, setPrompt] = useState(""),
    [explanation, setExplanation] = useState(""),
    [difficulty, setDifficulty] = useState(""),
    [codingType, setCodingType] = useState<CodingType | "">(""),
    [usage, setUsage] = useState<CodingUsage>("both"),
    [hints, setHints] = useState(""),
    [starterCode, setStarterCode] = useState(""),
    [referenceSolution, setReferenceSolution] = useState(""),
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
  useDraft(open && dirty);
  const activeSave = useRef<AbortController | null>(null);
  useEffect(() => () => activeSave.current?.abort(), [courseId]);

  function edit(q: Question | null) {
    if (activeSave.current) return;
    setEditing(q);
    setId(q?.id ?? newId("question"));
    const nextTitle = q?.title ?? "";
    const nextPrompt = q?.prompt ?? "";
    const synced = !q || !nextTitle.trim() || nextTitle.trim() === deriveTitle(nextPrompt);
    setTitle(nextTitle);
    setTitleTouched(!synced);
    setPrompt(nextPrompt);
    setExplanation(
      typeof q?.source?.explanation === "string" ? q.source.explanation : "",
    );
    setDifficulty(
      typeof q?.source?.difficulty === "string" && ["易", "中", "难"].includes(q.source.difficulty)
        ? q.source.difficulty
        : "",
    );
    setCodingType(q?.kind === "python" ? readCodingType(q.source) : "");
    setUsage(readCodingUsage(q?.source));
    setHints(q?.hints?.join("\n") ?? "");
    setStarterCode(q?.starter_code ?? "");
    setReferenceSolution(q?.kind === "python" ? readReferenceSolution(q.answer) : "");
    setKind(q?.kind ?? "single_choice");
    setStatus(q?.status ?? "draft");
    setOptions(q?.options?.length ? q.options : ["", ""]);
    setInteractive(
      q?.kind === "interactive"
        ? (q.interactive ?? emptyInteractiveSource)
        : emptyInteractiveSource,
    );
    setInteractiveAnswer(
      q?.kind === "interactive"
        ? questionEditors.interactive.restore(q.answer)
        : "",
    );
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
      typeof q?.source?.material_id === "number" ? q.source.material_id : null,
    );
    setReferencePage(
      typeof q?.source?.page_no === "number" ? String(q.source.page_no) : "",
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

  async function commitSave(
    overrideStatus?: Question["status"],
    opts?: { keepOpen?: boolean },
  ): Promise<boolean> {
    if (activeSave.current) return false;
    const targetStatus = overrideStatus ?? status;
    const resolvedTitle = title.trim() || deriveTitle(prompt);
    if (!resolvedTitle || !prompt.trim()) {
      setError("请填写题干内容。");
      return false;
    }
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
      const trimmedExplanation = explanation.trim();
      if (trimmedExplanation) source.explanation = trimmedExplanation;
      else delete source.explanation;
      if (["易", "中", "难"].includes(difficulty)) source.difficulty = difficulty;
      else delete source.difficulty;
      if (kind === "python" && codingType) source.coding_type = codingType;
      else delete source.coding_type;
      if (kind === "python") {
        if (usage !== "both") source.usage = usage;
        else delete source.usage;
      }

      const fields = editorPayload(kind, {
        answer: kind === "interactive" ? interactiveAnswer : answer,
        options,
        hints,
        starterCode,
        referenceSolution,
        codingType,
        samples,
        cases,
        editing,
        interactive,
      });
      if (kind === "interactive" && targetStatus === "ready" && fields.answer === null) {
        throw new Error("设为可用前，请填写非 null 的私有正确提交值。");
      }
      let warning = "";
      if (kind === "interactive") {
        if (!isInteractiveValue(fields.answer)) {
          throw new Error("私有正确提交值须为有效 JSON。");
        }
        try {
          await validateInteractiveSource(interactive, fields.answer, saving.signal);
        } catch (issue) {
          if (saving.signal.aborted || targetStatus === "ready") throw issue;
          const state = targetStatus === "draft" ? "草稿" : "停用题目";
          warning = `“${resolvedTitle}”已保存为${state}。设为可用前请修复：${errorMessage(issue)}`;
        }
      }
      if (saving.signal.aborted) return false;
      const body = {
        title: resolvedTitle,
        kind,
        prompt,
        chapter_ids: chapterIds,
        knowledge_point_ids: pointIds,
        source_type: editing?.source_type ?? "imported",
        status: targetStatus,
        ...fields,
        source,
      };
      if (editing) {
        await api.put(
          scoped(`/teacher/questions/${encodeURIComponent(id)}`, courseId),
          body,
        );
      } else {
        await api.post(scoped("/teacher/questions", courseId), {
          id,
          ...body,
        });
      }
      if (saving.signal.aborted) return false;
      setTitle(resolvedTitle);
      setStatus(targetStatus);
      setSavedWarning(warning);
      setDirty(false);
      if (!opts?.keepOpen) setOpen(false);
      onSaved();
      return true;
    } catch (e) {
      if (!saving.signal.aborted) setError(errorMessage(e));
      return false;
    } finally {
      if (activeSave.current === saving) activeSave.current = null;
      if (!saving.signal.aborted) setBusy(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    await commitSave();
  }

  return {
    editing,
    setEditing,
    open,
    setOpen,
    id,
    setId,
    title,
    setTitle: (value: string) => {
      setTitle(value);
      setTitleTouched(Boolean(value.trim()));
    },
    prompt,
    setPrompt: (value: string) => {
      setPrompt(value);
      if (!titleTouched) setTitle(deriveTitle(value));
    },
    explanation,
    setExplanation,
    difficulty,
    setDifficulty,
    codingType,
    setCodingType,
    usage,
    setUsage,
    hints,
    setHints,
    starterCode,
    setStarterCode,
    referenceSolution,
    setReferenceSolution,
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
      const example = interactiveExamples.find((item) => item.id === exampleId);
      if (
        !example ||
        !window.confirm(`使用“${example.title}”替换当前题名、题干、源码和正确提交值？`)
      ) {
        return;
      }
      setTitle(example.title);
      setTitleTouched(true);
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
    saveWithStatus: commitSave,
  };
}
