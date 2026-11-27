import { it, expect, vi, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App";
import { setToken } from "../src/lib/api";
vi.mock("../src/features/courseware/courseware-page", async () => {
  const { useDraft } = await import("../src/lib/drafts");
  return { CoursewarePage: () => { useDraft(true); return <input aria-label="未保存资料" defaultValue="保留草稿" />; } };
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
  expect(location.pathname + location.search).toBe("/teacher/courseware?course=1");
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
    ? { id: 1, name: "管理员", role: "admin" } : url.endsWith("/admin/overview") ? {items: []} : [])));
  render(<App />);
  await screen.findByRole("heading", { name: "课程选择" });
  expect(screen.queryByRole("link", { name: "教师管理" })).toBeNull();
  await userEvent.click(screen.getByRole("link", { name: "进入后台" }));
  for (const name of ["全局概览", "课程管理", "班级管理", "课程包管理", "教师管理", "学生管理", "资料合成管理", "评测管理", "全站设置"]) {
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
    ["班级管理", "学情统计", "定时开放"], ["章节与课件", "题库与组卷", "学习任务", "设置"],
  ]) {
    const icons = group.map(name => {
      const role = ["学情统计", "设置"].includes(name) ? "button" : "link";
      const icon = screen.getByRole(role, { name }).querySelector("svg");
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
  const stats = screen.getByRole("button", { name: "学情统计" });
  await user.click(stats);
  expect(stats).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("link", { name: "学生成绩" })).toBeVisible();
  await user.click(stats);
  expect(screen.queryByRole("link", { name: "学生成绩" })).toBeNull();
  expect(location.pathname).toBe("/teacher/content-graph");
  expect(screen.getByRole("button", { name: "收起导航" })).toHaveAttribute("aria-expanded", "true");
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
  expect(screen.getByRole("combobox", {name:"当前班级"})).toHaveTextContent("下午班");
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


it("shows only the signed-in teacher's courses, exports from the card and opens the account menu", async () => {
  setToken("teacher-session");
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/auth/me")) return json({id: 7, name: "林老师", role: "teacher"});
    if (url.endsWith("/teacher/courses")) return json([{id: 31, name: "循环", teacher_id: 7}, {id: 32, name: "另一门课", teacher_id: 9}]);
    if (url.endsWith("/classrooms")) return json([{id: 21, course_id:31, name:"周四班"}]);
    return json({});
  });
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(<App/>);
  await screen.findByRole("heading", {name:"循环"});
  expect(screen.getByText(/教学班 · 周四班/)).toBeVisible();
  expect(screen.queryByRole("heading", {name:"另一门课"})).toBeNull();
  expect(screen.queryByRole("link", {name:"进入后台"})).toBeNull();
  await user.click(screen.getByRole("button", {name:"循环的更多操作"}));
  await user.click(await screen.findByRole("menuitem", {name:"导出课程包"}));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/teacher/courses/31/export", expect.anything()));
  await user.click(screen.getByRole("button", {name:/欢迎，林老师/}));
  expect(await screen.findByRole("menuitem", {name:"修改密码"})).toBeVisible();
  expect(screen.getByRole("menuitem", {name:"退出账号"})).toBeVisible();
});


it("requires a course source and uses the selected package when creating from the first card", async () => {
  setToken("teacher-session");
  const writes: {url: string; body: Record<string, unknown>}[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") { writes.push({url, body: JSON.parse(String(init.body))}); return json({id:42}); }
    if (url.endsWith("/auth/me")) return json({id: 7, name: "林老师", role: "teacher"});
    if (url.endsWith("/packages")) return json({items: [{key:"sample", name:"长课程名称", directory:"demo", shared:true}]});
    return json([]);
  }));
  const user = userEvent.setup();
  render(<App/>);
  await user.click(await screen.findByRole("button", {name:"创建新课程"}));
  await user.type(screen.getByLabelText("课程名称"), "新课程");
  const submit = screen.getByRole("button", {name:"创建课程"});
  expect(submit).toBeDisabled();
  await user.click(screen.getByRole("radio", {name:"导入课程包"}));
  expect(submit).toBeDisabled();
  await user.click(screen.getByRole("combobox", {name:"课程包"}));
  await user.click(await screen.findByRole("option", {name:/长课程名称/}));
  await user.click(submit);
  await waitFor(() => expect(writes[0]).toMatchObject({url:"/api/teacher/course/packages/create-course",body:{name:"新课程",package_key:"sample",request_id:expect.any(String)}}));
  await user.click(await screen.findByRole("button", {name:"创建新课程"}));
  await user.type(screen.getByLabelText("课程名称"), "空白课");
  await user.click(screen.getByRole("radio", {name:"创建空课程"}));
  await user.click(screen.getByRole("button", {name:"创建课程"}));
  await waitFor(() => expect(writes[1]).toEqual({url:"/api/teacher/courses",body:{name:"空白课"}}));
});

it("searches transfer candidates and requires selecting a teacher from the current results", async () => {
  setToken("admin-session");
  const transfer = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/auth/me")) return json({id: 7, name: "管理员", role: "admin"});
    if (url.endsWith("/teacher/courses")) return json([{id: 31, name: "计算思维", teacher_id: 7}]);
    if (url.includes("/admin/accounts?")) {
      const query = new URL(url, location.origin).searchParams.get("q") ?? "";
      const items = [{id: 7, name: "管理员", student_id: "0007"}, {id: 8, name: "张老师", student_id: "0008"},
        {id: 9, name: "停用教师", student_id: "0009", disabled: true}].filter(t => (t.name + t.student_id).includes(query));
      return json({items, total: items.length});
    }
    if (url.endsWith("/transfer")) transfer(JSON.parse(String(init.body)));
    return json([]);
  }));
  const user = userEvent.setup();
  render(<App/>);
  await user.click(await screen.findByRole("button", {name:"计算思维的更多操作"}));
  expect(await screen.findByRole("menuitem", {name:"修改课程名称"})).toBeVisible();
  await user.click(screen.getByRole("menuitem", {name:"转交整门课程"}));
  const target = await screen.findByRole("radio", {name:/张老师.*0008/});
  expect(screen.getAllByRole("radio")).toHaveLength(1);
  const confirm = screen.getByRole("button", {name:"确认转交"});
  expect(confirm).toBeDisabled();
  await user.click(target);
  expect(confirm).toBeEnabled();
  const search = screen.getByRole("searchbox", {name:"搜索教师姓名或工号"});
  await user.type(search, "0000");
  expect(await screen.findByText("未找到匹配的教师")).toBeVisible();
  expect(confirm).toBeDisabled();
  await user.clear(search);
  await user.type(search, "0008");
  await user.click(await screen.findByRole("radio", {name:/张老师.*0008/}));
  await user.click(confirm);
  await waitFor(() => expect(transfer).toHaveBeenCalledWith({teacher_id: 8}));
});

it("previews cascade deletion of a taught course and deletes only after confirmation", async () => {
  setToken("admin-session");
  const courses = [
    { id: 31, name: "已开课", revision: 3, teacher_id: 8 },
    { id: 32, name: "备课中", revision: 2, teacher_id: 8 },
  ];
  const remove = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/auth/me")) return json({id: 8, name: "管理员", role: "admin"});
    if (url.endsWith("/teacher/courses")) return json(remove.mock.calls.length ? courses.slice(1) : courses);
    if (url.endsWith("/deletion-preview")) {
      const course = courses[url.includes("/31/") ? 0 : 1]!;
      const canDelete = course.id === 31;
      return json({name: course.name, revision: course.revision, confirmation: "preview/+=", can_delete: canDelete,
        blocked_reason: canDelete ? null : "课程还有备课任务在处理，请等待任务结束后重试。",
        counts: {
          classrooms: canDelete ? 2 : 0, students: canDelete ? 12 : 0, reading_records: 5,
          submissions: 7, assessment_attempts: 3, chapters: 2, materials: 1,
          knowledge_points: 3, questions: 4, activities: 1, exam_drafts: 1,
        }});
    }
    if (init.method === "DELETE") {
      remove(url);
      return new Response(null, {status: 204});
    }
    return json([]);
  }));
  const user = userEvent.setup();
  render(<App/>);
  await user.click(await screen.findByRole("button", {name:"备课中的更多操作"}));
  await user.click(await screen.findByRole("menuitem", {name:"删除课程"}));
  expect(await screen.findByText(/备课任务在处理/)).toBeVisible();
  expect(screen.queryByRole("button", {name:"确认删除课程"})).not.toBeInTheDocument();
  expect(remove).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", {name:"取消"}));

  await user.click(await screen.findByRole("button", {name:"已开课的更多操作"}));
  await user.click(await screen.findByRole("menuitem", {name:"删除课程"}));
  await screen.findByText("受影响学生");
  expect(within(screen.getByRole("dialog")).queryByRole("textbox")).toBeNull();
  expect(screen.getByText("受影响学生").parentElement).toHaveTextContent("12");
  expect(screen.getByText("阅读记录").parentElement).toHaveTextContent("5");
  expect(screen.getByText(/所有关联教学班、教学内容、班级名册/)).toHaveTextContent("将永久删除");
  const confirmation = screen.getByRole("button", {name:"确认删除课程"});
  await user.click(confirmation);
  await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith("/api/teacher/courses/31?expected_revision=3&confirmation=preview%2F%2B%3D"));
  await waitFor(() => expect(screen.queryByRole("heading", {name:"已开课"})).not.toBeInTheDocument());
  expect(screen.getByRole("heading", {name:"备课中"})).toBeVisible();
});


it("remembers a roster selection per course and normalizes invalid class links", async () => {
  setToken("teacher-session");
  sessionStorage.setItem("classroom:17:30","32");
  history.replaceState({}, "", "/teacher/students?course=30&class=999");
  const rooms = [{id:31,course_id:30,name:"甲班"}, {id:32,course_id:30,name:"乙班"}, {id:41,course_id:40,name:"丙班"}];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth/me")) return json({id:17,name:"老师",role:"teacher"});
    if (url.endsWith("/teacher/courses")) return json([{id:30,name:"甲课"},{id:40,name:"乙课"},{id:50,name:"新课"}]);
    if (url.endsWith("/classrooms")) return json(rooms);
    if (url.endsWith('/students')) return json([]);
    return json({items:[],total:0, students:[],activities:[]});
  }));
  render(<App/>);
  expect(await screen.findByRole("combobox",{name:"当前班级"})).toHaveTextContent("乙班");
  expect(location.search).toBe("?course=30&class=32");
  expect(screen.getByRole("link",{name:"班级管理"})).toHaveAttribute("aria-current","location");
  expect(screen.getByRole("link",{name:"返回班级列表"})).toBeVisible();
  await act(async()=>{ history.pushState({},"","/teacher/grades?course=40"); window.dispatchEvent(new PopStateEvent("popstate")); });
  expect(await screen.findByLabelText("当前班级")).toHaveTextContent("丙班");
  expect(screen.queryByRole("combobox",{name:"当前班级"})).toBeNull();
  await act(async()=>{ history.pushState({},"","/teacher/grades?course=50"); window.dispatchEvent(new PopStateEvent("popstate")); });
  expect(await screen.findByText("本课程尚未创建班级")).toBeVisible();
  expect(screen.getByRole("button",{name:"创建班级"})).toBeEnabled();
});

it("shows chapter numbers and release states for the selected classroom in learning tasks", async () => {
  setToken("teacher-session");
  history.replaceState({}, "", "/teacher/activities?course=30&class=31&chapter=12");
  const chapters = ["入门", "变量", "循环", "函数"].map((title, index) => ({ id: 11 + index, order_index: index + 1, title }));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth/me")) return json({ id: 17, name: "老师", role: "teacher" });
    if (url.endsWith("/teacher/courses")) return json([{ id: 30, name: "课程" }]);
    if (url.endsWith("/classrooms")) return json([{ id: 31, course_id: 30, name: "甲班" }, { id: 32, course_id: 30, name: "乙班" }]);
    if (url.endsWith("/catalog")) return json({ chapters, knowledge_points: [], activities: [] });
    if (url.endsWith("/31/releases")) return json([
      { chapter_id: 11, status: "published", opens_at: null },
      { chapter_id: 12, status: "published", opens_at: "2099-01-01T00:00:00Z" },
      { chapter_id: 13, status: "paused", opens_at: null },
    ]);
    return json([]);
  }));
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findByRole("heading", { name: /第 2 章.*变量/ })).toBeVisible();
  expect(screen.getByRole("button", { name: "入门" })).toHaveAccessibleDescription("已开放");
  expect(screen.getByRole("button", { name: "变量" })).toHaveAccessibleDescription("等待开放");
  expect(screen.getByRole("button", { name: "循环" })).toHaveAccessibleDescription("已暂停");
  expect(screen.getByRole("button", { name: "函数" })).toHaveAccessibleDescription("未开放");
  await user.click(screen.getByRole("combobox", { name: "当前班级" }));
  await user.click(await screen.findByRole("option", { name: "乙班" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "入门" })).toHaveAccessibleDescription("未开放"));
  expect(location.search).toBe("?course=30&class=32&chapter=12");
  expect(screen.getByRole("button", { name: "变量" })).toHaveAttribute("aria-current", "page");
});
