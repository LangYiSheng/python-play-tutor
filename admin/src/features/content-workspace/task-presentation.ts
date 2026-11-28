import type { Job } from "./graph-layout";

export type TaskSnapshot = Job;

const taskNames: Record<string, string> = {
  digest: "原文梳理", calibrate: "整册校准", generate: "讲稿生成", pipeline: "课程生成", audio: "语音合成",
};
const stageNames: Record<string, string> = {
  digest: "梳理原文", calibrate: "校准整理稿", apply: "应用校准修正", script: "生成讲解稿",
  knowledge: "抽取知识点", generate: "生成讲解稿", audio: "合成逐页配音", done: "执行结束",
};
export function stageTitle(key: string) {
  return stageNames[key] ?? key;
}
export function taskTitle(job: Pick<Job, "kind">) {
  return taskNames[job.kind] ?? (job.kind ? `课件处理（${job.kind}）` : "课件处理");
}
export function taskStage(job: TaskSnapshot) {
  if (job.queued && job.status === "running") return "等待执行";
  const key = job.stage || job.kind;
  return stageNames[key] ?? (job.kind === "pipeline" ? "等待阶段记录" : taskTitle(job));
}
export function taskWork(job: TaskSnapshot) {
  if (!(job.total > 0)) return "";
  const count = `${job.done} / ${job.total}`;
  if (job.progress_unit === "groups") return `已处理 ${count} 个文本窗口`;
  if (job.progress_unit === "pages") return `已处理 ${count} 页`;
  if (job.progress_unit === "steps") return `已执行 ${count} 步`;
  if (job.progress_unit === null) return "";
  switch (job.stage || job.kind) {
    case "digest": return `已整理 ${count} 个文本窗口`;
    case "calibrate": return `已校准 ${count} 个文本窗口`;
    case "script":
    case "generate": return "";
    case "audio": return `已处理 ${count} 页配音`;
    case "done": return job.kind === "pipeline" ? "课程生成流程已结束" : "";
    // Applying corrections has no window or page counter.
    default: return "";
  }
}

export function taskPercent(job: TaskSnapshot) {
  if (job.percent === null) return null;
  const value = job.percent ?? (job.total > 0 ? job.done * 100 / job.total : NaN);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
}

export function taskFailed(job: TaskSnapshot) {
  return job.status !== "cancelled" && (job.status === "failed" || job.status === "interrupted" || Boolean(job.failed?.length));
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
