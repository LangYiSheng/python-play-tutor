import frameHtml from './interactivePracticeFrame.html?raw';
import palette from './gamePalette.css?raw';
import { isInteractiveValue, type InteractiveResult, type InteractiveSource, type JsonValue } from './interactiveValues';
export { equalInteractiveValues, isInteractiveValue } from './interactiveValues';
export type { InteractiveSource, InteractiveResult, JsonValue } from './interactiveValues';
const frameTemplate = frameHtml.replace('/* SHARED_GAME_PALETTE */', palette);

interface FrameOptions {
  initialDraft?: JsonValue;
  onDraft?(value: JsonValue): void;
  onReady?(): void;
  onError?(message: string): void;
}

/** Own the opaque-origin iframe and a private message port for exactly one question mount. */
export function mountInteractivePractice(frame: HTMLIFrameElement, source: InteractiveSource, options: FrameOptions = {}) {
  const instance = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('');
  let port: MessagePort | undefined;
  let ready = false, closed = false, sequence = 0;
  let pending: {request: number; resolve(result: InteractiveResult): void; reject(error: Error): void} | undefined;
  let stateRead: {request: number; timer: number; resolve(value: JsonValue): void; reject(error: Error): void} | undefined;
  let timer = window.setTimeout(() => fail('题目加载超时，请重新加载'), 8000);

  function close(message: string) {
    window.clearTimeout(timer);
    window.removeEventListener('message', boot);
    closed = true;
    ready = false;
    port?.close();
    pending?.reject(new Error(message));
    pending = undefined;
    window.clearTimeout(stateRead?.timer);
    stateRead?.reject(new Error(message));
    stateRead = undefined;
    frame.removeAttribute('srcdoc');
  }
  function fail(message: string) {
    if (closed) return;
    close(message);
    options.onError?.(message);
  }
  function boot(event: MessageEvent) {
    if (event.source !== frame.contentWindow || event.origin !== 'null'
      || event.data?.type !== 'interactive-practice-boot' || event.data.instance !== instance) return;
    window.removeEventListener('message', boot);
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessageerror = () => fail('题目返回了无法读取的数据');
    port.onmessage = ({data}) => {
      if (closed || !data) return;
      switch (data.type) {
        case 'ready':
          if (!ready) {
            window.clearTimeout(timer);
            ready = true;
            options.onReady?.();
          }
          break;
        case 'height':
          if (Number.isFinite(data.height)) frame.style.height = Math.min(2000, Math.max(44, data.height)) + 'px';
          break;
        case 'draft':
          if (!isInteractiveValue(data.value)) return fail('草稿须为有效 JSON，最多 16 KiB、16 层嵌套');
          options.onDraft?.(data.value);
          break;
        case 'state':
          if (!stateRead || data.request !== stateRead.request) return;
          window.clearTimeout(stateRead.timer);
          if (typeof data.error === 'string') stateRead.reject(new Error(data.error));
          else if (!isInteractiveValue(data.value)) stateRead.reject(new Error('助教状态须为有效 JSON，最多 16 KiB、16 层嵌套'));
          else stateRead.resolve(data.value);
          stateRead = undefined;
          break;
        case 'result':
          if (!pending || data.request !== pending.request) return;
          if (typeof data.correct !== 'boolean' || typeof data.message !== 'string'
            || Array.from(data.message).length > 1000 || !isInteractiveValue(data.value)) {
            return fail('判定结果格式无效，请检查提交值和反馈文字');
          }
          window.clearTimeout(timer);
          pending.resolve({correct: data.correct, message: data.message, value: data.value});
          pending = undefined;
          break;
        case 'fault':
          fail(typeof data.message === 'string' ? data.message.slice(0, 500) : '题目脚本运行失败');
          break;
      }
    };
    const draft = options.initialDraft ?? null;
    if (!isInteractiveValue(draft)) return fail('保存的草稿格式无效');
    // Only these authored fields cross the boundary. Reactive proxies aren't transferable.
    frame.contentWindow!.postMessage({instance, source: {html: source.html, css: source.css, js: source.js},
      initialDraft: JSON.parse(JSON.stringify(draft)), fontSize: getComputedStyle(document.documentElement).fontSize}, '*', [channel.port2]);
  }
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('credentialless', '');
  window.addEventListener('message', boot);
  frame.srcdoc = frameTemplate.replace('__PRACTICE_INSTANCE__', instance);
  return {
    getState(): Promise<JsonValue> {
      if (closed || !ready || !port) return Promise.reject(new Error('题目尚未就绪'));
      if (stateRead) return Promise.reject(new Error('正在读取题目状态'));
      const request = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          stateRead = undefined;
          reject(new Error('读取题目状态超时'));
        }, 1500);
        stateRead = {request, timer, resolve, reject};
        port!.postMessage({type: 'getState', request});
      });
    },
    check(): Promise<InteractiveResult> {
      if (closed || !ready || !port) return Promise.reject(new Error('题目尚未就绪'));
      if (pending) return Promise.reject(new Error('正在判定，请稍候'));
      const request = ++sequence;
      return new Promise((resolve, reject) => {
        pending = {request, resolve, reject};
        timer = window.setTimeout(() => fail('题目判定超时，请重新加载'), 5000);
        port!.postMessage({type: 'check', request});
      });
    },
    dispose() {
      if (closed) return;
      close('已退出本题');
    }
  };
}
