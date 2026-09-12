# Changelog

All notable changes to `@no404/node` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- First release: server-side 301/302 redirects for your application's 404s,
  matched against your live catalogue by no404.
- Framework-independent core on Web APIs only (fetch, URL, AbortSignal, Web Crypto):
  path normalisation, blacklist, cache with negative results, circuit breaker,
  1.5 s timeout, open-redirect and loop protection, the API's `redirectStatus`.
- Adapters: Express 4/5, Fastify 5, Hono 4, Next.js 15/16 (App Router and Pages Router).
- Shared caches: Redis (ioredis, node-redis, Upstash) and Cloudflare Workers KV.
- Visitor forwarding: truncated IP (/24, /48), site-keyed HMAC visitor ID, user agent, CDN country.
- Ad-click category (`ad=`) detected locally; the query string is never sent.
- Concurrent lookups of one path share a single API call, process-wide (Next.js 16 runs a
  not-found lookup twice per request); the default in-memory cache is process-wide too.
- Debug headers (`debug: true` / `NO404_DEBUG=1`): `X-No404-Source`, `X-No404-Score`,
  `X-No404-Skip`, with the Laravel package's values.
- CLI: `npx @no404/node check | resolve | doctor`.
- CI: Node 22 / 24 / 26, ESLint, package checks (publint, arethetypeswrong, zero dependencies),
  Bun and Deno smoke tests of the built package, the CLI on Windows.

[Unreleased]: https://github.com/RoPi-LLC/no404-node/commits/main
