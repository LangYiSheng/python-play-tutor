import { expect, test } from "@playwright/test";

test("保留所选班级，取消资料编辑后可继续浏览分页目录", async ({page}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("pythontopia-reborn-session", "catalog-fixture");
    sessionStorage.setItem("classroom:1", "9");
  });
  const requests: URL[] = [];
  const prompts: string[] = [];
  page.on("dialog", async dialog => { prompts.push(dialog.message()); await dialog.dismiss(); });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    requests.push(url);
    const path = url.pathname;
    const pageNo = Number(url.searchParams.get("page") ?? 1);
    const classes = [{id: 7, name: "第一班", teacher_id: 1}, {id: 9, name: "第二班", teacher_id: 1}];
    let result: unknown = [];
    if (path.endsWith("/auth/me")) result = {id: 1, name: "教师", role: "teacher"};
    if (path.endsWith("/classrooms")) result = classes;
    if (path.endsWith("/materials")) result = {page: pageNo, total: 0, items: []};
    if (path.endsWith("/courses")) result = {chapters: [{id: 1, title: "第一章", order_index: 1}]};
    if (path.endsWith("/questions")) result = {page: pageNo, total: 1000, items: [{
      id: "q" + pageNo, title: "题目页" + pageNo, chapter_ids: [1], status: "ready", source_type: "imported", kind: "fill",
    }]};
    if (path.endsWith("/knowledge-points")) result = {page: pageNo, total: 10000, items: [{
      id: pageNo, title: "知识点页" + pageNo, content: {}, chapter_id: 1,
    }]};
    await route.fulfill({json: result});
  });
  await page.goto("/teacher/materials");
  const nav = page.getByRole("navigation", {name: "班级导航"});
  await expect(page.getByLabel("当前班级")).toContainText("第二班");
  await page.getByRole("button", {name: "上传资料"}).click();
  await page.getByLabel("资料名称").fill("取消的资料");
  await page.keyboard.press("Escape");
  await page.getByRole("button", {name: "上传资料"}).click();
  await expect(page.getByLabel("资料名称")).toHaveValue("");
  await page.getByLabel("资料名称").fill("本次也取消");
  await page.getByRole("button", {name: "取消", exact: true}).click();
  await page.getByRole("link", {name: "班级管理"}).click();
  await expect(nav).toBeVisible();
  await nav.getByRole("link", {name: "内容列表"}).click();
  await page.getByRole("tab", {name: "题目", exact: true}).click();
  await expect(page.getByLabel("当前班级")).toContainText("第二班");
  await expect(page.getByText("题目页1")).toBeVisible();
  await page.getByRole("button", {name: "下一页"}).click();
  await expect(page.getByText("题目页2")).toBeVisible();
  await page.getByRole("tab", {name: "知识点", exact: true}).click();
  await expect(page.getByText("知识点页1")).toBeVisible();
  await page.getByRole("button", {name: "下一页"}).click();
  await expect(page.getByText("知识点页2")).toBeVisible();
  for (const url of requests.filter(url => /\/(questions|knowledge-points)$/.test(url.pathname))) {
    expect(url.searchParams.get("size")).toBe("10");
    expect(url.searchParams.get("classroom_id")).toBe("9");
  }
  expect(requests.filter(url => url.pathname.endsWith("/courses")).every(url => url.searchParams.get("view") === "chapters")).toBe(true);
  expect(prompts).toEqual([]);
});
