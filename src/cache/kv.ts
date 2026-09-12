import type { CacheAdapter } from "../core/types.js";

/** What we need from a Cloudflare Workers KV namespace. */
export interface KvNamespaceLike {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface KvCacheOptions {
  /** Prepended to every key. */
  prefix?: string | undefined;
}

/** Workers KV refuses an `expirationTtl` below 60 seconds. */
const KV_MIN_TTL = 60;

/**
 * Cloudflare Workers KV cache. Isolate memory is short-lived on Workers, so the
 * default in-memory cache barely helps there; KV is shared by every isolate.
 *
 *   app.notFound((c) => no404Hono(createNo404({ env: c.env, cache: createKvCache(c.env.NO404_KV) }))(c));
 */
export function createKvCache(namespace: KvNamespaceLike, options: KvCacheOptions = {}): CacheAdapter {
  const prefix = options.prefix ?? "";
  return {
    async get(key) {
      const raw = await namespace.get(prefix + key, "text");
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return undefined;
      }
    },
    async set(key, value, ttlSeconds) {
      await namespace.put(prefix + key, JSON.stringify(value), {
        expirationTtl: Math.max(KV_MIN_TTL, Math.ceil(ttlSeconds)),
      });
    },
    async delete(key) {
      await namespace.delete(prefix + key);
    },
  };
}
