# no404 for Node.js

Real server-side **301/302 redirects for your 404s**, matched against your live
catalogue by [no404](https://www.no404.tr). When a visitor lands on a deleted
product or an old URL, your server asks no404 for the best current page and
redirects there — a real HTTP redirect that search engines follow, not a
JavaScript hop on a 404 page.

Works with **Express, Fastify, Hono and Next.js** (App Router and Pages Router).
Zero runtime dependencies. Fail-open: if no404 is slow or down, your normal 404
page renders after at most 1.5 seconds, and lookups pause for a minute.

## Requirements

| | Supported |
| --- | --- |
| Node.js | 22.12 or newer (24 and 26 tested) |
| Express | 4.18+ and 5 |
| Fastify | 5 |
| Hono | 4 (Node, Bun, Deno, Cloudflare Workers) |
| Next.js | 15 and 16 (App Router and Pages Router, Node runtime) |

You need a no404 account and a site. The API key is on the site's
**Integration** tab in the no404 dashboard.

## Install

```bash
npm install @no404/node
```

Set the key as a **server-side** environment variable — never with a
`NEXT_PUBLIC_` / `VITE_` prefix:

```bash
NO404_API_KEY=your-site-key
NO404_SITE_URL=https://shop.example
# optional: a random secret for exact unique-visitor counts (openssl rand -hex 32)
NO404_VISITOR_SECRET=...
```

Create the client **once** and share it:

```js
// no404.js
import { createNo404 } from "@no404/node";

export const no404 = createNo404(); // reads NO404_API_KEY and NO404_SITE_URL
```

## Express

Register the middleware **after all your routes** and **before** your own 404
handler. Only requests no route answered reach it.

```js
import express from "express";
import { no404Express } from "@no404/node/express";
import { no404 } from "./no404.js";

const app = express();
// … your routes …
app.use(no404Express(no404));
app.use((req, res) => res.status(404).send("Not found")); // still runs when there is no match
```

## Fastify

```js
import Fastify from "fastify";
import { no404Fastify } from "@no404/node/fastify";
import { no404 } from "./no404.js";

const fastify = Fastify({ trustProxy: true });
fastify.setNotFoundHandler(no404Fastify(no404));
```

404s your routes raise with `reply.callNotFound()` (a deleted product) are
covered too. Pass `{ fallback: (request, reply) => … }` for your own 404 body.

## Hono

```js
import { Hono } from "hono";
import { no404Hono } from "@no404/node/hono";
import { no404 } from "./no404.js";

const app = new Hono();
// … your routes …
app.notFound(no404Hono(no404)); // on the top-level app — Hono does not call notFound on sub-apps
```

## Next.js — App Router

Three small pieces. `proxy.ts` hands the original URL to the not-found page
(on Next 15 the file is `middleware.ts`):

```ts
// proxy.ts
import { NextResponse, type NextRequest } from "next/server";
import { withNo404Headers } from "@no404/node/next/proxy";

export function proxy(request: NextRequest) {
  return NextResponse.next({ request: { headers: withNo404Headers(request) } });
}

export const config = { matcher: ["/((?!_next/|api/|favicon.ico).*)"] };
```

Already have a `proxy.ts`? Pass `withNo404Headers(request)` as the request
headers of the response you already return.

```tsx
// app/not-found.tsx — every unmatched URL and every notFound() lands here
import { resolveNotFound } from "@no404/node/next";
import { no404 } from "@/lib/no404";

export default async function NotFound() {
  await resolveNotFound(no404); // redirects on a match, returns otherwise
  return <h1>Page not found</h1>;
}
```

```tsx
// app/product/[slug]/page.tsx — a deleted product
import { notFoundOrRedirect } from "@no404/node/next";

if (!product) await notFoundOrRedirect(no404, `/product/${slug}`); // instead of notFound()
```

### Why you see 308/307 on the App Router

The App Router's page layer can only issue `permanentRedirect()` (308) and
`redirect()` (307). The SDK maps no404's **301 → 308** and **302 → 307**.
Google treats 308 exactly like 301 (permanent) and 307 like 302 (temporary);
the only difference is that the request method is kept, which does not matter
for page views. Pages Router and the other frameworks send 301/302 as is.

## Next.js — Pages Router

```ts
// pages/[...no404].tsx — catch-all for addresses no page answers
import { no404GetServerSideProps } from "@no404/node/next/pages";
import { no404 } from "@/lib/no404";

export const getServerSideProps = no404GetServerSideProps(no404);
export default function NotFound() {
  return null; // never rendered: it redirects or renders pages/404 with a real 404
}
```

Wrap an existing `getServerSideProps` that returns `{ notFound: true }`:

```ts
import { withNo404 } from "@no404/node/next/pages";

export const getServerSideProps = withNo404(no404, async (context) => {
  const product = await findProduct(context.params?.slug);
  return product ? { props: { product } } : { notFound: true };
});
```

## Configuration

```js
createNo404({
  apiKey: process.env.NO404_API_KEY, // default: NO404_API_KEY
  siteUrl: "https://shop.example",    // default: NO404_SITE_URL — allowed redirect hosts come from it
  timeoutMs: 1500,                    // 200–1500
  cacheTtlSeconds: 3600,              // 60–604800, negative answers included
  cache: memoryCache(),               // or createRedisCache(...) / createKvCache(...)
  ignorePrefixes: ["/api", "/static"],// never looked up (Next adds nothing; list your own)
  ignoreExtensions: ["html"],         // added to the built-in list (css, js, images, fonts …)
  allowedHosts: ["shop.example", "www.shop.example"], // default: siteUrl host + www twin
  force301: false,                    // off: a 301 is cached forever by browsers
  visitorSecret: process.env.NO404_VISITOR_SECRET,
  onError: (error) => {},             // configuration / network / cache problems; default console.warn
  logger: { debug: console.debug },   // one line per lookup — never the key or the IP
  debug: false,                       // X-No404-Source / -Score / -Skip response headers (troubleshooting only)
});
```

| Variable | Meaning |
| --- | --- |
| `NO404_API_KEY` | The site's API key (required). |
| `NO404_SITE_URL` | Your site's root URL. Without it only relative targets are allowed. |
| `NO404_VISITOR_SECRET` | Site secret for the pseudonymous visitor ID. |
| `NO404_BASE_URL` | The API address (default `https://www.no404.tr`). |
| `NO404_DISABLED=1` | Kill switch: no lookups at all. |
| `NO404_DEBUG=1` | Debug headers: `X-No404-Source`, `X-No404-Score`, `X-No404-Skip` (`cached`, `none`, `circuit`, `blacklist`, `invalid-target` …). Not on the App Router, which cannot set response headers from a page. Turn it off again: it tells anyone how your 404s are handled. |

The **301 or 302** decision comes from the threshold you choose in the no404
dashboard (`redirectStatus` in the API response); `force301` overrides it.

## Deployment: use a shared cache on serverless

Every answer is cached per path — including "no match" — so a dead URL costs
one lookup per hour, not one per visit. The default cache lives in one
process. On Vercel, AWS Lambda, Cloudflare Workers or several pods, every
instance would ask again; use a shared store (the circuit breaker is shared
with it):

```js
import Redis from "ioredis"; // or node-redis, or @upstash/redis
import { createRedisCache } from "@no404/node/cache/redis";

export const no404 = createNo404({ cache: createRedisCache(new Redis(process.env.REDIS_URL)) });
```

```js
// Cloudflare Workers + Hono
import { createKvCache } from "@no404/node/cache/kv";

app.notFound((c) =>
  no404Hono(createNo404({ env: c.env, cache: createKvCache(c.env.NO404_KV) }))(c),
);
```

A cache error never breaks a request: the lookup goes to no404 directly and
`onError` is called (at most once a minute).

## What is sent

To resolve a 404, the SDK sends no404:

- the **path** without the query string (`/old-product`, never `?utm_…`);
- the `Referer`, when there is one;
- the **ad category** (`google`, `microsoft`, `meta`, `other`) when the URL
  carries an ad click — worked out locally; click IDs such as `gclid` are never sent;
- the visitor's **IP truncated to its network** (`203.0.113.0`, `2001:db8:1c1c::`);
  private and reserved addresses are not sent at all;
- a **visitor ID**: an HMAC-SHA256 of the full IP keyed with *your*
  `NO404_VISITOR_SECRET` — no404 cannot turn it back into an address or match a
  visitor across sites (no secret → no ID);
- the visitor's user agent (up to 512 characters) and the country your CDN reports;
- the SDK's own user agent (`no404-node/<version> (<framework>); <your site>`).

Never sent: the full IP, cookies, sessions, request bodies, the query string.
The API key travels in the `Authorization` header, never in a URL.

## Fail-open

| Situation | What happens |
| --- | --- |
| A normal page | Nothing — the SDK only runs where your framework would answer 404. |
| Cached answer | Answered from the cache, no request. |
| Many visitors on one dead link at once | One request to no404, shared by all of them. |
| no404 slow or down | Your 404 page after ≤ 1.5 s; lookups pause for 60 s. |
| Rate limit / quota (429) | Lookups pause for 5 minutes. |
| Invalid key, paused site, inactive plan | Lookups pause for 5 minutes; `onError` tells you. |
| Malformed answer | No redirect; cached as a miss. |
| Target on another host, a loop, a header injection | No redirect. |

Every redirect carries `X-Redirect-By: no404` (except on the Next.js App Router,
which cannot set response headers from a page).

## Check your installation

```bash
npx @no404/node doctor                                   # environment + project
npx @no404/node resolve /old-product                     # does the key work? (1 lookup)
npx @no404/node check https://shop.example/old-product --expect 301
npx @no404/node check https://shop.example --random      # a made-up path: expect 404
```

The no404 dashboard's installation test shows the other side: whether no404
received the lookup.

## Limits

- Static exports (`output: "export"` in Next.js) have no server — the SDK cannot run.
- The Next.js `edge` runtime is not supported (Next 16's `proxy` runs on Node).
- `getStaticProps` 404s have no server code to hook into; use `getServerSideProps` or the App Router.
- Only GET and HEAD requests are looked up.

## License

MIT © RoPi LLC
