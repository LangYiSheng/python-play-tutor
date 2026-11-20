import { isInteractiveValue, type JsonValue } from './interactiveValues';

export interface InteractiveDraft { interactiveDraft: JsonValue }
export type AnswerValue = string | boolean | string[] | InteractiveDraft | null;
export interface QuestionDraft { answer: AnswerValue; code: string }
export interface QuestionShape { kind: QuestionKind; options?: string[] }
interface AnswerPolicy {
  label: string;
  execution: 'answer' | 'python';
  restore: (value: unknown) => AnswerValue;
  serialize: (value: AnswerValue) => AnswerValue;
  complete: (draft: QuestionDraft, question: QuestionShape) => boolean;
  choices?: (question: QuestionShape) => { label: string; value: string }[];
}

const text = (value: unknown) => typeof value === 'string' ? value : '';
const textPolicy: AnswerPolicy = {
  label: '填空题', execution: 'answer', restore: text, serialize: text,
  complete: draft => typeof draft.answer === 'string' && Boolean(draft.answer.trim()),
};
const optionChoices = (question: QuestionShape) => (question.options ?? []).map(value => ({ label: value, value }));

export const questionTypes = {
  single_choice: {
    ...textPolicy, label: '单选题', choices: optionChoices,
  },
  multiple_choice: {
    label: '多选题', execution: 'answer', choices: optionChoices,
    restore: value => Array.isArray(value) && value.every(item => typeof item === 'string') ? [...value] : [],
    serialize: value => Array.isArray(value) ? [...value] : [],
    complete: (draft, question) => Array.isArray(draft.answer) && draft.answer.length > 0
      && new Set(draft.answer).size === draft.answer.length
      && draft.answer.every(item => question.options?.includes(item)),
  },
  boolean: {
    ...textPolicy, label: '判断题',
    // Keep existing local string drafts readable; wire answers remain booleans.
    restore: value => typeof value === 'boolean' ? String(value) : value === 'true' || value === 'false' ? value : '',
    serialize: value => value === true || value === 'true' ? true : value === false || value === 'false' ? false : null,
    complete: draft => ['true', 'false', true, false].includes(draft.answer as string | boolean),
    choices: question => (question.options?.length ? question.options : ['正确', '错误'])
      .map((label, index) => ({ label, value: index === 0 ? 'true' : 'false' })),
  },
  fill: textPolicy,
  interactive: {
    label: '交互练习题', execution: 'answer',
    restore: value => value && typeof value === 'object' && 'interactiveDraft' in value && isInteractiveValue(value.interactiveDraft)
      ? { interactiveDraft: value.interactiveDraft } : null,
    // The host obtains grading evidence from check() only on an explicit practice submission.
    serialize: () => null,
    complete: draft => draft.answer !== null && typeof draft.answer === 'object' && 'interactiveDraft' in draft.answer,
  },
  python: {
    ...textPolicy, label: '编程题', execution: 'python',
    complete: draft => Boolean(draft.code.trim()),
  },
} satisfies Record<string, AnswerPolicy>;

export type QuestionKind = keyof typeof questionTypes;
export const questionKindLabels = Object.fromEntries(Object.entries(questionTypes).map(([kind, policy]) => [kind, policy.label])) as Record<QuestionKind, string>;
export function questionType(kind: QuestionKind): AnswerPolicy {
  const policy = questionTypes[kind];
  if (!policy) throw new Error(`不支持的题型：${kind}`);
  return policy;
}
export function restoreDraft(question: QuestionShape, answer: unknown, code = ''): QuestionDraft {
  return { answer: questionType(question.kind).restore(answer), code };
}
export function submissionAnswer(question: QuestionShape, draft: QuestionDraft) {
  const policy = questionType(question.kind);
  return policy.execution === 'python' ? { code: draft.code } : { answer: policy.serialize(draft.answer) };
}
