import { defineConfig } from "tsdown";

/**
 * One entry per `exports` subpath. The core and the adapters only use Web APIs
 * (fetch, URL, AbortSignal, crypto.subtle), so the build is platform-neutral;
 * `scripts/assert-zero-deps.mjs` fails the build if a `node:` import slips
 * into anything but the CLI.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    express: "src/adapters/express.ts",
    fastify: "src/adapters/fastify.ts",
    hono: "src/adapters/hono.ts",
    next: "src/adapters/next.ts",
    "next-proxy": "src/adapters/next-proxy.ts",
    "next-pages": "src/adapters/next-pages.ts",
    "cache-redis": "src/cache/redis.ts",
    "cache-kv": "src/cache/kv.ts",
    cli: "src/cli.ts",
  },
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "node22",
  dts: true,
  clean: true,
  sourcemap: false,
  external: [/^node:/, /^next(\/|$)/],
});
