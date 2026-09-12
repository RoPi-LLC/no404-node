import { headers } from "next/headers";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import type { No404Client } from "../core/client.js";
import { visitorFromHeaders } from "../core/request.js";
import { NO404_URL_HEADER } from "./next-proxy.js";

export { NO404_URL_HEADER, withNo404Headers, type NextRequestLike } from "./next-proxy.js";

export interface ResolveNotFoundOptions {
  /** The URL to look up. Default: the `x-no404-url` header written by `withNo404Headers` in proxy.ts. */
  url?: string | undefined;
}

/**
 * Call it on the first line of `app/not-found.tsx` (App Router). A match
 * redirects; otherwise it returns and your 404 page renders as usual.
 *
 *   export default async function NotFound() {
 *     await resolveNotFound(no404);
 *     return <h1>Not found</h1>;
 *   }
 *
 * The page layer can only issue 308 (`permanentRedirect`) or 307 (`redirect`),
 * so the API's 301 becomes 308 and 302 becomes 307 — Google treats 308 as
 * permanent and 307 as temporary, exactly like 301 and 302. Do not wrap the
 * call in try/catch: both functions work by throwing. A page cannot set response
 * headers, so there is no `X-Redirect-By` and no debug headers here.
 */
export async function resolveNotFound(client: No404Client, options: ResolveNotFoundOptions = {}): Promise<void> {
  const requestHeaders = await headers();
  const url = options.url ?? requestHeaders.get(NO404_URL_HEADER);
  if (!url) return; // proxy.ts does not call withNo404Headers: nothing to look up.

  const result = await client.resolve({
    url,
    method: "GET",
    referrer: requestHeaders.get("referer"),
    visitor: visitorFromHeaders((name) => requestHeaders.get(name)),
    adapter: "next",
  });
  if (result.decision !== "redirect") return;
  if (result.status === 301) permanentRedirect(result.url);
  redirect(result.url);
}

/**
 * Use instead of `notFound()` in a dynamic route (a deleted product): redirects
 * when no404 has a match, otherwise calls `notFound()` exactly as before.
 *
 *   if (!product) await notFoundOrRedirect(no404, `/product/${slug}`);
 */
export async function notFoundOrRedirect(client: No404Client, path: string): Promise<never> {
  await resolveNotFound(client, { url: path });
  notFound();
}
