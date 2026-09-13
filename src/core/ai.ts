import type { AiSource } from "./constants.js";

/**
 * `utm_source` value → assistant (lower case, EXACT match). ChatGPT appends
 * `utm_source=chatgpt.com` to outbound links; the others are known values.
 * An allow-list on purpose: not every value containing "chat" is an assistant
 * (`utm_source=chatbot-campaign`). A Map, so `constructor` / `__proto__` never match.
 */
const UTM_SOURCES: ReadonlyMap<string, AiSource> = new Map<string, AiSource>([
  ["chatgpt.com", "chatgpt"],
  ["chatgpt", "chatgpt"],
  ["openai", "chatgpt"],
  ["openai.com", "chatgpt"],
  ["claude.ai", "claude"],
  ["claude", "claude"],
  ["perplexity", "perplexity"],
  ["perplexity.ai", "perplexity"],
  ["gemini", "gemini"],
  ["gemini.google.com", "gemini"],
  ["copilot", "copilot"],
  ["copilot.com", "copilot"],
  ["copilot.microsoft.com", "copilot"],
  ["meta.ai", "meta"],
  ["deepseek", "other"],
  ["grok", "other"],
  ["grok.com", "other"],
  ["mistral", "other"],
  ["you.com", "other"],
]);

/**
 * Referrer host → assistant. Matches the domain itself or any subdomain of it
 * (after one leading `www.` / `m.` is stripped). Chat products only:
 * `google.com` is search, `gemini.google.com` is an assistant.
 */
const REFERRER_HOSTS: readonly (readonly [string, AiSource])[] = [
  ["chatgpt.com", "chatgpt"],
  ["chat.openai.com", "chatgpt"],
  ["claude.ai", "claude"],
  ["perplexity.ai", "perplexity"],
  ["perplexity.com", "perplexity"],
  ["gemini.google.com", "gemini"],
  ["bard.google.com", "gemini"],
  ["copilot.microsoft.com", "copilot"],
  ["copilot.cloud.microsoft", "copilot"],
  ["meta.ai", "meta"],
  ["chat.deepseek.com", "other"],
  ["grok.com", "other"],
  ["chat.mistral.ai", "other"],
  ["you.com", "other"],
  ["poe.com", "other"],
  ["phind.com", "other"],
];

/**
 * Works out whether the visitor clicked through from an AI assistant (ChatGPT,
 * Claude, Perplexity…). Returns only the CATEGORY, or null. Mirrors the no404
 * server's rules (`src=` hint). Two pieces of evidence, first match wins:
 *
 *  1. `utm_source` in the RAW URL — ChatGPT often sends no referrer, so this is
 *     frequently the only sign. The query string itself never leaves the site.
 *  2. The referrer's host.
 */
export function detectAiSource(rawUrl: string, referrer?: string | null): AiSource | null {
  const fromUtm = sourceForUtm(rawUrl);
  if (fromUtm !== null) return fromUtm;
  const host = referrerHost(referrer ?? "");
  return host === null ? null : sourceForHost(host);
}

function sourceForUtm(rawUrl: string): AiSource | null {
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
  // Last duplicate wins, as in detectAdCategory.
  const all = params.getAll("utm_source");
  const value = (all[all.length - 1] ?? "").trim().toLowerCase();
  return value === "" ? null : (UTM_SOURCES.get(value) ?? null);
}

function referrerHost(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;
  // A schemeless value (`chatgpt.com/c/1`) is tried again as https.
  for (const candidate of [text, `https://${text}`]) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname === "" ? null : normalizeHost(url.hostname);
  }
  return null;
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").replace(/^(www|m)\./, "");
}

function sourceForHost(host: string): AiSource | null {
  for (const [domain, source] of REFERRER_HOSTS) {
    if (host === domain || host.endsWith(`.${domain}`)) return source;
  }
  return null;
}
