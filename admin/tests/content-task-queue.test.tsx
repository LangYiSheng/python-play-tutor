import { render } from "./render-with-toasts";
import { afterEach, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDetail, TaskQueue, useTaskCommands } from "../src/features/content-workspace/task-queue";
import type { Job } from "../src/features/content-workspace/graph-layout";

afterEach(() => vi.unstubAllGlobals());
const job: Job = {kind: "generate", stage: "script", material_id: 3, done: 2, total: 8,
  percent: 25, queued: false, status: "running", cancellable: true, started_at: "2026-11-20T16:00:00Z"};

function Queue({ jobs, reload }: { jobs: Job[]; reload: () => void }) {
  const commands = useTaskCommands(1, reload);
  return <>{commands.feedback}<TaskQueue jobs={jobs} onSelect={() => {}} titleOf={() => "循环语句"} request={commands.request}/></>;
}

it("reports actual progress and confirms cancellation for exactly the displayed run", async () => {
  const user = userEvent.setup(), reload = vi.fn();
  const fetch = vi.fn(async () => Response.json({status:"cancelling"}));
  vi.stubGlobal("fetch", fetch);
  render(<Queue jobs={[job]} reload={reload}/>);
  expect(screen.getByText("25%")).toBeInTheDocument();
  await user.click(screen.getByRole("button", {name: "取消任务"}));
  expect(fetch).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/循环语句/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", {name: "确认取消任务"}));
  expect(await screen.findByText("已请求取消")).toBeVisible();
  expect(fetch).toHaveBeenCalledWith("/api/teacher/courses/1/synthesis/3/cancel",
    expect.objectContaining({method:"POST", body:JSON.stringify({expected_started_at:job.started_at})}));
  expect(reload).toHaveBeenCalledOnce();
});

it("shows interrupted jobs and offers retry only for a retryable attempt", async () => {
  const user = userEvent.setup(), request = vi.fn();
  const interrupted = {...job, status:"interrupted", percent:null, cancellable:false, retryable:false, retry_note:"需核查执行结果"};
  const view = render(<TaskDetail job={interrupted} material="判断语句" request={request}/>);
  expect(screen.getByText("已中断").closest(".inspector-task")).toHaveAttribute("data-failed", "true");
  expect(screen.getByText("未记录百分比")).toBeInTheDocument();
  expect(screen.queryByRole("button", {name:"重试"})).not.toBeInTheDocument();
  expect(screen.getByText("需核查执行结果")).toBeInTheDocument();
  const failed = {...interrupted, status:"failed", retryable:true};
  view.rerender(<TaskDetail job={failed} material="判断语句" request={request}/>);
  await user.click(screen.getByRole("button", {name:"重试"}));
  expect(request).toHaveBeenCalledWith({command:"retry", job:failed, material:"判断语句"});
});

it("dismisses a failed task after confirmation and preserves its failed status", async () => {
  const user = userEvent.setup(), reload = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({status:"failed", queue_dismissed:true})));
  render(<Queue jobs={[{...job, status:"failed", retryable:true}]} reload={reload}/>);
  await user.click(screen.getByRole("button", {name:"取消任务"}));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/失败记录将保留/)).toBeVisible();
  await user.click(within(dialog).getByRole("button", {name:"确认取消任务"}));
  expect(await screen.findByText("失败任务已从队列移除")).toBeVisible();
  expect(reload).toHaveBeenCalledOnce();
});
