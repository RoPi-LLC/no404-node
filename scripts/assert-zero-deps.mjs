// Guards two promises the package makes:
//   1. zero runtime dependencies (`dependencies` is empty);
//   2. the core and the adapters run on Web APIs only — no `node:` import may
//      reach anything in dist/ except the CLI (Cloudflare Workers, Deno, Bun).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const failures = [];

if (Object.keys(pkg.dependencies ?? {}).length > 0) {
  failures.push(`dependencies must be empty, found: ${Object.keys(pkg.dependencies).join(", ")}`);
}

const nodeImport = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']node:/;
for (const file of readdirSync("dist")) {
  if (!/\.(c|m)?js$/.test(file) || file.startsWith("cli.")) continue;
  const source = readFileSync(join("dist", file), "utf8");
  if (nodeImport.test(source)) failures.push(`dist/${file} imports a node: builtin`);
}

if (failures.length > 0) {
  console.error(failures.map((line) => `✗ ${line}`).join("\n"));
  process.exit(1);
}
console.log("✓ zero runtime dependencies, no node: builtins outside the CLI");
