import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiGenerateDialog } from "../src/features/assessments/ai-generate-dialog";

const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

it("renders wide section-grouped quota matrix with quick-fill and submits point quotas", async () => {
  const submittedBodies: unknown[] = [];
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/course-studio/knowledge")) {
      return json({
        chapters: [
          {
            id: 1,
            stable_id: "ch-1",
            title: "计算思维",
            order_index: 1,
            materials: [{ id: 2, stable_id: "m-2", title: "第一章课件", kind: "presentation", pages: 35 }],
            points: [
              {
                id: 11,
                stable_id: "kp-11",
                chapter_id: 1,
                title: "早期计算工具演变",
                section: "1.1 计算工具演变",
                brief: "算筹与算盘",
                question_count: 3,
                sources: [{ material_id: 2, material_title: "第一章课件", pages: [4, 5] }],
              },
              {
                id: 12,
                stable_id: "kp-12",
                chapter_id: 1,
                title: "机械式计算工具",
                section: "1.1 计算工具演变",
                brief: "帕斯卡加法器",
                question_count: 0,
                sources: [{ material_id: 2, material_title: "第一章课件", pages: [7, 8] }],
              },
              {
                id: 13,
                stable_id: "kp-13",
                chapter_id: 1,
                title: "计算思维的特征",
                section: "1.2 计算思维概述",
                brief: "抽象与自动化",
                question_count: 1,
                sources: [{ material_id: 2, material_title: "第一章课件", pages: [34, 35] }],
              },
            ],
          },
        ],
      });
    }
    if (url.pathname.endsWith("/exercises/generate") && init?.method === "POST") {
      submittedBodies.push(JSON.parse(String(init.body)));
      return json({ id: "job-1", kind: "exercise_generate", status: "queued" });
    }
    return json({});
  });

  const onSubmitted = vi.fn();
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  render(<AiGenerateDialog open courseId={7} onOpenChange={onOpenChange} onSubmitted={onSubmitted} />);

  await user.click(await screen.findByRole("button", { name: /按知识点配额（3）/ }));

  // Grouped section headers and existing question counts render in compact matrix (without numeric prefixes)
  expect(screen.getByRole("table")).toBeVisible();
  expect(screen.getByText("计算工具演变")).toBeVisible();
  expect(screen.getByText("计算思维概述")).toBeVisible();
  expect(screen.queryByText("1.1 计算工具演变")).not.toBeInTheDocument();

  // Filter by section and quick-fill +1 single choice for that section only
  await user.click(screen.getByRole("combobox", { name: "按小节筛选" }));
  await user.click(await screen.findByRole("option", { name: "计算工具演变" }));
  expect(screen.queryByText("计算思维的特征")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /各 \+1 单选/ }));
  expect(screen.getByText("已配 2 个知识点 · 共 2 题")).toBeVisible();

  // Directly edit one cell (multiple choice for 机械式计算工具)
  const multiInput = screen.getByLabelText("机械式计算工具 多选题");
  await user.clear(multiInput);
  await user.type(multiInput, "2");
  expect(screen.getByText("已配 2 个知识点 · 共 4 题")).toBeVisible();

  // Submit sends exact point_quotas payload
  await user.click(screen.getByRole("button", { name: "开始生成草稿" }));
  await waitFor(() => expect(submittedBodies).toHaveLength(1));
  expect(submittedBodies[0]).toEqual({
    point_quotas: [
      { knowledge_point_id: 11, single: 1, multiple: 0, true_false: 0, fill_blank: 0 },
      { knowledge_point_id: 12, single: 1, multiple: 2, true_false: 0, fill_blank: 0 },
    ],
  });
  expect(onSubmitted).toHaveBeenCalledOnce();
});

it("defaults chapter mode to 10 questions, applies presets, and sends chosen difficulty", async () => {
  const submittedBodies: unknown[] = [];
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const url = new URL(path, location.origin);
    if (url.pathname.endsWith("/course-studio/knowledge")) {
      return json({
        chapters: [
          {
            id: 1,
            stable_id: "ch-1",
            title: "函数与作用域",
            order_index: 1,
            materials: [{ id: 2, stable_id: "m-2", title: "函数课件", kind: "presentation", pages: 20 }],
            points: [],
          },
        ],
      });
    }
    if (url.pathname.endsWith("/exercises/generate") && init?.method === "POST") {
      submittedBodies.push(JSON.parse(String(init.body)));
      return json({ id: "job-2", kind: "exercises_generate", status: "queued" });
    }
    return json({});
  });

  const user = userEvent.setup();
  render(<AiGenerateDialog open courseId={7} onOpenChange={() => {}} onSubmitted={() => {}} />);

  expect(await screen.findByLabelText("单选题")).toHaveValue(4);
  await user.click(screen.getByRole("button", { name: "强化 16 题" }));
  expect(screen.getByLabelText("单选题")).toHaveValue(6);

  await user.click(screen.getByLabelText("难度定位"));
  await user.click(await screen.findByRole("option", { name: /综合拔高/ }));

  await user.click(screen.getByRole("button", { name: "开始生成草稿" }));
  await waitFor(() => expect(submittedBodies).toHaveLength(1));
  expect(submittedBodies[0]).toEqual({
    difficulty: "challenging",
    counts: { single: 6, multiple: 4, true_false: 3, fill_blank: 3 },
  });
});
