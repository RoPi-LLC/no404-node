import { VERSION } from "../version.js";
import { detectAdCategory } from "./ad.js";
import { detectAiSource } from "./ai.js";
import { fnv1a32, sharedMemoryCache } from "./cache.js";
import {
  API_KEY_PATTERN,
  CACHE_SCHEMA,
  CONFIG_ERROR_TTL,
  DEFAULT_BASE_URL,
  DEFAULT_CACHE_TTL,
  DEFAULT_IGNORED_EXTENSIONS,
  DEFAULT_IGNORED_PREFIXES,
  DEFAULT_TIMEOUT_MS,
  HIGH_CONFIDENCE_SCORE,
  MATCH_SOURCES,
  MAX_CACHE_TTL,
  MAX_PATH_LENGTH,
  MAX_TIMEOUT_MS,
  MAX_USER_AGENT_LENGTH,
  MIN_CACHE_TTL,
  MIN_TIMEOUT_MS,
  OUTAGE_TTL,
  PING_TIMEOUT_MS,
  QUOTA_TTL,
  USER_AGENT_PREFIX,
  type AdCategory,
  type AiSource,
} from "./constants.js";
import { parseIp, truncateIp } from "./ip.js";
import { byteLength, normalizePath, trimTrailingSlashes } from "./path.js";
import type {
  BreakerState,
  CacheAdapter,
  Logger,
  LookupResult,
  MatchSource,
  No404Error,
  No404ErrorKind,
  No404Options,
  PingResult,
  ResolveInput,
  ResolveResult,
  SkipReason,
  Visitor,
} from "./types.js";

type Transport =
  | { ok: true; status: number; body: string; location: string }
  | { ok: false; error: string };

type Lookup = { result: LookupResult; cached: boolean } | { result: null; reason: SkipReason };

/** Traffic categories worked out locally and sent as `ad=` / `src=`. Never the raw query. */
interface Hints {
  ad: AdCategory | null;
  ai: AiSource | null;
}

// eslint-disable-next-line no-control-regex -- header-injection guard: control characters are exactly what it looks for
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;
/** Header values must be ByteStrings; a stray emoji in a User-Agent would make fetch throw. */
const NON_PRINTABLE_ASCII = /[^\x20-\x7E]/g;
const SOURCE_SET: ReadonlySet<string> = new Set(MATCH_SOURCES);
const EMPTY_RESULT: LookupResult = {
  found: false,
  redirect: null,
  score: 0,
  source: "NONE",
  redirectStatus: 0,
};
/** Cache errors (Redis down) are reported at most this often. */
const CACHE_ERROR_INTERVAL_MS = 60_000;

/**
 * no404 — the framework-independent core (the behaviour contract).
 *
 * A port of `No404_Client` from the WordPress plugin (1.0.3), by way of the
 * Laravel package: same normalisation, blacklist, cache (negatives included),
 * circuit breaker, 301/302 decision and target validation, so a site behaves
 * the same whichever integration it runs. Only Web APIs are used (fetch, URL,
 * AbortSignal, crypto.subtle) — no `node:` import may enter this folder.
 *
 * FAIL-OPEN: `resolve()` never throws and never waits longer than the timeout.
 * When no404 is slow, down or answers something malformed, it returns
 * `decision: "none"` and your application renders its own 404 page.
 */
export class No404Client {
  readonly apiBase: string;
  readonly siteUrl: string;
  readonly allowedHosts: readonly string[];

  readonly #apiKey: string;
  readonly #keyFormatValid: boolean;
  readonly #disabled: boolean;
  readonly #debug: boolean;
  readonly #timeoutMs: number;
  readonly #cacheTtl: number;
  readonly #force301: boolean;
  readonly #visitorSecret: string;
  readonly #cache: CacheAdapter;
  readonly #fetch: typeof fetch | undefined;
  readonly #onError: ((error: No404Error) => void) | undefined;
  readonly #logger: Logger | undefined;
  readonly #prefixes: readonly string[];
  readonly #extensions: ReadonlySet<string>;
  readonly #scope: string;
  #warnedKeyFormat = false;
  #lastCacheErrorAt = 0;
  #hmacKey: Promise<CryptoKey | null> | undefined;

  constructor(options: No404Options = {}) {
    const env = options.env ?? readProcessEnv();

    this.#apiKey = (options.apiKey ?? env.NO404_API_KEY ?? "").trim();
    this.#keyFormatValid = API_KEY_PATTERN.test(this.#apiKey);
    this.apiBase = trimTrailingSlashes((options.baseUrl ?? env.NO404_BASE_URL ?? DEFAULT_BASE_URL).trim());
    this.siteUrl = trimTrailingSlashes((options.siteUrl ?? env.NO404_SITE_URL ?? "").trim());
    this.#disabled = options.disabled ?? /^(1|true|yes|on)$/i.test(env.NO404_DISABLED ?? "");
    this.#debug = options.debug ?? /^(1|true|yes|on)$/i.test(env.NO404_DEBUG ?? "");
    this.#timeoutMs = clamp(options.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.#cacheTtl = clamp(options.cacheTtlSeconds, MIN_CACHE_TTL, MAX_CACHE_TTL, DEFAULT_CACHE_TTL);
    this.#force301 = options.force301 ?? false;
    this.#visitorSecret = options.visitorSecret ?? env.NO404_VISITOR_SECRET ?? "";
    this.#cache = options.cache ?? sharedMemoryCache();
    this.#fetch = options.fetch;
    this.#onError = options.onError;
    this.#logger = options.logger;

    const hosts = (options.allowedHosts ?? hostsFor(this.siteUrl))
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host !== "");
    this.allowedHosts = [...new Set(hosts)];

    const prefixes = [...DEFAULT_IGNORED_PREFIXES];
    for (const prefix of options.ignorePrefixes ?? []) {
      const normalised = normalizePath(prefix);
      if (normalised !== "" && normalised !== "/") prefixes.push(normalised);
    }
    this.#prefixes = [...new Set(prefixes.map((prefix) => prefix.toLowerCase()))];

    const extensions = new Set(DEFAULT_IGNORED_EXTENSIONS);
    for (const extension of options.ignoreExtensions ?? []) {
      const normalised = extension.trim().replace(/^\.+/, "").toLowerCase();
      if (/^[a-z0-9]{1,16}$/.test(normalised)) extensions.add(normalised);
    }
    this.#extensions = extensions;

    // Cache entries are scoped to the API key: changing the key drops the old answers.
    this.#scope = `no404:${CACHE_SCHEMA}:${fnv1a32(this.#apiKey)}`;
  }

  /** Is the client operable: a well-formed key, a base URL, not disabled? */
  isConfigured(): boolean {
    return !this.#disabled && this.#keyFormatValid && this.apiBase !== "";
  }

  /**
   * Resolves a 404. Never throws.
   *
   * AD CLICKS: when the URL carries an ad click (gclid, paid utm…), the cache is
   * NOT read — each paid click is counted by no404. If no404 cannot be reached,
   * the cached answer is still used. A click from an AI assistant (ChatGPT,
   * Claude, Perplexity… — `utm_source` or the referrer) is treated the same way.
   */
  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const started = Date.now();
    let result: ResolveResult;
    try {
      result = await this.#resolve(input);
    } catch (error) {
      this.#report({ kind: "internal", message: `unexpected error: ${errorMessage(error)}` });
      result = { decision: "none", reason: "error", cached: false };
    }
    try {
      this.#logger?.debug?.("no404 resolve", {
        path: result.path,
        decision: result.decision,
        reason: result.decision === "none" ? result.reason : undefined,
        status: result.decision === "redirect" ? result.status : undefined,
        cached: result.cached,
        ms: Date.now() - started,
      });
    } catch {
      // A throwing logger must not break the request.
    }
    return result;
  }

  async #resolve(input: ResolveInput): Promise<ResolveResult> {
    if (!this.isConfigured()) {
      this.#warnKeyFormat();
      return { decision: "none", reason: "not-configured", cached: false };
    }

    const method = (input.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return { decision: "none", reason: "method", cached: false };

    const path = normalizePath(input.url);
    if (path === "" || path === "/" || byteLength(path) > MAX_PATH_LENGTH) {
      return { decision: "none", reason: "invalid-path", cached: false };
    }
    if (this.isIgnoredPath(path)) return { decision: "none", reason: "blacklist", cached: false, path };

    const lookup = await this.#lookup(path, input, {
      ad: detectAdCategory(input.url),
      ai: detectAiSource(input.url, input.referrer),
    });
    if (lookup.result === null) return { decision: "none", reason: lookup.reason, cached: false, path };

    const { result, cached } = lookup;
    const { source, score } = result;
    if (result.redirect === null) return { decision: "none", reason: "no-match", cached, path, source, score };

    const url = this.validateTarget(result.redirect, path);
    if (url === "") return { decision: "none", reason: "invalid-target", cached, path, source, score };

    return {
      decision: "redirect",
      url,
      status: this.decideStatus(result),
      source: result.source,
      score: result.score,
      cached,
      path,
    };
  }

  async #lookup(path: string, input: ResolveInput, hints: Hints): Promise<Lookup> {
    const key = `${this.#scope}:${path}`;
    const stored = await this.#cacheGet(key);
    const cached = isLookupResult(stored) ? stored : null;
    // Ad and AI-assistant clicks are counted by no404: the cache is not read for them.
    const counted = hints.ad !== null || hints.ai !== null;
    if (cached !== null && !counted) return { result: cached, cached: true };

    // Circuit breaker: while the API is unreachable or out of quota, do not ask on every 404.
    if ((await this.#cacheGet(this.#breakerKey())) != null) {
      return cached !== null ? { result: cached, cached: true } : { result: null, reason: "circuit-open" };
    }

    const fresh = await this.#fetchOnce(`${this.apiBase}|${key}|${hints.ad ?? ""}|${hints.ai ?? ""}`, async () => {
      const response = await this.#request(
        this.#buildUrl(path, input.referrer, hints),
        this.#timeoutMs,
        await this.#requestHeaders(input.adapter, input.visitor),
      );
      return this.#handleResponse(response, key);
    });
    if (fresh !== null) return { result: fresh, cached: false };

    // An ad or AI click that could not be answered falls back to what we knew.
    return cached !== null ? { result: cached, cached: true } : { result: null, reason: "lookup-failed" };
  }

  /**
   * Concurrent lookups of one path share ONE API call. Measured on Next.js 16:
   * a single request to a not-found page runs the lookup twice, within a
   * millisecond, before either can write the cache. A burst of visitors on one
   * dead link is merged the same way.
   */
  async #fetchOnce(key: string, run: () => Promise<LookupResult | null>): Promise<LookupResult | null> {
    const pending = inFlight();
    let promise = pending.get(key);
    if (promise === undefined) {
      promise = run();
      pending.set(key, promise);
      const settle = () => pending.delete(key);
      void promise.then(settle, settle);
    }
    return promise;
  }

  /** Turns an API response into a result and writes the cache entries it needs. */
  async #handleResponse(response: Transport, key: string): Promise<LookupResult | null> {
    if (!response.ok) {
      await this.#trip(OUTAGE_TTL, "unreachable", 0, "unreachable", `no404 could not be reached (${response.error}); lookups pause for 60 s`);
      return null;
    }

    const { status } = response;
    if (status === 429) {
      await this.#trip(QUOTA_TTL, "rate_limited", status, "rate-limited", "no404 rate limit or monthly quota reached (HTTP 429); lookups pause for 5 minutes");
      return null;
    }
    if (status === 401 || status === 403 || status === 404) {
      await this.#trip(CONFIG_ERROR_TTL, "configuration", status, "configuration", `no404 rejected the request (HTTP ${status}): check the API key, the site's status and the subscription; lookups pause for 5 minutes`);
      return null;
    }
    if (status >= 500) {
      await this.#trip(OUTAGE_TTL, "server_error", status, "server-error", `no404 answered HTTP ${status}; lookups pause for 60 s`);
      return null;
    }
    if (status >= 300 && status < 400) {
      await this.#trip(OUTAGE_TTL, "redirected", status, "redirected", `no404 answered with a redirect to ${originOf(response.location)} — check baseUrl (the canonical host is https://www.no404.tr)`);
      return null;
    }

    const result = status === 200 ? toLookupResult(parseJson(response.body)) : null;
    // Negative results are cached too — this is what actually protects the quota.
    // Including 422 (invalid path): there is no point asking about this PATH again.
    await this.#cacheSet(key, result ?? EMPTY_RESULT, this.#cacheTtl);
    return result;
  }

  /**
   * The redirect's status code.
   *
   * A 301 is cached PERMANENTLY by browsers and by Google; issuing one for a
   * speculative match cannot be undone. Order: `force301` → the API's
   * `redirectStatus` (the 301 threshold the site owner picked in the dashboard)
   * → the local rule, which only applies to API versions that don't send it.
   */
  decideStatus(result: { source: string; score: number; redirectStatus?: number | undefined }): 301 | 302 {
    if (this.#force301) return 301;
    if (result.redirectStatus === 301 || result.redirectStatus === 302) return result.redirectStatus;
    if (result.source === "REDIRECT") return 301; // A human defined it.
    if (result.source === "CATALOG" && result.score >= HIGH_CONFIDENCE_SCORE) return 301;
    return 302; // Low-scoring CATALOG and FALLBACK stay reversible.
  }

  /**
   * Open-redirect and loop protection.
   *
   * @returns a safe target, or "" when it is rejected
   */
  validateTarget(redirect: unknown, currentPath: string): string {
    if (typeof redirect !== "string" || redirect.trim() === "") return "";
    // Header injection: control characters never get through.
    if (CONTROL_CHARS.test(redirect)) return "";

    const target = redirect.trim();
    if (byteLength(target) > MAX_PATH_LENGTH) return "";

    if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      // Relative: our own site. "//evil" is protocol-relative and "/\evil" is read
      // as "//evil" by browsers; anything not starting with "/" is rejected too.
      if (!target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) return "";
      return normalizePath(target) === currentPath ? "" : target;
    }

    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return "";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!this.allowedHosts.includes(url.hostname.toLowerCase())) return "";
    if (normalizePath(url.pathname) === currentPath) return ""; // Loop.
    return target;
  }

  /**
   * Troubleshooting headers for a result — the same names and values as the
   * Laravel package. Empty unless `debug` is on.
   */
  debugHeaders(result: ResolveResult): Record<string, string> {
    if (!this.#debug) return {};
    const skip = result.cached ? "cached" : "none";
    if (result.decision === "redirect") return debugTriple(result.source, result.score, skip);
    switch (result.reason) {
      case "no-match":
        return debugTriple(result.source ?? "NONE", result.score ?? 0, skip);
      case "invalid-target":
        return debugTriple(result.source ?? "NONE", result.score ?? 0, "invalid-target");
      case "circuit-open":
        return { "X-No404-Skip": "circuit" };
      case "lookup-failed":
        return { "X-No404-Skip": "none" };
      default:
        return { "X-No404-Skip": result.reason };
    }
  }

  /** Should this (normalised) path never be looked up? */
  isIgnoredPath(path: string): boolean {
    const lower = path.toLowerCase();
    for (const prefix of this.#prefixes) {
      if (lower === prefix || lower.startsWith(`${prefix}/`)) return true;
    }
    const basename = lower.slice(lower.lastIndexOf("/") + 1);
    const dot = basename.lastIndexOf(".");
    if (dot === -1 || dot === basename.length - 1) return false;
    return this.#extensions.has(basename.slice(dot + 1));
  }

  normalizePath(raw: unknown): string {
    return normalizePath(raw);
  }

  detectAdCategory(rawUrl: string): AdCategory | null {
    return detectAdCategory(rawUrl);
  }

  detectAiSource(rawUrl: string, referrer?: string | null): AiSource | null {
    return detectAiSource(rawUrl, referrer);
  }

  /** The SDK's User-Agent: `no404-node/<version> (<adapter>); <siteUrl>`. */
  userAgent(adapter = "core"): string {
    const name = adapter.replace(/[^a-z0-9-]/gi, "") || "core";
    const site = this.siteUrl.replace(NON_PRINTABLE_ASCII, "");
    return `${USER_AGENT_PREFIX}${VERSION} (${name})${site !== "" ? `; ${site}` : ""}`;
  }

  /**
   * Pseudonymous visitor ID: HMAC-SHA256 of the FULL IP, keyed with a secret only
   * this site knows. no404 can count unique visitors exactly but can neither turn
   * it back into an address nor match a visitor across two sites. The packed
   * address is hashed, so two spellings of one IP give one ID — and the same ID
   * as the WordPress and Laravel integrations. No secret → "".
   */
  async visitorId(ip: unknown): Promise<string> {
    if (this.#visitorSecret === "") return "";
    const parsed = parseIp(ip);
    if (!parsed) return "";
    const key = await this.#hmacKeyFor();
    if (!key) return "";
    const signature = await globalThis.crypto.subtle.sign("HMAC", key, parsed.bytes);
    return toHex(new Uint8Array(signature));
  }

  /**
   * Visitor headers. PRIVACY: the full IP never leaves the site — only its network
   * (/24, /48) and the site-keyed HMAC above. Invalid values are dropped, not sent.
   */
  async visitorHeaders(visitor: Visitor | undefined): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (!visitor) return headers;

    const ip = truncateIp(visitor.ip);
    if (ip !== "") headers["X-No404-Visitor-IP"] = ip;

    const id = await this.visitorId(visitor.ip);
    if (id !== "") headers["X-No404-Visitor-Id"] = id;

    const ua = (visitor.userAgent ?? "").replace(NON_PRINTABLE_ASCII, "").slice(0, MAX_USER_AGENT_LENGTH).trim();
    if (ua !== "") headers["X-No404-Visitor-UA"] = ua;

    // Cloudflare sends "XX" for an unknown country and "T1" for Tor.
    const country = (visitor.country ?? "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(country) && country !== "XX") headers["X-No404-Visitor-Country"] = country;

    return headers;
  }

  /** The open circuit breaker, or null while lookups are allowed. */
  async breakerState(): Promise<BreakerState | null> {
    const state = await this.#cacheGet(this.#breakerKey());
    if (state == null || typeof state !== "object") return null;
    const s = state as Partial<Record<keyof BreakerState, unknown>>;
    return {
      until: typeof s.until === "number" ? s.until : 0,
      status: typeof s.status === "number" ? s.status : 0,
      reason: typeof s.reason === "string" ? s.reason : "unknown",
    };
  }

  /** Closes the circuit breaker (after fixing the key, the plan or the network). */
  async resetBreaker(): Promise<void> {
    const key = this.#breakerKey();
    try {
      if (this.#cache.delete) await this.#cache.delete(key);
      else await this.#cache.set(key, null, 1);
    } catch (error) {
      this.#cacheError(error);
    }
  }

  /**
   * Connection test (the CLI's `resolve` command). Deliberately BYPASSES the
   * cache and the circuit breaker — the user needs the real state. Sends no
   * visitor data.
   */
  async ping(path = "/no404-connection-test"): Promise<PingResult> {
    const out: PingResult = {
      code: "unexpected",
      status: 0,
      found: false,
      redirect: null,
      score: 0,
      source: "NONE",
      detail: "",
    };
    if (this.apiBase === "") return { ...out, code: "no_api_base" };
    if (this.#apiKey === "") return { ...out, code: "no_api_key" };
    if (!this.#keyFormatValid) return { ...out, code: "invalid_key", detail: "The API key has an invalid format." };

    const response = await this.#request(
      this.#buildUrl(normalizePath(path) || "/", null, { ad: null, ai: null }),
      Math.max(PING_TIMEOUT_MS, this.#timeoutMs),
      await this.#requestHeaders("ping", undefined),
    );
    if (!response.ok) return { ...out, code: "unreachable", detail: response.error };

    const { status } = response;
    const payload = parseJson(response.body);
    const message = isRecord(payload) && typeof payload.message === "string" ? payload.message : "";

    if (status >= 300 && status < 400) return { ...out, status, code: "redirected", detail: response.location };

    const result = status === 200 ? toLookupResult(payload) : null;
    if (result) {
      return { code: "ok", status, found: result.found, redirect: result.redirect, score: result.score, source: result.source, detail: message };
    }

    const code: PingResult["code"] =
      status === 401 || status === 404
        ? "invalid_key"
        : status === 403
          ? "forbidden"
          : status === 429
            ? "rate_limited"
            : status === 422
              ? "invalid_path"
              : status >= 500
                ? "server_error"
                : "unexpected";
    return { ...out, status, code, detail: message };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #breakerKey(): string {
    return `${this.#scope}:outage`;
  }

  /**
   * The request URL. The API key is NOT part of it: it travels in the
   * Authorization header — a key in a URL ends up in proxy and CDN logs.
   */
  #buildUrl(path: string, referrer: string | null | undefined, hints: Hints): string {
    let query = `path=${encodeURIComponent(path)}`;
    const ref = (referrer ?? "").trim();
    if (ref !== "") query += `&ref=${encodeURIComponent(ref.slice(0, MAX_PATH_LENGTH))}`;
    if (hints.ad !== null) query += `&ad=${hints.ad}`;
    if (hints.ai !== null) query += `&src=${hints.ai}`;
    return `${this.apiBase}/api/v1/resolve?${query}`;
  }

  async #requestHeaders(adapter: string | undefined, visitor: Visitor | undefined): Promise<Record<string, string>> {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${this.#apiKey}`,
      "User-Agent": this.userAgent(adapter),
      ...(await this.visitorHeaders(visitor)),
    };
  }

  async #request(url: string, timeoutMs: number, headers: Record<string, string>): Promise<Transport> {
    // Called through a closure: Workers reject an unbound `fetch` ("Illegal invocation").
    const fetchFn = this.#fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    try {
      const response = await fetchFn(url, {
        method: "GET",
        headers,
        // A 3xx means a wrong base URL; report it rather than follow it.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text();
      return { ok: true, status: response.status, body, location: response.headers.get("location") ?? "" };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async #trip(ttl: number, reason: string, status: number, kind: No404ErrorKind, message: string): Promise<void> {
    const state: BreakerState = { until: Math.floor(Date.now() / 1000) + ttl, status, reason };
    await this.#cacheSet(this.#breakerKey(), state, ttl);
    this.#report({ kind, message, status: status === 0 ? undefined : status });
  }

  async #hmacKeyFor(): Promise<CryptoKey | null> {
    this.#hmacKey ??= (async () => {
      const subtle = globalThis.crypto?.subtle;
      if (!subtle) return null;
      try {
        return await subtle.importKey(
          "raw",
          new TextEncoder().encode(this.#visitorSecret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
      } catch {
        return null;
      }
    })();
    return this.#hmacKey;
  }

  async #cacheGet(key: string): Promise<unknown> {
    try {
      return await this.#cache.get(key);
    } catch (error) {
      this.#cacheError(error);
      return undefined;
    }
  }

  async #cacheSet(key: string, value: unknown, ttl: number): Promise<void> {
    try {
      await this.#cache.set(key, value, ttl);
    } catch (error) {
      this.#cacheError(error);
    }
  }

  #cacheError(error: unknown): void {
    const now = Date.now();
    if (now - this.#lastCacheErrorAt < CACHE_ERROR_INTERVAL_MS) return;
    this.#lastCacheErrorAt = now;
    this.#report({ kind: "cache", message: `the cache is not working (${errorMessage(error)}); every 404 now asks no404` });
  }

  #warnKeyFormat(): void {
    if (this.#warnedKeyFormat || this.#disabled || this.#apiKey === "" || this.#keyFormatValid) return;
    this.#warnedKeyFormat = true;
    this.#report({ kind: "invalid-key-format", message: "the API key has an invalid format; no lookups are made (copy it again from the no404 dashboard)" });
  }

  #report(error: No404Error): void {
    try {
      if (this.#onError) this.#onError(error);
      else if (this.#logger?.warn) this.#logger.warn(`no404: ${error.message}`, { kind: error.kind, status: error.status });
      else console.warn(`[no404] ${error.message}`);
    } catch {
      // Reporting must never break the request.
    }
  }
}

/** Creates a client. Build it ONCE per process (module scope) and share it. */
export function createNo404(options: No404Options = {}): No404Client {
  return new No404Client(options);
}

// ── helpers ─────────────────────────────────────────────────────────────────

const IN_FLIGHT = Symbol.for("@no404/node:in-flight");

/** Lookups on the wire, per process: client copies loaded by separate bundles share it too. */
function inFlight(): Map<string, Promise<LookupResult | null>> {
  const store = globalThis as unknown as Record<symbol, Map<string, Promise<LookupResult | null>> | undefined>;
  return (store[IN_FLIGHT] ??= new Map<string, Promise<LookupResult | null>>());
}

function readProcessEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env ?? {};
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** The siteUrl host and its www / non-www twin. */
function hostsFor(siteUrl: string): string[] {
  if (siteUrl === "") return [];
  try {
    const host = new URL(siteUrl).hostname.toLowerCase();
    if (host === "") return [];
    return [host, host.startsWith("www.") ? host.slice(4) : `www.${host}`];
  } catch {
    return [];
  }
}

function originOf(location: string): string {
  try {
    return new URL(location).origin;
  } catch {
    return "another address";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A malformed body never turns into an exception. */
function parseJson(body: string): unknown {
  if (body === "") return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** Validates an API payload and copies only the known fields. */
function toLookupResult(payload: unknown): LookupResult | null {
  if (!isRecord(payload) || !payload.success) return null;
  const score =
    typeof payload.score === "number" ? payload.score : typeof payload.score === "string" ? Number(payload.score) : 0;
  const redirectStatus = Number(payload.redirectStatus);
  return {
    found: Boolean(payload.found),
    redirect: typeof payload.redirect === "string" ? payload.redirect : null,
    score: Number.isFinite(score) ? score : 0,
    source: typeof payload.source === "string" && SOURCE_SET.has(payload.source) ? (payload.source as MatchSource) : "NONE",
    redirectStatus: redirectStatus === 301 || redirectStatus === 302 ? redirectStatus : 0,
  };
}

/** A cached value must have the exact shape we write; anything else is ignored. */
function isLookupResult(value: unknown): value is LookupResult {
  return (
    isRecord(value) &&
    typeof value.found === "boolean" &&
    (value.redirect === null || typeof value.redirect === "string") &&
    typeof value.score === "number" &&
    typeof value.source === "string" &&
    SOURCE_SET.has(value.source) &&
    (value.redirectStatus === 0 || value.redirectStatus === 301 || value.redirectStatus === 302)
  );
}

function debugTriple(source: string, score: number, skip: string): Record<string, string> {
  return { "X-No404-Source": source, "X-No404-Score": score.toFixed(3), "X-No404-Skip": skip };
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
