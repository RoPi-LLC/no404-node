import type { No404Client } from "../core/client.js";
import { REDIRECT_BY } from "../core/constants.js";
import { nodeHeaderGetter, visitorFromHeaders } from "../core/request.js";

/** The parts of the `getServerSideProps` context we use. */
export interface PagesContextLike {
  req: {
    method?: string | undefined;
    headers: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string | undefined } | undefined;
  };
  res: { setHeader(name: string, value: string): unknown };
  resolvedUrl: string;
}

export interface PagesRedirect {
  redirect: { destination: string; statusCode: 301 | 302 };
}

/**
 * Looks up the current Pages Router request. Returns a `getServerSideProps`
 * redirect (a real 301/302) or null.
 */
export async function resolvePagesNotFound(client: No404Client, context: PagesContextLike): Promise<PagesRedirect | null> {
  const get = nodeHeaderGetter(context.req.headers);
  const result = await client.resolve({
    url: context.resolvedUrl,
    method: context.req.method ?? "GET",
    referrer: get("referer"),
    visitor: visitorFromHeaders(get, context.req.socket?.remoteAddress),
    adapter: "next-pages",
  });
  for (const [name, value] of Object.entries(client.debugHeaders(result))) context.res.setHeader(name, value);
  if (result.decision !== "redirect") return null;
  context.res.setHeader("X-Redirect-By", REDIRECT_BY);
  return { redirect: { destination: result.url, statusCode: result.status } };
}

/**
 * `getServerSideProps` for a catch-all page (`pages/[...no404].tsx`): redirects
 * on a match, otherwise renders your `pages/404` with a real 404 status.
 *
 *   export const getServerSideProps = no404GetServerSideProps(no404);
 */
export function no404GetServerSideProps(client: No404Client) {
  return async (context: PagesContextLike): Promise<PagesRedirect | { notFound: true }> =>
    (await resolvePagesNotFound(client, context)) ?? { notFound: true };
}

/**
 * Wraps an existing `getServerSideProps`: when it returns `{ notFound: true }`
 * (a deleted product), no404 is asked first.
 *
 *   export const getServerSideProps = withNo404(no404, async (context) => { … });
 */
export function withNo404<C extends PagesContextLike, R>(client: No404Client, getServerSideProps: (context: C) => Promise<R>) {
  return async (context: C): Promise<R | PagesRedirect> => {
    const result = await getServerSideProps(context);
    if (isNotFound(result)) {
      const redirect = await resolvePagesNotFound(client, context);
      if (redirect) return redirect;
    }
    return result;
  };
}

function isNotFound(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { notFound?: unknown }).notFound === true;
}
