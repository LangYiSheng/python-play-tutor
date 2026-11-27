import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LearningTasks } from "../src/features/activities/activities-page";

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

it("creates a chapter-scoped practice draft and preserves goals after a rejected publication", async () => {
  const writes: Record<string, unknown>[] = [];
  const course = {
    chapters: [{ id: 1, title: "第一章" }, { id: 2, title: "第二章" }],
    knowledge_points: [{ id: 11, title: "变量", chapter_id: 1 }, { id: 12, title: "表达式", chapter_id: 1 }, { id: 22, title: "循环", chapter_id: 2 }],
    npcs: [], activities: [{ id: "exam", title: "章节测验", chapter_id: 1, kind: "assessment", question_ids: [] }],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") {
      const body = JSON.parse(init.body as string);
      writes.push(body);
      return body.published
        ? new Response(JSON.stringify({ detail: "变量缺少可用编程题" }), { status: 422 })
        : json({});
    }
    if (url.includes("/question-candidates")) return json([{
      id: "private-cases", title: "仅私有用例", kind: "python", owner_id: 9,
      status: "ready", chapter_ids: [1], knowledge_point_ids: [11], samples: [],
    }, { id: "fruits", title: "水果索引", kind: "interactive", owner_id: 9,
      status: "ready", chapter_ids: [1], knowledge_point_ids: [12] }]);
    return json(url.includes("/catalog") ? course : []);
  }));
  const user = userEvent.setup();
  render(<LearningTasks courseId={7}/>);
  await user.click(await screen.findByRole("button", {name:"第二章"}));
  expect(screen.getByText("本章暂无活动")).toBeVisible();
  expect(screen.queryByRole("button", { name: "选题章节测验" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", {name:"第一章"}));
  const create = await screen.findByRole("button", { name: "新增客观题练习" });
  await waitFor(() => expect(create).toBeEnabled());
  await user.click(create);
  await user.type(screen.getByRole("textbox", { name: "活动名称" }), "变量练习");
  expect(screen.getByRole("radio", { name: "按知识点出题" })).toBeChecked();
  await user.click(screen.getByRole("tab", { name: "知识点目标" }));
  expect(screen.queryByRole("checkbox", { name: "循环" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: "变量" }));
  await user.clear(screen.getByRole("spinbutton", { name: /答对总数/ }));
  await user.type(screen.getByRole("spinbutton", { name: /答对总数/ }), "3");
  await user.type(screen.getByRole("spinbutton", { name: /填空题至少/ }), "1");
  await user.click(screen.getByRole("checkbox", { name: "表达式" }));
  expect(screen.getAllByRole("spinbutton", { name: /答对总数/ })).toHaveLength(1);
  expect(screen.getByRole("spinbutton", { name: /交互练习题至少/ })).toBeVisible();
  expect(screen.getByRole("spinbutton", { name: /答对总数/ })).toHaveValue(1);
  await user.click(screen.getByRole("button", { name: "变量" }));
  expect(screen.getByRole("spinbutton", { name: /答对总数/ })).toHaveValue(3);
  expect(screen.getByRole("checkbox", { name: "表达式" })).toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "表达式" }));
  expect(screen.getByText("按此目标至少需要 3 道不同题目，当前还缺 3 道。")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByText("变量缺少可用编程题")).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "活动信息" }));
  await user.click(screen.getByRole("combobox", { name: "发布状态" }));
  await user.click(await screen.findByRole("option", { name: "草稿" }));
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({
    kind: "practice", chapter_id: 1, published: false, knowledge_point_ids: [11],
    practice_rules: { goals: [{ knowledge_point_id: 11, total: 3, by_kind: { fill: 1 } }] },
  });
  await user.click(await screen.findByRole("button", { name: "选题章节测验" }));
  expect(await screen.findByRole("checkbox", { name: "仅私有用例" })).toBeEnabled();
  expect(screen.queryByRole("checkbox", { name: "水果索引" })).not.toBeInTheDocument();
});

it("selects shared and untagged questions once and saves their final positions with the activity", async () => {
  const update = vi.fn();
  const course = {
    chapters: [{id: 1, title: "第一章"}],
    knowledge_points: [{id: 11, title: "变量", chapter_id: 1}, {id: 12, title: "表达式", chapter_id: 1}],
    npcs: [], activities: [{id: "paper", title: "固定题单", kind: "practice", practice_kind: "objective", chapter_id: 1, question_ids: []}],
  };
  const questions = [
    {id: "both", title: "B 变量题", knowledge_point_ids: [11, 12]},
    {id: "expression", title: "A 表达式题", knowledge_point_ids: [12]},
    {id: "untagged", title: "C 综合题", knowledge_point_ids: []},
  ].map(q => ({...q, chapter_ids: [1], owner_id: null, kind: "fill", status: "ready"}));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "PUT") { update(url, JSON.parse(String(init.body))); return json({}); }
    return json(url.includes("/catalog") ? course : url.includes("/question-candidates") ? questions : []);
  }));
  const user = userEvent.setup();
  render(<LearningTasks courseId={7}/>);
  await user.click(await screen.findByRole("button", {name: "选题固定题单"}));
  await user.click(screen.getByRole("checkbox", {name: "B 变量题"}));
  await user.click(screen.getByRole("button", {name: /表达式/}));
  expect(screen.getByRole("checkbox", {name: "B 变量题"})).toBeChecked();
  await user.click(screen.getByRole("checkbox", {name: /全选当前/}));
  await user.click(screen.getByRole("button", {name: /未关联本章知识点/}));
  await user.click(screen.getByRole("checkbox", {name: "C 综合题"}));
  await user.click(screen.getByRole("tab", {name: "题目顺序"}));
  await user.click(screen.getByRole("button", {name: "按题目名称排序"}));
  expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("A 表达式题");
  await user.click(screen.getByRole("button", {name: "按知识点排序"}));
  expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("B 变量题");
  await user.click(screen.getByRole("button", {name: "保存"}));
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.stringContaining("/teacher/courses/7/activities/paper"),
    expect.objectContaining({title: "固定题单", question_ids: ["both", "expression", "untagged"]})));
});

it("previews cascading impact, requires an explicit confirmation, and refreshes after deletion", async () => {
  let removed = false;
  const calls: unknown[] = [];
  const activity = { id: "review", chapter_id: 1, title: "综合复习", kind: "practice", practice_kind: "objective", question_ids: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/content-deletions/preview")) return json({ id: "p1", confirmation: "综合复习", remove: [{kind: "activity", id: "review", title: "综合复习"}], detach: [], preserve: [], blockers: [], affected_students: 0, ending_sessions: 0, history_policy: "学生历史记录保留" });
    if (url.endsWith("/p1/confirm")) { calls.push(JSON.parse(init.body as string)); removed = true; return json({ok: true}); }
    return json(url.includes("/catalog") ? { chapters: [{id: 1, title: "第一章"}], npcs: [], knowledge_points: [], activities: removed ? [] : [activity] } : []);
  }));
  const user = userEvent.setup();
  render(<LearningTasks courseId={7}/>);
  await user.click(await screen.findByRole("button", { name: "删除综合复习" }));
  expect(await within(screen.getByRole("dialog")).findByText("一起删除（1）")).toBeVisible();
  await user.click(screen.getByRole("button", {name: "取消"}));
  expect(calls).toHaveLength(0);
  await user.click(screen.getByRole("button", {name: "删除综合复习"}));
  await waitFor(() => expect(screen.getByRole("button", {name: "确认级联删除"})).toBeEnabled());
  await user.click(screen.getByRole("button", {name: "确认级联删除"}));
  expect(await screen.findByText("本章暂无活动")).toBeVisible();
  expect(calls).toEqual([{confirmation: "综合复习", confirmed: true}]);
});

it("creates a fixed practice and switches an existing goal practice back to a fixed list", async () => {
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  const course = {
    chapters: [{ id: 1, title: "第一章" }], knowledge_points: [{ id: 11, chapter_id: 1, title: "变量" }], npcs: [],
    activities: [{ id: "guided", chapter_id: 1, title: "变量目标", kind: "practice", practice_kind: "objective", question_ids: [],
      knowledge_point_ids: [11], practice_rules: { goals: [{ knowledge_point_id: 11, total: 3, by_kind: {} }] } }],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST" || init.method === "PUT") {
      writes.push({ method: init.method, body: JSON.parse(init.body as string) });
      return json({});
    }
    return json(url.includes("/catalog") ? course : []);
  }));
  const user = userEvent.setup();
  render(<LearningTasks courseId={7}/>);
  await user.click(await screen.findByRole("button", { name: "编辑变量目标" }));
  expect(screen.getByRole("radio", { name: "按知识点出题" })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: "固定题单" }));
  expect(screen.getByRole("combobox", { name: "发布状态" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "新增客观题练习" }));
  expect(screen.getByRole("radio", {name:"按知识点出题"})).toBeChecked();
  await user.type(screen.getByRole("textbox", { name: "活动名称" }), "固定练习");
  await user.click(screen.getByRole("radio", { name: "固定题单" }));
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[0]).toMatchObject({ method: "PUT", body: { practice_rules: null, knowledge_point_ids: [11] } });
  expect(writes[1]).toMatchObject({ method: "POST", body: { practice_rules: null, kind: "practice" } });
});

it("counts the class teacher's practice pool when an administrator creates an activity", async () => {

  history.replaceState({}, "", "/teacher/activities?course=32");
  const question = { kind: "single_choice", status: "ready", chapter_ids: [1], knowledge_point_ids: [11], samples: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth/me")) return json({ id: 1, name: "管理员", role: "admin" });
    if (url.endsWith("/classrooms")) return json([{ id: 7, name: "一班", teacher_id: 9 }]);
    if (url.endsWith("/teacher/courses")) return json([{id: 32, name: "课程", teacher_id: 9}]);
    if (url.includes("/catalog")) return json({ chapters: [{ id: 1, title: "第一章", order_index: 1, owner_id: null }],
      knowledge_points: [{ id: 11, chapter_id: 1, title: "变量" }], npcs: [], activities: [] });
    if (url.includes("/question-candidates")) return json([
      { ...question, id: "shared", owner_id: null }, { ...question, id: "teacher", owner_id: 9 },
    ]);
    return json([]);
  }));
  const user = userEvent.setup();
  render(<LearningTasks courseId={32}/>);
  await user.click(await screen.findByRole("button", {name:"第一章"}));
  const create = await screen.findByRole("button", { name: "新增客观题练习" });
  await waitFor(() => expect(create).toBeEnabled());
  await user.click(create);
  await user.click(screen.getByRole("tab", { name: "知识点目标" }));
  await user.click(screen.getByRole("checkbox", { name: "变量" }));
  expect(screen.getByRole("spinbutton", { name: /答对总数/ })).toHaveAccessibleName(/可用 2 题/);
});

it("keeps required reading and advanced rules scoped to the selected chapter", async () => {
  history.replaceState({}, "", "/teacher/activities?course=7&chapter=1");
  const chapters = [{id:1,title:"第一章"}, {id:2,title:"第二章"}];
  const makeTask = () => ({ material_id:9, title:"共用课件", kind:"pdf", required:false, rule:{}, order_index:1 });
  const tasks = [makeTask(), makeTask()];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/catalog")) return json({chapters, activities:[], knowledge_points:[]});
    const match = /\/chapters\/(1|2)\/material-tasks(\/9)?$/.exec(url);
    if (!match) throw Error(url);
    const index = Number(match[1]) - 1;
    if (match[2] && init.method === "PUT") {
      Object.assign(tasks[index], JSON.parse(String(init.body)));
      return json(tasks[index]);
    }
    return json({items:[tasks[index]]});
  }));
  const user = userEvent.setup();
  render(<LearningTasks courseId={7}/>);
  const required = () => screen.findByRole("checkbox", { name:"共用课件必读" });
  expect(screen.queryByRole("button", {name:"上传资料"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button", {name:"关联已有资料"})).not.toBeInTheDocument();
  await user.click(await required());
  expect(await screen.findByText("读完整份")).toBeVisible();
  await user.click(screen.getByRole("button", { name:"共用课件高级设置" }));
  await user.clear(screen.getByLabelText("有效阅读秒数"));
  await user.type(screen.getByLabelText("有效阅读秒数"), "45");
  await user.click(screen.getByRole("button", {name:"保存"}));
  expect(await screen.findByText("读完整份，有效阅读 45 秒")).toBeVisible();
  await user.click(screen.getByRole("button",{name:"第二章"}));
  expect(await required()).not.toBeChecked();
  await user.click(screen.getByRole("button",{name:"第一章"}));
  expect(await required()).toBeChecked();
  await user.click(await required());
  await waitFor(() => expect(tasks[0].required).toBe(false));
  expect(tasks[0].rule).toEqual({scope:"all",minimum_seconds:45});
});
