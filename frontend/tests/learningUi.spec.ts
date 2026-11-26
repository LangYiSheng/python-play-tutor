import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import LessonWorkspace from "../src/features/learning/LessonWorkspace.vue";
import PracticeWorkspace from "../src/features/practice/PracticeWorkspace.vue";
import { api } from "../src/shared/api";
import { useSession } from "../src/shared/session";
function setup(compact = false) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSession();
  session.user = {
    id: 1,
    name: "fixture",
    student_id: "124639931179929",
    role: "student" };
  session.classroomId = 2;
  session.world = {
    player: { map_key: "town_hub", tile_x: 22, tile_y: 36, direction: "down" },
    npcs: [],
    quests: [],
    chapters: [],
    flags: [] };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: compact,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn() })),
  );
  return { pinia, session };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
});
describe("learning workspace usability", () => {
  it("refreshes server-verified learning goals after a normal practice submission", async () => {
    const { pinia, session } = setup();
    vi.spyOn(session, "activity").mockResolvedValue({id: "practice",
chapter_id: 179,
title: "练习",
kind: "practice",
npc_key: "arena_guard",
assistant_allowed: false,
progress: { page_no: null, visited_pages: [], accepted_question_ids: [], completed: false },
questions: [{ id: "q1", title: "判断题", kind: "boolean", prompt: "请选择", options: [], samples: [] }],
resources: []});
    vi.spyOn(api, "post").mockResolvedValue({ id: "s1", question_id: "q1", mode: "submit", status: "accepted", feedback: {} });
    const get = vi.spyOn(api, "get").mockResolvedValue({ page_no: null, visited_pages: [], accepted_question_ids: ["q1"], completed: true });
    vi.spyOn(session, "refresh").mockResolvedValue();
    const wrapper = mount(PracticeWorkspace, { props: { activityId: "practice" }, global: { plugins: [pinia], stubs: { AssistantPanel: true } } });
    await flushPromises();
    const progress = wrapper.get('progress[aria-label="活动总进度"]');
    expect(progress.attributes("value")).toBe("0");
    expect(progress.attributes("max")).toBe("1");
    await wrapper.get('input[value="true"]').setValue();
    await wrapper.findAll("button").find(button => button.text() === "提交答案")!.trigger("click");
    await flushPromises();
    expect(get).toHaveBeenCalledWith("/activities/practice/progress?classroom_id=2");
    expect(progress.attributes("value")).toBe("1");
    wrapper.unmount();
  });

  it("preserves a library text position on PDF replacement without writing activity progress", async () => {
    const { pinia } = setup();
    sessionStorage.setItem("read:1:2:material-186", "1");
    vi.spyOn(api, "get").mockResolvedValue({ id: 186, title: "课件", kind: "pdf", status: "ready", pages: [
      { id: 10715, page_no: 34, title: "计算", text: "计算" }, { id: 10723, page_no: 42, title: "抽象", text: "抽象" },
    ] });
    const post = vi.spyOn(api, "post");
    const wrapper = mount(LessonWorkspace, { props: { activityId: "", materialId: 186 }, global: { plugins: [pinia], stubs: {
      AssistantPanel: true, PdfReader: { props: ["page"], template: '<div class="pdf-fixture">{{ page }}</div>' },
    } } });
    await flushPromises();
    expect(wrapper.get(".pdf-fixture").text()).toBe("42");
    expect(wrapper.find(".lesson-footer").exists()).toBe(false);
    expect(wrapper.findComponent({ name: "AssistantPanel" }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "AssistantPanel" }).props("materialId")).toBe(186);
    expect(post).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("restores a library reader's previous local position after moving to the current material key", async () => {
    const { pinia } = setup();
    sessionStorage.setItem("read:1:2:material-186-2", "1");
    vi.spyOn(api, "get").mockResolvedValue({
      id: 186, title: "资料库课件", kind: "text", status: "ready", pages: [
        { id: 1, page_no: 1, title: "第一页", text: "开始阅读" },
        { id: 2, page_no: 2, title: "第二页", text: "上次读到这里" },
      ],
    });
    const wrapper = mount(LessonWorkspace, { props: { activityId: "", materialId: 186 }, global: { plugins: [pinia], stubs: { AssistantPanel: true } } });
    await flushPromises();
    expect(wrapper.get(".lesson-text").text()).toContain("上次读到这里");
    expect(sessionStorage.getItem("read:1:2:material-186")).toBe("1");
    expect(sessionStorage.getItem("read:1:2:material-186-2")).toBeNull();
    wrapper.unmount();
  });

  it("makes inactive compact regions hidden and inert while preserving reading position across the assistant view", async () => {
    const { pinia } = setup(true);
    vi.spyOn(api, "get").mockResolvedValue({
        id: 186,
        title: "课件",
        kind: "text",
        status: "ready",
        pages: [
          { id: 1, page_no: 41, title: "第一页", text: "原课件文本" },
          { id: 2, page_no: 42, title: "第二页", text: "第二页文本" },
        ] });
    const wrapper = mount(LessonWorkspace, {
      attachTo: document.body,
      props: { materialId:186 },
      global: {
        plugins: [pinia],
        stubs: {
          AssistantPanel: {
            template:
              '<section class="assistant-panel"><textarea aria-label="测试助教问题" /></section>' } } } });
    await flushPromises();
    expect(wrapper.find(".learning-support").attributes("hidden")).toBeDefined();
    expect(wrapper.find(".learning-support").attributes("inert")).toBeDefined();
    await wrapper
      .findAll("button")
      .find((b) => b.text().trim() === "下一页")!
      .trigger("click");
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "目标与助教")!
      .trigger("click");
    expect(wrapper.find(".lesson-content").attributes("hidden")).toBeDefined();
    expect(wrapper.find(".lesson-content").attributes("inert")).toBeDefined();
    expect(document.activeElement?.id).toBe("lesson-assistant-region");
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "课程内容")!
      .trigger("click");
    expect(
      wrapper.find(".lesson-content").attributes("hidden"),
    ).toBeUndefined();
    expect(wrapper.find(".lesson-text").text()).toContain("第二页文本");
    expect(document.activeElement?.id).toBe("lesson-reading-region");
    wrapper.unmount();
  });
  it("requires a deliberate boolean choice and sends false only after the student selects it", async () => {
    const { pinia, session } = setup();
    vi.spyOn(session, "activity").mockResolvedValue({id: "practice",
chapter_id: 179,
title: "判断题夹具",
kind: "practice",
npc_key: "mayor_py",
assistant_allowed: false,
questions: [
        {
          id: "boolean-q",
          title: "判断一个命题",
          kind: "boolean",
          prompt: "请选择你的判断。",
          options: [],
          samples: [] },
      ],
resources: []});
    const post = vi
      .spyOn(api, "post")
      .mockResolvedValue({
        id: "s1",
        activity_id: "practice",
        question_id: "boolean-q",
        mode: "submit",
        status: "wrong_answer",
        feedback: { detail: "请重新思考" },
        created_at: "2026-11-03T00:00:00Z" });
    const wrapper = mount(PracticeWorkspace, {
      props: { activityId: "practice" },
      global: { plugins: [pinia], stubs: { AssistantPanel: true } } });
    await flushPromises();
    const submit = wrapper
      .findAll("button")
      .find((b) => b.text() === "提交答案")!;
    expect(submit.attributes("disabled")).toBeDefined();
    await submit.trigger("click");
    expect(post).not.toHaveBeenCalled();
    await wrapper.find('input[value="false"]').setValue();
    expect(submit.attributes("disabled")).toBeUndefined();
    await submit.trigger("click");
    await flushPromises();
    expect(post).toHaveBeenCalledWith(
      "/submissions",
      expect.objectContaining({ answer: false, question_id: "boolean-q" }),
    );
    wrapper.unmount();
  });
});
