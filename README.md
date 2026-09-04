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

The plugin must be installed **alongside your DSH deployment** (in the same `node_modules` tree), because it resolves the host's `@deepseek-ai/*` packages at runtime (peer dependencies).

The DSH deployment is a **pnpm workspace**, so use `pnpm` (not `npm` — npm does not support the `workspace:` protocol used by DSH's internal packages). The `-w` flag adds the plugin to the workspace root:

```sh
pnpm install -w git+https://github.com/stelmakhdigital/dsh-web-automation.git
```

> The `@deepseek-ai/*` peer dependencies are provided by your DSH installation (resolved from the workspace). If you install the plugin into a project that does not already have DSH's packages, install DSH first so the peers resolve to the host's versions.

### Optional: browser automation

The [`dsh-web-browser`](browser/) sub-package adds local Chromium (Playwright) automation behind the `browser_*` tools (`browser_open`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot`). It is separate because it pulls in Playwright + a Chromium download.

```sh
pnpm install -w git+https://github.com/stelmakhdigital/dsh-web-automation.git#browser
# then, one-time, install the Chromium binary:
npx playwright install chromium
```

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

- **SSRF guard** (on by default): `web_fetch` blocks requests to loopback, private, link-local, and otherwise reserved network targets. The check runs on the literal host and after DNS resolution (against rebinding). Set `fetch.allowPrivateNetworks: true` to disable the guard in a trusted, network-isolated environment.
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

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERESOLVE` peer conflict on install | Peer deps absent outside DSH deployment | `npm install --legacy-peer-deps` |
| `Cannot find module '@deepseek-ai/...'` | Plugin installed without DSH's packages | Install DSH first (peers resolve to host's versions) |
| `web_fetch` blocked (SSRF) | Target is loopback/private/link-local | Set `fetch.allowPrivateNetworks: true` (trusted env only) |
| SearXNG returns non-JSON | JSON API not enabled on the instance | Add `search.formats: [html, json]` to SearXNG's `settings.yml` |
| Embedding re-rank falls back to BM25 | Embedding endpoint unreachable | Check the endpoint URL + model name; BM25 is the fallback |
| Browser: `Chromium not found` | Playwright browser not installed | `npx playwright install chromium` |
| `web.db` grows large | Cache eviction caps too high | Lower `fetch.cacheMaxPages` / `search.cacheMaxSearches` |

## License

MIT — see [LICENSE](LICENSE).
