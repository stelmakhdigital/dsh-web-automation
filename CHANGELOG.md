# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **SSRF guard** (`fetch/ssrf.ts`): blocks requests to loopback, private, link-local,
  and otherwise reserved network targets in `web_fetch`. Checked on the literal host
  and after DNS resolution (anti-rebinding). Configurable via `fetch.allowPrivateNetworks`.
- **LRU cache eviction**: `last_accessed_at` on `web_searches`/`web_pages` (schema v2 +
  migration), updated on every read/write. `store.evict()` keeps the most-recently-accessed
  entries (`fetch.cacheMaxPages=500`, `search.cacheMaxSearches=1000` defaults).
- **Tests**: vitest suite (37 tests) covering the SSRF guard (IP literals, protocol block,
  DNS rebinding, `allowPrivate` bypass) and the store (CRUD, LRU eviction, stats, clear).
- `vitest` devDependency + `test` / `test:watch` scripts.

### Changed
- Store schema bumped to v2 (`last_accessed_at` column + migration for existing DBs).
- `WebStoreOptions` gained `evictLimits` (per-table LRU caps).
- Fetch config gained `cacheMaxPages` + `allowPrivateNetworks`.
- Search config gained `cacheMaxSearches`.

## [0.1.0] - 2026-01-01

### Added
- Initial release.
- Multi-engine keyless search (DuckDuckGo/Bing + optional Exa/DeepSeek/Jina).
- SQLite-cached fetch provider (ETag/Last-Modified revalidation).
- `web_platform_search` tool (platform-specific search).
- History/stats/cache tools.
- Browser automation sub-package (Playwright/Chromium).
- CI (build + lib-sync + best-effort typecheck).

[Unreleased]: https://github.com/stelmakhdigital/dsh-web-automation/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/stelmakhdigital/dsh-web-automation/releases/tag/v0.1.0
