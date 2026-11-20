import type { Job } from "./graph-layout";

export type TaskSnapshot = Job;

export function taskPercent(job: TaskSnapshot) {
  if (job.percent === null) return null;
  const value = job.percent ?? (job.total > 0 ? job.done * 100 / job.total : NaN);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
}

export function taskFailed(job: TaskSnapshot) {
  return job.status === "failed" || job.status === "interrupted" || Boolean(job.failed?.length);
}

export function taskStatus(job: TaskSnapshot) {
  switch (job.status) {
    case "cancelled": return "已取消";
    case "cancelling": return "正在取消";
    case "interrupted": return "已中断";
    case "failed": return "执行失败";
    case "done": return job.failed?.length ? "部分失败" : "已完成";
    default: return job.queued ? "排队中" : "执行中";
  }
}
