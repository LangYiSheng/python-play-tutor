import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MyVoicesDialog } from "../src/features/voices/my-voices-dialog";
import { NarrationReview } from "../src/features/materials/narration/review";

afterEach(() => vi.unstubAllGlobals());

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sampleCapabilities = {
  speech_configured: true,
  protocol: "dashscope",
  default_model: "qwen-audio-3.1-tts-flash",
  default_voice: "longanhuan_v3.1",
  default_speed: 1,
  default_instruction: "",
  instruction_supported: true,
  instruction_presets: [
    { id: "natural", label: "自然授课", text: "请用自然连贯的普通话大学课堂授课语气朗读，语流顺畅，句中不要多余停顿，吐字清晰亲切。" },
    { id: "fluent", label: "流畅明快", text: "请用流畅明快、节奏紧凑的授课语气连贯朗读，句内不断开停顿，表达生动有条理。" },
    { id: "calm", label: "温和沉稳", text: "请用温和沉稳、逻辑清晰的讲解语气平稳朗读，语句衔接顺畅自然，无突兀卡顿。" },
  ],
  clone_supported: true,
  clone_hint: "支持上传或录制 10–20 秒清晰干声，直接通过阿里百炼复刻你的专属音色。",
};

const sampleVoice = {
  id: 11,
  name: "张老师-课堂原声",
  provider: "dashscope",
  target_model: "qwen-audio-3.1-tts-flash",
  provider_voice_id: "qwen-audio-3.1-tts-flash-t1-abc",
  status: "ready" as const,
  error: "",
  has_sample: true,
  sample_seconds: 16,
  is_default: true,
  material_count: 2,
  created_at: "2026-11-26T12:00:00+00:00",
  updated_at: "2026-11-26T12:00:00+00:00",
};

it("lists teacher voices, previews audio and enrolls a new voice via file upload", async () => {
  const calls: { url: string; method: string; isForm?: boolean; body?: unknown }[] = [];
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL() { return "blob:voice-preview"; }
    static revokeObjectURL() {}
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (method !== "GET") {
        calls.push({
          url,
          method,
          isForm: init.body instanceof FormData,
          body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        });
      }
      if (url.endsWith("/teacher/voices")) {
        return json({ capabilities: sampleCapabilities, voices: [sampleVoice] });
      }
      if (url.endsWith("/teacher/voices/11/preview")) {
        return new Response("ID3fake", { status: 200, headers: { "Content-Type": "audio/mpeg" } });
      }
      if (url.endsWith("/teacher/voices/enroll")) {
        return json({ ...sampleVoice, id: 12, name: "新复刻音色", is_default: true }, 201);
      }
      return json({});
    }),
  );

  const user = userEvent.setup();
  const onChanged = vi.fn();
  render(<MyVoicesDialog open onOpenChange={() => {}} onChanged={onChanged} />);

  expect(await screen.findByText("张老师-课堂原声")).toBeTruthy();
  expect(screen.getByText(/已用于 2 份课件/)).toBeTruthy();

  // Preview voice + switch preview style & speed
  await user.click(screen.getByRole("button", { name: /试听样音/ }));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/teacher/voices/11/preview"))).toBe(true));
  expect(await screen.findByLabelText("张老师-课堂原声试听音频")).toBeTruthy();

  await user.click(screen.getByLabelText("试听朗读语气"));
  await user.click(await screen.findByRole("option", { name: "流畅明快" }));
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url.endsWith("/teacher/voices/11/preview") &&
          (c.body as { instruction?: string })?.instruction === sampleCapabilities.instruction_presets[1].text,
      ),
    ).toBe(true),
  );

  await user.click(screen.getByLabelText("试听语速"));
  await user.click(await screen.findByRole("option", { name: "1.1x" }));
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url.endsWith("/teacher/voices/11/preview") &&
          (c.body as { speed?: number })?.speed === 1.1,
      ),
    ).toBe(true),
  );

  // Enroll new voice via file upload
  await user.click(screen.getByRole("button", { name: /复刻新声音/ }));
  expect(await screen.findByText("复刻我的声音")).toBeTruthy();
  const nameInput = screen.getByLabelText("1. 声音名称");
  await user.clear(nameInput);
  await user.type(nameInput, "新复刻音色");

  const fileInput = document.getElementById("enroll-voice-file") as HTMLInputElement;
  const fakeWav = new File([new Uint8Array(4096)], "teacher.wav", { type: "audio/wav" });
  await user.upload(fileInput, fakeWav);

  const submit = screen.getByRole("button", { name: /开始复刻声音/ });
  expect(submit).toBeDisabled();

  await user.click(screen.getByText(/确认该音频为本人真实声音/));
  expect(submit).not.toBeDisabled();
  await user.click(submit);

  await waitFor(() =>
    expect(calls.some((c) => c.url.endsWith("/teacher/voices/enroll") && c.isForm === true)).toBe(true),
  );
  expect(onChanged).toHaveBeenCalled();
});

it("switches material voice and offers regenerating mismatched pages in narration review", async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (method !== "GET") {
        calls.push({ url, method, body: init.body ? JSON.parse(init.body as string) : undefined });
      }
      if (url.endsWith("/teacher/voices")) {
        return json({ capabilities: sampleCapabilities, voices: [sampleVoice] });
      }
      if (url.endsWith("/quota")) return json({ used_today: 0, daily_limit: 300, available: true });
      if (url.endsWith("/audio") || url.endsWith("/voice")) {
        return json({
          available: true,
          voice: "qwen-audio-3.1-tts-flash-t1-abc",
          voice_name: "张老师-课堂原声",
          voice_source: "custom",
          voice_mode: "custom",
          selected_voice_id: 11,
          system_voice: "longanhuan_v3.1",
          mismatched_count: 1,
          model: "qwen-audio-3.1-tts-flash",
          pages: [{ page_no: 1, status: "accepted", ready: true, seconds: 12, audio_voice: "longanhuan_v3.1", voice_mismatch: true }],
        });
      }
      if (url.endsWith("/narrations")) {
        return json({
          material_id: 7,
          title: "第 1 讲",
          coverage: { pages: 1, covered: 1, missing: 0, draft: 0, accepted: 1, rejected: 0, unavailable: 0, stale: 0 },
          pages: [
            {
              page_no: 1,
              title: "变量",
              has_text: true,
              source_chars: 10,
              source_text: "变量定义",
              raw_text: "变量定义",
              digest: null,
              narration: {
                text: "这一页讲变量。",
                bridge_in: "",
                target_seconds: 60,
                status: "accepted",
                source: "ai_generated",
                model: "deepseek-flash",
                image_used: false,
                anchors: [],
                edited_by_teacher: false,
                reviewed_at: "2026-11-26T12:00:00Z",
                stale_reason: null,
              },
            },
          ],
        });
      }
      if (url.endsWith("/job")) {
        return json({ running: false, queued: false, kind: "audio", status: "done", done: 1, total: 1, message: "", failed: [] });
      }
      if (url.includes("/calibrate")) return new Response("missing", { status: 404 });
      if (url.endsWith("/audio-batch")) {
        return json({ job: { running: false, queued: false, kind: "audio", status: "done", done: 1, total: 1, message: "", failed: [] } }, 202);
      }
      return json({});
    }),
  );

  const user = userEvent.setup();
  render(<NarrationReview courseId={3} materialId={7} title="第 1 讲" onClose={() => {}} />);

  expect(await screen.findByText("旧音色")).toBeTruthy();
  expect(screen.getByRole("button", { name: /用新音色重合成/ })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: /生成全文配音（1 页旧音色）/ }));
  expect(await screen.findByText("检测到 1 页旧音色音频")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "用当前音色重合成全部页" }));

  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url.endsWith("/audio-batch") &&
          (c.body as { regenerate_mismatch?: boolean })?.regenerate_mismatch === true,
      ),
    ).toBe(true),
  );
});

it("updates material speech instruction and forces batch resynthesis when style changes", async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let currentInstruction: string | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const parsedBody = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      if (method !== "GET") {
        calls.push({ url, method, body: parsedBody });
      }
      if (url.endsWith("/teacher/voices")) {
        return json({ capabilities: sampleCapabilities, voices: [sampleVoice] });
      }
      if (url.endsWith("/quota")) return json({ used_today: 0, daily_limit: 300, available: true });
      if (url.endsWith("/voice") && method === "PUT") {
        currentInstruction = parsedBody?.speech_instruction ?? null;
        return json({
          available: true,
          voice: "qwen-audio-3.1-tts-flash-t1-abc",
          voice_name: "张老师-课堂原声",
          voice_source: "custom",
          voice_mode: "custom",
          selected_voice_id: 11,
          system_voice: "longanhuan_v3.1",
          mismatched_count: 0,
          model: "qwen-audio-3.1-tts-flash",
          speech_instruction: currentInstruction,
          effective_instruction: currentInstruction ?? "",
          speech_speed: null,
          effective_speed: 1,
          instruction_supported: true,
          instruction_presets: sampleCapabilities.instruction_presets,
          pages: [{ page_no: 1, status: "accepted", ready: true, seconds: 12, audio_voice: "qwen-audio-3.1-tts-flash-t1-abc", voice_mismatch: false }],
        });
      }
      if (url.endsWith("/audio")) {
        return json({
          available: true,
          voice: "qwen-audio-3.1-tts-flash-t1-abc",
          voice_name: "张老师-课堂原声",
          voice_source: "custom",
          voice_mode: "custom",
          selected_voice_id: 11,
          system_voice: "longanhuan_v3.1",
          mismatched_count: 0,
          model: "qwen-audio-3.1-tts-flash",
          speech_instruction: currentInstruction,
          effective_instruction: currentInstruction ?? "",
          speech_speed: null,
          effective_speed: 1,
          instruction_supported: true,
          instruction_presets: sampleCapabilities.instruction_presets,
          pages: [{ page_no: 1, status: "accepted", ready: true, seconds: 12, audio_voice: "qwen-audio-3.1-tts-flash-t1-abc", voice_mismatch: false }],
        });
      }
      if (url.endsWith("/narrations")) {
        return json({
          material_id: 7,
          title: "第 1 讲",
          coverage: { pages: 1, covered: 1, missing: 0, draft: 0, accepted: 1, rejected: 0, unavailable: 0, stale: 0 },
          pages: [
            {
              page_no: 1,
              title: "变量",
              has_text: true,
              source_chars: 10,
              source_text: "变量定义",
              raw_text: "变量定义",
              digest: null,
              narration: {
                text: "这一页讲变量。",
                bridge_in: "",
                target_seconds: 60,
                status: "accepted",
                source: "ai_generated",
                model: "deepseek-flash",
                image_used: false,
                anchors: [],
                edited_by_teacher: false,
                reviewed_at: "2026-11-26T12:00:00Z",
                stale_reason: null,
              },
            },
          ],
        });
      }
      if (url.endsWith("/job")) {
        return json({ running: false, queued: false, kind: "audio", status: "done", done: 1, total: 1, message: "", failed: [] });
      }
      if (url.includes("/calibrate")) return new Response("missing", { status: 404 });
      if (url.endsWith("/audio-batch")) {
        return json({ job: { running: false, queued: false, kind: "audio", status: "done", done: 1, total: 1, message: "", failed: [] } }, 202);
      }
      return json({});
    }),
  );

  const user = userEvent.setup();
  render(<NarrationReview courseId={3} materialId={7} title="第 1 讲" onClose={() => {}} />);

  const stylePicker = await screen.findByLabelText("朗读语气");
  await user.click(stylePicker);
  await user.click(await screen.findByRole("option", { name: "流畅明快" }));

  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url.endsWith("/voice") &&
          c.method === "PUT" &&
          (c.body as { speech_instruction?: string })?.speech_instruction === sampleCapabilities.instruction_presets[1].text,
      ),
    ).toBe(true),
  );

  await user.click(screen.getByRole("button", { name: "生成全文配音" }));
  expect(await screen.findByText("已调整朗读语气或语速")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "用当前音色重合成全部页" }));

  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.url.endsWith("/audio-batch") &&
          (c.body as { force?: boolean })?.force === true,
      ),
    ).toBe(true),
  );
});
