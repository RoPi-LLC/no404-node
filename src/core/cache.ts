import type { CacheAdapter } from "./types.js";

export interface MemoryCacheOptions {
  /** Oldest entries are dropped beyond this (default 5000 ≈ 1.5 MB). */
  maxEntries?: number | undefined;
}

/**
 * The default cache: an in-process LRU with per-entry expiry.
 *
 * It lives in ONE process. On serverless platforms (Vercel, Lambda, Workers)
 * and with several pods, every instance asks again for the same dead path —
 * use `@no404/node/cache/redis` or `/cache/kv` there (README, "Deployment").
 */
export class MemoryCache implements CacheAdapter {
  readonly #entries = new Map<string, { value: unknown; expiresAt: number }>();
  readonly #maxEntries: number;

  constructor(options: MemoryCacheOptions = {}) {
    this.#maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 5000));
  }

  get(key: string): unknown {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    // Re-insert: a Map iterates in insertion order, so the front is the least recent.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: unknown, ttlSeconds: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

export function memoryCache(options?: MemoryCacheOptions): MemoryCache {
  return new MemoryCache(options);
}

const SHARED_CACHE = Symbol.for("@no404/node:memory-cache");

/**
 * The default cache, one per PROCESS rather than per client: Next.js can load
 * the same module in two bundles, and two client copies with separate caches
 * would each ask about the same path. Entries are scoped to the API key, so
 * clients with different keys never read each other's answers.
 */
export function sharedMemoryCache(): MemoryCache {
  const store = globalThis as unknown as Record<symbol, MemoryCache | undefined>;
  return (store[SHARED_CACHE] ??= new MemoryCache());
}

/** FNV-1a, 32 bit, as 8 hex characters. Scopes cache keys to the API key; not reversible in practice. */
export function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
