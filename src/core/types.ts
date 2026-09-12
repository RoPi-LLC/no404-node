import type { MATCH_SOURCES } from "./constants.js";

export type MatchSource = (typeof MATCH_SOURCES)[number];

/** What the API said about a path. This is also what is cached (negatives included). */
export interface LookupResult {
  found: boolean;
  redirect: string | null;
  score: number;
  source: MatchSource;
  /** The API's own 301/302 decision; 0 when an older API did not send it. */
  redirectStatus: 301 | 302 | 0;
}

/** The visitor who hit the 404. The full IP never leaves the site (see README, "What is sent"). */
export interface Visitor {
  ip?: string | undefined;
  userAgent?: string | undefined;
  country?: string | undefined;
}

export interface ResolveInput {
  /** The request URL — a path (`/old?utm=x`) or a full URL. The query is read locally, never sent. */
  url: string;
  /** Only GET and HEAD are looked up. Defaults to GET. */
  method?: string | undefined;
  referrer?: string | null | undefined;
  visitor?: Visitor | undefined;
  /** Adapter name, reported in the User-Agent (`express`, `next` …). */
  adapter?: string | undefined;
}

export type SkipReason =
  | "not-configured"
  | "method"
  | "invalid-path"
  | "blacklist"
  | "no-match"
  | "circuit-open"
  | "lookup-failed"
  | "invalid-target"
  | "error";

export type ResolveResult =
  | {
      decision: "redirect";
      url: string;
      status: 301 | 302;
      source: MatchSource;
      score: number;
      cached: boolean;
      path: string;
    }
  | {
      decision: "none";
      reason: SkipReason;
      cached: boolean;
      path?: string | undefined;
      /** Set when the API answered (no-match, invalid-target). */
      source?: MatchSource | undefined;
      score?: number | undefined;
    };

/** A key-value store with expiry. Values are plain JSON-serialisable objects. */
export interface CacheAdapter {
  get(key: string): unknown;
  set(key: string, value: unknown, ttlSeconds: number): void | Promise<void>;
  delete?(key: string): void | Promise<void>;
}

export type No404ErrorKind =
  | "invalid-key-format"
  | "configuration"
  | "rate-limited"
  | "unreachable"
  | "server-error"
  | "redirected"
  | "cache"
  | "internal";

export interface No404Error {
  kind: No404ErrorKind;
  message: string;
  status?: number | undefined;
}

export interface Logger {
  debug?(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
}

export interface BreakerState {
  /** Unix time (seconds) when lookups resume. */
  until: number;
  status: number;
  reason: string;
}

export type PingCode =
  | "ok"
  | "no_api_base"
  | "no_api_key"
  | "invalid_key"
  | "forbidden"
  | "rate_limited"
  | "invalid_path"
  | "redirected"
  | "unreachable"
  | "server_error"
  | "unexpected";

export interface PingResult {
  code: PingCode;
  status: number;
  found: boolean;
  redirect: string | null;
  score: number;
  source: MatchSource;
  /** Error message, or the `Location` of a redirect. Never contains the API key. */
  detail: string;
}

export interface No404Options {
  /** Defaults to `NO404_API_KEY`. Server-side only — never expose it to the browser. */
  apiKey?: string | undefined;
  /** Your site's root URL. Allowed redirect hosts and the User-Agent come from it. Defaults to `NO404_SITE_URL`. */
  siteUrl?: string | undefined;
  /** Defaults to `NO404_BASE_URL`, then https://www.no404.tr. */
  baseUrl?: string | undefined;
  /** Lookup timeout, 200–1500 ms (default 1500). */
  timeoutMs?: number | undefined;
  /** How long a result is cached, 60–604800 s (default 3600). */
  cacheTtlSeconds?: number | undefined;
  /** Default: an in-memory LRU. Use a shared store (Redis, KV) on serverless platforms. */
  cache?: CacheAdapter | undefined;
  /** Hosts a redirect target may point to. Default: the siteUrl host and its www / non-www twin. */
  allowedHosts?: readonly string[] | undefined;
  /** Extra path prefixes never looked up (`/api`, `/static` …). */
  ignorePrefixes?: readonly string[] | undefined;
  /** Extra file extensions never looked up. */
  ignoreExtensions?: readonly string[] | undefined;
  /** Send every redirect as a 301. Off by default: a 301 is cached permanently by browsers. */
  force301?: boolean | undefined;
  /** Site secret for the pseudonymous visitor ID. Defaults to `NO404_VISITOR_SECRET`; none → no ID is sent. */
  visitorSecret?: string | undefined;
  /** Called on configuration, network and cache problems. Never throws into your request. Default: console.warn. */
  onError?: ((error: No404Error) => void) | undefined;
  logger?: Logger | undefined;
  /** Custom fetch (tests, proxies). Default: globalThis.fetch. */
  fetch?: typeof fetch | undefined;
  /** Turn every lookup off. Defaults to `NO404_DISABLED=1`. */
  disabled?: boolean | undefined;
  /**
   * Add `X-No404-Source`, `X-No404-Score` and `X-No404-Skip` to 404 and redirect
   * responses (Express, Fastify, Hono, Next Pages Router). Defaults to `NO404_DEBUG=1`.
   * For troubleshooting only: it tells anyone how the site handles its 404s.
   */
  debug?: boolean | undefined;
  /** Where the NO404_* variables are read from. Default: process.env when it exists (pass `env` on Workers). */
  env?: Record<string, string | undefined> | undefined;
}
