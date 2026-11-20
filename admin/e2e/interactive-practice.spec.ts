import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window === window.top) sessionStorage.setItem("pythontopia-reborn-session", "preview-fixture");
  });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const data = path === "/api/auth/me" ? { id: 1, role: "teacher", name: "预览教师", must_change_password: false }
      : path === "/api/classrooms" ? [{ id: 1, name: "预览班级", teacher_id: 1 }]
      : path === "/api/teacher/courses" ? { chapters: [{ id: 1, title: "测试章节" }], knowledge_points: [], activities: [], npcs: [] } : [];
    await route.fulfill({ json: data });
  });
});

test("教师在隔离预览内试答两种模板并检查脚本与私有答案是否一致", async ({ page }) => {
  await page.goto("/teacher/questions");
  await page.getByRole("button", { name: "新增题目" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "题型" }).click();
  await page.getByRole("option", { name: "交互练习题" }).click();
  await dialog.getByRole("tab", {name:"编写与试答"}).click();
  await dialog.getByText("从示例开始").click();
  await dialog.getByRole("button",{name:"试用示例"}).click();
  await expect(dialog.frameLocator('iframe[title="教学示例试用区"]').getByLabel("起点 start")).toBeVisible();
  page.once("dialog", confirmation=>confirmation.accept());
  await dialog.getByRole("button",{name:"用此示例编写"}).click();
  await dialog.getByText("从示例开始").click();
  await dialog.getByRole("button", { name: "运行预览", exact: true }).click();
  const frame = dialog.frameLocator('iframe[title="学生交互练习预览"]');
  const check = dialog.getByRole("button", { name: "检查预览作答" });
  await check.click();
  await expect(dialog.getByText(/脚本判定错误/)).toBeVisible();
  await frame.getByLabel("起点 start").selectOption("1");
  await frame.getByLabel("终点 stop").selectOption("8");
  await frame.getByLabel("步长 step").selectOption("2");
  await dialog.getByRole("button", { name: "查看助教收到的状态" }).click();
  const displayed = dialog.locator("div[role=status]").filter({ hasText: "助教收到的当前题面状态" }).locator("pre");
  expect(JSON.parse(await displayed.innerText())).toMatchObject({ 起点: 1, 步长: 2, 当前亮灯编号: [1, 3, 5, 7] });
  await check.click();
  await expect(dialog.getByText(/脚本判定正确/)).toBeVisible();
  await expect(dialog.getByText("本次脚本判定与私有答案一致。")).toBeVisible();

  await dialog.getByText("从示例开始").click();
  await dialog.getByRole("combobox", { name: "教学示例" }).click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["点亮小镇路灯", "整理采集背包"]);
  await page.getByRole("option", { name: "整理采集背包" }).click();
  page.once("dialog", confirmation => confirmation.accept());
  await dialog.getByRole("button", { name: "用此示例编写" }).click();
  await dialog.getByText("从示例开始").click();
  await dialog.getByRole("tab", {name:"私有判定"}).click();
  await dialog.getByLabel("私有正确提交值（JSON）").fill("false");
  await dialog.getByRole("button", { name: "重新运行预览" }).click();
  const pop = frame.getByRole("button", { name: /取出栈顶/ });
  await expect(pop).toBeVisible();
  while (await pop.isEnabled()) await pop.click();
  for (const name of ["药草", "蘑菇", "水晶"]) await frame.getByRole("button", { name: "入栈：" + name }).click();
  await check.click();
  await expect(dialog.getByText(/脚本判定正确/)).toBeVisible();
  await expect(dialog.getByText(/脚本判定与私有答案不一致/)).toBeVisible();
});

test("旧题可试答和保留草稿，修复状态与判定回调后才能设为可用", async ({ page }) => {
  const js = 'practice.onCheck(() => practice.incorrect("请再试一次", 0));';
  const question = {
    id: "old", title: "已有交互题", prompt: "请操作", kind: "interactive",
    status: "ready", source: {}, source_type: "imported", chapter_ids: [1], knowledge_point_ids: [],
    answer: 1, interactive: { html: "<p>练习内容</p>", css: "", js },
  };
  const writes: string[] = [];
  await page.route(/\/api\/teacher\/questions(?:[/?]|$)/, async route => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      Object.assign(question, body);
      writes.push(body.status);
      await route.fulfill({ json: question });
    } else await route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/old")
      ? question : {items: [question], total: 1, page: 1} });
  });
  await page.goto("/teacher/questions");
  await page.getByRole("button", { name: "编辑已有交互题" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", {name:"编写与试答"}).click();
  await dialog.getByRole("button", { name: "运行预览" }).click();
  await dialog.getByRole("button", { name: "查看助教收到的状态" }).click();
  await expect(dialog.getByRole("alert")).toContainText("onGetState");
  await dialog.getByRole("button", { name: "检查预览作答" }).click();
  await expect(dialog.getByText(/脚本判定错误/)).toBeVisible();

  const save = dialog.getByRole("button", { name: "保存题目" });
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText("读取助教初始状态");
  await expect(page.locator('iframe[title="交互题保存校验"]')).toHaveCount(0);
  expect(writes).toEqual([]);
  await dialog.getByRole("tab", {name:"题目信息"}).click();
  await dialog.getByRole("combobox", { name: "状态" }).click();
  await page.getByRole("option", { name: "待审核" }).click();
  await save.click();
  await expect(page.getByText(/已保存为草稿.*onGetState/)).toBeVisible();
  expect(writes).toEqual(["draft"]);
  await page.getByRole("button", { name: "编辑已有交互题" }).click();
  await dialog.getByRole("combobox", { name: "状态" }).click();
  await page.getByRole("option", { name: "可用", exact: true }).click();
  await dialog.getByRole("tab", {name:"编写与试答"}).click();
  await dialog.getByRole("tab", { name: "JavaScript" }).click();
  const code = dialog.getByRole("textbox", { name: "JavaScript 源码" });
  const snapshot = 'practice.onGetState(() => ({ selected: [] }));';
  await code.fill(snapshot + '\npractice.onCheck(() => { throw Error("判定故障"); });');
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText("判定故障");
  expect(writes).toEqual(["draft"]);
  await code.fill(snapshot + "\n" + js);
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual(["draft", "ready"]);
});
