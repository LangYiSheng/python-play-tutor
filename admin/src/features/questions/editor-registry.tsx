import type { ComponentType, Dispatch, SetStateAction } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SelectField } from '@/components/select-field';
import type { QuestionKind } from '../../../../shared/questions';
import type { InteractiveSource } from '../../../../shared/interactivePractice';
import { InteractiveFields } from './interactive-fields';
import { parseInteractiveTarget } from './interactive-target';
import type { Question } from '@/lib/types';
import { Cases } from './cases-editor';
import type { Case } from './types';

export type EditorAnswer = string | string[];
interface Values {
  answer: EditorAnswer; options: string[]; hints: string; starterCode: string;
  samples: Case[]; cases: Case[]; editing: Question | null; interactive: InteractiveSource;
}
interface Fields extends Values {
  setAnswer: Dispatch<SetStateAction<EditorAnswer>>;
  setOptions: Dispatch<SetStateAction<string[]>>;
  setHints: (value: string) => void;
  setStarterCode: (value: string) => void;
  setSamples: (value: Case[]) => void;
  setCases: (value: Case[]) => void;
  setInteractive: (value: InteractiveSource) => void;
  applyInteractiveExample: (id: string) => void;
  setDirty: (value: boolean) => void;
}
type Payload = Pick<Question, 'answer' | 'options' | 'hints' | 'starter_code' | 'samples' | 'hidden_cases' | 'interactive'>;
interface EditorDefinition {
  Fields: ComponentType<Fields>;
  restore: (value: unknown) => EditorAnswer;
  serialize: (value: Values) => Partial<Payload>;
}
const text = (value: unknown) => value == null ? '' : String(value);
const emptyPayload: Payload = { answer: null, options: [], hints: [], starter_code: '', samples: [], hidden_cases: [], interactive: null };

function ChoiceFields(props: Fields & { multiple?: boolean }) {
  const { answer, options, setAnswer, setOptions, setDirty, multiple } = props;
  const selected = Array.isArray(answer) ? answer : answer ? [answer] : [];
  return <fieldset className="field">
    <legend>选项与正确答案</legend>
    {multiple && <p className="hint">至少勾选两个正确答案；学生须全部选对，少选或多选均不通过。</p>}
    {options.map((option, i) => <div className="flex gap-2 items-center my-2" key={i}>
      <input type={multiple ? 'checkbox' : 'radio'} name="correct-option" aria-label={`选项${i + 1}为正确答案`}
        checked={option !== '' && selected.includes(option)} onChange={() => {
          setAnswer(multiple ? selected.includes(option) ? selected.filter(value => value !== option) : [...selected, option] : option);
          setDirty(true);
        }} />
      <Input aria-label={`选项${i + 1}`} value={option} required onChange={event => {
        const value = event.target.value;
        setOptions(options.map((old, index) => index === i ? value : old));
        if (option && selected.includes(option)) setAnswer(multiple ? selected.flatMap(old => old === option ? value ? [value] : [] : [old]) : value);
        setDirty(true);
      }} />
      <Button type="button" variant="ghost" size="icon" aria-label={`删除选项${i + 1}`} disabled={options.length <= 2} onClick={() => {
        setOptions(options.filter((_, index) => index !== i));
        if (selected.includes(option)) setAnswer(multiple ? selected.filter(value => value !== option) : '');
        setDirty(true);
      }}><Trash2 /></Button>
    </div>)}
    <Button type="button" variant="outline" size="sm" disabled={options.length >= 20} onClick={() => { setOptions([...options, '']); setDirty(true); }}>添加选项</Button>
  </fieldset>;
}
function MultipleFields(props: Fields) { return <ChoiceFields {...props} multiple />; }
function BooleanFields({ answer, setAnswer, setDirty }: Fields) {
  return <div className="field"><Label htmlFor="q-answer">正确答案</Label>
    <SelectField id="q-answer" value={typeof answer === 'string' ? answer : ''} onValueChange={value => { setAnswer(value); setDirty(true); }}>
      <option value="">请选择</option><option value="true">正确</option><option value="false">错误</option>
    </SelectField>
  </div>;
}
function FillFields({ answer, setAnswer }: Fields) {
  return <div className="field"><Label htmlFor="q-answer">可接受答案（每行一个）</Label>
    <Textarea id="q-answer" value={answer} onChange={event => setAnswer(event.target.value)} />
  </div>;
}
function PythonFields({ starterCode, setStarterCode, hints, setHints, samples, setSamples, cases, setCases, setDirty }: Fields) {
  return <>
    <div className="field"><Label htmlFor="q-starter">初始 Python 代码（标准输入输出）</Label>
      <Textarea id="q-starter" value={starterCode} maxLength={20000} onChange={event => { setStarterCode(event.target.value); setDirty(true); }} />
    </div>
    <div className="field"><Label htmlFor="q-hints">分步提示（每行一条，最多10条）</Label>
      <Textarea id="q-hints" value={hints} onChange={event => { setHints(event.target.value); setDirty(true); }} />
    </div>
    <Cases title="公开样例" rows={samples} setRows={value => { setSamples(value); setDirty(true); }} />
    <Cases title="私有判题用例" rows={cases} setRows={value => { setCases(value); setDirty(true); }} />
  </>;
}

export const questionEditors: Record<QuestionKind, EditorDefinition> = {
  single_choice: { Fields: ChoiceFields, restore: text, serialize: value => ({ options: value.options, answer: value.answer }) },
  multiple_choice: { Fields: MultipleFields,
    restore: value => Array.isArray(value) && value.every(item => typeof item === 'string') ? [...value] : [],
    serialize: value => ({ options: value.options, answer: Array.isArray(value.answer) ? [...value.answer] : [] }) },
  boolean: { Fields: BooleanFields, restore: text,
    serialize: value => ({ answer: value.answer === 'true' ? true : value.answer === 'false' ? false : null }) },
  fill: { Fields: FillFields, restore: value => Array.isArray(value) ? value.join('\n') : text(value),
    serialize: value => ({ answer: typeof value.answer === 'string' ? value.answer.split('\n').filter(Boolean) : [] }) },
  interactive: { Fields: InteractiveFields, restore: value => value == null ? '' : JSON.stringify(value, null, 2),
    serialize: value => ({ interactive: value.interactive, answer: parseInteractiveTarget(text(value.answer)) }) },
  python: { Fields: PythonFields, restore: text,
    serialize: value => ({ answer: value.editing?.kind === 'python' ? value.editing.answer : null, hints: value.hints.split('\n').filter(line => line.trim()),
      starter_code: value.starterCode, hidden_cases: value.cases,
      samples: value.samples.map(row => ({ input: row.input, output: row.expected_output })) }) },
};
export function editorPayload(kind: QuestionKind, values: Values): Payload {
  return { ...emptyPayload, ...questionEditors[kind].serialize(values) };
}
