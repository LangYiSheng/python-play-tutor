import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, nextTick, ref } from "vue";
import { focusableControls, useModalFocus } from "../src/shared/modalFocus";
import { useSession } from "../src/shared/session";

const mounted: VueWrapper[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(async () => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  await nextTick();
  document.body.replaceChildren();
  sessionStorage.clear();
});

async function settleFocus() {
  await nextTick();
  await nextTick();
}

function key(key: string, shiftKey = false, repeat = false) {
  const event = new KeyboardEvent("keydown", {
    key,
    shiftKey,
    repeat,
    bubbles: true,
    cancelable: true,
  });
  document.activeElement?.dispatchEvent(event);
  return event;
}

function modalHarness() {
  const invoker = document.createElement("button");
  invoker.textContent = "打开工作区";
  invoker.dataset.worldFocus = "";
  document.body.append(invoker);
  invoker.focus();
  const view = ref<string | null>(null);
  const wrapper = mount(
    defineComponent({
      setup() {
        const panel = ref<HTMLElement>();
        useModalFocus(
          panel,
          () => view.value,
          () => {
            view.value = null;
          },
        );
        return () =>
          view.value
            ? h(
                "section",
                {
                  ref: panel,
                  role: "dialog",
                  "aria-modal": "true",
                  tabindex: -1,
                },
                [
                  h(
                    "button",
                    { key: `${view.value}-first`, "data-control": "first" },
                    `${view.value}：主要操作`,
                  ),
                  h("details", [
                    h("summary", { "data-control": "summary" }, "操作指南"),
                    h("button", "折叠指南中的按钮"),
                  ]),
                  h(
                    "button",
                    { key: `${view.value}-last`, "data-control": "last" },
                    `${view.value}：返回`,
                  ),
                  h("div", { hidden: true }, [h("button", "hidden 祖先")]),
                  h("div", { inert: "" }, [h("button", "inert 祖先")]),
                  h("div", { "aria-hidden": "true" }, [h("input")]),
                  h("div", { style: { display: "none" } }, [
                    h("button", "折叠区域"),
                  ]),
                  h("div", { style: { visibility: "hidden" } }, [
                    h("button", "不可见区域"),
                  ]),
                  h("fieldset", { disabled: true }, [h("button", "禁用分组")]),
                  h("button", { disabled: true }, "禁用按钮"),
                  h("input", { disabled: true }),
                  h("input", { type: "hidden" }),
                  h("button", { tabindex: -1 }, "不参与 Tab"),
                ],
              )
            : null;
      },
    }),
    { attachTo: document.body },
  );
  mounted.push(wrapper);
  return { invoker, view, wrapper };
}

describe("the current modal owns keyboard focus", () => {
  it("focuses each new view and restores its invoker after Escape", async () => {
    const { invoker, view, wrapper } = modalHarness();
    view.value = "设置";
    await settleFocus();
    expect(document.activeElement).toBe(
      wrapper.get('[data-control="first"]').element,
    );

    view.value = "图书馆";
    await settleFocus();
    expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement?.textContent).toBe("图书馆：主要操作");

    expect(key("Escape").defaultPrevented).toBe(true);
    await settleFocus();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(document.activeElement).toBe(invoker);
  });

  it("keeps Shift+Tab from the panel inside and skips unavailable controls", async () => {
    const { invoker, view, wrapper } = modalHarness();
    view.value = "设置";
    await settleFocus();
    const panel = wrapper.get<HTMLElement>('[role="dialog"]').element;
    const first = wrapper.get<HTMLButtonElement>(
      '[data-control="first"]',
    ).element;
    const last = wrapper.get<HTMLButtonElement>(
      '[data-control="last"]',
    ).element;

    panel.focus();
    expect(key("Tab", true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(key("Tab", true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    invoker.focus();
    expect(document.activeElement).toBe(first);
  });

  it("returns to the world menu when the original invoker was removed", async () => {
    const { invoker, view } = modalHarness();
    view.value = "资料阅读";
    await settleFocus();
    invoker.remove();
    const worldMenu = document.createElement("button");
    worldMenu.dataset.worldFocus = "";
    worldMenu.textContent = "任务日志";
    document.body.append(worldMenu);

    key("Escape");
    await settleFocus();
    expect(document.activeElement).toBe(worldMenu);
  });

  it("allows native summary navigation and excludes closed details descendants", async () => {
    const { view, wrapper } = modalHarness();
    view.value = "设置";
    await settleFocus();
    const panel = wrapper.get<HTMLElement>('[role="dialog"]').element;
    const summary = wrapper.get<HTMLElement>(
      '[data-control="summary"]',
    ).element;
    const first = wrapper.get<HTMLElement>('[data-control="first"]').element;
    const last = wrapper.get<HTMLElement>('[data-control="last"]').element;
    expect(focusableControls(panel)).toEqual([first, summary, last]);
    summary.focus();
    expect(document.activeElement).toBe(summary);
    // Native Shift+Tab must move toward the first button, rather than being
    // mistaken for focus outside the modal and wrapped back to logout.
    expect(key("Tab", true).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it("ignores repeated Escape events so holding the key cannot skip views", async () => {
    const { view } = modalHarness();
    view.value = "图书馆";
    await settleFocus();
    key("Escape", false, true);
    await settleFocus();
    expect(view.value).toBe("图书馆");
    key("Escape");
    await settleFocus();
    expect(view.value).toBeNull();
  });
});

describe("workspace return navigation", () => {
  it("replaces the visible view while allowing a return through its origins", () => {
    const session = useSession();
    session.open({ kind: "settings" });
    session.navigate({ kind: "library" });
    session.navigate({
      kind: "material",
      material_id: 43,

      page_no: 3,
    });
    expect(session.workspace).toEqual({
      kind: "material",
      material_id: 43,

      page_no: 3,
    });
    expect(session.previousWorkspace).toEqual({ kind: "library" });
    session.back();
    expect(session.workspace).toEqual({ kind: "library" });
    session.back();
    expect(session.workspace).toEqual({ kind: "settings" });
    expect(session.canGoBack).toBe(false);
  });

  it("cannot resurrect an old view after a top-level open or logout", () => {
    const session = useSession();
    session.open({ kind: "settings" });
    session.navigate({ kind: "library" });
    session.open({ kind: "journal" });
    expect(session.canGoBack).toBe(false);
    expect(session.previousWorkspace).toBeUndefined();
    session.back();
    expect(session.workspace).toBeNull();

    session.open({ kind: "settings" });
    session.navigate({ kind: "library" });
    session.open(null);
    session.back();
    expect(session.workspace).toBeNull();

    session.open({ kind: "settings" });
    session.navigate({ kind: "library" });
    session.reset();
    expect(session.canGoBack).toBe(false);
    expect(session.previousWorkspace).toBeUndefined();
    session.back();
    expect(session.workspace).toBeNull();
  });
});
