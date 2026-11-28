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

it('surfaces failure and interruption cards for one-click triage and provides global jump actions', async () => {
  const openCourse = vi.fn();
  const openSettings = vi.fn();
  vi.mocked(api.get).mockResolvedValue({
    items: [{ ...task, course_id: 9, course_name: '数据结构' }],
    total: 1,
    counts: { running: 0, failed: 2, interrupted: 1, done: 5 },
  });
  render(<Synthesis onOpenCourse={openCourse} onOpenSettings={openSettings} />);
  await screen.findByText('PDF · 数据结构');
  expect(screen.getByText(/2 条任务执行失败，1 条任务中断待核查/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '查看失败任务' }));
  await waitFor(() => expect(vi.mocked(api.get).mock.calls.at(-1)?.[0]).toContain('view=history'));
  expect(vi.mocked(api.get).mock.calls.at(-1)?.[0]).toContain('status=failed');
  fireEvent.click(screen.getByRole('button', { name: '进入课程' }));
  expect(openCourse).toHaveBeenCalledWith(9);
  fireEvent.click(screen.getByRole('button', { name: '模型与语音设置' }));
  expect(openSettings).toHaveBeenCalledTimes(1);
});

it('allows retrying directly from the course run detail dialog', async () => {
  vi.mocked(api.get).mockImplementation(async (url) => url.endsWith('/runs/1') ? task : {
    items: [task], total: 1, counts: { running: 0, failed: 1, interrupted: 0, done: 0 },
  });
  vi.mocked(api.post).mockResolvedValue({ ...task, status: 'running', queued: true });
  render(<Synthesis courseId={7} />);
  await screen.findByText('变量讲义');
  fireEvent.click(screen.getByRole('button', { name: '任务详情' }));
  const popup = await screen.findByRole('dialog', { name: /任务详情/ });
  fireEvent.click(within(popup).getByRole('button', { name: '重试' }));
  fireEvent.click(screen.getByRole('button', { name: '确认重试' }));
  await screen.findByText(/已提交重试/);
  expect(api.post).toHaveBeenCalledWith('/teacher/courses/7/synthesis/11/retry', { expected_started_at: task.started_at });
});

it('shows AI jobs in the unified history and refreshes the counters after dismissal', async () => {
  const row = { source: 'studio', title: '循环', course_name: '基础课', requested_by: '教师',
    job: { id: 'j1', kind: 'coding_exercises_generate', status: 'failed', course_instance_id: 7,
      progress: { done: 1, total: 2, message: '' }, result: { created: 1 }, error: '生成超时' } };
  let dismissed = false;
  vi.mocked(api.get).mockImplementation(async () => ({
    items: dismissed ? [] : [row], counts: { running: 0, failed: Number(!dismissed) }, total: Number(!dismissed),
  }));
  vi.mocked(api.post).mockImplementation(async () => { dismissed = true; return { queue_dismissed: true }; });
  render(<Synthesis courseId={7} />);
  fireEvent.click(await screen.findByRole('tab', { name: '历史记录' }));
  expect(await screen.findByText('AI 编程出题')).toBeVisible();
  expect(screen.getByText('失败前已生成并入库 1 道待审题目')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '忽略' }));
  expect(api.post).toHaveBeenCalledWith('/teacher/courses/7/course-studio/jobs/j1/dismiss', {});
  await waitFor(() => expect(screen.queryByText('生成超时')).not.toBeInTheDocument());
});

it.each([
  { scope: 'course', courseId: 7, listPath: '/teacher/courses/7/synthesis' },
  { scope: 'administrator', courseId: undefined, listPath: '/admin/synthesis' },
])('opens a completed AI coding job from the $scope history and reads its results without starting work', async ({ courseId, listPath }) => {
  const job = {
    id: 'coding-7', kind: 'coding_exercises_generate', course_instance_id: 7,
    scope_key: 'chapter:17:coding_exercises', status: 'done', cancel_requested: false, error: '',
    created_at: '2026-11-28T01:00:00Z', started_at: '2026-11-28T01:00:10Z',
    finished_at: '2026-11-28T01:02:00Z', updated_at: '2026-11-28T01:02:00Z',
    progress: { done: 4, total: 4, message: '已完成：新增 2 道已验编程题草稿' },
    result: { created: 2, skipped: 1, failed: 1, question_ids: ['q-a', 'q-b'], failures: ['边界样例验题失败'] },
  };
  const row = { source: 'studio', title: '二进制转换', course_name: '计算机基础', requested_by: '赵老师', job };
  const questions = [{ id: 'q-a', title: '把二进制转换成整数' }, { id: 'q-b', title: '修复小数位权计算' }];
  const detailUrl = '/teacher/courses/7/course-studio/jobs/coding-7';
  vi.mocked(api.get).mockImplementation(async url => {
    if (url === detailUrl) return { ...job, output_questions: questions };
    if (!url.startsWith(listPath + '?')) throw new Error('意外的请求 ' + url);
    const history = new URL(url, location.origin).searchParams.get('view') === 'history';
    return { items: history ? [row] : [], total: Number(history), counts: { running: 0, done: 1 } };
  });
  const openCourse = vi.fn();
  render(<Synthesis courseId={courseId} onOpenCourse={courseId === undefined ? openCourse : undefined} />);
  fireEvent.click(await screen.findByRole('tab', { name: '历史记录' }));
  const resultRow = await screen.findByRole('row', { name: /AI 编程出题/ });
  fireEvent.click(within(resultRow).getByRole('button', { name: '任务详情' }));
  const dialog = within(await screen.findByRole('dialog', { name: '任务详情 · AI 编程出题' }));
  expect(api.get).toHaveBeenCalledWith(detailUrl, expect.any(AbortSignal));
  for (const question of questions) expect(await dialog.findByText(question.title)).toBeVisible();
  for (const [label, value] of [['任务状态', '已完成'], ['执行进度', '4 / 4'], ['新增题目', '2'], ['跳过', '1'], ['未通过验题', '1']]) {
    expect(dialog.getByText(label).nextElementSibling).toHaveTextContent(value);
  }
  expect(dialog.getByText(job.progress.message)).toBeVisible();
  expect(dialog.getByText(job.result.failures[0])).toBeVisible();
  expect(api.post).not.toHaveBeenCalled();
  if (courseId === undefined) {
    fireEvent.click(dialog.getByRole('button', { name: '关闭详情' }));
    fireEvent.click(within(resultRow).getByRole('button', { name: '进入课程' }));
    expect(openCourse).toHaveBeenCalledWith(7);
  }
});
