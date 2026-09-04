/**
 * `@deepseek-ai/dsh-web-fetch-cached`: registers a SQLite-cached
 * `WebFetchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): a fetch provider does not own the `ctx.web` key —
 * it registers INTO the seam's provider registry, exactly as
 * `@deepseek-ai/dsh-web-fetch-http` registers its backend. The key is owned
 * by `@deepseek-ai/dsh-web`.
 *
 * The page cache lives in the shared web store (`$DSH_HOME/web.db` by
 * default), the same `web_pages` table the search provider's enrichment
 * writes.
 *
 * @module @deepseek-ai/dsh-web-fetch-cached
 */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import { WebStore } from '../store/index.ts'
import { PRODUCT_USER_AGENT } from '../user-agent.ts'
import { CachedHttpFetchProvider } from './provider.ts'
import type { CachedFetchLimits } from './provider.ts'

export { CACHED_FETCH_PROVIDER_ID, CachedHttpFetchProvider } from './provider.ts'
export type { CachedFetchLimits } from './provider.ts'

/** Default `User-Agent`: an explicit product agent, never a browser disguise. */
export const DEFAULT_USER_AGENT = PRODUCT_USER_AGENT

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-cached'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config: transport limits (as `web-fetch-http`) plus cache settings (all defaulted except `cacheDir`). */
export interface Config {
  /** Maximum accepted request URL length. */
  maxUrlLength?: number
  /** Maximum response body size in bytes. */
  maxResponseBytes?: number
  /** Maximum decoded body length in characters. */
  maxBodyChars?: number
  /** Fetch timeout in milliseconds, within Node's timer range. */
  timeoutMs?: number
  /** Maximum number of same-origin redirect hops to follow. */
  maxRedirects?: number
  /** `User-Agent` header sent on every request. */
  userAgent?: string
  /** Time-to-live in milliseconds for cached pages. */
  cacheTtlMs?: number
  /** SQLite store path. Defaults to `$DSH_HOME/web.db`. */
  storePath?: string
  /** Issue conditional revalidation requests for fresh-but-expired entries. */
  revalidate?: boolean
  /**
   * Maximum number of page records kept in the store (LRU by last access).
   * Oldest (least-recently-accessed) pages beyond this cap are evicted after
   * each write. Defaults to 500. Set to 0 to disable the page cache entirely.
   */
  cacheMaxPages?: number
  /**
   * Allow requests to private/reserved network targets (loopback, LAN,
   * link-local). Defaults to false: the SSRF guard blocks these. Enable only
   * in a trusted, network-isolated environment.
   */
  allowPrivateNetworks?: boolean
}

export const Config: z<Config> = z.object({
  maxUrlLength: z.number().default(2048),
  maxResponseBytes: z.number().default(5_000_000),
  maxBodyChars: z.number().default(100_000),
  timeoutMs: z.number().default(30_000),
  maxRedirects: z.number().default(5),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  cacheTtlMs: z.number().default(21_600_000),
  revalidate: z.boolean().default(true),
  cacheMaxPages: z.number().default(500),
  allowPrivateNetworks: z.boolean().default(false),
})

/** Complete config after schemastery applies every field default (except `storePath`). */
type ResolvedConfig = Omit<Required<Config>, 'storePath'>

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

/** A resource limit (byte/char/length/timeout cap) must be a positive finite number. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-cached: ${name} must be a positive finite number`)
  }
}

/** Node coerces larger timer delays to 1 ms, so reject them at configuration time. */
function assertTimeoutMs(value: number): void {
  assertPositiveFinite('timeoutMs', value)
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-cached: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
  }
}

/** The redirect hop cap must be a non-negative integer (0 follows no redirects). */
function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`web-fetch-cached: ${name} must be a non-negative integer`)
  }
}

/** Optional apply options (used when the top-level plugin shares one store). */
export interface ApplyOptions {
  /** A shared store to use instead of creating one (caps are merged in). */
  store?: WebStore
}

/** Register the cached HTTP(S) fetch provider with `ctx.web`. */
export function apply(ctx: Context, config: Config, options: ApplyOptions = {}): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveFinite('maxUrlLength', resolved.maxUrlLength)
  assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  assertTimeoutMs(resolved.timeoutMs)
  assertNonNegativeInteger('maxRedirects', resolved.maxRedirects)
  assertPositiveFinite('cacheTtlMs', resolved.cacheTtlMs)
  assertNonNegativeInteger('cacheMaxPages', resolved.cacheMaxPages)
  let store: WebStore
  if (options.store !== undefined) {
    // Shared store (owned by the top-level plugin): merge this module's
    // resolved cap — the settings section is the authoritative source.
    options.store.setEvictLimits({ maxPages: resolved.cacheMaxPages })
    store = options.store
  } else {
    // Standalone: own the store and close it when this plugin's fiber is
    // disposed (HMR / context teardown).
    const owned = new WebStore({
      path: config.storePath ?? dshHomePath('web.db'),
      evictLimits: { maxPages: resolved.cacheMaxPages },
    })
    ctx.effect(function* () {
      yield () => {
        void owned.close()
      }
    }, 'web-fetch-cached.store.close()')
    store = owned
  }
  const limits: CachedFetchLimits = {
    maxUrlLength: resolved.maxUrlLength,
    maxResponseBytes: resolved.maxResponseBytes,
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
    maxRedirects: resolved.maxRedirects,
    userAgent: resolved.userAgent,
    cacheTtlMs: resolved.cacheTtlMs,
    store,
    revalidate: resolved.revalidate,
    allowPrivateNetworks: resolved.allowPrivateNetworks,
  }
  try {
    ctx.web.registerFetchProvider(new CachedHttpFetchProvider(limits))
  } catch (error) {
    // A duplicate id means the deployment ALSO loads DSH's built-in
    // web-fetch-cached (e.g. via the local-web overlay). The plugin and the
    // built-in packages are mutually exclusive — say so, instead of surfacing
    // the bare seam error.
    if (error instanceof WebError && error.code === 'WEB_DUPLICATE_PROVIDER') {
      throw new WebError(
        'the "cached-http" fetch provider is already registered: the dsh-web-automation plugin and DSH built-in web packages (e.g. the local-web overlay) are mutually exclusive — keep one',
        'WEB_DUPLICATE_PROVIDER',
        { cause: error },
      )
    }
    throw error
  }
}
