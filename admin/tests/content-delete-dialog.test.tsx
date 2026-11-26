import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContentDeleteDialog } from '../src/components/content-delete-dialog';

it("includes exclusively related questions in a fresh course-scoped preview", async () => {
  const previews = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    previews(path, payload);
    return json({
      ...plan,
      related_question_count: 1,
      remove: payload.include_related_questions
        ? [...plan.remove, {kind: "question", id: "q1", title: "随章删除的题目"}]
        : plan.remove,
    });
  }));
  const user = userEvent.setup();
  render(<ContentDeleteDialog courseId={7} targets={[{kind: "chapter", id: "1"}]} onClose={vi.fn()} onDone={vi.fn()} />);
  await user.click(await screen.findByRole("checkbox", {name: /同时删除仅由本次所选内容关联的 1 道题目/}));
  expect(await screen.findByText("随章删除的题目")).toBeVisible();
  expect(previews).toHaveBeenLastCalledWith("/api/teacher/courses/7/content-deletions/preview", {
    targets: [{kind: "chapter", id: "1"}], include_related_questions: true,
  });
});
const plan = { id: 'preview', confirmation: '章节一', remove: [{kind:'chapter', id:'1', title:'章节一'}], detach: [], preserve: [], blockers: [], affected_students: 0, ending_sessions: 0, history_policy: '学生历史记录保留' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type':'application/json'}});
afterEach(() => vi.unstubAllGlobals());

it('blocks confirmation and shows the dependency location', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({...plan, blockers: [{message:'建筑开放条件仍引用此章节',path:'configuration.buildings.library'}]})));
  render(<ContentDeleteDialog courseId={7} targets={[{kind:'chapter',id:'1'}]} onClose={() => {}} onDone={() => {}} />);
  expect(await screen.findByText('建筑开放条件仍引用此章节')).toBeVisible();
  expect(screen.getByText('位置：configuration.buildings.library')).toBeVisible();
  expect(screen.getByRole('button', {name:'继续确认'})).toBeDisabled();
});

it('requires a fresh preview after a conflict and clears previous confirmation', async () => {
  const done = vi.fn(), previews = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/confirm')) return json({detail:'学生记录或删除影响已变化，请重新查看影响范围'},409);
    previews(); return json(plan);
  }));
  const user = userEvent.setup();
  render(<ContentDeleteDialog courseId={7} targets={[{kind:'chapter',id:'1'}]} onClose={() => {}} onDone={done} />);
  await waitFor(() => expect(screen.getByRole('button',{name:'继续确认'})).toBeEnabled());
  await user.click(screen.getByRole('button',{name:'继续确认'}));
  await user.type(screen.getByRole('textbox'),'章节一');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button',{name:'确认级联删除'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('学生记录或删除影响已变化');
  expect(screen.getByRole('button',{name:'确认级联删除'})).toBeDisabled();
  expect(done).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'重新预览'}));
  await waitFor(() => expect(previews).toHaveBeenCalledTimes(2));
  await user.click(screen.getByRole('button',{name:'继续确认'}));
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(screen.getByRole('checkbox')).not.toBeChecked();
});
