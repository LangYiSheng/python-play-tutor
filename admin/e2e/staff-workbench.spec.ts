import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const adminId = process.env.E2E_ADMIN_STUDENT_ID;
const adminPassword = process.env.E2E_ADMIN_PASSWORD;

async function login(page: Page, id: string, password: string) {
  await page.goto("/teacher/");
  await page.getByLabel("学号", { exact: true }).fill(id);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
}

test("管理员创建教师，教师首次登录建班，管理员查看并管理该班", async ({ page, browser, baseURL, request }) => {
  test.skip(!adminId || !adminPassword, "需要隔离环境的管理员账号");
  const id = String(Date.now()), password = randomUUID(), className = `任课班 ${id}`;
  await login(page, adminId!, adminPassword!);
  await page.getByRole("link", { name: "全站设置" }).click();
  await expect(page.getByRole("textbox", { name: "模型名称", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "资料合成管理" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("tab", { name: "评测管理" }).click();
  await expect(page.getByRole("button", { name: "暂停派发" })).toBeEnabled();
  await page.getByRole("link", { name: "教师管理" }).click();
  await page.getByRole("button", { name: "创建教师" }).click();
  await page.getByLabel("姓名", { exact: true }).fill("验收教师");
  await page.getByLabel("登录学号").fill(id);
  await page.getByLabel(/初始密码/).fill(password);
  await page.getByRole("button", { name: "确认创建" }).click();
  await expect(page.getByRole("cell").filter({ hasText: id })).toBeVisible();
  const context = await browser.newContext({ baseURL, viewport: { width: 1920, height: 1080 } });
  try {
    const teacher = await context.newPage();
    await login(teacher, id, password);
    await teacher.getByLabel("当前密码", { exact: true }).fill(password);
    const newPassword = randomUUID();
    await teacher.getByLabel("新密码", { exact: true }).fill(newPassword);
    await teacher.getByLabel("确认新密码").fill(newPassword);
    await teacher.getByRole("button", { name: "保存密码" }).click();
    await expect(teacher.getByRole("heading", { name: "班级管理" })).toBeVisible();
    await expect(teacher.getByRole("link", { name: "教师管理" })).toHaveCount(0);
    await teacher.getByRole("link", { name: "课程包" }).click();
    await expect(teacher.getByRole("table", { name: "可用课程包" })).toBeVisible();
    await expect(teacher.getByRole("button", { name: "导出课程包" })).toBeDisabled();
    await teacher.getByRole("link", { name: "班级管理" }).click();
    await teacher.getByRole("button", { name: "创建班级" }).click();
    await teacher.getByLabel("班级名称").fill(className);
    await teacher.getByLabel("课程来源").click();
    await teacher.getByRole("option", { name: "创建空课程" }).click();
    await teacher.getByRole("dialog").getByRole("button", { name: "创建班级" }).click();
    const nav = teacher.getByRole("navigation", { name: "班级导航" });
    for (const group of ["班级教学", "课程内容", "课程编排", "任务与设置"]) {
      await expect(nav.getByText(group, { exact: true })).toBeVisible();
    }
    await page.getByRole("link", { name: "全局概览" }).click();
    const row = page.getByRole("row").filter({ hasText: className });
    await expect(row).toContainText("验收教师");
    await row.getByRole("button", { name: "进入班级" }).click();
    await expect(page.getByLabel("当前班级")).toContainText(className);
    await page.getByRole("link", { name: "课程结构" }).click();
    await page.getByRole("button", { name: "新增章节" }).click();
    await page.getByLabel("名称", { exact: true }).fill("管理员编写的章节");
    await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("cell", { name: "管理员编写的章节", exact: true })).toBeVisible();
    await teacher.getByRole("link", { name: "课程结构" }).click();
    await expect(teacher.getByRole("cell", { name: "管理员编写的章节", exact: true })).toBeVisible();
    await teacher.getByRole("link", { name: "学生账号" }).click();
    await teacher.getByRole("button", { name: "添加学生" }).click();
    const studentId = `0${id}`;
    await teacher.getByLabel("学号", { exact: true }).fill(studentId);
    await teacher.getByLabel("姓名", { exact: true }).fill("保留账号的学生");
    await teacher.getByRole("button", { name: "确认添加" }).click();
    await expect(teacher.getByRole("cell", { name: studentId, exact: true })).toBeVisible();

    const loginResponse = await request.post("/api/auth/login", { data: { student_id: studentId, password: studentId } });
    expect(loginResponse.ok()).toBeTruthy();
    const initial = await loginResponse.json();
    const studentPassword = randomUUID();
    const changed = await request.post("/api/auth/password", {
      headers: { Authorization: `Bearer ${initial.access_token}` }, data: { new_password: studentPassword },
    });
    expect(changed.ok()).toBeTruthy();
    const headers = { Authorization: `Bearer ${(await changed.json()).access_token}` };
    const membership = await request.get("/api/classrooms", { headers });
    const [{ id: classroomId }] = await membership.json();
    const move = await request.put("/api/world/position", {
      headers, data: { classroom_id: classroomId, map_key: "town_hub", tile_x: 22, tile_y: 36, direction: "down" },
    });
    expect(move.ok()).toBeTruthy();
    await teacher.getByRole("link", { name: "班级管理" }).click();
    await teacher.getByRole("button", { name: `管理 ${className}`, exact: true }).click();
    await expect(teacher.getByRole("menuitem", { name: "归档" })).toBeVisible();
    await expect(teacher.getByRole("menuitem", { name: "正式删除" })).toHaveCount(0);
    await teacher.keyboard.press("Escape");

    await page.getByRole("link", { name: "班级管理" }).click();
    await page.getByRole("button", { name: `管理 ${className}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "正式删除" }).click();
    await expect(page.getByRole("dialog")).toContainText("1 名学生");
    await page.getByLabel("确认班级全名").fill(className);
    await page.getByRole("dialog").getByRole("button", { name: "确认正式删除" }).click();
    await expect(page.getByRole("row").filter({ hasText: className })).toHaveCount(0);
    await page.getByRole("link", { name: "学生管理" }).click();
    await expect(page.getByRole("row").filter({ hasText: studentId })).toContainText("未关联班级");
    const relogin = await request.post("/api/auth/login", { data: { student_id: studentId, password: studentPassword } });
    expect(relogin.ok()).toBeTruthy();
    const remaining = await request.get("/api/classrooms", { headers: { Authorization: `Bearer ${(await relogin.json()).access_token}` } });
    expect(await remaining.json()).toEqual([]);
    await page.getByRole("link", { name: "班级管理" }).click();
    await page.getByLabel("班级状态").click();
    await page.getByRole("option", { name: "已删除" }).click();
    await page.getByRole("row").filter({ hasText: className }).getByRole("button", { name: "学习记录" }).click();
    await expect(page.getByRole("dialog")).toContainText(studentId);
  } finally {
    await context.close();
  }
});
