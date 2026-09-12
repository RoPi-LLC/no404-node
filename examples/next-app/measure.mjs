// Measures what the App Router adapter really sends over HTTP (plan §5.5.4).
// Starts the fake no404 API and `next start`, requests a few paths without
// following redirects, prints the results and stops both.
//   pnpm build && node measure.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const API = "http://127.0.0.1:4404";
const SITE = "http://127.0.0.1:3100";

const children = [
  spawn(process.execPath, [fileURLToPath(new URL("../fake-api.mjs", import.meta.url))], { stdio: "ignore" }),
  spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3100", "-H", "127.0.0.1"], {
    cwd: here,
    stdio: "ignore",
    env: { ...process.env, NO404_BASE_URL: API },
  }),
];

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`${url} did not start`);
}

const cases = [
  ["/", 200, null],
  ["/old-product", 308, "/new-product"],
  ["/old-product", 308, "/new-product"], // second time: from the cache
  ["/temporary", 307, "/new-product"],
  ["/product/deleted", 308, "/product/ring"],
  ["/nothing-here", 404, null],
  ["/product/unknown", 404, null],
];

let failed = 0;
try {
  await waitFor(`${API}/__count`);
  await waitFor(SITE);
  for (const [path, status, location] of cases) {
    const res = await fetch(`${SITE}${path}`, { redirect: "manual" });
    const body = await res.text();
    const got = res.headers.get("location");
    const metaRefresh = /http-equiv="refresh"/i.test(body);
    const ok = res.status === status && (location === null || got === location) && !metaRefresh;
    if (!ok) failed++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${path.padEnd(18)} ${res.status}${got ? ` → ${got}` : ""}${metaRefresh ? "  (meta refresh!)" : ""}` +
        `  expected ${status}${location ? ` → ${location}` : ""}`,
    );
  }
  const calls = Number(await (await fetch(`${API}/__count`)).text());
  // 4 distinct looked-up paths (old-product, temporary, product/deleted, nothing-here, product/unknown = 5)
  console.log(`${calls === 5 ? "PASS" : "FAIL"}  API calls: ${calls} (expected 5 — the repeated path came from the cache)`);
  if (calls !== 5) failed++;
  if (process.argv.includes("--log")) console.log(await (await fetch(`${API}/__log`)).text());
} finally {
  for (const child of children) child.kill();
}
process.exitCode = failed > 0 ? 1 : 0;
