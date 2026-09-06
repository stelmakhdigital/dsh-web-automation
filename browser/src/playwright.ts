/**
 * Local Playwright (Chromium) provider for the browser seam. Launches a real
 * browser on the host and drives one page. Interactive elements are tagged with
 * a `data-dsh-ref` attribute at snapshot time so a later click/type can address
 * them by `ref` without re-deriving a fragile selector.
 * @module @deepseek-ai/dsh-web-browser/playwright
 */

import type { Browser, Page } from 'playwright'
import { checkSsrf } from './ssrf.ts'
import type {
  BrowserElement,
  BrowserNavigateResult,
  BrowserOpenOptions,
  BrowserProvider,
  BrowserScreenshot,
  BrowserScreenshotOptions,
  BrowserSession,
  BrowserSnapshot,
  BrowserSnapshotOptions,
  BrowserTarget,
} from './types.ts'
import { BrowserError, BROWSER_CODES } from './types.ts'

/** Options for the Playwright provider. */
export interface PlaywrightProviderConfig {
  /** Run the browser headless. Default `true`. */
  readonly headless?: boolean
  /** Default per-action timeout in milliseconds. Default `30000`. */
  readonly timeoutMs?: number
  /** Auth profiles: name → storage-state file path (Playwright `storageState`). */
  readonly authProfiles?: Record<string, string>
  /** Default snapshot visible-text bound. Default `20000`. */
  readonly maxTextLength?: number
  /** Default snapshot element bound. Default `200`. */
  readonly maxElements?: number
  /**
   * Allow navigation to private/reserved network targets (loopback, LAN,
   * link-local). Default `false`: the SSRF guard blocks these. Enable only in
   * a trusted, network-isolated environment.
   */
  readonly allowPrivateNetworks?: boolean
}

/**
 * Assert a navigation target is public (not a private/reserved network
 * target). Throws {@link BrowserError} `BROWSER_SSRF_BLOCKED` when the guard
 * blocks the URL. The check runs on the literal host and after DNS resolution
 * (against rebinding).
 * @param url - the http(s) URL to check.
 * @param allowPrivate - when true, skip the check (allow all).
 */
export async function assertPublicNavigation(url: string, allowPrivate: boolean): Promise<void> {
  const check = await checkSsrf(url, { allowPrivate })
  if (!check.allowed) {
    throw new BrowserError(
      `navigation to ${url} blocked by the SSRF guard: ${check.reason ?? 'private/reserved target'}`,
      BROWSER_CODES.SSRF_BLOCKED,
    )
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TEXT_LENGTH = 20_000
const DEFAULT_MAX_ELEMENTS = 200

/** The playwright package, loaded lazily (see {@link loadPlaywright}). */
type PlaywrightModule = typeof import('playwright')

let playwrightModule: PlaywrightModule | undefined
let playwrightLoad: Promise<PlaywrightModule> | undefined
let playwrightLoadFailed = false

/**
 * Load playwright on first use (the promise is cached, success or failure).
 * The browser package is often installed from a local checkout (pnpm does not
 * install a linked package's own dependencies), so a static import would fail
 * to load the plugin whenever playwright is not resolvable from the package's
 * real location. Lazy loading keeps the plugin tree loadable; a missing
 * playwright then surfaces as a clear `BROWSER_UNAVAILABLE` error from
 * {@link PlaywrightProvider.open}.
 */
function loadPlaywright(): Promise<PlaywrightModule> {
  playwrightLoad ??= import('playwright').then(
    (mod) => {
      playwrightModule = mod
      return mod
    },
    (error: unknown) => {
      playwrightLoadFailed = true
      throw error
    },
  )
  return playwrightLoad
}

/** CSS selector matching the interactive elements surfaced in a snapshot. */
const INTERACTIVE_SELECTOR =
  'a[href], button, input, textarea, select, [role="button"], [role="link"], '
  + '[role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="switch"]'

/**
 * The Playwright-backed browser provider.
 */
export class PlaywrightProvider implements BrowserProvider {
  readonly id = 'playwright'
  private readonly headless: boolean
  private readonly timeoutMs: number
  private readonly authProfiles: Record<string, string>
  private readonly maxTextLength: number
  private readonly maxElements: number
  private readonly allowPrivateNetworks: boolean

  constructor(config: PlaywrightProviderConfig = {}) {
    this.headless = config.headless ?? true
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.authProfiles = config.authProfiles ?? {}
    this.maxTextLength = config.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH
    this.maxElements = config.maxElements ?? DEFAULT_MAX_ELEMENTS
    this.allowPrivateNetworks = config.allowPrivateNetworks ?? false
    // Preload so available() is accurate by the first browser action.
    void loadPlaywright().catch(() => undefined)
  }

  /** Cheap local usability check: the Chromium executable must resolve. */
  available(): boolean {
    if (playwrightModule !== undefined) {
      try {
        return playwrightModule.chromium.executablePath() !== ''
      } catch {
        return false
      }
    }
    // Still loading (optimistic — open() reports the real error) or the load
    // already failed (unavailable).
    return !playwrightLoadFailed
  }

  async open(options: BrowserOpenOptions, signal?: AbortSignal): Promise<BrowserSession> {
    throwIfAborted(signal)
    let pw: PlaywrightModule
    try {
      pw = await loadPlaywright()
    } catch (error) {
      throw new BrowserError(
        'playwright is not installed where the dsh-web-browser package is linked; install it into the profile (dsh plugin --profile <name> add playwright) or into the browser package directory (npm install)',
        BROWSER_CODES.UNAVAILABLE,
        { cause: error },
      )
    }
    const storageState = this.resolveStorageState(options.authProfile)
    const browser = await pw.chromium.launch({ headless: options.headless ?? this.headless })
    const contextOptions: { storageState?: string } = {}
    if (storageState !== undefined) contextOptions.storageState = storageState
    const context = await browser.newContext(contextOptions)
    const page = await context.newPage()
    return new PlaywrightSession(browser, page, this.timeoutMs, this.maxTextLength, this.maxElements, this.allowPrivateNetworks)
  }

  private resolveStorageState(profileName: string | undefined): string | undefined {
    if (profileName === undefined) return undefined
    const path = this.authProfiles[profileName]
    if (path === undefined) {
      throw new BrowserError(
        `auth profile "${profileName}" is not configured; known profiles: ${Object.keys(this.authProfiles).join(', ') || '(none)'}`,
        BROWSER_CODES.AUTH_MISSING,
      )
    }
    return path
  }
}

/**
 * A live Playwright-backed session (one page).
 */
class PlaywrightSession implements BrowserSession {
  readonly providerId = 'playwright'
  private closed = false

  constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly timeoutMs: number,
    private readonly maxTextLength: number,
    private readonly maxElements: number,
    private readonly allowPrivateNetworks: boolean,
  ) {}

  url(): string {
    return this.page.url()
  }

  async navigate(url: string, signal?: AbortSignal): Promise<BrowserNavigateResult> {
    this.ensureOpen(signal)
    const target = assertHttpUrl(url)
    // SSRF guard on the literal target (before any browser work).
    await assertPublicNavigation(target, this.allowPrivateNetworks)
    try {
      await this.page.goto(target, { waitUntil: 'load', timeout: this.timeoutMs })
    } catch (error) {
      throw classifyPlaywrightError(error, 'navigate')
    }
    // Playwright follows redirects internally, so re-check the FINAL url: a
    // public URL that 302s to a private target is reported as blocked.
    const finalUrl = this.page.url()
    if (finalUrl.length > 0 && finalUrl !== 'about:blank') {
      await assertPublicNavigation(finalUrl, this.allowPrivateNetworks)
    }
    const title = await this.page.title().catch(() => undefined)
    return { url: finalUrl, ...(title !== undefined ? { title } : {}) }
  }

  async snapshot(options: BrowserSnapshotOptions = {}, signal?: AbortSignal): Promise<BrowserSnapshot> {
    this.ensureOpen(signal)
    const maxTextLength = options.maxTextLength ?? this.maxTextLength
    const maxElements = options.maxElements ?? this.maxElements
    // The callback is serialized and executed IN THE PAGE: it must be fully
    // self-contained — no references to module-scope helpers (they do not
    // exist in the page context).
    const data = await this.page.evaluate(
      (selector: string) => {
        /** Infer an ARIA role from a tag (and input type) when no explicit role is set. */
        function roleFromTag(tag: string, el: Element): string {
          if (tag === 'a') return 'link'
          if (tag === 'button') return 'button'
          if (tag === 'textarea') return 'textbox'
          if (tag === 'select') return 'combobox'
          if (tag === 'input') {
            const type = (el.getAttribute('type') ?? 'text').toLowerCase()
            if (type === 'checkbox') return 'checkbox'
            if (type === 'radio') return 'radio'
            if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
            return 'textbox'
          }
          return tag
        }
        /** Best-effort accessible name for an element. */
        function accessibleName(el: Element, tag: string): string {
          const ariaLabel = el.getAttribute('aria-label')
          if (ariaLabel !== null && ariaLabel !== '') return ariaLabel.trim()
          if (tag === 'input') {
            const placeholder = el.getAttribute('placeholder')
            if (placeholder !== null && placeholder !== '') return placeholder.trim()
            const name = el.getAttribute('name')
            if (name !== null && name !== '') return name.trim()
          }
          // `textContent` is typed non-null by the DOM lib but is null for void/empty
          // elements (e.g. an `<input>` with no placeholder or name); widen to handle it.
          const rawText = (el as { textContent: string | null }).textContent
          const text = (rawText ?? '').trim().replace(/\s+/g, ' ')
          if (text !== '') return text.length > 120 ? `${text.slice(0, 117)}...` : text
          const id = el.getAttribute('id')
          return id !== null && id !== '' ? id : '(unnamed)'
        }
        interface RawElement {
          role: string
          name: string
          tag: string
          href: string | null
        }
        const elements: RawElement[] = []
        const nodes = Array.from(document.querySelectorAll(selector))
        let index = 0
        for (const el of nodes) {
          if (el.getClientRects().length === 0) continue
          const ref = `@e${index + 1}`
          index += 1
          el.setAttribute('data-dsh-ref', ref)
          const tag = el.tagName.toLowerCase()
          const role = el.getAttribute('role') ?? roleFromTag(tag, el)
          const name = accessibleName(el, tag)
          const href = tag === 'a' ? el.getAttribute('href') : null
          elements.push({ role, name, tag, href })
        }
        const text = document.body.innerText
        return { elements, text }
      },
      INTERACTIVE_SELECTOR,
    )
    const elements: BrowserElement[] = data.elements.slice(0, maxElements).map((el: BrowserElement, i: number) => ({
      ref: `@e${i + 1}`,
      role: el.role,
      name: el.name,
      tag: el.tag,
      ...(el.href !== null && el.href !== '' ? { href: el.href } : {}),
    }))
    const truncated = data.elements.length > maxElements || data.text.length > maxTextLength
    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      elements,
      text: data.text.slice(0, maxTextLength),
      truncated,
    }
  }

  async click(target: BrowserTarget, signal?: AbortSignal): Promise<void> {
    this.ensureOpen(signal)
    const locator = this.locatorFor(target)
    try {
      await locator.click({ timeout: this.timeoutMs })
    } catch (error) {
      throw classifyPlaywrightError(error, 'click')
    }
  }

  async type(target: BrowserTarget, text: string, signal?: AbortSignal): Promise<void> {
    this.ensureOpen(signal)
    const locator = this.locatorFor(target)
    try {
      await locator.fill(text, { timeout: this.timeoutMs })
    } catch (error) {
      throw classifyPlaywrightError(error, 'type')
    }
  }

  async evaluate(expression: string, signal?: AbortSignal): Promise<unknown> {
    this.ensureOpen(signal)
    try {
      return await this.page.evaluate(expression)
    } catch (error) {
      throw classifyPlaywrightError(error, 'evaluate')
    }
  }

  async screenshot(options: BrowserScreenshotOptions = {}, signal?: AbortSignal): Promise<BrowserScreenshot> {
    this.ensureOpen(signal)
    try {
      const buffer = options.selector !== undefined
        ? await this.page.locator(options.selector).screenshot({ timeout: this.timeoutMs })
        : await this.page.screenshot({ fullPage: options.fullPage ?? false, timeout: this.timeoutMs })
      return { buffer, mimeType: 'image/png' }
    } catch (error) {
      throw classifyPlaywrightError(error, 'screenshot')
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.browser.close().catch(() => undefined)
  }

  private locatorFor(target: BrowserTarget) {
    return target.kind === 'ref'
      ? this.page.locator(`[data-dsh-ref="${target.ref}"]`)
      : this.page.locator(target.selector)
  }

  private ensureOpen(signal?: AbortSignal): void {
    if (this.closed) throw new BrowserError('the browser session is closed; open a new one', BROWSER_CODES.NOT_OPEN)
    throwIfAborted(signal)
  }
}

/** Validate a navigation URL is http(s). */
function assertHttpUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new BrowserError(`invalid URL: ${url}`, BROWSER_CODES.INVALID_URL)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserError(`only http(s) URLs are supported, got "${parsed.protocol}"`, BROWSER_CODES.INVALID_URL)
  }
  return parsed.toString()
}

/** Throw `BROWSER_ABORTED` when the signal is already aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) {
    throw new BrowserError('the browser action was aborted', BROWSER_CODES.ABORTED)
  }
}

/** Classify a Playwright failure into a {@link BrowserError}. */
function classifyPlaywrightError(error: unknown, action: string): BrowserError {
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout/i.test(message)) {
    return new BrowserError(`browser ${action} timed out: ${message}`, BROWSER_CODES.TIMEOUT, { cause: error })
  }
  if (/target closed|browser has been closed|context closed/i.test(message)) {
    return new BrowserError(`browser ${action} failed (session closed): ${message}`, BROWSER_CODES.NOT_OPEN, { cause: error })
  }
  return new BrowserError(`browser ${action} failed: ${message}`, BROWSER_CODES.ACTION_FAILED, { cause: error })
}
