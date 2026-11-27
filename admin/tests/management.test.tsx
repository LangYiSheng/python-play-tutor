import { render } from "./render-with-toasts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ClassroomManagement } from "@/features/management/classrooms";
import { Accounts } from "@/features/management/accounts";
import { GlobalOverview } from "@/features/management/overview";
import { RecordViewer } from "@/pages/teaching";
import { Students } from "@/pages/students";

const row = { id: 7, name: "一班", teacher_id: 12, teacher_name: "任老师", status: "active", student_count: 2, has_learning_records: true };
const props = { courseId: 3, onCreate: vi.fn(), onOpen: vi.fn(), onChanged: vi.fn() };
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
  expect(within(dialog).queryByRole("textbox")).toBeNull();
  await user.click(confirm);
  await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
  expect(fetch.mock.calls.filter(([path, init]) => init.method === "DELETE" && path === "/api/teacher/classrooms/7")).toHaveLength(1);
});

it("lets administrators reset an unbound legacy student's password using a valid temporary password", async () => {
  const student = { id: 5, name: "小林", student_id: "0005", role: "student", classrooms: [], must_change_password: false, disabled: false };
  const fetch = vi.fn(async (url: string, init: RequestInit) => Response.json(url.endsWith("/classrooms/management") ? [row] : init.method === "POST" ? { ok: true } : { items: [student], total: 1 }));
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(<Accounts role="student" />);
  await screen.findByText("未关联班级");
  expect(screen.getByRole("button", { name: "修改姓名" })).toBeVisible();
  const reset = screen.getByRole("button", { name: "重置密码" });
  expect(reset).toBeVisible();
  screen.getByRole("button", { name: "管理 小林" }).focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("menuitem", { name: "删除账号" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "停用账号" })).toBeVisible();
  await user.keyboard("{Escape}");
  await user.click(reset);
  expect(await screen.findByRole("dialog")).toHaveTextContent("学号不足 8 位");
  const confirm = screen.getByRole("button", { name: "确认重置密码" });
  await user.type(screen.getByLabelText("临时密码"), "1234567");
  expect(screen.getByText("密码至少需要 8 位")).toBeVisible();
  expect(confirm).toBeDisabled();
  await user.type(screen.getByLabelText("临时密码"), "8");
  await user.click(confirm);
  expect(await screen.findByText("已重置密码 · 小林")).toBeVisible();
  expect(fetch.mock.calls.filter(([url, init]) => url === "/api/admin/accounts/5/reset-password" && init.method === "POST")).toHaveLength(1);
});

it.each(["classroom", "admin"] as const)("adds a single student from the %s student-management page", async scope => {
  const classroom = scope === "classroom";
  const student = { id: 8, name: "测试学生", student_id: "00000034", role: "student", classrooms: [], must_change_password: true, disabled: false };
  let added = false;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") {
      added = true;
      return Response.json(classroom ? { created: 1, bound: 0, existing: 0 } : student);
    }
    if (url.endsWith("/classrooms/management")) return Response.json([]);
    const items = added ? [student] : [];
    return Response.json(classroom ? items : { items, total: items.length });
  });
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(classroom ? <Students classroomId={7} /> : <Accounts role="student" />);
  if (classroom) expect(screen.getByRole("button", { name: "导入学生" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "添加学生" }));
  const dialog = within(await screen.findByRole("dialog"));
  await user.type(dialog.getByLabelText("学号"), student.student_id);
  await user.type(dialog.getByLabelText("姓名"), student.name);
  await user.click(dialog.getByRole("button", { name: "添加学生" }));
  const payload = { student_id: student.student_id, name: student.name };
  expect(fetch).toHaveBeenCalledWith(classroom ? "/api/teacher/classrooms/7/students" : "/api/admin/students", expect.objectContaining({
    method: "POST", body: JSON.stringify(classroom ? { students: [payload] } : payload),
  }));
  expect(await screen.findByText(student.name)).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

it("shows the learner's chapter tasks and measured reading time", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    student: { name: "小林", student_id: "5" }, submissions: [],
    chapters: [{ id: 2, title: "Python 基础", completed: false, tasks: [
      { id: "reading:2:3", title: "变量讲义", kind: "reading", required: true, completed: false, locked: false, current: 2, total: 4, unit: "页" },
    ] }],
    participation: [{ id: "reading:2:3", title: "变量讲义", chapter: "Python 基础", kind: "reading",
      created_at: null, read_pages: 2, read_seconds: 15 }],
  })));
  render(<RecordViewer classroomId={7} studentId={5} onClose={vi.fn()} />);
  await user.click(screen.getByRole("tab", { name: "章节任务" }));
  expect(await screen.findByText("Python 基础")).toBeVisible();
  expect(screen.getByText("未完成 · 2/4 页")).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "活动参与" }));
  expect(await screen.findByText("已读 2 页，有效阅读 15 秒")).toBeVisible();
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

it("copies the class join code and opens its student roster", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([{...row, join_code: "test-code"}])));
  const user = userEvent.setup();
  render(<ClassroomManagement {...props} isAdmin={false} />);
  await user.click(await screen.findByRole("button", { name: "复制一班的加入码" }));
  expect(await navigator.clipboard.readText()).toBe("test-code");
  expect(screen.getByRole("button", { name: "进入小镇" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "学生管理" }));
  expect(props.onOpen).toHaveBeenCalledWith(row.id);
  expect(screen.queryByRole("columnheader", { name: "任课教师" })).toBeNull();
  expect(screen.queryByRole("button", { name: "学习记录" })).toBeNull();
});

it("hides table headers and column tools when classroom list is empty", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
  render(<ClassroomManagement {...props} isAdmin={false} />);
  expect(await screen.findByText("尚未创建班级")).toBeVisible();
  expect(screen.getByRole("button", { name: "创建第一个班级" })).toBeVisible();
  expect(screen.queryByRole("columnheader", { name: "班级名称" })).toBeNull();
  expect(screen.queryByRole("button", { name: "列设置" })).toBeNull();
});
