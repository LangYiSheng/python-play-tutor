import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PracticeWorkspace from "../src/features/practice/PracticeWorkspace.vue";
import { useSession } from "../src/shared/session";
import { api } from "../src/shared/api";
import type { Submission } from "../src/shared/types";
import PracticeQuestionCard from "../src/features/practice/PracticeQuestionCard.vue";
import * as pythonRunner from '../src/features/practice/pythonRunner';
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
describe("public judge sample feedback", () => {
  it("does not leave empty or duplicate detail paragraphs below a one-line result", async () => {
    const question = { id: "q1", title: "结果", kind: "boolean" as const, prompt: "请选择", options: [], samples: [] };
    const result: Submission = { id: "submission", activity_id: "practice", question_id: "q1", mode: "submit", status: "accepted", feedback: { detail: " 回答正确  " }, created_at: "2026-11-08T00:00:00Z" };
    const wrapper = mount(PracticeQuestionCard, { props: { question, index: 0, answer: "true", code: "", result } });
    expect(wrapper.get(".submission-result-heading").find("svg").exists()).toBe(true);
    expect(wrapper.get(".submission-result-heading").text()).toBe("回答正确");
    expect(wrapper.find(".submission-result > p").exists()).toBe(false);
    await wrapper.setProps({ result: { ...result, feedback: { detail: "  " } } });
    expect(wrapper.find(".submission-result > p").exists()).toBe(false);
    wrapper.unmount();
  });
  it("renders reference answer and explanation cleanly below submission feedback", async () => {
    const question = { id: "q2", title: "切片", kind: "single_choice" as const, prompt: "结果是？", options: ["1", "2"], samples: [] };
    const result: Submission = {
      id: "sub-exp",
      activity_id: "ch1-assessment",
      question_id: "q2",
      mode: "submit",
      status: "wrong_answer",
      feedback: {
        detail: "请结合课件重新思考",
        correct_answer: "2",
        explanation: "切片左闭右开，a[1:3] 包含索引 1 和 2 共两个元素。",
      },
      created_at: "2026-11-27T00:00:00Z",
    };
    const wrapper = mount(PracticeQuestionCard, { props: { question, index: 0, answer: "1", code: "", result } });
    const section = wrapper.get(".submission-explanation");
    expect(section.text()).toContain("参考答案：2");
    expect(section.text()).toContain("答案解析");
    expect(section.text()).toContain("切片左闭右开");
    wrapper.unmount();
  });
  it("deduplicates prompt when it matches title or repeats the title as its first line", () => {
    const singleLine = mount(PracticeQuestionCard, {
      props: {
        question: {
          id: "q-dup-1",
          title: "已知整数 x = 2025，表达式 x // 100 % 10 的值为 0。",
          kind: "boolean",
          prompt: "已知整数 x = 2025，表达式 x // 100 % 10 的值为 0。",
          options: [],
          samples: [],
        },
        index: 6,
        answer: null,
        code: "",
      },
    });
    expect(singleLine.find(".question-prompt").exists()).toBe(false);
    expect(singleLine.get("h3").text()).toContain("7. 已知整数 x = 2025");
    singleLine.unmount();

    const multiLine = mount(PracticeQuestionCard, {
      props: {
        question: {
          id: "q-dup-2",
          title: "执行以下代码后，输出结果是 'ytho'。",
          kind: "boolean",
          prompt: "执行以下代码后，输出结果是 'ytho'。\n\ns = \"= python= \"\nprint(s.strip(\" =np\"))",
          options: [],
          samples: [],
        },
        index: 0,
        answer: null,
        code: "",
      },
    });
    expect(multiLine.get(".question-prompt").text()).toBe('s = "= python= "\nprint(s.strip(" =np"))');
    multiLine.unmount();
  });
  it("shows safe public diagnostics in formal summaries without case output or private fields", async () => {
    vi.spyOn(pythonRunner,'createPythonRunner').mockReturnValue({run:vi.fn(),ready:async()=>[],dispose:vi.fn()});
    const pinia = createPinia();
    setActivePinia(pinia);
    const session = useSession();
    session.user = {
      id: 1,
      student_id: "124639931179929",
      name: "Fixture",
      role: "student",
    };
    session.classroomId = 1;
    session.world = {
      player: {
        map_key: "town_hub",
        tile_x: 22,
        tile_y: 36,
        direction: "down",
      },
      npcs: [],
      quests: [],
      chapters: [],
      flags: [],
    };
    vi.spyOn(session, "activity").mockResolvedValue({id: "code-test",
chapter_id: 179,
title: "公开反馈测试",
kind: "practice",
npc_key: "mayor_py",
assistant_allowed: false,
questions: [
        {
          id: "q1",
          title: "测试题",
          kind: "python",
          prompt: "只验证公开样例反馈",
          options: [],
          samples: [{ input: "", output: "hello" }],

        },
      ],
resources: []});
    const result: Submission & {
      feedback: Submission["feedback"] & { hidden_cases: string[] };
    } = {
      id: "fixture-submission",
      activity_id: "code-test",
      question_id: "q1",

      mode: "submit",
      status: "runtime_error",
      created_at: "2026-11-03T00:00:00Z",
      feedback: {
        detail: "公开样例运行结束",
        status: "runtime_error",
        samples: [
          {
            status: "runtime_error",
            stdout: "<img src=x onerror=alert(1)>",
            stderr: "NameError: name wasd is not defined",
            compile_output: "Syntax diagnostics",
          },
        ],
        hidden_cases: ["PRIVATE_CASE_OUTPUT_DO_NOT_RENDER"],
      },
    };
    vi.spyOn(api, "post").mockResolvedValue(result);
    const wrapper = mount(PracticeWorkspace, {
      props: { activityId: "code-test" },
      global: {
        plugins: [pinia],
        stubs: {
          CodeEditor: {
            props: ["modelValue"],
            template:
              '<textarea aria-label="测试代码" :value="modelValue" @input="$emit(\'update:modelValue\',$event.target.value)" />',
          },
          AssistantPanel: true,
        },
      },
    });
    await flushPromises();
    await wrapper.find("textarea").setValue("wasd");
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "提交代码")!
      .trigger("click");
    await flushPromises();
    const feedback = wrapper.find(".coding-tests");
    expect(feedback.text()).toContain("执行出错");
    expect(feedback.text()).not.toContain("<img src=x onerror=alert(1)>");
    expect(feedback.find('.case-tabs').exists()).toBe(false);
    expect(feedback.find("img").exists()).toBe(false);
    expect(feedback.text()).toContain("NameError: name wasd is not defined");
    expect(feedback.text()).toContain("Syntax diagnostics");
    expect(feedback.text()).not.toContain("PRIVATE_CASE_OUTPUT_DO_NOT_RENDER");
    wrapper.unmount();
  });
});
