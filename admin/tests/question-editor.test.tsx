import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuestionDialog } from '../src/features/questions/editor-dialog';
import { useQuestionEditor } from '../src/features/questions/use-editor';
import { api } from '../src/lib/api';
import type { Question } from '../src/lib/types';
import { editorPayload, questionEditors } from '../src/features/questions/editor-registry';
import { questionKindLabels } from '../../shared/questions';
import { interactiveExamples } from '../../shared/interactiveExamples';
import * as validation from '../src/features/questions/validate-interactive';

const exampleSource = { html: '<p>示例</p>', css: '', js: 'practice.onCheck(() => practice.correct("正确", 1));' };

afterEach(() => vi.restoreAllMocks());
beforeEach(() => { vi.spyOn(validation, 'validateInteractiveSource').mockResolvedValue(undefined); });

const question: Question = {
  id: 'q', title: '数字类型', kind: 'multiple_choice', prompt: '选择所有数字类型',
  options: ['int', 'float', 'str'], answer: ['int', 'float'], hidden_cases: [], samples: [],
  source: {}, source_type: 'imported', status: 'draft', chapter_ids: [], knowledge_point_ids: [], owner_id: 1,
};
function Host({ initial = question }: { initial?: Question } = {}) {
  const editor = useQuestionEditor(1, () => {});
  return <><button onClick={() => editor.edit(initial)}>打开</button><p>{editor.savedWarning}</p>
    <QuestionDialog editor={editor} courseId={1} course={{ data: null }} materials={{ data: [] }} /></>;
}

it('keeps selected answers when renaming options, removes deleted answers and saves arrays', async () => {
  const put = vi.spyOn(api, 'put').mockResolvedValue({});
  const user = userEvent.setup();
  render(<Host />);
  await user.click(screen.getByText('打开'));
  await user.click(screen.getByRole('tab',{name:'答案'}));
  expect(screen.getByLabelText('选项1为正确答案')).toBeChecked();
  expect(screen.getByLabelText('选项2为正确答案')).toBeChecked();
  await user.clear(screen.getByLabelText('选项1'));
  await user.type(screen.getByLabelText('选项1'), 'integer');
  // An empty option removes its selection; the teacher explicitly chooses the new value.
  await user.click(screen.getByLabelText('选项1为正确答案'));
  await user.click(screen.getByLabelText('删除选项2'));
  await user.click(screen.getByText('保存题目'));
  expect(put).toHaveBeenCalledWith(expect.stringContaining('/teacher/courses/1/questions/q'), expect.objectContaining({
    options: ['integer', 'str'], answer: ['integer'], kind: 'multiple_choice',
  }));
});

it('preserves public and private cases independently across tabs', async () => {
  const put = vi.spyOn(api, 'put').mockResolvedValue({});
  const user = userEvent.setup();
  render(<Host initial={{ ...question, kind: 'python', samples: [{input: '1', output: '2'}] }} />);
  await user.click(screen.getByText('打开'));
  await user.click(screen.getByRole('tab', {name: '测试用例'}));
  await user.click(screen.getByRole('button', {name: '复制'}));
  await user.type(screen.getByLabelText('标准输入'), '0');
  await user.click(screen.getByRole('button', {name: /私有用例 · 0/}));
  await user.click(screen.getByRole('button', {name: '添加用例'}));
  await user.type(screen.getByLabelText('预期输出'), 'private');
  await user.click(screen.getByRole('tab', {name: '内容关联'}));
  await user.click(screen.getByText('保存题目'));
  expect(put).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    samples: [{input: '1', output: '2'}, {input: '10', output: '2'}],
    hidden_cases: [{input: '', expected_output: 'private'}],
  }));
});

it('registers every public kind and preserves existing editor answer formats', () => {
  expect(Object.keys(questionEditors).sort()).toEqual(Object.keys(questionKindLabels).sort());
  const values = { answer: 'false', options: ['A', 'B'], hints: 'Read\nPrint', starterCode: 'print(input())',
    cases: [{ input: 'private', expected_output: 'private' }], samples: [{ input: 'hi', expected_output: 'hi' }], editing: question, interactive: exampleSource };
  expect(editorPayload('boolean', values).answer).toBe(false);
  expect(editorPayload('fill', { ...values, answer: 'Python\npy' }).answer).toEqual(['Python', 'py']);
  expect(editorPayload('single_choice', { ...values, answer: 'A' })).toMatchObject({ answer: 'A', options: ['A', 'B'] });
  expect(editorPayload('python', values)).toMatchObject({ starter_code: 'print(input())', samples: [{ input: 'hi', output: 'hi' }], hidden_cases: values.cases });
});

it('restores structured private targets intact, rejects malformed JSON and saves the edited source', async () => {
  const put = vi.spyOn(api, 'put').mockResolvedValue({});
  const user = userEvent.setup();
  const target = { value: [2, false] };
  render(<Host initial={{ ...question, kind: 'interactive', interactive: exampleSource, answer: target }} />);
  await user.click(screen.getByText('打开'));
  await user.click(screen.getByRole('tab',{name:'编写与试答'}));
  const html = screen.getByRole('textbox', { name: 'HTML 源码' });
  await user.clear(html);
  await user.type(html, '<p>新题面</p>');
  await user.click(screen.getByRole('tab',{name:'私有判定'}));
  const answer = screen.getByLabelText('私有正确提交值（JSON）');
  expect(answer).toHaveValue(JSON.stringify(target,null,2));
  await user.clear(answer);
  await user.type(answer, 'bad');
  await user.click(screen.getByText('保存题目'));
  expect(await screen.findByText(/须为有效 JSON/)).toBeVisible();
  expect(put).not.toHaveBeenCalled();
  await user.clear(answer);
  await user.type(answer, '0');
  await user.click(screen.getByText('保存题目'));
  expect(put).toHaveBeenCalledWith(expect.stringContaining('/teacher/courses/1/questions/q'), expect.objectContaining({
    kind: 'interactive', answer: 0, interactive: { ...exampleSource, html: '<p>新题面</p>' },
  }));
});

it('applies a template only after confirmation and keeps source editable', async () => {
  const user = userEvent.setup();
  const put = vi.spyOn(api, 'put').mockResolvedValue({});
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<Host initial={{ ...question, kind: 'interactive', interactive: exampleSource, answer: 1 }} />);
  await user.click(screen.getByText('打开'));
  await user.click(screen.getByRole('tab',{name:'编写与试答'}));
  await user.click(screen.getByText('从示例开始'));
  const template = interactiveExamples[1];
  await user.click(screen.getByRole('combobox', { name: '教学示例' }));
  await user.click(await screen.findByRole('option', { name: template.title }));
  await user.click(screen.getByRole('button', { name: '用此示例编写' }));
  expect(screen.getByLabelText('HTML 源码')).toHaveValue(exampleSource.html);
  await user.click(screen.getByRole('button', { name: '用此示例编写' }));
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText('HTML 源码')).toHaveValue(template.source.html);
  await user.click(screen.getByText('保存题目'));
  expect(put).toHaveBeenCalledWith(expect.stringContaining('/teacher/courses/1/questions/q'), expect.objectContaining({
    kind: 'interactive', prompt: template.prompt, answer: template.target, interactive: template.source,
  }));
});

it('blocks a broken ready question, then retains its draft with a visible diagnostic', async () => {
  const put = vi.spyOn(api, 'put').mockResolvedValue({});
  vi.mocked(validation.validateInteractiveSource).mockRejectedValue(new Error('题目未注册 practice.onGetState'));
  const user = userEvent.setup();
  render(<Host initial={{ ...question, kind: 'interactive', status: 'ready', interactive: exampleSource, answer: 1 }} />);
  await user.click(screen.getByText('打开'));
  await user.click(screen.getByText('保存题目'));
  expect(await screen.findByRole('alert')).toHaveTextContent('onGetState');
  expect(put).not.toHaveBeenCalled();
  await user.click(screen.getByRole('combobox', { name: '状态' }));
  await user.click(await screen.findByRole('option', { name: '待审核' }));
  await user.click(screen.getByText('保存题目'));
  expect(put).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'draft' }));
  expect(await screen.findByText(/已保存为草稿.*onGetState/)).toBeVisible();
});

it('cancels an in-flight save validation when leaving the class before the API write', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const validate = vi.mocked(validation.validateInteractiveSource).mockReturnValue(pending);
  const put = vi.spyOn(api, 'put').mockResolvedValue({});
  const user = userEvent.setup();
  const { unmount } = render(<Host initial={{ ...question, kind: 'interactive', interactive: exampleSource, answer: 1 }} />);
  await user.click(screen.getByText('打开'));
  await user.click(screen.getByText('保存题目'));
  const signal = validate.mock.calls[0][2];
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => { finish(); });
  expect(put).not.toHaveBeenCalled();
});
