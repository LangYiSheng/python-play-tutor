import { mediaCache } from "./mediaCache";
import { pdfCache } from "./pdfCache";

const SWEEP_MS = 60_000;
const HIDDEN_CLEAR_MS = 30 * 60_000;

/** Periodically drops expired or over-budget entries without touching pinned media. */
export function startMediaMaintenance() {
  const sweep = window.setInterval(() => {
    mediaCache.prune();
    pdfCache.prune();
  }, SWEEP_MS);
  let hiddenTimer: number | undefined;
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      if (hiddenTimer !== undefined) window.clearTimeout(hiddenTimer);
      hiddenTimer = window.setTimeout(() => {
        mediaCache.clearUnpinned();
        pdfCache.clearUnpinned();
      }, HIDDEN_CLEAR_MS);
    } else if (hiddenTimer !== undefined) {
      window.clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.clearInterval(sweep);
    if (hiddenTimer !== undefined) window.clearTimeout(hiddenTimer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
