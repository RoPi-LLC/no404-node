import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNo404, MemoryCache, VERSION, type CacheAdapter, type No404Error } from "../src/index.js";
import { fakeFetch, HIT, json, makeClient, NONE } from "./helpers.js";

// Ported one to one from the WordPress plugin's tests/test-core.php, so every
// integration keeps the same behaviour contract.

describe("normalizePath (must match cleanPath on the server)", () => {
  const c = makeClient(fakeFetch());
  it.each([
    ["/product/gold-ring/", "/product/gold-ring"],
    ["//product//x", "/product/x"],
    ["/product?utm_source=google", "/product"],
    ["/product#section", "/product"],
    ["https://store.example/product/x", "/product/x"],
    ["\\product\\x", "/product/x"],
    ["/", "/"],
    ["/product\r\n", "/product"],
    ["", ""],
    ["https://store.example?q=1", "/"],
  ])("%j → %j", (input, expected) => {
    expect(c.normalizePath(input)).toBe(expected);
  });
});

describe("isIgnoredPath (quota protection)", () => {
  const c = makeClient(fakeFetch());
  it.each([
    ["/tema/style.css", true],
    ["/gorsel/foto.PNG", true],
    ["/wp-admin/edit.php", true],
    ["/wp-json/wp/v2/posts", true],
    ["/.well-known/acme", true],
    ["/14-gram-gold-ring-102", false],
    ["/product/3.5-mm-cable", false],
    ["/wp-administration-guide", false],
    ["/file.", false],
  ])("%s → %s", (path, expected) => {
    expect(c.isIgnoredPath(path)).toBe(expected);
  });

  it("takes extra extensions", () => {
    const custom = makeClient(fakeFetch(), { ignoreExtensions: [".HTML"] });
    expect(custom.isIgnoredPath("/old.html")).toBe(true);
  });
});

describe("decideStatus (the 301/302 decision)", () => {
  const c = makeClient(fakeFetch());
  const forced = makeClient(fakeFetch(), { force301: true });
  it("follows the local rule when the API does not say", () => {
    expect(c.decideStatus({ source: "REDIRECT", score: 1 })).toBe(301);
    expect(c.decideStatus({ source: "CATALOG", score: 0.92 })).toBe(301);
    expect(c.decideStatus({ source: "CATALOG", score: 0.5 })).toBe(301);
    expect(c.decideStatus({ source: "CATALOG", score: 0.42 })).toBe(302);
    expect(c.decideStatus({ source: "FALLBACK", score: 0 })).toBe(302);
  });
  it("obeys the API's redirectStatus (the dashboard threshold)", () => {
    expect(c.decideStatus({ source: "CATALOG", score: 0.92, redirectStatus: 302 })).toBe(302);
    expect(c.decideStatus({ source: "CATALOG", score: 0.42, redirectStatus: 301 })).toBe(301);
    expect(c.decideStatus({ source: "CATALOG", score: 0.42, redirectStatus: 307 })).toBe(302);
  });
  it("force301 wins over everything", () => {
    expect(forced.decideStatus({ source: "FALLBACK", score: 0 })).toBe(301);
    expect(forced.decideStatus({ source: "CATALOG", score: 0.42, redirectStatus: 302 })).toBe(301);
  });
});

describe("validateTarget (open redirect + loop protection)", () => {
  const c = makeClient(fakeFetch());
  it.each([
    ["https://store.example/new", "https://store.example/new"],
    ["https://www.store.example/new", "https://www.store.example/new"],
    ["https://evil.com/x", ""],
    ["//evil.com/x", ""],
    ["/\\evil.com/x", ""],
    ["https://store.example@evil.com/x", ""],
    ["javascript:alert(1)", ""],
    ["data:text/html,x", ""],
    ["ftp://store.example/x", ""],
    ["/new-product", "/new-product"],
    ["new-product", ""],
    ["https://store.example/old", ""],
    ["/old", ""],
    ["https://store.example/old/", ""],
    ["https://store.example/x\r\nX-Evil: 1", ""],
    ["", ""],
  ])("%j → %j", (target, expected) => {
    expect(c.validateTarget(target, "/old")).toBe(expected);
  });
  it("accepts only relative targets when there is no siteUrl", () => {
    const bare = makeClient(fakeFetch(), { siteUrl: undefined });
    expect(bare.validateTarget("https://store.example/new", "/old")).toBe("");
    expect(bare.validateTarget("/new", "/old")).toBe("/new");
  });
});

describe("resolve: the cache protects the quota", () => {
  it("asks the API once per path", async () => {
    const api = fakeFetch([json(HIT)]);
    const c = makeClient(api);
    const r1 = await c.resolve({ url: "/old-product" });
    const r2 = await c.resolve({ url: "/old-product" });
    const r3 = await c.resolve({ url: "/old-product/" });
    const r4 = await c.resolve({ url: "/old-product?utm=abc" });
    expect(api.calls).toHaveLength(1);
    expect(r1).toMatchObject({ decision: "redirect", url: "https://store.example/new", status: 301, cached: false });
    for (const r of [r2, r3, r4]) expect(r).toMatchObject({ decision: "redirect", cached: true });
  });

  it("caches negative results too", async () => {
    const api = fakeFetch([json(NONE), json(HIT)]);
    const c = makeClient(api);
    await c.resolve({ url: "/nothing-here" });
    await c.resolve({ url: "/nothing-here" });
    const r = await c.resolve({ url: "/nothing-here" });
    expect(api.calls).toHaveLength(1);
    expect(r).toEqual({
      decision: "none",
      reason: "no-match",
      cached: true,
      path: "/nothing-here",
      source: "NONE",
      score: 0,
    });
  });

  it("never sends a static file or an ignored prefix", async () => {
    const api = fakeFetch();
    const c = makeClient(api);
    for (const url of ["/tema/style.css", "/wp-admin/x", "/gorsel/a.jpg", "/"]) await c.resolve({ url });
    expect(api.calls).toHaveLength(0);
  });

  it("only looks up GET and HEAD", async () => {
    const api = fakeFetch([json(HIT)]);
    const c = makeClient(api);
    expect(await c.resolve({ url: "/old", method: "POST" })).toMatchObject({ reason: "method" });
    expect(await c.resolve({ url: "/old", method: "head" })).toMatchObject({ decision: "redirect" });
    expect(api.calls).toHaveLength(1);
  });

  it("merges concurrent lookups of one path into one API call", async () => {
    const api = fakeFetch([json(HIT)]);
    const c = makeClient(api);
    const [a, b] = await Promise.all([c.resolve({ url: "/twice" }), c.resolve({ url: "/twice" })]);
    expect(api.calls).toHaveLength(1);
    expect(a).toMatchObject({ decision: "redirect" });
    expect(b).toMatchObject({ decision: "redirect" });
  });

  it("merges them across client copies too (Next.js loads modules in two bundles)", async () => {
    const api = fakeFetch([json(HIT)]);
    const options = { apiKey: "sharedkey123", fetch: api.fetch, siteUrl: "https://store.example", env: {} };
    const [a, b] = await Promise.all([
      createNo404(options).resolve({ url: "/copies" }),
      createNo404(options).resolve({ url: "/copies" }),
    ]);
    expect(api.calls).toHaveLength(1);
    expect(a.decision).toBe("redirect");
    expect(b.decision).toBe("redirect");
    // …and share the default cache afterwards.
    await createNo404(options).resolve({ url: "/copies" });
    expect(api.calls).toHaveLength(1);
  });

  it("shares answers between clients on one cache", async () => {
    const api = fakeFetch([json(HIT)]);
    const cache = new Map<string, unknown>();
    const shared: CacheAdapter = { get: (k) => cache.get(k), set: (k, v) => void cache.set(k, v) };
    await makeClient(api, { cache: shared }).resolve({ url: "/old-product" });
    await makeClient(api, { cache: shared }).resolve({ url: "/old-product" });
    expect(api.calls).toHaveLength(1);
  });
});

describe("FAIL-OPEN: the site stays up when no404 is down", () => {
  it("opens the circuit breaker after a transport failure", async () => {
    const api = fakeFetch([new TypeError("fetch failed")]);
    const c = makeClient(api);
    expect(await c.resolve({ url: "/old-product" })).toMatchObject({ decision: "none", reason: "lookup-failed" });
    expect(await c.resolve({ url: "/another-product" })).toMatchObject({ decision: "none", reason: "circuit-open" });
    expect(api.calls).toHaveLength(1);
    expect(c.errors.map((e) => e.kind)).toEqual(["unreachable"]);
    expect(await c.breakerState()).toMatchObject({ reason: "unreachable", status: 0 });
  });

  it("gives up after the timeout", async () => {
    const slow = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const c = createNo404({
      apiKey: "testkey123",
      fetch: slow,
      timeoutMs: 200,
      cache: new MemoryCache(),
      onError: () => undefined,
      env: {},
    });
    const started = Date.now();
    const r = await c.resolve({ url: "/slow" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r).toMatchObject({ reason: "lookup-failed" });
  });

  it.each([
    [401, "configuration", "configuration"],
    [403, "configuration", "configuration"],
    [404, "configuration", "configuration"],
    [429, "rate_limited", "rate-limited"],
    [500, "server_error", "server-error"],
    [302, "redirected", "redirected"],
  ])("HTTP %i trips the breaker (%s)", async (status, reason, kind) => {
    const api = fakeFetch([json({ success: false, message: "x" }, status)]);
    const c = makeClient(api);
    expect(await c.resolve({ url: "/old" })).toMatchObject({ decision: "none", reason: "lookup-failed" });
    expect(await c.breakerState()).toMatchObject({ reason, status });
    expect(c.errors[0]).toMatchObject({ kind, status });
    await c.resolve({ url: "/other" });
    expect(api.calls).toHaveLength(1);
  });

  it("resetBreaker closes it", async () => {
    const api = fakeFetch([json({}, 429)]);
    const c = makeClient(api);
    await c.resolve({ url: "/old" });
    await c.resetBreaker();
    expect(await c.breakerState()).toBeNull();
    await c.resolve({ url: "/other" });
    expect(api.calls).toHaveLength(2);
  });

  it("swallows a malformed body and caches it as a miss", async () => {
    const api = fakeFetch([new Response("<html>not JSON</html>", { status: 200 })]);
    const c = makeClient(api);
    expect(await c.resolve({ url: "/old" })).toMatchObject({ reason: "lookup-failed" });
    expect(await c.resolve({ url: "/old" })).toMatchObject({ reason: "no-match", cached: true });
    expect(api.calls).toHaveLength(1);
  });

  it("survives missing fields", async () => {
    const c = makeClient(fakeFetch([json({ success: true })]));
    expect(await c.resolve({ url: "/old" })).toMatchObject({ decision: "none", reason: "no-match" });
  });

  it("keeps working when the cache throws (and reports it once)", async () => {
    const broken: CacheAdapter = {
      get: () => {
        throw new Error("redis down");
      },
      set: () => {
        throw new Error("redis down");
      },
    };
    const api = fakeFetch([json(HIT), json(HIT)]);
    const c = makeClient(api, { cache: broken });
    expect(await c.resolve({ url: "/a" })).toMatchObject({ decision: "redirect" });
    expect(await c.resolve({ url: "/a" })).toMatchObject({ decision: "redirect" });
    expect(c.errors.filter((e) => e.kind === "cache")).toHaveLength(1);
  });

  it("never lets a throwing onError or logger reach the request", async () => {
    const c = createNo404({
      apiKey: "testkey123",
      cache: new MemoryCache(),
      fetch: fakeFetch([new TypeError("down")]).fetch,
      onError: () => {
        throw new Error("boom");
      },
      logger: {
        debug: () => {
          throw new Error("boom");
        },
      },
      env: {},
    });
    await expect(c.resolve({ url: "/old" })).resolves.toMatchObject({ decision: "none" });
  });
});

describe("the target is validated after the lookup", () => {
  it("drops a foreign host and a loop", async () => {
    const api = fakeFetch([json({ ...HIT, redirect: "https://evil.com/x" }), json({ ...HIT, redirect: "/loop" })]);
    const c = makeClient(api);
    expect(await c.resolve({ url: "/old" })).toMatchObject({ reason: "invalid-target" });
    expect(await c.resolve({ url: "/loop/" })).toMatchObject({ reason: "invalid-target" });
  });

  it("uses the API's redirectStatus", async () => {
    const c = makeClient(fakeFetch([json({ ...HIT, redirectStatus: 302 })]));
    expect(await c.resolve({ url: "/old" })).toMatchObject({ decision: "redirect", status: 302 });
  });
});

describe("the request", () => {
  it("is built like the other integrations'", async () => {
    const api = fakeFetch();
    const c = makeClient(api);
    await c.resolve({ url: "/14-gram-altin-yüzük", referrer: "https://google.com/search?q=x" });
    const call = api.calls[0];
    expect(call?.url).toBe(
      `https://no404.tr/api/v1/resolve?path=${encodeURIComponent("/14-gram-altin-yüzük")}&ref=${encodeURIComponent("https://google.com/search?q=x")}`,
    );
    expect(call?.headers.Authorization).toBe("Bearer testkey123");
    expect(call?.headers["User-Agent"]).toBe(`no404-node/${VERSION} (core); https://store.example`);
    expect(call?.url).not.toContain("testkey123");
    expect(call?.headers).not.toHaveProperty("Origin");
    expect(call?.init.redirect).toBe("manual");
  });

  it("names the adapter in the User-Agent", async () => {
    const api = fakeFetch();
    await makeClient(api).resolve({ url: "/x", adapter: "express" });
    expect(api.calls[0]?.headers["User-Agent"]).toContain("(express)");
  });
});

describe("visitor data: truncated IP + UA, never the full IP", () => {
  const c = makeClient(fakeFetch());

  it("sends the visitor headers next to the key", async () => {
    const api = fakeFetch();
    const client = makeClient(api);
    await client.resolve({
      url: "/visitor",
      visitor: { ip: "85.34.78.211", userAgent: "Mozilla/5.0\r\nX-Evil: 1", country: "tr" },
    });
    const headers = api.calls[0]?.headers ?? {};
    expect(headers["X-No404-Visitor-IP"]).toBe("85.34.78.0");
    expect(headers["X-No404-Visitor-UA"]).toBe("Mozilla/5.0X-Evil: 1");
    expect(headers["X-No404-Visitor-Country"]).toBe("TR");
    expect(headers).not.toHaveProperty("X-No404-Visitor-Id");
    expect(JSON.stringify(api.calls)).not.toContain("85.34.78.211");
  });

  it("drops invalid values, non-ASCII and unknown countries", async () => {
    expect(await c.visitorHeaders({ ip: "bad", country: "XX" })).toEqual({});
    expect(await c.visitorHeaders({ userAgent: "Bot 🤖" })).toEqual({ "X-No404-Visitor-UA": "Bot" });
  });

  it("sends nothing about the visitor in the connection test", async () => {
    const api = fakeFetch();
    await makeClient(api).ping();
    expect(Object.keys(api.calls[0]?.headers ?? {}).some((h) => h.startsWith("X-No404-Visitor"))).toBe(false);
  });
});

describe("visitor ID: site-keyed HMAC of the full IP", () => {
  const c = makeClient(fakeFetch(), { visitorSecret: "site-secret-A" });

  it("equals the WordPress / Laravel ID (HMAC over the packed address)", async () => {
    const expected = createHmac("sha256", "site-secret-A").update(Buffer.from([85, 34, 78, 211])).digest("hex");
    expect(await c.visitorId("85.34.78.211")).toBe(expected);
  });

  it("is stable across spellings and differs between neighbours and sites", async () => {
    const id = await c.visitorId("85.34.78.211");
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(await c.visitorId("::ffff:85.34.78.211")).toBe(id);
    expect(await c.visitorId("2a01:4f8::1")).toBe(await c.visitorId("2A01:04F8:0:0:0:0:0:1"));
    expect(await c.visitorId("85.34.78.212")).not.toBe(id);
    const other = makeClient(fakeFetch(), { visitorSecret: "site-secret-B" });
    expect(await other.visitorId("85.34.78.211")).not.toBe(id);
  });

  it("needs a secret and a valid IP", async () => {
    expect(await makeClient(fakeFetch()).visitorId("85.34.78.211")).toBe("");
    expect(await c.visitorId("not-an-ip")).toBe("");
  });

  it("travels next to the truncated IP", async () => {
    const api = fakeFetch();
    await makeClient(api, { visitorSecret: "site-secret-A" }).resolve({ url: "/v", visitor: { ip: "85.34.78.211" } });
    expect(api.calls[0]?.headers["X-No404-Visitor-Id"]).toBe(await c.visitorId("85.34.78.211"));
  });
});

describe("detectAdCategory (only the category leaves the site)", () => {
  const c = makeClient(fakeFetch());
  it.each([
    ["/p?gclid=abc", "google"],
    ["/p?gbraid=abc", "google"],
    ["/p?msclkid=abc", "microsoft"],
    ["/p?utm_medium=paid&utm_source=facebook", "meta"],
    ["/p?utm_source=ig&utm_medium=paid", "meta"],
    ["/p?utm_medium=CPC&utm_source=google", "google"],
    ["/p?utm_medium=cpc&utm_source=newsletter", "other"],
    ["/p?ttclid=1", "other"],
    ["/p?fbclid=xyz", null],
    ["/p?utm_medium=email&utm_source=newsletter", null],
    ["/p", null],
    ["/p#gclid=abc", null],
  ])("%s → %s", (url, expected) => {
    expect(c.detectAdCategory(url)).toBe(expected);
  });
});

describe("an ad click skips the cache READ and sends only the category", () => {
  it("counts every paid click", async () => {
    const api = fakeFetch([json(HIT), json(HIT)]);
    const c = makeClient(api);
    await c.resolve({ url: "/old-product" });
    await c.resolve({ url: "/old-product?gclid=abc123" });
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]?.url).toContain("&ad=google");
    expect(api.calls[1]?.url).not.toContain("abc123");
    await c.resolve({ url: "/old-product?fbclid=x" });
    expect(api.calls).toHaveLength(2);
  });

  it("falls back to the cache when no404 is down", async () => {
    const api = fakeFetch([json(HIT), new TypeError("timeout")]);
    const c = makeClient(api);
    await c.resolve({ url: "/old-product" });
    const r = await c.resolve({ url: "/old-product?utm_medium=paid&utm_source=facebook" });
    expect(r).toMatchObject({ decision: "redirect", url: "https://store.example/new", cached: true });
  });
});

describe("configuration", () => {
  it("stays silent without a key", async () => {
    const api = fakeFetch();
    const c = makeClient(api, { apiKey: "" });
    expect(await c.resolve({ url: "/old" })).toMatchObject({ reason: "not-configured" });
    expect(api.calls).toHaveLength(0);
    expect(c.errors).toHaveLength(0);
  });

  it("reports a malformed key once and never sends it", async () => {
    const api = fakeFetch();
    const c = makeClient(api, { apiKey: "bad key!" });
    await c.resolve({ url: "/a" });
    await c.resolve({ url: "/b" });
    expect(api.calls).toHaveLength(0);
    expect(c.errors.map((e: No404Error) => e.kind)).toEqual(["invalid-key-format"]);
  });

  it("reads NO404_* from env and honours NO404_DISABLED", async () => {
    const api = fakeFetch([json(HIT)]);
    const fromEnv = createNo404({
      fetch: api.fetch,
      cache: new MemoryCache(),
      env: { NO404_API_KEY: "testkey123", NO404_SITE_URL: "https://store.example/", NO404_BASE_URL: "https://staging.test/" },
    });
    expect(await fromEnv.resolve({ url: "/old" })).toMatchObject({ decision: "redirect" });
    expect(api.calls[0]?.url.startsWith("https://staging.test/api/v1/resolve?")).toBe(true);
    expect(fromEnv.allowedHosts).toEqual(["store.example", "www.store.example"]);

    const off = createNo404({ fetch: api.fetch, env: { NO404_API_KEY: "testkey123", NO404_DISABLED: "1" } });
    expect(await off.resolve({ url: "/old" })).toMatchObject({ reason: "not-configured" });
  });

  it("logs a debug line without the key", async () => {
    const debug = vi.fn();
    const c = makeClient(fakeFetch([json(HIT)]), { logger: { debug } });
    await c.resolve({ url: "/old", visitor: { ip: "85.34.78.211" } });
    expect(debug).toHaveBeenCalledOnce();
    expect(JSON.stringify(debug.mock.calls)).not.toMatch(/testkey123|85\.34\.78\.211/);
  });
});

describe("debug headers (same names and values as the Laravel package)", () => {
  it("are empty unless debug is on", async () => {
    const c = makeClient(fakeFetch([json(HIT)]));
    expect(c.debugHeaders(await c.resolve({ url: "/old" }))).toEqual({});
  });

  it("describe every outcome", async () => {
    const api = fakeFetch([json(HIT), json({ ...NONE, score: 0.21 }), json({ ...HIT, redirect: "https://evil.com" })]);
    const c = makeClient(api, { debug: true });
    expect(c.debugHeaders(await c.resolve({ url: "/old" }))).toEqual({
      "X-No404-Source": "CATALOG",
      "X-No404-Score": "0.900",
      "X-No404-Skip": "none",
    });
    expect(c.debugHeaders(await c.resolve({ url: "/old" }))).toMatchObject({ "X-No404-Skip": "cached" });
    expect(c.debugHeaders(await c.resolve({ url: "/miss" }))).toEqual({
      "X-No404-Source": "NONE",
      "X-No404-Score": "0.210",
      "X-No404-Skip": "none",
    });
    expect(c.debugHeaders(await c.resolve({ url: "/foreign" }))).toMatchObject({ "X-No404-Skip": "invalid-target" });
    expect(c.debugHeaders(await c.resolve({ url: "/a.css" }))).toEqual({ "X-No404-Skip": "blacklist" });
    expect(c.debugHeaders(await c.resolve({ url: "/x", method: "POST" }))).toEqual({ "X-No404-Skip": "method" });
  });

  it("read NO404_DEBUG", async () => {
    const c = createNo404({ apiKey: "testkey123", cache: new MemoryCache(), fetch: fakeFetch().fetch, env: { NO404_DEBUG: "1" } });
    expect(c.debugHeaders(await c.resolve({ url: "/a.css" }))).toEqual({ "X-No404-Skip": "blacklist" });
  });
});

describe("ping (connection test)", () => {
  it("reports a redirect with its Location", async () => {
    const location = "https://www.no404.tr/api/v1/resolve?path=/test";
    const c = makeClient(fakeFetch([new Response(null, { status: 302, headers: { location } })]));
    expect(await c.ping("/test")).toMatchObject({ code: "redirected", status: 302, detail: location });
  });

  it("maps the answers", async () => {
    expect(await makeClient(fakeFetch([json(HIT)])).ping()).toMatchObject({ code: "ok", found: true, redirect: HIT.redirect });
    expect(await makeClient(fakeFetch([json({ message: "Invalid key" }, 401)])).ping()).toMatchObject({ code: "invalid_key", detail: "Invalid key" });
    expect(await makeClient(fakeFetch([json({}, 403)])).ping()).toMatchObject({ code: "forbidden" });
    expect(await makeClient(fakeFetch([json({}, 429)])).ping()).toMatchObject({ code: "rate_limited" });
    expect(await makeClient(fakeFetch([new TypeError("dns")])).ping()).toMatchObject({ code: "unreachable" });
    expect(await makeClient(fakeFetch(), { apiKey: "" }).ping()).toMatchObject({ code: "no_api_key" });
  });

  it("bypasses the cache and the breaker", async () => {
    const api = fakeFetch([json({}, 429), json(HIT)]);
    const c = makeClient(api);
    await c.resolve({ url: "/old" });
    expect(await c.ping("/old")).toMatchObject({ code: "ok" });
    expect(api.calls).toHaveLength(2);
  });
});
