import { expect, test } from "@playwright/test";

test("教师用键盘和鼠标调整章节活动顺序，刷新后保留", async ({page}) => {
  const titles: Record<string, string> = {a: "基础练习", b: "进阶练习", c: "章节测验"};
  let order = ["a", "b", "c"];
  await page.addInitScript(() => sessionStorage.setItem("pythontopia-reborn-session", "activity-order-fixture"));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/chapters/1/activities/order")) {
      const body = route.request().postDataJSON();
      if (JSON.stringify(body.previous) !== JSON.stringify(order))
        return route.fulfill({status:409, json:{detail:"活动顺序已变更"}});
      order = body.ordered;
      return route.fulfill({json:{ok:true}});
    }
    const data = path.endsWith("/auth/me") ? {id:1, role:"teacher", name:"测试教师"}
      : path === "/api/classrooms" ? [{id:1, course_id:1, teacher_id:1, name:"测试班"}]
      : path === "/api/teacher/courses" ? [{id:1, teacher_id:1, name:"测试课程"}]
      : path.endsWith("/material-tasks") ? {items:[]}
      : path.endsWith("/catalog") ? {chapters:[{id:1, title:"基础", order_index:1}], npcs:[], knowledge_points:[],
        activities:order.map((id, i) => ({id, title:titles[id], chapter_id:1, order_index:i, question_ids:[],
          kind:id === "c" ? "assessment" : "practice", practice_kind:"objective"}))} : [];
    return route.fulfill({json:data});
  });
  await page.goto("/teacher/activities?course=1&class=1");
  const handle = (name: string) => page.getByRole("button", {name:"拖动排序："+name});
  await handle("基础练习").focus();
  await page.keyboard.press("Space");
  await expect(handle("基础练习")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("status").filter({hasText:"droppable area b"})).toBeAttached();
  await page.keyboard.press("Space");
  await expect.poll(() => order).toEqual(["b", "a", "c"]);

  const source = await handle("章节测验").boundingBox();
  const target = await handle("进阶练习").boundingBox();
  if (!source || !target) throw Error("排序手柄不可见");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps:12});
  await page.mouse.up();
  await expect.poll(() => order).toEqual(["c", "b", "a"]);
  await page.reload();
  await expect(page.locator(".activity-rows h3")).toHaveText(["章节测验", "进阶练习", "基础练习"]);
});
