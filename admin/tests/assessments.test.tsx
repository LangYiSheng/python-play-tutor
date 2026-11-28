import { afterEach, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssessmentsPage } from "../src/features/assessments/assessments-page";

const chapter = { id: 17, stable_id: "ch-17", title: "基础语法", order_index: 1, materials: [], points: [] };
const point = { id: 81, stable_id: "kp-81", title: "表达式", chapter_id: 17, owner_id: 2 };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState({}, "", "/");
});

it("pages only the selected knowledge point and switches cleanly to exams tab and back", async () => {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", async (path: string) => {
    const url = new URL(path, location.origin);
    calls.push(url);
    if (url.pathname.endsWith("/catalog")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/knowledge-point-labels")) return json([point]);
    if (url.pathname.endsWith("/course-studio/jobs")) return json({ jobs: [] });
    if (url.pathname.endsWith("/course-studio/exams")) return json({ exams: [] });
    if (url.pathname.endsWith("/course-studio/knowledge")) return json({ chapters: [chapter] });
    const page = Number(url.searchParams.get("page") || 1);
    return json({
      page,
      total: 35,
      items: [
        {
          id: "q" + page,
          title: "测试题 " + page,
          kind: "fill",
          source_type: "imported",
          status: "ready",
          chapter_ids: [chapter.id],
        },
      ],
    });
  });

  history.replaceState({}, "", "/teacher/assessments?course=12&tab=bank&point=81");
  const user = userEvent.setup();
  render(<AssessmentsPage courseId={12} />);
  expect(await screen.findByText("知识点 · 表达式")).toBeVisible();
  expect(await screen.findByText("测试题 1")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByText("测试题 2")).toBeVisible();

  const requests = calls.filter((url) => url.pathname.endsWith("/questions"));
  expect(requests.map((url) => url.searchParams.get("page"))).toEqual(["1", "2"]);
  expect(
    requests.every(
      (url) => url.searchParams.get("knowledge_point_id") === "81" && url.searchParams.get("size") === "10",
    ),
  ).toBe(true);
  expect(
    calls
      .filter((u) => !u.pathname.includes("/course-studio/"))
      .every((url) => url.pathname.startsWith("/api/teacher/courses/12/") && !url.searchParams.has("classroom_id")),
  ).toBe(true);

  await user.click(screen.getByRole("tab", { name: "课程组卷" }));
  expect(await screen.findByText("本课程尚未生成试卷")).toBeVisible();
  expect(location.search).toBe("?course=12&tab=exams");

  await act(async () => {
    history.back();
  });
  expect(await screen.findByText("知识点 · 表达式")).toBeVisible();
});

it("handles reviewable draft filter and clears back to tab=bank", async () => {
  const requests: URLSearchParams[] = [];
  vi.stubGlobal("fetch", async (path: string) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/catalog")) return json({ chapters: [] });
    if (url.pathname.endsWith("/course-studio/jobs")) return json({ jobs: [] });
    requests.push(url.searchParams);
    const page = Number(url.searchParams.get("page") || 1);
    return json({
      page,
      total: 12,
      items: [
        {
          id: "q" + page,
          title: "题目 " + page,
          kind: "fill",
          source_type: "imported",
          status: "draft",
          chapter_ids: [],
        },
      ],
    });
  });

  history.replaceState({}, "", "/teacher/assessments?course=12&tab=bank&status=draft&reviewable=true");
  const user = userEvent.setup();
  render(<AssessmentsPage courseId={12} />);
  expect(await screen.findByText("题目 1")).toBeVisible();
  const status = screen.getByRole("combobox", { name: "题目状态" });
  expect(status).toHaveTextContent("待我审核");
  await user.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByText("题目 2")).toBeVisible();
  expect(requests.map((params) => [params.get("page"), params.get("status"), params.get("reviewable")])).toEqual([
    ["1", "draft", "true"],
    ["2", "draft", "true"],
  ]);

  await user.click(status);
  await user.click(await screen.findByRole("option", { name: "全部状态" }));
  expect(await screen.findByText("题目 1")).toBeVisible();
  expect(location.search).toBe("?course=12&tab=bank");
  expect(requests.at(-1)?.has("reviewable")).toBe(false);
  expect(requests.at(-1)?.has("status")).toBe(false);
});

it("submits AI objective exercise generation and creates an exam via wizard", async () => {
  const submitted: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/catalog")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/questions")) return json({ page: 1, total: 0, items: [] });
    if (url.pathname.endsWith("/course-studio/jobs")) return json({ jobs: [] });
    if (url.pathname.endsWith("/course-studio/knowledge")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/course-studio/exams")) return json({ exams: [] });
    if (url.pathname.endsWith("/course-studio/chapters/17/exercises/generate")) {
      submitted.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
      return json(
        {
          id: "job-ex-1",
          course_instance_id: 1,
          kind: "exercises_generate",
          scope_key: "ch:17",
          status: "queued",
          progress: { done: 0, total: 1, message: "queued" },
          result: null,
          error: "",
          cancel_requested: false,
          started_at: null,
          finished_at: null,
          created_at: "2026-11-24T00:00:00Z",
          updated_at: "2026-11-24T00:00:00Z",
        },
        202,
      );
    }
    if (url.pathname.endsWith("/course-studio/exams/gaps")) {
      return json({
        ok: true,
        totalShortage: 0,
        byType: [{ type: "single", label: "单选题", count: 10, needed: 10, available: 15, shortage: 0 }],
      });
    }
    if (url.pathname.endsWith("/course-studio/exams/generate")) {
      return json(
        {
          id: "exam-1",
          stable_id: "ex-1",
          title: "期末综合测试卷",
          subtitle: "",
          examMode: "闭卷",
          durationMinutes: 90,
          totalScore: 80,
          abMode: false,
          maxOverlapRate: 0,
          includeUnreviewed: false,
          chapters: ["第1章 基础语法"],
          chapterWeights: {},
          sections: [],
          variants: {
            A: {
              label: "正式卷",
              totalScore: 80,
              questions: [
                {
                  uid: "u1",
                  sourceId: "q1",
                  chapter: "第1章 基础语法",
                  type: "single",
                  score: 2,
                  question: "Python 变量命名正确的是？",
                  options: { A: "user_1", B: "1_user" },
                  answer: "A",
                  explanation: "标识符不能数字开头",
                  knowledge_points: ["变量"],
                  page: 1,
                },
              ],
            },
          },
          stats: { overlapCount: 0, overlapRate: 0 },
          createdAt: "2026-11-24T00:00:00Z",
          updatedAt: "2026-11-24T00:00:00Z",
        },
        201,
      );
    }
    return json({});
  });

  history.replaceState({}, "", "/teacher/assessments?course=12&tab=bank");
  const user = userEvent.setup();
  render(<AssessmentsPage courseId={12} />);

  await user.click(await screen.findByRole("button", { name: "AI 智能出题" }));
  await user.click(await screen.findByRole("button", { name: "开始生成草稿" }));
  await waitFor(() => expect(submitted).toHaveLength(1));
  expect(submitted[0].path).toBe("/api/teacher/courses/12/course-studio/chapters/17/exercises/generate");
  expect(submitted[0].body.counts).toEqual({ single: 4, multiple: 2, true_false: 2, fill_blank: 2 });

  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("tab", { name: "课程组卷" }));
  await user.click(await screen.findByRole("button", { name: "新建试卷" }));
  await user.click(await screen.findByRole("button", { name: /下一步：检查题库缺口/ }));
  expect(await screen.findByText("题库数量充足，可立即组卷")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "生成试卷" }));
  expect(await screen.findByText("Python 变量命名正确的是？")).toBeVisible();
});

it("supports one-click approve, batch approve, and hides completed AI jobs from the work queue", async () => {
  const updates: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/catalog")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/course-studio/jobs")) {
      return json({
        jobs: [
          {
            id: "j-done",
            course_instance_id: 1,
            kind: "exercises_generate",
            scope_key: "chapter:17:exercises",
            status: "done",
            progress: { done: 1, total: 1, message: "正在根据课件内容生成客观题…" },
            result: { created: 2, skipped: 0 },
            error: "",
            cancel_requested: false,
            started_at: "2026-11-24T00:00:00Z",
            finished_at: "2026-11-24T00:01:00Z",
            created_at: "2026-11-24T00:00:00Z",
            updated_at: "2026-11-24T00:01:00Z",
          },
        ],
      });
    }
    if (url.pathname.endsWith("/course-studio/exams")) return json({ exams: [] });
    if (url.pathname.endsWith("/course-studio/knowledge")) return json({ chapters: [chapter] });
    if (url.pathname.includes("/questions/") && init?.method === "PUT") {
      updates.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      return json({ ok: true });
    }
    if (url.pathname.endsWith("/questions")) {
      return json({
        page: 1,
        total: 2,
        items: [
          { id: "q1", title: "待审第一题", kind: "single_choice", source_type: "ai_generated", status: "draft", chapter_ids: [17] },
          { id: "q2", title: "待审第二题", kind: "boolean", source_type: "ai_generated", status: "draft", chapter_ids: [17] },
        ],
      });
    }
    return json({});
  });

  history.replaceState({}, "", "/teacher/assessments?course=12&tab=bank");
  const user = userEvent.setup();
  render(<AssessmentsPage courseId={12} />);

  expect(await screen.findByRole("button", { name: "通过待审第一题" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /AI 出题任务/ })).not.toBeInTheDocument();

  // One-click row approve
  await user.click(await screen.findByRole("button", { name: "通过待审第一题" }));
  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toEqual({ path: "/api/teacher/courses/12/questions/q1", body: { status: "ready" } });

  // Batch approve selected rows
  await user.click(screen.getByRole("checkbox", { name: "选择待审第二题" }));
  await user.click(await screen.findByRole("button", { name: /批量通过审核/ }));
  await waitFor(() => expect(updates).toHaveLength(2));
  expect(updates[1]).toEqual({ path: "/api/teacher/courses/12/questions/q2", body: { status: "ready" } });
});

it("allows collapsing and reopening AI job panel while generation is running", async () => {
  vi.stubGlobal("fetch", async (path: string) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/catalog")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/course-studio/jobs")) {
      return json({
        jobs: [
          {
            id: "j-running",
            course_instance_id: 1,
            kind: "exercises_generate",
            scope_key: "chapter:17:exercises",
            status: "running",
            progress: { done: 3, total: 12, message: "正在按知识点配额生成单选题（3/12 批）…" },
            result: null,
            error: "",
            cancel_requested: false,
            started_at: "2026-11-26T00:00:00Z",
            finished_at: null,
            created_at: "2026-11-26T00:00:00Z",
            updated_at: "2026-11-26T00:00:05Z",
          },
        ],
      });
    }
    if (url.pathname.endsWith("/course-studio/exams")) return json({ exams: [] });
    if (url.pathname.endsWith("/course-studio/knowledge")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/questions")) return json({ page: 1, total: 0, items: [] });
    return json({});
  });

  history.replaceState({}, "", "/teacher/assessments?course=12&tab=bank");
  const user = userEvent.setup();
  render(<AssessmentsPage courseId={12} />);

  // Header shows running badge without blocking the question bank by default
  const toggleBtn = await screen.findByRole("button", { name: /AI 出题任务（1 进行中）/ });
  expect(toggleBtn).toBeVisible();
  expect(screen.queryByText("AI 创作任务")).not.toBeInTheDocument();

  // Teacher can expand to inspect progress and collapse again while still running
  await user.click(toggleBtn);
  expect(await screen.findByText(/正在按知识点配额生成单选题/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.queryByText("AI 创作任务")).not.toBeInTheDocument();

  // Escape closes the task dialog and returns to the question bank
  await user.click(toggleBtn);
  expect(await screen.findByText("AI 创作任务")).toBeVisible();
  await user.keyboard("{Escape}");
  expect(screen.queryByText("AI 创作任务")).not.toBeInTheDocument();
});

it("shows partial created counts on interrupted and legacy exercise jobs", async () => {
  let cancelled = false;
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/course-studio/jobs/j-interrupted-zero/cancel") && init.method === "POST") {
      cancelled = true;
      return json({status:"cancelled"});
    }
    if (url.pathname.endsWith("/catalog")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/course-studio/jobs")) {
      return json({
        jobs: [
          {
            id: "j-interrupted-partial",
            course_instance_id: 1,
            kind: "exercises_generate",
            scope_key: "chapter:17:exercises",
            status: "interrupted",
            progress: { done: 4, total: 12, message: "中断前已生成并入库 12 道待审题目（跳过重复或无效 1 道）" },
            result: { chapter_id: 17, created: 12, skipped: 1 },
            error: "服务重启，任务已中断",
            cancel_requested: false,
            started_at: "2026-11-26T00:00:00Z",
            finished_at: "2026-11-26T00:01:00Z",
            created_at: "2026-11-26T00:00:00Z",
            updated_at: "2026-11-26T00:01:00Z",
          },
          {
            id: "j-interrupted-legacy",
            course_instance_id: 1,
            kind: "exercises_generate",
            scope_key: "chapter:17:exercises",
            status: "interrupted",
            progress: { done: 10, total: 12, message: "正在按知识点配额生成填空题（11/12 批）…" },
            result: null,
            error: "服务重启，任务已中断",
            cancel_requested: false,
            started_at: "2026-11-26T00:00:00Z",
            finished_at: "2026-11-26T00:01:00Z",
            created_at: "2026-11-26T00:00:00Z",
            updated_at: "2026-11-26T00:01:00Z",
          },
          {
            id: "j-interrupted-zero",
            course_instance_id: 1,
            kind: "exercises_generate",
            scope_key: "chapter:17:exercises",
              status: cancelled ? "cancelled" : "interrupted",
            progress: { done: 0, total: 1, message: "已加入智能出题队列" },
            result: null,
            error: "服务重启，任务已中断",
            cancel_requested: false,
            started_at: null,
            finished_at: "2026-11-26T00:01:00Z",
            created_at: "2026-11-26T00:00:00Z",
            updated_at: "2026-11-26T00:01:00Z",
          },
        ],
      });
    }
    if (url.pathname.endsWith("/course-studio/exams")) return json({ exams: [] });
    if (url.pathname.endsWith("/course-studio/knowledge")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/questions")) return json({ page: 1, total: 0, items: [] });
    return json({});
  });

  history.replaceState({}, "", "/teacher/assessments?course=12&tab=bank");
  const user = userEvent.setup();
  render(<AssessmentsPage courseId={12} />);

  await user.click(await screen.findByRole("button", { name: /AI 出题任务（3）/ }));
  expect(await screen.findByText("中断前已生成并入库 12 道待审题目（跳过重复或无效 1 道）")).toBeVisible();
  expect(screen.getByText(/中断前已执行 10\/12 批/)).toBeVisible();
  expect(screen.getByText("中断前未写入题目")).toBeVisible();
  await user.click(within(screen.getByText("中断前未写入题目").closest("li")!).getByRole("button", {name:"取消任务"}));
  await waitFor(() => expect(screen.queryByText("中断前未写入题目")).not.toBeInTheDocument());
  expect(cancelled).toBe(true);
});

it("shows coding_type filter only when kind is python and resets it when switching back", async () => {
  const requests: URLSearchParams[] = [];
  vi.stubGlobal("fetch", async (path: string) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/catalog")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/course-studio/jobs")) return json({ jobs: [] });
    if (url.pathname.endsWith("/questions")) {
      requests.push(url.searchParams);
      return json({ page: 1, total: 0, items: [] });
    }
    return json({});
  });

  history.replaceState({}, "", "/teacher/assessments?course=12&tab=bank");
  const user = userEvent.setup();
  render(<AssessmentsPage courseId={12} />);

  await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(1));
  expect(screen.queryByRole("combobox", { name: "编程形式" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("combobox", { name: "题目类型" }));
  await user.click(await screen.findByRole("option", { name: "编程题" }));
  const codingTypeSelect = await screen.findByRole("combobox", { name: "编程形式" });
  expect(codingTypeSelect).toBeVisible();

  await user.click(codingTypeSelect);
  await user.click(await screen.findByRole("option", { name: "程序填空" }));
  await waitFor(() => expect(requests.at(-1)?.get("coding_type")).toBe("fill_code"));

  await user.click(screen.getByRole("combobox", { name: "题目类型" }));
  await user.click(await screen.findByRole("option", { name: "全部题型" }));
  expect(screen.queryByRole("combobox", { name: "编程形式" })).not.toBeInTheDocument();
  await waitFor(() => expect(requests.at(-1)?.has("coding_type")).toBe(false));
});

it("submits AI coding exercise generation and displays coding job summary with failures", async () => {
  const submitted: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/catalog")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/questions")) {
      return json({
        page: 1,
        total: 1,
        items: [
          {
            id: "q-fresh-py",
            title: "新生成的编程题",
            kind: "python",
            coding_type: "fill_code",
            source_type: "ai_generated",
            status: "draft",
            chapter_ids: [17],
            created_at: new Date().toISOString(),
          },
        ],
      });
    }
    if (url.pathname.endsWith("/course-studio/knowledge")) {
      return json({
        chapters: [
          {
            ...chapter,
            materials: [{ id: 5, stable_id: "m-5", title: "第2章课件", kind: "presentation", pages: 12 }],
            points: [{ id: 81, stable_id: "kp-81", chapter_id: 17, title: "表达式", section: "2.1", brief: "", question_count: 0, sources: [] }],
          },
        ],
      });
    }
    if (url.pathname.endsWith("/course-studio/jobs")) {
      return json({
        jobs: [
          {
            id: "job-coding-done",
            course_instance_id: 12,
            kind: "coding_exercises_generate",
            scope_key: "chapter:17:coding_exercises",
            status: "done",
            progress: { done: 3, total: 3, message: "已完成：新增 2 道已验编程题草稿（1 道未通过自动验题）" },
            result: {
              chapter_id: 17,
              created: 2,
              skipped: 0,
              failed: 1,
              failures: ["第 3 题（程序设计 · 难）：独立盲解输出不一致"],
            },
            error: "",
            cancel_requested: false,
            started_at: "2026-11-27T00:00:00Z",
            finished_at: "2026-11-27T00:01:00Z",
            created_at: "2026-11-27T00:00:00Z",
            updated_at: "2026-11-27T00:01:00Z",
          },
        ],
      });
    }
    if (url.pathname.endsWith("/course-studio/chapters/17/coding-exercises/generate")) {
      submitted.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
      return json(
        {
          id: "job-coding-1",
          course_instance_id: 12,
          kind: "coding_exercises_generate",
          scope_key: "chapter:17:coding_exercises",
          status: "queued",
          progress: { done: 0, total: 3, message: "已加入 AI 编程出题队列" },
          result: null,
          error: "",
          cancel_requested: false,
          started_at: null,
          finished_at: null,
          created_at: "2026-11-27T00:00:00Z",
          updated_at: "2026-11-27T00:00:00Z",
        },
        202,
      );
    }
    return json({});
  });

  history.replaceState({}, "", "/teacher/assessments?course=12&tab=bank");
  const user = userEvent.setup();
  render(<AssessmentsPage courseId={12} />);

  // Freshly generated question displays the "新生成" badge and relative creation time
  expect(await screen.findByText("新生成的编程题")).toBeVisible();
  expect(screen.getByText("新生成")).toBeVisible();
  expect(screen.getByText(/生成于 刚刚/)).toBeVisible();

  expect(screen.queryByRole("button", { name: /AI 出题任务/ })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "AI 智能出题" }));
  await user.click(await screen.findByRole("button", { name: /Python 编程题（自动验题）/ }));

  await user.click(screen.getByRole("combobox", { name: "目标难度" }));
  await user.click(await screen.findByRole("option", { name: /难（高思维密度与综合逻辑）/ }));
  await user.click(screen.getByRole("combobox", { name: "教学用途" }));
  await user.click(await screen.findByRole("option", { name: "测验专用" }));
  await user.type(screen.getByLabelText("语法范围补充约束（可选）"), "仅限顺序结构");
  await user.click(screen.getByRole("button", { name: "表达式" }));

  await user.click(screen.getByRole("button", { name: /生成并自动验题/ }));
  await waitFor(() => expect(submitted).toHaveLength(1));
  expect(submitted[0].path).toBe("/api/teacher/courses/12/course-studio/chapters/17/coding-exercises/generate");
  expect(submitted[0].body).toEqual({
    counts: { fill_code: 1, debug: 1, design: 1 },
    difficulty: "难",
    usage: "assessment",
    knowledge_point_ids: [81],
    allowed_syntax_note: "仅限顺序结构",
    enable_blind_solve: true,
  });
});
