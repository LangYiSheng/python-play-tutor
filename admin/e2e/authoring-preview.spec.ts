import { expect, test, type Locator } from "@playwright/test";

const chapters = [{id:1, order_index:1, title:"课程导论"}, {id:2, order_index:2, title:"基础语法"}];
const questions = [
  {id:"interactive-fixture", kind:"interactive", title:"合成互动题", prompt:"把蓝色卡片放到左侧"},
  {id:"python-fixture", kind:"python", title:"合成编程题", prompt:"输出两个整数的和"},
].map(question => ({...question, chapter_ids:[1], knowledge_point_ids:[], source_type:"imported", source:{},
  status:"draft", owner_id:1, options:[], samples:[], hidden_cases:[]}));

test.beforeEach(async ({page}) => {
  await page.setViewportSize({width:1456, height:1253});
  await page.addInitScript(() => sessionStorage.setItem("pythontopia-reborn-session", "authoring-preview-fixture"));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith("/auth/me") ? {id:1, role:"teacher", name:"测试教师"}
      : path.endsWith("/classrooms") ? [{id:1, course_id:1, teacher_id:1, name:"测试班"}]
      : path.endsWith("/teacher/courses") ? [{id:1, teacher_id:1, name:"测试课程"}]
      : path.endsWith("/catalog") ? {chapters, knowledge_points:[], activities:[], npcs:[]}
      : path.endsWith("/questions") ? {items:questions, total:2, page:1}
      : questions.find(question => path.endsWith("/questions/"+question.id)) ?? [];
    await route.fulfill({json:data});
  });
});

test("批量上传预览逐项显示章节和名称，并以教师手选章节提交", async ({page}) => {
  const filenames = ["第二章基础语法.pdf", "第三章条件判断.pdf"];
  let manifest: {name:string; size:number}[] = [];
  let submittedChapters: string | null = null;
  await page.route("**/api/teacher/courses/1/materials/upload-*", async route => {
    const request = route.request();
    const bytes = request.postDataBuffer()!;
    const form = await new Response(new Uint8Array(bytes), {headers:{"Content-Type":request.headers()["content-type"]!}}).formData();
    if (request.url().endsWith("/upload-preview")) {
      manifest = JSON.parse(String(form.get("manifest")));
      return route.fulfill({json:{items:filenames.map((filename, i) => ({filename, title:filename.slice(0,-4),
        chapter:{order_index:2+i, title:i ? "条件判断" : "基础语法", new:i === 1}})), skipped:[]}});
    }
    submittedChapters = String(form.get("chapter_ids"));
    return route.fulfill({json:{created:[], skipped:[]}});
  });
  await page.goto("/teacher/courseware?course=1&class=1");
  await page.getByRole("button", {name:"上传资料", exact:true}).click();
  const dialog = page.getByRole("dialog", {name:"上传资料"});
  await dialog.locator('input[type="file"]').setInputFiles(filenames.map(name => ({name, mimeType:"application/pdf", buffer:Buffer.from("%PDF-synthetic")})));
  const rows = dialog.getByRole("region", {name:"导入预览"}).locator("tbody tr");
  await expect(rows.nth(0).getByRole("cell")).toHaveText([filenames[0]!, "第 2 章 · 基础语法", "第二章基础语法"]);
  await expect(rows.nth(1).getByRole("cell")).toHaveText([filenames[1]!, "第 3 章 · 条件判断（新建）", "第三章条件判断"]);
  expect(manifest.map(file => file.name)).toEqual(filenames);
  await dialog.getByRole("checkbox", {name:"课程导论"}).check();
  await expect(rows.nth(0).getByRole("cell").nth(1)).toHaveText("第 1 章 · 课程导论");
  await expect(rows.nth(1).getByRole("cell").nth(1)).toHaveText("第 1 章 · 课程导论");
  await dialog.getByRole("button", {name:"开始批量导入"}).click();
  await expect.poll(() => submittedChapters).toBe("[1]");
});

async function expectTwoColumns(dialog: Locator, kind: string) {
  const prompt = dialog.getByRole("textbox", {name:"题干", exact:true});
  const type = dialog.getByRole("combobox", {name:"题型", exact:true});
  await expect(prompt).toBeInViewport();
  await expect(type).toBeInViewport();
  const left = await prompt.boundingBox();
  const right = await type.boundingBox();
  expect(left && right && left.x + left.width <= right.x).toBe(true);
  const control = kind === "python" ? dialog.getByRole("combobox", {name:"编程形式"})
    : dialog.getByRole("button", {name:"运行预览", exact:true});
  await expect(control).toBeVisible();
}

test("新增和编辑交互练习题、编程题时同屏核对题干与分类", async ({page}) => {
  await page.goto("/teacher/assessments?course=1&tab=bank");
  for (const question of questions) {
    await page.getByRole("button", {name:"新增题目", exact:true}).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", {name:"题型", exact:true}).click();
    await page.getByRole("option", {name:question.kind === "python" ? "编程题" : "交互练习题", exact:true}).click();
    await expectTwoColumns(dialog, question.kind);
    await dialog.getByRole("button", {name:"取消", exact:true}).click();
    await page.getByRole("button", {name:"编辑"+question.title, exact:true}).click();
    await expect(dialog.getByRole("textbox", {name:"题干", exact:true})).toHaveValue(question.prompt);
    await expectTwoColumns(dialog, question.kind);
    await dialog.getByRole("button", {name:"取消", exact:true}).click();
  }
});
