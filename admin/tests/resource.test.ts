import { it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useResource } from "../src/lib/use-resource";
afterEach(() => vi.unstubAllGlobals());
it("ignores an old classroom response after switching", async () => {
  const pending = new Map<string, (r: Response) => void>();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => pending.set(url, resolve)),
    ),
  );
  const { result, rerender } = renderHook(
    ({ path }) => useResource<{ name: string }>(path),
    { initialProps: { path: "/teacher/courses/1/catalog" } },
  );
  rerender({ path: "/teacher/courses/2/catalog" });
  await act(async () =>
    pending.get("/api/teacher/courses/2/catalog")!(
      new Response(JSON.stringify({ name: "班级二" })),
    ),
  );
  await waitFor(() => expect(result.current.data?.name).toBe("班级二"));
  await act(async () =>
    pending.get("/api/teacher/courses/1/catalog")!(
      new Response(JSON.stringify({ name: "班级一" })),
    ),
  );
  expect(result.current.data?.name).toBe("班级二");
});
