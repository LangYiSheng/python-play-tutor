import type { Question } from '../../shared/types';
import { runPython } from './pythonRunner';

export type RunPythonSample = typeof runPython;
export interface BrowserCase { input: string; output: string; stdout: string; stderr: string }

/** Every explicit submission executes fresh public samples; Run never saves progress. */
export async function evaluateBrowserSubmission(code: string, samples: Question['samples'], signal: AbortSignal, runSample: RunPythonSample = runPython): Promise<BrowserCase[]> {
  if (!samples.length || samples.length > 20) throw new Error('此题尚未配置有效的公开样例，请联系教师');
  const results: BrowserCase[] = [];
  for (const sample of samples) {
    const result = await runSample(code, sample.input, signal);
    if (signal.aborted) throw new Error('已停止运行');
    results.push({ input: sample.input, output: sample.output, ...result });
  }
  return results;
}
