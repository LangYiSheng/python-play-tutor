import { expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { routerKey } from "vue-router";
import WorldPage from "../src/features/WorldPage.vue";
import { useSession } from "../src/shared/session";

it("guides a shelf visitor to the librarian and opens the library only through their dialogue", async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSession();
  session.classroomId = 1;
  session.world = {default_role: null, npcs: [], chapters: [], flags: [],
    player: {map_key: "library", tile_x: 9, tile_y: 5, direction: "down"}};
  session.taskChapters = [{id: 1, title: "第一章", completed: false, order_index: 1, tasks: [
    {id: "book", kind: "reading", material_id: 1, required: true, completed: false, locked: false,
      title: "讲义", lock_reason: null, current: 0, total: 1, unit: "页"},
  ]}];
  vi.spyOn(session, "refreshTasks").mockResolvedValue();
  const guide = vi.fn();
  const canvas = defineComponent({name: "WorldCanvas", emits: ["interact"], template: "<div />", methods: {guide}});
  const wrapper = shallowMount(WorldPage, {global: {
    plugins: [pinia], provide: {[routerKey as symbol]: {}}, stubs: {WorldCanvas: canvas},
  }});
  try {
    await flushPromises();
    const scene = wrapper.getComponent(canvas);
    scene.vm.$emit("interact", "library_shelf", "object");
    await flushPromises();
    expect(guide).toHaveBeenCalledWith("librarian");
    expect(session.workspace).toBeNull();
    expect(wrapper.findComponent({name: "DialogueLayer"}).exists()).toBe(false);

    scene.vm.$emit("interact", "librarian", "npc");
    await flushPromises();
    const dialogue = wrapper.getComponent({name: "DialogueLayer"});
    expect(dialogue.props("line").choices[0].label).toBe("查看学习资料");
    dialogue.vm.$emit("advance", "open");
    await flushPromises();
    expect(session.workspace?.kind).toBe("library");
    wrapper.getComponent({name: "OverlayHost"}).vm.$emit("close");
    await flushPromises();
    expect(session.workspace).toBeNull();
    expect(wrapper.getComponent({name: "DialogueLayer"}).props("line").text).toContain("从刚才的进度接着学");
  } finally {
    wrapper.unmount();
  }
});
