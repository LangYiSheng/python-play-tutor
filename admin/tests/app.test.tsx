import { it, expect, vi, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App";
import { setToken } from "../src/lib/api";
vi.mock("../src/pages/content-list", async () => {
  const { useDraft } = await import("../src/lib/drafts");
  return { ContentListPage: () => { useDraft(true); return <input aria-label="未保存资料" defaultValue="保留草稿" />; } };
});
vi.mock("../src/features/content-workspace/knowledge-graph", () => ({
  KnowledgeGraph: ({ courseId, initialReview }: { courseId: number; initialReview?: { materialId?: number } }) =>
    <><h1>图谱课程 {courseId}</h1>{initialReview && <aside aria-label="待审批">{initialReview.materialId ?? "全部课件"}</aside>}</>,
}));
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setToken(null); history.replaceState({}, "", "/"); });
it("带课程 ID 的审核链接在刷新后仍定位到原资料", async () => {
  setToken("teacher-session");
  history.replaceState({}, "", "/teacher/content-review?course=10&material_id=16");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url.endsWith("/auth/me")
    ? {id: 81, name: "教师", role: "teacher"} : url.endsWith("/teacher/courses") ? [{id: 10, name: "课程甲"}] : [])));
  render(<App/>);
  expect(await screen.findByRole("heading", {name: "图谱课程 10"})).toBeVisible();
  expect(location.pathname).toBe("/teacher/content-graph");
  expect(screen.getByLabelText("待审批")).toHaveTextContent("16");
  expect(screen.queryByLabelText("当前班级")).not.toBeInTheDocument();
});
it("cancelling draft discard prevents class creation and keeps the current class and draft", async () => {
  setToken("test-session");
  history.replaceState({}, "", "/teacher/materials?course=1");
  const create = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") { create(); return json({ id: 2, name: "新班级" }); }
    return json(url.endsWith("/auth/me") ? { id: 1, name: "教师", role: "teacher" } : [{ id: 1, name: "原班级" }]);
  }));
  vi.spyOn(window, "confirm").mockReturnValue(false);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByLabelText("未保存资料");
  expect(location.pathname + location.search).toBe("/teacher/content-list?course=1&tab=materials");
  expect(screen.queryByRole("button", { name: "创建班级" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "班级管理" }));
  expect(window.confirm).toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("当前班级")).not.toBeInTheDocument();
  expect(screen.getByLabelText("未保存资料")).toHaveValue("保留草稿");
});
it("ignores an old account's class list even when its fetch resolves after cancellation", async () => {
  setToken("old-session");
  history.replaceState({}, "", "/teacher/materials?course=1");
  let finishOld!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/auth/me")) return json({ id: 1, name: "旧教师", role: "teacher" });
    if (url.endsWith("/auth/login")) return json({ access_token: "new-session", user: { id: 2, name: "新教师", role: "teacher" } });
    if (new Headers(init.headers).get("Authorization") === "Bearer old-session") return new Promise<Response>((resolve) => { finishOld = resolve; });
    return json([{ id: 22, name: "新班级", teacher_id: 2, teacher_name: "新教师", status: "active", student_count: 0 }]);
  }));
  const user = userEvent.setup();
  render(<App />);
  await waitFor(() => expect(finishOld).toBeDefined());
  act(() => { setToken(null); window.dispatchEvent(new Event("session-expired")); });
  await user.type(screen.getByLabelText("工号", { exact: true }), "9999");
  await user.type(screen.getByLabelText("密码", { exact: true }), "test-password");
  await user.click(screen.getByRole("button", { name: "进入工作台" }));
  expect(location.pathname).toBe("/teacher/courses");
  await screen.findByRole("heading", {name: "新班级"});
  await act(async () => { finishOld(json([{ id: 11, name: "旧课程" }])); });
  expect(screen.queryByRole("heading", {name: "旧课程"})).not.toBeInTheDocument();

});

it("opens the administrator workspace before any class exists", async () => {
  setToken("admin-session");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url.endsWith("/auth/me")
    ? { id: 1, name: "管理员", role: "admin" } : [])));
  render(<App />);
  await screen.findByRole("heading", { name: "课程选择" });
  for (const name of ["全局概览", "教师管理", "学生管理", "全站设置"]) {
    expect(screen.getByRole("link", { name })).toBeVisible();
  }
  expect(screen.queryByRole("link", { name: "课程包" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("当前班级")).not.toBeInTheDocument();
});
it("distinguishes global and classroom navigation and exposes the sidebar's toggle state", async () => {
  setToken("admin-session");
  history.replaceState({}, "", "/teacher/content-graph?course=3");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url.endsWith("/auth/me")
    ? { id: 1, name: "管理员", role: "admin" } : [{ id: 3, name: "一班", teacher_id: 1 }])));
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("heading", { name: "图谱课程 3" });
  expect(screen.queryByLabelText("待审批")).not.toBeInTheDocument();
  for (const group of [
    ["班级管理", "班级概况", "章节开放安排"], ["教师管理", "学生管理", "学生账号"],
    ["全局概览", "教学流程"], ["全站设置", "课程答疑设置"],
  ]) {
    const icons = group.map(name => {
      const icon = screen.getByRole("link", { name }).querySelector("svg");
      expect(icon).toHaveAttribute("aria-hidden", "true");
      return icon!.innerHTML;
    });
    expect(new Set(icons).size).toBe(group.length);
  }
  const toggle = screen.getByRole("button", { name: "收起导航" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toContainElement(screen.getByRole("navigation", { name: "课程导航" }));
  await user.click(toggle);
  expect(screen.getByRole("button", { name: "展开导航" })).toHaveAttribute("aria-expanded", "false");
  await user.click(toggle);
  expect(screen.getByRole("button", { name: "收起导航" })).toHaveAttribute("aria-expanded", "true");
});
it("counts the class teacher's practice pool when an administrator creates an activity", async () => {
  setToken("admin-session");
  history.replaceState({}, "", "/teacher/activities?course=32");
  const question = { kind: "single_choice", status: "ready", chapter_ids: [1], knowledge_point_ids: [11], samples: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth/me")) return json({ id: 1, name: "管理员", role: "admin" });
    if (url.endsWith("/classrooms")) return json([{ id: 7, name: "一班", teacher_id: 9 }]);
    if (url.endsWith("/teacher/courses")) return json([{id: 32, name: "课程", teacher_id: 9}]);
    if (url.endsWith("/catalog")) return json({ chapters: [{ id: 1, title: "第一章" }],
      knowledge_points: [{ id: 11, chapter_id: 1, title: "变量" }], npcs: [], activities: [] });
    if (url.includes("/question-candidates")) return json([
      { ...question, id: "shared", owner_id: null }, { ...question, id: "teacher", owner_id: 9 },
    ]);
    return json([]);
  }));
  const user = userEvent.setup();
  render(<App />);
  const create = await screen.findByRole("button", { name: "新增活动" });
  await waitFor(() => expect(create).toBeEnabled());
  await user.click(create);
  await user.click(screen.getByRole("combobox", { name: "类型" }));
  await user.click(await screen.findByRole("option", { name: "练习" }));
  await user.click(screen.getByRole("tab", { name: "知识点目标" }));
  await user.click(screen.getByRole("checkbox", { name: "变量" }));
  expect(screen.getByRole("spinbutton", { name: /答对总数/ })).toHaveAccessibleName(/可用 2 题/);
});
it("redirects a teacher from an admin deep link without loading site-wide data", async () => {
  setToken("teacher-session");
  history.replaceState({}, "", "/teacher/overview");
  const fetch = vi.fn(async (url: string) => json(url.endsWith("/auth/me")
    ? { id: 2, name: "教师", role: "teacher" } : []));
  vi.stubGlobal("fetch", fetch);
  render(<App />);
  await screen.findByRole("heading", { name: "课程选择" });
  expect(location.pathname).toBe("/teacher/courses");
  expect(screen.queryByRole("link", { name: "全局概览" })).not.toBeInTheDocument();
  expect(fetch.mock.calls.some(([url]) => url.includes("/api/admin/"))).toBe(false);
});

it("课程洞察汇总两班，成绩页按所选班级显示零分、待判定和未交", async () => {
  setToken("teacher-session");
  history.replaceState({}, "", "/teacher/courses");
  const rooms = [{id: 14, name: "下午班", course_id: 80}, {id: 19, name: "晚班", course_id: 80}];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth/me")) return json({id: 1, name: "王老师", role: "teacher"});
    if (url.endsWith("/teacher/courses")) return json([{id: 80, name: "计算思维与人工智能", teacher_name: "王老师", teacher_id: 1}]);
    if (url.endsWith("/classrooms")) return json(rooms);
    if (url.endsWith("/insights")) return json({name: "计算思维与人工智能", teacher: "王老师",
      totals: {classrooms: 2, students: 200, materials: 1, points: 3, questions: 4}, usage: {},
      assistant: {learning: {sessions: 0, messages: 0}, practice: {sessions: 0, messages: 0}}});
    if (url.includes("/activity-report")) {
      const early = url.includes("/14/");
      return json({students: [{id: 5, name: early ? "甲" : "乙", student_id: "00000005", enrolled: true}],
        activities: [{id: "exam", title: "随堂测验", chapter: "第二章", results: early ? {5: {score: 0}} : {}},
                     {id: "quiz", title: "期末测验", chapter: "第三章", results: {5: {assessment_status: "grading"}}}]});
    }
    throw Error("未知测试路径 " + url);
  }));
  const user = userEvent.setup();
  render(<App/>);
  await user.click(await screen.findByRole("button", {name: "进入课程"}));
  expect(await screen.findByText("200")).toBeVisible();
  expect(screen.queryByLabelText("当前班级")).toBeNull();
  await user.click(screen.getByRole("link", {name: "学生成绩"}));
  screen.getByRole("combobox", {name: "当前班级"}).focus();
  await user.keyboard("{ArrowDown}");
  await user.click(await screen.findByRole("option", {name: "下午班"}));
  expect(await screen.findByRole("cell", {name: "0"})).toBeVisible();
  expect(screen.getByRole("cell", {name: "待判定"})).toBeVisible();
  screen.getByRole("combobox", {name: "当前班级"}).focus();
  await user.keyboard("{ArrowDown}");
  await user.click(await screen.findByRole("option", {name: "晚班"}));
  expect(await screen.findByRole("cell", {name: "未交"})).toBeVisible();
  expect(location.search).toBe("?course=80&class=19");
  await act(async () => { history.back(); });
  expect(await screen.findByRole("cell", {name: "0"})).toBeVisible();
});
