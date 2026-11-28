import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const adminId = process.env.E2E_ADMIN_STUDENT_ID;
const adminPassword = process.env.E2E_ADMIN_PASSWORD;

async function login(page: Page, id: string, password: string, target = "/teacher/") {
  await page.goto(target);
  await page.getByLabel("工号", { exact: true }).fill(id);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
}

test("管理员创建教师，教师首次登录建班，管理员查看并管理该班", async ({ page, browser, baseURL, request }) => {
  test.skip(!adminId || !adminPassword, "需要隔离环境的管理员账号");
  const id = String(Date.now()), className = `任课班 ${id}`;
  const teacherName = `验收教师 ${id}`, renamed = `已改名教师 ${id}`;
  await login(page, adminId!, adminPassword!);
  await page.getByRole("link", { name: "进入后台" }).click();
  await page.getByRole("link", { name: "全站设置" }).click();
  await expect(page.getByRole("textbox", { name: "模型名称", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "任务管理" }).click();
  await expect(page.getByRole("group", { name: "生成任务总览" })).toBeVisible();
  await page.getByRole("link", { name: "评测管理" }).click();
  await expect(page.getByRole("heading", { name: "评测管理", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "教师管理" }).click();
  await page.getByRole("button", { name: "创建教师" }).click();
  await page.getByLabel("姓名", { exact: true }).fill(teacherName);
  await page.getByLabel("工号", { exact: true }).fill(id);
  const initialPassword = page.getByLabel("初始密码", { exact: true });
  const create = page.getByRole("button", { name: "确认创建" });
  await initialPassword.fill("1234567");
  await expect(initialPassword).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("密码至少需要 8 位")).toBeVisible();
  await expect(create).toBeDisabled();
  await initialPassword.clear();
  await create.click();
  await expect(page.locator('[data-slot="toast"]').getByText(`已创建教师账号 ${id}。`)).toBeVisible();
  await expect(page.getByRole("cell").filter({ hasText: id })).toBeVisible();
  const context = await browser.newContext({ baseURL, viewport: { width: 1920, height: 1080 } });
  try {
    const teacher = await context.newPage();
    await login(teacher, id, id, "/teacher/teachers");
    const newPassword = randomUUID();
    await teacher.getByLabel("新密码", { exact: true }).fill(newPassword);
    await teacher.getByLabel("确认新密码").fill(newPassword);
    await teacher.getByRole("button", { name: "保存密码" }).click();
    await expect(teacher).toHaveURL(/\/teacher\/classes$/);
    await expect(teacher.getByRole("heading", { name: "班级管理" })).toBeVisible();
    await expect(teacher.getByRole("link", { name: "教师管理" })).toHaveCount(0);
    await expect(teacher.getByRole("link", { name: "课程包" })).toHaveCount(0);
    await teacher.getByRole("button", { name: "创建班级" }).click();
    await teacher.getByLabel("班级名称").fill(className);
    await teacher.getByLabel("课程来源").click();
    await teacher.getByRole("option", { name: "创建空课程" }).click();
    await teacher.getByRole("dialog").getByRole("button", { name: "创建班级" }).click();
    const nav = teacher.getByRole("navigation", { name: "课程导航" });
    for (const entry of ["任务管理", "评测管理"]) {
      await expect(nav.getByRole("link", { name: entry })).toBeVisible();
    }
    await nav.getByRole("link", { name: "课程包" }).click();
    await expect(teacher.getByRole("table", { name: "可用课程包" })).toBeVisible();
    await expect(teacher.getByRole("button", { name: "导出课程包" })).toBeEnabled();
    await page.getByRole("link", { name: "全局概览" }).click();
    const row = page.getByRole("row").filter({ hasText: className });
    await expect(row).toContainText(teacherName);
    await row.getByRole("button", { name: "进入班级" }).click();
    await expect(page.getByLabel("当前班级")).toContainText(className);
    await page.getByRole("link", { name: "内容列表" }).click();
    await page.getByRole("button", { name: "新增章节" }).click();
    await page.getByLabel("名称", { exact: true }).fill("管理员编写的章节");
    await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("cell", { name: "管理员编写的章节", exact: true })).toBeVisible();
    await teacher.getByRole("link", { name: "内容列表" }).click();
    await expect(teacher.getByRole("cell", { name: "管理员编写的章节", exact: true })).toBeVisible();
    await teacher.getByRole("link", { name: "学生账号" }).click();
    await teacher.getByRole("button", { name: "导入学生" }).click();
    const studentId = `0${id}`;
    await teacher.getByLabel("CSV 或 XLSX 文件").setInputFiles({
      name: "roster.csv", mimeType: "text/csv", buffer: Buffer.from(`学号,姓名\n${studentId},保留账号的学生\n`),
    });
    await teacher.getByRole("button", { name: "确认导入" }).click();
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
    await page.keyboard.press("Escape");

    await teacher.locator("button.account").click();
    await teacher.getByRole("menuitem", { name: "退出账号" }).click();
    await expect(teacher.getByRole("button", { name: "进入工作台" })).toBeVisible();
    await login(teacher, id, newPassword, "/teacher/teachers");
    await expect(teacher).toHaveURL(/\/teacher\/classes$/);

    await page.getByRole("link", { name: "教师管理" }).click();
    const teacherRow = page.getByRole("row").filter({ hasText: teacherName });
    await expect(teacherRow.getByRole("button", { name: "重置密码" })).toBeVisible();
    await teacherRow.getByRole("button", { name: "修改姓名" }).click();
    await page.getByLabel("姓名", { exact: true }).fill(renamed);
    await page.getByRole("button", { name: "保存姓名" }).click();
    await expect(page.getByRole("row").filter({ hasText: id })).toContainText(renamed);
    await page.getByRole("button", { name: `管理 ${renamed}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "停用账号" }).click();
    await page.getByRole("button", { name: "确认停用账号" }).click();
    await expect(page.getByRole("row").filter({ hasText: id })).toContainText("已停用");
    expect((await request.post("/api/auth/login", { data: { student_id: id, password: newPassword } })).status()).toBe(401);
    await page.getByRole("button", { name: `管理 ${renamed}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "删除账号" }).click();
    const deletion = page.getByRole("dialog");
    const confirm = deletion.getByRole("button", { name: "确认删除账号" });
    await expect(deletion.getByRole("textbox")).toHaveCount(0);
    await confirm.click();
    await expect(page.getByRole("row").filter({ hasText: id })).toHaveCount(0);
    expect((await request.post("/api/auth/login", { data: { student_id: studentId, password: studentPassword } })).ok()).toBeTruthy();
  } finally {
    await context.close();
  }
});
