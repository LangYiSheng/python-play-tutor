import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KnowledgeGraph } from "../src/features/content-workspace/knowledge-graph";
import { cleanGraphLabel } from "../src/features/content-workspace/studio-graph-layout";

const overview = {
  chapters: [
    {
      id: 17,
      stable_id: "ch-17",
      title: "基础语法",
      order_index: 1,
      materials: [{ id: 9, stable_id: "m-9", title: "变量课件", kind: "presentation", pages: 12 }],
      points: [
        {
          id: 81,
          stable_id: "kp-81",
          chapter_id: 17,
          title: "变量定义",
          section: "1.1 变量",
          brief: "命名与赋值",
          question_count: 3,
          sources: [{ material_id: 9, material_title: "变量课件", pages: [1, 2] }],
        },
      ],
    },
  ],
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  history.replaceState({}, "", "/");
});

it("renders PPT knowledge graph in tree/radial/list views and triggers AI extraction", async () => {
  const extracted: string[] = [];
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/course-graph")) {
      return json({
        title: "Python 基础课",
        chapters: [{ id: 17, title: "基础语法", order_index: 1 }],
        materials: [{ id: 9, title: "变量课件", kind: "presentation", status: "ready", chapter_ids: [17] }],
      });
    }
    if (url.pathname.endsWith("/course-graph/tasks")) return json([]);
    if (url.pathname.endsWith("/content-review/summary")) return json({ material_count: 0, question_count: 0 });
    if (url.pathname.endsWith("/course-studio/jobs")) {
      return json({
        jobs: [
          {
            id: "job-kp-0",
            course_instance_id: 1,
            kind: "knowledge_extract",
            scope_key: "ch:17",
            status: "done",
            progress: { done: 1, total: 1, message: "已完成：新增 1 个知识点" },
            result: { created: 1, updated: 0 },
            error: "",
            cancel_requested: false,
            started_at: null,
            finished_at: null,
            created_at: "2026-11-24T00:00:00Z",
            updated_at: "2026-11-24T00:00:00Z",
          },
          {
            id: "job-ex-0",
            course_instance_id: 1,
            kind: "exercises_generate",
            scope_key: "ch:17",
            status: "done",
            progress: { done: 1, total: 1, message: "已完成：新增 4 道待审题目" },
            result: { created: 4 },
            error: "",
            cancel_requested: false,
            started_at: null,
            finished_at: null,
            created_at: "2026-11-24T00:00:00Z",
            updated_at: "2026-11-24T00:00:00Z",
          },
        ],
      });
    }
    if (url.pathname.endsWith("/course-studio/knowledge")) return json(overview);
    if (url.pathname.endsWith("/questions")) return json({ items: [], total: 0, page: 1 });
    if (url.pathname.endsWith("/course-studio/chapters/17/knowledge/extract") && init?.method === "POST") {
      extracted.push(url.pathname);
      return json(
        {
          id: "job-kp-1",
          course_instance_id: 1,
          kind: "knowledge_extract",
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
    return json({});
  });

  const user = userEvent.setup();
  render(<KnowledgeGraph courseId={12} />);

  // Tree view renders SVG with PPT section + knowledge point nodes and keeps chapter/section names free of numbering prefixes
  expect(await screen.findByRole("img", { name: "PPT 知识点图谱画布" })).toBeVisible();
  expect(screen.queryByText(/第 1 章 ·/)).not.toBeInTheDocument();
  expect(screen.queryByText(/1\.1/)).not.toBeInTheDocument();
  expect(screen.getByText("变量")).toBeVisible();
  expect(screen.getByText("变量定义")).toBeVisible();

  // Clicking a knowledge point node opens its PPT source, brief details & delete button in the inspector
  await user.click(screen.getByText("变量定义"));
  expect(await screen.findByText("命名与赋值")).toBeVisible();
  expect(screen.getByText("变量课件")).toBeVisible();
  expect(screen.getByRole("button", { name: "删除知识点" })).toBeVisible();

  // Switch to radial view
  await user.click(screen.getByRole("button", { name: "环形" }));
  expect(screen.getByRole("button", { name: "环形" })).toHaveAttribute("aria-pressed", "true");

  // Top toolbar has prominent AI 生成知识图谱 entry
  await user.click(screen.getByRole("button", { name: "AI 生成知识图谱" }));
  await user.click(await screen.findByRole("button", { name: "开始生成知识图谱" }));
  await waitFor(() => expect(extracted).toEqual(["/api/teacher/courses/12/course-studio/chapters/17/knowledge/extract"]));

  // Task drawer on KnowledgeGraph only shows knowledge_extract jobs (never exercises or TTS)
  expect(await screen.findByText("AI 知识点抽取")).toBeVisible();
  expect(screen.queryByText("AI 智能出题")).not.toBeInTheDocument();
  expect(screen.queryByText("语音合成")).not.toBeInTheDocument();

  // Switch to list view & trigger AI knowledge extraction
  await user.click(screen.getByRole("button", { name: "列表" }));
  expect(await screen.findByRole("link", { name: "查看题目（3）" })).toHaveAttribute(
    "href",
    expect.stringContaining("/teacher/assessments?course=12&tab=bank&point=81"),
  );
  expect(location.search).toBe("?view=list");

  await user.click(screen.getByRole("button", { name: "AI 抽取知识点" }));
  await waitFor(() => expect(extracted).toHaveLength(2));
});

it("strips leading numeric/chapter/section prefixes while preserving normal numbers in titles", () => {
  expect(cleanGraphLabel("10.1 文本数据处理")).toBe("文本数据处理");
  expect(cleanGraphLabel("10.2 图像数据处理")).toBe("图像数据处理");
  expect(cleanGraphLabel("1.1.2 局部变量")).toBe("局部变量");
  expect(cleanGraphLabel("第一节 变量概念")).toBe("变量概念");
  expect(cleanGraphLabel("一、程序设计基础")).toBe("程序设计基础");
  expect(cleanGraphLabel("0和1的思维与逻辑运算")).toBe("0和1的思维与逻辑运算");
  expect(cleanGraphLabel("10.1")).toBe("10.1");
});
