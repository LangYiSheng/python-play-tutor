import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { sameRecipe, type CatalogChapter, type Recipe } from "../src/features/quick-orchestration/contracts";
import { QuestionPlanEditor } from "../src/features/quick-orchestration/question-plan-editor";
import {
  applyPerPointToInherited, kindProblem, quotaProblems, stageCount, stageSummary, withoutAssessmentPlan, withSelectedPoints,
} from "../src/features/quick-orchestration/question-plan";

const catalog: CatalogChapter[] = Array.from({ length: 12 }, (_, ch) => ({
  id: `chapter-${ch}`, title: `第${ch + 1}章`, materials: [],
  knowledge_points: Array.from({ length: 10 }, (_, point) => ({
    id: `p-${ch}-${point}`, title: `知识点 ${point + 1}`,
    available_questions: { practice: { single_choice: 2, boolean: 1 }, assessment: { single_choice: 1, fill: 1 } },
  })),
}));
function recipe(): Recipe {
  return {
    template_id: "learn-practice-quiz", practice_count: 1, quiz_count: 2,
    chapters: catalog.map(ch => ({
      chapter_id: ch.id, material_ids: [], knowledge_point_ids: ch.knowledge_points.map(p => p.id),
    })),
  };
}

it("keeps old saved totals per chapter and bulk-fills only inheriting chapters in the selected stage", () => {
  const original = recipe();
  original.chapters[0].question_plan = { practice: { mode: "total", count: 3, by_kind: { fill: 3 } } };
  expect(stageSummary(original, original.chapters[1], "practice")).toBe("整章最多 1 题（课程默认）");
  const next = applyPerPointToInherited(original, "practice", 2);
  expect(next.chapters[0].question_plan).toEqual(original.chapters[0].question_plan);
  expect(stageCount(next, next.chapters[11], "practice")).toBe(20);
  const expanded = withSelectedPoints(next.chapters[11], [...next.chapters[11].knowledge_point_ids, "new-point"]);
  expect(stageCount(next, expanded, "practice")).toBe(22);
  expect(next.chapters[11].question_plan?.assessment).toBeUndefined();
  expect(stageCount(next, next.chapters[11], "assessment")).toBe(2);
  expect(stageCount(original, original.chapters[11], "practice")).toBe(1);
});

it("reconciles point changes, excludes a stage cleanly, and compares detailed settings on save/refresh", () => {
  const original = recipe();
  const first = original.chapters[0];
  first.question_plan = { practice: { mode: "by_point", points: [
    { knowledge_point_id: "keep", count: 2, by_kind: { boolean: 0, python: 1 } },
    { knowledge_point_id: "old", count: 3 },
  ] }, assessment: { mode: "total", count: 1 } };
  const updated = withSelectedPoints(first, ["new", "keep"]);
  expect(updated.question_plan?.practice).toEqual({ mode: "by_point", points: [
    { knowledge_point_id: "new", count: 1 }, { knowledge_point_id: "keep", count: 2, by_kind: { boolean: 0, python: 1 } },
  ] });
  expect(withoutAssessmentPlan(updated).question_plan).toEqual({ practice: updated.question_plan?.practice });
  const equivalent = structuredClone(original);
  const rule = equivalent.chapters[0].question_plan!.practice!;
  if (rule.mode !== "by_point") throw Error();
  rule.points[0].by_kind = { python: 1, boolean: 0 };
  expect(sameRecipe(original, equivalent)).toBe(true);
  delete rule.points[0].by_kind.boolean;
  expect(sameRecipe(original, equivalent)).toBe(false);
});

it("names chapter and point for inconsistent type totals and enforces the aggregate cap", () => {
  const value = applyPerPointToInherited(recipe(), "practice", 11);
  const rule = value.chapters[1].question_plan!.practice!;
  if (rule.mode !== "by_point") throw Error();
  rule.points[0].by_kind = { single_choice: 12 };
  expect(quotaProblems(value, true, catalog)).toContain("《第2章》练习 · 知识点 1：指定题型共 12 题，超过题数 11。请调整题型或总数。");
  expect(quotaProblems(value, true, catalog)).toContain("《第1章》练习共需 1 至 100 题。");
  expect(kindProblem(4, { single_choice: 0, multiple_choice: 1, boolean: 1, fill: 0, python: 1 })).toContain("还差 1 题");
  expect(kindProblem(4, { python: 0 })).toBe("");
});

it("edits one chapter, point and stage at a time and distinguishes a blank type from an explicit zero", async () => {
  const user = userEvent.setup();
  let latest: Recipe = recipe();
  function Editor() {
    const [value, setValue] = useState(latest);
    return <QuestionPlanEditor recipe={value} chapters={catalog} withQuiz onChange={next => { latest = next; setValue(next); }} />;
  }
  render(<Editor />);
  expect(screen.getByText(/本章所选知识点合计最多 1 道练习题/)).toBeVisible();
  await user.type(screen.getByRole("searchbox", { name: "查找章节题量" }), "第12章");
  await user.click(screen.getByRole("radio", { name: "按知识点分配" }));
  const selection = () => latest.chapters[11];
  expect(stageCount(latest, selection(), "practice")).toBe(10);
  await user.type(screen.getByRole("searchbox", { name: "查找知识点题量" }), "10");
  await user.clear(screen.getByRole("spinbutton", { name: "该知识点题数" }));
  await user.type(screen.getByRole("spinbutton", { name: "该知识点题数" }), "2");
  await user.click(screen.getByText("指定题型数量"));
  await user.type(screen.getByRole("spinbutton", { name: "单选题" }), "0");
  await user.type(screen.getByRole("spinbutton", { name: "判断题" }), "3");
  expect(screen.getByText("可用 1 题，缺 2 题")).toBeVisible();
  expect(quotaProblems(latest, true, catalog)).toHaveLength(1);
  await user.clear(screen.getByRole("spinbutton", { name: "判断题" }));
  expect(quotaProblems(latest, true, catalog)).toEqual([]);
  const rule = selection().question_plan?.practice;
  expect(rule?.mode === "by_point" && rule.points[9].by_kind).toEqual({ single_choice: 0 });
  await user.click(screen.getByRole("tab", { name: "测验" }));
  expect(screen.getByText(/本章所选知识点合计最多 2 道测验题/)).toBeVisible();
  await user.click(screen.getByRole("radio", { name: "自定本章总题数" }));
  await user.clear(screen.getByRole("spinbutton", { name: "本章测验总题数" }));
  await user.type(screen.getByRole("spinbutton", { name: "本章测验总题数" }), "4");
  expect(stageCount(latest, selection(), "assessment")).toBe(4);
  expect(stageCount(latest, selection(), "practice")).toBe(11);
  expect(latest.chapters[0].question_plan).toBeUndefined();
  const defaults = within(screen.getByRole("region", { name: "课程默认题量" }));
  await user.click(defaults.getByText("按知识点批量设置"));
  await user.click(defaults.getByRole("button", { name: "应用到 11 个默认章节" }));
  expect(stageCount(latest, latest.chapters[0], "practice")).toBe(10);
  expect(stageCount(latest, selection(), "practice")).toBe(11);
  expect(defaults.getByRole("spinbutton", { name: "每章练习总题数" })).toHaveAccessibleDescription("0/12 章沿用");
  expect(defaults.getByRole("spinbutton", { name: "每章测验总题数" })).toHaveAccessibleDescription("11/12 章沿用");
  await user.click(screen.getByRole("button", { name: "批量恢复默认" }));
  await user.click(screen.getByRole("checkbox", { name: "勾选第12章" }));
  await user.click(screen.getByRole("button", { name: "所选章节恢复默认测验" }));
  expect(selection().question_plan?.assessment).toBeUndefined();
  expect(stageCount(latest, selection(), "practice")).toBe(11);
  await user.click(screen.getByRole("tab", { name: "练习" }));
  await user.clear(screen.getByRole("searchbox", { name: "查找章节题量" }));
  await user.click(screen.getByRole("button", { name: "批量恢复默认" }));
  await user.click(screen.getByRole("checkbox", { name: "全选章节" }));
  await user.click(screen.getByRole("button", { name: "所选章节恢复默认练习" }));
  expect(latest.chapters.every(row => !row.question_plan?.practice)).toBe(true);
});
