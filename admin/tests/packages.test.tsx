import { render } from "./render-with-toasts";
import { afterEach, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Packages } from "../src/pages/packages";
afterEach(() => vi.unstubAllGlobals());
it("previews an existing package without uploading and still requires explicit confirmation", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const key = "mounted-" + "a".repeat(64);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/packages")) return new Response(JSON.stringify({ items: [
      { key, mine: true, name: "共享课程", package_id: "shared", package_version: "2", source: "mounted", directory: "shared-course", created_at: "2026-11-12T00:00:00Z", chapter_count: 7, question_count: 42 },
    ], unavailable: 0 }));
    calls.push({ url, body: JSON.parse(init.body as string) });
    if (url.endsWith("/imports/available/preview")) return new Response(JSON.stringify({
      id: "mounted-preview", expected_revision: 3, package_id: "shared", package_version: "2", name: "共享课程",
      can_apply: true, expires_at: "2030-01-01T00:00:00Z", blockers: [], warnings: [],
      diff: { activities: { added: ["lesson"], updated: [], removed: [] } },
    }));
    return new Response(JSON.stringify({ instance_id: 1, revision: 4 }));
  }));
  const user = userEvent.setup();
  render(<Packages courses={[{ id: 31, name: "目标课" }]} onCreated={() => {}} />);
  await screen.findByText("shared-course");
  expect(screen.getByRole("article")).toHaveTextContent("7 章 · 42 道题");
  await user.type(screen.getByRole("textbox", { name: "搜索课程包" }), "不存在");
  expect(screen.queryByRole("button", { name: "以此创建课程" })).not.toBeInTheDocument();
  await user.clear(screen.getByRole("textbox", { name: "搜索课程包" }));
  await user.click(await screen.findByRole("button", { name: "共享课程的更多操作" }));
  await user.click(await screen.findByRole("menuitem", {name: "更新已有课程"}));
  await user.click(screen.getByRole("button", {name: "预览差异"}));
  expect(await screen.findByRole("dialog", {name:"导入差异"})).toBeVisible();
  expect(calls).toEqual([{ url: "/api/teacher/courses/31/imports/available/preview", body: { package_key: key } }]);
  expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /我已核对差异/ }));
  await user.click(screen.getByRole("button", { name: "确认导入" }));
  await screen.findByText("课程包已导入");
  expect(calls[1].url).toBe("/api/teacher/courses/31/imports/mounted-preview/apply");
  expect(calls[1].body).toMatchObject({ expected_revision: 3 });
  expect(screen.queryByLabelText("课程包 ZIP 文件")).not.toBeInTheDocument();
});


it("creates an independent course using the selected package and a retry key", async () => {
  const created = vi.fn();
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/packages")) return new Response(JSON.stringify({items: [{key:"package", name:"循环", mine:true, chapter_count:1, question_count:23}]}));
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({name:"循环练习", package_key:"package"});
    expect(body.request_id).toBeTruthy();
    return new Response(JSON.stringify({id:42, name:body.name}));
  });
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(<Packages courses={[]} onCreated={created}/>);
  await user.click(await screen.findByRole("button", {name:"以此创建课程"}));
  await user.type(screen.getByLabelText("新课程名称"), "练习");
  await user.click(screen.getByRole("button", {name:"创建课程"}));
  expect(await screen.findByText("已创建课程「循环练习」")).toBeVisible();
  expect(created).toHaveBeenCalledOnce();
});

it("shows a catalog error with a retry and no ZIP upload", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "课程列表暂不可用" }), { status: 503 })));
  render(<Packages courses={[{ id: 31, name: "目标课" }]} onCreated={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("课程列表暂不可用");
  expect(screen.getByRole("button", { name: "刷新列表" })).toBeEnabled();
  expect(screen.queryByLabelText("课程包 ZIP 文件")).not.toBeInTheDocument();
});

it("only offers deletion for exported packages, confirms and handles failure before removing the row", async () => {
  const items = [
    {key:'owned',mine:true,name:'导出课程',directory:'export-31-demo',can_delete:true},
    {key:'default',mine:true,name:'默认课程',directory:'default',can_delete:false},
  ];
  let fail = true;
  const deletes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (init?.method === 'DELETE') {
      deletes.push(url);
      if (fail) return new Response(JSON.stringify({detail:'删除失败'}),{status:422});
      items.shift(); return new Response(JSON.stringify({deleted:true}));
    }
    return new Response(JSON.stringify({items,unavailable:0}));
  }));
  const user = userEvent.setup(); render(<Packages courses={[{ id: 31, name: "目标课" }]} onCreated={() => {}}/>);
  await user.click(await screen.findByRole('button',{name:'导出课程的更多操作'}));
  await user.click(await screen.findByRole('menuitem',{name:'删除课程包'}));
  expect(screen.queryByRole('button',{name:'删除 default'})).not.toBeInTheDocument();
  expect(deletes).toHaveLength(0);
  await user.click(screen.getByRole('button',{name:'取消'}));
  expect(deletes).toHaveLength(0);
  await user.click(screen.getByRole('button',{name:'导出课程的更多操作'}));
  await user.click(await screen.findByRole('menuitem',{name:'删除课程包'}));
  await user.click(screen.getByRole('button',{name:'确认删除'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('删除失败');
  expect(screen.getByRole('dialog')).toBeVisible();
  fail = false;
  await user.click(screen.getByRole('button',{name:'确认删除'}));
  await screen.findByText('课程包已删除');
  expect(screen.queryByRole('button',{name:'删除 export-31-demo'})).not.toBeInTheDocument();
  expect(screen.getByText('default')).toBeInTheDocument();
  expect(deletes).toEqual(['/api/teacher/course/packages/owned','/api/teacher/course/packages/owned']);
});

it("lists all packages including other teachers' exports in adminMode", async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    items: [
      { key: 'other-export', mine: false, shared: false, exporter_name: '李老师', name: '李老师的导出课', directory: 'export-9-li', chapter_count: 3, question_count: 15, can_delete: true },
      { key: 'preset', mine: false, shared: true, protected: true, name: '系统预置课', directory: 'supplied-1', chapter_count: 7, question_count: 48, can_delete: false },
    ],
    unavailable: 0,
  }))));
  render(<Packages adminMode courses={[{ id: 9, name: "李老师的课", teacher_name: "李老师" }]} onCreated={() => {}} />);
  expect(await screen.findByText("李老师的导出课")).toBeVisible();
  expect(screen.getByText("李老师 导出")).toBeVisible();
  expect(screen.getByText("系统预置课")).toBeVisible();
  expect(screen.getByText("预置受保护")).toBeVisible();
});
