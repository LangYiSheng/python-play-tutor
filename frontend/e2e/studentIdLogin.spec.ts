import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { signInStudent } from "./studentAccount";

test("an imported student signs in with leading zeroes and sets an eight-character password", async ({ page, request }) => {
  test.setTimeout(90_000);
  const teacherId = process.env.E2E_TEACHER_STUDENT_ID;
  const teacherPassword = process.env.E2E_TEACHER_PASSWORD;
  test.skip(!teacherId || !teacherPassword, "需要隔离环境的教师账号");
  const teacher = await request.post("/api/auth/login", { data: { student_id: teacherId, password: teacherPassword } });
  expect(teacher.ok()).toBe(true);
  const headers = { Authorization: `Bearer ${(await teacher.json()).access_token}` };
  const created = await request.post("/api/classrooms", { headers, data: { name: "学号登录验收" } });
  expect(created.status()).toBe(201);
  const classroom = await created.json();
  const course = await request.post(`/api/teacher/classrooms/${classroom.id}/course/empty`, {
    headers, data: { name: "学号登录验收课程", confirmed: true },
  });
  expect(course.ok()).toBe(true);
  const student_id = "00" + BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 20));
  const name = "学号登录验收学生";
  const roster = `/api/teacher/classrooms/${classroom.id}/students`;
  expect((await request.post("/api/auth/register", { data: { student_id, password: student_id, name } })).status()).toBe(404);
  const enrolled = await request.post(roster, { headers, data: { students: [{ student_id, name }] } });
  expect(enrolled.status()).toBe(201);
  expect((await enrolled.json()).created).toBe(1);
  const repeated = await request.post(roster, { headers, data: { students: [{ student_id, name }] } });
  expect((await repeated.json()).existing).toBe(1);

  await page.goto("/");
  const account = page.getByLabel("学号", { exact: true });
  await expect(account).toHaveAttribute("type", "text");
  await expect(account).toHaveAttribute("inputmode", "numeric");
  await expect(page.getByRole("button", { name: /注册/ })).toHaveCount(0);
  await signInStudent(page, { student_id, password: student_id });
  await expect(page.getByRole("heading", { name: "设置密码" })).toBeVisible();
  const newPassword = page.getByLabel("新密码", { exact: true });
  const confirmation = page.getByLabel("确认新密码", { exact: true });
  const save = page.getByRole("button", { name: "设置密码并继续" });
  await newPassword.fill("1234567");
  await expect(newPassword).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("密码至少需要 8 位")).toBeVisible();
  await expect(save).toBeDisabled();
  const password = "12345678";
  await newPassword.fill(password);
  await confirmation.fill("12345679");
  await expect(page.getByText("两次输入的新密码不一致")).toBeVisible();
  await expect(save).toBeDisabled();
  await confirmation.fill(password);
  await save.click();
  await expect(page).toHaveURL(/\/world$/);
  expect((await request.post("/api/auth/login", { data: { student_id: student_id.slice(2), password } })).status()).toBe(401);
  const login = await request.post("/api/auth/login", { data: { student_id, password } });
  expect(login.ok()).toBe(true);
  expect((await login.json()).user.student_id).toBe(student_id);
});
