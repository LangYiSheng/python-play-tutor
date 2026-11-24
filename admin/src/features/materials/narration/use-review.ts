import {
  narrationApi,
  type CalibrationReport,
  type NarrationAudioStatus,
  type NarrationJobState,
  type NarrationList,
  type NarrationPage,
  type NarrationQuota,
} from "@/features/materials/narration/api";
import { toast } from "@/components/ui/toast";
import { errorMessage, token } from "@/lib/api";
import { useCallback, useEffect, useState } from "react";

export function useNarrationReview(courseId: number, materialId: number, initialPage?: number) {
  const [data, setData] = useState<NarrationList | null>(null);
  const [quota, setQuota] = useState<NarrationQuota | null>(null);
  const [report, setReport] = useState<CalibrationReport | null>(null);
  const [audioState, setAudioState] = useState<NarrationAudioStatus | null>(
    null,
  );
  const [pageNo, setPageNo] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [job, setJob] = useState<NarrationJobState | null>(null);
  const load = useCallback(async () => {
    setBusy("load");
    setError("");
    try {
      const [list, limits, sound] = await Promise.all([
        narrationApi.list(courseId, materialId),
        narrationApi.quota(courseId, materialId),
        narrationApi.audioStatus(courseId, materialId),
      ]);
      setData(list);
      setQuota(limits);
      setAudioState(sound);
      setPageNo(current => list.pages.find(page => page.page_no === (current ?? initialPage))?.page_no ?? list.pages[0]?.page_no ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }, [courseId, materialId, initialPage]);
  useEffect(() => {
    void load();
  }, [load]);
  const page: NarrationPage | undefined = data?.pages.find(
    (item) => item.page_no === pageNo,
  );
  const saved = page?.narration?.text ?? "";
  const dirty = pageNo !== null && draft !== saved;
  useEffect(() => {
    setDraft(saved);
  }, [pageNo, saved]);
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const state = await narrationApi.job(courseId, materialId);
        if (!stopped) setJob(state);
      } catch {
        // 状态查询失败不影响审校本身
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [courseId, materialId]);

  useEffect(() => {
    let active = true;
    // 展示上一次的（可能未完成的）报告：中断的运行也能看到跑到第几窗。
    narrationApi
      .calibration(courseId, materialId, true)
      .then((value) => {
        if (active) setReport(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [courseId, materialId]);
  async function run(
    label: string,
    action: () => Promise<unknown>,
    done: string,
  ) {
    setBusy(label);
    setError("");
    const captured = token();
    try {
      await action();
      if (captured === token()) toast.add({ title: done, type: "success" });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  async function runPipeline() {
    if (!data) return;
    setBusy("pipeline");
    setError("");
    const captured = token();
    try {
      await narrationApi.pipeline(courseId, materialId);
      if (captured === token()) toast.add({ title: "已提交一键梳理", type: "info" });
      const state = await waitForJob();
      const next = await narrationApi
        .calibration(courseId, materialId, true)
        .catch(() => null);
      if (next) setReport(next);
      if (captured === token()) {
        toast.add(state.status === "done"
          ? { title: "梳理、校准与讲解稿已完成", description: "校准修正已自动应用。", type: "success" }
          : { title: "一键梳理未完成", description: state.message, type: "warning" });
      }
      if (state.failed?.length) {
        setError(
          state.failed
            .map((item) => `第 ${item.page_no} 页：${item.error ?? "未知错误"}`)
            .slice(0, 5)
            .join("；"),
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
      await load().catch(() => {});
    }
  }
  async function waitForJob(): Promise<NarrationJobState> {
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      const state = await narrationApi.job(courseId, materialId);
      setJob(state);
      if (!state.running && !state.queued) return state;
      if (Date.now() > deadline)
        throw new Error("任务仍在后台运行，可稍后刷新查看");
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
    }
  }
  async function acceptAllDrafts() {
    if (!data) return;
    const drafts = data.pages.filter(
      (item) => item.narration?.status === "draft",
    ).length;
    if (!drafts) {
      toast.add({ title: "没有待审的草稿", type: "info" });
      return;
    }
    if (
      !window.confirm(
        `一次接受全部 ${drafts} 页待审草稿？之后仍可在右侧单独驳回。`,
      )
    )
      return;
    await run(
      "accept-all",
      () => narrationApi.acceptBatch(courseId, materialId),
      `已接受 ${drafts} 页`,
    );
  }
  async function synthesizeAllAudio() {
    if (!data) return;
    const accepted = data.pages.filter(
      (item) => item.narration?.status === "accepted",
    ).length;
    if (!accepted) {
      toast.add({ title: "还没有已接受的页", description: "请先接受讲解稿，再合成配音。", type: "info" });
      return;
    }
    if (
      !window.confirm(
        `为 ${accepted} 页已接受的讲解生成全文配音？已生成的页会复用，不重复计费。`,
      )
    )
      return;
    const total = data.coverage.pages;
    setBusy("audio-all");
    setError("");
    const captured = token();
    try {
      await narrationApi.audioBatch(courseId, materialId, 1, total);
      if (captured === token()) toast.add({ title: "已提交全文配音生成", type: "info" });
      const state = await waitForJob();
      if (captured === token()) {
        toast.add(state.status === "done"
          ? { title: `全文配音已生成（${state.done}/${state.total} 页）`, type: "success" }
          : { title: "全文配音未完成", description: state.message, type: "warning" });
      }
      if (state.failed?.length) {
        setError(
          state.failed
            .map((item) => `第 ${item.page_no} 页：${item.error ?? "未知错误"}`)
            .slice(0, 5)
            .join("；"),
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
      await load().catch(() => {});
    }
  }
  const running = Boolean(job?.running);
  const busyNow = Boolean(busy) || running;
  const audioPage = audioState?.pages.find((item) => item.page_no === pageNo);
  const navigation = () => {
    const pages = data?.pages ?? [];
    const index = pages.findIndex((item) => item.page_no === pageNo);
    return {
      previous: index > 0 ? pages[index - 1].page_no : null,
      next:
        index >= 0 && index < pages.length - 1
          ? pages[index + 1].page_no
          : null,
    };
  };
  const { previous, next } = navigation();
  return {
    data,
    setData,
    quota,
    setQuota,
    report,
    setReport,
    audioState,
    setAudioState,
    pageNo,
    setPageNo,
    draft,
    setDraft,
    busy,
    setBusy,
    error,
    setError,
    job,
    setJob,
    load,
    page,
    saved,
    dirty,
    run,
    runPipeline,
    acceptAllDrafts,
    synthesizeAllAudio,
    running,
    busyNow,
    audioPage,
    navigation,
    previous,
    next,
  };
}
