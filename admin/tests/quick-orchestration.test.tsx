import { render } from "./render-with-toasts";
import { afterEach, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuickOrchestration } from "../src/features/quick-orchestration/page";
import { sameRecipe, type CourseTemplate, type Recipe } from "../src/features/quick-orchestration/contracts";

const stages: CourseTemplate["stages"] = [
  { kind: "lesson", label: "读课件", location: "图书馆" },
  { kind: "practice", label: "做练习", location: "练习场" },
  { kind: "assessment", label: "做测验", location: "广场" },
];
const features = [
  { id: "public_chat", title: "小镇日常", description: "课间可以和角色闲聊。", default_enabled: true },
  { id: "library_shelf_tour", title: "参观图书馆书架", description: "首次阅读后学习查阅馆里的资料。", default_enabled: true },
];
const templates = [{ id: "learn-practice-quiz", title: "学课件、做练习、做测验", stages, features }];
const shorter = { id: "learn-practice", title: "学课件、做练习", stages: stages.slice(0, 2) };

const chapters = [
  { id: "basics", title: "基础知识", materials: [
    { id: "intro", title: "课堂导入", available: true },
    { id: "handout", title: "讲义", available: true },
    { id: "unavailable", title: "转换中的课件", available: false },
  ], knowledge_points: [{ id: "variable", title: "变量" }, { id: "string", title: "字符串" }] },
  { id: "iteration", title: "循环", materials: [{ id: "for", title: "循环课件", available: true }], knowledge_points: [{ id: "loop", title: "循环条件" }] },
];
const result = { token: "preview-1", blockers: [], welcome_dialogue: "欢迎来到本章课堂！", changes: { added: 4, updated: 0, removed: 0 }, reset_impact: null,
  quests: [{ id: "arrival", kind: "main", chapter_id: "iteration", title: "小镇研习", goals: ["拜访镇长", "拜访图书管理员"] },
    { id: "shelves", kind: "side", chapter_id: null, title: "认识书架", available_after: "循环课件", goals: ["打开学习资料"] }] };
const step = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(await screen.findByRole("tab", { name }));
const nextToQuestions = () => screen.getByRole("button", { name: "题量与题型" });
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
afterEach(() => vi.unstubAllGlobals());

it("defaults to available course content, reorders chapters, previews edits and restores the saved recipe", async () => {
  let saved: Recipe | null = null;
  const requests: { url: string; body: { expected_revision: number; recipe: Recipe; token?: string } }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return json({ revision: saved ? 8 : 7, templates, chapters, recipe: saved });
    const body = JSON.parse(String(init.body));
    requests.push({ url, body });
    if (url.endsWith("/preview")) return json(result);
    saved = body.recipe;
    return json({ revision: 8 });
  }));
  const user = userEvent.setup();
  const view = render(<QuickOrchestration courseId={2} />);
  expect(await screen.findByRole("tab", { name: "模板与功能", selected: true })).toBeVisible();
  expect(within(screen.getByRole("tablist")).getAllByRole("tab").map(tab => tab.getAttribute("aria-label")))
    .toEqual(["模板与功能", "授课章节", "题量与题型", "预览与生成"]);
  expect(screen.getByRole("list", { name: "每章教学流程" })).toHaveTextContent("广场");
  expect(screen.queryByRole("checkbox", { name: "基础知识" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "授课章节" }));
  expect(screen.queryByRole("list", { name: "每章教学流程" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: "基础知识" }));
  expect(screen.getByRole("checkbox", { name: "变量" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "课堂导入" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /转换中的课件/ })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: "讲义" }));
  await user.click(screen.getByRole("checkbox", { name: "字符串" }));
  await user.click(screen.getByRole("checkbox", { name: "循环" }));
  expect(screen.getByRole("button", { name: "上移循环" })).toBeDisabled();
  await user.click(screen.getByRole("combobox", { name: "起始章" }));
  await user.click(await screen.findByRole("option", { name: "循环" }));
  await step(user, "题量与题型");
  await user.clear(screen.getByRole("spinbutton", { name: "每章测验总题数" }));
  await user.type(screen.getByRole("spinbutton", { name: "每章测验总题数" }), "3");
  expect(screen.getByRole("spinbutton", { name: "每章测验总题数" })).toHaveValue(3);
  await step(user, "预览与生成");
  const review = within(await screen.findByRole("region", { name: "课程流程预览" }));
  expect(await review.findByText("欢迎来到本章课堂！")).toBeVisible();
  expect(review.getAllByRole("row")[1]).toHaveTextContent("1. 循环");
  await user.click(review.getByRole("button", { name: "1. 循环" }));
  expect(review.getByText("拜访图书管理员")).toBeVisible();
  const town = within(review.getByRole("region", { name: "全镇支线" }));
  expect(town.getByText("认识书架")).toBeVisible();
  expect(town.getByText("完成《循环课件》后出现")).toBeVisible();
  expect(review.getByRole("table")).not.toHaveTextContent("认识书架");
  expect(requests).toEqual([{ url: "/api/teacher/courses/2/quick-orchestration/preview", body: {
    expected_revision: 7, recipe: {
      template_id: "learn-practice-quiz", practice_count: 1, quiz_count: 3,
      start_chapter_id: "iteration", final_chapter_id: null, feature_ids: ["public_chat", "library_shelf_tour"],
      chapters: [
        { chapter_id: "iteration", material_ids: ["for"], knowledge_point_ids: ["loop"] },
        { chapter_id: "basics", material_ids: ["intro"], knowledge_point_ids: ["variable"] },
      ],
    },
  } }]);
  await user.click(screen.getByRole("button", { name: "确认生成课程流程" }));
  expect(await screen.findByText(/课程流程已生成/)).toBeVisible();
  expect(screen.getByRole("button", { name: "已生成课程流程" })).toBeDisabled();
  expect(review.getByText("欢迎来到本章课堂！")).toBeVisible();
  expect(requests[1]).toMatchObject({ body: { expected_revision: 7, token: "preview-1" } });
  view.unmount();
  render(<QuickOrchestration courseId={2} />);
  await step(user, "授课章节");
  expect(await screen.findByRole("checkbox", { name: "基础知识" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "调整基础知识的内容" }));
  expect(screen.getByRole("checkbox", { name: "字符串" })).not.toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "循环" }));
  await step(user, "预览与生成");
  expect(screen.getByRole("region", { name: "课程流程预览" })).not.toHaveTextContent("1. 循环");
  expect(requests[2].body.expected_revision).toBe(8);
  expect(requests[2].body.recipe).toMatchObject({ template_id: "learn-practice-quiz", quiz_count: 3 });
}, 15_000);

it("blocks an incomplete preview, preserves the draft after a conflict and clears old data on switching class", async () => {
  let previews = 0;
  let reads = 0;
  let pendingSignal: AbortSignal | null | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return json({ revision: ++reads, templates, chapters: url.includes("/3/") ? [] : chapters, recipe: null });
    if (url.endsWith("/preview")) {
      previews++;
      if (previews === 1) return json({ ...result, token: null, blockers: ["基础知识的题库还缺 1 道题"] });
      if (previews === 3) {
        pendingSignal = init.signal;
        return new Promise<Response>(() => {});
      }
      return json(result);
    }
    return json({ detail: "课程已变化，请重新预览" }, 409);
  }));
  const user = userEvent.setup();
  const view = render(<QuickOrchestration courseId={2} />);
  await step(user, "授课章节");
  await user.click(await screen.findByRole("checkbox", { name: "基础知识" }));
  await step(user, "预览与生成");
  expect(await screen.findByText("基础知识的题库还缺 1 道题")).toBeVisible();
  expect(screen.getByRole("group", { name: "课程总览" })).toHaveTextContent("预计合计");
  expect(screen.getByRole("button", { name: "确认生成课程流程" })).toBeDisabled();
  await step(user, "题量与题型");
  await step(user, "预览与生成");
  await user.click(await screen.findByRole("button", { name: "确认生成课程流程" }));
  expect(await screen.findByText("课程已变化，请重新预览")).toBeVisible();
  expect(screen.getByRole("button", { name: "重新载入课程" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "重新载入课程" }));
  expect(await screen.findByText("教学内容已刷新")).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "基础知识" })).toBeChecked();
  await step(user, "预览与生成");
  view.rerender(<QuickOrchestration courseId={3} />);
  expect(await screen.findByRole("tab", { name: "模板与功能", selected: true })).toBeVisible();
  await step(user, "授课章节");
  expect(await screen.findByText("这门课程还没有章节")).toBeVisible();
  expect(nextToQuestions()).toBeDisabled();
  expect(pendingSignal?.aborted).toBe(true);
  expect(screen.queryByText("基础知识")).not.toBeInTheDocument();
});

it("shows reduced inherited counts alongside a strict shortage, and can generate after restoring defaults", async () => {
  const saved: Recipe = { template_id: templates[0].id, practice_count: 10, quiz_count: 10,
    chapters: [{ chapter_id: "basics", material_ids: ["intro"], knowledge_point_ids: ["variable"],
      question_plan: { assessment: { mode: "total", count: 10 } } }] };
  const practice = { chapter_id: "basics", stage: "practice", requested: 10, effective: 6 };
  const shortage = "「基础知识」的测验需要 10 道题，所选知识点只有 6 道可用题。";
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return json({ revision: 1, templates, chapters, recipe: saved });
    const { recipe }: { recipe: Recipe } = JSON.parse(String(init.body));
    if (recipe.chapters[0].question_plan?.assessment) {
      return json({ ...result, token: null, adjustments: [practice], papers: [], blockers: [shortage] });
    }
    const paper = { count: 6, by_kind: { boolean: 6 } };
    return json({ ...result, adjustments: [practice, { ...practice, stage: "assessment" }],
      papers: [{ chapter_id: "basics", practice: { ...paper, individual: true }, assessment: paper }] });
  }));
  const user = userEvent.setup();
  render(<QuickOrchestration courseId={2} />);
  await step(user, "预览与生成");
  expect(await screen.findByRole("alert")).toHaveTextContent(shortage);
  const counts = () => within(screen.getByRole("row", { name: /1\. 基础知识/ })).getAllByRole("cell").slice(3);
  expect(counts()[0]).toHaveTextContent("6 题题库不足，已从默认 10 题下调");
  expect(counts()[1]).toHaveTextContent("预计 10 题");
  expect(screen.getByRole("group", { name: "课程总览" })).toHaveTextContent("预计合计");
  expect(screen.getByRole("button", { name: "确认生成课程流程" })).toBeDisabled();

  await step(user, "题量与题型");
  await step(user, "测验");
  await user.click(screen.getByRole("radio", { name: "沿用课程默认" }));
  expect(screen.getByRole("spinbutton", { name: "每章测验总题数" })).toHaveValue(10);
  await step(user, "预览与生成");
  expect(await screen.findByText("实际合计")).toBeVisible();
  expect(counts()[0]).toHaveTextContent("首批 6 题");
  expect(counts()[1]).toHaveTextContent("6 题题库不足，已从默认 10 题下调");
  const totals = screen.getByRole("group", { name: "课程总览" });
  expect(totals).toHaveTextContent("练习共 6 题（个人抽题按首批计算）");
  expect(totals).toHaveTextContent("测验共 6 题");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认生成课程流程" })).toBeEnabled();
});

it("guides a teacher from an empty chapter to valid selections without submitting an invalid preview", async () => {
  let refreshed = false;
  const fetch = vi.fn(async () => json({ revision: 1, templates, recipe: null, chapters: refreshed ? chapters : [
    { ...chapters[0], materials: [], knowledge_points: [] },
  ] }));
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(<QuickOrchestration courseId={2} />);
  await step(user, "授课章节");
  await user.click(await screen.findByRole("checkbox", { name: "基础知识" }));
  const generate = nextToQuestions();
  expect(screen.getByText("请调整《基础知识》")).toBeVisible();
  expect(screen.getByText(/本章有 0 份可用课件/)).toBeVisible();
  expect(screen.getByText(/本章有 0 个知识点/)).toBeVisible();
  expect(generate).toBeDisabled();
  expect(fetch).toHaveBeenCalledTimes(1);
  refreshed = true;
  await user.click(screen.getByRole("button", { name: "刷新内容" }));
  await user.click(await screen.findByRole("checkbox", { name: "课堂导入" }));
  expect(generate).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: "变量" }));
  expect(generate).toBeEnabled();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("blocks oversized and retired selections and enables generation as soon as the chapter is repaired", async () => {
  const materials = Array.from({ length: 65 }, (_, index) => ({ id: `m${index}`, title: `课件${index}`, available: true }));
  const points = Array.from({ length: 66 }, (_, index) => ({ id: `p${index}`, title: `知识点${index}` }));
  let refreshed = false;
  vi.stubGlobal("fetch", vi.fn(async () => json({ revision: 1, templates, recipe: null, chapters: [{
    ...chapters[0], materials: materials.map((row, i) => ({ ...row, available: !refreshed || i !== 1 })),
    knowledge_points: points.filter((_, i) => !refreshed || i !== 1),
  }] })));
  const user = userEvent.setup();
  render(<QuickOrchestration courseId={2} />);
  await step(user, "授课章节");
  await user.click(await screen.findByRole("checkbox", { name: "基础知识" }));
  const generate = nextToQuestions();
  expect(screen.getByText("已选 65 份课件，请保留最多 64 份。")).toBeVisible();
  expect(screen.getByText("已选 66 个知识点，请保留最多 65 个。")).toBeVisible();
  expect(generate).toBeDisabled();
  await user.click(screen.getByLabelText("课件0"));
  await user.click(screen.getByLabelText("知识点0"));
  expect(generate).toBeEnabled();
  refreshed = true;
  await user.click(screen.getByRole("button", { name: "刷新内容" }));
  expect(await screen.findByText(/已选知识点中有 1 个已移出本章/)).toBeVisible();
  expect(screen.getByText(/已选课件中有 1 份已移出本章或暂不可用/)).toBeVisible();
  expect(generate).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /课件1\s*暂不可用/ }));
  await user.click(screen.getByLabelText("已移出本章，取消勾选即可移除"));
  expect(generate).toBeEnabled();
});

it("limits chapter selection to 64 and flags a saved chapter that was removed", async () => {
  const catalog = Array.from({ length: 65 }, (_, index) => ({ ...chapters[1], id: `c${index}`, title: `教学单元${index}` }));
  const recipe = { template_id: "learn-practice", practice_count: 1, quiz_count: 0,
    chapters: catalog.slice(0, 64).map(row => ({ chapter_id: row.id, material_ids: ["for"], knowledge_point_ids: ["loop"] })),
  };
  let refreshed = false;
  vi.stubGlobal("fetch", vi.fn(async () => json({ revision: 2, templates: [...templates, shorter], chapters: refreshed ? catalog.slice(1) : catalog, recipe })));
  const user = userEvent.setup();
  render(<QuickOrchestration courseId={8} />);
  await step(user, "授课章节");
  expect(await screen.findByLabelText("教学单元64")).toBeDisabled();
  refreshed = true;
  await user.click(screen.getByRole("button", { name: "刷新内容" }));
  expect(await screen.findByText("第 1 个章节已移出本课程，请取消勾选该章。")).toBeVisible();
  expect(nextToQuestions()).toBeDisabled();
  await user.click(screen.getByLabelText("已移出的章节"));
  expect(screen.getByLabelText("教学单元64")).toBeEnabled();
  expect(nextToQuestions()).toBeEnabled();
});

it("previews a saved two-stage recipe and explicitly adds a quiz without losing the dialogue style", async () => {
  const recipe: Recipe = { template_id: shorter.id, dialogue_style: "teaching-sample", practice_count: 2, quiz_count: 0,
    chapters: [{ chapter_id: "basics", material_ids: ["intro"], knowledge_point_ids: ["variable"] }] };
  expect(sameRecipe(recipe, { ...recipe, dialogue_style: undefined })).toBe(false);
  let payload: Recipe | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return json({ revision: 2, templates: [...templates, shorter], chapters, recipe });
    payload = JSON.parse(String(init.body)).recipe;
    return json(result);
  }));
  const user = userEvent.setup();
  render(<QuickOrchestration courseId={8} />);
  const upgrade = await screen.findByRole("checkbox", { name: "为原有课程增加测验" });
  expect(upgrade).not.toBeChecked();
  expect(screen.getByRole("list", { name: "每章教学流程" })).not.toHaveTextContent("广场");
  await step(user, "题量与题型");
  expect(screen.queryByRole("spinbutton", { name: "每章测验总题数" })).not.toBeInTheDocument();
  await step(user, "预览与生成");
  expect(await screen.findByText(result.welcome_dialogue)).toBeVisible();
  expect(payload).toEqual(recipe);
  await step(user, "模板与功能");
  await user.click(screen.getByRole("checkbox", { name: "为原有课程增加测验" }));
  expect(screen.getByRole("list", { name: "每章教学流程" })).toHaveTextContent("广场");
  await step(user, "预览与生成");
  expect(await screen.findByRole("columnheader", { name: "测验总题数" })).toBeVisible();
  expect(payload).toEqual({ ...recipe, template_id: "learn-practice-quiz", quiz_count: 1,
    start_chapter_id: "basics", final_chapter_id: null, feature_ids: ["public_chat", "library_shelf_tour"] });
});

it("pins the chosen ending, inserts chapters in the middle, and saves optional town features", async () => {
  const third = { ...chapters[1], id: "third", title: "实践" };
  const fourth = { ...chapters[1], id: "fourth", title: "补充课" };
  const extension = { id: "future_tour", title: "参观小镇", description: "新增支线", default_enabled: false };
  const catalog = { chapters: [...chapters, third, fourth], templates: [{ ...templates[0], features: [...features, extension] }] };
  let saved: Recipe | null = null;
  let submitted: Recipe | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return json({ ...catalog, recipe: saved, revision: saved ? 2 : 1 });
    submitted = JSON.parse(String(init.body)).recipe as Recipe;
    if (url.endsWith("/preview")) return json({ ...result, closing_dialogue: submitted.final_chapter_id ? "有空再来小镇坐坐。" : null });
    saved = submitted;
    return json({ revision: 2 });
  }));
  const user = userEvent.setup();
  const view = render(<QuickOrchestration courseId={17} />);
  const pick = async (which: string, option: string) => {
    await user.click(screen.getByRole("combobox", { name: which }));
    await user.click(await screen.findByRole("option", { name: option }));
  };
  await step(user, "授课章节");
  expect(screen.getByRole("combobox", { name: "最终章" })).toHaveTextContent("暂不设置");
  for (const name of ["基础知识", "循环", "实践"]) await user.click(screen.getByRole("checkbox", { name }));
  await pick("起始章", "实践");
  await pick("最终章", "循环");
  await user.click(screen.getByRole("checkbox", { name: "补充课" }));
  await pick("授课位置", "第 2 位");
  expect(screen.getByRole("combobox", { name: "起始章" })).toHaveTextContent("实践");
  expect(screen.getByRole("combobox", { name: "最终章" })).toHaveTextContent("循环");
  expect(screen.getByRole("button", { name: "上移循环" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "下移实践" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "上移补充课" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "下移基础知识" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "上一步" }));
  for (const name of ["小镇日常", "参观图书馆书架", "参观小镇"]) await user.click(screen.getByRole("checkbox", { name }));
  await step(user, "预览与生成");
  const review = within(await screen.findByRole("region", { name: "课程流程预览" }));
  expect(await review.findByText("参观小镇")).toBeVisible();
  expect(await review.findByText(result.welcome_dialogue)).toBeVisible();
  expect(review.queryByText("最终章总结对白")).not.toBeInTheDocument();
  expect(review.queryByText("有空再来小镇坐坐。")).not.toBeInTheDocument();
  expect(submitted?.chapters.map(row => row.chapter_id)).toEqual(["third", "fourth", "basics", "iteration"]);
  expect(submitted).toMatchObject({ start_chapter_id: "third", final_chapter_id: "iteration", feature_ids: ["future_tour"] });
  await user.click(screen.getByRole("button", { name: "确认生成课程流程" }));
  await screen.findByText(/课程流程已生成/);
  view.unmount();
  render(<QuickOrchestration courseId={17} />);
  expect(await screen.findByRole("checkbox", { name: "参观小镇" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "小镇日常" })).not.toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "参观小镇" }));
  await step(user, "授课章节");
  await pick("最终章", "暂不设置");
  await user.click(screen.getByRole("checkbox", { name: "实践" }));
  await step(user, "预览与生成");
  expect(await screen.findByText("仅使用基础流程")).toBeVisible();
  expect(submitted).toMatchObject({ start_chapter_id: "fourth", final_chapter_id: null, feature_ids: [] });
  expect(screen.queryByText("最终章总结对白")).not.toBeInTheDocument();
}, 20_000);

it("opens older full courses with their original ending and allows one chapter to welcome and conclude", async () => {
  const old = { template_id: templates[0].id, chapters: [{ chapter_id: "basics", material_ids: ["intro"], knowledge_point_ids: ["variable"] }],
    practice_count: 1, quiz_count: 1 };
  const newerFeature = { id: "extra_tour", title: "认识新地点", description: "新课程的支线", default_enabled: true };
  const catalog = [{ ...templates[0], features: [...features, newerFeature] }];
  vi.stubGlobal("fetch", vi.fn(async () => json({ templates: catalog, chapters, recipe: old, revision: 2 })));
  const user = userEvent.setup();
  render(<QuickOrchestration courseId={18} />);
  expect(await screen.findByRole("checkbox", { name: "认识新地点" })).not.toBeChecked();
  await step(user, "授课章节");
  expect(await screen.findByRole("combobox", { name: "最终章" })).toHaveTextContent("基础知识");
  expect(screen.getByRole("combobox", { name: "起始章" })).toHaveTextContent("基础知识");
  expect(screen.getByText("当前流程已保存")).toBeVisible();
  await user.click(screen.getByRole("checkbox", { name: "循环" }));
  expect(screen.getByRole("combobox", { name: "起始章" })).toHaveTextContent("循环");
  expect(screen.getByRole("combobox", { name: "最终章" })).toHaveTextContent("基础知识");
  await user.click(screen.getByRole("checkbox", { name: "基础知识" }));
  expect(screen.getByRole("combobox", { name: "最终章" })).toHaveTextContent("暂不设置");
  expect(screen.getByRole("combobox", { name: "起始章" })).toHaveTextContent("循环");
});

it("narrows a twelve-chapter course by knowledge point and reviews the actual generated papers", async () => {
  const large = Array.from({ length: 12 }, (_, index) => ({
    id: "c" + index, title: "单元" + (index + 1), materials: chapters[1].materials,
    knowledge_points: Array.from({ length: 10 }, (_, n) => ({ id: "p" + n, title: (n === 9 ? "拓展" : "基础") + (index + 1) + "-" + n })),
  }));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? json({
    ...result, papers: large.map(chapter => ({ chapter_id: chapter.id,
      practice: chapter.id === "c0" ? { count: 3, by_kind: {}, individual: true }
        : { count: 3, by_kind: { boolean: 2, single_choice: 1 } }, assessment: { count: 1, by_kind: { boolean: 1 } },
    })),
  }) : json({ templates, chapters: large, recipe: null, revision: 1 })));
  const user = userEvent.setup();
  render(<QuickOrchestration courseId={11} />);
  await step(user, "授课章节");
  await user.click(screen.getByRole("button", { name: "选中全部章节" }));
  await user.type(screen.getByLabelText("搜索章节或知识点"), "拓展12-9");
  expect(screen.getByRole("checkbox", { name: "单元12" })).toBeChecked();
  expect(screen.queryByRole("checkbox", { name: "单元1" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "调整单元12的内容" }));
  await user.type(screen.getByLabelText("搜索本章知识点"), "拓展");
  await user.click(screen.getByRole("button", { name: "取消匹配项知识点" }));
  expect(screen.getByRole("checkbox", { name: "拓展12-9" })).not.toBeChecked();
  await step(user, "预览与生成");
  const review = within(screen.getByRole("region", { name: "课程流程预览" }));
  const totals = review.getByRole("group", { name: "课程总览" });
  expect(totals).toHaveTextContent("实际合计");
  expect(totals).toHaveTextContent("12 章");
  expect(totals).toHaveTextContent("119 个已选知识点");
  expect(totals).toHaveTextContent("练习共 36 题（个人抽题按首批计算）");
  expect(totals).toHaveTextContent("测验共 12 题");
  expect(review.getAllByRole("row")).toHaveLength(13);
  const last = within(review.getByRole("row", { name: /12\. 单元12/ }));
  expect(last.getByText("9 个")).toBeVisible();
  expect(await last.findByText("3 题")).toBeVisible();
  await user.click(last.getByRole("button"));
  expect(review.getByText(/实际题型：.*判断题 2 题/)).toBeVisible();
  expect(review.getByText(/基础12-0/)).toBeVisible();
  await step(user, "授课章节");
  expect(screen.getByLabelText("搜索章节或知识点")).toHaveValue("拓展12-9");
  expect(screen.getByRole("checkbox", { name: "拓展12-9" })).not.toBeChecked();
});
