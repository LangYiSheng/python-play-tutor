import { test, expect } from "@playwright/test";
import { setup, go, pdf } from "./helpers";

test("从章节上传 PDF 并发布整份必读任务点", async ({page,request}) => {
  const {chapterId, scoped, headers}=await setup(page,request,"章节任务点");
  await go(page,"章节");
  await page.getByRole("button",{name:"上传资料到此章",exact:true}).click();
  await page.getByLabel("资料名称").fill("单页讲义");
  await page.getByLabel("文件（支持拖入多文件或 .zip）",{exact:true}).setInputFiles({name:"单页讲义.pdf",mimeType:"application/pdf",buffer:pdf()});
  await page.getByRole("button",{name:"保存资料"}).click();
  await expect(page.getByRole("checkbox",{name:"单页讲义必读"})).toHaveCount(0);
  await page.getByRole("link",{name:"管理本章学习任务"}).click();
  await expect(page.getByRole("heading",{name:"学习任务",exact:true})).toBeVisible();
  const required=page.getByLabel("单页讲义必读");
  await expect(required).not.toBeChecked();
  const materialsPath=scoped("/teacher/materials");
  await expect.poll(async () => {
    const response=await request.get(materialsPath,{headers});
    return (await response.json()).find((m:{title:string})=>m.title==="单页讲义")?.status;
  },{timeout:60000}).toBe("ready");
  await required.check();
  await expect(required).toBeChecked();
  const response=await request.get(scoped(`/teacher/chapters/${chapterId}/material-tasks`),{headers});
  expect((await response.json()).items).toMatchObject([{title:"单页讲义",required:true,rule:{}}]);
  for(const title of ["新增客观题练习","新增编程题练习","新增测验"]) {
    await page.getByRole("button",{name:title}).click();
    await expect(page.getByRole("dialog",{name:title})).toBeVisible();
    await page.getByRole("button",{name:"取消",exact:true}).click();
  }
});
