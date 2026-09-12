import type { CacheAdapter } from "../core/types.js";

/**
 * What we need from a Redis client. Works with ioredis and Upstash (`setex`)
 * and node-redis (`setEx`) without importing any of them.
 */
export interface RedisLikeClient {
  get(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  setex?(key: string, seconds: number, value: string): Promise<unknown>;
  setEx?(key: string, seconds: number, value: string): Promise<unknown>;
}

export interface RedisCacheOptions {
  /** Prepended to every key (e.g. "myapp:"). */
  prefix?: string | undefined;
}

/**
 * A shared cache: every instance (serverless functions, pods) sees the same
 * answers and the same circuit breaker, so a dead path is asked about once.
 *
 *   import Redis from "ioredis";
 *   const no404 = createNo404({ cache: createRedisCache(new Redis(process.env.REDIS_URL)) });
 *
 * A Redis error never breaks a request: the client reports it (`onError`,
 * kind "cache") and answers without the cache.
 */
export function createRedisCache(client: RedisLikeClient, options: RedisCacheOptions = {}): CacheAdapter {
  const prefix = options.prefix ?? "";
  return {
    async get(key) {
      const raw = await client.get(prefix + key);
      if (raw === null || raw === undefined) return undefined;
      if (typeof raw !== "string") return raw; // Upstash parses JSON itself.
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return undefined;
      }
    },
    async set(key, value, ttlSeconds) {
      const seconds = Math.max(1, Math.ceil(ttlSeconds));
      const payload = JSON.stringify(value);
      if (client.setEx) await client.setEx(prefix + key, seconds, payload);
      else if (client.setex) await client.setex(prefix + key, seconds, payload);
      else throw new Error("the Redis client has neither setex nor setEx");
    },
    async delete(key) {
      await client.del(prefix + key);
    },
  };
}
