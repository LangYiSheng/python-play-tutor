import { afterEach, describe, expect, it, vi } from "vitest";
import { sameOutput } from "../src/features/practice/pythonRunner";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.querySelectorAll("iframe").forEach(frame => frame.remove());
});

describe("public sample execution", () => {
  it("normalizes terminal newline without hiding incorrect internal whitespace", () => {
    expect(sameOutput("hello\r\n", "hello")).toBe(true);
    expect(sameOutput(" hello", "hello")).toBe(false);
    expect(sameOutput("a  b", "a b")).toBe(false);
  });

  it("cancels before creating an execution context", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.resetModules();
    const { runPython } = await import("../src/features/practice/pythonRunner");
    const controller = new AbortController();
    controller.abort();
    await expect(runPython("while True: pass", "", controller.signal)).rejects.toThrow("已停止");
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches the Pyodide runtime bundle once and reuses it across contexts", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(".js")) return new Response("/* stub */", { status: 200 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    vi.resetModules();
    const { createPythonRunner } = await import("../src/features/practice/pythonRunner");
    const runner = createPythonRunner(2);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    runner.dispose();
    const nextRunner = createPythonRunner(2);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    nextRunner.dispose();
  });

  it("evicts failed prewarmed contexts and retries bundle download cleanly", async () => {
    let shouldFail = true;
    const fetchSpy = vi.fn(async () => {
      if (shouldFail) return new Response("unavailable", { status: 503 });
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    vi.resetModules();
    const { createPythonRunner } = await import("../src/features/practice/pythonRunner");
    const runner = createPythonRunner(2);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(document.querySelectorAll("iframe")).toHaveLength(0);

    shouldFail = false;
    const callsBeforeRetry = fetchSpy.mock.calls.length;
    const controller = new AbortController();
    const pending = runner.run("print(1)", "", controller.signal);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetchSpy.mock.calls.length).toBe(callsBeforeRetry + 5);
    controller.abort();
    await expect(pending).rejects.toThrow("已停止");
    runner.dispose();
  });
});
