import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InsightsPage } from "@/features/analytics/insights-page";
import { TaskDetailsPage } from "@/features/analytics/details-page";
import { GradesPage } from "@/features/analytics/grades-page";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("learning analytics pages", () => {
  it("renders course insights KPIs, funnel, class comparison and hotspots", async () => {
    const onOpenClass = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          name: "Python小镇：计算工具与计算思维",
          teacher: "王老师",
          totals: { classrooms: 2, students: 100, chapters: 2, materials: 10, points: 20, questions: 30 },
          usage: { learning: 45, practice: 30, assessment: 20 },
          assistant: { learning: { sessions: 4, messages: 12 }, practice: { sessions: 3, messages: 9 } },
          active_students: 60,
          assistant_students: 5,
          completion: {
            required_completed: 90,
            required_total: 150,
            open_classroom_count: 2,
            by_stage: {
              reading: { completed: 40, total: 50 },
              objective: { completed: 30, total: 50 },
              programming: { completed: 0, total: 0 },
              assessment: { completed: 20, total: 50 },
            },
          },
          assessment_summary: {
            expected: 50,
            submitted: 22,
            graded: 20,
            grading: 2,
            attention: 0,
            average_score: 82.5,
            pass_count: 18,
          },
          chapters: [
            {
              id: 1,
              title: "第一章 初识计算",
              order_index: 1,
              open_classrooms: 2,
              target_students: 100,
              stages: {
                reading: { task_count: 1, completed: 40, total: 50 },
                objective: { task_count: 1, completed: 30, total: 50 },
                programming: { task_count: 0, completed: 0, total: 0 },
                assessment: { task_count: 1, completed: 20, total: 50 },
              },
            },
            {
              id: 2,
              title: "第二章 尚未开放章节",
              order_index: 2,
              open_classrooms: 0,
              target_students: 0,
              stages: {
                reading: { task_count: 1, completed: 0, total: 0 },
                objective: { task_count: 0, completed: 0, total: 0 },
                programming: { task_count: 0, completed: 0, total: 0 },
                assessment: { task_count: 0, completed: 0, total: 0 },
              },
            },
          ],
          classrooms: [
            {
              id: 11,
              name: "计科一班",
              student_count: 50,
              active_students: 35,
              open_chapters: 1,
              total_chapters: 2,
              required_completed: 60,
              required_total: 75,
              assessment_submitted: 15,
              assessment_expected: 25,
              average_score: 86,
              assistant_messages: 14,
            },
          ],
          difficult_questions: [
            {
              question_id: "q1",
              title: "二进制进位计算",
              kind: "single_choice",
              chapter_title: "第一章 初识计算",
              attempts: 40,
              learners: 25,
              failed_attempts: 18,
              accepted_learners: 15,
              appended_count: 6,
            },
          ],
          assistant_hotspots: [
            {
              key: "material:3",
              kind: "material",
              title: "计算机简史课件",
              chapter_title: "第一章 初识计算",
              learners: 4,
              sessions: 4,
              messages: 12,
            },
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    render(<InsightsPage courseId={1} onOpenClassAnalytics={onOpenClass} />);

    expect(await screen.findByText("82.5 分")).toBeVisible();
    expect(screen.getByText("章节推进总览")).toBeVisible();
    expect(screen.getAllByText("第一章 初识计算").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("第二章 尚未开放章节")).toBeNull();
    expect(screen.getByText("二进制进位计算")).toBeVisible();
    expect(screen.getByText("计算机简史课件")).toBeVisible();
    expect(screen.getByText("计科一班")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /成绩册/ }));
    expect(onOpenClass).toHaveBeenCalledWith(11, "grades");
  });

  it("switches between task list and student matrix and opens task sheet drawer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          total_chapters: 2,
          open_chapters: 1,
          students: [
            { id: 1, student_id: "20260001", name: "张同学", enrolled: true },
            { id: 2, student_id: "20260002", name: "李同学", enrolled: true },
          ],
          activities: [
            {
              id: "prac-1",
              title: "变量随堂练习",
              chapter: "第一章",
              kind: "objective",
              required: true,
              material_titles: {},
              opened: true,
              completed: 1,
              in_progress: 1,
              results: {
                1: { completed: true, accepted: 5, assigned: 5 },
                2: { completed: false, accepted: 2, assigned: 6, appended: 1 },
              },
            },
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    render(<TaskDetailsPage classroomId={9} />);

    expect(await screen.findByText("1 / 2 人完成（50%）")).toBeVisible();
    expect(screen.queryByRole("button", { name: /列设置/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /查看学生/ }));
    expect(await screen.findByText("含错题补题 +1")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "关闭抽屉" }));
    await user.click(screen.getByRole("tab", { name: /学生矩阵/ }));
    expect(await screen.findByText("张同学")).toBeVisible();
    expect(screen.getByText("已通过 2 / 6 题")).toBeVisible();
  });

  it("computes exam distribution, sorts students by average and opens student sheet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/activity-report")) {
          return Response.json({
            students: [
              { id: 1, student_id: "20260001", name: "甲同学", enrolled: true },
              { id: 2, student_id: "20260002", name: "乙同学", enrolled: true },
              { id: 3, student_id: "20260003", name: "丙同学", enrolled: true },
            ],
            activities: [
              {
                id: "exam-1",
                title: "第一单元测验",
                chapter: "第一章",
                kind: "assessment",
                required: true,
                material_titles: {},
                opened: true,
                completed: 2,
                results: {
                  1: { completed: true, score: 50, assessment_status: "graded" },
                  2: { completed: true, score: 80, assessment_status: "graded" },
                  3: { completed: false, score: null, assessment_status: "grading" },
                },
              },
            ],
          });
        }
        return Response.json({
          student: { name: "乙同学", student_id: "20260002" },
          assessments: [
            { id: "a1", activity_id: "exam-1", activity_title: "第一单元测验", score: 90, max_score: 100, status: "graded" },
          ],
          chapters: [],
          participation: [],
          submissions: [
            {
              id: "s1",
              question_id: "q-uuid",
              question_title: "求列表偶数和",
              question_kind: "python",
              activity_title: "第一单元测验",
              mode: "submit",
              status: "accepted",
              answer: null,
              code: "print(sum(x for x in nums if x % 2 == 0))",
              feedback: {},
              created_at: "2026-11-27T02:00:00Z",
            },
          ],
        });
      }),
    );

    const user = userEvent.setup();
    render(<GradesPage classroomId={9} classroomName="计科一班" />);

    expect((await screen.findAllByText("65 分")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /导出 CSV 成绩单/ })).toBeVisible();

    screen.getByRole("combobox", { name: "成绩排序" }).focus();
    await user.keyboard("{ArrowDown}");
    await user.click(await screen.findByRole("option", { name: "按个人均分从高到低" }));
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText(/乙同学/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /乙同学 · 20260002/ }));
    expect(await screen.findByText("乙同学的学习记录")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "作答记录" }));
    expect(await screen.findByText("求列表偶数和")).toBeVisible();
  });
});
