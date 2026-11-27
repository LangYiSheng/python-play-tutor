import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, AlertTriangle, Copy, Eye, Pause, Play, RefreshCw, RotateCcw,
  Search, ShieldAlert, ShieldCheck, SlidersHorizontal,
} from "lucide-react";
import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import { DateRangePicker } from "@/components/date-range-picker";
import { ListEmpty, PageHeader, ErrorNotice, Pager } from "@/components/common";
import { DialogSkeleton, TableSkeleton } from "@/components/skeletons";
import { ManagementTable } from "@/components/management-table";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { SelectField } from "@/components/select-field";
import { api, errorMessage, request, token } from "@/lib/api";
import { formatTimestamp } from "@/lib/time";
import { judgeDateQuery, recentJudgeDates, type JudgeDates } from "@/lib/judge-dates";
import { useResource } from "@/lib/use-resource";

const statuses: Record<string, string> = {
  prepared: "等待评测", dispatching: "正在评测", accepted: "通过", wrong_answer: "解答错误",
  runtime_error: "运行错误", compile_error: "语法错误", time_limit: "运行超时", memory_limit: "内存超限",
  infrastructure_error: "服务异常", submission_unknown: "结果待核查", queued: "历史排队", running: "历史执行中",
};
const pausePresets = ["评测服务异常排查", "服务器例行维护", "临时限流保护"];
const resumePresets = ["服务检测恢复正常", "维护完成恢复派发"];

interface Service {
  paused: boolean;
  health: { status?: string; detail?: string; latency_ms?: number };
  checked_at: string | null;
  worker_seen_at: string | null;
  worker_alive: boolean;
  counts: Record<string, number>;
  global_counts: Record<string, number> | null;
  events: { at: string; message: string }[];
}
interface Submission {
  classroom_name?: string;
  id: string; student_name: string; student_id: string | null; question_title: string; activity_title: string;
  status: string; created_at: string; updated_at: string; passed_count: number | null; total_count: number | null;
}
interface Detail extends Submission {
  code: string;
  feedback: { detail?: string };
  diagnostic: { started_at: string; finished_at: string | null; detail: string } | null;
  cases: { index: number; public: boolean; input: string; expected_output: string;
    result: { status: string; stdout: string; stderr: string; time_ns: number | null; memory_bytes: number | null; output_truncated: boolean; source?: "public_receipt" } | null }[];
}
const timestamp = (value: string | null) => value ? formatTimestamp(value) : "暂无记录";

function useJudgePolling<T>(path: string) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false), [updatedAt, setUpdatedAt] = useState("");
  const lastPath = useRef(path);
  const reload = useCallback(() => setRevision(v => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    const captured = token();
    let active = true, timer: ReturnType<typeof setTimeout>;
    if (lastPath.current !== path) {
      lastPath.current = path;
      setData(null);
    }
    setError("");
    async function poll() {
      setRefreshing(true);
      try {
        const value = await api.get<T>(path, controller.signal);
        if (active && captured === token()) {
          setData(value);
          setError("");
          setUpdatedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
        }
      } catch (e) { if (active) setError(errorMessage(e)); }
      finally {
        if (active) {
          setRefreshing(false);
          timer = setTimeout(() => void poll(), 10_000);
        }
      }
    }
    void poll();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [path, revision]);
  return { data, error, refreshing, updatedAt, reload };
}

function Status({ value }: { value: string }) {
  const tone = value === "accepted"
    ? "judge-pass"
    : ["prepared", "dispatching"].includes(value)
      ? "judge-pending"
      : value === "submission_unknown"
        ? "judge-warn"
        : "judge-fail";
  return <span className={`judge-status ${tone}`}>{statuses[value] ?? value}</span>;
}

type JudgeProps = { classroomId?: number; canManage: boolean };

export function Judge(props: JudgeProps) {
  // A different class unmounts the entire page, including open private evidence.
  return <JudgePage key={props.classroomId ?? "global"} {...props} canManage={props.canManage && props.classroomId === undefined} />;
}

function JudgePage({ classroomId, canManage }: JudgeProps) {
  const [moreFilters, setMoreFilters] = useState(false);
  const [draftDates, setDraftDates] = useState<JudgeDates>(() => recentJudgeDates(7));
  const [dateQuery, setDateQuery] = useState(() => judgeDateQuery(recentJudgeDates(7)));
  const [preset, setPreset] = useState<number | "all" | "custom">(7), [dateError, setDateError] = useState("");
  const [search, setSearch] = useState(""), [query, setQuery] = useState(""), [status, setStatus] = useState("");
  const [page, setPage] = useState(1), [size, setSize] = useState(DEFAULT_PAGE_SIZE), [selected, setSelected] = useState<string | null>(null);
  const [control, setControl] = useState<boolean | null>(null), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const action = useRef<AbortController | null>(null);
  useEffect(() => () => action.current?.abort(), []);
  const scope = classroomId === undefined ? "" : `classroom_id=${classroomId}&`;
  const service = useJudgePolling<Service>(`/teacher/judge/service?${scope}${dateQuery.slice(1)}`);
  const submissions = useJudgePolling<{ items: Submission[]; total: number }>(`/teacher/judge/submissions?${scope}q=${encodeURIComponent(query)}&status=${status}&page=${page}&size=${size}${dateQuery}`);
  const state = service.data;
  const sharedLoadError = service.error === submissions.error ? service.error : "";

  function applyDates(next: JudgeDates | null, choice: typeof preset) {
    try {
      const nextQuery = judgeDateQuery(next);
      if (next) setDraftDates(next);
      setDateQuery(nextQuery); setPreset(choice); setDateError(""); setPage(1); setSelected(null);
    } catch (e) { setDateError(errorMessage(e)); }
  }
  function toggleStatusFilter(nextStatus: string) {
    setStatus(current => current === nextStatus ? "" : nextStatus);
    setPage(1);
  }
  function focusGlobalStatus(nextStatus: string) {
    applyDates(null, "all");
    setStatus(nextStatus);
    setPage(1);
  }
  async function operate(kind: "probe" | "control") {
    const controller = new AbortController(), captured = token();
    action.current = controller;
    setBusy(true); setError("");
    try {
      await request(`/teacher/judge/service${kind === "probe" ? "/probe" : ""}`, {
        method: kind === "probe" ? "POST" : "PUT", signal: controller.signal,
        ...(kind === "control" ? { body: JSON.stringify({ paused: control, reason }) } : {}),
      });
      if (controller.signal.aborted || captured !== token()) return;
      setControl(null); setReason(""); service.reload(); submissions.reload();
      toast.add(kind === "probe" ? { title: "检测已完成", type: "info" } :
        { title: "派发设置已保存", description: "正在执行的提交会继续完成。", type: "success" });
    } catch (e) { if (!controller.signal.aborted) setError(errorMessage(e)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  const healthy = state?.health.status === "healthy";
  const unhealthy = Boolean(state && (!healthy || !state.worker_alive));
  const globalPrepared = state?.global_counts?.prepared ?? 0;
  const globalDispatching = state?.global_counts?.dispatching ?? 0;
  const globalUnknown = state?.global_counts?.submission_unknown ?? 0;
  const globalInfra = state?.global_counts?.infrastructure_error ?? 0;
  const globalAlert = globalUnknown > 0 || globalInfra > 0 || (state?.paused && globalPrepared > 0);
  const latestEvent = state?.events.length ? state.events[state.events.length - 1] : null;
  const metrics = state ? [
    { key: "prepared", label: "等待评测", value: state.counts.prepared ?? 0, tone: (state.counts.prepared ?? 0) > 0 ? "active" : "neutral" },
    { key: "dispatching", label: "正在评测", value: state.counts.dispatching ?? 0, tone: (state.counts.dispatching ?? 0) > 0 ? "active" : "neutral" },
    { key: "submission_unknown", label: "结果待核查", value: state.counts.submission_unknown ?? 0, tone: (state.counts.submission_unknown ?? 0) > 0 ? "warn" : "neutral" },
    { key: "infrastructure_error", label: "服务异常", value: state.counts.infrastructure_error ?? 0, tone: (state.counts.infrastructure_error ?? 0) > 0 ? "danger" : "neutral" },
  ] : [];

  const updatedAt = service.updatedAt || submissions.updatedAt;
  const isRefreshing = (service.refreshing || submissions.refreshing) && Boolean(state || submissions.data);

  return <>
    <PageHeader title="评测管理">
      {updatedAt && <span className="judge-live-meta" aria-live="polite">
        <span className="judge-live-dot" aria-hidden="true" />
        上次更新 {updatedAt}
      </span>}
      <Button variant="outline" onClick={() => { service.reload(); submissions.reload(); }}>
        <RefreshCw className={isRefreshing ? "animate-spin" : ""} />刷新
      </Button>
    </PageHeader>
    <ErrorNotice message={sharedLoadError} />
    <ErrorNotice message={control === null ? error : ""} />
    <section className="surface judge-service" aria-label="评测服务状态">
      <div className="judge-service-head">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            {unhealthy ? <ShieldAlert size={18} className="judge-fail-text" /> : <ShieldCheck size={18} />}评测服务
          </h2>
          {state ? <div className="judge-status-badges">
            <span className="judge-badge" data-tone={healthy ? "ok" : "danger"}>
              <span className="judge-badge-dot" aria-hidden="true" />
              {healthy ? "连接正常" : "需要检查"}
            </span>
            <span className="judge-badge" data-tone={state.paused ? "warn" : "ok"}>
              {state.paused ? "派发已暂停" : "自动派发"}
            </span>
            {!state.worker_alive && <span className="judge-badge" data-tone="danger">队列心跳异常</span>}
          </div> : service.error ? null : <div role="status" aria-busy="true" className="judge-status-badges">
            <span className="sr-only">正在加载…</span>
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>}
        </div>
        {canManage ? <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void operate("probe")}><Activity />立即检测</Button>
          <Button variant={state?.paused ? "default" : "outline"} disabled={busy || !state} onClick={() => { setReason(""); setError(""); setControl(!state?.paused); }}>
            {state?.paused ? <Play /> : <Pause />}{state?.paused ? "恢复派发" : "暂停派发"}
          </Button>
        </div> : null}
      </div>
      {state && unhealthy && <div className="judge-incident" data-tone="danger" role="status">
        <div className="judge-incident-body">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            <p className="judge-incident-title">
              {[
                !healthy ? (state.health.detail ?? "等待首次检测") : "",
                !state.worker_alive ? "队列处理器未收到近期心跳" : "",
              ].filter(Boolean).join(" · ")}
            </p>
            <p className="judge-incident-note">
              {canManage
                ? "新测验提交将留在等待队列，不会误判为答错；可先立即检测或在排查期间暂停全站派发。"
                : "测验提交将留在等待队列，不会误判为答错；请联系管理员排查评测服务（学生浏览器公开样例试运行不受影响）。"}
            </p>
          </div>
        </div>
      </div>}
      {state && state.paused && <div className="judge-incident" data-tone="warn" role="status">
        <div className="judge-incident-body">
          <Pause size={16} aria-hidden="true" />
          <div>
            <p className="judge-incident-title">全站评测派发已暂停</p>
            <p className="judge-incident-note">新测验提交会暂存在等待队列中，恢复后自动继续评测；练习浏览器公开样例试运行不受影响。</p>
          </div>
        </div>
      </div>}
      <ErrorNotice message={sharedLoadError ? "" : service.error} />
      {state ? <div className="judge-metrics" role="group" aria-label="状态筛选统计">
        {metrics.map(({ key, label, value, tone }) => (
          <button type="button" key={key} className="judge-metric" data-tone={tone}
            aria-pressed={status === key} onClick={() => toggleStatusFilter(key)}>
            <span>{label}</span>
            <strong>{value}</strong>
          </button>
        ))}
      </div> : !service.error ? <div className="judge-metrics" aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="judge-metric pointer-events-none space-y-2">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-7 w-12" />
          </div>
        ))}
      </div> : null}
      {canManage && state?.global_counts ? <div className="judge-global-queue" data-alert={globalAlert}>
        <span>
          全站实时队列（全部日期）：等待 <strong>{globalPrepared}</strong> · 评测中 <strong>{globalDispatching}</strong> · 待核查 <strong>{globalUnknown}</strong> · 服务异常 <strong>{globalInfra}</strong>
        </span>
        {(globalUnknown > 0 || globalInfra > 0 || globalPrepared > 0) && <div className="judge-global-actions">
          {globalUnknown > 0 && <Button type="button" size="xs" variant="outline" onClick={() => focusGlobalStatus("submission_unknown")}>查看全站待核查</Button>}
          {globalInfra > 0 && <Button type="button" size="xs" variant="outline" onClick={() => focusGlobalStatus("infrastructure_error")}>查看全站异常</Button>}
          {globalPrepared > 0 && state.paused && <Button type="button" size="xs" variant="outline" onClick={() => focusGlobalStatus("prepared")}>查看积压队列</Button>}
        </div>}
      </div> : null}
      <div className="flex flex-wrap items-start justify-between gap-3 text-xs text-muted-foreground">
        <span>{classroomId === undefined ? "全站" : "本班"} · 所选日期</span>
        {state ? <details><summary className="cursor-pointer">运行详情</summary>
          <p className="mt-2">检测：{timestamp(state.checked_at)}{state.health.latency_ms != null ? ` · ${state.health.latency_ms} ms` : ""} · 心跳{state.worker_alive ? "正常" : "异常"}</p>
          <p className="mt-1">每 10 秒自动刷新</p>
        </details> : null}
      </div>
      {canManage && state ? <details className="mt-3 text-sm"><summary className="cursor-pointer">
        服务事件（{state.events.length}）{latestEvent ? <span className="ml-2 text-xs text-muted-foreground">最新：{timestamp(latestEvent.at)} · {latestEvent.message}</span> : null}
      </summary>
        <p className="mt-2 text-xs text-muted-foreground">按事件发生时间筛选，仅保留最近 50 条服务事件。</p>
        {!state.events.length ? <p className="mt-2 text-sm">所选范围内没有保留的服务事件。</p> : null}
        <ol className="judge-events">{[...state.events].reverse().map((e, i) => <li key={`${e.at}-${i}`}><time>{timestamp(e.at)}</time><span>{e.message}</span></li>)}</ol>
      </details> : null}
    </section>
    <section className="judge-submissions" aria-label={classroomId === undefined ? "全站提交记录" : "本班提交记录"}>
      <h2 className="font-semibold">提交记录</h2>
      <form className="my-3 flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); setPage(1); setQuery(search.trim()); }}>
        <Input className="max-w-sm" aria-label="搜索提交" placeholder="学生姓名、学号、题目或提交编号" value={search} maxLength={100} onChange={e => setSearch(e.target.value)} />
        <Button variant="ghost" type="submit"><Search />搜索</Button>
        <SelectField aria-label="评测状态" value={status || "all"} onValueChange={v => { setStatus(v === "all" ? "" : v); setPage(1); }}>
          <option value="all">全部状态</option>{Object.entries(statuses).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
        </SelectField>
        <Button type="button" variant="outline" aria-expanded={moreFilters} aria-controls={moreFilters ? "judge-date-filters" : undefined} onClick={() => setMoreFilters(open => !open)}><SlidersHorizontal/>更多筛选</Button>
        <span id="judge-columns-0" className="ml-auto" />
      </form>
      <Collapsible open={moreFilters} onOpenChange={setMoreFilters}>
        <CollapsibleContent id="judge-date-filters">
          <section className="judge-date-filter mb-4 rounded-lg border bg-muted/30 px-4" aria-label="评测日期筛选">
            <div className="flex flex-wrap items-center gap-2"><span className="mr-1 text-sm font-medium">提交日期</span>
              {[1, 7, 30].map(days => <Button key={days} size="sm" variant={preset === days ? "default" : "outline"} aria-pressed={preset === days} onClick={() => applyDates(recentJudgeDates(days), days)}>近{days === 1 ? "一天" : days === 7 ? "七天" : "三十天"}</Button>)}
              <Button size="sm" variant={preset === "all" ? "default" : "outline"} aria-pressed={preset === "all"} onClick={() => applyDates(null, "all")}>全部时间</Button>
            </div>
            <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); applyDates(draftDates, "custom"); }}>
              <div className="min-w-0"><DateRangePicker start={preset === "all" ? "" : draftDates.start} end={preset === "all" ? "" : draftDates.end}
                change={(start,end) => { setPreset("custom"); setDraftDates({ start,end }); }} /></div>
              <Button type="submit" size="sm" variant="outline">应用日期</Button>
            </form>
            <ErrorNotice message={dateError} />
          </section>
        </CollapsibleContent>
      </Collapsible>
      <ErrorNotice message={sharedLoadError ? "" : submissions.error} />
      {!submissions.data ? submissions.error ? null : <TableSkeleton /> : submissions.data.items.length ? <>
        <ManagementTable toolsId="judge-columns-0" pageSize={{value:size,total:submissions.data.total,change:v => {setSize(v);setPage(1);}}} aria-label="Python 提交记录"><TableHeader><TableRow>{["学生", "题目 / 活动", "评测结果", "提交时间", "操作"].map(title => <TableHead key={title}>{title}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{submissions.data.items.map(row => <TableRow key={row.id}>
            <TableCell><span className="font-medium">{row.student_name}</span><p className="text-xs text-muted-foreground">{row.student_id ?? "无学号"}{classroomId === undefined && row.classroom_name && ` · ${row.classroom_name}`}</p></TableCell>
            <TableCell className="max-w-xs whitespace-normal"><span>{row.question_title}</span><p className="text-xs text-muted-foreground">{row.activity_title}</p></TableCell>
            <TableCell><Status value={row.status} />{row.total_count != null ? <p className="mt-1 text-xs text-muted-foreground">{row.passed_count} / {row.total_count} 通过</p> : null}</TableCell>
            <TableCell>{timestamp(row.created_at)}</TableCell>
            <TableCell><Button variant="outline" size="sm" onClick={() => setSelected(row.id)} aria-label={`查看 ${row.student_name} 的提交 ${row.id}`}><Eye />查看提交</Button></TableCell>
          </TableRow>)}</TableBody></ManagementTable>
      </> : <div className="surface"><ListEmpty filteredTitle="没有匹配的提交" title="暂无正式提交" description="这里只显示正式提交的 Python 答案。" filtered={Boolean(query || status) || preset !== "all"} reset={() => { setQuery(""); setSearch(""); setStatus(""); applyDates(null,"all"); }} /></div>}
      {submissions.data && submissions.data.total > 0 ? <Pager page={page} size={size} total={submissions.data.total} onPage={setPage} onSize={v => { setSize(v); setPage(1); }} /> : null}
    </section>
    <Dialog open={control !== null} onOpenChange={open => { if (!open && !busy) setControl(null); }}>
      <DialogContent><DialogHeader>
        <DialogTitle>{control ? "暂停全站评测派发" : "恢复全站评测派发"}</DialogTitle>
        <DialogDescription>
          此操作影响所有班级。已在执行的提交继续完成；成绩和待核查结果保持不变。
          {state?.global_counts ? ` 当前全站等待 ${globalPrepared} 条、评测中 ${globalDispatching} 条。` : ""}
        </DialogDescription>
      </DialogHeader>
        <form onSubmit={e => { e.preventDefault(); void operate("control"); }}>
          <ErrorNotice message={error} />
          <Label htmlFor="judge-reason">操作原因</Label>
          <Input id="judge-reason" className="mt-2" value={reason} maxLength={200} required disabled={busy} placeholder="填写或点选下方常用原因" onChange={e => setReason(e.target.value)} />
          <div className="judge-reason-presets" role="group" aria-label="常用操作原因">
            {(control ? pausePresets : resumePresets).map(text => (
              <Button key={text} type="button" size="xs" variant={reason === text ? "secondary" : "outline"} disabled={busy} onClick={() => setReason(text)}>
                {text}
              </Button>
            ))}
          </div>
          <DialogFooter className="mt-4"><Button type="button" variant="outline" disabled={busy} onClick={() => setControl(null)}>取消</Button><Button type="submit" disabled={busy || !reason.trim()}>{busy ? "保存中…" : "确认"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    {selected ? <SubmissionDialog key={selected} classroomId={classroomId} id={selected} onClose={() => setSelected(null)} /> : null}
  </>;
}

function SubmissionDialog({ classroomId, id, onClose }: { classroomId?: number; id: string; onClose: () => void }) {
  const detail = useResource<Detail>(`/teacher/judge/submissions/${encodeURIComponent(id)}${classroomId === undefined ? "" : `?classroom_id=${classroomId}`}`);
  const data = detail.data;
  async function copyId(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.add({ title: "已复制提交编号", description: value, type: "success" });
    } catch {
      toast.add({ title: "复制失败，请手动选中复制", type: "warning" });
    }
  }
  const adviceTone = data?.status === "accepted" ? "ok" : ["submission_unknown", "infrastructure_error", "prepared", "dispatching"].includes(data?.status ?? "") ? "warn" : "normal";
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="judge-detail sm:max-w-4xl">
    <DialogHeader><DialogTitle>提交详情</DialogTitle><DialogDescription>仅本班教师与管理员可见。用例来自提交时快照，题目名称为当前名称；隐藏用例与诊断不可转发给学生。</DialogDescription></DialogHeader>
    <ErrorNotice message={detail.error} />{detail.error ? <Button variant="outline" onClick={detail.reload}><RotateCcw />重试</Button> : null}
    {detail.loading ? <DialogSkeleton rows={4} /> : data ? <div className="judge-detail-body">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{data.question_title}</h3>
          <p className="text-sm">{data.student_name} · {data.student_id ?? "无学号"}{data.classroom_name ? ` · ${data.classroom_name}` : ""} · {timestamp(data.created_at)}</p>
        </div>
        <div className="flex items-center gap-2">
          {data.total_count != null && <span className="text-xs text-muted-foreground">{data.passed_count} / {data.total_count} 通过</span>}
          <Status value={data.status} />
        </div>
      </div>
      <div className="judge-id-row">
        <p className="break-all text-xs text-muted-foreground">提交编号：{data.id}</p>
        <Button type="button" size="xs" variant="ghost" onClick={() => void copyId(data.id)}><Copy />复制编号</Button>
      </div>
      <div className="judge-advice" data-tone={adviceTone}><strong>排查提示</strong><p>{advice(data)}</p>{data.feedback.detail ? <p>{data.feedback.detail}</p> : null}</div>
      <h3 className="my-2 font-semibold">提交代码</h3><pre className="judge-code"><code>{data.code}</code></pre>
      <h3 className="my-3 font-semibold">评测过程</h3>
      {data.diagnostic ? <p className="text-sm text-muted-foreground">开始：{timestamp(data.diagnostic.started_at)} · 结束：{timestamp(data.diagnostic.finished_at)}{data.diagnostic.detail ? ` · ${data.diagnostic.detail}` : ""}</p> : <p className="text-sm text-muted-foreground">当时未记录执行诊断；历史提交不会自动重跑。</p>}
      {!data.cases.length ? <p className="my-4 text-sm">没有保存用例快照。</p> : data.cases.map(c => <details className="judge-case" key={c.index} open={c.result?.status !== "accepted"}>
        <summary>
          <span>{c.public ? "公开" : "隐藏"}用例 {c.index + 1}</span>
          {!c.public && <span className="judge-private-tag">教师私有</span>}
          {c.result ? <Status value={c.result.status} /> : <span className="text-xs text-muted-foreground">没有执行记录</span>}
          {c.result?.source === "public_receipt" ? <span className="text-xs text-muted-foreground">历史公开回执</span> : null}
        </summary>
        <div className="mt-3"><Output title="输入" value={c.input} />
          <div className="judge-output-grid"><Output title="实际输出" value={c.result?.stdout} tone={c.result?.status === "wrong_answer" ? "actual" : ""} /><Output title="预期输出" value={c.expected_output} tone={c.result?.status === "wrong_answer" ? "expected" : ""} /></div>
          {c.result ? <><p className="text-xs text-muted-foreground">CPU 耗时：{c.result.time_ns == null ? "未记录" : `${(c.result.time_ns / 1e6).toFixed(2)} ms`} · 内存：{c.result.memory_bytes == null ? "未记录" : `${(c.result.memory_bytes / 1048576).toFixed(2)} MiB`}</p>
            {c.result.stderr ? <Output title="错误输出" value={c.result.stderr} tone="actual" /> : null}{c.result.output_truncated ? <p>输出过长，仅展示已保存部分。</p> : null}</> : null}
        </div>
      </details>)}
    </div> : null}
  </DialogContent></Dialog>;
}

function Output({ title, value, tone = "" }: { title: string; value?: string; tone?: string }) {
  return <div className="judge-output"><h4>{title}</h4><pre className={tone ? `judge-${tone}` : ""}>{value === undefined ? "未记录" : value === "" ? "（空输出）" : value}</pre></div>;
}

function advice(data: Detail): string {
  if (data.status === "accepted") return "本次正式提交已通过全部用例。";
  if (data.status === "submission_unknown") return "请求可能已经执行，但完整结果未能确认。请保留提交编号，核对服务事件及执行记录；不要直接重跑或凭推测改成绩。";
  if (["infrastructure_error", "prepared", "dispatching"].includes(data.status)) return "当前不是代码正确性的最终结论。请先查看服务连接、队列状态和时间记录。";
  if (data.status === "time_limit") return "可能存在无限循环或算法在较大输入下耗时过长。公开样例较小，不能覆盖正式用例的全部规模。";
  if (data.status === "memory_limit") return "检查是否创建了过大的列表、字符串，或数据随循环持续累积。正式运行有内存限制。";
  if (["runtime_error", "compile_error"].includes(data.status)) return "结合错误输出检查语法、缩进、输入解析和越界；也需考虑 Python 运行环境与第三方包差异。";
  const publicCases = data.cases.filter(c => c.public);
  const publicPassed = publicCases.length > 0 && publicCases.every(c => c.result?.status === "accepted");
  return `${publicPassed ? "本次提交的公开用例通过，隐藏用例未全部通过。" : "请对照本次提交代码及实际输出，浏览器试运行与正式提交可能不是同一份代码。"}公开样例不覆盖全部输入；请检查边界条件、空格换行、中文/英文标点与额外提示文字。这些是排查方向，不是自动归因。`;
}
