import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNotice } from "@/components/common";
import { SelectField } from "@/components/select-field";
import { errorMessage } from "@/lib/api";
import {
  equalInteractiveValues, mountInteractivePractice,
  type InteractiveResult, type InteractiveSource, type JsonValue,
} from "../../../../shared/interactivePractice";
import type { EditorAnswer } from "./editor-registry";
import { parseInteractiveTarget } from "./interactive-target";
import { interactiveExamples } from "../../../../shared/interactiveExamples";

const sourceFields = [
  { key: "html", label: "HTML", max: 32000 },
  { key: "css", label: "CSS", max: 16000 },
  { key: "js", label: "JavaScript", max: 32000 },
] as const;

function Preview({ source, target }: { source: InteractiveSource; target: JsonValue }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const runner = useRef<ReturnType<typeof mountInteractivePractice> | null>(null);
  const [ready, setReady] = useState(false);
  const [operation, setOperation] = useState<"check" | "state" | null>(null);
  const [failure, setFailure] = useState("");
  const [result, setResult] = useState<InteractiveResult | null>(null);
  const [assistantState, setAssistantState] = useState<JsonValue>();
  useEffect(() => {
    if (!frame.current) return;
    try {
      const session = mountInteractivePractice(frame.current, source, {
        onReady: () => setReady(true),
        onError: message => { setFailure(message); setReady(false); setResult(null); setAssistantState(undefined); },
        onDraft: () => { setResult(null); setAssistantState(undefined); },
      });
      runner.current = session;
      return () => { runner.current = null; session.dispose(); };
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }, [source]);
  async function request(action: "check" | "state") {
    const session = runner.current;
    if (!session || !ready || operation) return;
    setOperation(action);
    setFailure("");
    try {
      if (action === "state") {
        const state = await session.getState();
        if (runner.current === session) setAssistantState(state);
      } else {
        const next = await session.check();
        if (runner.current === session) setResult(next);
      }
    } catch (error) {
      if (runner.current === session) {
        if (action === "state") setAssistantState(undefined);
        else setResult(null);
        setFailure(errorMessage(error));
      }
    } finally {
      if (runner.current === session) setOperation(null);
    }
  }
  const matches = result && target !== null && equalInteractiveValues(result.value, target);
  return <div className="interactive-preview">
    <iframe title="学生交互练习预览" ref={frame} />
    <div className="p-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!ready || !!operation} onClick={() => request("check")}>
          {operation === "check" ? "检查中…" : "检查预览作答"}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={!ready || !!operation} onClick={() => request("state")}>
          {operation === "state" ? "读取中…" : "查看助教收到的状态"}
        </Button>
      </div>
      <ErrorNotice message={failure} />
      {assistantState !== undefined && <div role="status">
        <p className="hint">助教收到的当前题面状态（JSON）</p><pre>{JSON.stringify(assistantState, null, 2)}</pre>
      </div>}
      {result && <div role="status" className="space-y-1">
        <p>{result.correct ? "脚本判定正确" : "脚本判定错误"}{result.message ? ` · ${result.message}` : ""}</p>
        <p className="hint">本次提交值</p><pre>{JSON.stringify(result.value, null, 2)}</pre>
        {target === null ? <p>请填写私有正确提交值，再核对判定。</p> :
         matches !== result.correct ? <p className="text-destructive">脚本判定与私有答案不一致，请核对检查函数和正确提交值。</p> :
         <p>本次脚本判定与私有答案一致。</p>}
      </div>}
    </div>
  </div>;
}

export function InteractiveFields({ interactive, setInteractive, answer, setAnswer, applyInteractiveExample }: {
  interactive: InteractiveSource; setInteractive: (value: InteractiveSource) => void;
  answer: EditorAnswer; setAnswer: (value: string) => void;
  applyInteractiveExample: (id: string) => void;
}) {
  const [exampleId, setExampleId] = useState<string>(interactiveExamples[0].id);
  const [preview, setPreview] = useState<{ key: number; source: InteractiveSource; targetText: string; target: JsonValue } | null>(null);
  const [failure, setFailure] = useState("");
  const targetText = typeof answer === "string" ? answer : "";
  function runPreview() {
    try {
      const target = parseInteractiveTarget(targetText);
      setFailure("");
      setPreview(previous => ({ key: (previous?.key ?? 0) + 1, source: interactive, targetText, target }));
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }
  return <fieldset className="field space-y-3">
    <legend>交互内容</legend>
    <p className="hint">仅用于练习。HTML 编排操作区，CSS 调整样式，JavaScript 在学生点击提交时检查作答。题面代码对学生可见。</p>
    <div>
      <Label htmlFor="interactive-example">练习模板</Label>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <SelectField id="interactive-example" value={exampleId} onValueChange={setExampleId}>
          {interactiveExamples.map(example => <option key={example.id} value={example.id}>{example.title}</option>)}
        </SelectField>
        <Button type="button" variant="outline" size="sm" onClick={() => applyInteractiveExample(exampleId)}>套用模板</Button>
      </div>
    </div>
    <Tabs defaultValue="html">
      <TabsList aria-label="题面源码">{sourceFields.map(({ key, label }) =>
        <TabsTrigger type="button" value={key} key={key}>{label}</TabsTrigger>)}</TabsList>
      {sourceFields.map(({ key, label, max }) => <TabsContent key={key} value={key}>
        <Textarea aria-label={`${label} 源码`} rows={8} maxLength={max} spellCheck={false}
          className="font-mono text-sm" value={interactive[key]} onChange={event => {
            setInteractive({ ...interactive, [key]: event.target.value }); setFailure("");
          }} />
      </TabsContent>)}
    </Tabs>
    <details className="text-sm">
      <summary className="cursor-pointer">题目脚本接口</summary>
      <div className="space-y-1 mt-2">
        <p><code>practice.saveDraft(value)</code> 保存当前操作，重新打开时用 <code>practice.initialDraft</code> 恢复。</p>
        <p><code>practice.onGetState(fn)</code> 注册状态读取函数，每次调用都应同步返回描述当前公开题面的 JSON。例如返回已点亮的路灯编号，私有正确提交值留在服务端。</p>
        <p><code>practice.onCheck(fn)</code> 注册提交检查。函数内调用 <code>practice.correct(message, value)</code> 或 <code>practice.incorrect(message, value)</code>，省略 value 时使用最近保存的草稿。</p>
        <p>有多种正确操作时，检查函数应将它们转换为相同的正确提交值。</p>
      </div>
    </details>
    <div className="field">
      <Label htmlFor="interactive-target">私有正确提交值（JSON）</Label>
      <Textarea id="interactive-target" rows={2} className="font-mono" value={targetText} spellCheck={false}
        onChange={event => { setAnswer(event.target.value); setFailure(""); }} />
      <p className="hint">服务端用此值核验提交。例如数字写 1，文本写 "完成"，有序列表写 [0, 2]。设为可用前须填写。</p>
    </div>
    <Button type="button" variant="outline" size="sm" onClick={runPreview}>{preview ? "重新运行预览" : "运行预览"}</Button>
    <ErrorNotice message={failure} />
    {preview && preview.source === interactive && preview.targetText === targetText &&
      <Preview key={preview.key} source={preview.source} target={preview.target} />}
  </fieldset>;
}
