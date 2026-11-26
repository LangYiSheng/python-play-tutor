import { CheckCircle2, Loader2, Square, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api";
import type { LectioJob } from "@/lib/lectio-api";

const KIND_LABELS: Record<string, string> = {
  knowledge_extract: "AI 知识点抽取",
  exercises_generate: "AI 智能出题",
  exam_fill_gaps: "AI 试卷补题",
};

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

function summaryForDoneJob(job: LectioJob): string {
  const msg = job.progress.message?.trim() ?? "";
  if (msg && !msg.startsWith("正在") && !msg.startsWith("已加入")) return msg;
  const res = job.result ?? {};
  const created = typeof res.created === "number" ? res.created : null;
  const skipped = typeof res.skipped === "number" ? res.skipped : 0;
  const updated = typeof res.updated === "number" ? res.updated : 0;
  if (job.kind === "exercises_generate" && created !== null) {
    if (created > 0) {
      return `已完成：新增 ${created} 道待审题目${skipped > 0 ? `（跳过重复或无效 ${skipped} 道）` : ""}`;
    }
    return "已完成：未新增题目（均已存在或被跳过）";
  }
  if (job.kind === "exam_fill_gaps" && created !== null) {
    return created > 0 ? `已完成：补充 ${created} 道待审题目` : "已完成：题库已满足需求";
  }
  if (job.kind === "knowledge_extract" && created !== null) {
    const parts: string[] = [];
    if (created > 0) parts.push(`新增 ${created} 个知识点`);
    if (updated > 0) parts.push(`更新 ${updated} 个`);
    return parts.length ? `已完成：${parts.join("，")}` : "已完成：知识点已同步";
  }
  return "任务已完成";
}

function summaryForEndedJob(job: LectioJob): string {
  const verb = job.status === "cancelled" ? "取消" : job.status === "failed" ? "失败" : "中断";
  const res = job.result ?? {};
  const created = typeof res.created === "number" ? res.created : null;
  const skipped = typeof res.skipped === "number" ? res.skipped : 0;
  if (job.kind === "exercises_generate" || job.kind === "exam_fill_gaps") {
    if (created !== null) {
      if (created > 0) {
        return `${verb}前已生成并入库 ${created} 道待审题目${skipped > 0 ? `（跳过重复或无效 ${skipped} 道）` : ""}`;
      }
      return `${verb}前未入库新题目`;
    }
    if (job.progress.total > 1 && job.progress.done > 0) {
      return `${verb}前已执行 ${job.progress.done}/${job.progress.total} 批（历史任务未记录准确入库数，请以题库待审列表为准）`;
    }
    return `${verb}前未写入题目`;
  }
  const msg = job.progress.message?.trim() ?? "";
  if (!msg || msg.startsWith("正在") || msg.startsWith("已加入")) return "";
  return msg;
}

function displayMessage(job: LectioJob): string {
  if (job.status === "done") return summaryForDoneJob(job);
  if (job.status === "failed" || job.status === "interrupted" || job.status === "cancelled") {
    return summaryForEndedJob(job);
  }
  const msg = job.progress.message?.trim() ?? "";
  const created = typeof job.result?.created === "number" ? job.result.created : 0;
  if ((job.kind === "exercises_generate" || job.kind === "exam_fill_gaps") && created > 0 && !msg.includes("已入库")) {
    return msg ? `${msg}（已入库 ${created} 道）` : `已入库 ${created} 道待审题目`;
  }
  return msg;
}

export function LectioJobList({
  jobs,
  onCancel,
  onClose,
}: {
  jobs: LectioJob[];
  onCancel: (jobId: string) => Promise<unknown>;
  onClose?: () => void;
}) {
  if (!jobs.length) return null;

  return (
    <section className="inspector-section" aria-label="AI 创作任务">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="!mb-0">AI 创作任务</h3>
        {onClose && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label="收起任务面板"
            onClick={onClose}
          >
            <X /> 收起
          </Button>
        )}
      </div>
      <ul className="space-y-1.5 text-xs">
        {jobs.slice(0, 10).map((job) => {
          const active = job.status === "queued" || job.status === "running";
          const done = job.status === "done";
          const pct =
            job.progress.total > 0
              ? Math.min(100, Math.round((100 * job.progress.done) / job.progress.total))
              : null;
          const message = displayMessage(job);
          return (
            <li
              key={job.id}
              className="rounded-md border bg-background px-3 py-2 space-y-1.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  {active ? (
                    <Loader2 size={14} className="shrink-0 animate-spin text-primary" />
                  ) : done ? (
                    <CheckCircle2 size={14} className="shrink-0 text-emerald-600" />
                  ) : null}
                  <strong className="whitespace-nowrap text-xs font-medium">{KIND_LABELS[job.kind] ?? job.kind}</strong>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge
                    variant={job.status === "failed" ? "destructive" : active ? "default" : "outline"}
                    className={
                      done
                        ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                        : undefined
                    }
                  >
                    {STATUS_LABELS[job.status] ?? job.status}
                  </Badge>
                  {active && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={job.cancel_requested}
                      onClick={() => {
                        void onCancel(job.id).catch((e) =>
                          toast.add({ title: errorMessage(e), type: "error" }),
                        );
                      }}
                    >
                      <Square /> {job.cancel_requested ? "正在取消…" : "取消"}
                    </Button>
                  )}
                </div>
              </div>
              {message && <p className="break-words text-muted-foreground leading-relaxed">{message}</p>}
              {pct !== null && active && (
                <progress aria-label="AI 任务进度" max={100} value={pct} className="w-full h-1.5" />
              )}
              {job.error && <p className="text-destructive">{job.error}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
