import { afterEach, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContentReviewPage } from "../src/pages/content-review";

afterEach(() => vi.unstubAllGlobals());

it("names exactly which drafts will be accepted and clears the queue when switching classes", async () => {
  const user = userEvent.setup();
  const items = [
    { kind: "question", id: "q7", title: "变量命名", source: "imported", page_no: 0, question_kind: "fill", revision: "4" },
    { kind: "narration", id: "10", title: "循环语句", source: "ai", page_no: 2, question_kind: "", revision: "abc" },
  ];
  const decisions: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/decisions")) {
      decisions.push(JSON.parse(String(init.body)));
      return Response.json({ count: 1 });
    }
    const rows = url.includes("/classrooms/8/") ? [] : items.slice(decisions.length);
    return Response.json({ items: rows, total: rows.length, page: 1 });
  }));
  const page = render(<ContentReviewPage classroomId={7} />);
  await user.click(await screen.findByRole("checkbox", { name: "选择变量命名" }));
  await user.click(screen.getByRole("button", { name: "通过所选 1 项" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("题目 · 变量命名")).toBeInTheDocument();
  expect(within(dialog).queryByText(/循环语句/)).not.toBeInTheDocument();
  expect(decisions).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "确认通过 1 项" }));
  expect(await screen.findByText("已通过 1 项")).toBeInTheDocument();
  expect(decisions).toEqual([{ decision: "accept", items: [{ kind: "question", id: "q7", revision: "4" }] }]);
  page.rerender(<ContentReviewPage classroomId={8} />);
  expect(await screen.findByText("当前班级没有待审批内容")).toBeInTheDocument();
  expect(screen.queryByText(/循环语句/)).not.toBeInTheDocument();
});
