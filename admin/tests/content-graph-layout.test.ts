import { describe, expect, it } from "vitest";
import { graphLayout, type GraphData, type GraphQuestion, type Job, type MaterialDetail, type PointDetail } from "@/features/content-workspace/graph-layout";

const data: GraphData = {
  title: "计算思维",
  chapters: [{ id: 3, title: "变量" }],
  materials: [{ id: 4, title: "变量与赋值", status: "ready", kind: "pdf", chapter_ids: [3] }],
};
const point: PointDetail = { id: 5, title: "变量赋值", chapter_id: 3, questions: 6, sources: [{ material_id: 4, pages: [2] }] };
const material: MaterialDetail = { points: [{ ...point, pages: [2] }], pages: 5, narrations: 1, drafts: 1, audio: 0 };

describe("教师课程图谱", () => {
  it("选择章节保留全貌，点进一个知识点后只展开该点及真实来源", () => {
    const chapter = { kind: "chapter" as const, id: 3 };
    const all = graphLayout(data, null, null, []);
    const selected = graphLayout(data, chapter, null, []);
    expect(selected).toEqual(all);
    const selectedPoint = graphLayout(data, chapter, null, [], point);
    expect(selectedPoint.links).toContainEqual({ from: "chapter-3", to: "point-5" });
    expect(selectedPoint.links).toContainEqual({ from: "material-4", to: "point-5" });
    const deck = graphLayout(data, { kind: "material", id: 4 }, material, []);
    expect(deck.cards.map(c => c.key)).toEqual(expect.arrayContaining(["point-5", "narration-4"]));
  });

  it("不同运行的任务节点使用独立身份，失败、中断和取消不显示运行中的动画", () => {
    const task: Job = { id: 12, run_id: 21, material_id: 4, kind: "generate", stage: "script", queued: false,
      done: 2, total: 5, status: "running", percent: 40 };
    const jobs = [task, { ...task, run_id: 19, status: "interrupted" }, { ...task, run_id: 17, status: "failed" },
      { ...task, run_id: 15, status: "cancelled", percent: null, done: 0, total: 0 }];
    const view = graphLayout(data, { kind: "material", id: 4 }, material, jobs);
    const overview = graphLayout(data, null, null, jobs);
    expect(overview.cards.find(c => c.key === "material-4")?.caption).toContain("40%");
    expect(overview.cards.filter(c => c.kind === "task")).toEqual([]);
    expect(view.cards.find(c => c.key === "task-21")?.caption).toContain("40%");
    expect(view.links.filter(l => l.active).map(l => l.to)).toEqual(["task-21"]);
    expect(view.links.filter(l => l.failed).map(l => l.to)).toEqual(["task-19", "task-17"]);
    expect(view.cards.find(c => c.key === "task-15")?.caption).not.toMatch(/%/);
  });

  it("按页展开关联题目，同一道跨知识点题目只有一个节点", () => {
    const question: GraphQuestion = { id: "test-1", title: "变量操作", kind: "boolean", status: "draft", source_type: "imported",
      prompt: "判断赋值表达式", chapter_ids: [3], points: [point, { id: 7, title: "表达式", chapter_id: 3 }], sources: [{ material_id: 4, pages: [2] }] };
    const other = { ...question, id: "test-2" };
    const page = graphLayout(data, null, null, [], point, [question, other], question);
    expect(page.cards.filter(c => c.kind === "question")).toHaveLength(2);
    expect(page.links.filter(l => l.to === "question-test-1").map(l => l.from).sort()).toEqual(["chapter-3", "material-4", "point-5", "point-7"]);
    expect(page.links.filter(l => l.to === "question-test-2")).toEqual([{ from: "point-5", to: "question-test-2" }]);
    expect(graphLayout(data, null, null, [], point, [other]).cards.some(c => c.key === "question-test-1")).toBe(false);
    const orphan = { ...question, points: [], chapter_ids: [], sources: [] };
    const located = graphLayout(data, null, null, [], undefined, [], orphan);
    expect(located.links.filter(l => l.to === "question-test-1")).toEqual([{ from: "course-0", to: "question-test-1" }]);
  });
});
