import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

export async function provisionStudent(
  request: APIRequestContext, teacher: Record<string, string>, classroomId: number, name: string, base = "",
) {
  const student_id = `0${BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 24))}`;
  const password = `Resident-${randomUUID()}`;
  const created = await request.post(`${base}/api/teacher/classrooms/${classroomId}/students`, {
    headers: teacher, data: { students: [{ student_id, name }] },
  });
  expect(created.status(), await created.text()).toBe(201);
  const login = await request.post(`${base}/api/auth/login`, { data: { student_id, password: student_id } });
  expect(login.ok(), await login.text()).toBe(true);
  const changed = await request.post(`${base}/api/auth/password`, {
    headers: { Authorization: `Bearer ${(await login.json()).access_token}` },
    data: { new_password: password },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  const identity = await changed.json() as {
    access_token: string;
    user: { id: number; student_id: string; name: string; dev_tools_enabled: boolean };
  };
  return { identity, credentials: { student_id, password } };
}

export async function signInStudent(page: Page, { student_id, password }: { student_id: string; password: string }) {
  await page.getByLabel("学号", { exact: true }).fill(student_id);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "进入小镇", exact: true }).click();
}

export async function visitLibrary(page: Page) {
  await page.locator(".hud-dock").getByRole("button", { name: "去图书馆", exact: true }).click();
  const dialogue = page.getByRole("dialog", { name: "角色对白" });
  await expect(dialogue).toBeVisible({ timeout: 45_000 });
  await dialogue.getByRole("button", { name: /查看学习资料/ }).click();
}
