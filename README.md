# dsh-web-automation

> 🇬🇧 **English** | 🇷🇺 [Русский](README.ru.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives a **local model** a **local-first web stack** — no paid search API, no third-party data broker, no cloud required for the keyless engines.

It bundles four capabilities into one installable plugin:

| Capability | What it does | Keyless? |
|---|---|---|
| **Multi-engine search** | The `web_search` tool, routed across DuckDuckGo + Bing (keyless) and Exa / DeepSeek / Jina (opt-in, when their API keys are present). Fallback or fuse (parallel + RRF) routing, cooldowns, BM25 enrichment. | ✅ DDG + Bing |
| **Cached fetch** | The `web_fetch` tool backed by a SQLite page cache with ETag/Last-Modified revalidation. Repeats within the TTL make no network request. | ✅ |
| **Web platforms** | The `web_platform_search` tool: search a specific platform (GitHub, Reddit, YouTube, Bilibili, V2EX, RSS, …) via its own public endpoint. New platforms are added **without code** via config or versioned rule packs (hot-reloaded). | ✅ |
| **History / stats / cache** | `web_history`, `web_search_stats`, `web_cache_clear` — read the shared local store; no network. | ✅ |

All state is local: the store is `$DSH_HOME/web.db`. Outbound traffic for the keyless engines is limited to DuckDuckGo and Bing.

## Install

Plugins are installed **into a DSH profile** with `dsh plugin` — each profile is its own pnpm workspace under `$DSH_HOME/profiles/<name>`. At boot, DSH symlinks the host's `@deepseek-ai/*` packages into the profile's `node_modules`, so the plugin's peer dependencies resolve to the host's own copies.

This package is a **DSH bundle**: its `package.json` declares `dsh.bundle`, so installing it automatically applies the shipped [`local-web.cordis.yml`](local-web.cordis.yml) overlay — it pins the `web` seam to the plugin's providers, enables `web_fetch` in the host `tool-web` row, and registers the plugin. No manual `--patch` needed:

```sh
dsh plugin --profile tui add git+https://github.com/stelmakhdigital/dsh-web-automation.git
```

(Replace `tui` with your profile name. The seam pin is **required**: without it the seam sees two usable search providers (the deployment default plus `multi`) and fails with `WEB_PROVIDER_AMBIGUOUS`.)

Manual alternative — if you want to tweak the config before applying, apply the overlay yourself:

```sh
dsh --profile tui --patch "$PWD/local-web.cordis.yml"
```

### Optional: browser automation

The [`dsh-web-browser`](browser/) sub-package adds local Chromium (Playwright) automation behind the `browser_*` tools (`browser_open`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot`). It is separate because it pulls in Playwright + a Chromium download.

It is a sub-directory of this repo, and pnpm cannot install a sub-directory of a git repo — so install it from a local clone (keep the clone in a stable place; the profile links to it):

```sh
git clone --depth 1 https://github.com/stelmakhdigital/dsh-web-automation.git ~/dsh-plugins/dsh-web-automation
dsh plugin --profile tui add ~/dsh-plugins/dsh-web-automation/browser
# one-time: install the Chromium binary
dsh plugin --profile tui exec playwright install chromium
```

The browser package is a bundle too — its patch (`browser/cordis.patch.yml`) registers the browser plugin row automatically.

## Configure

Add a row to your deployment's `cordis.yml` (or an overlay applied with `dsh --patch ...`). See [`cordis.yml.example`](cordis.yml.example) for the full reference.

```yaml
- id: web-automation
  name: 'dsh-web-automation'
  config:
    search:
      engines: [ddg, bing, exa, deepseek, jina]   # tried in order
      mode: fallback            # fallback | fuse
      region: ''                # region/market hint (DDG kl, Bing setmkt)
      # exa:      { apiKeyEnv: EXA_API_KEY }      # or apiKey: '...'
      # deepseek: { apiKeyEnv: DEEPSEEK_API_KEY }
      # jina:     { apiKeyEnv: JINA_API_KEY }
    fetch:
      revalidate: true          # conditional revalidation for fresh-but-expired pages
    platforms:
      tool: true                # register web_platform_search
      maxResults: 20
      # platforms:              # override built-ins by id, or add new platforms
      #   - id: my-site
      #     name: My Site
      #     format: json
      #     searchUrl: 'https://my-site.example/search?q={query}'
      #     fields: { items: 'data.results', url: 'link', title: 'title' }
    history:
      history: true             # web_history
      cacheClear: true          # web_cache_clear
      stats: true               # web_search_stats
```

Every field is defaulted, so an empty `config: {}` (or no `config` at all) enables the full local web stack with the keyless engines.

## Relationship to DSH's built-in web packages

This plugin is an **externalized, standalone copy** of DSH's internal web packages (`web-search-multi`, `web-fetch-cached`, `web-platforms`, `web-store`, `web-browser`, `tool-web-history`) and is currently **ahead of upstream** (SearXNG engine, news-mode freshness, embedding re-rank, LRU eviction, SSRF guard, inline screenshots).

- **Mutual exclusion**: the plugin and the built-in packages register the same provider ids (`multi`, `cached-http`) and tool names. A deployment that loads both fails at startup with `WEB_DUPLICATE_PROVIDER` — keep one. If you use this plugin, do **not** apply DSH's `examples/web-local` overlay (or its preset copies), and vice versa.
- **The tools come from the host**: `web_search` and `web_fetch` are registered by the host's `tool-web` plugin; this plugin registers the **providers** behind them (plus `web_platform_search` and the history tools). The overlay above enables `web_fetch` in the `tool-web` row.
- **Upstream drift**: because the plugin evolves independently, its behavior may diverge from the built-in packages over time. The module headers in `src/` mark the upstream package each module mirrors.

## API keys (optional)

The keyless engines (DuckDuckGo, Bing) work with no configuration. To opt in to Exa / DeepSeek / Jina, provide their API keys either:

- in the launch environment (`EXA_API_KEY`, `DEEPSEEK_API_KEY`, `JINA_API_KEY`), or
- in the plugin config (`search.exa.apiKey`, etc.), or
- via the DSH credentials domain (a key written to the credentials store takes effect per-search, without a restart).

## Usage

Once installed and configured, the model can:

- **Search the web** — `web_search "query"` (multi-engine, enriched snippets).
- **Fetch a page** — `web_fetch <url>` (cached; repeats within the TTL make no network request).
- **Search a platform** — `web_platform_search { platform: "github", query: "..." }`.
- **Review history / stats** — `web_history`, `web_search_stats`, `web_cache_clear`.
- **Drive a browser** (with `dsh-web-browser`) — `browser_open`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot`.

## Privacy model

- **Queries** go to the configured search engines only — unavoidable with any search engine. With the default engine list and **no API keys**, outbound traffic is limited to DuckDuckGo and Bing; inference stays local.
- **No credentials required** for basic use.
- **All state is local**: the store is `$DSH_HOME/web.db`, nothing is sent anywhere else.
- **Caveat**: scraping public SERPs may violate a search engine's terms of service; the provider sends an explicit product `User-Agent`, rate-limits itself (1 req/s per engine by default), and cools down blocked engines. Use responsibly.

## Security

- **SSRF guard** (on by default): requests to loopback, private, link-local, and otherwise reserved network targets (IPv4 `0/8`, `10/8`, `127/8`, `172.16/12`, `169.254/16`, `192.168/16`; IPv6 `::1`, `::/128`, `fe80::/10`, `fc00::/7`) are blocked. The check runs on the literal host **and** after DNS resolution (against rebinding), and for `web_fetch`/enrichment it re-checks every redirect hop (max 5). Guarded paths and their flags:
  | Path | Flag |
  |---|---|
  | `web_fetch` (cached fetch provider) | `fetch.allowPrivateNetworks` |
  | search enrichment (page fetches for snippets) | `search.allowPrivateNetworks` |
  | `web_platform_search` fetches (incl. RSS feed URLs) | `platforms.allowPrivateNetworks` |
  | `browser_navigate` (Playwright) | `allowPrivateNetworks` in the `dsh-web-browser` config |

  Set the relevant flag to `true` only in a trusted, network-isolated environment.
- **Browser approval** (fail-closed): `browser_open`/`browser_navigate` require approval per the `dsh-web-browser` `approval` setting (`never` | `once` | `always`). If the approval service is unavailable or the call has no agent to route it through, the action is **denied**, not silently allowed.
- **Cache eviction** (LRU by usage): the store keeps at most `fetch.cacheMaxPages` page records (default 500) and `search.cacheMaxSearches` search records (default 1000), evicting the least-recently-accessed beyond the cap after each write. This keeps `web.db` bounded over time.

## Known limitations

- HTML SERP parsing is brittle; markup changes degrade to zero results until the parser updates (block detection converts silent empties into cooldowns).
- The plugin runs in the host DSH process with the host's privileges (a trusted static package); it is not sandboxed. Run DSH as a normal user, and in a network-isolated container/VM if the plugin may reach sensitive targets.
- Browser automation: one tab per agent session. Screenshots are saved to a file by default; pass `inline: true` to `browser_screenshot` to get base64 in the model context.

## Examples

### Keyless-only (no API keys, no SearXNG)

```yaml
dsh-web-automation:
  search:
    engines: [ddg, bing]   # keyless only
    enrich: true
```

### Full (all engines + SearXNG)

```yaml
dsh-web-automation:
  search:
    engines: [ddg, bing, exa, deepseek, jina, searxng]
    searxng:
      endpoint: http://localhost:8080   # your SearXNG instance
    embedding:
      endpoint: http://localhost:11434  # Ollama (or any /embeddings server)
      model: nomic-embed-text
```

### News mode (time-filtered)

```yaml
dsh-web-automation:
  search:
    engines: [bing]   # Bing supports the freshness filter
    freshness: 24h    # 24h | week | month | year
```

## Smoke test

After installing and applying the overlay, verify the stack end to end (in a DSH session):

1. `web_search "hello world"` — returns sources (DDG/Bing keyless).
2. `web_fetch https://example.com` twice — the second call is a cache hit (no network; check `web_search_stats`).
3. `web_platform_search { platform: "github", query: "schemastery" }` — returns GitHub sources.
4. `web_history` — shows the searches/fetches above.
5. `web_fetch http://127.0.0.1/` — fails with `WEB_SSRF_BLOCKED` (the SSRF guard).
6. (with `dsh-web-browser`) `browser_open` → `browser_navigate https://example.com` → `browser_screenshot` → `browser_close` — the screenshot file appears in the temp dir.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERESOLVE` peer conflict on install | Peer deps absent outside DSH deployment | `npm install --legacy-peer-deps` |
| `Cannot find module '@deepseek-ai/...'` | Plugin installed without DSH's packages | Install DSH first (peers resolve to host's versions) |
| `WEB_PROVIDER_AMBIGUOUS` at startup | The `web` seam sees two usable search providers | Add the `web` seam pin row (`searchProvider: multi`, `fetchProvider: cached-http`) — see the overlay |
| `WEB_DUPLICATE_PROVIDER` at startup | Both the plugin and DSH's built-in web packages are loaded | Keep one — remove the built-in rows (or the plugin row); see "Relationship to DSH's built-in web packages" |
| `web_fetch` blocked (SSRF) | Target is loopback/private/link-local | Set `fetch.allowPrivateNetworks: true` (trusted env only) |
| SearXNG returns non-JSON | JSON API not enabled on the instance | Add `search.formats: [html, json]` to SearXNG's `settings.yml` |
| Embedding re-rank falls back to BM25 | Embedding endpoint unreachable | Check the endpoint URL + model name; BM25 is the fallback |
| Browser: `Chromium not found` | Playwright browser not installed | `npx playwright install chromium` |
| `web.db` grows large | Cache eviction caps too high | Lower `fetch.cacheMaxPages` / `search.cacheMaxSearches` |

## License

MIT — see [LICENSE](LICENSE).
