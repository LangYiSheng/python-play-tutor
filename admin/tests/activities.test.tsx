import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Activities } from "../src/features/activities/activities-page";

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
    return json(url.includes("/teacher/courses") ? course : []);
  }));
  const user = userEvent.setup();
  render(<Activities classroomId={7} teacherId={9} />);
  const create = await screen.findByRole("button", { name: "新增活动" });
  await waitFor(() => expect(create).toBeEnabled());
  await user.click(create);
  await user.type(screen.getByRole("textbox", { name: "活动名称" }), "变量练习");
  await user.click(screen.getByRole("combobox", { name: "类型" }));
  await user.click(await screen.findByRole("option", { name: "练习" }));
  expect(screen.getByRole("radio", { name: "按知识点出题" })).toBeChecked();
  await user.click(screen.getByRole("tab", { name: "知识点目标" }));
  expect(screen.queryByRole("checkbox", { name: "循环" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: "变量" }));
  await user.clear(screen.getByRole("spinbutton", { name: /答对总数/ }));
  await user.type(screen.getByRole("spinbutton", { name: /答对总数/ }), "3");
  await user.type(screen.getByRole("spinbutton", { name: /编程题至少/ }), "1");
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
  await user.click(screen.getByRole("combobox", { name: "发布状态" }));
  await user.click(await screen.findByRole("option", { name: "草稿" }));
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({
    kind: "practice", chapter_id: 1, published: false, knowledge_point_ids: [11],
    practice_rules: { goals: [{ knowledge_point_id: 11, total: 3, by_kind: { python: 1 } }] },
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
    npcs: [], activities: [{id: "paper", title: "固定题单", kind: "practice", chapter_id: 1, question_ids: []}],
  };
  const questions = [
    {id: "both", title: "B 变量题", knowledge_point_ids: [11, 12]},
    {id: "expression", title: "A 表达式题", knowledge_point_ids: [12]},
    {id: "untagged", title: "C 综合题", knowledge_point_ids: []},
  ].map(q => ({...q, chapter_ids: [1], owner_id: null, kind: "fill", status: "ready"}));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "PUT") { update(url, JSON.parse(String(init.body))); return json({}); }
    return json(url.includes("/teacher/courses") ? course : url.includes("/question-candidates") ? questions : []);
  }));
  const user = userEvent.setup();
  render(<Activities classroomId={7} teacherId={9} />);
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
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.stringContaining("/teacher/activities/paper?"),
    expect.objectContaining({title: "固定题单", question_ids: ["both", "expression", "untagged"]})));
});

it("previews cascading impact, requires two confirmations, and refreshes after deletion", async () => {
  let removed = false;
  const calls: unknown[] = [];
  const activity = { id: "review", chapter_id: 1, title: "综合复习", kind: "practice", question_ids: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/content-deletions/preview")) return json({ id: "p1", confirmation: "综合复习", remove: [{kind: "activity", id: "review", title: "综合复习"}], detach: [], preserve: [], blockers: [], affected_students: 0, ending_sessions: 0, history_policy: "学生历史记录保留" });
    if (url.endsWith("/p1/confirm")) { calls.push(JSON.parse(init.body as string)); removed = true; return json({ok: true}); }
    return json(url.includes("/teacher/courses") ? { chapters: [{id: 1, title: "第一章"}], npcs: [], knowledge_points: [], activities: removed ? [] : [activity] } : []);
  }));
  const user = userEvent.setup();
  render(<Activities classroomId={7} teacherId={9} />);
  await user.click(await screen.findByRole("button", { name: "删除综合复习" }));
  expect(await within(screen.getByRole("dialog")).findByText("一起删除（1）")).toBeVisible();
  await user.click(screen.getByRole("button", {name: "取消"}));
  expect(calls).toHaveLength(0);
  await user.click(screen.getByRole("button", {name: "删除综合复习"}));
  await waitFor(() => expect(screen.getByRole("button", {name: "继续确认"})).toBeEnabled());
  await user.click(screen.getByRole("button", {name: "继续确认"}));
  expect(screen.getByRole("button", {name: "确认级联删除"})).toBeDisabled();
  await user.type(screen.getByRole("textbox"), "综合复习");
  expect(screen.getByRole("button", {name: "确认级联删除"})).toBeDisabled();
  await user.click(screen.getByRole("checkbox", {name: "我已核对删除范围，确认保留学生历史记录"}));
  await user.click(screen.getByRole("button", {name: "确认级联删除"}));
  expect(await screen.findByText("尚无学习活动")).toBeVisible();
  expect(calls).toEqual([{classroom_id: 7, confirmation: "综合复习", confirmed: true}]);
});

it("selects knowledge points by chapter and preserves the other chapter's selections on save", async () => {
  const update = vi.fn();
  const course = {
    chapters: [
      { id: 1, title: "第一章", order_index: 1, owner_id: null },
      { id: 2, title: "第二章", order_index: 2, owner_id: null },
      { id: 3, title: "第三章", order_index: 3, owner_id: null },
    ],
    knowledge_points: [
      { id: 11, chapter_id: 1, title: "变量", content: {}, owner_id: null },
      { id: 22, chapter_id: 2, title: "循环", content: {}, owner_id: null },
      { id: 22, chapter_id: 2, title: "循环", content: {}, owner_id: null },
    ],
    npcs: [{ key: "teacher", name: "老师" }],
    activities: [{ id: "review", chapter_id: 1, title: "综合复习", kind: "practice", material_id: null, npc_key: "teacher", assistant_allowed: true, learning: {}, knowledge_point_ids: [11], question_ids: [], owner_id: null }],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "PUT") { update(url, JSON.parse(init.body as string)); return json({}); }
    return json(url.includes("/teacher/courses") ? course : []);
  }));
  const user = userEvent.setup();
  render(<Activities classroomId={7} teacherId={9} />);
  await user.click(await screen.findByRole("button", { name: "编辑综合复习" }));
  expect(screen.getByRole("radio", { name: "固定题单" })).toBeChecked();
  await user.click(screen.getByRole("tab", { name: "内容关联" }));
  expect(screen.getByRole("checkbox", { name: "变量" })).toBeChecked();
  expect(screen.queryByRole("checkbox", { name: "循环" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "第二章" }));
  expect(screen.getAllByRole("checkbox", { name: "循环" })).toHaveLength(1);
  await user.click(screen.getByRole("checkbox", { name: "循环" }));
  expect(within(screen.getByRole("group", { name: "已选知识点" })).getByText("变量")).toBeInTheDocument();
  expect(screen.getByText("已选 2 / 65")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "第三章" }));
  expect(screen.getByText("本章暂无知识点，可选择其他章节。")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith("/api/teacher/activities/review?classroom_id=7", expect.objectContaining({ knowledge_point_ids: [11, 22] })));
});

it("creates a fixed practice and switches an existing goal practice back to a fixed list", async () => {
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  const course = {
    chapters: [{ id: 1, title: "第一章" }], knowledge_points: [{ id: 11, chapter_id: 1, title: "变量" }], npcs: [],
    activities: [{ id: "guided", chapter_id: 1, title: "变量目标", kind: "practice", question_ids: [],
      knowledge_point_ids: [11], practice_rules: { goals: [{ knowledge_point_id: 11, total: 3, by_kind: {} }] } }],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST" || init.method === "PUT") {
      writes.push({ method: init.method, body: JSON.parse(init.body as string) });
      return json({});
    }
    return json(url.includes("/teacher/courses") ? course : []);
  }));
  const user = userEvent.setup();
  render(<Activities classroomId={7} teacherId={9} />);
  await user.click(await screen.findByRole("button", { name: "编辑变量目标" }));
  expect(screen.getByRole("radio", { name: "按知识点出题" })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: "固定题单" }));
  expect(screen.queryByRole("combobox", { name: "发布状态" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "新增活动" }));
  expect(screen.queryByRole("group", { name: "出题方式" })).not.toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: "活动名称" }), "固定练习");
  await user.click(screen.getByRole("combobox", { name: "类型" }));
  await user.click(await screen.findByRole("option", { name: "练习" }));
  await user.click(screen.getByRole("radio", { name: "固定题单" }));
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[0]).toMatchObject({ method: "PUT", body: { practice_rules: null, knowledge_point_ids: [11] } });
  expect(writes[1]).toMatchObject({ method: "POST", body: { practice_rules: null, kind: "practice" } });
});
