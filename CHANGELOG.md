# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

### Added
- **SSRF guard, expanded** (`fetch/ssrf.ts`): blocks requests to loopback, private,
  link-local, and otherwise reserved network targets (IPv4 `0/8`, `10/8`, `127/8`,
  `172.16/12`, `169.254/16`, `192.168/16`; IPv6 `::1`, `fe80::/10`, `fc00::/7`).
  Checked on the literal host and after DNS resolution (anti-rebinding), and on
  every redirect hop (max 5) via `fetchPublic`. Now enforced on **all** outbound
  paths: `web_fetch`, search enrichment, `web_platform_search` (incl. RSS feed
  URLs), and `browser_navigate` (standalone copy in the browser sub-package).
  Per-path opt-out: `fetch.allowPrivateNetworks`, `search.allowPrivateNetworks`,
  `platforms.allowPrivateNetworks`, and the browser `allowPrivateNetworks`.
- **Browser SSRF guard** (`browser/src/ssrf.ts`): `browser_navigate` checks the
  literal target before navigation and the final URL after (Playwright follows
  redirects internally); blocked targets fail with `BROWSER_SSRF_BLOCKED`.
- **LRU cache eviction**: `last_accessed_at` on `web_searches`/`web_pages` (schema v2 +
  migration), updated on every read/write. `store.evict()` keeps the most-recently-accessed
  entries (`fetch.cacheMaxPages=500`, `search.cacheMaxSearches=1000` defaults).
- **Shared web store**: the top-level plugin now creates ONE `WebStore`
  (`$DSH_HOME/web.db`) shared by the search, fetch, and history modules when all
  use the default path (one connection instead of three); each module merges its
  own resolved eviction cap into the shared store. Custom `storePath`s keep their
  own stores.
- **Store disposal**: the store is closed when the plugin's fiber is disposed
  (`ctx.effect`), symmetric with the browser runtime's `closeAll` effect.
- **Friendly duplicate-provider errors**: registering the plugin on top of DSH's
  built-in web packages now fails with an explicit `WEB_DUPLICATE_PROVIDER`
  message explaining the mutual exclusion, instead of the bare seam error.
- **`local-web.cordis.yml` overlay**: ready-made overlay (seam pin + `tool-web`
  enablement + plugin row) for the standard DSH deployment; the `web` seam pin is
  required to avoid `WEB_PROVIDER_AMBIGUOUS`.
- **Documentation**: README (EN/RU) gained the overlay quick start, the
  "Relationship to DSH's built-in web packages" section (mutual exclusion, tools
  come from the host `tool-web`, upstream drift), the expanded Security section
  (all guarded paths + flags, browser approval fail-closed), a smoke-test
  checklist, and seam/duplicate troubleshooting rows. `cordis.yml.example` gained
  the seam pin rows and the new `allowPrivateNetworks` fields.
- **Tests**: vitest suite (75 tests) covering the SSRF guard (IP literals, protocol
  block, DNS rebinding, `allowPrivate` bypass, redirect hops), the store (CRUD,
  LRU eviction, stats, clear), enrichment SSRF behavior, platform SSRF behavior,
  browser screenshot writes, and browser approval fail-closed semantics.
- `vitest` devDependency + `test` / `test:watch` scripts.

### Changed
- Store schema bumped to v2 (`last_accessed_at` column + migration for existing DBs).
- `WebStoreOptions` gained `evictLimits` (per-table LRU caps); `WebStore` gained
  `setEvictLimits` (merge) for the shared-store flow.
- Fetch config gained `cacheMaxPages` + `allowPrivateNetworks`; search and
  platforms configs gained `allowPrivateNetworks`.
- **Browser fixes**: `browser_screenshot` now creates its output directory
  (no more ENOENT), and browser approval is **fail-closed** — a missing agent or
  an unavailable approval service denies the action instead of allowing it.
- **Single product User-Agent** (`src/user-agent.ts`): `deepseek-harness/0.3.0
  dsh-web-automation (+https://github.com/stelmakhdigital/dsh-web-automation)`
  is now the one UA for search, fetch, and platform requests (previously
  per-module 0.1.1/0.0.1/0.1.1 variants); browser-like platforms keep a
  `Mozilla/5.0 (compatible; ...)` UA built from the same version token.
- Exa/Jina `available()` JSDoc corrected: the engine reports *potentially*
  available when a resolver is set (the credentials-domain key takes effect per
  search); a keyless search fails with a provider error the router cools down.
- `lib/` and `browser/lib/` rebuilt (CI lib-sync gate enforces this).

## [0.2.0]

### Added
- **SearXNG engine**: self-hosted metasearch (no API key) via `search.searxng.endpoint`.
- **News mode**: `search.freshness` (`24h | week | month | year`, Bing `qft` filter).
- **Embedding re-rank**: `search.embedding` (local LLM server with `/embeddings`;
  falls back to BM25 when unreachable).
- **Inline screenshots**: `browser_screenshot` with `inline: true` returns base64
  in the model context instead of a file path.
- **Observability**: provider/engine log lines via the host logger seam.

## [0.1.0] - 2026-01-01

### Added
- Initial release.
- Multi-engine keyless search (DuckDuckGo/Bing + optional Exa/DeepSeek/Jina).
- SQLite-cached fetch provider (ETag/Last-Modified revalidation).
- `web_platform_search` tool (platform-specific search).
- History/stats/cache tools.
- Browser automation sub-package (Playwright/Chromium).
- CI (build + lib-sync + best-effort typecheck).

[0.3.0]: https://github.com/stelmakhdigital/dsh-web-automation/releases/tag/v0.3.0
[0.2.0]: https://github.com/stelmakhdigital/dsh-web-automation/releases/tag/v0.2.0
[0.1.0]: https://github.com/stelmakhdigital/dsh-web-automation/releases/tag/v0.1.0
