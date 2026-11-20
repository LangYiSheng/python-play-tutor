import { useState } from "react";
import { Empty, ErrorNotice, Loading, PageHeader, Pager } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ContentActionDialog, type ContentAction } from "@/features/content-workspace/action-dialog";
import { api, errorMessage, scoped } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import type { Question } from "@/lib/types";

type Row = {
  kind: "question" | "narration"; id: string; title: string; source: string;
  material_title?: string; page_no: number; question_kind: string; revision: string;
};
type Queue = { page: number; total: number; items: Row[] };
type Action = (rows: Row[], accept: boolean, text?: string) => Promise<void>;
type PageDraft = {
  raw_text: string; digest: { text: string } | null; narration: { text: string };
  revision: string; material_id: number; source_changed: boolean;
};
const types = { question: "题目", narration: "逐页讲解稿" };
const sourceLabels: Record<string, string> = { ai_generated: "AI 生成", ai: "AI 生成", teacher: "教师编写", imported: "导入" };
const key = (row: Row) => row.kind + "/" + row.id;
const title = (row: Row) => row.kind === "narration" ? `${row.title} · 第 ${row.page_no} 页` : row.title;
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

function DraftDialog({ row, classroomId, close, decide, edit, busy, error }: {
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

export function ContentReviewPage({ classroomId }: { classroomId: number }) {
  return <ReviewQueue key={classroomId} classroomId={classroomId} />;
}

function ReviewQueue({ classroomId }: { classroomId: number }) {
  const [kind, setKind] = useState("all"), [page, setPage] = useState(1), [size, setSize] = useState(10);
  const [selected, setSelected] = useState<string[]>([]), [bulk, setBulk] = useState<Row[] | null>(null);
  const [active, setActive] = useState<Row | null>(null);
  const [editor, setEditor] = useState<ContentAction | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const base = `/teacher/classrooms/${classroomId}/content-review`;
  const queue = useResource<Queue>(`${base}?page=${page}&size=${size}${kind === "all" ? "" : "&kind=" + kind}`);
  const rows = queue.data?.items ?? [];
  const selectable = rows.filter(row => row.question_kind !== "interactive");
  const checked = selectable.filter(row => selected.includes(key(row)));
  function reload() { setSelected([]); setError(""); queue.reload(); }
  const decide: Action = async (items, accept, text) => {
    setBusy(true); setMessage(""); setError("");
    try {
      const result = await api.post<{count: number}>(base + "/decisions", {
        decision: accept ? "accept" : "reject", items: items.map(({kind, id, revision}) => ({kind, id, revision})), text,
      });
      setMessage(`已${accept ? "通过" : "退回"} ${result.count} 项`); setActive(null); setBulk(null); reload();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return <>
    <PageHeader title="待审批" description="审阅本班课程的题目草稿与逐页讲解稿。" />
    <div className="surface">
      <div className="toolbar flex-wrap">
        <SelectField aria-label="待审内容类型" value={kind} onValueChange={v => { setKind(v); setPage(1); setSelected([]); setMessage(""); }}>
          <option value="all">全部内容</option><option value="question">题目</option><option value="narration">逐页讲解稿</option>
        </SelectField>
        <Button variant="outline" onClick={() => { setMessage(""); reload(); }}>刷新</Button>
        {!!checked.length && <Button onClick={() => { setError(""); setBulk(checked); }}>通过所选 {checked.length} 项</Button>}
      </div>
      <ErrorNotice message={queue.error || (!active && !bulk ? error : "")} />
      {message && <p className="px-4 text-sm" role="status">{message}</p>}
      {queue.loading ? <Loading /> : queue.error ? null : rows.length === 0
        ? <Empty title={kind === "all" ? "当前班级没有待审批内容" : "该类型暂无待审批内容"} />
        : <><Table><TableHeader><TableRow><TableHead className="w-10">
          <Checkbox aria-label="选择本页可批量通过的草稿" disabled={!selectable.length} checked={!!checked.length && checked.length === selectable.length}
            indeterminate={!!checked.length && checked.length < selectable.length} onCheckedChange={on => setSelected(on ? selectable.map(key) : [])} />
        </TableHead><TableHead>待审内容</TableHead><TableHead>类型</TableHead><TableHead>来源</TableHead><TableHead className="text-right">操作</TableHead>
        </TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={key(row)}>
          <TableCell><Checkbox aria-label={`选择${title(row)}`} checked={selected.includes(key(row))} disabled={row.question_kind === "interactive"}
            onCheckedChange={on => setSelected(ids => on ? [...ids, key(row)] : ids.filter(id => id !== key(row)))} /></TableCell>
          <TableCell className="max-w-96 whitespace-normal"><p className="font-medium">{title(row)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{row.kind === "question" ? "题目草稿尚未设为可用" : "待核对讲解稿与来源页"}</p></TableCell>
          <TableCell><Badge variant="secondary">{types[row.kind]}</Badge></TableCell>
          <TableCell className="max-w-60 whitespace-normal">{sourceLabel(row)}</TableCell>
          <TableCell className="text-right"><Button variant="outline" size="sm" onClick={() => { setError(""); setActive(row); }}>审阅</Button></TableCell>
        </TableRow>)}</TableBody></Table>
        <Pager page={queue.data?.page ?? page} total={queue.data?.total ?? 0} size={size}
          onPage={v => { setSelected([]); setPage(v); }} onSize={v => { setSelected([]); setSize(v); setPage(1); }} /></>}
    </div>
    {active && <DraftDialog key={key(active)} row={active} classroomId={classroomId} decide={decide} busy={busy} error={error}
      close={() => { setActive(null); setError(""); }} edit={materialId => {
        setEditor(materialId ? { kind: "material", mode: "narration", id: materialId, pageNo: active.page_no } : {kind: "question", mode: "edit", id: active.id});
        setActive(null); setError("");
      }} />}
    {editor && <ContentActionDialog classroomId={classroomId} action={editor} onClose={() => { setEditor(null); reload(); }} />}
    {bulk && <Dialog open onOpenChange={on => { if (!on && !busy) { setBulk(null); setError(""); } }}>
      <DialogContent><DialogHeader><DialogTitle>通过所选 {bulk.length} 项草稿？</DialogTitle>
        <DialogDescription>本次仅处理以下选中的内容。题目将设为可用，讲解稿将变为已接受。</DialogDescription></DialogHeader>
        <ul className="max-h-60 space-y-1 overflow-auto text-sm">{bulk.map(row => <li key={key(row)}>{types[row.kind]} · {title(row)}</li>)}</ul>
        <ErrorNotice message={error} />
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => { setBulk(null); setError(""); }}>取消</Button>
          <Button disabled={busy} onClick={() => void decide(bulk, true)}>确认通过 {bulk.length} 项</Button></DialogFooter>
      </DialogContent></Dialog>}
  </>;
}
