import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";

// A refresh can retain the same object's snapshot. A changed URL or classroom must
// immediately invalidate the old result, even before the new effect starts.
export function useGraphData<T>(url: string | null, revision: number, poll = 0) {
  const [result, setResult] = useState<{ url: string; data?: T; error?: string }>();
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let timer: number;
    async function load(path: string) {
      try {
        const data = await api.get<T>(path, controller.signal);
        if (!controller.signal.aborted) setResult({ url: path, data });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ url: path, error: errorMessage(error) });
      } finally {
        if (poll && !controller.signal.aborted) timer = window.setTimeout(() => void load(path), poll);
      }
    }
    void load(url);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [url, revision, poll]);
  return result?.url === url ? result : undefined;
}
