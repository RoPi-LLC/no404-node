import { PAID_MEDIUMS, type AdCategory } from "./constants.js";

/**
 * Works out whether a request came from an ad click, from its RAW URL (query
 * string included). Returns only the CATEGORY — google, microsoft, meta, other —
 * or null for organic traffic. The raw click ID (gclid, msclkid…) never leaves
 * the site. Mirrors the no404 server's rules: `fbclid` alone is NOT an ad,
 * because Facebook adds it to organic shares too.
 */
export function detectAdCategory(rawUrl: string): AdCategory | null {
  const q = rawUrl.indexOf("?");
  if (q === -1) return null;

  let query = rawUrl.slice(q + 1);
  const hash = query.indexOf("#");
  if (hash !== -1) query = query.slice(0, hash);

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return null;
  }
  // PHP's parse_str keeps the LAST duplicate; so do we.
  const value = (key: string): string => {
    const all = params.getAll(key);
    return (all[all.length - 1] ?? "").trim().toLowerCase();
  };

  for (const key of ["gclid", "gbraid", "wbraid", "gclsrc"]) {
    if (value(key) !== "") return "google";
  }
  if (value("msclkid") !== "") return "microsoft";
  if (PAID_MEDIUMS.has(value("utm_medium"))) return categoryForSource(value("utm_source"));
  for (const key of ["ttclid", "twclid", "li_fat_id"]) {
    if (value(key) !== "") return "other";
  }
  return null;
}

/**
 * The ad network of a click already known to be paid, from `utm_source`.
 * Meta's `{{site_source_name}}` yields fb, ig, an or msg — all four are Meta.
 */
function categoryForSource(source: string): AdCategory {
  if (/google|adwords/.test(source)) return "google";
  if (/bing|microsoft/.test(source)) return "microsoft";
  if (/facebook|instagram|meta|messenger|audience_network|threads|^(fb|ig|an|msg)$/.test(source)) {
    return "meta";
  }
  return "other";
}
