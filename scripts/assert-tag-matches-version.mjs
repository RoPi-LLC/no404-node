// Publish guard: the pushed tag (v1.2.3) must equal package.json's version,
// otherwise npm would receive a version nobody tagged.
import { readFileSync } from "node:fs";

const tag = process.env.GITHUB_REF_NAME ?? "";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

if (tag !== `v${version}`) {
  console.error(`✗ tag "${tag}" does not match package.json version "${version}" (expected "v${version}")`);
  process.exit(1);
}
console.log(`✓ tag ${tag} matches package.json`);
