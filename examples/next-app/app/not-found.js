import { resolveNotFound } from "@no404/node/next";
import { no404 } from "../lib/no404.js";

// Every unmatched URL and every notFound() lands here. A match redirects
// (308 / 307); otherwise the page below renders with a real 404.
export default async function NotFound() {
  await resolveNotFound(no404);
  return <h1>Not found</h1>;
}
