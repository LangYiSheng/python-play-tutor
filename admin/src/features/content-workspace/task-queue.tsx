import { useState, type ReactNode } from "react";
import { ChevronRight, CircleAlert, RotateCcw, Square } from "lucide-react";
import { Empty, ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";
import { taskNodeId } from "./graph-layout";
import { stageTitle, taskFailed, taskPercent, taskStage, taskStatus, taskTitle, taskWork, type TaskSnapshot } from "./task-presentation";

type Command = "cancel" | "retry";
type Pending = { command: Command; job: TaskSnapshot; material: string };
type Controls = { request: (target: Pending) => void };

export function useTaskCommands(classroomId: number | undefined, refresh: () => void) {
  const [pending, setPending] = useState<Pending | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  function request(target: Pending) {
    setError(""); setNotice(""); setPending(target);
  }
  async function submit() {
    if (!pending?.job.started_at || busy || classroomId === undefined) return;
    setBusy(true); setError("");
    const { job, command, material } = pending;
    try {
      const result = await api.post<{status: string; queue_dismissed?: boolean}>(`/teacher/classrooms/${classroomId}/synthesis/${job.material_id}/${command}`,
        { expected_started_at: job.started_at });
      const label = command === "cancel" ? (result.queue_dismissed ? "失败任务已从队列移除" : result.status === "cancelled" ? "任务已取消" : "已请求取消")
        : result.status === "failed" ? "重试仍有失败" : result.status === "done" ? "重试已完成" : "已提交重试";
      setNotice(`${material} · ${label}`); setPending(null);
    } catch (cause) {
      setError(errorMessage(cause));
      // A stale run cannot be resubmitted through this confirmation.
      setPending(null);
    } finally { setBusy(false); refresh(); }
  }
  const retry = pending?.command === "retry";
  const feedback = <><ErrorNotice message={error}/>{notice && <p role="status" className="inspector-feedback">{notice}</p>}
    {pending && <Dialog open onOpenChange={open => {if (!open && !busy) setPending(null);}}>
      <DialogContent><DialogHeader><DialogTitle>{retry ? "重试" : "取消"}{taskTitle(pending.job)}？</DialogTitle>
        <DialogDescription>{pending.material} · {taskStatus(pending.job)}</DialogDescription></DialogHeader>
        <p className="text-sm">{retry ? "将按原配置重新发起任务，可能产生模型或配音费用。"
          : pending.job.status === "failed" ? "将从图谱任务队列移除这条失败记录。已保存的内容和历史失败记录将保留。"
          : "排队任务会立即取消。已开始的步骤会先收尾，已保存的结果会保留。"}</p>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setPending(null)}>返回</Button>
          <Button disabled={busy} onClick={() => void submit()}>{retry ? "确认重试" : "确认取消任务"}</Button></DialogFooter>
      </DialogContent></Dialog>}
  </>;
  return { request, feedback };
}

function StageList({ job }: {job: TaskSnapshot}) {
  if (!job.stages?.length) return null;
  const cursor = job.stages.indexOf(job.stage);
  const stopped = ["interrupted", "failed", "cancelled"].includes(job.status ?? "");
  function state(index: number) {
    if (job.status === "done" || (cursor >= 0 && index < cursor)) return "已完成";
    if (cursor === index && !job.queued) return taskStatus(job);
    if (job.queued) return "等待执行";
    if (cursor < 0 && stopped) return "未记录";
    return stopped ? "未执行" : "等待执行";
  }
  return <ol aria-label="本次任务阶段" className="inspector-stages">
    {job.stages.map((stage, index) => <li key={stage} aria-current={index === cursor ? "step" : undefined}>
      <span>{index + 1}. {stageTitle(stage)}</span><small>{state(index)}</small>
    </li>)}
  </ol>;
}

export function TaskButtons({ job, material, request, variant = "outline" }: {
  job: TaskSnapshot; material: string; variant?: "outline" | "ghost"
} & Controls) {
  return <>{job.cancellable && job.started_at &&
    <Button size="sm" variant={variant} onClick={() => request({job, material, command:"cancel"})}><Square/>取消任务</Button>}
    {job.retryable && job.started_at &&
    <Button size="sm" variant={variant} onClick={() => request({job, material, command:"retry"})}><RotateCcw/>重试</Button>}</>;
}

function Progress({ job }: {job: TaskSnapshot}) {
  const percent = taskPercent(job);
  const work = taskWork(job);
  const active = job.queued || job.status === "running" || job.status === "cancelling";
  return <div className="inspector-task-progress">
    <div><span>{job.kind === "pipeline" && job.stage_index && job.stage_total
      ? `阶段 ${job.stage_index}/${job.stage_total} · ` : ""}{taskStage(job)}</span>
      <strong>{percent === null ? (active ? "进度待更新" : "未记录百分比") : percent + "%"}</strong></div>
    {percent !== null && <progress aria-label="任务进度" max={100} value={percent}/>}
    {work && <small className="inspector-work">{work}</small>}
  </div>;
}

export function TaskDetail({job, material, request, actions}: {
  job: TaskSnapshot; material: string; request?: Controls["request"]; actions?: ReactNode;
}) {
  const stopped = job.status === "failed" || job.status === "interrupted" || job.status === "cancelled";
  return <section className="inspector-section inspector-task" data-failed={taskFailed(job)}>
    <h3>执行进度 <span className="inspector-status">{taskFailed(job) && <CircleAlert size={13}/>} {taskStatus(job)}</span></h3>
    <Progress job={job}/>
    <StageList job={job}/>
    {(job.position || stopped) && <p className="inspector-meta">{stopped ? "停止位置" : "执行位置"} · {job.position || (job.stage || job.kind !== "pipeline" ? taskStage(job) : "尚未记录具体阶段")}</p>}
    {(job.diagnostic || job.message) && <p className="inspector-job-message">{job.diagnostic || job.message}</p>}
    {Boolean(job.failed?.length) && <details open><summary>失败记录（{job.failed!.length}）</summary>
      <ul>{job.failed!.map((item, index) => <li key={index}>{item.page_no ? `第 ${item.page_no} 页 · ` : ""}{item.error || "处理失败"}</li>)}</ul></details>}
    {job.retry_note && !job.retryable && !job.cancellable && <p className="inspector-meta">{job.retry_note}</p>}
    <div className="inspector-task-actions">{actions}{request && <TaskButtons job={job} material={material} request={request}/>}</div>
  </section>;
}

export function TaskQueue({jobs, titleOf, onSelect, request}: {
  jobs: TaskSnapshot[]; titleOf: (id: number) => string; onSelect: (job: TaskSnapshot) => void;
} & Controls) {
  if (!jobs.length) return <Empty title="当前没有进行中的生成任务"/>;
  return <ul className="inspector-task-list">{jobs.map(job => {
    const material = titleOf(job.material_id);
    return <li key={taskNodeId(job)} className="inspector-task" data-failed={taskFailed(job)}>
      <button className="inspector-task-focus" onClick={() => onSelect(job)}>
        <span><strong>{taskTitle(job)}</strong><small>{material}</small></span><ChevronRight size={15}/>
      </button>
      <div className="inspector-task-line"><span className="inspector-status">{taskFailed(job) && <CircleAlert size={13}/>} {taskStatus(job)}</span>
        <TaskButtons job={job} material={material} request={request}/></div>
      <Progress job={job}/>
    </li>;
  })}</ul>;
}
