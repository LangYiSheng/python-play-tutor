import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorNotice, Loading } from "@/components/common";
import { errorMessage, request, token } from "@/lib/api";

export type DeletionKind = "chapter" | "material" | "question" | "activity" | "knowledge_point";
type Impact = { kind: string; id?: string; title: string; reason?: string; count?: number };
type Preview = {
  id: string; confirmation: string; remove: Impact[]; detach: Impact[]; preserve: Impact[];
  blockers: { message: string; path?: string }[]; affected_students: number; ending_sessions: number; history_policy: string;
  related_question_count?: number;
};
const names: Record<string, string> = { chapter: "章节", material: "资料", question: "题目", activity: "活动", knowledge_point: "知识点", quest: "任务", story: "教学流程" };

export function ContentDeleteDialog({ classroomId, targets, onClose, onDone }: {
  classroomId: number; targets: { kind: DeletionKind; id: string }[]; onClose: () => void; onDone: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [revision, setRevision] = useState(0), [error, setError] = useState("");
  const [includeQuestions, setIncludeQuestions] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false), [stale, setStale] = useState(false);
  const action = useRef<AbortController | null>(null);
  const encoded = JSON.stringify(targets);
  useEffect(() => {
    setPreview(null);
    setIncludeQuestions(false);
  }, [classroomId, encoded]);
  useEffect(() => {
    const controller = new AbortController(), captured = token();
    setLoadingPreview(true); setError(""); setAcknowledged(false); setStale(false);
    const payload: Record<string, unknown> = { classroom_id: classroomId, targets: JSON.parse(encoded) };
    if (includeQuestions) payload.include_related_questions = true;
    void request<Preview>("/teacher/content-deletions/preview", {
      method: "POST", signal: controller.signal, body: JSON.stringify(payload),
    }).then(value => {
      if (!controller.signal.aborted && token() === captured) {
        setPreview(value);
        setLoadingPreview(false);
      }
    }).catch(e => {
      if (!controller.signal.aborted) {
        setError(errorMessage(e));
        setLoadingPreview(false);
      }
    });
    return () => controller.abort();
  }, [classroomId, encoded, revision, includeQuestions]);
  useEffect(() => () => action.current?.abort(), []);
  const needsAck = Boolean(preview && (preview.affected_students > 0 || preview.ending_sessions > 0));
  const relatedCount = preview?.related_question_count ?? 0;
  const primaryKind = targets[0]?.kind;
  const relatedLabel =
    primaryKind === "knowledge_point"
      ? `同时删除仅关联此知识点的 ${relatedCount} 道题目`
      : primaryKind === "material"
        ? `同时删除来源于此课件的 ${relatedCount} 道题目`
        : primaryKind === "chapter"
          ? `同时删除仅属于此章节的 ${relatedCount} 道题目`
          : `同时删除关联的 ${relatedCount} 道题目`;
  async function confirm() {
    if (!preview || busy || loadingPreview || stale || preview.blockers.length > 0) return;
    if (needsAck && !acknowledged) return;
    const controller = new AbortController(), captured = token();
    action.current = controller;
    setBusy(true); setError("");
    try {
      await request(`/teacher/content-deletions/${encodeURIComponent(preview.id)}/confirm`, {
        method: "POST", signal: controller.signal,
        body: JSON.stringify({ classroom_id: classroomId, confirmation: preview.confirmation, confirmed: true }),
      });
      if (!controller.signal.aborted && captured === token()) onDone();
    } catch (e) {
      if (!controller.signal.aborted) { setError(errorMessage(e)); setStale(true); }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  const confirmLabel = busy
    ? "正在删除…"
    : preview && preview.remove.length > 1
      ? `确认删除（共 ${preview.remove.length} 项）`
      : "确认删除";
  const confirmDisabled = busy || loadingPreview || !preview || preview.blockers.length > 0 || Boolean(error) || stale || (needsAck && !acknowledged);
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-2xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>删除影响范围</DialogTitle>
        <DialogDescription>请核对一起删除和解除关联的项目；执行后内容会退出当前教学，学生历史记录仍保留。</DialogDescription>
      </DialogHeader>
      <ErrorNotice message={error} />
      {!preview && !error ? <Loading /> : null}
      {preview ? <div className="max-h-[55dvh] space-y-4 overflow-auto pr-2">
        {(relatedCount > 0 || includeQuestions) ? (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-amber-300/80 bg-amber-50/50 px-3 py-2.5 text-xs">
            <Checkbox
              checked={includeQuestions}
              disabled={busy || loadingPreview}
              onCheckedChange={(checked) => setIncludeQuestions(Boolean(checked))}
            />
            <span className="space-y-0.5 leading-relaxed">
              <strong className="font-medium text-foreground">{relatedLabel}</strong>
              <span className="block text-muted-foreground">
                默认仅解除关联、保留题库；勾选后将把这批题目一并纳入「一起删除」范围。
              </span>
            </span>
          </label>
        ) : null}
        <ImpactList title="一起删除" rows={preview.remove} />
        <ImpactList title="解除关联" rows={preview.detach} />
        <ImpactList title="保留" rows={preview.preserve} />
        <p className="text-sm">{preview.history_policy}</p>
        {preview.affected_students > 0 ? <p className="text-sm font-medium text-amber-800">关联 {preview.affected_students} 名学生（含体验账号）。</p> : null}
        {preview.ending_sessions > 0 ? <p className="text-sm font-medium text-amber-800">将结束 {preview.ending_sessions} 个相关进行中互动，互动记录与进度保留。</p> : null}
        {needsAck && preview.blockers.length === 0 ? (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm">
            <Checkbox checked={acknowledged} disabled={busy || loadingPreview || stale} onCheckedChange={(checked) => setAcknowledged(Boolean(checked))} />
            <span>我已核对删除范围，确认保留学生历史记录</span>
          </label>
        ) : null}
        {preview.blockers.length > 0 ? <div className="rounded-md border border-destructive/30 p-3"><h3 className="font-semibold">需要先处理</h3>
          {preview.blockers.map((b, i) => <p className="mt-2 text-sm" key={i}>{b.message}{b.path ? <span className="mt-1 block break-all text-xs text-muted-foreground">位置：{b.path}</span> : null}</p>)}
          <p className="mt-2 text-xs text-muted-foreground">关闭弹窗，到教学流程或对应内容页修正后重新预览。</p>
        </div> : null}
      </div> : null}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        {error || stale ? <Button variant="outline" disabled={busy || loadingPreview} onClick={() => setRevision(v => v + 1)}>重新预览</Button> : null}
        <Button variant="destructive" disabled={confirmDisabled} onClick={() => void confirm()}>
          {confirmLabel}
        </Button>
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
