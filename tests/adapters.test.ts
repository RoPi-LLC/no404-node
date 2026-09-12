import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import Fastify from "fastify";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { no404Express } from "../src/adapters/express.js";
import { no404Fastify } from "../src/adapters/fastify.js";
import { no404Hono } from "../src/adapters/hono.js";
import { fakeFetch, HIT, json, makeClient } from "./helpers.js";

const VISITOR_HEADERS = {
  "x-forwarded-for": "85.34.78.12, 10.0.0.1",
  "user-agent": "TestBrowser/1.0",
  "cf-ipcountry": "TR",
  referer: "https://google.com/",
};

describe("Express", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function start(api: ReturnType<typeof fakeFetch>) {
    const app = express();
    app.get("/exists", (_req, res) => {
      res.send("ok");
    });
    app.use(no404Express(makeClient(api)));
    app.use((_req, res) => {
      res.status(404).send("custom 404");
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    close = () => new Promise((resolve) => server.close(() => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("leaves existing pages alone", async () => {
    const api = fakeFetch();
    const base = await start(api);
    const res = await fetch(`${base}/exists`);
    expect(res.status).toBe(200);
    expect(api.calls).toHaveLength(0);
  });

  it("turns a match into a real 301 and forwards the visitor", async () => {
    const api = fakeFetch([json(HIT)]);
    const base = await start(api);
    const res = await fetch(`${base}/old-product?utm_source=x`, { redirect: "manual", headers: VISITOR_HEADERS });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://store.example/new");
    expect(res.headers.get("x-redirect-by")).toBe("no404");
    const sent = api.calls[0];
    expect(sent?.url).toContain("path=%2Fold-product&ref=");
    expect(sent?.url).not.toContain("utm_source");
    expect(sent?.headers).toMatchObject({
      "X-No404-Visitor-IP": "85.34.78.0",
      "X-No404-Visitor-UA": "TestBrowser/1.0",
      "X-No404-Visitor-Country": "TR",
    });
    expect(sent?.headers["User-Agent"]).toContain("(express)");
  });

  it("adds debug headers to the 404 and to the redirect when asked", async () => {
    const api = fakeFetch([json(HIT)]);
    const app = express();
    app.use(no404Express(makeClient(api, { debug: true })));
    app.use((_req, res) => {
      res.status(404).send("custom 404");
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    close = () => new Promise((resolve) => server.close(() => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const redirect = await fetch(`${base}/old-product`, { redirect: "manual" });
    expect(redirect.headers.get("x-no404-source")).toBe("CATALOG");
    const missing = await fetch(`${base}/style.css`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-no404-skip")).toBe("blacklist");
  });

  it("falls through to your 404 handler without a match, and ignores POST", async () => {
    const api = fakeFetch();
    const base = await start(api);
    const res = await fetch(`${base}/nothing`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("custom 404");
    expect((await fetch(`${base}/nothing`, { method: "POST" })).status).toBe(404);
    expect(api.calls).toHaveLength(1);
  });
});

describe("Fastify", () => {
  function build(api: ReturnType<typeof fakeFetch>, withFallback = false) {
    const app = Fastify();
    app.get("/exists", async () => "ok");
    app.get("/product/:slug", async (_request, reply) => reply.callNotFound());
    app.setNotFoundHandler(
      no404Fastify(makeClient(api), withFallback ? { fallback: (_request, reply) => reply.code(404).send("mine") } : {}),
    );
    return app;
  }

  it("redirects unmatched routes and callNotFound() alike", async () => {
    const api = fakeFetch([json(HIT), json({ ...HIT, redirect: "/new-product", redirectStatus: 302 })]);
    const app = build(api);
    const a = await app.inject({ method: "GET", url: "/old-product", headers: VISITOR_HEADERS });
    expect(a.statusCode).toBe(301);
    expect(a.headers.location).toBe("https://store.example/new");
    expect(a.headers["x-redirect-by"]).toBe("no404");
    const b = await app.inject({ method: "GET", url: "/product/deleted" });
    expect(b.statusCode).toBe(302);
    expect(b.headers.location).toBe("/new-product");
    expect(api.calls[0]?.headers["X-No404-Visitor-IP"]).toBe("85.34.78.0");
  });

  it("keeps Fastify's 404 body, or your fallback", async () => {
    const plain = await build(fakeFetch()).inject({ method: "GET", url: "/nothing" });
    expect(plain.statusCode).toBe(404);
    expect(plain.json()).toMatchObject({ message: "Route GET:/nothing not found", statusCode: 404 });
    const custom = await build(fakeFetch(), true).inject({ method: "GET", url: "/nothing" });
    expect(custom.body).toBe("mine");
  });
});

describe("Hono", () => {
  function build(api: ReturnType<typeof fakeFetch>) {
    const app = new Hono();
    app.get("/exists", (c) => c.text("ok"));
    app.notFound(no404Hono(makeClient(api)));
    return app;
  }

  it("redirects a match", async () => {
    const api = fakeFetch([json(HIT)]);
    const res = await build(api).request("/old-product?gclid=1", { headers: { "cf-connecting-ip": "85.34.78.12" } });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://store.example/new");
    expect(api.calls[0]?.url).toContain("&ad=google");
    expect(api.calls[0]?.headers["X-No404-Visitor-IP"]).toBe("85.34.78.0");
  });

  it("puts debug headers on the redirect and on Hono's 404", async () => {
    const app = new Hono();
    app.notFound(no404Hono(makeClient(fakeFetch([json(HIT)]), { debug: true })));
    expect((await app.request("/old-product")).headers.get("x-no404-score")).toBe("0.900");
    expect((await app.request("/logo.png")).headers.get("x-no404-skip")).toBe("blacklist");
  });

  it("answers Hono's default 404 otherwise", async () => {
    const api = fakeFetch();
    const app = build(api);
    expect((await app.request("/exists")).status).toBe(200);
    const res = await app.request("/nothing");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("404 Not Found");
    expect(api.calls).toHaveLength(1);
  });
});
