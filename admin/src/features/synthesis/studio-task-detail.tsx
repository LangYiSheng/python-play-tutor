import { useEffect } from "react";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { displayMessage, KIND_LABELS, STATUS_LABELS } from "@/features/content-workspace/studio-job-list";
import type { CourseStudioJob } from "@/lib/course-studio-api";
import { formatTimestamp } from "@/lib/time";
import { useResource } from "@/lib/use-resource";

export interface StudioTaskRow {
  source: "studio";
  job: CourseStudioJob;
  title: string;
  course_name: string;
  requested_by: string;
}

interface JobDetail extends CourseStudioJob {
  output_questions: { id: string; title: string }[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
}

export function StudioTaskDetail({ row, close }: { row: StudioTaskRow; close: () => void }) {
  const { data, error, loading, reload } = useResource<JobDetail>(
    `/teacher/courses/${row.job.course_instance_id}/course-studio/jobs/${encodeURIComponent(row.job.id)}`,
  );
  const job = data ?? row.job;
  const active = job.status === "queued" || job.status === "running";
  useEffect(() => {
    if (!active || loading || error) return;
    const timer = window.setTimeout(reload, 5000);
    return () => window.clearTimeout(timer);
  }, [active, loading, error, data, reload]);

  const result = job.result ?? {};
  const questions = data?.output_questions ?? [];
  const unavailable = Math.max(0, strings(result.question_ids).length - questions.length);
  const knowledge = job.kind === "knowledge_extract";
  const counts = [
    ["created", knowledge ? "新增知识点" : "新增题目"],
    ["updated", "更新知识点"], ["retired", "停用知识点"], ["total_extracted", "抽取知识点"],
    ["skipped", "跳过"], ["failed", "未通过验题"],
  ].filter(([key]) => typeof result[key] === "number");
  const failures = [...new Set([...strings(result.failures), ...strings(result.errors)])];
  const notes = [...new Set([...strings(result.warnings), ...strings(result.notes)])].filter(note => !failures.includes(note));
  const messages = [{ label: "失败明细", items: failures }, { label: "生成说明", items: notes }];
  const message = displayMessage(job);

  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="synthesis-detail">
      <DialogHeader>
        <DialogTitle>任务详情 · {KIND_LABELS[job.kind] ?? job.kind}</DialogTitle>
        <DialogDescription>{[...new Set([row.course_name, row.title].filter(Boolean))].join(" · ")}</DialogDescription>
      </DialogHeader>
      <div className="synthesis-detail-body space-y-4">
        <dl className="synthesis-detail-facts">
          <div><dt>任务状态</dt><dd>{active && job.cancel_requested ? "正在取消" : STATUS_LABELS[job.status] ?? job.status}</dd></div>
          <div><dt>发起人</dt><dd>{row.requested_by}</dd></div>
          <div><dt>提交时间</dt><dd>{formatTimestamp(job.created_at)}</dd></div>
          {job.started_at && <div><dt>开始时间</dt><dd>{formatTimestamp(job.started_at)}</dd></div>}
          {job.finished_at && <div><dt>结束时间</dt><dd>{formatTimestamp(job.finished_at)}</dd></div>}
          {job.progress.total > 0 && <div><dt>执行进度</dt><dd>{job.progress.done} / {job.progress.total}</dd></div>}
        </dl>
        {message && <p>{message}</p>}
        {job.error && <ErrorNotice message={job.error}/>}
        {counts.length > 0 && <dl className="synthesis-detail-facts border-t pt-3">
          {counts.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{String(result[key])}</dd></div>)}
        </dl>}
        {loading && <p role="status" className="hint">正在读取任务详情…</p>}
        {error && <div><ErrorNotice message={error}/><Button variant="outline" size="sm" onClick={reload}>重新读取</Button></div>}
        {questions.length > 0 && <section><h3 className="mb-2 font-medium">生成的题目</h3>
          <ol className="list-decimal space-y-1.5 pl-5">{questions.map(q => <li key={q.id} className="break-words">{q.title}</li>)}</ol>
        </section>}
        {data && unavailable > 0 && <p className="hint">有 {unavailable} 道题目当前无法查看。</p>}
        {typeof result.reason === "string" && <p>{result.reason}</p>}
        {messages.map(({items, label}) => items.length > 0 &&
          <section key={label}><h3 className="mb-1 font-medium">{label}</h3>
            <ul className="list-disc space-y-1 pl-5">{items.map(item => <li key={item} className="break-words">{item}</li>)}</ul>
          </section>)}
      </div>
      <DialogFooter><Button variant="outline" onClick={close}>关闭详情</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
