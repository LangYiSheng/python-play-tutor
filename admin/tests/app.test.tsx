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
  KnowledgeGraph: ({ classroomId, initialReview }: { classroomId: number; initialReview?: { chapterId?: number; materialId?: number } }) =>
    <><h1>图谱班级 {classroomId}</h1>{initialReview && <aside aria-label="待审批">{initialReview.chapterId ?? "全部章节"} / {initialReview.materialId ?? "全部资料"}</aside>}</>,
}));
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setToken(null); history.replaceState({}, "", "/"); });
it("保留待审批直达链接与班级切换，切班清除旧章节和资料筛选", async () => {
  setToken("teacher-session");
  history.replaceState({}, "", "/teacher/content-review?chapter_id=9&material_id=16");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url.endsWith("/auth/me")
    ? {id: 81, name: "教师", role: "teacher"} : [{id: 10, name: "甲班"}, {id: 12, name: "乙班"}])));
  render(<App/>);
  expect(await screen.findByRole("heading", {name: "图谱班级 10"})).toBeVisible();
  expect(location.pathname + location.search).toBe("/teacher/content-graph");
  expect(screen.getByLabelText("待审批")).toHaveTextContent("9 / 16");
  expect(screen.queryByRole("link", {name: "待审批"})).not.toBeInTheDocument();
  expect(screen.getByRole("link", {name: "知识图谱"})).toHaveAttribute("aria-current", "page");
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", {name: "当前班级"}));
  await user.click(await screen.findByRole("option", {name: "乙班"}));
  expect(await screen.findByRole("heading", {name: "图谱班级 12"})).toBeVisible();
  expect(screen.getByLabelText("待审批")).toHaveTextContent("全部章节 / 全部资料");
});
it("cancelling draft discard prevents class creation and keeps the current class and draft", async () => {
  setToken("test-session");
  history.replaceState({}, "", "/teacher/materials");
  const create = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") { create(); return json({ id: 2, name: "新班级" }); }
    return json(url.endsWith("/auth/me") ? { id: 1, name: "教师", role: "teacher" } : [{ id: 1, name: "原班级" }]);
  }));
  vi.spyOn(window, "confirm").mockReturnValue(false);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByLabelText("未保存资料");
  expect(location.pathname + location.search).toBe("/teacher/content-list?tab=materials");
  expect(screen.queryByRole("button", { name: "创建班级" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "班级管理" }));
  expect(window.confirm).toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByLabelText("当前班级")).toHaveTextContent("原班级");
  expect(screen.getByLabelText("未保存资料")).toHaveValue("保留草稿");
});
it("ignores an old account's class list even when its fetch resolves after cancellation", async () => {
  setToken("old-session");
  history.replaceState({}, "", "/teacher/materials");
  let finishOld!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/auth/me")) return json({ id: 1, name: "旧教师", role: "teacher" });
    if (url.endsWith("/auth/login")) return json({ access_token: "new-session", user: { id: 2, name: "新教师", role: "teacher" } });
    if (new Headers(init.headers).get("Authorization") === "Bearer old-session") return new Promise<Response>((resolve) => { finishOld = resolve; });
    return json([{ id: 22, name: "新班级" }]);
  }));
  const user = userEvent.setup();
  render(<App />);
  await waitFor(() => expect(finishOld).toBeDefined());
  act(() => { setToken(null); window.dispatchEvent(new Event("session-expired")); });
  await user.type(screen.getByLabelText("学号", { exact: true }), "9999");
  await user.type(screen.getByLabelText("密码", { exact: true }), "test-password");
  await user.click(screen.getByRole("button", { name: "进入工作台" }));
  await waitFor(() => expect(screen.getByLabelText("当前班级")).toHaveTextContent("新班级"));
  await act(async () => { finishOld(json([{ id: 11, name: "旧班级" }])); });
  expect(screen.getByLabelText("当前班级")).toHaveTextContent("新班级");
  await user.click(screen.getByLabelText("当前班级"));
  expect(await screen.findByRole("option", { name: "新班级" })).toBeVisible();
  expect(screen.queryByRole("option", { name: "旧班级" })).not.toBeInTheDocument();
});

it("opens the administrator workspace before any class exists", async () => {
  setToken("admin-session");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url.endsWith("/auth/me")
    ? { id: 1, name: "管理员", role: "admin" } : [])));
  render(<App />);
  await screen.findByRole("heading", { name: "班级管理" });
  for (const name of ["全局概览", "教师管理", "学生管理", "全站设置"]) {
    expect(screen.getByRole("link", { name })).toBeVisible();
  }
  expect(screen.queryByRole("link", { name: "课程包" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("当前班级")).not.toBeInTheDocument();
});
it("distinguishes global and classroom navigation and exposes the sidebar's toggle state", async () => {
  setToken("admin-session");
  history.replaceState({}, "", "/teacher/content-graph");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url.endsWith("/auth/me")
    ? { id: 1, name: "管理员", role: "admin" } : [{ id: 3, name: "一班", teacher_id: 1 }])));
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("heading", { name: "图谱班级 3" });
  expect(screen.queryByLabelText("待审批")).not.toBeInTheDocument();
  for (const group of [
    ["班级管理", "班级概况", "教学管理"], ["教师管理", "学生管理", "学生账号"],
    ["全局概览", "教学流程"], ["全站设置", "本班答疑设置"],
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
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toContainElement(screen.getByRole("navigation", { name: "班级导航" }));
  await user.click(toggle);
  expect(screen.getByRole("button", { name: "展开导航" })).toHaveAttribute("aria-expanded", "false");
  await user.click(toggle);
  expect(screen.getByRole("button", { name: "收起导航" })).toHaveAttribute("aria-expanded", "true");
});
it("counts the class teacher's practice pool when an administrator creates an activity", async () => {
  setToken("admin-session");
  history.replaceState({}, "", "/teacher/activities");
  const question = { kind: "single_choice", status: "ready", chapter_ids: [1], knowledge_point_ids: [11], samples: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth/me")) return json({ id: 1, name: "管理员", role: "admin" });
    if (url.endsWith("/classrooms")) return json([{ id: 7, name: "一班", teacher_id: 9 }]);
    if (url.includes("/teacher/courses")) return json({ chapters: [{ id: 1, title: "第一章" }],
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
it("rejects an admin deep link for teachers without loading site-wide data", async () => {
  setToken("teacher-session");
  history.replaceState({}, "", "/teacher/overview");
  const fetch = vi.fn(async (url: string) => json(url.endsWith("/auth/me")
    ? { id: 2, name: "教师", role: "teacher" } : []));
  vi.stubGlobal("fetch", fetch);
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent("此页面仅管理员可访问");
  expect(screen.queryByRole("link", { name: "全局概览" })).not.toBeInTheDocument();
  expect(fetch.mock.calls.some(([url]) => url.includes("/api/admin/"))).toBe(false);
});
