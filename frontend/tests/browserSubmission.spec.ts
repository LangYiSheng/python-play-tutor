import { afterEach, expect, it, vi } from 'vitest';
import { evaluateBrowserSubmission } from '../src/features/practice/browserSubmission';

const run = vi.hoisted(() => vi.fn());
vi.mock('../src/features/practice/pythonRunner', () => ({ runPython: run }));
afterEach(() => vi.resetAllMocks());

it('uses the supplied warmed runner for every case', async () => {
  const warmRun = vi.fn().mockResolvedValue({stdout:'ok',stderr:''});
  const samples = [{input:'1',output:'ok'}, {input:'2',output:'ok'}];
  const signal = new AbortController().signal;
  await evaluateBrowserSubmission('print("ok")', samples, signal, warmRun);
  expect(warmRun.mock.calls).toEqual(samples.map(sample => ['print("ok")', sample.input, signal]));
  expect(run).not.toHaveBeenCalled();
});

it('runs each public sample again for every submission and preserves stdout and errors', async () => {
  run.mockResolvedValueOnce({stdout:'one\n',stderr:''}).mockResolvedValueOnce({stdout:'',stderr:'ValueError'});
  const samples = [{input:'1',output:'one'}, {input:'2',output:'two'}];
  const result = await evaluateBrowserSubmission('print(input())', samples, new AbortController().signal);
  expect(run.mock.calls.map(call => call.slice(0, 2))).toEqual([['print(input())', '1'], ['print(input())', '2']]);
  expect(result).toEqual([{...samples[0],stdout:'one\n',stderr:''},{...samples[1],stdout:'',stderr:'ValueError'}]);
  run.mockResolvedValue({stdout:'new',stderr:''});
  await evaluateBrowserSubmission('print("new")', samples, new AbortController().signal);
  expect(run).toHaveBeenCalledTimes(4);
});

it('does not produce a receipt for missing samples, interrupted or failed execution', async () => {
  await expect(evaluateBrowserSubmission('pass', [], new AbortController().signal)).rejects.toThrow('公开样例');
  const controller = new AbortController();
  run.mockImplementation(async () => { controller.abort(); return {stdout:'ok',stderr:''}; });
  await expect(evaluateBrowserSubmission('pass', [{input:'',output:'ok'}], controller.signal)).rejects.toThrow('已停止');
  run.mockRejectedValue(new Error('运行超过5秒，已停止'));
  await expect(evaluateBrowserSubmission('while True: pass', [{input:'',output:'ok'}], new AbortController().signal)).rejects.toThrow('超过5秒');
});
