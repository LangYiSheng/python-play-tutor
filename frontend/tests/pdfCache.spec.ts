import { describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfDocumentCache } from "../src/shared/pdfCache";

function fakeDoc() {
  return { destroy: vi.fn(async () => undefined) } as unknown as PDFDocumentProxy;
}

describe("pdf document cache", () => {
  it("evicts the oldest unpinned document after the second document", async () => {
    const cache = new PdfDocumentCache(2, 1000, 60_000);
    const first = fakeDoc();
    const second = fakeDoc();
    const third = fakeDoc();
    await cache.acquire("a", async () => first, 10);
    cache.release("a");
    await cache.acquire("b", async () => second, 10);
    cache.release("b");
    await cache.acquire("c", async () => third, 10);
    expect(first.destroy).toHaveBeenCalled();
    expect(second.destroy).not.toHaveBeenCalled();
    expect(cache.has("c")).toBe(true);
  });

  it("does not evict a document while it is still pinned", async () => {
    const cache = new PdfDocumentCache(1, 1000, 60_000);
    const first = fakeDoc();
    const second = fakeDoc();
    await cache.acquire("a", async () => first, 10);
    await cache.acquire("b", async () => second, 10);
    expect(first.destroy).not.toHaveBeenCalled();
    cache.release("a");
    cache.prune();
    expect(first.destroy).toHaveBeenCalled();
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
  });

  it("reuses a cached document and refreshes its pin", async () => {
    const cache = new PdfDocumentCache();
    const doc = fakeDoc();
    const loader = vi.fn(async () => doc);
    expect(await cache.acquire("a", loader)).toBe(doc);
    expect(await cache.acquire("a", loader)).toBe(doc);
    expect(loader).toHaveBeenCalledTimes(1);
    cache.release("a");
    cache.release("a");
    cache.prune();
    expect(doc.destroy).not.toHaveBeenCalled();
  });

  it("destroys expired and cleared documents", async () => {
    const cache = new PdfDocumentCache(2, 1000, 100);
    const doc = fakeDoc();
    await cache.acquire("a", async () => doc);
    cache.release("a");
    cache.prune(Date.now() + 200);
    expect(doc.destroy).toHaveBeenCalled();

    const cleared = fakeDoc();
    await cache.acquire("b", async () => cleared);
    cache.clear();
    expect(cleared.destroy).toHaveBeenCalled();
  });
});
