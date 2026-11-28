import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Teaching } from "../src/pages/teaching";
import { api } from "../src/lib/api";
import type { ChapterRelease } from "../src/lib/chapter-release";

afterEach(() => vi.restoreAllMocks());

it("schedules, immediately publishes and pauses the same classroom chapter", async () => {
  const user = userEvent.setup();
  let releases: ChapterRelease[] = [];
  vi.spyOn(api, "get").mockImplementation(async (path) => path.endsWith("/releases")
    ? releases : { chapters: [{ id: 7, title: "数据结构" }] });
  const put = vi.spyOn(api, "put").mockImplementation(async (_path, body) => {
    releases = [{ chapter_id: 7, ...body as Pick<ChapterRelease, "opens_at" | "status"> }];
    return {};
  });
  render(<Teaching classroomId={11} courseId={10} />);
  await user.click(await screen.findByRole("button", { name: "设置定时" }));
  fireEvent.change(screen.getByLabelText("开放时间"), { target: { value: "2099-02-03T10:30" } });
  await user.click(screen.getByRole("button", { name: "保存安排" }));
  await waitFor(() => expect(put).toHaveBeenCalledWith("/teacher/classrooms/11/releases/7",
    { status: "published", opens_at: expect.stringMatching(/^2099-/) }));
  await user.click(await screen.findByRole("button", { name: "立即发布" }));
  const pause = await screen.findByRole("button", { name: "暂停" });
  expect(screen.queryByRole("button", { name: "设置定时" })).not.toBeInTheDocument();
  expect(put).toHaveBeenLastCalledWith("/teacher/classrooms/11/releases/7", { status: "published", opens_at: null });
  await user.click(pause);
  expect(await screen.findByRole("button", { name: "立即发布" })).toBeVisible();
  expect(put).toHaveBeenLastCalledWith("/teacher/classrooms/11/releases/7", { status: "paused", opens_at: null });
});
