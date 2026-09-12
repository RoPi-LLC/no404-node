import type { No404Client } from "../core/client.js";
import { REDIRECT_BY } from "../core/constants.js";
import { nodeHeaderGetter, visitorFromHeaders } from "../core/request.js";

/** The parts of Fastify's request we read. */
export interface FastifyLikeRequest {
  method: string;
  url: string;
  ip: string;
  headers: Record<string, string | string[] | undefined>;
  raw: { url?: string | undefined };
}

/** The parts of Fastify's reply we use. */
export interface FastifyLikeReply {
  code(statusCode: number): FastifyLikeReply;
  header(key: string, value: string): FastifyLikeReply;
  send(payload?: unknown): unknown;
}

export interface No404FastifyOptions<Req, Rep> {
  /** Your own 404 response when there is no redirect. Default: Fastify's standard 404 body. */
  fallback?: ((request: Req, reply: Rep) => unknown) | undefined;
}

/**
 * Fastify not-found handler. It also receives the 404s your routes raise with
 * `reply.callNotFound()` (a deleted product, for instance).
 *
 *   fastify.setNotFoundHandler(no404Fastify(no404));
 *
 * `request.ip` is used as the last IP source; set Fastify's `trustProxy` when
 * you run behind a proxy.
 */
export function no404Fastify<Req extends FastifyLikeRequest = FastifyLikeRequest, Rep extends FastifyLikeReply = FastifyLikeReply>(
  client: No404Client,
  options: No404FastifyOptions<Req, Rep> = {},
) {
  return async function no404NotFound(request: Req, reply: Rep): Promise<unknown> {
    if (request.method === "GET" || request.method === "HEAD") {
      const get = nodeHeaderGetter(request.headers);
      const result = await client.resolve({
        url: request.raw.url ?? request.url,
        method: request.method,
        referrer: get("referer"),
        visitor: visitorFromHeaders(get, request.ip),
        adapter: "fastify",
      });
      for (const [name, value] of Object.entries(client.debugHeaders(result))) reply.header(name, value);
      if (result.decision === "redirect") {
        return reply.code(result.status).header("location", result.url).header("x-redirect-by", REDIRECT_BY).send();
      }
    }
    if (options.fallback) return options.fallback(request, reply);
    return reply.code(404).send({
      message: `Route ${request.method}:${request.url} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  };
}
