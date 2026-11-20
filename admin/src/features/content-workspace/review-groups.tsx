import { useState } from "react";
import { BookOpen, ChevronRight, Files } from "lucide-react";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

export type Kind = "all" | "question" | "narration";
export const kindLabel = { all: "全部内容", question: "题目", narration: "逐页讲解稿" };
export type Group = { id: number; name: string };
type Counts = { count: number; question_count: number; narration_count: number; eligible_count: number };
export type Chapter = Counts & { chapter_id: number; chapter_title: string };
export type Material = Counts & { material_id: number; material_title: string };
type GroupRow = Group & Counts;

export function GroupTable({ rows, level, open, approve }: {
  rows: GroupRow[]; level: "章节" | "资料"; open: (row: Group) => void; approve?: (row: Group) => void;
}) {
  const Icon = level === "章节" ? BookOpen : Files;
  return <Table><TableHeader><TableRow><TableHead>{level}</TableHead>
    <TableHead className="w-24 text-right">待审题目</TableHead><TableHead className="w-28 text-right">待审讲解稿</TableHead>
    {approve && <TableHead className="w-28 text-right">操作</TableHead>}
  </TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.id}>
    <TableCell className="whitespace-normal"><button type="button"
      className="flex w-full items-center gap-3 rounded-sm py-1 text-left hover:underline focus-visible:outline-ring"
      aria-label={`查看${row.name}的${level === "章节" ? "待审资料" : "待审明细"}`} onClick={() => open(row)}>
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" /><span className="break-words font-medium">{row.name}</span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button></TableCell>
    <TableCell className="text-right tabular-nums">{row.question_count} 题</TableCell>
    <TableCell className="text-right tabular-nums">{row.narration_count} 页</TableCell>
    {approve && <TableCell className="text-right"><Button size="sm" variant="outline" disabled={!row.eligible_count}
      aria-label={`批量通过${row.name}的草稿`} onClick={() => approve(row)}>按章通过</Button></TableCell>}
  </TableRow>)}</TableBody></Table>;
}

type Preview = {
  chapter_title: string; count: number; question_count: number; narration_count: number; excluded_count: number; token: string;
};
export function ChapterApproval({ base, chapter, kind, close, applied }: {
  base: string; chapter: Group; kind: Kind; close: () => void; applied: (count: number) => void;
}) {
  const route = `${base}/groups/${chapter.id}`;
  const preview = useResource<Preview>(route + "/preview" + (kind === "all" ? "" : "?kind=" + kind));
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [stale, setStale] = useState(false);
  const scope = preview.data;
  async function confirm() {
    if (busy || !scope?.count || stale) return;
    setBusy(true); setError("");
    try {
      const result = await api.post<{count: number}>(route + "/accept", {
        kind: kind === "all" ? null : kind, expected_count: scope.count, token: scope.token,
      });
      applied(result.count);
    } catch (e) {
      setStale(e instanceof ApiError && e.status === 409);
      setError(errorMessage(e));
    } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent>
    <DialogHeader><DialogTitle>按章批量通过</DialogTitle>
      <DialogDescription>范围包含本章所有资料和所有分页中符合筛选条件的待审草稿。</DialogDescription></DialogHeader>
    <p className="font-medium">{scope?.chapter_title ?? chapter.name}</p>
    <p className="text-sm text-muted-foreground">内容类型 · {kindLabel[kind]}</p>
    {preview.loading && <Loading />}
    {scope && <div className="space-y-2 rounded-md border bg-muted/25 p-3 text-sm">
      <p className="font-medium">本次通过 {scope.count} 项</p>
      <p>题目 {scope.question_count} 道 · 讲解稿 {scope.narration_count} 页</p>
      {scope.excluded_count > 0 && <p className="text-muted-foreground">另有 {scope.excluded_count} 项需单独审阅，仍保留在待审批中。</p>}
    </div>}
    <ErrorNotice message={error || preview.error} />
    <DialogFooter><Button variant="outline" disabled={busy} onClick={close}>取消</Button>
      {(stale || preview.error) ? <Button onClick={() => { setStale(false); setError(""); preview.reload(); }}>重新核对范围</Button>
      : <Button disabled={!scope?.count || busy || preview.loading} onClick={() => void confirm()}>确认通过 {scope?.count ?? 0} 项</Button>}
    </DialogFooter></DialogContent></Dialog>;
}
