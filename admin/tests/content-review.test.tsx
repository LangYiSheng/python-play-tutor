import { afterEach, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContentReviewPanel } from "../src/pages/content-review";

const ppt = {material_id: 9, material_title:"数据存取 Part 1", material_kind:"presentation", narration_count:12, first_page_no:4};
const pdf = {material_id: 12, material_title:"数据存取 Part 2", material_kind:"pdf", narration_count:5, first_page_no:9};
const drafts = (items=[ppt, pdf], questions=0, page=1, total=items.length) => ({items, question_count:questions, page, total});

afterEach(() => vi.unstubAllGlobals());

it("lists both course materials once and opens their existing editor at the first pending page in one click", async () => {
  const fetch = vi.fn(async () => Response.json(drafts([ppt,pdf],3)));
  vi.stubGlobal("fetch", fetch);
  const open = vi.fn(), user = userEvent.setup();
  render(<ContentReviewPanel classroomId={7} onOpenMaterial={open}/>);
  const list = within(await screen.findByRole("list", {name:"待审批内容"}));
  expect(list.getAllByRole("listitem")).toHaveLength(3);
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  await user.click(list.getByRole("button", {name:/数据存取 Part 1.*PPT.*12 页讲解稿待审/}));
  await user.click(list.getByRole("button", {name:/数据存取 Part 2.*PDF.*5 页讲解稿待审/}));
  expect(open.mock.calls).toEqual([[9,4],[12,9]]);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(list.getByRole("link", {name:/待审题目.*3 道题目草稿/})).toHaveAttribute("href","/teacher/assessments?tab=bank&status=draft&reviewable=true");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]).toEqual(["/api/teacher/classrooms/7/content-review/materials?page=1&size=25",expect.anything()]);
});

it("refreshes material counts after authoring, leaving question-only and empty queues distinct", async () => {
  let pending = drafts([ppt],1);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(pending)));
  const open = vi.fn();
  const ui = render(<ContentReviewPanel classroomId={7} revision={0} onOpenMaterial={open}/>);
  await screen.findByText("数据存取 Part 1");
  pending = drafts([],2);
  ui.rerender(<ContentReviewPanel classroomId={7} revision={1} onOpenMaterial={open}/>);
  expect(await screen.findByRole("link", {name:/待审题目.*2 道/})).toBeVisible();
  expect(screen.queryByText("数据存取 Part 1")).not.toBeInTheDocument();
  expect(screen.queryByText("当前班级没有待审批内容")).not.toBeInTheDocument();
  pending = drafts([]);
  ui.rerender(<ContentReviewPanel classroomId={7} revision={2} onOpenMaterial={open}/>);
  expect(await screen.findByText("当前班级没有待审批内容")).toBeVisible();
  expect(screen.queryByRole("link", {name:/待审题目/})).not.toBeInTheDocument();
});

it("pages large material collections on demand and resets position when switching class", async () => {
  const fetch = vi.fn(async (url: string) => {
    const { pathname, searchParams } = new URL(url, "http://localhost");
    expect(searchParams.get("size")).toBe("25");
    if (pathname.includes("/classrooms/8/")) {
      expect(searchParams.get("page")).toBe("1");
      return Response.json(drafts([], 4));
    }
    const page = Number(searchParams.get("page"));
    return Response.json(drafts(page === 1 ? [ppt] : [pdf], 0, page, 26));
  });
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup(), open = vi.fn();
  const ui = render(<ContentReviewPanel classroomId={7} onOpenMaterial={open}/>);
  await user.click(await screen.findByRole("button", {name:"下一页课件"}));
  expect(await screen.findByText("数据存取 Part 2")).toBeVisible();
  expect(screen.getByRole("button", {name:"下一页课件"})).toBeDisabled();
  ui.rerender(<ContentReviewPanel classroomId={8} onOpenMaterial={open}/>);
  expect(await screen.findByRole("link", {name:/待审题目.*4 道/})).toBeVisible();
  expect(screen.queryByText("数据存取 Part 2")).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("offers a retry when the material summary fails", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({detail:"暂时无法读取"},{status:503}))
    .mockResolvedValueOnce(Response.json(drafts([ppt])));
  vi.stubGlobal("fetch",fetch);
  render(<ContentReviewPanel classroomId={7} onOpenMaterial={vi.fn()}/>);
  expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取");
  expect(screen.queryByText("当前班级没有待审批内容")).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button",{name:"重新加载"}));
  expect(await screen.findByText(ppt.material_title)).toBeVisible();
});
