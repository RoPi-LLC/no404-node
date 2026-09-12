import { createNo404 } from "@no404/node";

// Created once per process and shared. In a real app the key comes from
// NO404_API_KEY and baseUrl is left at its default (https://www.no404.tr).
export const no404 = createNo404({
  siteUrl: "http://localhost:3100",
  apiKey: process.env.NO404_API_KEY ?? "example_key_123",
  baseUrl: process.env.NO404_BASE_URL ?? "http://127.0.0.1:4404",
});
