import type { ComponentType, Dispatch, SetStateAction } from "react";
import { Check, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { QuestionKind } from "../../../../shared/questions";
import type { InteractiveSource } from "../../../../shared/interactivePractice";
import { InteractiveFields } from "./interactive-fields";
import { parseInteractiveTarget } from "./interactive-target";
import type { Question } from "@/lib/types";
import type { Case } from "./types";

export type EditorAnswer = string | string[];
interface Values {
  answer: EditorAnswer;
  options: string[];
  hints: string;
  starterCode: string;
  samples: Case[];
  cases: Case[];
  editing: Question | null;
  interactive: InteractiveSource;
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
type Payload = Pick<
  Question,
  "answer" | "options" | "hints" | "starter_code" | "samples" | "hidden_cases" | "interactive"
>;
interface EditorDefinition {
  Fields: ComponentType<Fields>;
  restore: (value: unknown) => EditorAnswer;
  serialize: (value: Values) => Partial<Payload>;
}
const text = (value: unknown) => (value == null ? "" : String(value));
const emptyPayload: Payload = {
  answer: null,
  options: [],
  hints: [],
  starter_code: "",
  samples: [],
  hidden_cases: [],
  interactive: null,
};

function ChoiceFields(props: Fields & { multiple?: boolean }) {
  const { answer, options, setAnswer, setOptions, setDirty, multiple } = props;
  const selected = Array.isArray(answer) ? answer : answer ? [answer] : [];
  return (
    <fieldset className="field">
      <legend>选项与正确答案</legend>
      {multiple && (
        <p className="hint">至少勾选两个正确答案；学生须全部选对，少选或多选均不通过。</p>
      )}
      <div className="space-y-1.5">
        {options.map((option, i) => {
          const isCorrect = option !== "" && selected.includes(option);
          const letter = i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
          return (
            <div
              key={i}
              className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors ${
                isCorrect
                  ? "border-emerald-300 bg-emerald-50/70"
                  : "border-border/60 bg-background hover:bg-muted/30"
              }`}
            >
              <input
                type={multiple ? "checkbox" : "radio"}
                name="correct-option"
                aria-label={`选项${i + 1}为正确答案`}
                checked={isCorrect}
                className="size-4 accent-emerald-600 cursor-pointer shrink-0"
                onChange={() => {
                  setAnswer(
                    multiple
                      ? selected.includes(option)
                        ? selected.filter((value) => value !== option)
                        : [...selected, option]
                      : option,
                  );
                  setDirty(true);
                }}
              />
              <span
                className={`inline-flex size-6 shrink-0 items-center justify-center rounded text-xs font-semibold ${
                  isCorrect
                    ? "bg-emerald-600 text-white"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {letter}
              </span>
              <Input
                aria-label={`选项${i + 1}`}
                value={option}
                required
                className="h-8 bg-background"
                onChange={(event) => {
                  const value = event.target.value;
                  setOptions(options.map((old, index) => (index === i ? value : old)));
                  if (option && selected.includes(option)) {
                    setAnswer(
                      multiple
                        ? selected.flatMap((old) =>
                            old === option ? (value ? [value] : []) : [old],
                          )
                        : value,
                    );
                  }
                  setDirty(true);
                }}
              />
              {isCorrect && (
                <span className="hidden shrink-0 text-[11px] font-medium text-emerald-700 sm:inline">
                  正确
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`删除选项${i + 1}`}
                disabled={options.length <= 2}
                onClick={() => {
                  setOptions(options.filter((_, index) => index !== i));
                  if (selected.includes(option)) {
                    setAnswer(
                      multiple ? selected.filter((value) => value !== option) : "",
                    );
                  }
                  setDirty(true);
                }}
              >
                <Trash2 />
              </Button>
            </div>
          );
        })}
      </div>
      <div className="pt-1">
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={options.length >= 20}
          onClick={() => {
            setOptions([...options, ""]);
            setDirty(true);
          }}
        >
          <Plus /> 添加选项
        </Button>
      </div>
    </fieldset>
  );
}

function MultipleFields(props: Fields) {
  return <ChoiceFields {...props} multiple />;
}

function BooleanFields({ answer, setAnswer, setDirty }: Fields) {
  const val = typeof answer === "string" ? answer : "";
  return (
    <fieldset className="field">
      <legend>正确答案</legend>
      <div className="flex gap-2" role="group" aria-label="正确答案">
        <Button
          type="button"
          size="sm"
          variant={val === "true" ? "default" : "outline"}
          aria-pressed={val === "true"}
          className={
            val === "true"
              ? "flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
              : "flex-1"
          }
          onClick={() => {
            setAnswer("true");
            setDirty(true);
          }}
        >
          <Check /> 正确
        </Button>
        <Button
          type="button"
          size="sm"
          variant={val === "false" ? "default" : "outline"}
          aria-pressed={val === "false"}
          className={
            val === "false"
              ? "flex-1 bg-rose-600 text-white hover:bg-rose-700"
              : "flex-1"
          }
          onClick={() => {
            setAnswer("false");
            setDirty(true);
          }}
        >
          <X /> 错误
        </Button>
      </div>
    </fieldset>
  );
}

function FillFields({ answer, setAnswer, setDirty }: Fields) {
  return (
    <div className="field">
      <Label htmlFor="q-answer">可接受答案（每行一个）</Label>
      <Textarea
        id="q-answer"
        rows={3}
        value={answer}
        placeholder="每行填写一个等价答案，学生命中任一行即判正确"
        onChange={(event) => {
          setAnswer(event.target.value);
          setDirty(true);
        }}
      />
      <p className="hint">单空填空，每行一个等价写法（如大小写或同义表达）。</p>
    </div>
  );
}

function PythonFields({
  starterCode,
  setStarterCode,
  hints,
  setHints,
  setDirty,
}: Fields) {
  return (
    <>
      <div className="field">
        <Label htmlFor="q-starter">初始 Python 代码（标准输入输出）</Label>
        <Textarea
          id="q-starter"
          value={starterCode}
          maxLength={20000}
          onChange={(event) => {
            setStarterCode(event.target.value);
            setDirty(true);
          }}
        />
      </div>
      <div className="field">
        <Label htmlFor="q-hints">分步提示（每行一条，最多10条）</Label>
        <Textarea
          id="q-hints"
          value={hints}
          onChange={(event) => {
            setHints(event.target.value);
            setDirty(true);
          }}
        />
      </div>
    </>
  );
}

export const questionEditors: Record<QuestionKind, EditorDefinition> = {
  single_choice: {
    Fields: ChoiceFields,
    restore: text,
    serialize: (value) => ({ options: value.options, answer: value.answer }),
  },
  multiple_choice: {
    Fields: MultipleFields,
    restore: (value) =>
      Array.isArray(value) && value.every((item) => typeof item === "string")
        ? [...value]
        : [],
    serialize: (value) => ({
      options: value.options,
      answer: Array.isArray(value.answer) ? [...value.answer] : [],
    }),
  },
  boolean: {
    Fields: BooleanFields,
    restore: text,
    serialize: (value) => ({
      answer: value.answer === "true" ? true : value.answer === "false" ? false : null,
    }),
  },
  fill: {
    Fields: FillFields,
    restore: (value) => (Array.isArray(value) ? value.join("\n") : text(value)),
    serialize: (value) => ({
      answer:
        typeof value.answer === "string"
          ? value.answer.split("\n").filter(Boolean)
          : [],
    }),
  },
  interactive: {
    Fields: InteractiveFields,
    restore: (value) => (value == null ? "" : JSON.stringify(value, null, 2)),
    serialize: (value) => ({
      interactive: value.interactive,
      answer: parseInteractiveTarget(text(value.answer)),
    }),
  },
  python: {
    Fields: PythonFields,
    restore: text,
    serialize: (value) => ({
      answer: value.editing?.kind === "python" ? value.editing.answer : null,
      hints: value.hints.split("\n").filter((line) => line.trim()),
      starter_code: value.starterCode,
      hidden_cases: value.cases,
      samples: value.samples.map((row) => ({
        input: row.input,
        output: row.expected_output,
      })),
    }),
  },
};

export function editorPayload(kind: QuestionKind, values: Values): Payload {
  return { ...emptyPayload, ...questionEditors[kind].serialize(values) };
}
