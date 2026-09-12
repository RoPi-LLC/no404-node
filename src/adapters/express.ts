import type { No404Client } from "../core/client.js";
import { REDIRECT_BY } from "../core/constants.js";
import { nodeHeaderGetter, visitorFromHeaders } from "../core/request.js";

/** The parts of Express's request we read (Express 4 and 5). */
export interface ExpressLikeRequest {
  method: string;
  originalUrl?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

/** The parts of Node's response we write. */
export interface ExpressLikeResponse {
  headersSent: boolean;
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(): unknown;
}

/**
 * Express middleware. Register it AFTER all your routes and BEFORE your own 404
 * handler: only requests no route answered reach it.
 *
 *   app.use(no404Express(no404));
 *   app.use((req, res) => res.status(404).send("Not found"));
 *
 * A match becomes a real 301/302; anything else (no match, no404 down, a POST)
 * falls through to your 404 handler.
 */
export function no404Express(client: No404Client) {
  return async function no404Middleware(
    req: ExpressLikeRequest,
    res: ExpressLikeResponse,
    next: (error?: unknown) => void,
  ): Promise<void> {
    if (res.headersSent || (req.method !== "GET" && req.method !== "HEAD")) {
      next();
      return;
    }
    const get = nodeHeaderGetter(req.headers);
    const result = await client.resolve({
      url: req.originalUrl ?? req.url ?? "/",
      method: req.method,
      referrer: get("referer"),
      visitor: visitorFromHeaders(get, req.socket?.remoteAddress),
      adapter: "express",
    });
    if (!res.headersSent) {
      for (const [name, value] of Object.entries(client.debugHeaders(result))) res.setHeader(name, value);
    }
    if (result.decision === "redirect" && !res.headersSent) {
      res.statusCode = result.status;
      res.setHeader("Location", result.url);
      res.setHeader("X-Redirect-By", REDIRECT_BY);
      res.end();
      return;
    }
    next();
  };
}
