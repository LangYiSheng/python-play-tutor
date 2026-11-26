import { it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { render } from "./render-with-toasts";
import userEvent from "@testing-library/user-event";
import { Students } from "../src/pages/students";
import { Login } from "../src/pages/login";
afterEach(() => vi.unstubAllGlobals());
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
it("previews a roster without creating accounts and preserves leading zeroes on confirmation", async () => {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/import-preview"))
        return json({ students: [{ student_id: "00123456", name: "测试学生", action: "create" }] });
      if (init.method === "POST") {
        calls.push({ url, body: JSON.parse(init.body as string) });
        return json({ created: 1, bound: 0, existing: 0 });
      }
      return json([]);
    }),
  );
  const user = userEvent.setup();
  render(<Students classroomId={31} />);
  await user.click(screen.getByRole("button", { name: "导入学生" }));
  await user.upload(screen.getByLabelText("CSV 或 XLSX 文件"),
    new File(["学号,姓名\n00123456,测试学生"], "students.csv", { type: "text/csv" }));
  await screen.findByText(/将新建 1 人/);
  expect(calls).toEqual([]);
  await user.click(screen.getByRole("button", { name: "确认导入" }));
  await screen.findByText("名册已导入");
  expect(calls).toEqual([
    {
      url: "/api/teacher/classrooms/31/students",
      body: { students: [{ student_id: "00123456", name: "测试学生" }] },
    },
  ]);
});
it("requires explicit confirmation and sends only selected students for removal", async () => {
  const mutation = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "POST") {
        mutation(JSON.parse(init.body as string));
        return json({ affected: 1 });
      }
      return json([
        {
          id: 1,
          student_id: "0001",
          name: "学生甲",
          must_change_password: false,
        },
        {
          id: 2,
          student_id: "0002",
          name: "学生乙",
          must_change_password: true,
        },
      ]);
    }),
  );
  const user = userEvent.setup();
  render(<Students classroomId={31} />);
  await user.click(await screen.findByLabelText("选择0001"));
  screen.getByRole("button", { name: "重置学生乙（0002）的密码" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("dialog")).toHaveTextContent("0002");
  await user.click(screen.getByRole("button", { name: "确认操作" }));
  await waitFor(() => expect(mutation).toHaveBeenCalledWith({
    student_ids: ["0002"],
    action: "reset-password",
  }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  mutation.mockClear();
  await user.click(screen.getByRole("button", { name: "将学生乙（0002）移出班级" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("0002");
  await user.click(screen.getByRole("button", { name: "取消" }));
  await user.click(screen.getByRole("button", { name: "移出班级" }));
  expect(mutation).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "确认操作" }));
  await waitFor(() =>
    expect(mutation).toHaveBeenCalledWith({
      student_ids: ["0001"],
      action: "remove",
    }),
  );
});
it("does not grant a student access to the teacher app", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      json({
        access_token: "student-token",
        user: { id: 1, name: "学生", role: "student", student_id: "001" },
      }),
    ),
  );
  const logged = vi.fn(),
    user = userEvent.setup();
  render(<Login onLogin={logged} />);
  await user.type(screen.getByLabelText("工号"), "001");
  await user.type(screen.getByLabelText("密码"), "password");
  await user.click(screen.getByRole("button", { name: "进入工作台" }));
  await screen.findByRole("alert");
  expect(logged).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("pythontopia-reborn-session")).toBeNull();
});
