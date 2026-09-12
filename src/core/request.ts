import { isPublicIp } from "./ip.js";
import type { Visitor } from "./types.js";

/** Reads one request header by lower-case name. */
export type HeaderGetter = (name: string) => string | null | undefined;

/** Forwarding headers, in the order the WordPress and Laravel integrations read them. */
const IP_HEADERS = ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"] as const;
/** Country headers set by CDNs (Cloudflare, Vercel, CloudFront). */
const COUNTRY_HEADERS = ["cf-ipcountry", "x-vercel-ip-country", "cloudfront-viewer-country"] as const;

/**
 * The visitor behind a request. Behind a CDN or reverse proxy the socket
 * address is the proxy, so the usual forwarding headers are read first. A
 * visitor can forge those, but the value only feeds that site's own statistics
 * (and is truncated before it is sent); no404's rate limit uses this server's
 * real address. Private and reserved addresses are never used.
 */
export function visitorFromHeaders(get: HeaderGetter, remoteAddress?: string | null): Visitor {
  const visitor: Visitor = {};

  const ip = pickPublicIp(get, remoteAddress);
  if (ip !== undefined) visitor.ip = ip;

  const userAgent = get("user-agent");
  if (userAgent) visitor.userAgent = userAgent;

  for (const name of COUNTRY_HEADERS) {
    const country = get(name);
    if (country) {
      visitor.country = country;
      break;
    }
  }
  return visitor;
}

function pickPublicIp(get: HeaderGetter, remoteAddress?: string | null): string | undefined {
  for (const name of IP_HEADERS) {
    const raw = get(name);
    if (!raw) continue;
    for (const part of raw.split(",")) {
      const candidate = part.trim();
      if (isPublicIp(candidate)) return candidate;
    }
  }
  if (remoteAddress && isPublicIp(remoteAddress)) return remoteAddress;
  return undefined;
}

/** A getter over Node's `IncomingHttpHeaders` (Express, Fastify's raw request, Next Pages). */
export function nodeHeaderGetter(headers: Record<string, string | string[] | undefined>): HeaderGetter {
  return (name) => {
    const value = headers[name];
    return Array.isArray(value) ? value.join(", ") : value;
  };
}
