import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContentReviewPage } from "../src/pages/content-review";

const base = "/api/teacher/classrooms/7/content-review";
const chapter = { chapter_id: 5, chapter_title: "第二章 变量", count: 114, eligible_count: 113, question_count: 3, narration_count: 111 };
const material = { material_id: 9, material_title: "变量课件 Part 1", count: 114, eligible_count: 113, question_count: 3, narration_count: 111 };
const question = { kind: "question", id: "q7", title: "变量命名", source: "imported", material_title: material.material_title, page_no: 2, question_kind: "fill", revision: "4" };
const narration = { kind: "narration", id: "19", title: material.material_title, source: "ai", page_no: 12, question_kind: "", revision: "abc" };
const interactive = { ...question, id: "q8", title: "变量游戏", question_kind: "interactive" };
const pageOf = (items: unknown[], total = items.length, page = 1) => ({items, total, page});
function mockApi(respond: (url: URL, init: RequestInit) => unknown) {
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    const result = respond(new URL(input, "http://localhost"), init);
    return result instanceof Response ? result : Response.json(result);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => history.replaceState({}, "", "/teacher/content-review"));
afterEach(() => { vi.unstubAllGlobals(); history.replaceState({}, "", "/"); });

it("loads chapter summaries first and keeps selected drafts across detail pages", async () => {
  const user = userEvent.setup(), decisions: unknown[] = [];
  const fetch = mockApi((url, init) => {
    if (url.pathname === base + "/groups") return { ...pageOf([chapter]), item_total: 114 };
    if (url.pathname === base + "/groups/5/materials") return { ...pageOf([material]), chapter_title: chapter.chapter_title };
    if (url.pathname === base) {
      expect(url.searchParams.get("chapter_id")).toBe("5");
      expect(url.searchParams.get("material_id")).toBe("9");
      const page = Number(url.searchParams.get("page"));
      return { ...pageOf(page === 1 ? [question, interactive] : [narration], 114, page), material_title: material.material_title };
    }
    if (url.pathname.endsWith("/decisions")) {
      decisions.push(JSON.parse(String(init.body)));
      return { count: 2 };
    }
    throw Error("Unexpected request: " + url);
  });
  history.replaceState({ courseGraph: {classroomId: 7} }, "", "/teacher/content-review");
  render(<ContentReviewPage classroomId={7} />);
  expect(await screen.findByText("3 题")).toBeInTheDocument();
  expect(screen.getByText("111 页")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: /查看第二章 变量的待审资料/ }));
  expect(await screen.findByText(material.material_title)).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: /查看变量课件 Part 1的待审明细/ }));
  expect(history.state.courseGraph).toEqual({classroomId: 7});
  expect(location.search).toBe("?chapter_id=5&material_id=9");
  await user.click(await screen.findByRole("checkbox", { name: "选择变量命名" }));
  expect(screen.getByRole("checkbox", {name: "选择变量游戏"})).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByRole("button", { name: "下一页" }));
  await user.click(await screen.findByRole("checkbox", { name: /选择变量课件 Part 1 · 第 12 页/ }));
  await user.click(screen.getByRole("button", { name: "通过所选 2 项" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/题目 · 变量命名/)).toBeInTheDocument();
  expect(within(dialog).getByText(/逐页讲解稿 · 变量课件 Part 1 · 第 12 页/)).toBeInTheDocument();
  expect(within(dialog).queryByText(/变量游戏/)).not.toBeInTheDocument();
  expect(decisions).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", {name: "确认通过 2 项"}));
  expect(await screen.findByText("已通过 2 项")).toBeInTheDocument();
  expect(decisions).toEqual([{decision:"accept", items:[
    {kind:"question",id:"q7",revision:"4"},{kind:"narration",id:"19",revision:"abc"},
  ]}]);
});

it("requires a current chapter-wide preview before accepting all eligible drafts across pages", async () => {
  const user = userEvent.setup(), decisions: unknown[] = [];
  let prev = 0;
  mockApi((url, init) => {
    if (url.pathname.endsWith("/groups")) return { ...pageOf([chapter]), item_total: 114 };
    if (url.pathname.endsWith("/groups/5/preview")) {
      prev += 1;
      return { chapter_title: chapter.chapter_title, question_count: 2, narration_count: prev === 1 ? 111 : 110, count: prev === 1 ? 113 : 112, excluded_count:1, token:"token" + prev };
    }
    if (url.pathname.endsWith("/groups/5/accept")) {
      decisions.push(JSON.parse(String(init.body)));
      if (decisions.length === 1) return Response.json({detail:"审批范围已改变"}, {status:409});
      return {count:112};
    }
    throw Error("Unexpected request: " + url);
  });
  const ui = render(<ContentReviewPage classroomId={7}/>);
  await user.click(await screen.findByRole("button", {name:"批量通过第二章 变量的草稿"}));
  let dialog = within(screen.getByRole("dialog"));
  expect(await dialog.findByText("题目 2 道 · 讲解稿 111 页")).toBeInTheDocument();
  expect(dialog.getByText(/另有 1 项需单独审阅/)).toBeInTheDocument();
  expect(decisions).toHaveLength(0);
  await user.click(dialog.getByRole("button", {name:"确认通过 113 项"}));
  await user.click(await dialog.findByRole("button", {name:"重新核对范围"}));
  dialog = within(screen.getByRole("dialog"));
  await user.click(await dialog.findByRole("button", {name:"确认通过 112 项"}));
  expect(await screen.findByText("已通过 112 项")).toBeInTheDocument();
  expect(decisions).toEqual([{kind:null, expected_count:113, token:"token1"},{kind:null, expected_count:112, token:"token2"}]);
  mockApi((url) => {
    expect(url.pathname).toBe("/api/teacher/classrooms/8/content-review/groups");
    return {...pageOf([]),item_total:0};
  });
  ui.rerender(<ContentReviewPage classroomId={8}/>);
  expect(await screen.findByText("当前班级没有待审批内容")).toBeInTheDocument();
});

it("opens an unassigned source directly and preserves a narration's revision when accepting edited text", async () => {
  history.replaceState({}, "", "/teacher/content-review?chapter_id=0&material_id=9");
  const user = userEvent.setup(), decisions: unknown[] = [];
  mockApi((url, init) => {
    if (url.pathname.endsWith("/decisions")) {
      decisions.push(JSON.parse(String(init.body)));
      return {count:1};
    }
    if (url.pathname.endsWith("/narrations/19")) return { raw_text:"变量的定义", digest:null, narration:{text:"初稿"},
      revision:"new", material_id:9, source_changed:false };
    expect(url.pathname).toBe(base);
    expect(url.searchParams.get("chapter_id")).toBe("0");
    return { ...pageOf(decisions.length ? [] : [narration]), chapter_title:"未归章", material_title: material.material_title };
  });
  render(<ContentReviewPage classroomId={7}/>);
  await user.click(await screen.findByRole("button", {name:"审阅"}));
  const dialog = within(screen.getByRole("dialog"));
  const field = await dialog.findByRole("textbox", {name:"讲解稿"});
  await user.clear(field); await user.type(field, "已核对的讲稿");
  await user.click(dialog.getByRole("button", {name:"修改并通过"}));
  expect(await screen.findByText("该资料当前没有符合条件的待审草稿")).toBeInTheDocument();
  expect(decisions).toEqual([{decision:"accept",items:[{kind:"narration",id:"19",revision:"new"}],text:"已核对的讲稿"}]);
});

it("applies the selected content type to both the chapter preview and its confirmation", async () => {
  const user = userEvent.setup(), accepted: unknown[] = [];
  mockApi((url, init) => {
    if (url.pathname.endsWith("/groups")) return { ...pageOf([chapter]), item_total: 114 };
    if (url.pathname.endsWith("/preview")) {
      expect(url.searchParams.get("kind")).toBe("question");
      return {chapter_title:chapter.chapter_title, question_count:2, narration_count:0, count:2, excluded_count:1, token:"q"};
    }
    if (url.pathname.endsWith("/accept")) {
      accepted.push(JSON.parse(String(init.body)));
      return {count:2};
    }
    throw Error("Unexpected request: " + url);
  });
  render(<ContentReviewPage classroomId={7}/>);
  await user.click(screen.getByRole("combobox", {name:"待审内容类型"}));
  await user.click(await screen.findByRole("option", {name:"题目"}));
  await user.click(await screen.findByRole("button", {name:"批量通过第二章 变量的草稿"}));
  const dialog = within(screen.getByRole("dialog"));
  expect(await dialog.findByText("题目 2 道 · 讲解稿 0 页")).toBeInTheDocument();
  await user.click(dialog.getByRole("button", {name:"确认通过 2 项"}));
  expect(await screen.findByText("已通过 2 项")).toBeInTheDocument();
  expect(accepted).toEqual([{kind:"question", expected_count:2, token:"q"}]);
});
