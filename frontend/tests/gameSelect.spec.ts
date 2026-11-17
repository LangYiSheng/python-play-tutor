import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import GameSelect from "../src/shared/GameSelect.vue";
import { useModalFocus } from "../src/shared/modalFocus";

let wrapper: VueWrapper;
const options = [{ value: 1, label: "标准" }, { value: 1.5, label: "不可选", disabled: true }, { value: 2, label: "放大" }];
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(20, 20, 140, 34)] as unknown as DOMRectList);
});
afterEach(() => { wrapper?.unmount(); document.body.replaceChildren(); vi.restoreAllMocks(); });
function select(props = {}) {
  wrapper = mount(GameSelect, { attachTo: document.body, props: { modelValue: 1, options, "aria-label": "文字大小", ...props } });
  return wrapper.get('[role="combobox"]');
}

it("opens and selects by click while preserving numeric values", async () => {
  const trigger = select();
  await trigger.trigger("click");
  await flushPromises();
  expect(trigger.attributes("aria-expanded")).toBe("true");
  expect(wrapper.get('[role="listbox"]').attributes("aria-label")).toBe("文字大小");
  expect(wrapper.get('[aria-selected="true"]').text()).toBe("标准");
  expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  await wrapper.findAll('[role="option"]')[2].trigger("click");
  expect(wrapper.emitted("update:modelValue")).toEqual([[2]]);
  expect(trigger.attributes("aria-expanded")).toBe("false");
});

it("does not navigate options with keys and closes on Escape, blur or outside click", async () => {
  const trigger = select();
  const keys = ["ArrowDown", "ArrowUp", "Home", "End", "w", "a", "s", "d", "放"];
  for (const key of keys) await trigger.trigger("keydown", { key });
  expect(trigger.attributes("aria-expanded")).toBe("false");
  await trigger.trigger("click");
  for (const key of keys) await trigger.trigger("keydown", { key });
  expect(wrapper.get('[aria-selected="true"]').text()).toBe("标准");
  expect(trigger.attributes("aria-activedescendant")).toBeUndefined();
  await trigger.trigger("keydown", { key: "Escape" });
  expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  await trigger.trigger("click");
  await trigger.trigger("blur");
  expect(trigger.attributes("aria-expanded")).toBe("false");
  await trigger.trigger("click");
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  await flushPromises();
  expect(trigger.attributes("aria-expanded")).toBe("false");
});

it("keeps disabled controls and options inert and handles empty options", async () => {
  const trigger = select();
  await trigger.trigger("click");
  await wrapper.get('[aria-disabled="true"]').trigger("click");
  expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  await wrapper.setProps({ disabled: true });
  expect(trigger.attributes("aria-expanded")).toBe("false");
  expect(trigger.attributes("disabled")).toBeDefined();
  await wrapper.setProps({ disabled: false, options: [] });
  await trigger.trigger("click");
  expect(wrapper.text()).toContain("暂无选项");
});

it("keeps focus inside the modal and lets Escape close only the topmost layer", async () => {
  const close = vi.fn();
  const Host = defineComponent({
    components: { GameSelect },
    setup() {
      const panel = ref<HTMLElement>();
      useModalFocus(panel, () => true, close);
      return { panel, options };
    },
    template: '<div class="game-workspace" role="dialog" aria-modal="true"><section ref="panel"><GameSelect :model-value="1" :options="options" aria-label="文字大小" /></section></div>',
  });
  wrapper = mount(Host, { attachTo: document.body });
  const trigger = wrapper.get('[role="combobox"]');
  await trigger.trigger("click");
  await flushPromises();
  expect(document.activeElement).toBe(trigger.element);
  await trigger.trigger("keydown", { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  await trigger.trigger("keydown", { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});
