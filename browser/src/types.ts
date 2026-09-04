/**
 * Vocabulary for the browser automation capability (`ctx.browser`). A browser is a
 * long-lived, stateful session (unlike the stateless search/fetch seam), so the
 * contract is a {@link BrowserProvider} that opens a {@link BrowserSession}, plus
 * the request/result shapes the session methods exchange.
 * @module @deepseek-ai/dsh-web-browser/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Typed browser error with a machine-routable, open-string `code` and chained
 * `cause`. Shared codes cover unavailable/missing providers, a missing open
 * session, invalid URLs, approval denial, missing auth profiles, and provider
 * action failure; the Playwright provider additionally distinguishes timeout and
 * abort. Tool execution exposes the code in structured error metadata.
 */
export class BrowserError extends HarnessError {}

/** Machine-routable browser error codes. */
export const BROWSER_CODES = {
  UNAVAILABLE: 'BROWSER_UNAVAILABLE',
  DUPLICATE_PROVIDER: 'BROWSER_DUPLICATE_PROVIDER',
  NOT_OPEN: 'BROWSER_NOT_OPEN',
  ALREADY_OPEN: 'BROWSER_ALREADY_OPEN',
  INVALID_URL: 'BROWSER_INVALID_URL',
  ACTION_FAILED: 'BROWSER_ACTION_FAILED',
  TIMEOUT: 'BROWSER_TIMEOUT',
  ABORTED: 'BROWSER_ABORTED',
  APPROVAL_DENIED: 'BROWSER_APPROVAL_DENIED',
  APPROVAL_UNAVAILABLE: 'BROWSER_APPROVAL_UNAVAILABLE',
  AUTH_MISSING: 'BROWSER_AUTH_MISSING',
} as const

/** Options for opening a browser session. */
export interface BrowserOpenOptions {
  /** Run the browser headless (no visible window). Default `true`. */
  readonly headless?: boolean
  /** Name of a configured auth profile (storage state) to restore. */
  readonly authProfile?: string
  /** Per-action timeout in milliseconds; falls back to the provider default. */
  readonly timeoutMs?: number
}

/** The outcome of a navigation. */
export interface BrowserNavigateResult {
  /** The final URL after redirects. */
  readonly url: string
  /** The document title, when the page exposes one. */
  readonly title?: string
}

/** Options for a page snapshot. */
export interface BrowserSnapshotOptions {
  /** Upper bound on the visible-text length; the provider truncates and flags it. */
  readonly maxTextLength?: number
  /** Upper bound on the number of interactive elements returned. */
  readonly maxElements?: number
}

/** One interactive element surfaced in a snapshot, addressable by its `ref`. */
export interface BrowserElement {
  /** Stable per-snapshot handle (e.g. `@e1`) for click/type. */
  readonly ref: string
  /** The ARIA role (link, button, textbox, checkbox, ...). */
  readonly role: string
  /** The accessible name (link text, button label, input placeholder/label). */
  readonly name: string
  /** The lower-cased tag name (a, button, input, ...). */
  readonly tag: string
  /** The href, for links. */
  readonly href?: string
}

/** A normalized view of the current page for a model to reason over. */
export interface BrowserSnapshot {
  /** The current page URL. */
  readonly url: string
  /** The document title. */
  readonly title: string
  /** Interactive elements, in DOM order, each addressable by `ref`. */
  readonly elements: readonly BrowserElement[]
  /** The visible page text, truncated to `maxTextLength`. */
  readonly text: string
  /** True when the provider cut `text` or `elements` to honor the bounds. */
  readonly truncated: boolean
}

/**
 * Where a click/type targets. Exactly one of `ref` (from the most recent
 * snapshot) or `selector` (a CSS selector) is set.
 */
export type BrowserTarget =
  | { readonly kind: 'ref'; readonly ref: string }
  | { readonly kind: 'selector'; readonly selector: string }

/** Options for a screenshot. */
export interface BrowserScreenshotOptions {
  /** Capture the full scrollable page, not just the viewport. */
  readonly fullPage?: boolean
  /** Capture a single element (CSS selector) instead of the page. */
  readonly selector?: string
}

/** A captured screenshot (PNG bytes). */
export interface BrowserScreenshot {
  readonly buffer: Buffer
  readonly mimeType: 'image/png'
}

/**
 * A live browser session. Opened by a {@link BrowserProvider}; every method
 * honors `signal` for cancellation (except `close`). A session is single-page:
 * one page is active at a time.
 */
export interface BrowserSession {
  /** The provider that opened this session. */
  readonly providerId: string
  /** The current page URL (`about:blank` before the first navigation). */
  url(): string
  /** Navigate the active page to `url` and wait for load. */
  navigate(url: string, signal?: AbortSignal): Promise<BrowserNavigateResult>
  /** Capture a normalized snapshot of the current page. */
  snapshot(options?: BrowserSnapshotOptions, signal?: AbortSignal): Promise<BrowserSnapshot>
  /** Click the element addressed by `target`. */
  click(target: BrowserTarget, signal?: AbortSignal): Promise<void>
  /** Type `text` into the element addressed by `target` (replacing its value). */
  type(target: BrowserTarget, text: string, signal?: AbortSignal): Promise<void>
  /** Evaluate JavaScript in the page context and return the JSON-serializable result. */
  evaluate(expression: string, signal?: AbortSignal): Promise<unknown>
  /** Capture a PNG screenshot of the page (or one element). */
  screenshot(options?: BrowserScreenshotOptions, signal?: AbortSignal): Promise<BrowserScreenshot>
  /** Close the session and release the browser. Idempotent. */
  close(): Promise<void>
}

/**
 * A browser backend. Registered with `ctx.browser.registerProvider`. `id` is a
 * stable string, unique among registered providers.
 */
export interface BrowserProvider {
  readonly id: string
  /** Cheap local usability check; must not launch a browser. */
  available(): boolean
  /** Launch a browser session. */
  open(options: BrowserOpenOptions, signal?: AbortSignal): Promise<BrowserSession>
}
