import {expect, test} from "@playwright/test";

test("completes the four NPC journey with a dedicated one-question exercise and exam fixture", async ({page, request}) => {
  const student = process.env.E2E_TASK_STUDENT_ID, password = process.env.E2E_TASK_PASSWORD;
  const classroom = Number(process.env.E2E_TASK_CLASSROOM);
  test.skip(!student || !password || !classroom, "需要已布置章节任务的专用验收班。");
  test.setTimeout(300000);
  const login = await request.post("/api/auth/login", {data:{student_id:student,password}});
  expect(login.ok()).toBe(true);
  const identity = await login.json();
  const headers = {Authorization: "Bearer " + identity.access_token};
  const catalogue = async () => {
    const res = await request.get("/api/chapter-tasks?classroom_id=" + classroom, {headers});
    expect(res.ok()).toBe(true);
    return (await res.json()).chapters as {
      id:number; title:string; tasks:{kind:string; title:string; current:number; required:boolean; completed:boolean; locked:boolean}[];
    }[];
  };
  const chapters = await catalogue();
  const chapter = chapters.find(c => ["reading","objective","programming","assessment"].every(kind => c.tasks.some(t => t.kind === kind)));
  expect(chapter).toBeDefined();
  await page.addInitScript(({token, id, classroom}) => {
    sessionStorage.setItem("pythontopia-reborn-session", token);
    sessionStorage.setItem("classroom:" + id, String(classroom));
  }, {token: identity.access_token, id:identity.user.id, classroom});
  await page.goto("/world");
  await page.getByRole("button",{name:"按任意键继续"}).click({timeout:60000});
  const tracker = page.locator(".quest-tracker"), switcher = tracker.getByRole("button",{name:"切换追踪目标"});
  if (await switcher.isVisible()) {
    const original = await tracker.getByRole("heading").innerText() + await tracker.locator(".quest-next").innerText();
    await switcher.click();
    await expect.poll(async () => await tracker.getByRole("heading").innerText() + await tracker.locator(".quest-next").innerText()).not.toBe(original);
  }
  const dialogue = page.getByRole("dialog",{name:"角色对白"});
  const close = page.getByRole("button",{name:"关闭当前工作区"});
  async function visit(name:string) {
    await page.locator(".hud-dock").getByRole("button",{name:/任务日志/}).click();
    await page.locator(".town-directory-item").filter({hasText:chapter!.title}).first().click();
    await page.getByRole("button",{name:"前往"+name,exact:true}).first().click();
    await expect(dialogue).toBeVisible({timeout:45000});
    await expect(dialogue.locator(".eyebrow")).toHaveText(name);
  }
  async function leave() {
    await close.click();
    await expect(dialogue).toBeVisible();
    await dialogue.getByRole("button",{name:/结束交谈/}).click();
  }
  await visit("图书管理员");
  await dialogue.getByRole("button",{name:/查看学习资料/}).click();
  await expect(page.getByRole("navigation",{name:"资料章节"}).getByRole("button")).toHaveCount(chapters.length + 1);
  const siblings = chapters.find(c => c.tasks.filter(t => t.kind === "reading").length > 1);
  if (siblings) {
    const materials = siblings.tasks.filter(t => t.kind === "reading");
    const section = page.locator(".library-chapter").filter({has:page.getByRole("heading",{name:siblings.title,exact:true})});
    await section.getByRole("button").first().click();
    const nav = page.getByRole("navigation",{name:siblings.title});
    await expect(nav).toBeVisible();
    const other = nav.getByRole("button").filter({hasText:materials[1]!.title});
    await other.click();
    await expect(nav.getByRole("button",{current:"step"})).toContainText(materials[1]!.title);
    await page.getByRole("button",{name:/返回小镇图书馆/}).click();
  }
  const read = chapter!.tasks.find(t => t.kind === "reading" && t.required)!;
  expect(read).toBeDefined();
  await page.locator(".library-chapter").filter({has:page.getByRole("heading",{name:chapter!.title,exact:true})})
    .getByRole("button",{name:new RegExp(read.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}).first().click();
  await expect(page.getByRole("navigation",{name:chapter!.title})).toBeVisible();
  const pdf = page.locator(".pdf-reader");
  if (await pdf.count()) await expect(pdf.locator("canvas")).toBeVisible();
  const row = () => catalogue().then(rows => rows.find(c=>c.id===chapter!.id)!.tasks.find(t=>t.kind==="reading"&&t.title===read.title)!);
  if (!read.completed) {
    await expect.poll(async()=>{const r=await row();return r.completed || r.current>read.current;},{timeout:30000}).toBe(true);
    for (let turn=0;turn<15 && !(await row()).completed;turn++) {
      const next=page.getByRole("button",{name:/下一页/}).first();
      if (!await next.isEnabled()) break;
      const before=await row();
      await next.click();
      await expect.poll(async()=>{const r=await row();return r.completed || r.current>before.current;},{timeout:18000}).toBe(true);
    }
  }
  await leave();
  for(const [name,label] of [["教授","客观题练习"],["练习场教练","编程题练习"],["镇长","章节测验"]]) {
    await visit(name!);
    const choice=dialogue.getByRole("button",{name:new RegExp("查看"+label)});
    await expect.poll(async () => (await dialogue.locator(".dialogue-text").textContent())?.trim() === (await dialogue.locator(".dialogue-text").getAttribute("aria-label"))).toBe(true);
    if (await choice.isVisible()) {
      await choice.click();
      await expect(page.getByRole("heading",{name:label,exact:true}).first()).toBeVisible();
      const item=page.locator(".task-row:not(:disabled)").first();
      await item.click();
      await expect(page.locator(".workspace-practice .question-body")).toBeVisible({timeout:30000});
      const category = name === "教授" ? "objective" : name === "练习场教练" ? "programming" : "assessment";
      const finished = () => catalogue().then(rows => rows.find(c=>c.id === chapter!.id)!.tasks.filter(t=>t.kind === category && t.required).every(t=>t.completed));
      if (!await finished()) {
        if (category === "programming") {
          await page.getByRole("button",{name:"提交代码",exact:true}).click();
        } else {
          await page.locator('input[type="radio"][value="true"]').first().check();
          if (category === "assessment") {
            await page.getByRole("tab",{name:"题目列表"}).click();
            await page.getByRole("button",{name:"提交试卷",exact:true}).click();
          } else {
            await page.getByRole("button",{name:"提交答案",exact:true}).click();
          }
        }
        await expect.poll(finished,{timeout:60000}).toBe(true);
      }
      await leave();
    } else {
      await expect(dialogue.locator(".dialogue-text")).toContainText(/先|练习|资料/);
      await dialogue.getByRole("button",{name:/结束交谈/}).click();
    }
  }
  const verified = (await catalogue()).find(c => c.id === chapter!.id)!;
  expect(verified.tasks.filter(t => t.required).every(t => t.completed)).toBe(true);
});
