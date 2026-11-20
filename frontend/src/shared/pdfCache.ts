import type { PDFDocumentProxy } from "pdfjs-dist";

/** Keeps at most two recently opened PDF documents; range chunks stay inside pdf.js. */
export const PDF_CACHE_TTL = 15 * 60 * 1000;
const MB = 1024 * 1024;

type Entry = {
  url: string;
  doc: PDFDocumentProxy;
  bytes: number;
  lastUsed: number;
  expiresAt: number;
  pins: number;
};

export class PdfDocumentCache {
  private entries = new Map<string, Entry>();
  private epoch = 0;

  constructor(
    private maxDocs = 2,
    private maxBytes = 40 * MB,
    private ttlMs = PDF_CACHE_TTL,
  ) {}

  has(url: string) {
    const entry = this.entries.get(url);
    return !!entry && (entry.expiresAt > Date.now() || entry.pins > 0);
  }

  async acquire(url: string, load: () => Promise<PDFDocumentProxy>, bytes = 0): Promise<PDFDocumentProxy> {
    const now = Date.now();
    const hit = this.entries.get(url);
    if (hit && (hit.expiresAt > now || hit.pins > 0)) {
      hit.lastUsed = now;
      hit.expiresAt = now + this.ttlMs;
      hit.pins++;
      return hit.doc;
    }
    if (hit) this.remove(url);
    const epoch = this.epoch;
    const doc = await load();
    if (epoch !== this.epoch) {
      void doc.destroy().catch(() => undefined);
      const error = new Error("Aborted");
      error.name = "AbortError";
      throw error;
    }
    this.entries.set(url, {
      url,
      doc,
      bytes,
      lastUsed: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      pins: 1,
    });
    this.prune();
    return doc;
  }

  release(url: string) {
    const entry = this.entries.get(url);
    if (entry && entry.pins > 0) entry.pins--;
  }

  prune(now = Date.now()) {
    for (const entry of [...this.entries.values()]) {
      if (entry.pins === 0 && entry.expiresAt <= now) this.remove(entry.url);
    }
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    const oldest = () =>
      [...this.entries.values()]
        .filter((entry) => entry.pins === 0)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
    while (this.entries.size > this.maxDocs || total > this.maxBytes) {
      const entry = oldest();
      if (!entry) break;
      total -= entry.bytes;
      this.remove(entry.url);
    }
  }

  clear() {
    this.epoch++;
    for (const entry of this.entries.values()) void entry.doc.destroy().catch(() => undefined);
    this.entries.clear();
  }

  clearUnpinned() {
    for (const entry of [...this.entries.values()]) {
      if (entry.pins === 0) this.remove(entry.url);
    }
  }

  get size() {
    return this.entries.size;
  }

  private remove(url: string) {
    const entry = this.entries.get(url);
    if (!entry) return;
    void entry.doc.destroy().catch(() => undefined);
    this.entries.delete(url);
  }
}

export const pdfCache = new PdfDocumentCache();
