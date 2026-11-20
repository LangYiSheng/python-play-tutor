import { test, expect } from "@playwright/test";
import { setup, json, pdf } from "./helpers";

test("十一章十四份课件的全貌、来源、原位编辑与知识点题库", async ({ page, request }, info) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1396, height: 1000 });
  const { headers, scoped, chapterId, tag } = await setup(page, request, "知识图谱验收");
  const chapterIds = [chapterId];
  for (let n = 2; n <= 11; n++) {
    const ch = await json<{ id: number }>(await request.post(scoped("/teacher/chapters"), {
      headers, data: { title: `第 ${n} 章　计算思维与 Python 程序设计`, order_index: n },
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
  await panel.getByRole("button", { name: "编辑资料" }).click();
  const viewport = await page.locator(".react-flow__viewport").getAttribute("style");
  await page.getByLabel("资料名称").fill("第四章课件 Part 1（已校订）");
  await page.getByRole("button", {name: "保存资料"}).click();
  await expect(panel.getByRole("heading", {name: "第四章课件 Part 1（已校订）"})).toBeVisible();
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute("style", viewport!);
  expect(bankRequests).toEqual([]);
  await panel.getByRole("button", {name: /^第 4 章/}).click();
  await panel.getByRole("button", {name: "变量与数据类型"}).click();
  await expect(panel.getByText("暂无已确认的课件来源")).toBeVisible();
  await panel.getByRole("link", {name: "查看关联题目（1）"}).click();
  await expect(page.getByText("给变量赋值", {exact: true})).toBeVisible();
  expect(bankRequests.at(-1)?.searchParams.get("knowledge_point_id")).toBe(String(point.id));
  await page.goBack();
  await expect(panel.getByRole("heading", {name: "变量与数据类型"})).toBeVisible();
  await page.getByRole("button", { name: "课程全貌", exact: true }).click();
  await expect(page.locator(".cg-node")).toHaveCount(26);
  await page.getByRole("button", { name: "任务队列" }).click();
  await expect(page.getByText("当前没有进行中的生成任务")).toBeVisible();
});
