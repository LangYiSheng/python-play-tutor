import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Play, Sparkles, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import type { Case, CodingType } from "./types";
import {
  generateOutputsFromReference,
  verifyPythonQuestion,
  type PythonVerificationReport,
} from "./validate-python";

export function Cases({
  samples,
  hidden,
  onSamples,
  onHidden,
  codingType = "",
  starterCode = "",
  referenceSolution = "",
}: {
  samples: Case[];
  hidden: Case[];
  onSamples: (rows: Case[]) => void;
  onHidden: (rows: Case[]) => void;
  codingType?: CodingType | "";
  starterCode?: string;
  referenceSolution?: string;
}) {
  const [group, setGroup] = useState<"公开样例" | "私有用例">("公开样例");
  const [positions, setPositions] = useState({ 公开样例: 0, 私有用例: 0 });
  const [busyMode, setBusyMode] = useState<"verify" | "fill" | null>(null);
  const [runError, setRunError] = useState("");
  const [report, setReport] = useState<PythonVerificationReport | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(() => {
    setReport(null);
    setRunError("");
  }, [samples, hidden, codingType, starterCode, referenceSolution]);

  const isPublic = group === "公开样例";
  const rows = isPublic ? samples : hidden;
  const change = isPublic ? onSamples : onHidden;
  const index = Math.max(0, Math.min(positions[group], rows.length - 1));
  const select = (next: number) => setPositions((p) => ({ ...p, [group]: next }));
  const active = rows[index];
  function insert(copy: boolean) {
    const at = copy ? index + 1 : rows.length;
    change([
      ...rows.slice(0, at),
      copy ? { ...active } : { input: "", expected_output: "" },
      ...rows.slice(at),
    ]);
    select(at);
  }
  const full = samples.length + hidden.length >= 20;
  const totalCases = samples.length + hidden.length;
  const hasRef = Boolean(referenceSolution.trim());

  async function runVerify() {
    if (busyMode) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusyMode("verify");
    setRunError("");
    setReport(null);
    try {
      const next = await verifyPythonQuestion({
        codingType,
        starterCode,
        referenceSolution,
        samples,
        hidden,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setReport(next);
    } catch (cause) {
      if (!controller.signal.aborted) setRunError(errorMessage(cause));
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setBusyMode(null);
      }
    }
  }

  async function fillOutputs() {
    if (busyMode) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusyMode("fill");
    setRunError("");
    setReport(null);
    try {
      const generated = await generateOutputsFromReference({
        referenceSolution,
        samples,
        hidden,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        onSamples(generated.samples);
        onHidden(generated.hidden);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setRunError(errorMessage(cause));
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setBusyMode(null);
      }
    }
  }

  const caseCheck = report?.cases.find(
    (c) => c.scope === (isPublic ? "sample" : "hidden") && c.index === index + 1,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {(["公开样例", "私有用例"] as const).map((name) => (
          <Button
            key={name}
            type="button"
            variant={group === name ? "default" : "outline"}
            aria-pressed={group === name}
            onClick={() => setGroup(name)}
          >
            {name} · {name === "公开样例" ? samples.length : hidden.length}
          </Button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={Boolean(busyMode) || !hasRef || totalCases === 0}
            title={hasRef ? "用参考代码运行所有用例并回填预期输出" : "请先在「初始代码与提示」填写参考答案代码"}
            onClick={() => void fillOutputs()}
          >
            <Sparkles /> {busyMode === "fill" ? "计算中…" : "用参考代码填充输出"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={Boolean(busyMode) || !hasRef || totalCases === 0}
            title={hasRef ? "在浏览器沙箱验证参考解与初始代码" : "请先在「初始代码与提示」填写参考答案代码"}
            onClick={() => void runVerify()}
          >
            <Play /> {busyMode === "verify" ? "验证中…" : "一键验证全部用例"}
          </Button>
        </div>
      </div>
      <p className="hint">
        {isPublic
          ? "学生可见，编程练习提交时评测全部公开样例。"
          : "仅教师可见，用于测验的服务端判题。"}
      </p>
      {runError && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {runError}
        </p>
      )}
      {report && (
        <section
          aria-label="编程题用例验证结果"
          className={`space-y-1.5 rounded-md border px-3 py-2 text-xs ${
            report.ok
              ? "border-emerald-300 bg-emerald-50/70 text-emerald-900"
              : "border-destructive/40 bg-destructive/5 text-destructive"
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            {report.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            <strong>
              {report.ok ? "验题通过" : "验题未通过"}：参考代码通过{" "}
              {report.cases.filter((c) => c.status === "accepted").length} / {report.cases.length} 个用例
            </strong>
            {report.starterTotal !== undefined && (
              <Badge variant="outline" className="bg-background text-[11px]">
                初始代码通过 {report.starterPassed}/{report.starterTotal}
              </Badge>
            )}
          </div>
          {report.errors.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4">
              {report.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          )}
          {report.warnings.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-amber-800">
              {report.warnings.map((warn, i) => (
                <li key={i}>{warn}</li>
              ))}
            </ul>
          )}
        </section>
      )}
      <div className="editor-columns">
        <div className="editor-list">
          {rows.map((_, i) => {
            const check = report?.cases.find(
              (c) => c.scope === (isPublic ? "sample" : "hidden") && c.index === i + 1,
            );
            return (
              <button
                type="button"
                key={i}
                className="editor-list-item flex items-center justify-between gap-1"
                aria-pressed={index === i}
                onClick={() => select(i)}
              >
                <span>
                  {group} {i + 1}
                </span>
                {check && (
                  <span className={check.status === "accepted" ? "text-emerald-600" : "text-destructive"}>
                    {check.status === "accepted" ? "✓" : "✕"}
                  </span>
                )}
              </button>
            );
          })}
          <Button type="button" variant="outline" disabled={full} onClick={() => insert(false)}>
            添加用例
          </Button>
        </div>
        <div>
          {active ? (
            <>
              <div className="mb-3 flex items-center gap-2">
                <strong className="mr-auto">
                  {group} {index + 1}
                </strong>
                <Button type="button" variant="outline" size="sm" disabled={full} onClick={() => insert(true)}>
                  复制
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => change(rows.filter((_, i) => index !== i))}
                >
                  移除
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {(["input", "expected_output"] as const).map((key) => (
                  <label className="field" key={key}>
                    {key === "input" ? "标准输入" : "预期输出"}
                    <Textarea
                      rows={7}
                      className="field-sizing-fixed h-40 max-h-60 resize-y overflow-y-auto font-mono"
                      value={active[key]}
                      onChange={(e) =>
                        change(rows.map((r, i) => (i === index ? { ...r, [key]: e.target.value } : r)))
                      }
                    />
                  </label>
                ))}
              </div>
              {caseCheck && caseCheck.status !== "accepted" && (
                <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                  {caseCheck.stderr ? (
                    <pre className="whitespace-pre-wrap font-mono">{caseCheck.stderr}</pre>
                  ) : (
                    <>
                      <strong>参考代码实际输出：</strong>
                      <pre className="mt-1 whitespace-pre-wrap font-mono">
                        {caseCheck.stdout || "（无输出）"}
                      </pre>
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="hint">点击「添加用例」开始编写。</p>
          )}
        </div>
      </div>
    </div>
  );
}
