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
| `browser_evaluate` | Evaluate a JavaScript expression in the page and return its JSON result. |
| `browser_screenshot` | Capture a screenshot (saved to a file by default; `inline: true` returns the base64 PNG in the model context). |
| `browser_close` | Close the session and release the browser. |

## Install

This package is a sub-directory of the `dsh-web-automation` repo, and pnpm cannot install a sub-directory of a git repo directly. Install it into your DSH profile from a local clone as a **tarball** (`npm pack`) — unlike a `link:` install, the tarball is unpacked into the profile's `node_modules`, so playwright is installed and the package's `@deepseek-ai/*` imports resolve to the host's packages:

```sh
git clone --depth 1 https://github.com/stelmakhdigital/dsh-web-automation.git ~/dsh-plugins/dsh-web-automation
cd ~/dsh-plugins/dsh-web-automation
npm pack ./browser  # → dsh-web-browser-0.3.0.tgz (lib/ is prebuilt in the repo)
dsh plugin --profile web add ./dsh-web-browser-0.3.0.tgz
# one-time: install the Chromium binary
dsh plugin --profile web exec playwright install chromium
```

The package is a DSH bundle — its `cordis.patch.yml` registers the `web-browser` plugin row automatically (install the core `dsh-web-automation` bundle first for the `web` seam pin + `tool-web` row).

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
- Screenshots are saved to a file by default; `browser_screenshot` with `inline: true` returns the base64 PNG in the model context instead (no size cap — a large full-page shot can bloat the context).
- A re-render of the page invalidates snapshot element indices (re-snapshot before acting).

## License

MIT — see [LICENSE](LICENSE).
