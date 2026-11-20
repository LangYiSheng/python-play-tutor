import { useState } from "react";
import { ChevronRight, CircleAlert, RotateCcw, Square } from "lucide-react";
import { Empty, ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";
import { jobStage, jobTitle, taskNodeId } from "./graph-layout";
import { taskFailed, taskPercent, taskStatus, type TaskSnapshot } from "./task-presentation";

type Command = "cancel" | "retry";
type Pending = { command: Command; job: TaskSnapshot; material: string };
type Controls = { request: (target: Pending) => void };

export function useTaskCommands(classroomId: number, refresh: () => void) {
  const [pending, setPending] = useState<Pending | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  function request(target: Pending) {
    setError(""); setNotice(""); setPending(target);
  }
  async function submit() {
    if (!pending?.job.started_at || busy) return;
    setBusy(true); setError("");
    const { job, command, material } = pending;
    try {
      const result = await api.post<{status: string}>(`/teacher/classrooms/${classroomId}/synthesis/${job.material_id}/${command}`,
        { expected_started_at: job.started_at });
      const label = command === "cancel" ? (result.status === "cancelled" ? "任务已取消" : "已请求取消")
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
      <DialogContent><DialogHeader><DialogTitle>{retry ? "重试" : "取消"}{jobTitle(pending.job)}？</DialogTitle>
        <DialogDescription>{pending.material} · {taskStatus(pending.job)}</DialogDescription></DialogHeader>
        <p className="text-sm">{retry ? "将按原配置重新发起任务，可能产生模型或配音费用。" : "排队任务会立即取消。已开始的步骤会先收尾，已保存的结果会保留。"}</p>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setPending(null)}>返回</Button>
          <Button disabled={busy} onClick={() => void submit()}>{retry ? "确认重试" : "确认取消任务"}</Button></DialogFooter>
      </DialogContent></Dialog>}
  </>;
  return { request, feedback };
}

function TaskButtons({ job, material, request }: { job: TaskSnapshot; material: string } & Controls) {
  return <>{job.cancellable && job.started_at &&
    <Button size="sm" variant="outline" onClick={() => request({job, material, command:"cancel"})}><Square/>取消任务</Button>}
    {job.retryable && job.started_at &&
    <Button size="sm" variant="outline" onClick={() => request({job, material, command:"retry"})}><RotateCcw/>重试</Button>}</>;
}

function Progress({ job }: {job: TaskSnapshot}) {
  const percent = taskPercent(job);
  const stage = job.stage || job.running ? jobStage(job) : jobTitle(job);
  return <div className="inspector-task-progress">
    <div><span>{stage}</span>
      <strong>{percent === null ? "进度待更新" : percent + "%"}</strong></div>
    {percent !== null && <progress aria-label="任务进度" max={100} value={percent}/>}
  </div>;
}

export function TaskDetail({job, material, request}: {job: TaskSnapshot; material: string} & Controls) {
  return <section className="inspector-section inspector-task" data-failed={taskFailed(job)}>
    <h3>执行进度 <span className="inspector-status">{taskFailed(job) && <CircleAlert size={13}/>} {taskStatus(job)}</span></h3>
    <Progress job={job}/>
    {job.total > 0 && <p className="inspector-meta">已处理 {job.done} / {job.total}</p>}
    {job.message && <p className="inspector-job-message">{job.message}</p>}
    {Boolean(job.failed?.length) && <details><summary>失败记录（{job.failed!.length}）</summary>
      <ul>{job.failed!.map((item, index) => <li key={index}>{item.page_no ? `第 ${item.page_no} 页 · ` : ""}{item.error || "处理失败"}</li>)}</ul></details>}
    {job.retry_note && !job.retryable && !job.cancellable && <p className="inspector-meta">{job.retry_note}</p>}
    <div className="inspector-task-actions"><TaskButtons job={job} material={material} request={request}/></div>
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
        <span><strong>{jobTitle(job)}</strong><small>{material}</small></span><ChevronRight size={15}/>
      </button>
      <div className="inspector-task-line"><span className="inspector-status">{taskFailed(job) && <CircleAlert size={13}/>} {taskStatus(job)}</span>
        <TaskButtons job={job} material={material} request={request}/></div>
      <Progress job={job}/>
    </li>;
  })}</ul>;
}
