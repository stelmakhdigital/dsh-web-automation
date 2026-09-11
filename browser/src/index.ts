/**
 * `@deepseek-ai/dsh-web-browser`: browser automation for DSH. Mounts the
 * `ctx.browser` seam, registers a local Playwright (Chromium) provider, and
 * exposes the model-facing `browser_*` tools (open, navigate, snapshot, click,
 * type, evaluate, screenshot, close). Auth profiles (saved login state) and
 * approval-gated sensitive actions are configurable.
 * @module @deepseek-ai/dsh-web-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import BrowserRuntime from './runtime.ts'
import { PlaywrightProvider } from './playwright.ts'
import { registerBrowserTools, type BrowserApprovalMode } from './tools.ts'

export { BrowserRuntime } from './runtime.ts'
export type { BrowserRuntimeConfig } from './runtime.ts'
export { PlaywrightProvider } from './playwright.ts'
export type { PlaywrightProviderConfig } from './playwright.ts'
export { registerBrowserTools } from './tools.ts'
export type { BrowserApprovalMode, BrowserToolOptions } from './tools.ts'
export { BrowserError, BROWSER_CODES } from './types.ts'
export type {
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

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-browser'

/** Services required by the web browser suite. */
export const inject = ['tools', 'systemPrompt']

/** Settings namespace carrying the browser automation configuration. */
export const WEB_BROWSER_SETTINGS_NAMESPACE = 'web-browser'

/** Default cooperative per-action timeout budget (ms). */
export const DEFAULT_BROWSER_TIMEOUT_MS = 30_000

/** Default snapshot visible-text bound. */
export const DEFAULT_BROWSER_MAX_TEXT_LENGTH = 20_000

/** Default snapshot element bound. */
export const DEFAULT_BROWSER_MAX_ELEMENTS = 200

/**
 * Plugin config. `authProfiles` maps a profile name to a Playwright
 * storage-state file path (a saved login). `approval` gates sensitive actions
 * (navigate/evaluate, plus click/type in `all` mode) behind the approval service.
 */
export interface Config {
  /** Register the `browser_*` tools. Defaults to true. */
  tool?: boolean
  /** Run the browser headless by default. Defaults to true. */
  headless?: boolean
  /** Approval policy for sensitive actions. Defaults to `'never'`. */
  approval?: BrowserApprovalMode
  /** Cooperative per-action timeout budget (ms). Defaults to 30000. */
  timeoutMs?: number
  /** Default snapshot visible-text bound. Defaults to 20000. */
  maxTextLength?: number
  /** Default snapshot element bound. Defaults to 200. */
  maxElements?: number
  /** Auth profiles: name → storage-state file path. */
  authProfiles?: Record<string, string>
  /**
   * Allow navigation to private/reserved network targets (loopback, LAN,
   * link-local). Defaults to false: the SSRF guard blocks these. Enable only
   * in a trusted, network-isolated environment.
   */
  allowPrivateNetworks?: boolean
}

export const Config: z<Config> = z.object({
  tool: z.boolean().default(true),
  headless: z.boolean().default(true),
  approval: z.union(['never', 'navigate', 'all'] as const).default('never'),
  timeoutMs: z.number().default(DEFAULT_BROWSER_TIMEOUT_MS),
  maxTextLength: z.number().default(DEFAULT_BROWSER_MAX_TEXT_LENGTH),
  maxElements: z.number().default(DEFAULT_BROWSER_MAX_ELEMENTS),
  authProfiles: z.dict(z.string()).default({}),
  allowPrivateNetworks: z.boolean().default(false),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Configured bounds must be positive integers. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`web-browser: ${name} must be a positive integer`)
  }
}

/**
 * Mount the `ctx.browser` seam, register the Playwright provider, and register
 * the `browser_*` tools. The provider is registered even when the tools are
 * disabled so a host can drive `ctx.browser` directly.
 */
export function apply(ctx: Context, config: Config): void {
  // The settings section's resolved value (schema defaults → composition base
  // → user layer) is the authoritative source, so a committed edit applies on
  // the next launch. The registration carries no resolved value: the provider
  // is built once from the current section, so a committed change needs no
  // re-registration here.
  let current: () => Config = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, WEB_BROWSER_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source: () => Config) => {
        current = source
      },
      onChange: () => {},
    })
  })
  const resolved = current() as ResolvedConfig
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  assertPositiveInteger('maxTextLength', resolved.maxTextLength)
  assertPositiveInteger('maxElements', resolved.maxElements)

  // Instantiate the seam directly (not via `ctx.plugin`) so `browser` is
  // registered in THIS fiber's store; `ctx.plugin` would create a child fiber
  // that the upward service walk never reaches. Disposal of this plugin's fiber
  // unregisters the service and runs its `closeAll` effect.
  new BrowserRuntime(ctx, {})
  ctx.browser.registerProvider(new PlaywrightProvider({
    headless: resolved.headless,
    timeoutMs: resolved.timeoutMs,
    maxTextLength: resolved.maxTextLength,
    maxElements: resolved.maxElements,
    authProfiles: resolved.authProfiles,
    allowPrivateNetworks: resolved.allowPrivateNetworks,
  }))

  ctx.systemPrompt.section({
    name: 'tool:browser',
    order: 118,
    text: 'Drive a local browser with the browser_* tools: browser_open (once), then browser_navigate + browser_snapshot to see a page, then browser_click / browser_type (by snapshot ref like "@e3" or a CSS selector), browser_evaluate for page state, browser_screenshot for a PNG, and browser_close when done. Take a snapshot after any action that changes the page.',
  })

  if (!resolved.tool) return
  registerBrowserTools(ctx, { approval: resolved.approval })
}
