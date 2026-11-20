import { afterEach, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContentListPage } from "../src/pages/content-list";
import { ContentActionDialog } from "../src/features/content-workspace/action-dialog";

const chapter = { id: 17, title: "基础语法", order_index: 1, owner_id: 2 };
const point = { id: 81, title: "表达式", chapter_id: 17, owner_id: 2, content: { summary_markdown: "原说明", notes: "保留附加内容" } };
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

afterEach(() => { vi.unstubAllGlobals(); history.replaceState({}, "", "/"); });

it("pages only the selected knowledge point and loads other catalogs on demand", async () => {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", async (path: string) => {
    const url = new URL(path, location.origin);
    calls.push(url);
    if (url.pathname.endsWith("/courses")) return json({ chapters: [chapter] });
    if (url.pathname.endsWith("/knowledge-point-labels")) return json([point]);
    const page = Number(url.searchParams.get("page"));
    return json({ page, total: 35, items: [{ id: "q" + page, title: "测试题 " + page,
      kind: "fill", source_type: "imported", status: "ready", chapter_ids: [chapter.id] }] });
  });
  history.replaceState({}, "", "/teacher/content-list?tab=questions&point=81");
  const user = userEvent.setup();
  render(<ContentListPage classroomId={12} />);
  expect(await screen.findByText("知识点 · 表达式")).toBeVisible();
  expect(await screen.findByText("测试题 1")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByText("测试题 2")).toBeVisible();
  const requests = calls.filter(url => url.pathname.endsWith("/questions"));
  expect(requests.map(url => url.searchParams.get("page"))).toEqual(["1", "2"]);
  expect(requests.every(url => url.searchParams.get("knowledge_point_id") === "81" && url.searchParams.get("size") === "10")).toBe(true);
  expect(calls.every(url => url.searchParams.get("classroom_id") === "12")).toBe(true);
  expect(calls.some(url => url.pathname.endsWith("/materials"))).toBe(false);
  await user.click(screen.getByRole("tab", { name: "章节" }));
  expect(await screen.findByText("基础语法")).toBeVisible();
  await act(async () => { history.back(); });
  expect(await screen.findByText("知识点 · 表达式")).toBeVisible();
});

it("graph editing reads the selected point and saves through the curriculum editor", async () => {
  const saved = vi.fn(), closed = vi.fn();
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const url = new URL(path, location.origin);
    if (init.method === "PUT") saved(url.pathname, url.searchParams.get("classroom_id"), JSON.parse(String(init.body)));
    return json(url.pathname.endsWith("/courses") ? { chapters: [chapter] } : point);
  });
  const user = userEvent.setup();
  render(<ContentActionDialog classroomId={12} action={{ kind: "point", mode: "edit", id: 81 }} onClose={closed} />);
  const name = await screen.findByLabelText("名称");
  expect(name).toHaveValue("表达式");
  await user.clear(name);
  await user.type(name, "表达式与求值");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(closed).toHaveBeenCalledWith(true));
  expect(saved).toHaveBeenCalledWith("/api/teacher/knowledge-points/81", "12", { title: "表达式与求值", content: point.content });
});
