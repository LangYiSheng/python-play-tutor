import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContentDeleteDialog } from '../src/components/content-delete-dialog';
const plan = {
  id: 'preview',
  confirmation: '章节一',
  remove: [{ kind: 'chapter', id: '1', title: '章节一' }],
  detach: [{ kind: 'activity', id: 'a1', title: '第一章练习' }],
  preserve: [],
  blockers: [],
  affected_students: 2,
  ending_sessions: 0,
  history_policy: '学生历史记录保留',
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type':'application/json'}});
afterEach(() => vi.unstubAllGlobals());

it('blocks confirmation and shows the dependency location', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({...plan, blockers: [{message:'建筑开放条件仍引用此章节',path:'configuration.buildings.library'}]})));
  render(<ContentDeleteDialog classroomId={7} targets={[{kind:'chapter',id:'1'}]} onClose={() => {}} onDone={() => {}} />);
  expect(await screen.findByText('建筑开放条件仍引用此章节')).toBeVisible();
  expect(screen.getByText('位置：configuration.buildings.library')).toBeVisible();
  expect(screen.getByRole('button', {name:'确认删除'})).toBeDisabled();
});

it('requires a fresh preview after a conflict and clears previous acknowledgement', async () => {
  const done = vi.fn(), previews = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/confirm')) return json({detail:'学生记录或删除影响已变化，请重新查看影响范围'},409);
    previews(); return json(plan);
  }));
  const user = userEvent.setup();
  render(<ContentDeleteDialog classroomId={7} targets={[{kind:'chapter',id:'1'}]} onClose={() => {}} onDone={done} />);
  const ack = await screen.findByRole('checkbox', {name:'我已核对删除范围，确认保留学生历史记录'});
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'确认删除'})).toBeDisabled();
  await user.click(ack);
  await user.click(screen.getByRole('button',{name:'确认删除'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('学生记录或删除影响已变化');
  expect(screen.getByRole('button',{name:'确认删除'})).toBeDisabled();
  expect(done).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'重新预览'}));
  await waitFor(() => expect(previews).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('checkbox', {name:'我已核对删除范围，确认保留学生历史记录'})).not.toBeChecked();
});

it('allows one-click delete confirmation when no students or sessions are affected', async () => {
  const done = vi.fn();
  const confirmedBodies: unknown[] = [];
  const zeroPlan = {
    id: 'preview-zero',
    confirmation: '误传课件',
    remove: [{ kind: 'material', id: '9', title: '误传课件' }],
    detach: [],
    preserve: [],
    blockers: [],
    affected_students: 0,
    ending_sessions: 0,
    history_policy: '学生历史记录保留',
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/confirm')) {
      confirmedBodies.push(JSON.parse(String(init?.body)));
      return json({ ok: true });
    }
    return json(zeroPlan);
  }));
  const user = userEvent.setup();
  render(<ContentDeleteDialog classroomId={7} targets={[{ kind: 'material', id: '9' }]} onClose={() => {}} onDone={done} />);
  const btn = await screen.findByRole('button', { name: '确认删除' });
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  await user.click(btn);
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(confirmedBodies).toEqual([{ classroom_id: 7, confirmation: '误传课件', confirmed: true }]);
});

it('re-previews with include_related_questions and allows direct confirmation when students are unaffected', async () => {
  const done = vi.fn();
  const previewBodies: unknown[] = [];
  const confirmedBodies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (url.endsWith('/confirm')) {
      confirmedBodies.push(body);
      return json({ ok: true });
    }
    previewBodies.push(body);
    if (body.include_related_questions) {
      return json({
        ...plan,
        affected_students: 0,
        confirmation: '删除所选2项',
        related_question_count: 1,
        remove: [
          { kind: 'knowledge_point', id: '5', title: '变量命名规则' },
          { kind: 'question', id: 'q1', title: '合法变量名', reason: '仅关联本次删除的知识点，已勾选同步删除' },
        ],
        detach: [],
      });
    }
    return json({
      ...plan,
      affected_students: 0,
      confirmation: '变量命名规则',
      related_question_count: 1,
      remove: [{ kind: 'knowledge_point', id: '5', title: '变量命名规则' }],
      detach: [{ kind: 'question', id: 'q1', title: '合法变量名' }],
    });
  }));
  const user = userEvent.setup();
  render(<ContentDeleteDialog classroomId={7} targets={[{ kind: 'knowledge_point', id: '5' }]} onClose={() => {}} onDone={done} />);
  const toggle = await screen.findByRole('checkbox', { name: /同时删除仅关联此知识点的 1 道题目/ });
  expect(toggle).not.toBeChecked();
  await user.click(toggle);
  await waitFor(() => expect(previewBodies).toHaveLength(2));
  expect(previewBodies[1]).toMatchObject({ include_related_questions: true });
  expect(await screen.findByText(/仅关联本次删除的知识点，已勾选同步删除/)).toBeVisible();
  const confirmBtn = screen.getByRole('button', { name: '确认删除（共 2 项）' });
  expect(confirmBtn).toBeEnabled();
  await user.click(confirmBtn);
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(confirmedBodies).toEqual([{ classroom_id: 7, confirmation: '删除所选2项', confirmed: true }]);
});
