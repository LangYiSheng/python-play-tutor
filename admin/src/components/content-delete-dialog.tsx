import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorNotice, Loading } from "@/components/common";
import { errorMessage, request, token } from "@/lib/api";

export type DeletionKind = "chapter" | "material" | "question" | "activity" | "knowledge_point";
type Impact = { kind: string; id?: string; title: string; reason?: string; count?: number };
type Preview = {
  related_question_count?: number;
  id: string; confirmation: string; remove: Impact[]; detach: Impact[]; preserve: Impact[];
  classrooms: {id: number; name: string; students: number; ending_sessions: number}[];
  blockers: { message: string; path?: string }[]; affected_students: number; ending_sessions: number; history_policy: string;
};
const names: Record<string, string> = { chapter: "章节", material: "资料", question: "题目", activity: "活动", knowledge_point: "知识点" };

export function ContentDeleteDialog({ courseId, targets, onClose, onDone }: {
  courseId: number; targets: { kind: DeletionKind; id: string }[]; onClose: () => void; onDone: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [includeQuestions, setIncludeQuestions] = useState(false);
  const [revision, setRevision] = useState(0), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const action = useRef<AbortController | null>(null);
  const encoded = JSON.stringify(targets);
  useEffect(() => { setIncludeQuestions(false); }, [courseId, encoded]);
  useEffect(() => {
    const controller = new AbortController(), captured = token();
    setLoading(true); setError(""); setStale(false);
    void request<Preview>(`/teacher/courses/${courseId}/content-deletions/preview`, {
      method: "POST", signal: controller.signal, body: JSON.stringify({ targets: JSON.parse(encoded), ...(includeQuestions && {include_related_questions: true}) }),
    }).then(value => { if (!controller.signal.aborted && token() === captured) {setPreview(value); setLoading(false);} })
      .catch(e => { if (!controller.signal.aborted) {setError(errorMessage(e)); setLoading(false);} });
    return () => controller.abort();
  }, [courseId, encoded, revision, includeQuestions]);
  useEffect(() => () => action.current?.abort(), []);
  async function confirm() {
    if (!preview || busy || stale || loading || error || preview.blockers.length) return;
    const controller = new AbortController(), captured = token();
    action.current = controller;
    setBusy(true); setError("");
    try {
      await request(`/teacher/courses/${courseId}/content-deletions/${encodeURIComponent(preview.id)}/confirm`, {
        method: "POST", signal: controller.signal,
        body: JSON.stringify({ confirmation: preview.confirmation, confirmed: true }),
      });
      if (!controller.signal.aborted && captured === token()) onDone();
    } catch (e) {
      if (!controller.signal.aborted) { setError(errorMessage(e)); setStale(true); }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-2xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>删除影响范围</DialogTitle>
        <DialogDescription>请核对将删除的内容及关联。学生历史记录会保留。</DialogDescription>
      </DialogHeader>
      <ErrorNotice message={error} />
      {loading ? <Loading /> : null}
      {preview && !loading ? <div className="max-h-[55dvh] space-y-4 overflow-auto pr-2">
          {((preview.related_question_count ?? 0) > 0 || includeQuestions) && <label className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
            <Checkbox checked={includeQuestions} disabled={loading || busy} onCheckedChange={setIncludeQuestions} />
            <span>同时删除仅由本次所选内容关联的 {preview.related_question_count ?? 0} 道题目</span>
          </label>}
          <ImpactList title="一起删除" rows={preview.remove} />
          <ImpactList title="解除关联" rows={preview.detach} />
          <ImpactList title="保留" rows={preview.preserve} />
          <p className="text-sm">{preview.history_policy}</p>
          {preview.classrooms?.map(room => <p className="text-sm" key={room.id}>{room.name} · {room.students} 名学生，{room.ending_sessions} 个进行中互动</p>)}
          {preview.affected_students > 0 ? <p className="text-sm">关联 {preview.affected_students} 名学生（含体验账号）。</p> : null}
          {preview.ending_sessions > 0 ? <p className="text-sm">将结束 {preview.ending_sessions} 个相关进行中互动，互动记录与进度保留。</p> : null}
          {preview.blockers.length > 0 ? <div className="rounded-md border border-destructive/30 p-3"><h3 className="font-semibold">需要先处理</h3>
            {preview.blockers.map((b, i) => <p className="mt-2 text-sm" key={i}>{b.message}{b.path ? <span className="mt-1 block break-all text-xs text-muted-foreground">位置：{b.path}</span> : null}</p>)}
            <p className="mt-2 text-xs text-muted-foreground">关闭弹窗，到对应章节或内容页修正后重新预览。</p>
          </div> : null}
        </div> : null}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        {error || stale ? <Button variant="outline" disabled={busy} onClick={() => setRevision(v => v + 1)}>重新预览</Button> : null}
        <Button variant="destructive" disabled={!preview || !!preview.blockers.length || !!error || busy || stale || loading} onClick={() => void confirm()}>{busy ? "正在删除…" : "确认级联删除"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function ImpactList({ title, rows }: { title: string; rows: Impact[] }) {
  return <section><h3 className="mb-2 text-sm font-semibold">{title}（{rows.length}）</h3>
    {rows.length ? <ul className="divide-y rounded-md border">{rows.map((row, i) => <li className="px-3 py-2 text-sm" key={`${row.kind}:${row.id ?? i}:${i}`}>
      <span className="mr-2 text-xs text-muted-foreground">{names[row.kind] ?? "历史"}</span>{row.title}{row.count ? ` · ${row.count} 条` : ""}
      {row.reason ? <p className="mt-1 text-xs text-muted-foreground">{row.reason}</p> : null}
    </li>)}</ul> : <p className="text-xs text-muted-foreground">无</p>}
  </section>;
}
