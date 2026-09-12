/**
 * Next.js proxy helper. This file imports nothing from `next`, so it is safe in
 * `proxy.ts` (Next 16) and `middleware.ts` (Next 15, edge runtime).
 */

/** The request header that carries the original URL into `not-found.tsx`. */
export const NO404_URL_HEADER = "x-no404-url";

/** The parts of `NextRequest` we read. */
export interface NextRequestLike {
  nextUrl: { pathname: string; search: string };
  headers: Headers;
}

/**
 * A copy of the request headers with the original URL added (always
 * overwritten, so a visitor cannot inject it). In `proxy.ts`:
 *
 *   return NextResponse.next({ request: { headers: withNo404Headers(request) } });
 */
export function withNo404Headers(request: NextRequestLike): Headers {
  const headers = new Headers(request.headers);
  headers.set(NO404_URL_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return headers;
}
