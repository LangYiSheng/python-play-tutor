import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import EntryPage from "../src/features/EntryPage.vue";
import PasswordForm from "../src/features/PasswordForm.vue";
import { useSession } from "../src/shared/session";
import { api } from "../src/shared/api";

vi.mock("../src/app/arrival", async () => {
  const { ref } = await import("vue");
  return { preloadWorld: vi.fn().mockResolvedValue(undefined), startArrival: vi.fn(), endArrival: vi.fn(),
    backdropReady: ref(true), worldAssetsReady: ref(true), resourceError: ref("") };
});
const user = { id: 1, name: "同学", student_id: "00012", role: "student", must_change_password: true };
let wrapper: VueWrapper;
beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear(); });
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); });
async function entry(initial = true) {
  const session = useSession();
  if (initial) session.user = { ...user };
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", component: EntryPage }, { path: "/credits", component: { template: "<div/>" } },
    { path: "/world", component: { template: "<div/>" } },
  ] });
  await router.push("/");
  wrapper = mount(EntryPage, { global: { plugins: [router] } });
  return { session, router };
}

it("switches from login into password setup in the same entry card", async () => {
  const { router } = await entry(false);
  vi.spyOn(api, "post").mockResolvedValue({ access_token: "test-token", user });
  await wrapper.get('input[autocomplete="username"]').setValue("00012");
  await wrapper.get('input[type="password"]').setValue("00012");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(router.currentRoute.value.path).toBe("/");
  expect(wrapper.get("h2").text()).toBe("设置密码");
  expect(wrapper.findAll('input[type="password"]')).toHaveLength(2);
  expect(wrapper.find('input[autocomplete="current-password"]').exists()).toBe(false);
});

it("validates confirmation, retains failed input, then rotates session and continues", async () => {
  const { session, router } = await entry();
  const post = vi.spyOn(api, "post").mockRejectedValueOnce(new Error("暂时无法保存"));
  vi.spyOn(session, "load").mockResolvedValue(undefined);
  const inputs = wrapper.findAll("input");
  await inputs[0].setValue("private-password");
  await inputs[1].setValue("mismatch-password");
  await wrapper.get("form").trigger("submit");
  expect(post).not.toHaveBeenCalled();
  expect(wrapper.get('[role="alert"]').text()).toContain("不一致");
  await inputs[1].setValue("private-password");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toBe("暂时无法保存");
  expect((inputs[0].element as HTMLInputElement).value).toBe("private-password");
  post.mockResolvedValueOnce({ access_token: "rotated-token", user: { ...user, must_change_password: false } });
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(post).toHaveBeenLastCalledWith("/auth/password", { new_password: "private-password" });
  expect(api.token()).toBe("rotated-token");
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/world"));
});

it("restores the setup step for a logged-in initial account and logs out via text link", async () => {
  const { session } = await entry();
  api.setToken("initial-token");
  vi.spyOn(api, "post").mockResolvedValue({ ok: true });
  expect(wrapper.get("h2").text()).toBe("设置密码");
  await wrapper.get(".text-button").trigger("click");
  await flushPromises();
  expect(session.user).toBeNull();
  expect(api.token()).toBeNull();
  expect(wrapper.get("h2").text()).toBe("登录");
});

it("keeps current password verification in ordinary account settings", async () => {
  wrapper = mount(PasswordForm);
  const post = vi.spyOn(api, "post").mockRejectedValue(new Error("当前密码不正确"));
  const inputs = wrapper.findAll("input");
  expect(inputs).toHaveLength(3);
  for (const [index, value] of ["old-password", "new-password", "new-password"].entries()) await inputs[index].setValue(value);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(post).toHaveBeenCalledWith("/auth/password", { current_password: "old-password", new_password: "new-password" });
  expect(wrapper.get('[role="alert"]').text()).toBe("当前密码不正确");
});
