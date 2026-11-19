import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ClassroomManagement } from "@/features/management/classrooms";
import { Accounts } from "@/features/management/accounts";
import { GlobalOverview } from "@/features/management/overview";
import { RecordViewer } from "@/pages/teaching";

const row = { id: 7, name: "一班", teacher_id: 12, teacher_name: "任老师", status: "active", student_count: 2, has_learning_records: true };
const props = { userId: 12, onCreate: vi.fn(), onOpen: vi.fn(), onChanged: vi.fn() };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("keeps classes with learning records available for archiving while limiting formal deletion to administrators", async () => {
  const fetch = vi.fn(async (_path: string, init: RequestInit) => Response.json(init.method === "DELETE" ? { ok: true } : [row]));
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  const view = render(<ClassroomManagement {...props} isAdmin={false} />);
  (await screen.findByRole("button", { name: "管理 一班" })).focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("menuitem", { name: "归档" })).toBeVisible();
  expect(screen.queryByRole("menuitem", { name: "正式删除" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "转交班级" })).toBeNull();
  view.unmount();
  render(<ClassroomManagement {...props} isAdmin />);
  (await screen.findByRole("button", { name: "管理 一班" })).focus();
  await user.keyboard("{Enter}");
  await user.click(await screen.findByRole("menuitem", { name: "正式删除" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("2 名学生");
  expect(dialog).toHaveTextContent("学生账号和历史学习记录保留");
  const confirm = within(dialog).getByRole("button", { name: "确认正式删除" });
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText("确认班级全名"), { target: { value: "一班" } });
  await user.click(confirm);
  await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
  expect(fetch.mock.calls.filter(([path, init]) => init.method === "DELETE" && path === "/api/teacher/classrooms/7")).toHaveLength(1);
});

it("lets administrators reset an unbound student's password without creating or deleting an account", async () => {
  const student = { id: 5, name: "小林", student_id: "0005", role: "student", classrooms: [], must_change_password: false };
  const fetch = vi.fn(async (url: string, init: RequestInit) => Response.json(url.endsWith("/classrooms/management") ? [row] : init.method === "POST" ? { ok: true } : { items: [student], total: 1 }));
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(<Accounts role="student" />);
  await screen.findByText("未关联班级");
  expect(screen.queryByRole("button", { name: /删除/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "重置密码" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("学号 0005");
  await user.click(screen.getByRole("button", { name: "确认重置" }));
  expect(await screen.findByText("已重置 小林 的密码。")).toBeVisible();
  expect(fetch.mock.calls.filter(([url, init]) => url === "/api/admin/accounts/5/reset-password" && init.method === "POST")).toHaveLength(1);
});

it("reads retained grades from the history endpoint and distinguishes zero from pending", async () => {
  const fetch = vi.fn(async () => Response.json({ student: { name: "小林", student_id: "5" }, assessments: [
    { id: "1", activity_id: "midterm", activity_title: "期中测验", score: 0, max_score: 100 },
    { id: "2", activity_id: "final", activity_title: "期末测验", score: null, max_score: 100 },
  ] }));
  vi.stubGlobal("fetch", fetch);
  render(<RecordViewer classroomId={7} studentId={5} history onClose={vi.fn()} />);
  expect(await screen.findByText("期中测验")).toBeVisible();
  expect(screen.getByText("0 / 100")).toBeVisible();
  expect(screen.getByText("待判定")).toBeVisible();
  expect(fetch).toHaveBeenCalledWith("/api/teacher/classrooms/7/history/5", expect.anything());
});

it("includes completed wrong answers and timeouts in the overview", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [{
    classroom_id: 7, classroom_name: "一班", teacher_id: 12, teacher_name: "任老师", student_count: 2, task_completed: 1, task_total: 2,
    synthesis_counts: {}, judge_counts: { prepared: 1, accepted: 2, wrong_answer: 3, time_limit: 1 },
  }] })));
  render(<GlobalOverview onOpen={vi.fn()} />);
  expect(await screen.findByText("共 7 次提交")).toBeVisible();
  expect(screen.getByText(/解答错误 3/)).toHaveTextContent("运行超时 1");
});
