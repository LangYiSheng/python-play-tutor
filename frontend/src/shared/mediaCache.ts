/** Bounded in-memory cache for authenticated media (audio and page images). */
export type MediaKind = "audio" | "image";

export const MEDIA_CACHE_TTL = 15 * 60 * 1000;
const MB = 1024 * 1024;

type Entry = {
  key: string;
  url: string;
  bytes: number;
  kind: MediaKind;
  lastUsed: number;
  expiresAt: number;
  pins: number;
};

type Options = {
  maxBytes?: number;
  limits?: Partial<Record<MediaKind, number>>;
};

function abortError() {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

export class MediaCache {
  private entries = new Map<string, Entry>();
  private maxBytes: number;
  private limits: Record<MediaKind, number>;

  constructor(options: Options = {}) {
    this.maxBytes = options.maxBytes ?? 50 * MB;
    this.limits = { audio: 30 * MB, image: 20 * MB, ...options.limits };
  }

  async load(
    key: string,
    kind: MediaKind,
    loader: () => Promise<Blob>,
    options: { signal?: AbortSignal; pin?: boolean; ttlMs?: number } = {},
  ): Promise<string> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && (hit.expiresAt > now || hit.pins > 0)) {
      if (options.signal?.aborted) throw abortError();
      hit.lastUsed = now;
      hit.expiresAt = now + (options.ttlMs ?? MEDIA_CACHE_TTL);
      if (options.pin) hit.pins++;
      return hit.url;
    }
    if (hit) this.remove(key);
    const blob = await loader();
    if (options.signal?.aborted) throw abortError();
    const url = URL.createObjectURL(blob);
    this.entries.set(key, {
      key,
      url,
      bytes: blob.size,
      kind,
      lastUsed: Date.now(),
      expiresAt: Date.now() + (options.ttlMs ?? MEDIA_CACHE_TTL),
      pins: options.pin ? 1 : 0,
    });
    this.prune();
    return url;
  }

  pin(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.pins++;
    entry.lastUsed = Date.now();
    entry.expiresAt = Date.now() + MEDIA_CACHE_TTL;
  }

  unpin(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.pins > 0) entry.pins--;
  }

  has(key: string) {
    return this.entries.has(key);
  }

  prune(now = Date.now()) {
    for (const entry of [...this.entries.values()]) {
      if (entry.pins === 0 && entry.expiresAt <= now) this.remove(entry.key);
    }
    const totals: Record<MediaKind, number> = { audio: 0, image: 0 };
    for (const entry of this.entries.values()) totals[entry.kind] += entry.bytes;
    let total = totals.audio + totals.image;
    const oldest = () =>
      [...this.entries.values()]
        .filter((entry) => entry.pins === 0)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
    while (total > this.maxBytes || totals.audio > this.limits.audio || totals.image > this.limits.image) {
      const entry = oldest();
      if (!entry) break;
      total -= entry.bytes;
      totals[entry.kind] -= entry.bytes;
      this.remove(entry.key);
    }
  }

  clear() {
    for (const entry of this.entries.values()) URL.revokeObjectURL(entry.url);
    this.entries.clear();
  }

  clearPrefix(prefix: string) {
    for (const entry of [...this.entries.values()]) {
      if (entry.key.startsWith(prefix)) this.remove(entry.key);
    }
  }

  clearUnpinned() {
    for (const entry of [...this.entries.values()]) {
      if (entry.pins === 0) this.remove(entry.key);
    }
  }

  get size() {
    return [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    URL.revokeObjectURL(entry.url);
    this.entries.delete(key);
  }
}

export const mediaCache = new MediaCache();
