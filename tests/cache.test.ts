import { afterEach, describe, expect, it, vi } from "vitest";
import { createKvCache } from "../src/cache/kv.js";
import { createRedisCache } from "../src/cache/redis.js";
import { MemoryCache } from "../src/index.js";
import { fakeFetch, HIT, json, makeClient } from "./helpers.js";

describe("MemoryCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires entries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cache = new MemoryCache();
    cache.set("k", { a: 1 }, 60);
    vi.setSystemTime(59_000);
    expect(cache.get("k")).toEqual({ a: 1 });
    vi.setSystemTime(60_000);
    expect(cache.get("k")).toBeUndefined();
  });

  it("drops the least recently used entry", () => {
    const cache = new MemoryCache({ maxEntries: 2 });
    cache.set("a", 1, 60);
    cache.set("b", 2, 60);
    cache.get("a");
    cache.set("c", 3, 60);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.size).toBe(2);
  });
});

function fakeRedis(style: "setex" | "setEx") {
  const store = new Map<string, string>();
  const write = vi.fn(async (key: string, _seconds: number, value: string) => {
    store.set(key, value);
    return "OK";
  });
  return {
    store,
    write,
    client: {
      get: async (key: string) => store.get(key) ?? null,
      del: async (key: string) => store.delete(key),
      ...(style === "setex" ? { setex: write } : { setEx: write }),
    },
  };
}

describe("createRedisCache", () => {
  it.each(["setex", "setEx"] as const)("round-trips JSON through %s", async (style) => {
    const redis = fakeRedis(style);
    const cache = createRedisCache(redis.client, { prefix: "app:" });
    await cache.set("k", { a: 1 }, 59.2);
    expect(redis.write).toHaveBeenCalledWith("app:k", 60, '{"a":1}');
    expect(await cache.get("k")).toEqual({ a: 1 });
    await cache.delete?.("k");
    expect(await cache.get("k")).toBeUndefined();
  });

  it("shares answers and the breaker between instances", async () => {
    const redis = fakeRedis("setex");
    const api = fakeFetch([json(HIT), json({}, 429)]);
    await makeClient(api, { cache: createRedisCache(redis.client) }).resolve({ url: "/old" });
    const second = makeClient(api, { cache: createRedisCache(redis.client) });
    expect(await second.resolve({ url: "/old" })).toMatchObject({ decision: "redirect", cached: true });
    await second.resolve({ url: "/quota" });
    const third = makeClient(api, { cache: createRedisCache(redis.client) });
    expect(await third.resolve({ url: "/another" })).toMatchObject({ reason: "circuit-open" });
    expect(api.calls).toHaveLength(2);
  });

  it("accepts clients that parse JSON themselves (Upstash)", async () => {
    const cache = createRedisCache({ get: async () => ({ a: 1 }), del: async () => 1, setex: async () => "OK" });
    expect(await cache.get("k")).toEqual({ a: 1 });
  });
});

describe("createKvCache", () => {
  it("stores JSON with at least Workers' 60 s TTL", async () => {
    const store = new Map<string, string>();
    const put = vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    });
    const cache = createKvCache({
      get: async (key) => store.get(key) ?? null,
      put,
      delete: async (key) => {
        store.delete(key);
      },
    });
    await cache.set("k", { a: 1 }, 1);
    expect(put).toHaveBeenCalledWith("k", '{"a":1}', { expirationTtl: 60 });
    expect(await cache.get("k")).toEqual({ a: 1 });
  });
});
