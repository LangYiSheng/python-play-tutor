import { useEffect, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowUpRight, CheckCircle2, Clock, Eye,
  Headphones, History, NotebookPen, RefreshCw, Settings, XCircle,
} from 'lucide-react';
import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import { PageHeader, ErrorNotice, Loading, Pager, ListEmpty } from '@/components/common';
import { ManagementTable } from "@/components/management-table";
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/select-field';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { NarrationReview } from '@/features/materials/narration/review';
import { NarrationPlayer } from '@/features/materials/narration/player';
import { api, errorMessage } from '@/lib/api';
import { formatTimestamp } from '@/lib/time';
import { TaskButtons, TaskDetail, useTaskCommands } from '@/features/content-workspace/task-queue';
import { taskFailed, taskPercent, taskStage, taskStatus, taskTitle, taskWork, type TaskSnapshot } from '@/features/content-workspace/task-presentation';
import '@/features/content-workspace/inspector-content.css';
import '@/features/synthesis/synthesis.css';

type Task = TaskSnapshot & {
  course_id?: number;
  course_name?: string;
  id: number; material_id: number; title: string; material_kind: string; kind: string; status: string;
  requested_by: string; scope: string; material_available: boolean;
  done: number; total: number; message: string; started_at: string | null; finished_at: string | null;
  failed: { page_no: number; error?: string }[]; retryable: boolean; retry_note: string;
};
type Overview = { items: Task[]; total: number; counts: Record<string, number> };
const statuses: Record<string, string> = { running: '处理中', done: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', cancelling: '正在取消' };

function formatTime(value: string | null) {
  if (!value) return '—';
  try {
    return formatTimestamp(value);
  } catch {
    return new Date(value).toLocaleString('zh-CN');
  }
}

function formatDuration(startedAt: string | null, finishedAt: string | null): { text: string; slow: boolean } | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const sec = Math.round((end - start) / 1000);
  const prefix = finishedAt ? '耗时 ' : '已运行 ';
  if (sec < 60) return { text: `${prefix}${sec} 秒`, slow: false };
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return { text: `${prefix}${min} 分${remSec ? ` ${remSec} 秒` : ''}`, slow: !finishedAt && min >= 15 };
  const hr = Math.floor(min / 60);
  return { text: `${prefix}${hr} 小时 ${min % 60} 分`, slow: !finishedAt };
}

function statusTone(item: Task): 'active' | 'danger' | 'warn' | 'ok' | 'muted' {
  if (item.status === 'failed') return 'danger';
  if (item.status === 'interrupted' || item.status === 'cancelling') return 'warn';
  if (item.status === 'cancelled') return 'muted';
  if (item.status === 'done') return item.failed?.length ? 'warn' : 'ok';
  return 'active';
}

export type SynthesisProps = {
  courseId?: number;
  onOpenCourse?: (courseId: number) => void;
  onOpenSettings?: () => void;
};

export function Synthesis({ courseId, onOpenCourse, onOpenSettings }: SynthesisProps) {
  return <SynthesisPage key={courseId ?? 'global'} courseId={courseId} onOpenCourse={onOpenCourse} onOpenSettings={onOpenSettings} />;
}

function SynthesisPage({ courseId, onOpenCourse, onOpenSettings }: SynthesisProps) {
  const [query, setQuery] = useState(''), [status, setStatus] = useState('all');
  const [view, setView] = useState('running');
  const [page, setPage] = useState(1), [size, setSize] = useState(DEFAULT_PAGE_SIZE), [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<Overview>(), [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false), [updatedAt, setUpdatedAt] = useState('');
  const [review, setReview] = useState<Task>(), [listen, setListen] = useState<Task>(), [selected, setSelected] = useState<Task>();
  const commands = useTaskCommands(courseId, () => setRefresh(n => n + 1));
  const firstLoad = useRef(true);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      setRefreshing(true);
      try {
        const params = new URLSearchParams({ query, status, view, page: String(page), size: String(size) });
        const base = courseId === undefined ? "/admin/synthesis" : `/teacher/courses/${courseId}/synthesis`;
        const result = await api.get<Overview>(`${base}?${params}`, controller.signal);
        if (!controller.signal.aborted) {
          setData(result);
          setError('');
          setUpdatedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
          firstLoad.current = false;
        }
      } catch (e) { if (!controller.signal.aborted) setError(errorMessage(e)); }
      finally {
        if (!controller.signal.aborted) {
          setRefreshing(false);
          timer = setTimeout(() => void load(), 5000);
        }
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [courseId, query, status, view, page, size, refresh]);

  function focusFilter(nextView: 'running' | 'history', nextStatus: string) {
    setView(nextView);
    setStatus(nextStatus);
    setPage(1);
  }

  const runningCount = data?.counts.running ?? 0;
  const failedCount = data?.counts.failed ?? 0;
  const interruptedCount = data?.counts.interrupted ?? 0;
  const doneCount = data?.counts.done ?? 0;
  const hasAlerts = failedCount > 0 || interruptedCount > 0;

  return <>
    <PageHeader title="资料合成管理">
      {updatedAt && <span className="synthesis-live-meta" aria-live="polite">
        <span className="synthesis-live-dot" aria-hidden="true" />
        上次更新 {updatedAt}
      </span>}
      <Button variant="outline" onClick={() => setRefresh(n => n + 1)}>
        <RefreshCw className={refreshing && !firstLoad.current ? 'animate-spin' : ''} />刷新
      </Button>
    </PageHeader>
    <ErrorNotice message={error} />{commands.feedback}
    {data && <div className="synthesis-metrics" role="group" aria-label="合成任务总览">
      <button type="button" className="synthesis-metric" data-tone={runningCount > 0 ? 'active' : 'neutral'}
        aria-pressed={view === 'running'} onClick={() => focusFilter('running', 'all')}>
        <span className="synthesis-metric-label"><Activity size={14} aria-hidden="true" />正在执行</span>
        <strong>{runningCount}</strong>
      </button>
      <button type="button" className="synthesis-metric" data-tone={failedCount > 0 ? 'danger' : 'neutral'}
        aria-pressed={view === 'history' && status === 'failed'} onClick={() => focusFilter('history', 'failed')}>
        <span className="synthesis-metric-label"><XCircle size={14} aria-hidden="true" />执行失败</span>
        <strong>{failedCount}</strong>
      </button>
      <button type="button" className="synthesis-metric" data-tone={interruptedCount > 0 ? 'warn' : 'neutral'}
        aria-pressed={view === 'history' && status === 'interrupted'} onClick={() => focusFilter('history', 'interrupted')}>
        <span className="synthesis-metric-label"><AlertTriangle size={14} aria-hidden="true" />中断待核查</span>
        <strong>{interruptedCount}</strong>
      </button>
      <button type="button" className="synthesis-metric" data-tone={doneCount > 0 ? 'ok' : 'neutral'}
        aria-pressed={view === 'history' && status === 'done'} onClick={() => focusFilter('history', 'done')}>
        <span className="synthesis-metric-label"><CheckCircle2 size={14} aria-hidden="true" />已完成</span>
        <strong>{doneCount}</strong>
      </button>
    </div>}
    {data && hasAlerts && <div className="synthesis-alert" data-tone={failedCount > 0 ? 'danger' : 'warn'} role="status">
      <div className="synthesis-alert-text">
        <AlertTriangle size={16} aria-hidden="true" />
        <span>
          {[failedCount ? `${failedCount} 条任务执行失败` : '', interruptedCount ? `${interruptedCount} 条任务中断待核查` : ''].filter(Boolean).join('，')}。
          {courseId === undefined ? '可进入对应课程重试、取消或核查课件。' : '失败任务可确认后重试，中断任务请先打开课件审校核查。'}
        </span>
      </div>
      <div className="synthesis-alert-actions">
        {failedCount > 0 && !(view === 'history' && status === 'failed') && (
          <Button type="button" size="sm" variant="outline" onClick={() => focusFilter('history', 'failed')}>查看失败任务</Button>
        )}
        {interruptedCount > 0 && !(view === 'history' && status === 'interrupted') && (
          <Button type="button" size="sm" variant="outline" onClick={() => focusFilter('history', 'interrupted')}>查看待核查</Button>
        )}
        {courseId === undefined && onOpenSettings && (
          <Button type="button" size="sm" variant="outline" onClick={onOpenSettings}><Settings />模型与语音设置</Button>
        )}
      </div>
    </div>}
    <Tabs value={view} onValueChange={v => { setView(v as string); setStatus('all'); setPage(1); }} className="mb-4">
      <TabsList>
        <TabsTrigger value="running"><Activity />正在执行{data ? `（${data.counts.running}）` : ''}</TabsTrigger>
        <TabsTrigger value="history"><History />历史记录</TabsTrigger>
      </TabsList>
    </Tabs>
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <Input className="max-w-sm" aria-label="搜索资料名称" placeholder="搜索资料名称" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} />
      {view === 'history' && <SelectField aria-label="任务状态" value={status} onValueChange={v => { setStatus(v); setPage(1); }}>
        <option value="all">全部状态</option>{Object.entries(statuses).filter(([key]) => key !== 'running' && key !== 'cancelling').map(([key, label]) => <option value={key} key={key}>{label}</option>)}
      </SelectField>}
      <span id="synthesis-columns-0" className="ml-auto" />
    </div>
    {!data ? !error && <Loading /> : <div>
      {data.items.length > 0 && <ManagementTable toolsId="synthesis-columns-0" pageSize={{value:size,total:data.total,change:v => {setSize(v);setPage(1);}}}><TableHeader><TableRow><TableHead>任务 / 资料</TableHead><TableHead>类型 / 范围</TableHead><TableHead>状态 / 进度</TableHead><TableHead>执行时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
        <TableBody>{data.items.map(item => {
          const percent = taskPercent(item);
          const failed = taskFailed(item);
          const duration = formatDuration(item.started_at, item.finished_at);
          return <TableRow key={item.id}>
            <TableCell>
              <span className="font-medium">{item.title}</span>
              <div className="hint">{item.material_kind === 'pdf' ? 'PDF' : '演示文稿'}{courseId === undefined && item.course_name && ` · ${item.course_name}`}</div>
            </TableCell>
            <TableCell>
              {taskTitle(item)}
              <div className="hint">{item.scope}</div>
              <div className="hint">任务 #{item.id} · {item.requested_by}</div>
            </TableCell>
            <TableCell className="max-w-72 whitespace-normal">
              <div className="flex flex-wrap items-center gap-2">
                <span className="synthesis-pill" data-tone={statusTone(item)}>{taskStatus(item)}</span>
                {percent !== null && <span className="text-xs font-medium tabular-nums">{percent}%</span>}
              </div>
              {percent !== null && (item.status === 'running' || item.status === 'cancelling' || failed) && (
                <progress className="synthesis-progress" data-failed={failed} max={100} value={percent} aria-label={`${item.title}进度`} />
              )}
              <div className="hint mt-1">{taskStage(item)}{taskWork(item) && ' · ' + taskWork(item)}</div>
              {failed && (item.diagnostic || item.message) && <p className="synthesis-diagnostic">{item.diagnostic || item.message}</p>}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              <div>开始：{formatTime(item.started_at)}</div>
              <div>结束：{formatTime(item.finished_at)}</div>
              {duration && <div className="synthesis-duration" data-slow={duration.slow}><Clock size={12} aria-hidden="true" />{duration.text}</div>}
            </TableCell>
            <TableCell><div className="flex flex-wrap justify-end gap-1">
              <Button variant="ghost" size="sm" onClick={() => setSelected(item)}><Eye/>任务详情</Button>
              {courseId === undefined && onOpenCourse && item.course_id !== undefined && (
                <Button variant="ghost" size="sm" onClick={() => onOpenCourse(item.course_id!)}><ArrowUpRight />进入课程</Button>
              )}
              {courseId !== undefined && <>
                <Button variant="ghost" size="sm" disabled={item.material_available === false} onClick={() => setReview(item)}><NotebookPen />打开课件审校</Button>
                {item.kind === 'audio' && <Button variant="ghost" size="sm" disabled={item.material_available === false} onClick={() => setListen(item)}><Headphones />试听</Button>}
                <TaskButtons job={item} material={item.title} request={commands.request} variant="ghost"/>
              </>}
            </div></TableCell>
          </TableRow>;
        })}</TableBody>
      </ManagementTable>}
      {!data.items.length && <div className="surface"><ListEmpty title={view === "running" ? "没有进行中的任务" : "暂无执行记录"} filtered={Boolean(query.trim()) || status !== "all"} reset={() => { setQuery(""); setStatus("all"); setPage(1); }} /></div>}
      <Pager total={data.total} page={page} size={size} onPage={setPage} onSize={v => { setSize(v); setPage(1); }} />
    </div>}
    <p className="hint mt-3">每 5 秒自动更新执行状态。</p>
    {courseId !== undefined && review && <NarrationReview courseId={courseId} materialId={review.material_id} title={review.title} onClose={() => { setReview(undefined); setRefresh(n => n + 1); }} />}
    {courseId !== undefined && listen && <NarrationPlayer courseId={courseId} materialId={listen.material_id} title={listen.title} onClose={() => setListen(undefined)} />}
    {selected && <RunDetailDialog key={selected.id} task={selected} courseId={courseId}
      onRequest={courseId !== undefined ? commands.request : undefined}
      onReview={courseId !== undefined ? (item => { setSelected(undefined); setReview(item); }) : undefined}
      onListen={courseId !== undefined ? (item => { setSelected(undefined); setListen(item); }) : undefined}
      onOpenCourse={courseId === undefined ? onOpenCourse : undefined}
      close={() => setSelected(undefined)}/>}
  </>;
}

function RunDetailDialog({task, courseId, onRequest, onReview, onListen, onOpenCourse, close}: {
  task: Task;
  courseId?: number;
  onRequest?: ReturnType<typeof useTaskCommands>['request'];
  onReview?: (item: Task) => void;
  onListen?: (item: Task) => void;
  onOpenCourse?: (courseId: number) => void;
  close: () => void;
}) {
  const [detail, setDetail] = useState(task), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const base = courseId === undefined ? '/admin/synthesis' : `/teacher/courses/${courseId}/synthesis`;
        const row = await api.get<Task>(`${base}/runs/${task.id}`, controller.signal);
        if (controller.signal.aborted) return;
        setDetail(row); setError('');
        if (row.status === 'running' || row.status === 'cancelling') timer = setTimeout(load, 4000);
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [courseId, task.id]);
  const duration = formatDuration(detail.started_at, detail.finished_at);
  const actions = <>
    {onReview && <Button variant="outline" size="sm" disabled={detail.material_available === false} onClick={() => onReview(detail)}><NotebookPen />打开课件审校</Button>}
    {onListen && detail.kind === 'audio' && <Button variant="outline" size="sm" disabled={detail.material_available === false} onClick={() => onListen(detail)}><Headphones />试听</Button>}
    {onOpenCourse && detail.course_id !== undefined && <Button variant="outline" size="sm" onClick={() => { close(); onOpenCourse(detail.course_id!); }}><ArrowUpRight />进入课程处理</Button>}
  </>;
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="synthesis-detail"><DialogHeader>
      <DialogTitle>任务详情 · {taskTitle(detail)}</DialogTitle>
      <DialogDescription>{detail.title} · 任务 #{detail.id}{courseId === undefined && detail.course_name ? ` · ${detail.course_name}` : ''}</DialogDescription>
    </DialogHeader>
      <div className="synthesis-detail-body">
        <ErrorNotice message={error}/>
        <dl className="synthesis-detail-facts">
          <div><dt>处理范围</dt><dd>{detail.scope}</dd></div>
          <div><dt>发起人</dt><dd>{detail.requested_by}</dd></div>
          <div><dt>开始时间</dt><dd>{detail.started_at ? formatTime(detail.started_at) : '未记录'}</dd></div>
          {detail.finished_at && <div><dt>结束时间</dt><dd>{formatTime(detail.finished_at)}</dd></div>}
          {duration && <div><dt>执行耗时</dt><dd>{duration.text}</dd></div>}
        </dl>
        <TaskDetail job={detail} material={detail.title} request={onRequest} actions={actions}/>
      </div>
      <DialogFooter><Button variant="outline" onClick={close}>关闭详情</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
