import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaCache, MEDIA_CACHE_TTL } from "../src/shared/mediaCache";

let created = 0;
beforeEach(() => {
  created = 0;
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => `blob:${++created}`),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());

function blob(text: string) {
  return new Blob([text]);
}

describe("media cache", () => {
  it("reuses a loaded URL and revokes it after the last pin is released and it expires", async () => {
    const cache = new MediaCache({ maxBytes: 100, limits: { audio: 100 } });
    const loader = vi.fn(async () => blob("audio"));
    const first = await cache.load("audio:1", "audio", loader, { pin: true });
    const second = await cache.load("audio:1", "audio", loader, { pin: true });
    expect(second).toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);
    cache.unpin("audio:1");
    cache.unpin("audio:1");
    cache.prune(Date.now() + MEDIA_CACHE_TTL + 1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used unpinned entry when a kind budget is exceeded", async () => {
    const cache = new MediaCache({ maxBytes: 100, limits: { audio: 10 } });
    const first = await cache.load("a", "audio", async () => blob("123456"));
    const second = await cache.load("b", "audio", async () => blob("123456"));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.size).toBe(6);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(second);
  });

  it("keeps pinned entries over budget until they are released", async () => {
    const cache = new MediaCache({ maxBytes: 100, limits: { audio: 10 } });
    const first = await cache.load("a", "audio", async () => blob("123456"), { pin: true });
    await cache.load("b", "audio", async () => blob("123456"), { pin: true });
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(first);
    cache.unpin("a");
    cache.prune();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
    expect(cache.has("b")).toBe(true);
  });

  it("clears only the requested material prefix", async () => {
    const cache = new MediaCache({ maxBytes: 100, limits: { audio: 100 } });
    const first = await cache.load("audio:7:3:1", "audio", async () => blob("a"));
    const second = await cache.load("audio:7:4:1", "audio", async () => blob("b"));
    cache.clearPrefix("audio:7:3:");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(second);
    cache.clear();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(second);
  });
});
