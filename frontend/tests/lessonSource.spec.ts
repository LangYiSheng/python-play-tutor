import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { api } from "../src/shared/api";
import type { Material } from "../src/shared/types";
import { useLessonSource } from "../src/features/learning/useLessonSource";

const material = (id: number, kind = "text"): Material => ({
  id,
  kind,
  title: `资料 ${id}`,
  status: "ready",
  pages: [{ id: id * 10, page_no: 1, title: "第一页", text: "正文" }],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const wrappers: VueWrapper[] = [];
function setup() {
  const owner = {
    active: true,
    materialId: 1,
  };
  let source!: ReturnType<typeof useLessonSource>;
  const ready = vi.fn();
  const wrapper = mount(
    defineComponent({
      setup() {
        source = useLessonSource({
          userId: 1,
          classroomId: 2,
          currentOwner: () => owner.active,
          materialId: () => owner.materialId,
          initialPage: () => undefined,
          beforeLoad: vi.fn(),
          ready,
        });
        return () => null;
      },
    }),
  );
  wrappers.push(wrapper);
  return { source, owner, ready, wrapper };
}

beforeEach(() => {
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:current"),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("lesson source request ownership", () => {

  it("does not create a media URL after the reader has closed", async () => {
    const download = deferred<Blob>();
    vi.spyOn(api, "get").mockResolvedValue(material(1, "video"));
    const blob = vi.spyOn(api, "blob").mockReturnValue(download.promise);
    const { source, wrapper, ready } = setup();
    const pending = source.load();
    await flushPromises();
    const signal = blob.mock.calls[0]![1]!;
    wrapper.unmount();
    download.resolve(new Blob(["video"]));
    await pending;
    expect(signal.aborted).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });

  it("releases the current video URL when another source replaces it", async () => {
    vi.spyOn(api, "get")
      .mockResolvedValueOnce(material(1, "video"))
      .mockResolvedValueOnce(material(2));
    vi.spyOn(api, "blob").mockResolvedValue(new Blob(["video"]));
    const { source, owner } = setup();
    await source.load();
    expect(source.mediaBlob.value).toBe("blob:current");
    owner.materialId = 2;
    await source.load();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:current");
    expect(source.mediaBlob.value).toBe("");
    expect(source.material.value?.id).toBe(2);
  });

  it("ignores a previous account's failed source request", async () => {
    const download = deferred<Material>();
    vi.spyOn(api, "get").mockReturnValue(download.promise);
    const { source, owner, ready } = setup();
    const pending = source.load();
    owner.active = false;
    download.reject(new Error("已退出的账号"));
    await pending;
    expect(source.error.value).toBe("");
    expect(ready).not.toHaveBeenCalled();
  });

  it("keeps the last citation selected when requests complete in reverse order", async () => {
    const first = deferred<Material>();
    vi.spyOn(api, "get").mockImplementation(
      async (path) =>
        (path.startsWith("/materials/2?")
          ? first.promise
          : material(3)) as never,
    );
    const { source } = setup();
    const pending = source.showCitation(2, 1);
    expect(await source.showCitation(3, 1)).toBe(true);
    first.resolve(material(2));
    expect(await pending).toBe(false);
    expect(source.material.value?.id).toBe(3);
  });
});
