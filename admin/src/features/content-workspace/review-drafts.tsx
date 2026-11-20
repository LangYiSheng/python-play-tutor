import { useState } from "react";
import { ErrorNotice, Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { scoped } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import type { Question } from "@/lib/types";

export type Row = {
  kind: "question" | "narration"; id: string; title: string; source: string;
  material_title?: string; page_no: number; question_kind: string; revision: string;
};

export type Action = (rows: Row[], accept: boolean, text?: string) => Promise<void>;
type PageDraft = {
  raw_text: string; digest: { text: string } | null; narration: { text: string };
  revision: string; material_id: number; source_changed: boolean;
};
export const types = { question: "题目", narration: "逐页讲解稿" };
const sourceLabels: Record<string, string> = { ai_generated: "AI 生成", ai: "AI 生成", teacher: "教师编写", imported: "导入" };
export const key = (row: Row) => row.kind + "/" + row.id;
export const title = (row: Row) => row.kind === "narration" ? `${row.title} · 第 ${row.page_no} 页` : row.title;
function sourceLabel(row: Row) {
  if (row.kind === "question" && row.material_title)
    return row.material_title + (row.page_no ? ` · 第 ${row.page_no} 页` : "");
  return sourceLabels[row.source] ?? row.source;
}

function answerLabel(raw: unknown): string {
  const answer = raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
  if (answer === null || answer === undefined || answer === "") return "尚未填写";
  if (typeof answer === "boolean") return answer ? "正确" : "错误";
  if (Array.isArray(answer)) return answer.map(item => typeof item === "object" ? JSON.stringify(item) : String(item)).join("、");
  return typeof answer === "object" ? JSON.stringify(answer) : String(answer);
}

export function DraftDialog({ row, classroomId, close, decide, edit, busy, error }: {
  row: Row; classroomId: number; close: () => void; decide: Action;
  edit: (materialId?: number) => void; busy: boolean; error: string;
}) {
  const question = useResource<Question>(row.kind === "question" ? scoped("/teacher/questions/" + encodeURIComponent(row.id), classroomId) : null);
  const page = useResource<PageDraft>(row.kind === "narration" ? `/teacher/classrooms/${classroomId}/content-review/narrations/${row.id}` : null);
  const [text, setText] = useState<string | null>(null);
  const detail = page.data;
  const q = question.data;
  const canDecide = !!(detail || q) && !detail?.source_changed;
  const current = detail ? { ...row, revision: detail.revision } : row;
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
    <DialogContent className="editor-dialog"><DialogHeader>
      <DialogTitle>{title(row)}</DialogTitle>
      <DialogDescription>{types[row.kind]} · {sourceLabel(row)} · {q ? "草稿尚未设为可用" : "等待教师确认"}</DialogDescription>
    </DialogHeader>
    <div className="dialog-scroll space-y-4">
      <ErrorNotice message={error || page.error || question.error} />
      {(page.loading || question.loading) && <Loading />}
      {detail && <>
        <section><h3 className="mb-2 font-medium">{detail.digest?.text ? "本页整理稿" : "本页原文"}</h3>
          <p className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{detail.digest?.text || detail.raw_text || "本页没有可用文本"}</p></section>
        <label className="field">讲解稿<Textarea value={text ?? detail.narration.text} maxLength={4000} rows={7}
          disabled={busy || detail.source_changed} onChange={e => setText(e.target.value)} /></label>
        {detail.source_changed && <p role="status">来源页已变化，请打开课件审校并核对最新内容。</p>}
      </>}
      {q && <>
        <section><h3 className="mb-1 font-medium">题干</h3><p className="whitespace-pre-wrap">{q.prompt}</p></section>
        {!!q.options?.length && <ul className="list-disc space-y-1 pl-5">{q.options.map((opt, i) => <li key={i}>{opt}</li>)}</ul>}
        {q.kind === "python"
          ? <p className="text-sm">公开样例 {q.samples.length} 个 · 私有用例 {q.hidden_cases.length} 个</p>
          : <p className="break-words text-sm">正确答案&emsp;{answerLabel(q.answer)}</p>}
        <p className="text-sm text-muted-foreground">编辑时可核对完整答案与判定要求，将状态设为「可用」并保存即可通过。</p>
      </>}
    </div>
    <DialogFooter>
      {row.kind === "question" ? <Button variant="outline" disabled={busy || !q} onClick={() => edit()}>编辑题目</Button>
        : detail?.source_changed && <Button variant="outline" onClick={() => edit(detail.material_id)}>打开课件审校</Button>}
      <Button variant="outline" disabled={busy || !canDecide} onClick={() => void decide([current], false)}>{q ? "退回并停用" : "退回"}</Button>
      {row.question_kind !== "interactive" && <Button disabled={busy || !canDecide || (text !== null && !text.trim())}
        onClick={() => void decide([current], true, text !== null && text !== detail?.narration.text ? text : undefined)}>
        {text !== null && text !== detail?.narration.text ? "修改并通过" : "通过"}</Button>}
    </DialogFooter></DialogContent>
  </Dialog>;
}

export function DraftTable({ rows, selected, toggle, review }: {
  rows: Row[]; selected: Row[]; toggle: (rows: Row[], checked: boolean) => void; review: (row: Row) => void;
}) {
  const ids = new Set(selected.map(key));
  const eligible = rows.filter(row => row.question_kind !== "interactive");
  const checked = eligible.filter(row => ids.has(key(row))).length;
  return <Table><TableHeader><TableRow><TableHead className="w-10">
    <Checkbox aria-label="选择本页可批量通过的草稿" disabled={!eligible.length}
      checked={checked > 0 && checked === eligible.length} indeterminate={checked > 0 && checked < eligible.length}
      onCheckedChange={on => toggle(eligible, on)} />
  </TableHead><TableHead>待审内容</TableHead><TableHead>类型</TableHead><TableHead>来源</TableHead><TableHead className="text-right">操作</TableHead>
  </TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={key(row)}>
    <TableCell><Checkbox aria-label={`选择${title(row)}`} checked={ids.has(key(row))} disabled={row.question_kind === "interactive"}
      onCheckedChange={on => toggle([row], on)} /></TableCell>
    <TableCell className="max-w-96 whitespace-normal"><p className="font-medium">{title(row)}</p>
      {row.question_kind === "interactive" && <p className="mt-1 text-xs text-muted-foreground">需在题目编辑器中试答后通过</p>}
    </TableCell><TableCell><Badge variant="secondary">{types[row.kind]}</Badge></TableCell>
    <TableCell className="max-w-60 whitespace-normal">{sourceLabel(row)}</TableCell>
    <TableCell className="text-right"><Button variant="outline" size="sm" onClick={() => review(row)}>审阅</Button></TableCell>
  </TableRow>)}</TableBody></Table>;
}
