import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContentActionDialog } from "../src/features/content-workspace/action-dialog";
import { CoursewarePage } from "../src/features/courseware/courseware-page";

const chapter = { id: 17, title: "基础语法", order_index: 1, owner_id: 2 };
const point = {
  id: 81,
  title: "表达式",
  chapter_id: 17,
  owner_id: 2,
  content: { summary_markdown: "原说明", notes: "保留附加内容" },
};
const deck = {
  id: 9,
  title: "变量与表达式课件",
  kind: "presentation",
  status: "ready",
  chapter_ids: [17],
  owner_id: 2,
};
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState({}, "", "/");
});

it("graph editing reads the selected point and saves through the curriculum editor", async () => {
  const saved = vi.fn();
  const closed = vi.fn();
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const url = new URL(path, location.origin);
    if (init.method === "PUT") saved(url.pathname, url.searchParams.get("classroom_id"), JSON.parse(String(init.body)));
    return json(url.pathname.endsWith("/courses") ? { chapters: [chapter] } : point);
  });
  const user = userEvent.setup();
  render(<ContentActionDialog classroomId={12} action={{ kind: "point", mode: "edit", id: 81 }} onClose={closed} />);
  const name = await screen.findByLabelText("名称");
  expect(name).toHaveValue("表达式");
  await user.clear(name);
  await user.type(name, "表达式与求值");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(closed).toHaveBeenCalledWith(true));
  expect(saved).toHaveBeenCalledWith("/api/teacher/knowledge-points/81", "12", {
    title: "表达式与求值",
    content: point.content,
  });
});

it("shows chapter-material tree, auto-collapses on PPT open, and edits digest text", async () => {
  const savedContents: unknown[] = [];
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/courses")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/materials")) {
      expect(url.searchParams.has("size")).toBe(false);
      return json([deck]);
    }
    if (url.pathname.endsWith("/narrations/1/content") && init?.method === "PUT") {
      savedContents.push(JSON.parse(String(init.body)));
      return json({ page_no: 1, title: "封面", topic: "导入", tags: ["变量"], text: "修订后的整理稿", source: "teacher" });
    }
    if (url.pathname.endsWith("/narrations")) {
      return json({
        pages: [
          {
            page_no: 1,
            title: "封面",
            has_text: true,
            source_chars: 12,
            source_text: "Python 变量概念",
            raw_text: "Python 变量概念",
            digest: { title: "封面", topic: "导入", tags: ["变量"], text: "Python 变量概念", status: "draft", source: "ai", image_state: "none", model: "m" },
            narration: null,
          },
        ],
        coverage: { pages: 1, covered: 0, missing: 1, draft: 0, accepted: 0, rejected: 0, unavailable: 0, stale: 0 },
      });
    }
    if (url.pathname.endsWith("/narrations/quota")) return json({ available: true, used_today: 0, daily_limit: 50 });
    if (url.pathname.endsWith("/narrations/audio")) {
      return json({ available: true, voice: "Meilin", model: "tts-1", pages: [{ page_no: 1, status: "draft", ready: false, seconds: null }] });
    }
    if (url.pathname.endsWith("/narrations/job")) {
      return json({ running: false, queued: false, status: "done", done: 1, total: 1, message: "", failed: [] });
    }
    if (url.pathname.endsWith("/lectio/knowledge")) {
      return json({
        chapters: [
          {
            id: 17,
            stable_id: "ch-17",
            title: "基础语法",
            order_index: 1,
            materials: [{ id: 9, stable_id: "m-9", title: "变量与表达式课件", kind: "presentation", pages: 1 }],
            points: [
              {
                id: 81,
                stable_id: "kp-81",
                chapter_id: 17,
                title: "变量概念",
                section: "1.1 变量",
                brief: "理解变量绑定",
                question_count: 2,
                sources: [{ material_id: 9, material_title: "变量与表达式课件", pages: [1] }],
              },
            ],
          },
        ],
      });
    }
    if (url.pathname.endsWith("/course-graph/tasks")) {
      return json([
        {
          kind: "audio",
          stage: "audio",
          material_id: 9,
          done: 0,
          total: 1,
          percent: null,
          queued: false,
          status: "failed",
          cancellable: true,
          retryable: true,
          started_at: "2026-11-24T10:00:00Z",
        },
      ]);
    }
    if (url.pathname.endsWith("/lectio/jobs")) return json({ jobs: [] });
    return json({});
  });

  const user = userEvent.setup();
  render(<CoursewarePage classroomId={12} />);
  expect(await screen.findByRole("complementary", { name: "章节与资料目录" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "打开工作区" }));
  expect(await screen.findByRole("tab", { name: "原文整理" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "口播与配音" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "知识点（1）" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "资料设置" })).toBeVisible();

  // Current slide displays mapped knowledge point pills directly on the PPT view (without numeric section prefixes)
  expect(await screen.findByText("变量 · 变量概念")).toBeVisible();

  // Courseware tasks modal holds narration/TTS tasks (instead of knowledge graph)
  await user.click(screen.getByRole("button", { name: /制作任务\s*1/ }));
  expect(await screen.findByText("语音合成")).toBeVisible();
  await user.keyboard("{Escape}");

  // Opening a PPT/PDF automatically collapses the left chapter directory for wider slides
  expect(screen.queryByRole("complementary", { name: "章节与资料目录" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "展开章节目录" }));
  expect(screen.getByRole("complementary", { name: "章节与资料目录" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "收起章节目录" }));
  expect(screen.queryByRole("complementary", { name: "章节与资料目录" })).not.toBeInTheDocument();

  // Teacher can directly edit and save the digest text in 原文整理
  const digestBox = await screen.findByLabelText(/整理稿正文/);
  await user.clear(digestBox);
  await user.type(digestBox, "修订后的整理稿");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(savedContents).toHaveLength(1));
  expect(savedContents[0]).toMatchObject({ text: "修订后的整理稿" });

  // Knowledge tab lists sections + clickable page jump back to slide
  await user.click(screen.getByRole("tab", { name: "知识点（1）" }));
  expect(await screen.findByText("理解变量绑定")).toBeVisible();
  await user.click(screen.getByRole("button", { name: /第 1 页/ }));
  expect(await screen.findByLabelText(/整理稿正文/)).toBeVisible();

  await user.click(screen.getByRole("tab", { name: "口播与配音" }));
  expect(await screen.findByRole("button", { name: "测算节奏" })).toBeVisible();
});

it("flips exactly one slide per mouse wheel gesture without skipping pages", async () => {
  vi.stubGlobal("fetch", async (path: string) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/courses")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/materials")) return json([deck]);
    if (url.pathname.endsWith("/narrations")) {
      return json({
        pages: [1, 2, 3].map((n) => ({
          page_no: n,
          title: `第${n}页`,
          has_text: true,
          source_chars: 10,
          source_text: `内容 ${n}`,
          raw_text: `内容 ${n}`,
          digest: { title: `第${n}页`, topic: "", tags: [], text: `内容 ${n}`, status: "draft", source: "ai", image_state: "none", model: "m" },
          narration: null,
        })),
        coverage: { pages: 3, covered: 0, missing: 3, draft: 0, accepted: 0, rejected: 0, unavailable: 0, stale: 0 },
      });
    }
    if (url.pathname.endsWith("/narrations/quota")) return json({ available: true, used_today: 0, daily_limit: 50 });
    if (url.pathname.endsWith("/narrations/audio")) return json({ available: true, voice: "Meilin", model: "tts-1", pages: [] });
    if (url.pathname.endsWith("/narrations/job")) return json({ running: false, queued: false, status: "done", done: 0, total: 0, message: "", failed: [] });
    return json({});
  });

  const user = userEvent.setup();
  render(<CoursewarePage classroomId={12} />);
  await user.click(await screen.findByRole("button", { name: "打开工作区" }));
  expect(await screen.findByText("第 1 / 3 页")).toBeVisible();

  const stage = screen.getByTitle("在此区域滚动鼠标滚轮可快速切换上 / 下一页");
  let now = 10_000;
  const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    // Simulate a smooth-scroll burst spanning 260ms (ticks every 65ms): must flip ONLY 1 page (1 -> 2)
    for (let i = 0; i < 5; i += 1) {
      const ev = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
      stage.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      now += 65;
    }
    expect(await screen.findByText("第 2 / 3 页")).toBeVisible();

    // After a pause, wheel up flips back by 1 page (2 -> 1)
    now += 400;
    const up = new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true });
    stage.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
    expect(await screen.findByText("第 1 / 3 页")).toBeVisible();
  } finally {
    dateSpy.mockRestore();
  }
});

it("supports dragging files or zip archives directly onto the courseware page", async () => {
  const uploads: { url: string; fileNames: string[]; chapterIds: string | null }[] = [];
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/courses")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/materials")) return json([deck]);
    if (url.pathname.endsWith("/materials/upload-batch") && init?.method === "POST") {
      const form = init.body as FormData;
      const files = form.getAll("files").map((f) => (f as File).name);
      uploads.push({
        url: url.pathname + url.search,
        fileNames: files,
        chapterIds: form.get("chapter_ids") as string | null,
      });
      return new Response(
        JSON.stringify({
          created: [{ id: 10, title: "定稿课件", kind: "pdf", status: "queued", filename: "定稿课件.pdf" }],
          skipped: [{ filename: "readme.docx", reason: "不支持此文件类型" }],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    return json({});
  });

  const { container } = render(<CoursewarePage classroomId={12} />);
  expect(await screen.findByRole("button", { name: "打开工作区" })).toBeVisible();

  const dropRoot = container.firstElementChild as HTMLElement;
  const zipFile = new File(["zip-bytes"], "定稿版.zip", { type: "application/zip" });
  const dataTransfer = { types: ["Files"], files: [zipFile], dropEffect: "none" };

  fireEvent.dragEnter(dropRoot, { dataTransfer });
  expect(await screen.findByText("松开鼠标即可导入资料")).toBeVisible();

  fireEvent.drop(dropRoot, { dataTransfer });
  await waitFor(() => expect(uploads).toHaveLength(1));
  expect(uploads[0]).toEqual({
    url: "/api/teacher/materials/upload-batch?classroom_id=12",
    fileNames: ["定稿版.zip"],
    chapterIds: null,
  });
  expect(await screen.findByText(/readme\.docx：不支持此文件类型/)).toBeVisible();
});

it("opens right-click context menu on tree materials to edit or delete directly", async () => {
  const previewTargets: unknown[] = [];
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/courses")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/materials")) return json([deck]);
    if (url.pathname.endsWith("/content-deletions/preview") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      previewTargets.push(body);
      return json({
        id: "p-mat-9",
        confirmation: deck.title,
        remove: [{ kind: "material", id: String(deck.id), title: deck.title }],
        detach: [],
        preserve: [],
        blockers: [],
        affected_students: 0,
        ending_sessions: 0,
        history_policy: "学生历史记录保留",
      });
    }
    return json({});
  });

  const user = userEvent.setup();
  render(<CoursewarePage classroomId={12} />);
  const tree = await screen.findByRole("complementary", { name: "章节与资料目录" });
  const treeItem = await within(tree).findByRole("button", { name: /变量与表达式课件/ });

  fireEvent.contextMenu(treeItem);
  expect(await screen.findByRole("menuitem", { name: "编辑资料" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "删除资料" })).toBeVisible();
  await user.click(screen.getByRole("menuitem", { name: "编辑资料" }));
  expect(await screen.findByDisplayValue("变量与表达式课件")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "取消" }));

  fireEvent.contextMenu(treeItem);
  await user.click(await screen.findByRole("menuitem", { name: "删除资料" }));
  expect(await screen.findByText("删除影响范围")).toBeVisible();
  await waitFor(() => expect(previewTargets).toHaveLength(1));
  expect(previewTargets[0]).toMatchObject({ classroom_id: 12, targets: [{ kind: "material", id: "9" }] });
});

it("groups PPT slide rail by section and knowledge points with toggle to flat page list", async () => {
  vi.stubGlobal("fetch", async (path: string) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/courses")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/materials")) return json([deck]);
    if (url.pathname.endsWith("/narrations")) {
      return json({
        pages: [1, 2, 3, 4].map((n) => ({
          page_no: n,
          title: `第${n}页`,
          has_text: true,
          source_chars: 10,
          source_text: `内容 ${n}`,
          raw_text: `内容 ${n}`,
          digest: { title: `第${n}页`, topic: "", tags: [], text: `内容 ${n}`, status: "draft", source: "ai", image_state: "none", model: "m" },
          narration: { status: "accepted", script: `讲稿 ${n}` },
        })),
        coverage: { pages: 4, covered: 4, missing: 0, draft: 0, accepted: 4, rejected: 0, unavailable: 0, stale: 0 },
      });
    }
    if (url.pathname.endsWith("/narrations/quota")) return json({ available: true, used_today: 0, daily_limit: 50 });
    if (url.pathname.endsWith("/narrations/audio")) return json({ available: true, voice: "Meilin", model: "tts-1", pages: [] });
    if (url.pathname.endsWith("/narrations/job")) return json({ running: false, queued: false, status: "done", done: 4, total: 4, message: "", failed: [] });
    if (url.pathname.endsWith("/lectio/knowledge")) {
      return json({
        chapters: [
          {
            id: 17,
            stable_id: "ch-17",
            title: "基础语法",
            order_index: 1,
            materials: [{ id: 9, stable_id: "m-9", title: "变量与表达式课件", kind: "presentation", pages: 4 }],
            points: [
              {
                id: 81,
                stable_id: "kp-81",
                chapter_id: 17,
                title: "变量概念",
                section: "1.1 变量",
                brief: "理解变量绑定",
                question_count: 2,
                sources: [{ material_id: 9, material_title: "变量与表达式课件", pages: [2, 3] }],
              },
              {
                id: 82,
                stable_id: "kp-82",
                chapter_id: 17,
                title: "表达式求值",
                section: "1.2 表达式",
                brief: "运算符优先级",
                question_count: 1,
                sources: [{ material_id: 9, material_title: "变量与表达式课件", pages: [4] }],
              },
            ],
          },
        ],
      });
    }
    if (url.pathname.endsWith("/course-graph/tasks")) return json([]);
    if (url.pathname.endsWith("/lectio/jobs")) return json({ jobs: [] });
    return json({});
  });

  const user = userEvent.setup();
  render(<CoursewarePage classroomId={12} />);
  await user.click(await screen.findByRole("button", { name: "打开工作区" }));

  const rail = await screen.findByLabelText("幻灯片页码概览");
  expect(await within(rail).findByText("封面 / 导言")).toBeVisible();
  expect(within(rail).getByText("变量")).toBeVisible();
  expect(within(rail).queryByText("1.1 变量")).not.toBeInTheDocument();
  expect(within(rail).getByText("变量概念")).toBeVisible();
  expect(within(rail).getByText("表达式")).toBeVisible();
  expect(within(rail).queryByText("1.2 表达式")).not.toBeInTheDocument();
  expect(within(rail).getByText("表达式求值")).toBeVisible();

  // Collapse a non-active group hides its pages; clicking again expands them
  const kpToggle = within(rail).getByRole("button", { name: /变量概念/ });
  expect(within(rail).getByRole("button", { name: /第 2 页/ })).toBeVisible();
  await user.click(kpToggle);
  expect(within(rail).queryByRole("button", { name: /第 2 页/ })).not.toBeInTheDocument();
  await user.click(kpToggle);
  expect(within(rail).getByRole("button", { name: /第 2 页/ })).toBeVisible();

  // Clicking a page inside a KP group navigates to that slide
  await user.click(within(rail).getByRole("button", { name: /第 3 页/ }));
  expect(await screen.findByText("第 3 / 4 页")).toBeVisible();

  // Toggle to flat page mode and back to knowledge-grouped mode
  await user.click(within(rail).getByRole("button", { name: "页码" }));
  expect(within(rail).queryByText("变量概念")).not.toBeInTheDocument();
  await user.click(within(rail).getByRole("button", { name: "按知识点" }));
  expect(within(rail).getByText("变量概念")).toBeVisible();
});

it("keeps open PPT workspace mounted without flashing during background conversion polling", async () => {
  let materialsFetches = 0;
  let narrationFetches = 0;
  const convertingDeck = {
    id: 10,
    title: "新上传课件",
    kind: "presentation",
    status: "processing",
    chapter_ids: [17],
    owner_id: 2,
  };

  vi.stubGlobal("fetch", async (path: string) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/courses")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/materials")) {
      materialsFetches += 1;
      return json([deck, { ...convertingDeck, status: materialsFetches >= 2 ? "ready" : "processing" }]);
    }
    if (url.pathname.endsWith("/narrations")) {
      narrationFetches += 1;
      return json({
        pages: [1, 2].map((n) => ({
          page_no: n,
          title: `第${n}页`,
          has_text: true,
          source_chars: 10,
          source_text: `内容 ${n}`,
          raw_text: `内容 ${n}`,
          digest: { title: `第${n}页`, topic: "", tags: [], text: `内容 ${n}`, status: "draft", source: "ai", image_state: "none", model: "m" },
          narration: null,
        })),
        coverage: { pages: 2, covered: 0, missing: 2, draft: 0, accepted: 0, rejected: 0, unavailable: 0, stale: 0 },
      });
    }
    if (url.pathname.endsWith("/narrations/quota")) return json({ available: true, used_today: 0, daily_limit: 50 });
    if (url.pathname.endsWith("/narrations/audio")) return json({ available: true, voice: "Meilin", model: "tts-1", pages: [] });
    if (url.pathname.endsWith("/narrations/job")) return json({ running: false, queued: false, status: "done", done: 0, total: 0, message: "", failed: [] });
    if (url.pathname.endsWith("/lectio/knowledge")) return json({ chapters: [] });
    if (url.pathname.endsWith("/course-graph/tasks")) return json([]);
    if (url.pathname.endsWith("/lectio/jobs")) return json({ jobs: [] });
    return json({});
  });

  const user = userEvent.setup();
  render(<CoursewarePage classroomId={12} />);
  const openBtns = await screen.findAllByRole("button", { name: "打开工作区" });
  await user.click(openBtns[0]);
  expect(await screen.findByText("第 1 / 2 页")).toBeVisible();

  // Navigate to slide 2 before the 2.5s background poll runs
  await user.click(screen.getByRole("button", { name: /第 2 页/ }));
  expect(await screen.findByText("第 2 / 2 页")).toBeVisible();
  const initialNarrationFetches = narrationFetches;

  // Wait for the 2.5s background poll to refresh material status from processing -> ready
  await waitFor(() => expect(materialsFetches).toBeGreaterThanOrEqual(2), { timeout: 4500 });

  // Open PPT workspace must remain mounted on page 2 without re-fetching narrations
  expect(screen.getByText("第 2 / 2 页")).toBeVisible();
  expect(narrationFetches).toBe(initialNarrationFetches);
});

it("refreshes knowledge points when opening a deck whose pipeline completed in background", async () => {
  let knowledgeFetches = 0;
  vi.stubGlobal("fetch", async (path: string) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/courses")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/materials")) return json([deck]);
    if (url.pathname.endsWith("/narrations")) {
      return json({
        pages: [1, 2].map((n) => ({
          page_no: n,
          title: `第${n}页`,
          has_text: true,
          source_chars: 10,
          source_text: `内容 ${n}`,
          raw_text: `内容 ${n}`,
          digest: { title: `第${n}页`, topic: "", tags: [], text: `内容 ${n}`, status: "draft", source: "ai", image_state: "none", model: "m" },
          narration: { status: "accepted", script: `讲稿 ${n}` },
        })),
        coverage: { pages: 2, covered: 2, missing: 0, draft: 0, accepted: 2, rejected: 0, unavailable: 0, stale: 0 },
      });
    }
    if (url.pathname.endsWith("/narrations/quota")) return json({ available: true, used_today: 0, daily_limit: 50 });
    if (url.pathname.endsWith("/narrations/audio")) return json({ available: true, voice: "Meilin", model: "tts-1", pages: [] });
    if (url.pathname.endsWith("/narrations/job")) return json({ running: false, queued: false, kind: "pipeline", status: "done", done: 1, total: 1, message: "", failed: [] });
    if (url.pathname.endsWith("/lectio/knowledge")) {
      knowledgeFetches += 1;
      if (knowledgeFetches === 1) {
        return json({ chapters: [{ id: 17, stable_id: "ch-17", title: "基础语法", order_index: 1, materials: [], points: [] }] });
      }
      return json({
        chapters: [
          {
            id: 17,
            stable_id: "ch-17",
            title: "基础语法",
            order_index: 1,
            materials: [{ id: 9, stable_id: "m-9", title: "变量与表达式课件", kind: "presentation", pages: 2 }],
            points: [
              {
                id: 99,
                stable_id: "kp-99",
                chapter_id: 17,
                title: "变量概念",
                section: "1.1 变量",
                brief: "变量定义",
                question_count: 0,
                sources: [{ material_id: 9, material_title: "变量与表达式课件", pages: [2] }],
              },
            ],
          },
        ],
      });
    }
    if (url.pathname.endsWith("/course-graph/tasks")) return json([]);
    if (url.pathname.endsWith("/lectio/jobs")) return json({ jobs: [] });
    return json({});
  });

  const user = userEvent.setup();
  render(<CoursewarePage classroomId={12} />);
  await waitFor(() => expect(knowledgeFetches).toBe(1));

  await user.click(await screen.findByRole("button", { name: "打开工作区" }));

  const rail = await screen.findByLabelText("幻灯片页码概览");
  expect(await within(rail).findByText("变量概念")).toBeVisible();
  expect(screen.getByRole("tab", { name: "知识点（1）" })).toBeVisible();
});
