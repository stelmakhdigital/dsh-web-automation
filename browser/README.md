# dsh-web-browser

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds **local Chromium (Playwright) browser automation** behind the `browser_*` tools. It is a sub-package of [`dsh-web-automation`](../README.md), kept separate because it pulls in Playwright and a Chromium download.

## Tools

| Tool | What it does |
|---|---|
| `browser_open` | Open a URL in a new (or the current) tab. |
| `browser_navigate` | Navigate the current tab to a URL. |
| `browser_snapshot` | Capture the page's visible text + interactive elements (a structured snapshot). |
| `browser_click` | Click an element (by index from a snapshot, or by selector). |
| `browser_type` | Type text into an element. |
| `browser_screenshot` | Capture a screenshot (written to a file). |

## Install

```sh
npm install git+https://github.com/stelmakhdigital/dsh-web-automation.git#browser
# one-time: install the Chromium binary
npx playwright install chromium
```

## Configure

```yaml
- id: web-browser
  name: 'dsh-web-browser'
  config:
    tool: true                  # register the browser_* tools
    headless: true              # run without a visible window
    approval: never             # never | navigate | all (when to ask the user)
    # timeoutMs: 30000          # per-action deadline (ms)
    # maxTextLength: 100000     # snapshot visible-text bound (chars)
    # maxElements: 200          # snapshot interactive-element bound
```

## Privacy model

- The browser runs **locally** (Chromium on this machine); pages are fetched over the network to the sites you navigate to.
- No credentials are sent anywhere by the plugin itself.
- **Caveat**: browser automation can interact with any site the local machine can reach; use the `approval` policy to gate sensitive actions.

## Known limitations

- One tab per agent session.
- Screenshots are written to a file (not inlined into the model context).
- A re-render of the page invalidates snapshot element indices (re-snapshot before acting).

## License

MIT — see [LICENSE](LICENSE).
