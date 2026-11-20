import { test, expect } from "@playwright/test";
import { setup, json, pdf } from "./helpers";

test("十一章十四份课件的全貌、来源、原位编辑与知识点题库", async ({ page, request }, info) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1396, height: 1000 });
  const { headers, scoped, chapterId, tag } = await setup(page, request, "知识图谱验收");
  const chapterIds = [chapterId];
  for (let n = 2; n <= 11; n++) {
    const ch = await json<{ id: number }>(await request.post(scoped("/teacher/chapters"), {
      headers, data: { title: `第 ${n} 章\u3000计算思维与 Python 程序设计`, order_index: n },
    }));
    chapterIds.push(ch.id);
  }
  const split = new Set([4, 5, 7]);
  const materialIds = [];
  for (let n = 1; n <= 11; n++) {
    for (let part = 1; part <= (split.has(n) ? 2 : 1); part++) {
      // Chapter 4's first deck also belongs to chapter 11.
      const chapters = [chapterIds[n - 1]];
      if (n === 4 && part === 1) chapters.push(chapterIds[10]);
      const item = await json<{ id: number }>(await request.post(scoped("/teacher/materials/upload"), { headers, multipart: {
        title: `第 ${n} 章课件${split.has(n) ? " Part " + part : ""}`, chapter_ids: JSON.stringify(chapters),
        file: { name: `deck-${n}-${part}.pdf`, mimeType: "application/pdf", buffer: pdf() },
      }}));
      materialIds.push(item.id);
    }
  }
  const point = await json<{ id: number }>(await request.post(scoped("/teacher/knowledge-points"), {
    headers, data: { chapter_id: chapterIds[3], title: "变量与数据类型", content: {} },
  }));
  await json(await request.post(scoped("/teacher/questions"), { headers, data: {
    id: "graph-" + tag, title: "给变量赋值", kind: "boolean", prompt: "变量可以保存一个整数", answer: true,
    chapter_ids: [chapterIds[3]], knowledge_point_ids: [point.id], status: "ready",
  }}));
  const bankRequests: URL[] = [];
  page.on("request", req => {
    const url = new URL(req.url());
    if (url.pathname === "/api/teacher/questions") bankRequests.push(url);
  });
  await page.getByRole("link", { name: "知识图谱" }).click();
  await expect(page.locator(".cg-node")).toHaveCount(26);
  await expect(page.locator(".react-flow__edge")).toHaveCount(26);
  await expect(page.getByText("11 章 · 14 份资料")).toBeVisible();
  const canvas = await page.locator(".cg-canvas").boundingBox();
  await expect.poll(async () => {
    const bounds = await page.locator(".cg-node").evaluateAll(els => els.map(el => el.getBoundingClientRect().toJSON()));
    return bounds.every(b => b.x >= canvas!.x && b.right <= canvas!.x + canvas!.width &&
      b.y >= canvas!.y && b.bottom <= canvas!.y + canvas!.height);
  }).toBe(true);
  await page.screenshot({ path: info.outputPath("course-overview.png"), animations: "disabled" });
  const selected = page.locator(`.react-flow__node[data-id="material-${materialIds[3]}"]`);
  await selected.click();
  const panel = page.getByRole("complementary", { name: "节点详情" });
  await expect(panel.getByText("暂无可核对的课件页与知识点关联")).toBeVisible();
  await expect(panel.getByRole("button", { name: /^第 11 章/ })).toBeVisible();
  await expect.poll(async () => {
    const [card, inspector] = await Promise.all([selected.boundingBox(), panel.boundingBox()]);
    if (!card || !inspector) return false;
    return card.x + card.width <= inspector.x || card.y + card.height <= inspector.y;
  }).toBe(true);
  await panel.getByRole("button", { name: "编辑资料" }).click();
  const viewport = await page.locator(".react-flow__viewport").getAttribute("style");
  await page.getByLabel("资料名称").fill("第四章课件 Part 1（已校订）");
  await page.getByRole("button", {name: "保存资料"}).click();
  await expect(panel.getByRole("heading", {name: "第四章课件 Part 1（已校订）"})).toBeVisible();
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute("style", viewport!);
  expect(bankRequests).toEqual([]);
  await panel.getByRole("button", {name: /^第 4 章/}).click();
  await expect(panel.getByRole("button", {name: "变量与数据类型"})).toBeVisible();
  await expect(page.locator(".cg-node")).toHaveCount(26);
  await expect(page.locator(".cg-point")).toHaveCount(0);
  await panel.getByRole("button", {name: "变量与数据类型"}).click();
  await expect(panel.getByText("暂无已确认的课件来源")).toBeVisible();
  await expect(page.locator(".cg-point")).toHaveCount(1);
  await expect(page.locator(".cg-question")).toHaveCount(1);
  await panel.getByRole("button", {name: /给变量赋值/}).click();
  await expect(panel.getByText("变量可以保存一个整数")).toBeVisible();
  await panel.getByRole("button", {name: "编辑题目"}).click();
  await page.getByLabel("题目名称").fill("给变量重新赋值");
  await page.getByRole("button", {name: "保存题目"}).click();
  await expect(panel.getByRole("heading", {name: "给变量重新赋值"})).toBeVisible();
  await panel.getByRole("button", {name: "变量与数据类型"}).click();
  await panel.getByRole("link", {name: "查看关联题目（1）"}).click();
  await expect(page.getByText("给变量重新赋值", {exact: true})).toBeVisible();
  expect(bankRequests.at(-1)?.searchParams.get("knowledge_point_id")).toBe(String(point.id));
  await page.goBack();
  await expect(panel.getByRole("heading", {name: "变量与数据类型"})).toBeVisible();
  await page.getByRole("button", { name: "课程全貌", exact: true }).click();
  await expect(page.locator(".cg-node")).toHaveCount(26);
  await page.getByRole("button", { name: "任务队列" }).click();
  await expect(page.getByText("当前没有进行中的生成任务")).toBeVisible();
});

test("全课程搜索可定位未展开内容、分类型翻页，并展示知识点题目或未归章题", async ({ page, request }) => {
  const { headers, scoped, chapterId, tag } = await setup(page, request, "课程搜索验收");
  const point = await json<{ id: number }>(await request.post(scoped("/teacher/knowledge-points"), {
    headers, data: { chapter_id: chapterId, title: "循环专题", content: {} },
  }));
  for (let i = 1; i <= 12; i++) {
    await json(await request.post(scoped("/teacher/questions"), { headers, data: {
      id: "graph-search-" + tag + "-" + i, title: "循环习题 " + String(i).padStart(2, "0"),
      kind: "boolean", prompt: i === 12 ? "孤立记录仅能通过题干定位" : "判断命题", answer: true,
      chapter_ids: i === 12 ? [] : [chapterId], knowledge_point_ids: i === 12 ? [] : [point.id], status: i === 12 ? "draft" : "ready",
    }}));
  }
  const banks: URL[] = [];
  page.on("request", req => {
    const url = new URL(req.url());
    if (url.pathname === "/api/teacher/questions") banks.push(url);
  });
  await page.getByRole("link", { name: "知识图谱" }).click();
  await page.setViewportSize({ width: 430, height: 915 });
  const search = page.getByRole("textbox", { name: "搜索图谱节点" });
  const results = page.getByRole("region", { name: "课程搜索结果" });
  const detail = page.getByRole("complementary", { name: "节点详情" });
  await search.fill("循环");
  await results.getByRole("button", {name: "题目", exact: true}).click();
  await expect(results.locator(".cg-search-hit")).toHaveCount(10);
  const bounds = await results.boundingBox();
  expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 430).toBe(true);
  await results.getByRole("button", {name: "下一页"}).click();
  await expect(results.locator(".cg-search-hit")).toHaveCount(2);
  await results.getByRole("button", {name: /题目\s*循环习题 12/}).click();
  await expect(detail.getByText("尚未归章")).toBeVisible();
  await expect(detail.getByText("尚未关联知识点")).toBeVisible();
  await expect(page.locator(".cg-question.cg-selected")).toHaveText(/循环习题 12/);
  expect(banks).toEqual([]);
  const approval = page.getByRole("button", {name: /待审批\s*1 项/});
  const tasks = page.getByRole("button", {name: /^任务队列/});
  await expect(approval).toBeInViewport();
  await expect(tasks).toBeInViewport();
  const [linkBox, taskBox] = await Promise.all([approval.boundingBox(), tasks.boundingBox()]);
  expect(Math.abs(linkBox!.y - taskBox!.y)).toBeLessThan(1);
  await expect(page.getByRole("navigation", {name: "班级导航"}).getByText("待审批")).toHaveCount(0);
  // Wait for the user-controlled zoom to finish, then compare the exact restored transform.
  const initial = await page.locator(".react-flow__viewport").getAttribute("style");
  await page.getByRole("button", {name: "缩小图谱"}).click();
  const map = page.locator(".react-flow__viewport");
  await expect(map).not.toHaveAttribute("style", initial!);
  await expect.poll(async () => {
    const zoom = await page.evaluate(() => history.state?.courseGraph?.viewport?.zoom);
    const scale = await map.evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
    return typeof zoom === "number" && Math.abs(scale - zoom) < .00001;
  }).toBe(true);
  const viewport = await map.getAttribute("style");
  await approval.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/teacher\/content-graph$/);
  const review = page.getByRole("complementary", {name: "待审批"});
  const drafts = review.getByRole("link", {name: /待审题目/});
  await expect(drafts).toHaveAttribute("href", "/teacher/content-list?tab=questions&status=draft&reviewable=true");
  await expect(detail).toHaveCount(0);
  await expect(approval).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".cg-question.cg-selected")).toHaveText(/循环习题 12/);
  await tasks.click();
  await expect(review).toHaveCount(0);
  await expect(tasks).toHaveAttribute("aria-expanded", "true");
  await expect(approval).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("complementary", {name: "任务队列"}).getByRole("button", {name: "关闭详情栏"}).click();
  await expect(detail.getByRole("heading", {name: "循环习题 12"})).toBeVisible();
  await expect(map).toHaveAttribute("style", viewport!);
  await approval.click();
  await drafts.click();
  await expect(page.getByRole("row").filter({hasText: "循环习题 12"})).toBeVisible();
  await expect(page.getByRole("row").filter({hasText: "循环习题 01"})).toHaveCount(0);
  const draftRequest = banks.at(-1)?.searchParams;
  expect(draftRequest?.get("status")).toBe("draft");
  expect(draftRequest?.get("reviewable")).toBe("true");
  const bankCount = banks.length;
  await page.goBack();
  await expect(detail.getByRole("heading", {name: "循环习题 12"})).toBeVisible();
  await page.getByRole("button", { name: "课程全貌", exact: true }).click();
  await search.fill("仅能通过题干定位");
  await expect(results.locator(".cg-search-hit")).toHaveCount(1);
  await search.press("Enter");
  await expect(detail.getByRole("heading", {name: "循环习题 12"})).toBeVisible();
  await search.fill("循环");
  await results.getByRole("button", {name: "知识点", exact: true}).click();
  await results.locator(".cg-search-hit").first().click();
  await expect(detail.getByRole("heading", {name: "循环专题"})).toBeVisible();
  await expect(page.locator(".cg-question")).toHaveCount(6);
  await detail.getByRole("button", {name: "下一页"}).click();
  await expect(page.locator(".cg-question")).toHaveCount(5);
  expect(banks.length - bankCount).toBeGreaterThanOrEqual(2);
  expect(banks.slice(bankCount).every(u => u.searchParams.get("size") === "6" && u.searchParams.get("knowledge_point_id") === String(point.id))).toBe(true);
});

test("图谱工具栏同页切换审批与队列，支持键盘和旧审批书签", async ({ page }, info) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("pythontopia-reborn-session", "graph-task-fixture");
    sessionStorage.setItem("classroom:1", "9");
  });
  const materials = [31, 32].map(id => ({ id, kind: "pdf", title: `第 ${id} 份课件`, status: "ready", chapter_ids: [3] }));
  const running = { id: 6, run_id: 21, material_id: 31, status: "running", queued: false, stage: "script",
    kind: "generate", done: 2, total: 5, percent: 40, started_at: "2026-11-20T08:00:00Z" };
  const jobs = [running, { ...running, id: 8, run_id: 22, material_id: 32, status: "interrupted", percent: 20 }];
  let draft = true;
  let outOfScopeRequests = 0;
  await page.context().route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let response: unknown = [];
    if (path.endsWith("/auth/me")) response = { id: 1, name: "教师", role: "teacher" };
    if (path.endsWith("/classrooms")) response = [{ id: 9, name: "当前班级", teacher_id: 1 }];
    if (path.endsWith("/course-graph")) response = { title: "测试课程", chapters: [{ id: 3, title: "计算思维" }], materials };
    if (path.endsWith("/course-graph/tasks")) response = jobs;
    if (path.endsWith("/content-review/summary")) response = { total: Number(draft), material_count: Number(draft), question_count: 0 };
    if (path.endsWith("/content-review/materials")) response = { total: Number(draft), page: 1, question_count: 0,
      items: draft ? [{material_id: 31, material_title: materials[0].title, material_kind: "pdf", narration_count: 1, first_page_no: 2}] : [] };
    if (path.endsWith("/teacher/materials/31")) response = materials[0];
    if (path.includes("/materials/999")) outOfScopeRequests++;
    if (path.endsWith("/materials/31/narrations")) response = { material_id: 31, title: materials[0].title,
      coverage: {pages: 2, covered: 1, missing: 1, draft: Number(draft), accepted: Number(!draft), rejected: 0, unavailable: 0, stale: 0},
      pages: [1, 2].map(n => ({page_no: n, title: "课件原文", has_text: true, source_chars: 4, source_text: "课件原文", raw_text: "课件原文", digest: null,
        narration: n === 1 ? null : {text: "待核对的讲稿", status: draft ? "draft" : "accepted", source: "ai_generated", anchors: []} })) };
    if (path.endsWith("/narrations/2/accept") && route.request().method() === "POST") { draft = false; response = {page_no: 2, status: "accepted"}; }
    if (path.endsWith("/narrations/audio")) response = {available: false, pages: []};
    if (path.endsWith("/narrations/quota")) response = {available: false, used_today: 0, daily_limit: 0};
    if (path.endsWith("/narrations/job")) response = {running: false, status: "done", failed: [], done: 0, total: 0};
    if (path.includes("/narrations/calibrate")) response = {issues: [], fixes: [], terms: [], windows: 0};
    if (path.endsWith("/page-image")) { await route.fulfill({status: 404}); return; }
    if (path.includes("/course-graph/materials/")) response = { points: [], pages: 5, narrations: 0, audio: 0, drafts: 0 };
    await route.fulfill({ json: response });
  });
  await page.goto("/teacher/content-graph");
  await expect(page.locator('.react-flow__node[data-id="material-31"]')).toHaveAccessibleName(/执行中.*40%/);
  await expect(page.locator('.react-flow__node[data-id="material-32"] .cg-task-error')).toBeVisible();
  await expect(page.locator(".cg-node.cg-task")).toHaveCount(0);
  const approval = page.getByRole("button", { name: /^待审批/ });
  await expect(approval).toHaveAccessibleName(/待审批\s*1 项/);
  const queue = page.getByRole("button", { name: /任务队列\s*2 项/ });
  await expect(approval).toHaveAttribute("aria-expanded", "false");
  for (const [width, height] of [[1396, 1000], [430, 915], [885, 871]]) {
    await page.setViewportSize({ width, height });
    await page.mouse.move(0, 0);
    await expect(approval).toBeInViewport();
    await expect(queue).toBeInViewport();
    // Sidebar width animates briefly while the viewport crosses a layout breakpoint.
    await expect.poll(async () => {
      const [a, b] = await Promise.all([approval.boundingBox(), queue.boundingBox()]);
      return a && b && a.y - b.y;
    }).toBe(0);
    const metrics = await page.locator(".cg-bar > [data-slot=button]").evaluateAll(elements => elements.map(el => {
      const style = getComputedStyle(el);
      const frame = el.getBoundingClientRect();
      const icon = el.querySelector("svg")!.getBoundingClientRect();
      return { top: frame.top, width: frame.width, style: [frame.height, style.paddingLeft, style.paddingRight,
        style.gap, style.color, style.backgroundColor, style.borderColor, style.borderRadius, style.fontSize,
        style.fontWeight, style.display, style.alignItems, icon.width, icon.height, icon.y - frame.y] };
    }));
    expect(metrics).toHaveLength(2);
    expect(metrics[0].style).toEqual(metrics[1].style);
    expect(metrics[0].top).toBe(metrics[1].top);
    expect(metrics[0].width).toBeLessThan(metrics[1].width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator(".cg-bar").screenshot({ path: info.outputPath("toolbar-" + width + ".png"), animations: "disabled" });
  }
  await page.getByRole("textbox", {name: "搜索图谱节点"}).focus();
  await page.keyboard.press("Tab");
  await expect(approval).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/teacher\/content-graph$/);
  const review = page.getByRole("complementary", {name: "待审批"});
  await expect(review).toBeFocused();
  const source = review.getByRole("button", {name: /第 31 份课件/});
  await source.click();
  const narration = page.getByRole("dialog", {name: "课程生成 · 第 31 份课件"});
  await expect(narration.getByRole("button", {name: /第 2 页/})).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await narration.getByRole("button", {name: "接受", exact: true}).click();
  await expect(narration.getByRole("button", {name: /第 2 页.*已接受/})).toHaveAttribute("aria-current", "true");
  await narration.getByRole("button", {name: "关闭", exact: true}).click();
  await expect(approval).toHaveAccessibleName(/待审批\s*0 项/);
  await expect(source).toHaveCount(0);
  await expect(review).toBeVisible();
  await review.focus();
  await page.keyboard.press("Escape");
  await expect(approval).toBeFocused();
  await expect(review).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(queue).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(queue).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: /讲稿生成.*第 31 份课件/ }).click();
  const active = page.locator('.react-flow__node[data-id="task-21"]');
  await expect(active).toHaveAccessibleName(/执行中.*40%/);
  await expect(page.locator(".react-flow__edge.animated")).toHaveCount(1);
  await queue.click();
  await page.getByRole("button", { name: /讲稿生成.*第 32 份课件/ }).click();
  const error = page.locator('.react-flow__node[data-id="task-22"]');
  await expect(error).toHaveAccessibleName(/已中断.*20%/);
  await expect(error.locator(".cg-task-error")).toBeVisible();
  await expect(page.locator(".react-flow__edge.animated")).toHaveCount(0);
  await expect.poll(async () => {
    const [node, drawer] = await Promise.all([error.boundingBox(), page.locator(".cg-inspector").boundingBox()]);
    return !!(node && drawer && (node.x + node.width <= drawer.x || node.y + node.height <= drawer.y));
  }).toBe(true);
  const nodeDetails = page.getByRole("complementary", { name: "节点详情" });
  await nodeDetails.getByRole("button", { name: "关闭详情栏" }).click();
  await expect(page.locator(".cg-selected")).toHaveCount(0);
  await queue.click();
  await queue.click();
  await approval.click();
  await review.getByRole("button", { name: "关闭详情栏" }).click();
  await expect(nodeDetails).toHaveCount(0);
  await page.reload();
  await expect(queue).toBeVisible();
  await expect(nodeDetails).toHaveCount(0);
  await expect(page.locator(".cg-selected")).toHaveCount(0);
  await page.goto("/teacher/content-review?chapter_id=3&material_id=31");
  await expect(page).toHaveURL(/\/teacher\/content-graph$/);
  await expect(narration).toBeVisible();
  await narration.getByRole("button", {name: "关闭", exact: true}).click();
  await expect(review).toBeVisible();
  await page.reload();
  await expect(review).toBeVisible();
  await expect(narration).toHaveCount(0);
  await queue.click();
  await page.reload();
  await expect(approval).toHaveAttribute("aria-expanded", "false");
  await expect(review).toHaveCount(0);
  await page.goto("/teacher/content-review?chapter_id=3&material_id=999");
  await expect(review.getByText("这份资料在当前班级无法审校。")).toBeVisible();
  expect(outOfScopeRequests).toBe(0);
});
