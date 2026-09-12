#!/usr/bin/env node
/**
 * `npx @no404/node <command>` — installation checks. Node only (the core and
 * the adapters never import `node:` modules; this file may).
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createNo404 } from "./core/client.js";
import { API_KEY_PATTERN, REDIRECT_BY } from "./core/constants.js";
import { VERSION } from "./version.js";

const HELP = `no404 ${VERSION} — @no404/node

Usage:
  no404 check <url> [--expect 301|302] [--random]
      Requests <url> WITHOUT following redirects and reports the status code,
      Location and X-Redirect-By. --random asks a made-up path on that site
      (/no404-test-<hex>). --expect sets the exit code (Next.js App Router's
      308/307 count as 301/302).

  no404 resolve [path]
      Asks the no404 API about [path] with NO404_API_KEY, bypassing the cache.
      Tells you whether the key, the site and the subscription work.
      Each call counts as one lookup in your monthly quota.

  no404 doctor
      Checks Node, the NO404_* environment variables and this project.

Environment: NO404_API_KEY, NO404_SITE_URL, NO404_VISITOR_SECRET, NO404_BASE_URL.
`;

const PERMANENT = new Set([301, 308]);
const TEMPORARY = new Set([302, 307]);

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      expect: { type: "string" },
      random: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const [command, argument] = positionals;
  if (values.help || command === undefined) {
    console.log(HELP);
    return command === undefined && !values.help ? 1 : 0;
  }

  switch (command) {
    case "check":
      if (!argument) {
        console.error("✗ usage: no404 check <url>");
        return 2;
      }
      return check(argument, values.expect, values.random);
    case "resolve":
      return resolve(argument);
    case "doctor":
      return doctor();
    default:
      console.error(`✗ unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

async function check(target: string, expect: string | undefined, random: boolean): Promise<number> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    console.error(`✗ not a URL: ${target} (include https://)`);
    return 2;
  }
  if (random) url = new URL(`/no404-test-${randomBytes(4).toString("hex")}`, url);

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": `no404-node-cli/${VERSION}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error(`✗ ${url.href} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const status = response.status;
  const location = response.headers.get("location") ?? "";
  const by = response.headers.get("x-redirect-by") ?? "";
  console.log(`URL             ${url.href}`);
  console.log(`Status          ${status}`);
  if (location !== "") console.log(`Location        ${location}`);
  if (by !== "") console.log(`X-Redirect-By   ${by}`);
  console.log("");

  if (status >= 300 && status < 400) {
    if (by.toLowerCase() === REDIRECT_BY) {
      console.log(`✓ no404 redirected this address (${PERMANENT.has(status) ? "permanent" : "temporary"}).`);
    } else if (status === 307 || status === 308) {
      console.log("• A redirect without X-Redirect-By: no404. That is expected on the Next.js App Router,");
      console.log("  which cannot set the header — or another rule on the site answered first.");
    } else {
      console.log("• A redirect, but not from no404 (no X-Redirect-By: no404). Another rule answered first.");
    }
  } else if (status === 404) {
    console.log("• 404 — no redirect. Either no404 has no match for this path (expected for a --random");
    console.log("  path), the SDK is not installed at the 404 point, or no404 could not be reached.");
  } else if (status === 200) {
    console.log("• 200 — the address answered normally. If this path should not exist, the site");
    console.log("  serves a soft 404 and the SDK never sees it.");
  } else {
    console.log(`• HTTP ${status}.`);
  }
  if (by.toLowerCase() === REDIRECT_BY || status === 404) {
    console.log("\nIf the SDK looked this path up, it counts as one lookup in your no404 quota.");
  }

  if (expect === undefined) return 0;
  const wanted = Number(expect);
  const ok =
    status === wanted ||
    (PERMANENT.has(wanted) && PERMANENT.has(status)) ||
    (TEMPORARY.has(wanted) && TEMPORARY.has(status));
  console.log(ok ? `✓ matches --expect ${expect}` : `✗ expected ${expect}, got ${status}`);
  return ok ? 0 : 1;
}

async function resolve(path: string | undefined): Promise<number> {
  const client = createNo404({ onError: () => undefined });
  const result = await client.ping(path ?? "/no404-connection-test");
  const messages: Record<string, string> = {
    ok: "✓ Connected. The key, the site and the subscription work.",
    no_api_base: "✗ NO404_BASE_URL is empty.",
    no_api_key: "✗ NO404_API_KEY is not set.",
    invalid_key: "✗ no404 does not know this API key (copy it again from the site's Integration tab).",
    forbidden: "✗ The site is paused or the subscription is not active.",
    rate_limited: "✗ Rate limit or monthly quota reached.",
    invalid_path: "✗ no404 rejected the path.",
    redirected: "✗ no404 answered with a redirect: NO404_BASE_URL is wrong (use https://www.no404.tr).",
    unreachable: "✗ no404 could not be reached.",
    server_error: "✗ no404 had a server error; try again in a minute.",
    unexpected: "✗ Unexpected response.",
  };
  console.log(messages[result.code] ?? result.code);
  if (result.status !== 0) console.log(`HTTP            ${result.status}`);
  if (result.code === "ok") {
    console.log(`Match           ${result.found ? `${result.source} (score ${result.score.toFixed(2)})` : "none"}`);
    if (result.redirect) console.log(`Target          ${result.redirect}`);
  } else if (result.code === "redirected") {
    console.log(`Location        ${originOf(result.detail)}`);
  } else if (result.detail !== "") {
    console.log(`Detail          ${result.detail}`);
  }
  return result.code === "ok" ? 0 : 1;
}

function doctor(): number {
  let failed = false;
  const ok = (message: string) => console.log(`✓ ${message}`);
  const warn = (message: string) => console.log(`• ${message}`);
  const fail = (message: string) => {
    failed = true;
    console.log(`✗ ${message}`);
  };

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 12)) ok(`Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node} — @no404/node needs 22.12 or newer`);

  if (typeof fetch === "function") ok("fetch is available");
  else fail("fetch is not available");
  if (globalThis.crypto?.subtle) ok("Web Crypto is available (visitor ID)");
  else warn("Web Crypto is missing: the visitor ID will not be sent");

  const key = process.env.NO404_API_KEY ?? "";
  if (key === "") fail("NO404_API_KEY is not set — copy it from the site's Integration tab in the no404 dashboard");
  else if (!API_KEY_PATTERN.test(key.trim())) fail("NO404_API_KEY has an invalid format");
  else ok("NO404_API_KEY is set");

  const leaked = Object.keys(process.env).filter(
    (name) => /^(NEXT_PUBLIC_|VITE_|PUBLIC_|NUXT_PUBLIC_|EXPO_PUBLIC_|REACT_APP_)/.test(name) &&
      (/NO404/i.test(name) || (key !== "" && process.env[name] === key)),
  );
  if (leaked.length > 0) fail(`${leaked.join(", ")} would ship the no404 key to the browser — keep it server-side only`);

  const siteUrl = process.env.NO404_SITE_URL ?? "";
  if (siteUrl === "") warn("NO404_SITE_URL is not set — pass siteUrl to createNo404(), or only relative targets are allowed");
  else ok(`NO404_SITE_URL = ${siteUrl}`);

  if ((process.env.NO404_VISITOR_SECRET ?? "") === "") {
    warn("NO404_VISITOR_SECRET is not set — unique visitors are counted by network only (generate one: openssl rand -hex 32)");
  } else {
    ok("NO404_VISITOR_SECRET is set");
  }

  const packagePath = join(process.cwd(), "package.json");
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const hints: Array<[string, string]> = [
        ["next", "Next.js → @no404/node/next (not-found.tsx) + @no404/node/next/proxy (proxy.ts)"],
        ["express", "Express → @no404/node/express, after your routes"],
        ["fastify", "Fastify → @no404/node/fastify, setNotFoundHandler"],
        ["hono", "Hono → @no404/node/hono, app.notFound on the top-level app"],
      ];
      const found = hints.filter(([name]) => name in deps);
      if (found.length === 0) warn("No supported framework in package.json (Express, Fastify, Hono, Next.js)");
      for (const [, hint] of found) ok(hint);

      if ("next" in deps) {
        for (const file of ["next.config.ts", "next.config.mjs", "next.config.js"]) {
          const path = join(process.cwd(), file);
          if (existsSync(path) && /output\s*:\s*["']export["']/.test(readFileSync(path, "utf8"))) {
            fail(`${file} uses output: "export" — a static export has no server, the SDK cannot run`);
          }
        }
      }
    } catch {
      warn("package.json could not be read");
    }
  } else {
    warn("No package.json in this folder — run doctor from your project root");
  }

  return failed ? 1 : 0;
}

function originOf(location: string): string {
  try {
    return new URL(location).origin;
  } catch {
    return location === "" ? "(none)" : "(invalid)";
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);
