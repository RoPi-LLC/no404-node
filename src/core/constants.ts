/**
 * The behaviour contract shared by every no404 integration. Values mirror the
 * WordPress plugin's `No404_Client` (1.0.3) and the Laravel package, so a site
 * behaves the same whichever integration it runs.
 */

/** Cache schema version — bump it when the cached shape changes; old entries are skipped. */
export const CACHE_SCHEMA = "v1";

/** Ad categories the no404 API accepts in `ad=` (it drops anything else). */
export const AD_CATEGORIES = ["google", "microsoft", "meta", "other"] as const;
export type AdCategory = (typeof AD_CATEGORIES)[number];

/** AI-assistant categories the no404 API accepts in `src=` (it drops anything else). */
export const AI_SOURCES = ["chatgpt", "claude", "perplexity", "gemini", "copilot", "meta", "other"] as const;
export type AiSource = (typeof AI_SOURCES)[number];

/** `utm_medium` values that mark paid traffic (lower case) — same list as the server. */
export const PAID_MEDIUMS: ReadonlySet<string> = new Set([
  "cpc",
  "ppc",
  "paid",
  "paidsearch",
  "paid_search",
  "paid-search",
  "paidsocial",
  "paid_social",
  "paid-social",
  "display",
  "cpm",
  "cpv",
  "banner",
  "retargeting",
  "remarketing",
]);

/** Where a match came from, as the API reports it. */
export const MATCH_SOURCES = ["REDIRECT", "CATALOG", "FALLBACK", "NONE"] as const;

/** CATALOG matches at or above this score count as permanent (301) when the API does not say. */
export const HIGH_CONFIDENCE_SCORE = 0.5;

/** Timeout of a lookup (ms). Short enough not to hold up the 404 page; never above 1500. */
export const DEFAULT_TIMEOUT_MS = 1500;
export const MIN_TIMEOUT_MS = 200;
export const MAX_TIMEOUT_MS = 1500;
/** The connection test (`ping`) may wait longer: the user is watching it. */
export const PING_TIMEOUT_MS = 5000;

/** Lifetime of a cached result, negatives included (seconds). */
export const DEFAULT_CACHE_TTL = 3600;
export const MIN_CACHE_TTL = 60;
export const MAX_CACHE_TTL = 604_800;

/** Circuit breaker: API unreachable, 5xx or redirected (seconds). */
export const OUTAGE_TTL = 60;
/** Circuit breaker: rate limit or monthly quota (seconds). */
export const QUOTA_TTL = 300;
/** Circuit breaker: invalid key, paused site, inactive subscription (seconds). */
export const CONFIG_ERROR_TTL = 300;

/** Longest path the API accepts (bytes). */
export const MAX_PATH_LENGTH = 2048;
/** Longest visitor User-Agent the API keeps. */
export const MAX_USER_AGENT_LENGTH = 512;

/** The API's canonical host. `no404.tr` without www answers with a redirect. */
export const DEFAULT_BASE_URL = "https://www.no404.tr";

/** Same set as the server's `RESOLVE_API.keyPattern`; anything else is never sent. */
export const API_KEY_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;

/** Extensions with no catalogue counterpart: asking about them only burns quota. */
export const DEFAULT_IGNORED_EXTENSIONS: readonly string[] = [
  "css", "js", "mjs", "cjs", "map", "json", "xml", "txt", "php", "asp", "aspx",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "tiff",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "webm", "ogg", "wav", "avi", "mov",
  "pdf", "zip", "gz", "tar", "rar", "doc", "docx", "xls", "xlsx", "csv",
  "env", "sql", "bak", "log", "yml", "yaml", "ini",
];

/** Path prefixes never asked about. Adapters add their framework's own. */
export const DEFAULT_IGNORED_PREFIXES: readonly string[] = ["/.well-known", "/cgi-bin"];

/** Prefix of the SDK's User-Agent; the no404 dashboard recognises the integration by it. */
export const USER_AGENT_PREFIX = "no404-node/";

/** Value of the `X-Redirect-By` header on every redirect the SDK issues. */
export const REDIRECT_BY = "no404";
