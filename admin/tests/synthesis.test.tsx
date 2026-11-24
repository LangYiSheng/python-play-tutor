import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { render } from "./render-with-toasts";
import { beforeEach, expect, it, vi } from 'vitest';
import { Synthesis } from '../src/pages/synthesis';
import { api } from '../src/lib/api';

vi.mock('../src/lib/drafts', () => ({ useDraft: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() }, errorMessage: (e: Error) => e.message, token: () => null }));
vi.mock('../src/features/materials/narration/review', () => ({ NarrationReview: () => <div>审校对话框</div> }));
vi.mock('../src/features/materials/narration/player', () => ({ NarrationPlayer: () => <div>试听对话框</div> }));
const task = { id: 1, requested_by: '老师', scope: '第 1–2 页', material_available: true, material_id: 11, title: '变量讲义', material_kind: 'pdf', kind: 'generate', status: 'failed',
  done: 2, total: 2, message: '有一页失败', started_at: '2026-11-15T00:00:00', failed: [{ page_no: 2, error: '服务繁忙' }], retryable: true, retry_note: '' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockResolvedValue({ items: [task], total: 1, counts: { running: 0, failed: 1, interrupted: 0 } });
});
it('shows global synthesis records with their class and keeps changes in class workspaces', async () => {
  vi.mocked(api.get).mockResolvedValue({ items: [{ ...task, course_name: '一班' }], total: 1, counts: { running: 0, failed: 1, interrupted: 0 } });
  render(<Synthesis />);
  expect(await screen.findByText('PDF · 一班')).toBeVisible();
  expect(vi.mocked(api.get).mock.calls[0][0]).toContain('/admin/synthesis?');
  expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
});
it('loads class tasks without invoking services and requires confirmation before retry', async () => {
  vi.mocked(api.post).mockResolvedValue({ ...task, status: 'running', queued: true });
  render(<Synthesis courseId={7} />);
  await screen.findByText('变量讲义');
  expect(vi.mocked(api.get).mock.calls[0][0]).toContain('/courses/7/synthesis?');
  expect(vi.mocked(api.get).mock.calls[0][0]).toContain('view=running');
  fireEvent.click(screen.getByRole('tab', { name: '历史记录' }));
  await waitFor(() => expect(vi.mocked(api.get).mock.calls.at(-1)?.[0]).toContain('view=history'));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认重试' }));
  await screen.findByText(/已提交重试/);
  expect(api.post).toHaveBeenCalledWith('/teacher/courses/7/synthesis/11/retry', { expected_started_at: task.started_at });
  fireEvent.click(screen.getByRole('button', { name: '打开课件审校' }));
  expect(screen.getByText('审校对话框')).toBeInTheDocument();
});
it('explains the current stage and the real unit in the run detail, with audio actions only on audio runs', async () => {
  const record = { ...task, id: 9, kind: 'pipeline', stage: 'calibrate', stage_index: 2, stage_total: 4,
    stages: ['digest', 'calibrate', 'apply', 'script'],
    done: 2, total: 13, progress_unit: 'groups', position: '第 3 个窗口，课件第 9–12 页',
    diagnostic: '第 3 个窗口服务请求超时' };
  const audio = { ...task, id: 10, kind: 'audio', title: '语音批次' };
  vi.mocked(api.get).mockImplementation(async (url) => url.endsWith('/runs/9') ? record : {
    items: [record, audio], total: 2, counts: { running: 0, failed: 2, interrupted: 0 }
  });
  render(<Synthesis courseId={7} />);
  const row = (await screen.findByText('变量讲义')).closest('tr')!;
  expect(within(row).getByText('课程生成')).toBeVisible();
  expect(within(row).getByText(/已处理 2 \/ 13 个文本窗口/)).toBeVisible();
  expect(within(row).queryByRole('button', {name:'试听'})).toBeNull();
  expect(screen.getAllByRole('button', {name:'试听'})).toHaveLength(1);
  expect(within(row).getByRole('button', {name:'重试'}).className).toEqual(within(row).getByRole('button', {name:'打开课件审校'}).className);
  fireEvent.click(within(row).getByRole('button', {name:'任务详情'}));
  const popup = await screen.findByRole('dialog', {name:/任务详情 · 课程生成/});
  expect(within(popup).getByText('阶段 2/4 · 校准整理稿')).toBeVisible();
  const stages = within(popup).getByRole('list', {name: '本次任务阶段'});
  expect(within(stages).getByText('1. 梳理原文').closest('li')).toHaveTextContent('已完成');
  expect(within(stages).getByText('2. 校准整理稿').closest('li')).toHaveTextContent('执行失败');
  expect(within(stages).getByText('3. 应用校准修正').closest('li')).toHaveTextContent('未执行');
  expect(within(popup).getByText(/停止位置 · 第 3 个窗口/)).toBeVisible();
  expect(within(popup).getByText(record.diagnostic)).toBeVisible();
  expect(api.get).toHaveBeenCalledWith('/teacher/courses/7/synthesis/runs/9', expect.any(AbortSignal));
});
it('keeps refresh failures visible and aborts reads when leaving', async () => {
  const view = render(<Synthesis courseId={7} />);
  await screen.findByText('变量讲义');
  vi.mocked(api.get).mockRejectedValue(new Error('连接中断'));
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByRole('alert');
  expect(screen.getByText('变量讲义')).toBeInTheDocument();
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  const signal = vi.mocked(api.get).mock.calls[1][1];
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
