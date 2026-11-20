import { createPortal } from "react-dom";
import { useEffect, useState } from 'react';
import { FilePenLine, Headphones, RefreshCw, ListChecks } from 'lucide-react';
import { PageHeader, ErrorNotice, Loading, Empty, Pager } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/select-field';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { NarrationReview } from '@/features/materials/narration/review';
import { NarrationPlayer } from '@/features/materials/narration/player';
import { api, errorMessage } from '@/lib/api';
import { TaskButtons, TaskDetail, useTaskCommands } from '@/features/content-workspace/task-queue';
import { taskFailed, taskPercent, taskStage, taskStatus, taskTitle, taskWork, type TaskSnapshot } from '@/features/content-workspace/task-presentation';
import '@/features/content-workspace/inspector-content.css';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Activity, History } from 'lucide-react';

type Task = TaskSnapshot & {
  classroom_name?: string;
  id: number; material_id: number; title: string; material_kind: string; kind: string; status: string;
  requested_by: string; scope: string; material_available: boolean;
  done: number; total: number; message: string; started_at: string | null; finished_at: string | null;
  failed: { page_no: number; error?: string }[]; retryable: boolean; retry_note: string;
};
type Overview = { items: Task[]; total: number; counts: Record<string, number> };
const statuses: Record<string, string> = { running: '处理中', done: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', cancelling: '正在取消' };

export function Synthesis({ actionsTarget, classroomId }: { actionsTarget?: HTMLDivElement | null; classroomId?: number }) {
  return <SynthesisPage key={classroomId ?? 'global'} actionsTarget={actionsTarget} classroomId={classroomId}/>;
}

function SynthesisPage({ actionsTarget, classroomId }: { actionsTarget?: HTMLDivElement | null; classroomId?: number }) {
  const [query, setQuery] = useState(''), [status, setStatus] = useState('all');
  const [view, setView] = useState('running');
  const [page, setPage] = useState(1), [size, setSize] = useState(25), [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<Overview>(), [error, setError] = useState('');
  const [review, setReview] = useState<Task>(), [listen, setListen] = useState<Task>(), [selected, setSelected] = useState<Task>();
  const commands = useTaskCommands(classroomId, () => setRefresh(n => n + 1));
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const params = new URLSearchParams({ query, status, view, page: String(page), size: String(size) });
        const base = classroomId === undefined ? "/admin/synthesis" : `/teacher/classrooms/${classroomId}/synthesis`;
        const result = await api.get<Overview>(`${base}?${params}`, controller.signal);
        if (!controller.signal.aborted) { setData(result); setError(''); }
      } catch (e) { if (!controller.signal.aborted) setError(errorMessage(e)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void load(), 5000); }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [classroomId, query, status, view, page, size, refresh]);
  const refreshButton = <Button variant="outline" onClick={() => setRefresh(n => n + 1)}><RefreshCw />刷新</Button>;
  return <>
    {classroomId === undefined
      ? actionsTarget && createPortal(refreshButton, actionsTarget)
      : <PageHeader title="资料合成管理" description="跟踪本班讲稿生成、校准与配音任务，查看每次执行的结果和失败原因。">{refreshButton}</PageHeader>}
    <Tabs value={view} onValueChange={v => { setView(v as string); setStatus('all'); setPage(1); }} className="mb-4">
      <TabsList><TabsTrigger value="running"><Activity />正在执行{data ? `（${data.counts.running}）` : ''}</TabsTrigger><TabsTrigger value="history"><History />历史记录</TabsTrigger></TabsList>
    </Tabs>
    <ErrorNotice message={error} />{commands.feedback}
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <Input className="max-w-sm" aria-label="搜索资料名称" placeholder="搜索资料名称" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} />
      {view === 'history' && <SelectField aria-label="任务状态" value={status} onValueChange={v => { setStatus(v); setPage(1); }}>
        <option value="all">全部状态</option>{Object.entries(statuses).filter(([key]) => key !== 'running' && key !== 'cancelling').map(([key, label]) => <option value={key} key={key}>{label}</option>)}
      </SelectField>}
      {data && <span className="hint">处理中 {data.counts.running} · 失败 {data.counts.failed} · 待核查 {data.counts.interrupted}</span>}
    </div>
    {!data ? !error && <Loading /> : <div className="surface overflow-hidden">
      <Table><TableHeader><TableRow><TableHead>任务 / 资料</TableHead><TableHead>类型 / 范围</TableHead><TableHead>状态 / 进度</TableHead><TableHead>执行时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
        <TableBody>{data.items.map(item => <TableRow key={item.id}>
          <TableCell><span className="font-medium">{item.title}</span><div className="hint">{item.material_kind === 'pdf' ? 'PDF' : '演示文稿'}{classroomId === undefined && item.classroom_name && ` · ${item.classroom_name}`}</div></TableCell>
          <TableCell>{taskTitle(item)}<div className="hint">{item.scope}</div><div className="hint">任务 #{item.id} · {item.requested_by}</div></TableCell>
          <TableCell className="max-w-64 whitespace-normal"><span className={taskFailed(item) ? 'text-destructive' : ''}>{taskStatus(item)}</span>
            {taskPercent(item) !== null && <span className="ml-2 text-xs tabular-nums">{taskPercent(item)}%</span>}
            <div className="hint">{taskStage(item)}{taskWork(item) && ' · ' + taskWork(item)}</div>
            {taskFailed(item) && (item.diagnostic || item.message) && <p className="synthesis-diagnostic">{item.diagnostic || item.message}</p>}
          </TableCell>
          <TableCell className="text-xs text-muted-foreground"><div>开始：{item.started_at ? new Date(item.started_at).toLocaleString('zh-CN') : '—'}</div><div>结束：{item.finished_at ? new Date(item.finished_at).toLocaleString('zh-CN') : '—'}</div></TableCell>
          <TableCell><div className="flex flex-wrap justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => setSelected(item)}><ListChecks/>任务详情</Button>
            {classroomId !== undefined && <>
              <Button variant="ghost" size="sm" disabled={item.material_available === false} onClick={() => setReview(item)}><FilePenLine />查看资料</Button>
              {item.kind === 'audio' && <Button variant="ghost" size="sm" disabled={item.material_available === false} onClick={() => setListen(item)}><Headphones />试听</Button>}
              <TaskButtons job={item} material={item.title} request={commands.request} variant="ghost"/>
            </>}
          </div></TableCell>
        </TableRow>)}</TableBody>
      </Table>
      {!data.items.length && <Empty title={view === 'running' ? '当前没有正在执行的任务' : '暂无符合条件的执行记录'} description={view === 'running' ? '可在历史记录中查看之前的执行结果。' : '每次执行独立保留记录，重试不会覆盖上一次结果。'} />}
      <Pager total={data.total} page={page} size={size} onPage={setPage} onSize={v => { setSize(v); setPage(1); }} />
    </div>}
    <p className="hint mt-3">每 5 秒更新执行状态。</p>
    {classroomId !== undefined && review && <NarrationReview classroomId={classroomId} materialId={review.material_id} title={review.title} onClose={() => { setReview(undefined); setRefresh(n => n + 1); }} />}
    {classroomId !== undefined && listen && <NarrationPlayer classroomId={classroomId} materialId={listen.material_id} title={listen.title} onClose={() => setListen(undefined)} />}
    {selected && <RunDetailDialog key={selected.id} task={selected} classroomId={classroomId} close={() => setSelected(undefined)}/>}
  </>;
}

function RunDetailDialog({task, classroomId, close}: {task: Task; classroomId?: number; close: () => void}) {
  const [detail, setDetail] = useState(task), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const base = classroomId === undefined ? '/admin/synthesis' : `/teacher/classrooms/${classroomId}/synthesis`;
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
  }, [classroomId, task.id]);
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
      <DialogContent className="synthesis-detail"><DialogHeader>
        <DialogTitle>任务详情 · {taskTitle(detail)}</DialogTitle>
        <DialogDescription>{detail.title} · 任务 #{detail.id}</DialogDescription>
      </DialogHeader>
        <div className="synthesis-detail-body">
          <ErrorNotice message={error}/>
          <dl className="synthesis-detail-facts"><div><dt>处理范围</dt><dd>{detail.scope}</dd></div>
            <div><dt>发起人</dt><dd>{detail.requested_by}</dd></div>
            <div><dt>开始时间</dt><dd>{detail.started_at ? new Date(detail.started_at).toLocaleString('zh-CN') : '未记录'}</dd></div>
            {detail.finished_at && <div><dt>结束时间</dt><dd>{new Date(detail.finished_at).toLocaleString('zh-CN')}</dd></div>}
          </dl>
          <TaskDetail job={detail} material={detail.title}/>
        </div><DialogFooter><Button variant="outline" onClick={close}>关闭详情</Button></DialogFooter>
      </DialogContent></Dialog>;
}
