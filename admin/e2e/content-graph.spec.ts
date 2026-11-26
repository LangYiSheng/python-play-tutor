import { test, expect } from "@playwright/test";
import { setup, json, pdf } from "./helpers";

test("课程知识图谱的视图、知识点编辑和关联题库", async ({ page, request }, info) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1396, height: 1000 });
  const { headers, scoped, chapterId, tag, courseId } = await setup(page, request, "知识图谱验收");
  const chapterIds = [chapterId];
  for (let n = 2; n <= 11; n++) {
    const ch = await json<{ id: number }>(await request.post(scoped("/teacher/chapters"), {
      headers, data: { title: `第 ${n} 章\u3000计算思维与 Python 程序设计`, order_index: n },
    }));
    chapterIds.push(ch.id);
  }
  const split = new Set([4, 5, 7]);
  for (let n = 1; n <= 11; n++) {
    for (let part = 1; part <= (split.has(n) ? 2 : 1); part++) {
      // Chapter 4's first deck also belongs to chapter 11.
      const chapters = [chapterIds[n - 1]];
      if (n === 4 && part === 1) chapters.push(chapterIds[10]);
      await json<{ id: number }>(await request.post(scoped("/teacher/materials/upload"), { headers, multipart: {
        title: `第 ${n} 章课件${split.has(n) ? " Part " + part : ""}`, chapter_ids: JSON.stringify(chapters),
        file: { name: `deck-${n}-${part}.pdf`, mimeType: "application/pdf", buffer: pdf() },
      }}));
    }
  }
  const point = await json<{ id: number }>(await request.post(scoped("/teacher/knowledge-points"), {
    headers, data: { chapter_id: chapterIds[3], title: "变量与数据类型", content: {} },
  }));
  await json(await request.post(scoped("/teacher/questions"), { headers, data: {
    id: "graph-" + tag, title: "给变量赋值", kind: "boolean", prompt: "变量可以保存一个整数", answer: true,
    chapter_ids: [chapterIds[3]], knowledge_point_ids: [point.id], status: "ready",
  }}));
  await page.getByRole("link", { name: "知识图谱" }).click();
  await expect(page.getByText("11 章 · 1 知识点")).toBeVisible();
  await page.getByRole("button", { name: "树形", exact: true }).click();
  await expect(page.getByRole("img", { name: "PPT 知识点图谱画布" })).toBeVisible();
  await page.getByRole("button", { name: "环形", exact: true }).click();
  await expect(page.getByRole("img", { name: "PPT 知识点图谱画布" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("course-overview.png"), animations: "disabled" });
  await page.getByRole("button", { name: "列表", exact: true }).click();
  const list = page.getByRole("region", { name: "知识点列表视图" });
  await list.getByRole("textbox", { name: "筛选知识点" }).fill("变量");
  await list.getByRole("button", { name: "编辑变量与数据类型" }).click();
  await page.getByLabel("名称", { exact: true }).fill("变量与数据类型（已校订）");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(list.getByText("变量与数据类型（已校订）")).toBeVisible();

  await page.goto(`/teacher/assessments?course=${courseId}&tab=bank&point=${point.id}`);
  await expect(page.getByText("给变量赋值", {exact: true})).toBeVisible();
  await page.getByRole("tab", { name: "课程组卷" }).click();
  await expect(page.getByText("本课程尚未生成试卷", {exact: true})).toBeVisible();
  await page.getByRole("link", { name: "学习任务" }).click();
  await expect(page.getByRole("button", { name: "新增测验" })).toBeVisible();
});
