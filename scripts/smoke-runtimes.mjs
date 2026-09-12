// Runs the BUILT core and the Hono adapter on whichever runtime executes this
// file — Node, Bun or Deno — with a fake API: the "Web APIs only" promise,
// measured rather than claimed. CI runs it on all three.
//   node scripts/smoke-runtimes.mjs · bun scripts/smoke-runtimes.mjs · deno run scripts/smoke-runtimes.mjs
import { Hono } from "hono";
import { createNo404, MemoryCache } from "../dist/index.js";
import { no404Hono } from "../dist/hono.js";

const runtime =
  typeof globalThis.Bun !== "undefined"
    ? `bun ${globalThis.Bun.version}`
    : typeof globalThis.Deno !== "undefined"
      ? `deno ${globalThis.Deno.version.deno}`
      : `node ${globalThis.process?.version ?? "?"}`;

let calls = 0;
const fakeApi = async () => {
  calls++;
  return new Response(
    JSON.stringify({ success: true, found: true, redirect: "/new", score: 0.9, source: "CATALOG", redirectStatus: 301 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

const client = createNo404({
  apiKey: "smoketest123",
  siteUrl: "https://shop.example",
  visitorSecret: "smoke-secret",
  fetch: fakeApi,
  cache: new MemoryCache(),
  env: {},
});
const app = new Hono();
app.notFound(no404Hono(client));

const first = await app.request("/old", { headers: { "cf-connecting-ip": "85.34.78.12" } });
const second = await app.request("/old");
const id = await client.visitorId("85.34.78.211");

const failures = [];
if (first.status !== 301 || first.headers.get("location") !== "/new") failures.push(`redirect: ${first.status}`);
if (second.status !== 301) failures.push("cached redirect");
if (calls !== 1) failures.push(`API calls: ${calls}, expected 1`);
if (!/^[a-f0-9]{64}$/.test(id)) failures.push("visitor ID (Web Crypto)");

if (failures.length > 0) throw new Error(`${runtime}: ${failures.join(", ")}`);
console.log(`✓ ${runtime}: redirect, cache and Web Crypto visitor ID work`);
