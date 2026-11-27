/** Fresh opaque-origin workers: no app token, cookies, storage, network or previous code. */
export interface PythonResult { stdout: string; stderr: string }
interface RuntimeBundle {
  pyodideJs: string;
  asmJs: string;
  lockJson: ArrayBuffer;
  stdlibZip: ArrayBuffer;
  wasm: ArrayBuffer;
}
const runtimePath = '/python-runtime/0.27.7/';
const virtualIndex = 'https://pyodide.local/';
let bundlePromise: Promise<RuntimeBundle> | undefined;
let idleRuntimeCount = 0;

function fetchRuntimeText(base: string, name: string): Promise<string> {
  return fetch(new URL(name, base)).then(res => {
    if (!res.ok) throw new Error('Python运行环境加载失败');
    return res.text();
  });
}

function fetchRuntimeBuffer(base: string, name: string): Promise<ArrayBuffer> {
  return fetch(new URL(name, base)).then(res => {
    if (!res.ok) throw new Error('Python运行环境加载失败');
    return res.arrayBuffer();
  });
}

function loadRuntimeBundle(): Promise<RuntimeBundle> {
  if (!bundlePromise) {
    const base = new URL(runtimePath, location.origin).href;
    bundlePromise = Promise.all([
      fetchRuntimeText(base, 'pyodide.js'),
      fetchRuntimeText(base, 'pyodide.asm.js'),
      fetchRuntimeBuffer(base, 'pyodide-lock.json'),
      fetchRuntimeBuffer(base, 'python_stdlib.zip'),
      fetchRuntimeBuffer(base, 'pyodide.asm.wasm'),
    ]).then(([pyodideJs, asmJs, lockJson, stdlibZip, wasm]) => ({
      pyodideJs, asmJs, lockJson, stdlibZip, wasm,
    })).catch(() => {
      bundlePromise = undefined;
      throw new Error('Python运行环境加载失败');
    });
  }
  return bundlePromise;
}

const workerMain = `
  onmessage = async ({ data: init }) => {
    onmessage = null;
    const nativeFetch = self.fetch.bind(self);
    const assets = new Map([
      ['${virtualIndex}pyodide-lock.json', [init.lockJson, 'application/json']],
      ['${virtualIndex}python_stdlib.zip', [init.stdlibZip, 'application/zip']],
      ['${virtualIndex}pyodide.asm.wasm', [init.wasm, 'application/wasm']],
    ]);
    self.fetch = async (input) => {
      const key = String(input);
      const hit = assets.get(key);
      if (!hit) throw new TypeError('Failed to fetch');
      assets.delete(key);
      return new Response(hit[0], { status: 200, headers: { 'Content-Type': hit[1] } });
    };
    try {
      let py;
      try {
        py = await loadPyodide({ indexURL: '${virtualIndex}' });
      } finally {
        assets.clear();
        self.fetch = nativeFetch;
      }
      onmessage = ({ data }) => {
        // This worker executes exactly one sample and is then destroyed.
        onmessage = null;
        let stdout = '', stderr = '';
        const outDecoder = new TextDecoder(), errDecoder = new TextDecoder();
        const append = (old, value) => {
          if (old.length + value.length > 16000) throw Error('输出超过16000字符');
          return old + value;
        };
        py.setStdout({ write: bytes => { stdout = append(stdout, outDecoder.decode(bytes, { stream: true })); return bytes.length; } });
        py.setStderr({ write: bytes => { stderr = append(stderr, errDecoder.decode(bytes, { stream: true })); return bytes.length; } });
        py.globals.set('_exercise_input', data.input);
        py.runPython('import sys, io\\nsys.stdin = io.StringIO(_exercise_input)');
        try { py.runPython(data.code); } catch (e) { stderr = String(e).slice(0, 16000); }
        try { py.runPython('import sys; sys.stdout.flush(); sys.stderr.flush()'); } catch (e) { stderr = String(e).slice(0, 16000); }
        postMessage({ stdout, stderr });
        close();
      };
      postMessage({ ready: true });
    } catch (e) {
      postMessage({ error: String(e).slice(0, 2000) });
    }
  };`;

function createContext() {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('credentialless', '');
  frame.referrerPolicy = 'no-referrer';
  let bootResolve!: () => void;
  const booted = new Promise<void>(resolve => { bootResolve = resolve; });
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Prewarming can fail before the user presses Run; surface or evict cleanly.
  void ready.catch(() => {});
  let disposed = false, used = false, failed = false;
  let finish: ((result: PythonResult) => void) | undefined;
  let rejectRun: ((error: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    window.removeEventListener('message', receive);
    frame.contentWindow?.postMessage({ dispose: true }, '*');
    frame.remove();
    readyReject(new Error('已停止运行'));
    rejectRun?.(new Error('已停止运行'));
  };
  const fail = (message: string) => {
    failed = true;
    const error = new Error(message);
    readyReject(error); rejectRun?.(error); dispose();
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || disposed) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.boot) bootResolve();
    else if (data.ready && !used) { clearTimeout(timer); readyResolve(); }
    else if (typeof data.error === 'string') fail(data.error.slice(0, 2000));
    else if (used && typeof data.stdout === 'string' && typeof data.stderr === 'string') {
      finish?.({ stdout: data.stdout.slice(0, 16000), stderr: data.stderr.slice(0, 16000) });
      dispose();
    }
  };
  // Sandbox has zero network access (connect-src 'none'); runtime bytes arrive from parent memory.
  frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'"><script>
    let worker;
    onmessage = e => {
      if (e.source !== parent || !e.data) return;
      if (e.data.dispose) { worker?.terminate(); return; }
      if (e.data.init && !worker) {
        const { pyodideJs, asmJs, lockJson, stdlibZip, wasm } = e.data.init;
        const url = URL.createObjectURL(new Blob([pyodideJs, '\\n;\\n', asmJs, '\\n;\\n', ${JSON.stringify(workerMain).replace(/<\//g, '<\\/')}], { type: 'text/javascript' }));
        worker = new Worker(url); URL.revokeObjectURL(url);
        worker.onmessage = m => parent.postMessage(m.data, '*');
        worker.onerror = () => parent.postMessage({ error: 'Python运行环境加载失败' }, '*');
        worker.postMessage({ lockJson, stdlibZip, wasm }, [lockJson, stdlibZip, wasm]);
        return;
      }
      worker?.postMessage(e.data);
    };
    parent.postMessage({ boot: true }, '*');
  </script>`;
  window.addEventListener('message', receive);
  timer = setTimeout(() => fail('Python环境加载超时，请重试'), 60000);
  document.body.append(frame);
  void Promise.all([loadRuntimeBundle(), booted]).then(([bundle]) => {
    if (!disposed) frame.contentWindow?.postMessage({ init: bundle }, '*');
  }, error => {
    if (!disposed) fail(error instanceof Error ? error.message : 'Python运行环境加载失败');
  });
  return {
    ready, dispose,
    isFailed: () => failed,
    async run(code: string, input: string, signal: AbortSignal): Promise<PythonResult> {
      const abort = () => fail('已停止运行');
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) { abort(); throw new Error('已停止运行'); }
        await ready;
        if (disposed || signal.aborted || used) throw new Error('已停止运行');
        used = true;
        return await new Promise<PythonResult>((resolve, reject) => {
          finish = resolve; rejectRun = reject;
          timer = setTimeout(() => fail('运行超过5秒，已停止'), 5000);
          frame.contentWindow?.postMessage({ code, input }, '*');
        });
      } finally { signal.removeEventListener('abort', abort); dispose(); }
    },
  };
}

/** Per-workspace pool, bounded to two idle runtimes; never reuse executed Python. */
export function createPythonRunner(sampleCount = 2) {
  const size = Math.max(0, Math.min(2, sampleCount));
  const idle: ReturnType<typeof createContext>[] = [];
  const active = new Set<ReturnType<typeof createContext>>();
  let disposed = false;
  const prewarm = () => {
    // A full assessment may mount many questions. Bound all idle runtimes together.
    while (!disposed && idle.length < size && idleRuntimeCount < 2) {
      const context = createContext();
      idle.push(context);
      idleRuntimeCount++;
      void context.ready.catch(() => {
        const index = idle.indexOf(context);
        if (index !== -1) { idle.splice(index, 1); idleRuntimeCount--; }
      });
    }
  };
  prewarm();
  return {
    ready: () => Promise.all(idle.map(context => context.ready)),
    async run(code: string, input: string, signal: AbortSignal) {
      if (disposed || signal.aborted) throw new Error('已停止运行');
      let warmed = idle.shift();
      if (warmed) idleRuntimeCount--;
      while (warmed?.isFailed()) {
        warmed = idle.shift();
        if (warmed) idleRuntimeCount--;
      }
      const context = warmed ?? createContext();
      active.add(context);
      try { return await context.run(code, input, signal); }
      finally { active.delete(context); prewarm(); }
    },
    dispose() { disposed = true; idleRuntimeCount -= idle.length; idle.splice(0).forEach(context => context.dispose()); active.forEach(context => context.dispose()); active.clear(); },
  };
}

export function runPython(code: string, input: string, signal: AbortSignal): Promise<PythonResult> {
  if (signal.aborted) return Promise.reject(new Error('已停止运行'));
  return createContext().run(code, input, signal);
}
export function sameOutput(actual: string, expected: string): boolean {
  return actual.replace(/\r\n/g, '\n').trimEnd() === expected.replace(/\r\n/g, '\n').trimEnd();
}
