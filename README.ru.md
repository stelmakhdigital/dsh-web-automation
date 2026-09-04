# dsh-web-automation (русский)

> 🇬🇧 [English](README.md) | 🇷🇺 **Русский**

Плагин для [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), который даёт **локальной модели** **локальный web-стек** — без платного search API, без сторонних data-брокеров, без облака для keyless-движков.

В один устанавливаемый плагин собраны четыре возможности:

| Возможность | Что делает | Keyless? |
|---|---|---|
| **Многодвижковый поиск** | Tool `web_search`, маршрутизация через DuckDuckGo + Bing (keyless) и Exa / DeepSeek / Jina (опционально, при наличии API-ключей). Fallback или fuse (параллельно + RRF), cooldowns, BM25/embedding enrichment. | ✅ DDG + Bing |
| **Кэшированный fetch** | Tool `web_fetch` с SQLite-кэшем страниц и ETag/Last-Modified revalidation. Повторы в пределах TTL не делают сетевой запрос. | ✅ |
| **Web-платформы** | Tool `web_platform_search`: поиск по конкретной платформе (GitHub, Reddit, YouTube, Bilibili, V2EX, RSS, …) через её публичный эндпоинт. Новые платформы добавляются **без кода** через конфиг или версионированные rule-packs (hot-reload). | ✅ |
| **История / статистика / кэш** | `web_history`, `web_search_stats`, `web_cache_clear` — чтение общего локального хранилища; без сети. | ✅ |

Всё состояние локальное: хранилище — `$DSH_HOME/web.db`. Исходящий трафик keyless-движков ограничен DuckDuckGo и Bing.

## Установка

Плагин должен быть установлен **вместе с вашим DSH-деплоем** (в том же дереве `node_modules`), потому что он резолвит `@deepseek-ai/*` пакеты хоста в рантайме (peer dependencies).

DSH-деплой — это **pnpm workspace**, поэтому используйте `pnpm` (не `npm` — npm не поддерживает протокол `workspace:`, который используют внутренние пакеты DSH):

```sh
pnpm install git+https://github.com/stelmakhdigital/dsh-web-automation.git
```

> Peer-зависимости `@deepseek-ai/*` предоставляются вашей установкой DSH (резолвятся из workspace). Если вы устанавливаете плагин в проект, где ещё нет пакетов DSH, сначала установите DSH, чтобы peers резолвились к версиям хоста.

### Опционально: browser automation

Подпакет [`dsh-web-browser`](browser/) добавляет локальный Chromium (Playwright) автоматизацию за tool `browser_*` (`browser_open`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot`). Он вынесен отдельно, потому что тянет Playwright + загрузку Chromium.

```sh
pnpm install git+https://github.com/stelmakhdigital/dsh-web-automation.git#browser
# затем, один раз, установите бинарник Chromium:
npx playwright install chromium
```

## Конфигурация

Добавьте строку в `cordis.yml` вашего деплоя (или overlay через `dsh --patch ...`). Полный референс — в [`cordis.yml.example`](cordis.yml.example).

```yaml
- id: web-automation
  name: 'dsh-web-automation'
  config:
    search:
      engines: [ddg, bing, exa, deepseek, jina, searxng]   # порядок проб
      mode: fallback            # fallback | fuse
      region: ''                # region/market hint (DDG kl, Bing setmkt)
      # freshness: ''           # news mode: 24h | week | month | year (Bing qft)
      # searxng: { endpoint: http://localhost:8080 }   # self-hosted metasearch
      # embedding: { endpoint: http://localhost:11434, model: nomic-embed-text }
      # exa:      { apiKeyEnv: EXA_API_KEY }
      # deepseek: { apiKeyEnv: DEEPSEEK_API_KEY }
      # jina:     { apiKeyEnv: JINA_API_KEY }
    fetch:
      revalidate: true          # conditional revalidation для fresh-but-expired страниц
      # cacheMaxPages: 500      # LRU-лимит на страницы
      # allowPrivateNetworks: false  # SSRF-guard
    platforms:
      tool: true                # зарегистрировать web_platform_search
      maxResults: 20
    history:
      history: true             # web_history
      cacheClear: true          # web_cache_clear
      stats: true               # web_search_stats
```

Все поля имеют значения по умолчанию, поэтому пустой `config: {}` (или отсутствие `config`) включает полный локальный web-стек с keyless-движками.

## API-ключи (опционально)

Keyless-движки (DuckDuckGo, Bing) работают без конфигурации. Чтобы включить Exa / DeepSeek / Jina, предоставьте их API-ключи:

- в launch-окружении (`EXA_API_KEY`, `DEEPSEEK_API_KEY`, `JINA_API_KEY`), или
- в конфиге плагина (`search.exa.apiKey`, и т.д.), или
- через credentials-домен DSH (ключ, записанный в credentials store, действует per-search, без рестарта).

## Использование

После установки и конфигурации модель может:

- **Искать в вебе** — `web_search "query"` (многодвижковый, enriched snippets).
- **Загружать страницу** — `web_fetch <url>` (кэшируется; повторы в пределах TTL не делают сетевой запрос).
- **Искать по платформе** — `web_platform_search { platform: "github", query: "..." }`.
- **Смотреть историю / статистику** — `web_history`, `web_search_stats`, `web_cache_clear`.

## Безопасность

- **SSRF-guard** (включён по умолчанию): `web_fetch` блокирует запросы к loopback, private, link-local и другим зарезервированным сетевым целям. Проверка выполняется на литеральном хосте и после DNS-резолва (против rebinding). Отключите через `fetch.allowPrivateNetworks: true` только в доверенной, сетевы-изолированной среде.
- **Эвакуация кэша** (LRU по использованию): хранилище хранит не более `fetch.cacheMaxPages` страниц (default 500) и `search.cacheMaxSearches` поисков (default 1000), эвакуируя наименее недавно использованные после каждой записи. Это ограничивает рост `web.db` со временем.

## Известные ограничения

- HTML SERP-парсинг хрупкий; изменения разметки деградируют до нуля результатов, пока парсер не обновится (block detection превращает тихие пустоты в cooldowns).
- Плагин работает в процессе хоста DSH с привилегиями хоста (доверенный static-пакет); он не изолирован. Запускайте DSH как обычного пользователя, и в сетевы-изолированном контейнере/VM, если плагин может достигать чувствительных целей.
- Browser automation: одна вкладка на agent-сессию. Скриншоты по умолчанию сохраняются в файл; передайте `inline: true` в `browser_screenshot`, чтобы получить base64 в контекст модели.

## Примеры

### Только keyless (без API-ключей, без SearXNG)

```yaml
dsh-web-automation:
  search:
    engines: [ddg, bing]   # только keyless
    enrich: true
```

### Полный (все движки + SearXNG)

```yaml
dsh-web-automation:
  search:
    engines: [ddg, bing, exa, deepseek, jina, searxng]
    searxng:
      endpoint: http://localhost:8080   # ваш SearXNG
    embedding:
      endpoint: http://localhost:11434  # Ollama (или любой /embeddings сервер)
      model: nomic-embed-text
```

### News mode (time-filtered)

```yaml
dsh-web-automation:
  search:
    engines: [bing]   # Bing поддерживает freshness filter
    freshness: 24h    # 24h | week | month | year
```

## Troubleshooting

| Симптом | Причина | Решение |
|---|---|---|
| `ERESOLVE` peer conflict при установке | Peer deps отсутствуют вне DSH-деплоя | `npm install --legacy-peer-deps` |
| `Cannot find module '@deepseek-ai/...'` | Плагин установлен без пакетов DSH | Сначала установите DSH (peers резолвятся к версиям хоста) |
| `web_fetch` заблокирован (SSRF) | Цель — loopback/private/link-local | `fetch.allowPrivateNetworks: true` (только в доверенной среде) |
| SearXNG возвращает non-JSON | JSON API не включён на инстансе | Добавьте `search.formats: [html, json]` в `settings.yml` SearXNG |
| Embedding re-rank откатывается на BM25 | Embedding endpoint недоступен | Проверьте URL + имя модели; BM25 — fallback |
| Browser: `Chromium not found` | Playwright browser не установлен | `npx playwright install chromium` |
| `web.db` растёт | Лимиты эвакуации кэша слишком высокие | Уменьшите `fetch.cacheMaxPages` / `search.cacheMaxSearches` |

## Лицензия

MIT — см. [LICENSE](LICENSE).
