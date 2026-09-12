import type { No404Client } from "../core/client.js";
import { REDIRECT_BY } from "../core/constants.js";
import { visitorFromHeaders } from "../core/request.js";

/** The parts of Hono's context we use. */
export interface HonoLikeContext {
  req: {
    url: string;
    method: string;
    header(name: string): string | undefined;
  };
  text(text: string, status?: number): Response;
  /** Sets a header on the response Hono builds next (the fallback's). */
  header?(name: string, value: string): void;
}

export interface No404HonoOptions<C> {
  /** Your own 404 response when there is no redirect. Default: `c.text("404 Not Found", 404)`. */
  fallback?: ((c: C) => Response | Promise<Response>) | undefined;
  /** The socket address when no forwarding header carries the visitor IP (e.g. `getConnInfo(c).remote.address`). */
  visitorIp?: ((c: C) => string | undefined) | undefined;
}

/**
 * Hono not-found handler. Hono only calls `notFound` on the TOP-LEVEL app, so
 * register it there, not on a sub-app mounted with `app.route()`.
 *
 *   app.notFound(no404Hono(no404));
 *
 * Runs on Node, Bun, Deno and Cloudflare Workers (Web APIs only). On Workers
 * pass a KV cache (`@no404/node/cache/kv`) — isolate memory does not last.
 */
export function no404Hono<C extends HonoLikeContext = HonoLikeContext>(
  client: No404Client,
  options: No404HonoOptions<C> = {},
) {
  return async function no404NotFound(c: C): Promise<Response> {
    const result = await client.resolve({
      url: c.req.url,
      method: c.req.method,
      referrer: c.req.header("referer"),
      visitor: visitorFromHeaders((name) => c.req.header(name), options.visitorIp?.(c)),
      adapter: "hono",
    });
    const debug = client.debugHeaders(result);
    if (result.decision === "redirect") {
      return new Response(null, {
        status: result.status,
        headers: { Location: result.url, "X-Redirect-By": REDIRECT_BY, ...debug },
      });
    }
    for (const [name, value] of Object.entries(debug)) c.header?.(name, value);
    return options.fallback ? options.fallback(c) : c.text("404 Not Found", 404);
  };
}
