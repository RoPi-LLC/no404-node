import { notFoundOrRedirect } from "@no404/node/next";
import { no404 } from "../../../lib/no404.js";

const PRODUCTS = new Set(["ring"]);

export default async function Product({ params }) {
  const { slug } = await params;
  // A deleted product: redirect when no404 has a match, otherwise notFound().
  if (!PRODUCTS.has(slug)) await notFoundOrRedirect(no404, `/product/${slug}`);
  return <h1>Product: {slug}</h1>;
}
