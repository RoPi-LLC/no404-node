import { createNo404, MemoryCache, type No404Client, type No404Error, type No404Options } from "../src/index.js";

export interface FakeCall {
  url: string;
  headers: Record<string, string>;
  init: RequestInit;
}

type Queued = Response | Error | (() => Response | Promise<Response>);

export const HIT = {
  success: true,
  found: true,
  redirect: "https://store.example/new",
  score: 0.9,
  source: "CATALOG",
};

export const NONE = { success: true, found: false, redirect: null, score: 0, source: "NONE" };

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake no404 API: answers from a queue (default: no match) and COUNTS every call. */
export function fakeFetch(queue: Queued[] = []) {
  const calls: FakeCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      init: init ?? {},
    });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    return next ?? json(NONE);
  }) as typeof fetch;
  return { fetch: fetchFn, calls, queue };
}

export type FakeApi = ReturnType<typeof fakeFetch>;

/**
 * A client wired to the fake API; errors are collected instead of printed.
 * Each gets its own cache — the default one is shared by the whole process.
 */
export function makeClient(api: FakeApi, extra: No404Options = {}): No404Client & { errors: No404Error[] } {
  const errors: No404Error[] = [];
  const client = createNo404({
    cache: new MemoryCache(),
    apiKey: "testkey123",
    baseUrl: "https://no404.tr",
    siteUrl: "https://store.example",
    ignorePrefixes: ["/wp-admin", "/wp-json"],
    fetch: api.fetch,
    onError: (error) => errors.push(error),
    env: {},
    ...extra,
  });
  return Object.assign(client, { errors });
}
