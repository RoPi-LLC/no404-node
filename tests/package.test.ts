import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { USER_AGENT_PREFIX, VERSION } from "../src/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  dependencies?: Record<string, string>;
  exports: Record<string, unknown>;
};

describe("package", () => {
  it("sends the published version in the User-Agent", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("keeps the User-Agent prefix the no404 dashboard recognises", () => {
    expect(USER_AGENT_PREFIX).toBe("no404-node/");
  });

  it("has zero runtime dependencies", () => {
    // pnpm drops an empty "dependencies" object; absent and empty mean the same.
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it("exports every subpath", () => {
    expect(Object.keys(pkg.exports)).toEqual([
      ".",
      "./express",
      "./fastify",
      "./hono",
      "./next",
      "./next/proxy",
      "./next/pages",
      "./cache/redis",
      "./cache/kv",
      "./package.json",
    ]);
  });
});
