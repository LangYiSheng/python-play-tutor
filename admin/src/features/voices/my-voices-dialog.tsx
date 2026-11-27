import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import {
  Check,
  Link2,
  LoaderCircle,
  Mic,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Square,
  Star,
  Trash2,
  Upload,
  Volume2,
} from "lucide-react";
import { ErrorNotice } from "@/components/common";
import { DialogSkeleton } from "@/components/skeletons";
import { SelectField } from "@/components/select-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api";
import {
  convertRecordedBlobToWav,
  DEFAULT_CLONE_READING_SCRIPT,
  DEFAULT_VOICE_PREVIEW_TEXT,
  probeAudioDuration,
  SPEECH_INSTRUCTION_PRESETS,
  voiceApi,
  type SpeechCapabilities,
  type TeacherVoice,
} from "@/lib/voice-api";

type DialogView = "list" | "enroll" | "bind";

export interface MyVoicesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
  onApplyVoice?: (voice: TeacherVoice) => Promise<void> | void;
  applyLabel?: string;
}

const PROTOCOL_NAMES: Record<string, string> = {
  dashscope: "阿里百炼",
  openai: "OpenAI 兼容",
  deepseek: "DeepSeek",
  manual: "手动绑定",
};

const ALLOWED_AUDIO_EXTS = /\.(wav|mp3|m4a|ogg|flac|webm)$/i;

function isSupportedAudioFile(file: File): boolean {
  return ALLOWED_AUDIO_EXTS.test(file.name) || file.type.startsWith("audio/");
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function voiceStatusBadge(status: TeacherVoice["status"]) {
  if (status === "ready") return <Badge variant="secondary">已就绪</Badge>;
  if (status === "processing") {
    return (
      <Badge variant="outline" className="gap-1">
        <LoaderCircle size={12} className="animate-spin" /> 复刻中…
      </Badge>
    );
  }
  return <Badge variant="destructive">复刻失败</Badge>;
}

export function MyVoicesDialog({
  open,
  onOpenChange,
  onChanged,
  onApplyVoice,
  applyLabel = "应用到此课件",
}: MyVoicesDialogProps) {
  const [view, setView] = useState<DialogView>("list");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [capabilities, setCapabilities] = useState<SpeechCapabilities | null>(null);
  const [voices, setVoices] = useState<TeacherVoice[]>([]);

  // List actions: rename & preview
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [previewVoiceId, setPreviewVoiceId] = useState<number | null>(null);
  const [previewText, setPreviewText] = useState(DEFAULT_VOICE_PREVIEW_TEXT);
  const [previewStyleId, setPreviewStyleId] = useState("inherit");
  const [previewSpeed, setPreviewSpeed] = useState("default");
  const [previewUrl, setPreviewUrl] = useState<string>("");

  // Enroll form
  const canRecord =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined";
  const [enrollTab, setEnrollTab] = useState<"record" | "upload">(canRecord ? "record" : "upload");
  const [enrollName, setEnrollName] = useState("我的课堂原声");
  const [enrollModel, setEnrollModel] = useState("");
  const [enrollDefault, setEnrollDefault] = useState(true);
  const [enrollConsent, setEnrollConsent] = useState(false);
  const [sampleFile, setSampleFile] = useState<File | null>(null);
  const [sampleUrl, setSampleUrl] = useState("");
  const [sampleSeconds, setSampleSeconds] = useState<number | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordElapsed, setRecordElapsed] = useState(0);
  const [micLevel, setMicLevel] = useState(0);

  // Bind form
  const [bindName, setBindName] = useState("");
  const [bindVoiceId, setBindVoiceId] = useState("");
  const [bindModel, setBindModel] = useState("");
  const [bindDefault, setBindDefault] = useState(true);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recordStartRef = useRef<number>(0);
  const meterFrameRef = useRef<number | null>(null);
  const meterCtxRef = useRef<AudioContext | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);

  const stopRecordingResources = useCallback(() => {
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (meterFrameRef.current !== null) {
      cancelAnimationFrame(meterFrameRef.current);
      meterFrameRef.current = null;
    }
    if (meterCtxRef.current) {
      void meterCtxRef.current.close().catch(() => {});
      meterCtxRef.current = null;
    }
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) track.stop();
      mediaStreamRef.current = null;
    }
    setRecording(false);
    setMicLevel(0);
  }, []);

  const clearPreviewUrl = useCallback(() => {
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
  }, []);

  const clearSample = useCallback(() => {
    setSampleFile(null);
    setSampleSeconds(null);
    setDragActive(false);
    dragDepthRef.current = 0;
    setSampleUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const loadVoices = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      const data = await voiceApi.list();
      setCapabilities(data.capabilities);
      setVoices(data.voices);
      setEnrollModel((prev) => prev || data.capabilities.default_model || "");
      setBindModel((prev) => prev || data.capabilities.default_model || "");
    } catch (err) {
      if (!silent) setError(errorMessage(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setView("list");
      setError("");
      setRenamingId(null);
      setPreviewVoiceId(null);
      clearPreviewUrl();
      void loadVoices();
    } else {
      stopRecordingResources();
      clearPreviewUrl();
      clearSample();
    }
  }, [open, loadVoices, stopRecordingResources, clearPreviewUrl, clearSample]);

  useEffect(() => {
    return () => {
      stopRecordingResources();
    };
  }, [stopRecordingResources]);

  // Auto-poll any voice currently in "processing" state while dialog is open on list view.
  const hasProcessing = open && view === "list" && voices.some((v) => v.status === "processing");
  useEffect(() => {
    if (!hasProcessing) return;
    const timer = window.setInterval(() => {
      const pending = voices.filter((v) => v.status === "processing");
      void Promise.all(pending.map((v) => voiceApi.refresh(v.id).catch(() => null))).then((updated) => {
        if (updated.some(Boolean)) {
          void loadVoices(true);
          onChanged?.();
        }
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [hasProcessing, voices, loadVoices, onChanged]);

  async function startRecording() {
    if (!canRecord || recording) return;
    setError("");
    clearSample();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      recordChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) recordChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const elapsedSec = Math.max(1, Math.round((Date.now() - recordStartRef.current) / 1000));
        const rawBlob = new Blob(recordChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        stopRecordingResources();
        if (rawBlob.size === 0) return;
        setBusy("converting");
        void convertRecordedBlobToWav(rawBlob, elapsedSec)
          .then(({ file, durationSeconds }) => {
            setSampleFile(file);
            setSampleSeconds(durationSeconds);
            setSampleUrl((prev) => {
              if (prev) URL.revokeObjectURL(prev);
              return URL.createObjectURL(file);
            });
          })
          .catch((e) => setError(errorMessage(e)))
          .finally(() => setBusy(""));
      };

      // Live volume meter
      if (window.AudioContext) {
        try {
          const audioCtx = new window.AudioContext();
          meterCtxRef.current = audioCtx;
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          const tickLevel = () => {
            analyser.getByteTimeDomainData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i += 1) {
              const norm = (dataArray[i] - 128) / 128;
              sum += norm * norm;
            }
            const rms = Math.sqrt(sum / dataArray.length);
            setMicLevel(Math.min(100, Math.round(rms * 320)));
            meterFrameRef.current = requestAnimationFrame(tickLevel);
          };
          meterFrameRef.current = requestAnimationFrame(tickLevel);
        } catch {
          // AudioContext meter is optional.
        }
      }

      recordStartRef.current = Date.now();
      setRecordElapsed(0);
      setRecording(true);
      recorder.start();
      recordTimerRef.current = window.setInterval(() => {
        const sec = Math.floor((Date.now() - recordStartRef.current) / 1000);
        setRecordElapsed(sec);
        if (sec >= 60 && mediaRecorderRef.current?.state === "recording") {
          mediaRecorderRef.current.stop();
        }
      }, 250);
    } catch (err) {
      stopRecordingResources();
      setError(`无法开启麦克风：${errorMessage(err)}。你也可以直接切换到「上传本地音频」。`);
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    } else {
      stopRecordingResources();
    }
  }

  async function acceptAudioFile(picked: File) {
    setError("");
    if (!isSupportedAudioFile(picked)) {
      setError("仅支持 .wav / .mp3 / .m4a / .ogg / .flac / .webm 音频文件。");
      return;
    }
    if (picked.size > 10 * 1024 * 1024) {
      setError("音频文件不能超过 10 MB，请裁剪为 10–30 秒清晰人声。");
      return;
    }
    setSampleFile(picked);
    setSampleSeconds(null);
    setSampleUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(picked);
    });
    const duration = await probeAudioDuration(picked);
    if (duration !== null && duration > 60) {
      setError(`音频时长约 ${duration} 秒，建议裁剪到 10–30 秒（最长 60 秒）。`);
      clearSample();
      return;
    }
    if (duration !== null) {
      setSampleSeconds(duration);
    }
  }

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    if (!picked) return;
    await acceptAudioFile(picked);
  }

  function handleUploadDragEnter(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleUploadDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    if (!dragActive) setDragActive(true);
  }

  function handleUploadDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleUploadDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);
    const dropped = e.dataTransfer?.files?.[0];
    if (dropped) {
      void acceptAudioFile(dropped);
    }
  }

  async function submitEnroll(e: FormEvent) {
    e.preventDefault();
    if (!sampleFile) {
      setError("请先录制或上传一段 10–20 秒的清晰干声");
      return;
    }
    if (!enrollConsent) {
      setError("请先勾选确认音频为本人真实声音或已获本人授权");
      return;
    }
    setBusy("enroll");
    setError("");
    try {
      const created = await voiceApi.enroll({
        name: enrollName.trim(),
        file: sampleFile,
        targetModel: enrollModel.trim() || undefined,
        isDefault: enrollDefault,
        sampleSeconds,
        consent: enrollConsent,
      });
      toast.add({
        title: created.status === "ready" ? `声音「${created.name}」复刻成功` : `已提交「${created.name}」复刻任务`,
        description: created.status === "ready" ? "可以点击试听样音检查效果。" : "云端正在训练音色，稍后自动刷新。",
        type: "success",
      });
      clearSample();
      setEnrollConsent(false);
      setView("list");
      setPreviewVoiceId(created.status === "ready" ? created.id : null);
      await loadVoices();
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  }

  async function submitBind(e: FormEvent) {
    e.preventDefault();
    setBusy("bind");
    setError("");
    try {
      const created = await voiceApi.bind({
        name: bindName.trim(),
        provider_voice_id: bindVoiceId.trim(),
        target_model: bindModel.trim() || undefined,
        is_default: bindDefault,
      });
      toast.add({ title: `已绑定声音「${created.name}」`, type: "success" });
      setBindName("");
      setBindVoiceId("");
      setView("list");
      setPreviewVoiceId(created.id);
      await loadVoices();
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  }

  async function runPreview(voiceId: number, overrideStyleId?: string, overrideSpeed?: string) {
    setBusy(`preview-${voiceId}`);
    setError("");
    clearPreviewUrl();
    const styleKey = overrideStyleId ?? previewStyleId;
    const speedKey = overrideSpeed ?? previewSpeed;
    const presets = capabilities?.instruction_presets ?? SPEECH_INSTRUCTION_PRESETS;
    const matchedPreset = presets.find((p) => p.id === styleKey);
    const instruction =
      styleKey === "none" ? "" : matchedPreset ? matchedPreset.text : undefined;
    const speed = speedKey !== "default" ? Number(speedKey) : undefined;
    try {
      const blob = await voiceApi.preview(voiceId, previewText, {
        ...(instruction !== undefined ? { instruction } : {}),
        ...(speed !== undefined && Number.isFinite(speed) ? { speed } : {}),
      });
      const url = URL.createObjectURL(blob);
      setPreviewVoiceId(voiceId);
      setPreviewUrl(url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  }

  async function setAsDefault(voice: TeacherVoice) {
    setBusy(`default-${voice.id}`);
    setError("");
    try {
      await voiceApi.update(voice.id, { is_default: true });
      toast.add({ title: `已将「${voice.name}」设为我的默认音色`, type: "success" });
      await loadVoices();
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  }

  async function saveRename(voice: TeacherVoice) {
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === voice.name) {
      setRenamingId(null);
      return;
    }
    setBusy(`rename-${voice.id}`);
    setError("");
    try {
      await voiceApi.update(voice.id, { name: trimmed });
      setRenamingId(null);
      toast.add({ title: "声音名称已更新", type: "success" });
      await loadVoices();
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  }

  async function handleRefresh(voice: TeacherVoice) {
    setBusy(`refresh-${voice.id}`);
    setError("");
    try {
      const updated = await voiceApi.refresh(voice.id);
      toast.add({
        title: updated.status === "ready" ? `「${updated.name}」已就绪` : "已刷新复刻状态",
        type: updated.status === "failed" ? "warning" : "info",
      });
      await loadVoices();
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  }

  async function handleDelete(voice: TeacherVoice) {
    if (!window.confirm(`确定删除声音「${voice.name}」？使用该音色的课件将回退到默认音色。`)) return;
    setBusy(`delete-${voice.id}`);
    setError("");
    try {
      await voiceApi.remove(voice.id);
      if (previewVoiceId === voice.id) {
        setPreviewVoiceId(null);
        clearPreviewUrl();
      }
      toast.add({ title: `已删除声音「${voice.name}」`, type: "success" });
      await loadVoices();
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  }

  async function handleApply(voice: TeacherVoice) {
    if (!onApplyVoice) return;
    setBusy(`apply-${voice.id}`);
    setError("");
    try {
      await onApplyVoice(voice);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  }

  const engineLabel = capabilities
    ? `${PROTOCOL_NAMES[capabilities.protocol] ?? capabilities.protocol}${capabilities.default_model ? ` · ${capabilities.default_model}` : ""}`
    : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy && busy !== "converting") return;
        if (!next && recording) stopRecordingResources();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mic size={18} />
            {view === "list" ? "我的声音" : view === "enroll" ? "复刻我的声音" : "绑定已有音色 ID"}
          </DialogTitle>
          <DialogDescription>
            {view === "list"
              ? "你的复刻声音仅本人账号可用，不会影响其他老师的课程。"
              : view === "enroll"
                ? "录一段 10–20 秒清晰干声，即可为全部 PPT 讲稿批量合成你的课堂原声。"
                : "如果你已在云平台控制台创建过复刻音色，可直接粘贴音色 ID 绑定到账号下。"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto space-y-4 pr-1">
          <ErrorNotice message={error} />

          {loading ? (
            <DialogSkeleton rows={3} />
          ) : view === "list" ? (
            <>
              {capabilities && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2.5 text-xs">
                  <div className="space-y-0.5">
                    <p className="font-medium text-foreground">
                      当前全站语音服务：{capabilities.speech_configured ? engineLabel : "未配置"}
                    </p>
                    <p className="text-muted-foreground">{capabilities.clone_hint}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="xs"
                      disabled={!capabilities.clone_supported || Boolean(busy)}
                      title={!capabilities.clone_supported ? capabilities.clone_hint : undefined}
                      onClick={() => {
                        setError("");
                        setEnrollTab(canRecord ? "record" : "upload");
                        setView("enroll");
                      }}
                    >
                      <Plus /> 复刻新声音
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        setError("");
                        setView("bind");
                      }}
                    >
                      <Link2 /> 绑定已有音色 ID
                    </Button>
                  </div>
                </div>
              )}

              {voices.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center space-y-3">
                  <p className="text-sm font-medium">还没有你的专属声音</p>
                  <p className="text-xs text-muted-foreground">
                    {capabilities?.clone_supported
                      ? "点击「复刻新声音」录制或上传 15 秒干声，即可一键生成你的声音用于课程配音。"
                      : "你可以点击「绑定已有音色 ID」把云平台复刻好的音色加入个人音色库。"}
                  </p>
                  <div className="flex justify-center gap-2">
                    {capabilities?.clone_supported && (
                      <Button
                        size="sm"
                        onClick={() => {
                          setError("");
                          setEnrollTab(canRecord ? "record" : "upload");
                          setView("enroll");
                        }}
                      >
                        <Mic /> 开始复刻我的声音
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setError("");
                        setView("bind");
                      }}
                    >
                      <Link2 /> 绑定已有音色 ID
                    </Button>
                  </div>
                </div>
              ) : (
                <ul className="space-y-2.5">
                  {voices.map((voice) => {
                    const isPreviewOpen = previewVoiceId === voice.id;
                    const isRenaming = renamingId === voice.id;
                    return (
                      <li key={voice.id} className="rounded-md border p-3 space-y-2.5">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1 space-y-1">
                            {isRenaming ? (
                              <div className="flex items-center gap-1.5">
                                <Input
                                  aria-label="新声音名称"
                                  className="h-7 max-w-56 text-sm"
                                  value={renameDraft}
                                  maxLength={80}
                                  onChange={(e) => setRenameDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      void saveRename(voice);
                                    } else if (e.key === "Escape") {
                                      setRenamingId(null);
                                    }
                                  }}
                                />
                                <Button
                                  size="xs"
                                  disabled={Boolean(busy)}
                                  onClick={() => void saveRename(voice)}
                                >
                                  <Check /> 保存
                                </Button>
                                <Button size="xs" variant="ghost" onClick={() => setRenamingId(null)}>
                                  取消
                                </Button>
                              </div>
                            ) : (
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Volume2 size={15} className="shrink-0 text-muted-foreground" />
                                <span className="font-medium text-sm">{voice.name}</span>
                                {voice.is_default && <Badge variant="default">默认</Badge>}
                                {voiceStatusBadge(voice.status)}
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground">
                              {PROTOCOL_NAMES[voice.provider] ?? voice.provider}
                              {voice.target_model ? ` · 模型 ${voice.target_model}` : ""}
                              {voice.sample_seconds ? ` · 样本 ${voice.sample_seconds} 秒` : ""}
                              {voice.material_count > 0 ? ` · 已用于 ${voice.material_count} 份课件` : ""}
                            </p>
                            {voice.error && <p className="text-xs text-destructive">{voice.error}</p>}
                          </div>

                          <div className="flex flex-wrap items-center gap-1">
                            {voice.status === "ready" && (
                              <>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  disabled={Boolean(busy) || !capabilities?.speech_configured}
                                  onClick={() => {
                                    if (isPreviewOpen && !previewUrl) {
                                      setPreviewVoiceId(null);
                                    } else {
                                      setPreviewVoiceId(voice.id);
                                      void runPreview(voice.id);
                                    }
                                  }}
                                >
                                  <Play /> {busy === `preview-${voice.id}` ? "合成中…" : "试听样音"}
                                </Button>
                                {onApplyVoice && (
                                  <Button
                                    size="xs"
                                    disabled={Boolean(busy)}
                                    onClick={() => void handleApply(voice)}
                                  >
                                    {applyLabel}
                                  </Button>
                                )}
                                {!voice.is_default && (
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    disabled={Boolean(busy)}
                                    onClick={() => void setAsDefault(voice)}
                                  >
                                    <Star /> 设为默认
                                  </Button>
                                )}
                              </>
                            )}
                            {voice.status === "processing" && (
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={Boolean(busy)}
                                onClick={() => void handleRefresh(voice)}
                              >
                                <RefreshCw /> 刷新状态
                              </Button>
                            )}
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label={`重命名${voice.name}`}
                              disabled={Boolean(busy)}
                              onClick={() => {
                                setRenamingId(voice.id);
                                setRenameDraft(voice.name);
                              }}
                            >
                              <Pencil />
                            </Button>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label={`删除${voice.name}`}
                              disabled={Boolean(busy)}
                              onClick={() => void handleDelete(voice)}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </div>

                        {isPreviewOpen && (
                          <div className="space-y-2 rounded bg-muted/40 p-2.5 text-xs">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Input
                                aria-label="试听文本"
                                className="h-7 min-w-44 flex-1 text-xs"
                                value={previewText}
                                maxLength={120}
                                onChange={(e) => setPreviewText(e.target.value)}
                                placeholder="输入一句教学文本试听效果…"
                              />
                              {(capabilities?.instruction_supported || voice.provider === "dashscope") && (
                                <SelectField
                                  aria-label="试听朗读语气"
                                  value={previewStyleId}
                                  onValueChange={(val) => {
                                    setPreviewStyleId(val);
                                    void runPreview(voice.id, val, previewSpeed);
                                  }}
                                  className="h-7 w-28 text-xs"
                                >
                                  <option value="inherit">语气：默认</option>
                                  {(capabilities?.instruction_presets ?? SPEECH_INSTRUCTION_PRESETS).map((preset) => (
                                    <option key={preset.id} value={preset.id}>
                                      {preset.label}
                                    </option>
                                  ))}
                                  <option value="none">关闭指令</option>
                                </SelectField>
                              )}
                              {capabilities?.protocol !== "deepseek" && (
                                <SelectField
                                  aria-label="试听语速"
                                  value={previewSpeed}
                                  onValueChange={(val) => {
                                    setPreviewSpeed(val);
                                    void runPreview(voice.id, previewStyleId, val);
                                  }}
                                  className="h-7 w-24 text-xs"
                                >
                                  <option value="default">语速：默认</option>
                                  <option value="0.95">0.95x</option>
                                  <option value="1">1.0x</option>
                                  <option value="1.05">1.05x</option>
                                  <option value="1.1">1.1x</option>
                                  <option value="1.15">1.15x</option>
                                  <option value="1.2">1.2x</option>
                                </SelectField>
                              )}
                              <Button
                                size="xs"
                                variant="secondary"
                                disabled={Boolean(busy) || !previewText.trim()}
                                onClick={() => void runPreview(voice.id)}
                              >
                                <Play /> {busy === `preview-${voice.id}` ? "合成中…" : "重新试听"}
                              </Button>
                            </div>
                            {previewUrl && (
                              <audio
                                controls
                                autoPlay
                                src={previewUrl}
                                className="h-8 w-full"
                                aria-label={`${voice.name}试听音频`}
                              />
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          ) : view === "enroll" ? (
            <form id="enroll-voice-form" className="space-y-4" onSubmit={(e) => void submitEnroll(e)}>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="field">
                  <Label htmlFor="enroll-voice-name">1. 声音名称</Label>
                  <Input
                    id="enroll-voice-name"
                    value={enrollName}
                    maxLength={80}
                    required
                    placeholder="例如：张老师-课堂原声"
                    onChange={(e) => setEnrollName(e.target.value)}
                  />
                </div>
                <div className="field">
                  <Label htmlFor="enroll-voice-model">绑定模型</Label>
                  <Input
                    id="enroll-voice-model"
                    value={enrollModel}
                    maxLength={120}
                    placeholder={capabilities?.default_model || "qwen-audio-3.1-tts-flash"}
                    onChange={(e) => setEnrollModel(e.target.value)}
                  />
                  <p className="hint">默认与全站语音合成模型一致，通常无需修改。</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label>2. 录一段 10–20 秒清晰干声</Label>
                <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
                  <p className="font-medium text-foreground">
                    参考朗读稿（安静环境 · 正常授课语速 · 离麦克风约 15 厘米）
                  </p>
                  <p className="leading-relaxed text-muted-foreground">“{DEFAULT_CLONE_READING_SCRIPT}”</p>
                </div>

                <Tabs
                  value={enrollTab}
                  onValueChange={(value) => {
                    if (recording) stopRecording();
                    setEnrollTab(value === "record" ? "record" : "upload");
                  }}
                >
                  <TabsList>
                    <TabsTrigger value="record">
                      <Mic /> 网页直接录音
                    </TabsTrigger>
                    <TabsTrigger value="upload">
                      <Upload /> 上传本地音频
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="record" className="space-y-3 pt-2">
                    {!canRecord ? (
                      <div className="rounded-md border border-amber-300 bg-amber-50/70 p-3 text-xs space-y-2 dark:border-amber-800 dark:bg-amber-950/30">
                        <p className="font-medium text-amber-900 dark:text-amber-200">
                          当前浏览器连接不支持直接调用麦克风
                        </p>
                        <p className="text-amber-800/90 dark:text-amber-300/90">
                          网页录音要求 HTTPS 域名或本机访问。你可以用手机录音机 / 电脑录好 15 秒音频后直接上传，效果同样清晰。
                        </p>
                        <Button size="xs" type="button" variant="outline" onClick={() => setEnrollTab("upload")}>
                          <Upload /> 切换到上传本地音频
                        </Button>
                      </div>
                    ) : (
                      <div className="rounded-md border p-3 space-y-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          {!recording ? (
                            <Button
                              type="button"
                              size="sm"
                              disabled={Boolean(busy)}
                              onClick={() => void startRecording()}
                            >
                              <Mic /> {sampleFile ? "重新录制" : "开始录音"}
                            </Button>
                          ) : (
                            <Button type="button" size="sm" variant="destructive" onClick={stopRecording}>
                              <Square /> 停止录音
                            </Button>
                          )}
                          <span className="text-xs font-mono tabular-nums text-muted-foreground">
                            {formatDuration(recording ? recordElapsed : sampleSeconds ?? 0)} / 00:30
                          </span>
                          {recording && (
                            <div className="flex flex-1 items-center gap-2 min-w-28">
                              <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                <div
                                  className="h-full bg-primary transition-all duration-75"
                                  style={{ width: `${Math.max(4, micLevel)}%` }}
                                />
                              </div>
                              <span className="text-[11px] text-muted-foreground">收音中</span>
                            </div>
                          )}
                          {busy === "converting" && (
                            <span className="text-xs text-muted-foreground">正在整理音频为标准 WAV…</span>
                          )}
                        </div>
                        {sampleUrl && sampleFile && !recording && (
                          <div className="space-y-1.5 pt-1 border-t">
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>
                                已录制：{sampleFile.name}（约 {sampleSeconds ?? 0} 秒）
                              </span>
                              <Button type="button" size="xs" variant="ghost" onClick={clearSample}>
                                清除重录
                              </Button>
                            </div>
                            <audio controls src={sampleUrl} className="h-8 w-full" aria-label="试听录音样本" />
                            {sampleSeconds !== null && sampleSeconds < 8 && (
                              <p className="text-xs text-amber-700">
                                当前录音短于 8 秒，建议重新录到 10–20 秒以获得更自然的复刻效果。
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="upload" className="space-y-2 pt-2">
                    <div
                      data-testid="voice-upload-dropzone"
                      onDragEnter={handleUploadDragEnter}
                      onDragOver={handleUploadDragOver}
                      onDragLeave={handleUploadDragLeave}
                      onDrop={handleUploadDrop}
                      className={`rounded-md border border-dashed p-4 space-y-3 transition-colors ${
                        dragActive ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground/50"
                      }`}
                    >
                      <input
                        ref={fileInputRef}
                        id="enroll-voice-file"
                        type="file"
                        accept=".wav,.mp3,.m4a,.ogg,.flac,.webm,audio/*"
                        className="sr-only"
                        onChange={(e) => void handleFileChange(e)}
                      />
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => fileInputRef.current?.click()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            fileInputRef.current?.click();
                          }
                        }}
                        className="flex cursor-pointer flex-col items-center justify-center gap-1.5 py-2 text-center"
                      >
                        <Upload size={18} className={dragActive ? "text-primary" : "text-muted-foreground"} />
                        <p className="text-xs font-medium">
                          {dragActive ? "松开鼠标即可导入音频文件" : "将音频文件拖拽到此处，或点击选择文件"}
                        </p>
                        <p className="hint">
                          支持 .wav / .mp3 / .m4a / .ogg / .flac（建议 10–20 秒，单文件 ≤ 10 MB）。
                        </p>
                      </div>
                      {sampleUrl && sampleFile && (
                        <div className="space-y-1.5 pt-2 border-t">
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>
                              已选择：{sampleFile.name}
                              {sampleSeconds ? `（约 ${sampleSeconds} 秒）` : ""}
                            </span>
                            <Button type="button" size="xs" variant="ghost" onClick={clearSample}>
                              移除
                            </Button>
                          </div>
                          <audio controls src={sampleUrl} className="h-8 w-full" aria-label="试听上传样本" />
                          {sampleSeconds !== null && sampleSeconds < 8 && (
                            <p className="text-xs text-amber-700">
                              音频短于 8 秒，复刻相似度可能下降，建议提供 10–20 秒人声。
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </TabsContent>
                </Tabs>
              </div>

              <div className="space-y-2 rounded-md border bg-muted/20 p-3 text-xs">
                <Label className="gap-2 font-normal cursor-pointer">
                  <Checkbox checked={enrollDefault} onCheckedChange={(v) => setEnrollDefault(Boolean(v))} />
                  复刻完成后设为我的默认配音音色
                </Label>
                <Label className="gap-2 font-normal cursor-pointer">
                  <Checkbox checked={enrollConsent} onCheckedChange={(v) => setEnrollConsent(Boolean(v))} />
                  确认该音频为本人真实声音（或已获本人授权），仅用于课程教学配音
                </Label>
              </div>
            </form>
          ) : (
            <form id="bind-voice-form" className="space-y-3" onSubmit={(e) => void submitBind(e)}>
              <div className="field">
                <Label htmlFor="bind-voice-name">声音名称</Label>
                <Input
                  id="bind-voice-name"
                  required
                  maxLength={80}
                  value={bindName}
                  placeholder="例如：张老师-课堂原声"
                  onChange={(e) => setBindName(e.target.value)}
                />
              </div>
              <div className="field">
                <Label htmlFor="bind-voice-id">平台音色 ID</Label>
                <Input
                  id="bind-voice-id"
                  required
                  maxLength={200}
                  value={bindVoiceId}
                  placeholder="粘贴云平台生成的复刻音色 ID"
                  onChange={(e) => setBindVoiceId(e.target.value)}
                />
              </div>
              <div className="field">
                <Label htmlFor="bind-voice-model">绑定模型（可选）</Label>
                <Input
                  id="bind-voice-model"
                  maxLength={120}
                  value={bindModel}
                  placeholder={capabilities?.default_model || "留空则跟随全站语音模型"}
                  onChange={(e) => setBindModel(e.target.value)}
                />
                <p className="hint">阿里百炼复刻音色需与其创建时使用的 target_model 一致。</p>
              </div>
              <Label className="gap-2 text-xs font-normal cursor-pointer">
                <Checkbox checked={bindDefault} onCheckedChange={(v) => setBindDefault(Boolean(v))} />
                绑定后设为我的默认配音音色
              </Label>
            </form>
          )}
        </div>

        <DialogFooter>
          {view === "list" ? (
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          ) : view === "enroll" ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy === "enroll"}
                onClick={() => {
                  if (recording) stopRecordingResources();
                  setError("");
                  setView("list");
                }}
              >
                返回列表
              </Button>
              <Button
                type="submit"
                form="enroll-voice-form"
                disabled={
                  Boolean(busy) ||
                  recording ||
                  !sampleFile ||
                  !enrollName.trim() ||
                  !enrollConsent
                }
              >
                {busy === "enroll" ? "正在复刻…" : "开始复刻声音"}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy === "bind"}
                onClick={() => {
                  setError("");
                  setView("list");
                }}
              >
                返回列表
              </Button>
              <Button
                type="submit"
                form="bind-voice-form"
                disabled={Boolean(busy) || !bindName.trim() || !bindVoiceId.trim()}
              >
                {busy === "bind" ? "保存中…" : "确认绑定"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
