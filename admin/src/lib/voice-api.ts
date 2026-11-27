import { api, responseError, token } from "@/lib/api";

export interface InstructionPreset {
  id: string;
  label: string;
  text: string;
}

export const SPEECH_INSTRUCTION_PRESETS: InstructionPreset[] = [
  {
    id: "natural",
    label: "自然授课",
    text: "请用自然连贯的普通话大学课堂授课语气朗读，语速平稳清晰，句中不要多余停顿。",
  },
  {
    id: "fluent",
    label: "流畅明快",
    text: "请用亲切明快、流畅连贯的普通话讲课语气朗读，节奏紧凑自然，重点清晰。",
  },
  {
    id: "calm",
    label: "温和沉稳",
    text: "请用温和沉稳、吐字清晰的普通话教学语气朗读，娓娓道来，连贯自然。",
  },
];

export interface SpeechCapabilities {
  speech_configured: boolean;
  protocol: string;
  default_model: string;
  default_voice: string;
  default_speed?: number;
  default_instruction?: string;
  instruction_supported?: boolean;
  instruction_presets?: InstructionPreset[];
  clone_supported: boolean;
  clone_hint: string;
}

export interface TeacherVoice {
  id: number;
  name: string;
  provider: string;
  target_model: string;
  provider_voice_id: string;
  status: "processing" | "ready" | "failed";
  error: string;
  has_sample: boolean;
  sample_seconds: number | null;
  is_default: boolean;
  material_count: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface VoiceLibraryResponse {
  capabilities: SpeechCapabilities;
  voices: TeacherVoice[];
}

export const DEFAULT_CLONE_READING_SCRIPT =
  "大家好，今天我们一起来学习 Python 中的列表和字典。在编写程序时，合理选择数据结构能让代码更清晰、运行效率也更高。下面我们结合具体的例子，一步一步来看它们在实际项目里的用法。";

export const DEFAULT_VOICE_PREVIEW_TEXT =
  "大家好，今天我们一起来学习 Python 程序设计，先来看本页的核心概念。";

export const voiceApi = {
  list: (signal?: AbortSignal) => api.get<VoiceLibraryResponse>("/teacher/voices", signal),
  enroll: (params: {
    name: string;
    file: File;
    targetModel?: string;
    isDefault?: boolean;
    sampleSeconds?: number | null;
    consent: boolean;
  }) => {
    const body = new FormData();
    body.append("name", params.name);
    body.append("file", params.file);
    if (params.targetModel?.trim()) body.append("target_model", params.targetModel.trim());
    body.append("is_default", String(params.isDefault ?? true));
    if (params.sampleSeconds && params.sampleSeconds > 0) {
      body.append("sample_seconds", String(Math.round(params.sampleSeconds)));
    }
    body.append("consent", String(params.consent));
    return api.upload<TeacherVoice>("/teacher/voices/enroll", body);
  },
  bind: (body: {
    name: string;
    provider_voice_id: string;
    target_model?: string;
    is_default?: boolean;
  }) => api.post<TeacherVoice>("/teacher/voices/bind", body),
  refresh: (voiceId: number) => api.post<TeacherVoice>(`/teacher/voices/${voiceId}/refresh`, {}),
  update: (voiceId: number, body: { name?: string; is_default?: boolean }) =>
    api.patch<TeacherVoice>(`/teacher/voices/${voiceId}`, body),
  remove: (voiceId: number) => api.delete(`/teacher/voices/${voiceId}`),
  preview: async (
    voiceId: number,
    text?: string,
    options?: { instruction?: string | null; speed?: number | null },
  ): Promise<Blob> => {
    const headers = new Headers({ "Content-Type": "application/json" });
    const captured = token();
    if (captured) headers.set("Authorization", `Bearer ${captured}`);
    const payload: Record<string, unknown> = {};
    if (text?.trim()) payload.text = text.trim();
    if (options?.instruction !== undefined && options.instruction !== null) {
      payload.instruction = options.instruction;
    }
    if (options?.speed !== undefined && options.speed !== null) {
      payload.speed = options.speed;
    }
    const response = await fetch(`/api/teacher/voices/${voiceId}/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (captured !== token()) {
      throw new Error("账号状态已改变，请重新试听");
    }
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw responseError(response.status, data, captured, "试听合成失败，请重试");
    }
    const blob = await response.blob();
    if (captured !== token()) {
      throw new Error("账号状态已改变，请重新试听");
    }
    return blob;
  },
};

export function encodePcmToWav(samples: Float32Array, sampleRate: number): Blob {
  const byteLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + byteLength);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + byteLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, byteLength, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function downmixMono(audioBuffer: AudioBuffer): Float32Array {
  const length = audioBuffer.length;
  const channels = audioBuffer.numberOfChannels;
  if (channels <= 1) return audioBuffer.getChannelData(0);
  const mixed = new Float32Array(length);
  for (let ch = 0; ch < channels; ch += 1) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) {
      mixed[i] += data[i] / channels;
    }
  }
  return mixed;
}

export async function convertRecordedBlobToWav(
  blob: Blob,
  fallbackSeconds: number,
): Promise<{ file: File; durationSeconds: number }> {
  const targetRate = 24000;
  const AudioCtx = window.AudioContext;
  if (AudioCtx) {
    const ctx = new AudioCtx();
    try {
      const arrayBuf = await blob.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
      const duration = Math.max(1, Math.round(decoded.duration));
      let samples: Float32Array;
      let rate = decoded.sampleRate;
      if (typeof OfflineAudioContext !== "undefined" && decoded.sampleRate !== targetRate) {
        const frameCount = Math.max(1, Math.ceil(decoded.duration * targetRate));
        const offline = new OfflineAudioContext(1, frameCount, targetRate);
        const src = offline.createBufferSource();
        src.buffer = decoded;
        src.connect(offline.destination);
        src.start(0);
        const rendered = await offline.startRendering();
        samples = rendered.getChannelData(0);
        rate = targetRate;
      } else {
        samples = downmixMono(decoded);
      }
      const wavBlob = encodePcmToWav(samples, rate);
      return {
        file: new File([wavBlob], "recorded-voice.wav", { type: "audio/wav" }),
        durationSeconds: duration,
      };
    } catch {
      // Fallback to raw recorded blob if browser cannot decode its own MediaRecorder output.
    } finally {
      await ctx.close().catch(() => {});
    }
  }
  const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
  return {
    file: new File([blob], `recorded-voice.${ext}`, { type: blob.type || "audio/webm" }),
    durationSeconds: Math.max(1, Math.round(fallbackSeconds)),
  };
}

export async function probeAudioDuration(file: File): Promise<number | null> {
  if (typeof URL === "undefined" || typeof Audio === "undefined") return null;
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise<number | null>((resolve) => {
      const el = new Audio();
      const finish = (value: number | null) => {
        el.onloadedmetadata = null;
        el.onerror = null;
        resolve(value);
      };
      const timer = window.setTimeout(() => finish(null), 3000);
      el.preload = "metadata";
      el.onloadedmetadata = () => {
        window.clearTimeout(timer);
        finish(Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : null);
      };
      el.onerror = () => {
        window.clearTimeout(timer);
        finish(null);
      };
      el.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
