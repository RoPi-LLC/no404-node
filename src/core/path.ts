const encoder = new TextEncoder();

/** Length in bytes, as the API (and PHP's strlen in the other integrations) counts it. */
export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Brings a path into canonical form.
 *
 * Applies the SAME rules as the no404 server's `cleanPath` (and the WordPress /
 * Laravel integrations), so the local cache key and the path the server sees
 * line up. The query string is discarded — the server only takes the pathname,
 * and keeping `?utm_source=…` would fragment the cache and burn quota.
 *
 * @returns a path starting with "/", or "" for empty input
 */
export function normalizePath(raw: unknown): string {
  let value = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
  value = value.replace(/[\r\n\t\0]/g, "").trim();
  if (value === "") return "";

  // A full URL: keep only its path.
  if (/^https?:\/\//i.test(value)) {
    value = value.replace(/^https?:\/\/[^/?#\\]*/i, "");
  }

  // Drop the query string and the fragment.
  value = value.split(/[?#]/, 1)[0] ?? "";

  // A backslash is a slash (the WHATWG URL spec does the same for http(s)).
  value = value.replace(/\\/g, "/");

  if (value === "") return "/";
  if (!value.startsWith("/")) value = `/${value}`;

  value = value.replace(/\/{2,}/g, "/");
  if (value.length > 1) value = value.replace(/\/+$/, "");

  return value === "" ? "/" : value;
}
