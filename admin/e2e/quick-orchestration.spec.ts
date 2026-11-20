import { expect, test } from "@playwright/test";
import { chooseOption, go, json, pdf, setup } from "./helpers";

test("教师设置模板功能、选择授课章节并生成流程，重进后可调整测验题量", async ({ page, request }) => {
  const { cid, chapterId, headers, scoped } = await setup(page, request, "快速编排");
  const point = await json<{ id: number }>(await request.post(scoped("/teacher/knowledge-points"), {
    headers, data: { chapter_id: chapterId, title: "变量赋值" },
  }));
  const material = await json<{ id: number }>(await request.post(scoped("/teacher/materials/upload"), {
    headers, multipart: {
      title: "课堂投影片", chapter_ids: JSON.stringify([chapterId]),
      file: { name: "slides.pdf", mimeType: "application/pdf", buffer: pdf() },
    },
  }));
  await expect.poll(async () => {
    const row = await json(await request.get(scoped(`/teacher/materials/${material.id}`), { headers }));
    return row.status;
  }, { timeout: 30_000 }).toBe("ready");
  for (const id of ["exercise", "exercise-two", "quiz"]) {
    await json(await request.post(scoped("/teacher/questions"), { headers, data: {
      id, title: "变量判断", prompt: "可以给变量重新赋值吗？", kind: "boolean", status: "ready",
      source_type: "imported", answer: true, chapter_ids: [chapterId], knowledge_point_ids: [point.id],
    } }));
  }

  await go(page, "快速编排");
  const step = (name: string) => page.getByRole("tab", { name, exact: true }).click();
  await expect(page.getByRole("tab", { name: "模板与功能", selected: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "回归章节", exact: true })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "每章教学流程" })).toBeVisible();
  const chat = page.getByRole("checkbox", { name: "小镇日常闲聊" });
  const tour = page.getByRole("checkbox", { name: "认识图书馆的书架" });
  await expect(chat).toBeChecked();
  await expect(tour).toBeChecked();
  await tour.uncheck();
  await page.getByRole("button", { name: "授课章节" }).click();
  await expect(tour).toHaveCount(0);
  await page.getByRole("checkbox", { name: "回归章节", exact: true }).check();
  await expect(page.getByRole("combobox", { name: "起始章" })).toContainText("回归章节");
  const finale = page.getByRole("combobox", { name: "最终章" });
  await expect(finale).toContainText("暂不设置");
  await chooseOption(page, finale, "回归章节");
  await expect(page.getByRole("checkbox", { name: "课堂投影片" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "变量赋值" })).toBeChecked();
  await step("题量与题型");
  await page.getByRole("radio", { name: "按知识点分配" }).check();
  await page.getByRole("spinbutton", { name: "该知识点题数" }).fill("2");
  await page.getByText("指定题型数量", { exact: false }).filter({ visible: true }).first().click();
  await page.getByRole("spinbutton", { name: "判断题", exact: true }).fill("2");
  const generate = async (withFinale: boolean) => {
    await step("预览与生成");
    const preview = page.getByRole("region", { name: "课程流程预览" });
    const row = preview.getByRole("row", { name: /回归章节/ });
    await expect(row).toContainText("2 题");
    await expect(preview.getByRole("columnheader", { name: "测验总题数" })).toHaveCount(1);
    await expect(preview.getByText("小镇日常闲聊", { exact: true })).toBeVisible();
    await expect(preview.getByText("最终章总结对白", { exact: true })).toHaveCount(0);
    await expect(preview.getByText("最终章", { exact: true }).locator("xpath=following-sibling::dd[1]"))
      .toHaveText(withFinale ? "回归章节" : "暂不设置");
    await row.getByRole("button").click();
    await expect(preview.getByText(/变量赋值 · 首批 2 题/)).toBeVisible();
    await page.getByRole("button", { name: "确认生成课程流程" }).click();
    await expect(page.getByText(/课程流程已生成/)).toBeVisible();
  };
  await generate(true);
  await page.reload();
  await expect(tour).not.toBeChecked();
  await step("授课章节");
  await expect(page.getByRole("checkbox", { name: "回归章节", exact: true })).toBeChecked();
  await expect(finale).toContainText("回归章节");
  await chooseOption(page, finale, "暂不设置");
  await step("题量与题型");
  await expect(page.getByRole("spinbutton", { name: "该知识点题数" })).toHaveValue("2");
  await page.getByRole("spinbutton", { name: "每章测验总题数" }).fill("2");
  await generate(false);
  const course = await json<{ catalog: { activities: { kind: string }[] } }>(
    await request.get(`/api/teacher/classrooms/${cid}/authoring`, { headers }),
  );
  expect(course.catalog.activities.map(row => row.kind).sort()).toEqual(["assessment", "lesson", "practice"]);
});
