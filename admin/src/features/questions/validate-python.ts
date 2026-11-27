import {
  type CodingType,
  validateFillSubmission,
} from "../../../../shared/codingQuestions";
import { createPythonRunner, sameOutput } from "../../../../shared/pythonRunner";
import type { Case } from "./types";

export interface PythonCaseCheckResult {
  scope: "sample" | "hidden";
  index: number;
  status: "accepted" | "wrong_answer" | "runtime_error";
  stdout: string;
  expected: string;
  stderr: string;
}

export interface PythonVerificationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  cases: PythonCaseCheckResult[];
  starterPassed?: number;
  starterTotal?: number;
}

export async function verifyPythonQuestion({
  codingType,
  starterCode,
  referenceSolution,
  samples,
  hidden,
  signal,
}: {
  codingType: CodingType | "";
  starterCode: string;
  referenceSolution: string;
  samples: Case[];
  hidden: Case[];
  signal: AbortSignal;
}): Promise<PythonVerificationReport> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!referenceSolution.trim()) {
    return { ok: false, errors: ["请先在「初始代码与提示」页签填写参考答案代码。"], warnings, cases: [] };
  }
  const allCases: { scope: "sample" | "hidden"; index: number; item: Case }[] = [
    ...samples.map((item, i) => ({ scope: "sample" as const, index: i + 1, item })),
    ...hidden.map((item, i) => ({ scope: "hidden" as const, index: i + 1, item })),
  ];
  if (!allCases.length) {
    return { ok: false, errors: ["请至少添加一个公开样例或私有用例后再验证。"], warnings, cases: [] };
  }

  if (codingType === "fill_code") {
    errors.push(...validateFillSubmission(starterCode, referenceSolution));
  } else if (codingType === "debug") {
    if (!starterCode.trim()) errors.push("程序改错题必须填写含错误的初始代码。");
    else if (starterCode.trim() === referenceSolution.trim()) {
      errors.push("程序改错题的初始代码与参考答案完全相同。");
    }
  }

  const runner = createPythonRunner(Math.min(2, allCases.length));
  const results: PythonCaseCheckResult[] = [];
  let starterPassed: number | undefined;
  let starterTotal: number | undefined;

  try {
    for (const entry of allCases) {
      signal.throwIfAborted();
      const run = await runner.run(referenceSolution, entry.item.input, signal);
      const status: PythonCaseCheckResult["status"] = run.stderr
        ? "runtime_error"
        : sameOutput(run.stdout, entry.item.expected_output)
          ? "accepted"
          : "wrong_answer";
      results.push({
        scope: entry.scope,
        index: entry.index,
        status,
        stdout: run.stdout,
        expected: entry.item.expected_output,
        stderr: run.stderr,
      });
      if (status !== "accepted") {
        const label = entry.scope === "sample" ? `公开样例 ${entry.index}` : `私有用例 ${entry.index}`;
        errors.push(
          status === "runtime_error"
            ? `参考代码在${label}执行出错：${run.stderr.trim().slice(0, 140)}`
            : `参考代码在${label}输出与预期不一致。`,
        );
      }
    }

    if (starterCode.trim()) {
      starterPassed = 0;
      starterTotal = allCases.length;
      let publicStarterPassed = 0;
      for (const entry of allCases) {
        signal.throwIfAborted();
        const run = await runner.run(starterCode, entry.item.input, signal);
        const passed = !run.stderr && sameOutput(run.stdout, entry.item.expected_output);
        if (passed) {
          starterPassed += 1;
          if (entry.scope === "sample") publicStarterPassed += 1;
        }
      }
      if (starterPassed === starterTotal) {
        errors.push("初始代码未作修改即可通过全部测试用例，请检查是否误把完整答案放进了初始代码。");
      } else if (codingType === "debug" && samples.length > 0 && publicStarterPassed === samples.length) {
        warnings.push("程序改错题的初始代码通过了全部公开样例（仅隐藏用例失败），建议至少有 1 个公开样例暴露该错误。");
      }
    }
  } finally {
    runner.dispose();
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    cases: results,
    starterPassed,
    starterTotal,
  };
}

export async function generateOutputsFromReference({
  referenceSolution,
  samples,
  hidden,
  signal,
}: {
  referenceSolution: string;
  samples: Case[];
  hidden: Case[];
  signal: AbortSignal;
}): Promise<{ samples: Case[]; hidden: Case[] }> {
  if (!referenceSolution.trim()) {
    throw new Error("请先在「初始代码与提示」页签填写参考答案代码。");
  }
  const total = samples.length + hidden.length;
  if (!total) throw new Error("请先添加至少一个测试用例并填写标准输入。");

  const runner = createPythonRunner(Math.min(2, total));
  try {
    const nextSamples: Case[] = [];
    for (const [idx, row] of samples.entries()) {
      signal.throwIfAborted();
      const run = await runner.run(referenceSolution, row.input, signal);
      if (run.stderr) {
        throw new Error(`公开样例 ${idx + 1} 执行出错：${run.stderr.trim().slice(0, 160)}`);
      }
      nextSamples.push({ input: row.input, expected_output: run.stdout.replace(/\r\n/g, "\n") });
    }
    const nextHidden: Case[] = [];
    for (const [idx, row] of hidden.entries()) {
      signal.throwIfAborted();
      const run = await runner.run(referenceSolution, row.input, signal);
      if (run.stderr) {
        throw new Error(`私有用例 ${idx + 1} 执行出错：${run.stderr.trim().slice(0, 160)}`);
      }
      nextHidden.push({ input: row.input, expected_output: run.stdout.replace(/\r\n/g, "\n") });
    }
    return { samples: nextSamples, hidden: nextHidden };
  } finally {
    runner.dispose();
  }
}
