import {
  narrationApi,
  type CalibrationReport,
  type NarrationAudioStatus,
  type NarrationJobState,
  type NarrationList,
  type NarrationPage,
  type NarrationQuota,
} from "@/features/materials/narration/api";
import { errorMessage } from "@/lib/api";
import { useCallback, useEffect, useState } from "react";

export function useNarrationReview(classroomId: number, materialId: number, initialPage?: number) {
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
  const [message, setMessage] = useState("");
  const [job, setJob] = useState<NarrationJobState | null>(null);
  const load = useCallback(async () => {
    setBusy("load");
    setError("");
    try {
      const [list, limits, sound] = await Promise.all([
        narrationApi.list(classroomId, materialId),
        narrationApi.quota(classroomId, materialId),
        narrationApi.audioStatus(classroomId, materialId),
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
  }, [classroomId, materialId, initialPage]);
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
        const state = await narrationApi.job(classroomId, materialId);
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
  }, [classroomId, materialId]);

  useEffect(() => {
    let active = true;
    // 展示上一次的（可能未完成的）报告：中断的运行也能看到跑到第几窗。
    narrationApi
      .calibration(classroomId, materialId, true)
      .then((value) => {
        if (active) setReport(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [classroomId, materialId]);
  async function run(
    label: string,
    action: () => Promise<unknown>,
    done: string,
  ) {
    setBusy(label);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(done);
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
    setMessage("已提交一键梳理，后台会依次完成整理、校准与讲解稿");
    try {
      await narrationApi.pipeline(classroomId, materialId);
      const state = await waitForJob();
      const next = await narrationApi
        .calibration(classroomId, materialId, true)
        .catch(() => null);
      if (next) setReport(next);
      setMessage(
        state.status === "done"
          ? "梳理、校准、讲解稿已完成，校准修正已自动应用"
          : `一键梳理结束于「${state.status}」：${state.message || "请检查失败页"}`,
      );
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
      setMessage("已完成的阶段已保存，可直接重试（不会重复计费）");
    } finally {
      setBusy("");
      await load().catch(() => {});
    }
  }
  async function waitForJob(): Promise<NarrationJobState> {
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      const state = await narrationApi.job(classroomId, materialId);
      setJob(state);
      if (!state.running && !state.queued) return state;
      if (state.message) setMessage(`正在后台处理：${state.message}`);
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
      setMessage("没有待审的草稿");
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
      () => narrationApi.acceptBatch(classroomId, materialId),
      `已接受 ${drafts} 页`,
    );
  }
  async function synthesizeAllAudio() {
    if (!data) return;
    const accepted = data.pages.filter(
      (item) => item.narration?.status === "accepted",
    ).length;
    if (!accepted) {
      setMessage("还没有已接受的页，先接受再合成音频");
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
    setMessage("已提交全文配音生成，后台继续执行，可以切去别的资料");
    try {
      await narrationApi.audioBatch(classroomId, materialId, 1, total);
      const state = await waitForJob();
      setMessage(
        state.status === "done"
          ? `全文配音已生成（${state.done}/${state.total} 页）`
          : `配音生成结束于「${state.status}」：${state.message || "请检查失败页"}`,
      );
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
      setMessage("已生成的配音已保存，可直接重试");
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
    message,
    setMessage,
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
