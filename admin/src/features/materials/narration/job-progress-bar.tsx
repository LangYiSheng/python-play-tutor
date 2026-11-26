import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { NarrationJobState } from "./api";

const PIPELINE_STAGES: [string, string][] = [
  ["digest", "整理原文"],
  ["calibrate", "整册校准"],
  ["apply", "应用修正"],
  ["script", "生成讲解稿"],
  ["knowledge", "抽取知识点"],
];

const KIND_LABELS: Record<string, string> = {
  pipeline: "一键梳理",
  digest: "整理原文",
  calibrate: "整册校准",
  generate: "生成讲解稿",
  audio: "全文配音",
};

function unitLabel(unit?: NarrationJobState["progress_unit"]) {
  if (unit === "groups") return "组";
  if (unit === "pages") return "页";
  if (unit === "steps") return "步";
  return "项";
}

function formatElapsed(startedAt: string | null, nowMs: number) {
  if (!startedAt) return "";
  const parsed = Date.parse(startedAt);
  if (Number.isNaN(parsed)) return "";
  const secs = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

export function JobProgressBar({
  job,
  onRetry,
  retrying = false,
}: {
  job: NarrationJobState | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const [dismissedKey, setDismissedKey] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());

  const active = Boolean(job && (job.running || job.queued));

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!job || job.status === "idle") return null;

  const chain = job.chain ?? [];
  const hasStages = job.kind === "pipeline" && (chain.length > 0 || active);
  const failed = job.status === "failed" || job.status === "interrupted" || job.status === "cancelled";
  const finished = job.status === "done";
  const hasVisibleContent = active || failed || (finished && hasStages) || Boolean(job.failed?.length);
  if (!hasVisibleContent) return null;

  const jobKey = `${job.id ?? ""}:${job.started_at ?? ""}:${job.status}`;
  if (!active && dismissedKey === jobKey) return null;

  const currentStage = job.stage || chain[0] || "";
  const stageIndex = PIPELINE_STAGES.findIndex(([key]) => key === currentStage);
  const total = job.total || 0;
  const done = Math.min(job.done || 0, total || job.done || 0);
  const computedPercent =
    typeof job.percent === "number"
      ? Math.max(0, Math.min(100, job.percent))
      : total > 0
        ? Math.max(0, Math.min(100, Math.round((done / total) * 100)))
        : finished
          ? 100
          : 0;

  const unit = unitLabel(job.progress_unit);
  const elapsed = active ? formatElapsed(job.started_at, nowMs) : "";
  const showBar = active || total > 0;
  const barPercent = active && total === 0 ? 18 : computedPercent;

  const firstFailedError = job.failed?.find((item) => item.error?.trim())?.error?.trim() ?? "";
  const messageText =
    firstFailedError && job.message && !job.message.includes(firstFailedError)
      ? `${job.message} · ${firstFailedError}`
      : job.message || firstFailedError;
  const canRetry = Boolean(
    failed &&
      onRetry &&
      (job.retryable === true ||
        (job.retryable === undefined && Boolean(job.started_at)) ||
        (job.kind === "audio" && (job.failed?.length ?? 0) > 0)),
  );
  const failedCount = job.failed?.length ?? 0;

  return (
    <div
      className={`flex shrink-0 flex-col gap-1.5 rounded-md border px-2.5 py-1.5 text-xs ${
        failed
          ? "border-destructive/30 bg-destructive/5"
          : active
            ? "border-primary/30 bg-primary/5"
            : "bg-muted/25"
      }`}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {active ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />
        ) : failed ? (
          <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
        ) : (
          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
        )}

        {hasStages ? (
          <div className="flex flex-wrap items-center gap-1">
            {PIPELINE_STAGES.map(([key, label], index) => {
              const isDone = finished || (stageIndex >= 0 && index < stageIndex);
              const isCurrent = !isDone && key === currentStage;
              const isFailedStage = isCurrent && failed;
              const isRunningStage = isCurrent && active;
              return (
                <Badge
                  key={key}
                  variant={
                    isFailedStage
                      ? "destructive"
                      : isDone
                        ? "default"
                        : isCurrent
                          ? "secondary"
                          : "outline"
                  }
                  className={`h-5 px-1.5 text-[11px] ${isRunningStage ? "animate-pulse" : ""}`}
                >
                  {isDone ? "✓ " : isFailedStage ? "✕ " : isCurrent ? "● " : "○ "}
                  {label}
                </Badge>
              );
            })}
          </div>
        ) : (
          <span className="font-medium">
            {KIND_LABELS[job.kind] ?? "后台任务"}
            {job.queued ? " · 排队中" : active ? " · 进行中" : failed ? " · 未完成" : " · 已完成"}
          </span>
        )}

        {showBar && (
          <div className="flex items-center gap-2">
            <div
              role="progressbar"
              aria-label="任务进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={computedPercent}
              className="h-1.5 w-28 overflow-hidden rounded-full bg-muted sm:w-36"
            >
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  failed
                    ? "bg-destructive/70"
                    : finished
                      ? "bg-emerald-500"
                      : active && total === 0
                        ? "animate-pulse bg-primary/70"
                        : "bg-primary"
                }`}
                style={{ width: `${barPercent}%` }}
              />
            </div>
            <span className="shrink-0 font-medium tabular-nums">
              {job.queued
                ? "排队等待执行…"
                : total > 0
                  ? `${done} / ${total} ${unit}（${computedPercent}%）`
                  : active
                    ? "准备中…"
                    : "已完成"}
            </span>
          </div>
        )}

        {elapsed && (
          <span className="hint shrink-0 tabular-nums">已用 {elapsed}</span>
        )}

        {job.position && (
          <span className="hint shrink-0" role="note">
            {job.position}
          </span>
        )}

        {!job.position && job.failed?.length ? (
          <span className="hint shrink-0" role="note">
            失败页：{job.failed.slice(0, 6).map((item) => `第 ${item.page_no} 页`).join("、")}
            {job.failed.length > 6 ? " 等" : ""}
          </span>
        ) : null}

        {messageText && (
          <span
            className={`min-w-0 flex-1 truncate ${failed ? "text-destructive" : "hint"}`}
            title={messageText}
          >
            {messageText}
          </span>
        )}

        {canRetry && (
          <Button
            size="xs"
            variant="destructive"
            className="h-6 shrink-0 px-2 text-[11px]"
            disabled={retrying}
            onClick={() => onRetry?.()}
          >
            <RotateCcw className={retrying ? "animate-spin" : ""} />
            {retrying ? "正在重试…" : failedCount > 0 ? `一键重试失败页（${failedCount} 页）` : "重试任务"}
          </Button>
        )}

        {!active && (
          <Button
            size="icon-xs"
            variant="ghost"
            className={canRetry ? "shrink-0" : "ml-auto shrink-0"}
            aria-label="隐藏任务提示"
            onClick={() => setDismissedKey(jobKey)}
          >
            <X />
          </Button>
        )}
      </div>
    </div>
  );
}
