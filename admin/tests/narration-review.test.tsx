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
      raw_text: "监督学习的定义",
      digest: {
        title: "监督学习",
        topic: "这一页讲监督学习的定义",
        tags: ["监督学习"],
        text: "整理后的监督学习定义",
        status: "draft",
        source: "ai",
        image_state: "sent",
        model: "deepseek-flash",
      },
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
        return json(overrides.job ?? {
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
  expect(screen.getByRole("button", { name: /生成全文配音/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: /试听/ })).toBeDisabled();
});

it("queues the one-click pipeline and shows which stage is running", async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  stub(calls, {
    job: {
      running: false,
      queued: false,
      kind: "pipeline",
      status: "done",
      stage: "calibrate",
      chain: ["calibrate", "apply", "script"],
      done: 0,
      total: 0,
      message: "",
      failed: [],
    },
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const user = userEvent.setup();
  render(<NarrationReview classroomId={3} materialId={7} title="第 1 讲" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByRole("button", { name: /一键梳理文本/ })).toBeTruthy());
  await user.click(screen.getByRole("button", { name: /一键梳理文本/ }));
  await waitFor(() => expect(calls.some((call) => call.url.endsWith("/pipeline"))).toBe(true));
  await waitFor(() => expect(screen.getAllByText(/整理原文/).length).toBeGreaterThan(0));
  expect(screen.getAllByText(/整册校准/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/生成讲解稿/).length).toBeGreaterThan(0);
});

it("lists calibration fixes and tag merges, and says the fixes were applied", async () => {
  stub([], {
    calibration: {
      ...report,
      fixes: [
        {
          page_no: 1,
          before: "监督学习的定义是",
          after: "监督学习的定义：",
          reason: "补上漏掉的冒号",
        },
      ],
      tag_map: { "监督学习算法": "监督学习" },
      tag_stats: { before: 2, after: 1, merged: 1 },
    },
  });
  const user = userEvent.setup();
  render(<NarrationReview classroomId={3} materialId={7} title="第 1 讲" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByRole("tab", { name: /校准/ })).toBeTruthy());
  await user.click(screen.getByRole("tab", { name: /校准/ }));
  await waitFor(() => expect(screen.getByText(/校准修正已自动应用/)).toBeTruthy());
  expect(screen.getByText(/原文修正（1 处，已自动应用）/)).toBeTruthy();
  expect(screen.getByText("补上漏掉的冒号")).toBeTruthy();
  expect(screen.getByText(/标签合并（1 组）/)).toBeTruthy();
});

it("shows the digest read-only and folds the raw text", async () => {
  stub([]);
  render(<NarrationReview classroomId={3} materialId={7} title="第 1 讲" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText("整理后的监督学习定义")).toBeTruthy());
  expect(screen.getByText("监督学习")).toBeTruthy();
  expect(screen.getByText("这一页讲监督学习的定义")).toBeTruthy();
  expect(screen.getByText("标签：监督学习")).toBeTruthy();
  expect(screen.getByText(/查看原始文本（12 字）/)).toBeTruthy();
  expect(screen.queryByLabelText("本页标题")).toBeNull();
  expect(screen.queryByRole("button", { name: /保存标题与标签/ })).toBeNull();
});