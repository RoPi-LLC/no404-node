// A stand-in for the no404 API, for the example apps: answers a few paths and
// counts the requests (GET /__count). Never used by the package itself.
//   node examples/fake-api.mjs      → http://127.0.0.1:4404
import { createServer } from "node:http";

const MATCHES = {
  "/old-product": { redirect: "/new-product", redirectStatus: 301 },
  "/temporary": { redirect: "/new-product", redirectStatus: 302 },
  "/product/deleted": { redirect: "/product/ring", redirectStatus: 301 },
};

let count = 0;
const log = [];
const port = Number(process.env.PORT ?? 4404);

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/__count") {
    res.end(String(count));
    return;
  }
  if (url.pathname === "/__log") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(log));
    return;
  }
  count++;
  log.push({ path: url.searchParams.get("path"), userAgent: req.headers["user-agent"], at: Date.now() });
  const match = MATCHES[url.searchParams.get("path") ?? ""];
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify(
      match
        ? { success: true, found: true, score: 0.9, source: "CATALOG", ...match }
        : { success: true, found: false, redirect: null, score: 0, source: "NONE" },
    ),
  );
}).listen(port, "127.0.0.1", () => console.log(`fake no404 API on http://127.0.0.1:${port}`));
