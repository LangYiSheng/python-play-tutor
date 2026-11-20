import { errorMessage } from "@/lib/api";
import {
  equalInteractiveValues, mountInteractivePractice, type InteractiveSource, type JsonValue,
} from "../../../../shared/interactivePractice";

/** Run submission checks from the initial student view without changing the teacher's preview. */
export async function validateInteractiveSource(source: InteractiveSource, target: JsonValue, signal: AbortSignal) {
  signal.throwIfAborted();
  const frame = document.createElement("iframe");
  frame.title = "交互题保存校验";
  frame.tabIndex = -1;
  frame.inert = true;
  frame.setAttribute("aria-hidden", "true");
  frame.className = "interactive-validation-frame";
  document.body.append(frame);

  let session: ReturnType<typeof mountInteractivePractice> | undefined;
  let rejectReady: (reason: unknown) => void = () => {};
  const cancel = () => { rejectReady(signal.reason); session?.dispose(); };
  signal.addEventListener("abort", cancel, { once: true });
  let stage = "加载题目";
  try {
    await new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      session = mountInteractivePractice(frame, source, {
        onReady: resolve, onError: message => reject(new Error(message)),
      });
    });
    signal.throwIfAborted();
    stage = "读取助教初始状态（onGetState）";
    await session!.getState();
    stage = "检查初始作答（onCheck）";
    const result = await session!.check();
    if (target !== null && equalInteractiveValues(result.value, target) !== result.correct) {
      throw new Error("脚本判定与私有正确提交值不一致。");
    }
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(`${stage}失败：${errorMessage(error)}`, { cause: error });
  } finally {
    signal.removeEventListener("abort", cancel);
    session?.dispose();
    frame.remove();
  }
}
