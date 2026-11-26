import { expect, test } from "@playwright/test";

test("保留所选班级，独立浏览课程题库分页", async ({page}) => {
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
    const classes = [{id: 7, name: "第一班", teacher_id: 1, course_id: 1}, {id: 9, name: "第二班", teacher_id: 1, course_id: 1}];
    let result: unknown = [];
    if (path.endsWith("/auth/me")) result = {id: 1, name: "教师", role: "teacher"};
    if (path.endsWith("/classrooms")) result = classes;
    if (path.endsWith("/materials")) result = {page: pageNo, total: 0, items: []};
    if (path.endsWith("/courses")) result = [{id: 1, name: "课程", teacher_id: 1}];
    if (path.endsWith("/catalog")) result = {chapters: [{id: 1, title: "第一章", order_index: 1}]};
    if (path.endsWith("/questions")) result = {page: pageNo, total: 1000, items: [{
      id: "q" + pageNo, title: "题目页" + pageNo, chapter_ids: [1], status: "ready", source_type: "imported", kind: "fill",
    }]};
    await route.fulfill({json: result});
  });
  await page.goto("/teacher/teaching?course=1&class=9");
  const nav = page.getByRole("navigation", {name: "课程导航"});
  await expect(page.getByLabel("当前班级")).toContainText("第二班");
  await page.getByRole("button", {name: "收起导航", exact: true}).click();
  await expect(page.getByRole("button", {name: "展开导航", exact: true})).toHaveAttribute("aria-expanded", "false");
  await expect(nav.getByRole("link", {name: "定时开放"})).toBeVisible();
  await expect(nav.getByRole("link", {name: "定时开放"})).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", {name: "章节与课件"}).click();
  await page.getByRole("button", {name: "上传资料", exact: true}).click();
  await page.getByLabel("资料名称").fill("取消的资料");
  await page.keyboard.press("Escape");
  await page.getByRole("button", {name: "上传资料", exact: true}).click();
  await expect(page.getByLabel("资料名称")).toHaveValue("");
  await page.getByLabel("资料名称").fill("本次也取消");
  await page.getByRole("button", {name: "取消", exact: true}).click();
  await page.getByRole("link", {name: "班级管理"}).click();
  await expect(nav).toBeVisible();
  await nav.getByRole("link", {name: "题库与组卷"}).click();
  await expect(page.getByLabel("当前班级")).toHaveCount(0);
  await expect(page.getByText("题目页1")).toBeVisible();
  await page.getByRole("button", {name: "下一页"}).click();
  await expect(page.getByText("题目页2")).toBeVisible();
  await nav.getByRole("link", {name: "定时开放"}).click();
  await expect(page.getByLabel("当前班级")).toContainText("第二班");
  for (const url of requests.filter(url => /\/(questions|knowledge-points)$/.test(url.pathname))) {
    expect(url.searchParams.get("size")).toBe("10");
    expect(url.pathname).toBe("/api/teacher/courses/1/questions");
    expect(url.searchParams.has("classroom_id")).toBe(false);
  }
  expect(requests.some(url => url.pathname === "/api/teacher/courses/1/catalog" && url.searchParams.get("view") === "chapters")).toBe(true);
  expect(prompts).toEqual([]);
  await page.setViewportSize({width: 390, height: 844});
  await page.reload();
  await expect(page.getByRole("button", {name: "展开导航", exact: true})).toHaveAttribute("aria-expanded", "false");
  await expect(nav.getByRole("link", {name: "定时开放"})).toBeVisible();
  await expect(nav.getByRole("link", {name: "定时开放"})).toHaveAttribute("aria-current", "page");
});
