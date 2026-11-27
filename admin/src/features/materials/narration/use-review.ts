import {
  narrationApi,
  type CalibrationReport,
  type MaterialVoiceMode,
  type NarrationAudioStatus,
  type NarrationJobState,
  type NarrationList,
  type NarrationPage,
  type NarrationQuota,
  type ScriptStyleOptions,
  type ScriptStylePreset,
} from "@/features/materials/narration/api";
import { toast } from "@/components/ui/toast";
import { errorMessage, token } from "@/lib/api";
import { voiceApi, type TeacherVoice } from "@/lib/voice-api";
import { useCallback, useEffect, useRef, useState } from "react";

export function useNarrationReview(
  courseId: number,
  materialId: number,
  initialPage?: number,
  jumpTarget?: { pageNo: number; seq: number } | null,
  onKnowledgeUpdated?: () => void,
) {
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
  const [stylePreset, setStylePreset] = useState<ScriptStylePreset>("natural");
  const [customStyle, setCustomStyle] = useState("");
  const [usePacing, setUsePacing] = useState(false);
  const [sectionMinutes, setSectionMinutes] = useState(10);
  const [chapterMinutes, setChapterMinutes] = useState(90);
  const [myVoices, setMyVoices] = useState<TeacherVoice[]>([]);
  const [speechStyleDirty, setSpeechStyleDirty] = useState(false);

  const reloadVoices = useCallback(async () => {
    try {
      const res = await voiceApi.list();
      if (mountedRef.current && Array.isArray(res?.voices)) {
        setMyVoices(res.voices);
      }
    } catch {
      // Optional personal voice catalog: silently fall back to global voice when unavailable.
    }
  }, []);

  function scriptOptions(): ScriptStyleOptions | undefined {
    const custom = customStyle.trim();
    if (stylePreset === "natural" && !custom && !usePacing) return undefined;
    return {
      style_preset: stylePreset,
      ...(custom ? { custom_style: custom } : {}),
      ...(usePacing ? { use_pacing: true, section_minutes: sectionMinutes, chapter_minutes: chapterMinutes } : {}),
    };
  }
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
    void reloadVoices();
  }, [load, reloadVoices]);
  useEffect(() => {
    if (!jumpTarget || !data) return;
    if (data.pages.some((item) => item.page_no === jumpTarget.pageNo)) {
      setPageNo(jumpTarget.pageNo);
    }
  }, [jumpTarget, data]);
  const page: NarrationPage | undefined = data?.pages.find(
    (item) => item.page_no === pageNo,
  );
  const saved = page?.narration?.text ?? "";
  const dirty = pageNo !== null && draft !== saved;
  useEffect(() => {
    setDraft(saved);
  }, [pageNo, saved]);
  const lastProgressKey = useRef("");
  const mountedRef = useRef(true);
  const onKnowledgeUpdatedRef = useRef(onKnowledgeUpdated);
  onKnowledgeUpdatedRef.current = onKnowledgeUpdated;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, [courseId, materialId]);

  const silentRefresh = useCallback(async () => {
    try {
      const [list, limits, sound] = await Promise.all([
        narrationApi.list(courseId, materialId),
        narrationApi.quota(courseId, materialId),
        narrationApi.audioStatus(courseId, materialId),
      ]);
      if (!mountedRef.current) return;
      setData(list);
      setQuota(limits);
      setAudioState(sound);
    } catch {
      // 后台增量刷新失败不影响审校与轮询
    }
  }, [courseId, materialId]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    lastProgressKey.current = "";
    const tick = async () => {
      try {
        const state = await narrationApi.job(courseId, materialId);
        if (stopped) return;
        setJob(state);
        const key = `${state.id ?? ""}:${state.stage ?? ""}:${state.done}:${state.status}`;
        if (lastProgressKey.current && key !== lastProgressKey.current && (state.running || state.status === "done")) {
          void silentRefresh();
          if (state.kind === "pipeline" && state.status === "done") {
            onKnowledgeUpdatedRef.current?.();
          }
        }
        lastProgressKey.current = key;
        if (state.running || state.queued) {
          timer = window.setTimeout(() => void tick(), 2000);
        }
      } catch {
        // 状态查询失败不影响审校本身
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [courseId, materialId, silentRefresh]);

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
      await narrationApi.pipeline(courseId, materialId, scriptOptions());
      if (captured === token()) toast.add({ title: "已提交一键梳理", type: "info" });
      const state = await waitForJob();
      const next = await narrationApi
        .calibration(courseId, materialId, true)
        .catch(() => null);
      if (next) setReport(next);
      if (captured === token()) {
        toast.add(state.status === "done"
          ? { title: "梳理、校准、讲解稿与知识点已完成", description: "校准修正与章节知识点已自动更新。", type: "success" }
          : { title: "一键梳理未完成", description: state.message, type: "warning" });
      }
      if (state.status === "done") {
        onKnowledgeUpdatedRef.current?.();
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
      if (!mountedRef.current) {
        return {
          id: null,
          material_id: materialId,
          kind: "",
          running: false,
          queued: false,
          status: "running",
          done: 0,
          total: 0,
          message: "",
          failed: [],
          started_at: null,
        };
      }
      const state = await narrationApi.job(courseId, materialId);
      if (!mountedRef.current) return state;
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
  async function selectMaterialVoice(
    mode: MaterialVoiceMode,
    teacherVoiceId?: number | null,
    options?: { speechInstruction?: string | null; speechSpeed?: number | null; note?: string },
  ) {
    setBusy("voice");
    setError("");
    try {
      const sound = await narrationApi.setVoice(courseId, materialId, mode, teacherVoiceId, options);
      setAudioState(sound);
      const changedStyle = Boolean(options && ("speechInstruction" in options || "speechSpeed" in options));
      const hasReady = sound.pages.some((p) => p.ready);
      if (changedStyle && hasReady) setSpeechStyleDirty(true);
      const label = sound.voice_name || sound.voice;
      toast.add({
        title: options?.note ?? `已切换本课件配音音色为「${label}」`,
        description:
          sound.mismatched_count && sound.mismatched_count > 0
            ? `有 ${sound.mismatched_count} 页为旧音色，点「生成全文配音」可批量按新音色重配。`
            : changedStyle && hasReady
              ? "已生效于后续合成；点「生成全文配音」或单页「重新合成」可按新风格重配。"
              : undefined,
        type: "success",
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  async function synthesizeAllAudio(options?: { regenerateMismatch?: boolean; force?: boolean; skipConfirm?: boolean }) {
    if (!data) return;
    const accepted = data.pages.filter(
      (item) => item.narration?.status === "accepted",
    ).length;
    if (!accepted) {
      toast.add({ title: "还没有已接受的页", description: "请先接受讲解稿，再合成配音。", type: "info" });
      return;
    }
    const regenerateMismatch = Boolean(options?.regenerateMismatch);
    const force = Boolean(options?.force);
    if (!options?.skipConfirm) {
      if (
        !window.confirm(
          force || regenerateMismatch
            ? `用当前音色与朗读风格重新合成 ${accepted} 页已接受的讲解？`
            : `为 ${accepted} 页已接受的讲解生成全文配音？已生成的页会复用，不重复计费。`,
        )
      )
        return;
    }
    const total = data.coverage.pages;
    setBusy("audio-all");
    setError("");
    const captured = token();
    try {
      await narrationApi.audioBatch(courseId, materialId, 1, total, regenerateMismatch, force);
      if (force) setSpeechStyleDirty(false);
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
  async function retryFailedJob() {
    if (!job || busyNow) return;
    const failedCount = job.failed?.length ?? 0;
    const isAudio = job.kind === "audio";
    const isPipeline = job.kind === "pipeline";
    setBusy("retry");
    setError("");
    const captured = token();
    try {
      if (job.retryable !== false && job.started_at) {
        try {
          await narrationApi.retryJob(courseId, materialId, job.started_at);
        } catch (err) {
          if (isAudio && data) {
            await narrationApi.audioBatch(courseId, materialId, 1, data.coverage.pages);
          } else {
            throw err;
          }
        }
      } else if (isAudio && data) {
        await narrationApi.audioBatch(courseId, materialId, 1, data.coverage.pages);
      } else {
        throw new Error("当前任务状态不支持直接重试，请刷新页面后重试");
      }
      if (captured === token()) {
        toast.add({
          title: failedCount > 0 ? `已提交重试 ${failedCount} 个失败页` : "已从断点重试任务",
          type: "info",
        });
      }
      const state = await waitForJob();
      if (isPipeline) {
        const next = await narrationApi.calibration(courseId, materialId, true).catch(() => null);
        if (next) setReport(next);
      }
      if (captured === token()) {
        toast.add(
          state.status === "done"
            ? {
                title: isAudio
                  ? `失败页配音已补齐（${state.done}/${state.total} 页）`
                  : isPipeline
                    ? "梳理、校准、讲解稿与知识点已完成"
                    : "重试已完成",
                type: "success",
              }
            : { title: "重试未完全成功", description: state.message, type: "warning" },
        );
      }
      if (isPipeline && state.status === "done") {
        onKnowledgeUpdatedRef.current?.();
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
  const running = Boolean(job?.running || job?.queued);
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
    retryFailedJob,
    running,
    busyNow,
    audioPage,
    navigation,
    previous,
    next,
    stylePreset,
    setStylePreset,
    customStyle,
    setCustomStyle,
    usePacing,
    setUsePacing,
    sectionMinutes,
    setSectionMinutes,
    chapterMinutes,
    setChapterMinutes,
    scriptOptions,
    myVoices,
    reloadVoices,
    selectMaterialVoice,
    speechStyleDirty,
  };
}
