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

Плагины ставятся **в профиль DSH** командой `dsh plugin` — каждый профиль это отдельный pnpm-workspace в `$DSH_HOME/profiles/<name>`. При старте DSH кладёт симлинки на `@deepseek-ai/*` пакеты хоста в `node_modules` профиля, поэтому peer-зависимости плагина резолвятся к собственным копиям хоста.

Этот пакет — **DSH bundle**: в `package.json` объявлено `dsh.bundle`, поэтому при установке автоматически применяется поставляемый оверлей [`local-web.cordis.yml`](local-web.cordis.yml) — он фиксирует `web`-seam на провайдерах плагина, включает `web_fetch` в строке `tool-web` хоста и регистрирует плагин. Ручной `--patch` не нужен:

```sh
dsh plugin --profile tui add git+https://github.com/stelmakhdigital/dsh-web-automation.git
```

(Замените `tui` на имя вашего профиля. Фиксация seam **обязательна**: без неё seam видит два пригодных search-провайдера (дефолт деплоя + `multi`) и падает с `WEB_PROVIDER_AMBIGUOUS`.)

Ручной вариант — если хочется сначала поправить конфиг, примените оверлей сами:

```sh
dsh --profile tui --patch "$PWD/local-web.cordis.yml"
```

### Опционально: browser automation

Подпакет [`dsh-web-browser`](browser/) добавляет локальный Chromium (Playwright) автоматизацию за tool `browser_*` (`browser_open`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot`). Он вынесен отдельно, потому что тянет Playwright + загрузку Chromium.

Это подкаталог репозитория, а pnpm не умеет ставить подкаталог git-репозитория напрямую. Ставится из локального клона **тарбаллом** (`npm pack`): в отличие от `link:`-установки, тарболл распаковывается в `node_modules` профиля — ставятся собственные зависимости пакета (playwright) и импорты `@deepseek-ai/*` резолвятся к пакетам хоста:

```sh
git clone --depth 1 https://github.com/stelmakhdigital/dsh-web-automation.git ~/dsh-plugins/dsh-web-automation
cd ~/dsh-plugins/dsh-web-automation
npm pack browser    # → dsh-web-browser-0.3.0.tgz (lib/ собран в репозитории)
dsh plugin --profile tui add ./dsh-web-browser-0.3.0.tgz
# один раз: установить бинарник Chromium
dsh plugin --profile tui exec playwright install chromium
```

Браузерный пакет тоже bundle — его патч (`cordis.patch.yml` в тарболе) автоматически добавляет строку browser-плагина. Обновление: `git pull` в клоне, снова `npm pack browser`, `dsh plugin add` нового тарбола.

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

## Отношение к встроенным web-пакетам DSH

Этот плагин — **внешняя standalone-копия** внутренних web-пакетов DSH (`web-search-multi`, `web-fetch-cached`, `web-platforms`, `web-store`, `web-browser`, `tool-web-history`) и на данный момент **впереди upstream** (SearXNG-движок, news-mode freshness, embedding re-rank, LRU-эвакуация, SSRF-guard, inline-скриншоты).

- **Взаимное исключение**: плагин и встроенные пакеты регистрируют одни и те же provider id (`multi`, `cached-http`) и имена tool. Деплой, загружающий оба, падает при старте с `WEB_DUPLICATE_PROVIDER` — оставляйте один. Если используете этот плагин, **не** применяйте оверлей DSH `examples/web-local` (и его preset-копии), и наоборот.
- **Tools даёт хост**: `web_search` и `web_fetch` регистрируются плагин-хостом `tool-web`; этот плагин регистрирует **провайдеров** за ними (плюс `web_platform_search` и history-tools). Оверлей выше включает `web_fetch` в строке `tool-web`.
- **Расхождение с upstream**: плагин эволюционирует независимо, поэтому его поведение может расходиться со встроенными пакетами со временем. Шапки модулей в `src/` помечают upstream-пакет, которому соответствует каждый модуль.

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

- **SSRF-guard** (включён по умолчанию): запросы к loopback, private, link-local и другим зарезервированным сетевым целям (IPv4 `0/8`, `10/8`, `127/8`, `172.16/12`, `169.254/16`, `192.168/16`; IPv6 `::1`, `::/128`, `fe80::/10`, `fc00::/7`) блокируются. Проверка выполняется на литеральном хосте **и** после DNS-резолва (против rebinding), а для `web_fetch`/enrichment — на каждом hop-е редиректа (макс. 5). Защищённые пути и их флаги:
  | Путь | Флаг |
  |---|---|
  | `web_fetch` (cached fetch provider) | `fetch.allowPrivateNetworks` |
  | search enrichment (запросы страниц для сниппетов) | `search.allowPrivateNetworks` |
  | запросы `web_platform_search` (вкл. RSS feed URL) | `platforms.allowPrivateNetworks` |
  | `browser_navigate` (Playwright) | `allowPrivateNetworks` в конфиге `dsh-web-browser` |

  Ставьте соответствующий флаг в `true` только в доверенной, сетевы-изолированной среде.
- **Browser approval** (fail-closed): `browser_open`/`browser_navigate` требуют approval согласно настройке `approval` в `dsh-web-browser` (`never` | `once` | `always`). Если approval-сервис недоступен или у вызова нет agent для маршрутизации, действие **отказывается**, а не разрешается молча.
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

## Smoke-тест

После установки и применения оверлея проверьте стек end-to-end (в DSH-сессии):

1. `web_search "hello world"` — возвращает источники (DDG/Bing keyless).
2. `web_fetch https://example.com` дважды — второй вызов — cache hit (без сети; см. `web_search_stats`).
3. `web_platform_search { platform: "github", query: "schemastery" }` — возвращает GitHub-источники.
4. `web_history` — показывает поиски/загрузки выше.
5. `web_fetch http://127.0.0.1/` — падает с `WEB_SSRF_BLOCKED` (SSRF-guard).
6. (с `dsh-web-browser`) `browser_open` → `browser_navigate https://example.com` → `browser_screenshot` → `browser_close` — файл скриншота появляется в temp-каталоге.

## Troubleshooting

| Симптом | Причина | Решение |
|---|---|---|
| `ERESOLVE` peer conflict при установке | Peer deps отсутствуют вне DSH-деплоя | `npm install --legacy-peer-deps` |
| `Cannot find module '@deepseek-ai/...'` | Плагин установлен без пакетов DSH | Сначала установите DSH (peers резолвятся к версиям хоста) |
| `WEB_PROVIDER_AMBIGUOUS` при старте | `web`-seam видит два пригодных search-провайдера | Добавьте строку фикса `web`-seam (`searchProvider: multi`, `fetchProvider: cached-http`) — см. оверлей |
| `WEB_DUPLICATE_PROVIDER` при старте | Загружены и плагин, и встроенные web-пакеты DSH | Оставьте один — удалите встроенные строки (или строку плагина); см. «Отношение к встроенным web-пакетам DSH» |
| `web_fetch` заблокирован (SSRF) | Цель — loopback/private/link-local | `fetch.allowPrivateNetworks: true` (только в доверенной среде) |
| SearXNG возвращает non-JSON | JSON API не включён на инстансе | Добавьте `search.formats: [html, json]` в `settings.yml` SearXNG |
| Embedding re-rank откатывается на BM25 | Embedding endpoint недоступен | Проверьте URL + имя модели; BM25 — fallback |
| Browser: `Chromium not found` | Playwright browser не установлен | `npx playwright install chromium` |
| `web.db` растёт | Лимиты эвакуации кэша слишком высокие | Уменьшите `fetch.cacheMaxPages` / `search.cacheMaxSearches` |

## Лицензия

MIT — см. [LICENSE](LICENSE).
