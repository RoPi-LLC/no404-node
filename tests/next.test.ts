import { describe, expect, it, vi } from "vitest";
import { fakeFetch, HIT, json, makeClient } from "./helpers.js";

const mocks = vi.hoisted(() => {
  class NavigationSignal extends Error {
    constructor(
      readonly kind: "permanent" | "temporary" | "not-found",
      readonly url: string,
    ) {
      super(kind);
    }
  }
  return { NavigationSignal, headers: new Headers() };
});

vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("next/navigation", () => ({
  permanentRedirect: (url: string) => {
    throw new mocks.NavigationSignal("permanent", url);
  },
  redirect: (url: string) => {
    throw new mocks.NavigationSignal("temporary", url);
  },
  notFound: () => {
    throw new mocks.NavigationSignal("not-found", "");
  },
}));

const { notFoundOrRedirect, resolveNotFound, withNo404Headers } = await import("../src/adapters/next.js");
const { no404GetServerSideProps, withNo404 } = await import("../src/adapters/next-pages.js");

describe("Next.js App Router", () => {
  it("proxy header: always overwritten with the real URL", () => {
    const headers = withNo404Headers({
      nextUrl: { pathname: "/old", search: "?gclid=1" },
      headers: new Headers({ "x-no404-url": "/injected", accept: "text/html" }),
    });
    expect(headers.get("x-no404-url")).toBe("/old?gclid=1");
    expect(headers.get("accept")).toBe("text/html");
  });

  it("301 → permanentRedirect (308), 302 → redirect (307)", async () => {
    mocks.headers = new Headers({ "x-no404-url": "/old-product?gclid=1", "x-forwarded-for": "85.34.78.12" });
    const api = fakeFetch([json(HIT), json({ ...HIT, redirectStatus: 302 })]);
    const client = makeClient(api);
    await expect(resolveNotFound(client)).rejects.toMatchObject({ kind: "permanent", url: HIT.redirect });
    mocks.headers = new Headers({ "x-no404-url": "/other" });
    await expect(resolveNotFound(client)).rejects.toMatchObject({ kind: "temporary" });
    expect(api.calls[0]?.url).toContain("&ad=google");
    expect(api.calls[0]?.headers["X-No404-Visitor-IP"]).toBe("85.34.78.0");
    expect(api.calls[0]?.headers["User-Agent"]).toContain("(next)");
  });

  it("returns quietly without the proxy header or a match", async () => {
    const api = fakeFetch();
    mocks.headers = new Headers();
    await expect(resolveNotFound(makeClient(api))).resolves.toBeUndefined();
    expect(api.calls).toHaveLength(0);
    mocks.headers = new Headers({ "x-no404-url": "/nothing" });
    await expect(resolveNotFound(makeClient(api))).resolves.toBeUndefined();
  });

  it("notFoundOrRedirect keeps notFound() when there is no match", async () => {
    mocks.headers = new Headers();
    await expect(notFoundOrRedirect(makeClient(fakeFetch()), "/product/x")).rejects.toMatchObject({ kind: "not-found" });
    await expect(notFoundOrRedirect(makeClient(fakeFetch([json(HIT)])), "/product/x")).rejects.toMatchObject({ kind: "permanent" });
  });
});

describe("Next.js Pages Router", () => {
  function context(url: string) {
    const setHeader = vi.fn();
    return {
      ctx: { req: { method: "GET", headers: { "user-agent": "UA" } }, res: { setHeader }, resolvedUrl: url },
      setHeader,
    };
  }

  it("catch-all: a real 301/302 or { notFound: true }", async () => {
    const gssp = no404GetServerSideProps(makeClient(fakeFetch([json(HIT)])));
    const { ctx, setHeader } = context("/old-product");
    expect(await gssp(ctx)).toEqual({ redirect: { destination: HIT.redirect, statusCode: 301 } });
    expect(setHeader).toHaveBeenCalledWith("X-Redirect-By", "no404");
    expect(await no404GetServerSideProps(makeClient(fakeFetch()))(context("/nothing").ctx)).toEqual({ notFound: true });
  });

  it("withNo404 only asks when your getServerSideProps says notFound", async () => {
    const api = fakeFetch([json(HIT)]);
    const client = makeClient(api);
    const found = withNo404(client, async () => ({ props: { ok: true } }));
    expect(await found(context("/product/a").ctx)).toEqual({ props: { ok: true } });
    expect(api.calls).toHaveLength(0);
    const missing = withNo404(client, async () => ({ notFound: true as const }));
    expect(await missing(context("/product/b").ctx)).toMatchObject({ redirect: { statusCode: 301 } });
  });
});
