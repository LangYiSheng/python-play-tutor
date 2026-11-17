import { afterEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuestionDialog } from '../src/features/questions/editor-dialog';
import { useQuestionEditor } from '../src/features/questions/use-editor';
import { api } from '../src/lib/api';
import type { Question } from '../src/lib/types';
import { editorPayload, questionEditors } from '../src/features/questions/editor-registry';
import { questionKindLabels } from '../../shared/questions';

afterEach(() => vi.restoreAllMocks());

const question: Question = {
  id: 'q', title: '数字类型', kind: 'multiple_choice', prompt: '选择所有数字类型',
  options: ['int', 'float', 'str'], answer: ['int', 'float'], hidden_cases: [], samples: [],
  source: {}, source_type: 'imported', status: 'draft', chapter_ids: [], knowledge_point_ids: [], owner_id: 1,
};
function Host() {
  const editor = useQuestionEditor(1, () => {});
  return <><button onClick={() => editor.edit(question)}>打开</button>
    <QuestionDialog editor={editor} course={{ data: null }} materials={{ data: [] }} /></>;
}

it('keeps selected answers when renaming options, removes deleted answers and saves arrays', async () => {
  const put = vi.spyOn(api, 'put').mockResolvedValue({});
  const user = userEvent.setup();
  render(<Host />);
  await user.click(screen.getByText('打开'));
  expect(screen.getByLabelText('选项1为正确答案')).toBeChecked();
  expect(screen.getByLabelText('选项2为正确答案')).toBeChecked();
  await user.clear(screen.getByLabelText('选项1'));
  await user.type(screen.getByLabelText('选项1'), 'integer');
  // An empty option removes its selection; the teacher explicitly chooses the new value.
  await user.click(screen.getByLabelText('选项1为正确答案'));
  await user.click(screen.getByLabelText('删除选项2'));
  await user.click(screen.getByText('保存题目'));
  expect(put).toHaveBeenCalledWith(expect.stringContaining('/teacher/questions/q'), expect.objectContaining({
    options: ['integer', 'str'], answer: ['integer'], kind: 'multiple_choice',
  }));
});

it('registers every public kind and preserves existing editor answer formats', () => {
  expect(Object.keys(questionEditors).sort()).toEqual(Object.keys(questionKindLabels).sort());
  const values = { answer: 'false', options: ['A', 'B'], hints: 'Read\nPrint', starterCode: 'print(input())',
    cases: [{ input: 'private', expected_output: 'private' }], samples: [{ input: 'hi', expected_output: 'hi' }], editing: question };
  expect(editorPayload('boolean', values).answer).toBe(false);
  expect(editorPayload('fill', { ...values, answer: 'Python\npy' }).answer).toEqual(['Python', 'py']);
  expect(editorPayload('single_choice', { ...values, answer: 'A' })).toMatchObject({ answer: 'A', options: ['A', 'B'] });
  expect(editorPayload('python', values)).toMatchObject({ starter_code: 'print(input())', samples: [{ input: 'hi', output: 'hi' }], hidden_cases: values.cases });
});
