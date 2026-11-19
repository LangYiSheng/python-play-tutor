import { it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NarrationReview } from "../src/features/materials/narration/review";

afterEach(() => vi.unstubAllGlobals());

const report = {
  id: 1,
  complete: true,
  windows: 1,
  windows_done: 1,
  pages: 2,
  summary: "整体连贯",
  terms: ["监督学习"],
  issues: [],
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const list = {
  material_id: 7,
  title: "第 1 讲",
  coverage: { pages: 2, covered: 1, missing: 1, draft: 1, accepted: 0, rejected: 0, unavailable: 0, stale: 0 },
  pages: [
    {
      page_no: 1,
      title: "划重点",
      has_text: true,
      source_chars: 12,
      source_text: "监督学习的定义",
      narration: {
        text: "这一页先看监督学习的定义。",
        bridge_in: "",
        target_seconds: 90,
        status: "draft",
        source: "ai_generated",
        model: "deepseek-flash",
        image_used: true,
        anchors: ["监督学习"],
        edited_by_teacher: false,
        reviewed_at: null,
        stale_reason: null,
      },
    },
    {
      page_no: 2,
      title: "空页",
      has_text: false,
      source_chars: 0,
      source_text: "",
      narration: null,
    },
  ],
};

function stub(
  calls: { url: string; method: string; body?: unknown }[],
  overrides: Record<string, unknown> = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (method !== "GET") calls.push({ url, method, body: init.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith("/quota")) return json({ used_today: 4, daily_limit: 300, available: true });
      if (url.endsWith("/audio"))
        return json({
          available: true,
          voice: "Meilin",
          model: "zonos3-mini",
          pages: [{ page_no: 1, status: "draft", ready: false, seconds: null }],
        });
      if (url.endsWith("/narrations")) return json(overrides.list ?? list);
      if (url.endsWith("/job"))
        return json({
          running: false,
          queued: false,
          kind: "calibrate",
          status: "done",
          done: 1,
          total: 1,
          message: "",
          failed: [],
        });
      if (url.includes("/calibrate/apply"))
        return json({ regenerated: [], failed: [], awaiting_teacher: [] });
      if (url.includes("/calibrate")) return json(overrides.calibration ?? report);
      return json({ page_no: 1, status: "draft", reused: false, model: "deepseek-flash" });
    }),
  );
}

it("shows coverage and the generated draft next to the page source", async () => {
  stub([]);
  render(<NarrationReview classroomId={3} materialId={7} title="第 1 讲" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText("共 2 页")).toBeTruthy());
  expect(screen.getByText("已生成 1")).toBeTruthy();
  expect(screen.getByText("待审 1")).toBeTruthy();
  expect(screen.getByText(/今日已生成 4 \/ 300/)).toBeTruthy();
  expect(screen.getByText("监督学习的定义")).toBeTruthy();
  await waitFor(() => expect(screen.getByLabelText("讲解稿")).toHaveValue("这一页先看监督学习的定义。"));
});

it("accepting is blocked until an edited draft is saved", async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  stub(calls);
  const user = userEvent.setup();
  render(<NarrationReview classroomId={3} materialId={7} title="第 1 讲" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("讲解稿")).toBeTruthy());

  const accept = screen.getByRole("button", { name: /^接受$/ });
  await waitFor(() => expect(accept).not.toBeDisabled());
  await user.type(screen.getByLabelText("讲解稿"), "再看标签。");
  expect(accept).toBeDisabled();

  await user.click(screen.getByRole("button", { name: /保存修改/ }));
  await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
  const saved = calls.find((call) => call.method === "PUT")!;
  expect(saved.url).toContain("/teacher/classrooms/3/materials/7/narrations/1");
  expect(saved.body).toEqual({ text: "这一页先看监督学习的定义。再看标签。" });
});

it("keeps audio generation disabled until the page is accepted", async () => {
  stub([]);
  render(<NarrationReview classroomId={3} materialId={7} title="第 1 讲" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText("音色 Meilin · zonos3-mini")).toBeTruthy());
  const audio = screen.getByRole("button", { name: /生成音频/ });
  expect(audio).toBeDisabled();
  expect(screen.getByRole("button", { name: /试听/ })).toBeDisabled();
});

it("generate and calibrate hit the scoped endpoints", async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  stub(calls);
  const user = userEvent.setup();
  render(<NarrationReview classroomId={3} materialId={7} title="第 1 讲" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByRole("button", { name: /生成本页/ })).toBeTruthy());
  await user.click(screen.getByRole("button", { name: /生成本页/ }));
  await waitFor(() => expect(calls.some((call) => call.url.endsWith("/1/generate"))).toBe(true));

  await user.click(screen.getByRole("button", { name: /全篇校准/ }));
  await waitFor(() => expect(calls.some((call) => call.url.endsWith("/calibrate"))).toBe(true));
});

it("queues one calibration request and polls the job until it finishes", async () => {
  const posts: string[] = [];
  let polls = 0;
  let started = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (url.endsWith("/quota")) return json({ used_today: 0, daily_limit: 300, available: true });
      if (url.endsWith("/audio")) return json({ available: true, voice: "Meilin", model: "m", pages: [] });
      if (url.endsWith("/narrations")) return json(list);
      if (url.includes("/calibrate/apply")) return json({ regenerated: [], failed: [], awaiting_teacher: [] });
      if (url.endsWith("/job")) {
        const running = started && polls < 1;
        polls += started ? 1 : 0;
        return json({
          running,
          queued: false,
          kind: "calibrate",
          status: running ? "running" : "done",
          done: running ? 1 : 3,
          total: 3,
          message: running ? "第 1/3 个窗口" : "校准完成",
          failed: [],
        });
      }
      if (url.includes("/calibrate")) {
        if (method !== "POST") return json({ ...report, complete: false, windows: 3, windows_done: 3 });
        posts.push(url);
        started = true;
        return json({
          job: { running: true, queued: true, kind: "calibrate", status: "running", done: 0, total: 3, message: "", failed: [] },
        });
      }
      return json({ page_no: 1, status: "draft", reused: false, model: "x" });
    }),
  );
  const user = userEvent.setup();
  render(<NarrationReview classroomId={3} materialId={7} title="第 1 讲" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByRole("button", { name: /全篇校准/ })).not.toBeDisabled());
  await user.click(screen.getByRole("button", { name: /全篇校准/ }));
  await waitFor(() => expect(posts.length).toBe(1));
  // 请求只入队一次，进度靠轮询 /job：关掉页面也不会中断后台任务。
  await waitFor(() => expect(polls).toBeGreaterThan(1), { timeout: 5000 });
  await waitFor(() => expect(screen.getByText(/校准报告已生成/)).toBeTruthy());
  expect(posts.length).toBe(1);
});
