/**
 * `@deepseek-ai/dsh-web-search-multi`: registers a multi-engine
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): a search provider does not own the `ctx.web` key —
 * it registers INTO the seam's provider registry, exactly as the other
 * `web-search-*` packages do. The key is owned by `@deepseek-ai/dsh-web`.
 *
 * Engines: `ddg` and `bing` are keyless (always available); `exa`,
 * `deepseek`, and `jina` require API keys resolved from the config or the
 * launch environment at `apply` time.
 *
 * @module @deepseek-ai/dsh-web-search-multi
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { WebStore } from '../store/index.ts'
import { BING_DEFAULT_ENDPOINT, BingEngine } from './engines/bing.ts'
import { DUCKDUCKGO_DEFAULT_ENDPOINT, DuckDuckGoEngine } from './engines/ddg.ts'
import { DeepSeekEngine } from './engines/deepseek.ts'
import { ExaEngine } from './engines/exa.ts'
import { JINA_DEFAULT_BASE_URL, JinaEngine } from './engines/jina.ts'
import type { SearchEngine } from './engines/types.ts'
import { MultiSearchProvider } from './provider.ts'

export { MULTI_SEARCH_PROVIDER_ID, MultiSearchProvider, filterAndDedupe, searchCacheKey } from './provider.ts'
export type { MultiSearchProviderOptions } from './provider.ts'
export type { EngineSearchResult, SearchEngine } from './engines/types.ts'

/** Default `User-Agent`: an explicit product agent, never a browser disguise. */
export const DEFAULT_USER_AGENT = 'deepseek-harness/0.1.1 (+https://github.com/deepseek-ai)'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-multi'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Settings namespace carrying the multi-engine search configuration. */
export const WEB_SEARCH_MULTI_SETTINGS_NAMESPACE = settingsNamespace('web-search-multi')

/** Engine-specific config blocks. */
export interface EngineConfig {
  /** Literal API key; wins over `apiKeyEnv`. */
  apiKey?: string
  /** Environment variable name to resolve the key from. */
  apiKeyEnv?: string
  /** Endpoint base override. */
  baseURL?: string
}

/** DeepSeek engine config (extends the common key fields). */
export interface DeepSeekEngineConfig extends EngineConfig {
  /** Anthropic-format model name. */
  model?: string
  /** Maximum `web_search` server-tool uses per request. */
  maxUses?: number
}

/** Plugin config (all fields defaulted except the engine blocks). */
export interface Config {
  /** Ordered engine ids to consider. */
  engines?: string[]
  /** Force a single engine id (error when unavailable). */
  engine?: string
  /** 'fallback' = first success wins; 'fuse' = parallel + RRF merge. */
  mode?: 'fallback' | 'fuse'
  /** Region/market hint (DDG `kl`, Bing `setmkt`). */
  region?: string
  /** Enrich top results with fetched page text + BM25 re-rank. */
  enrich?: boolean
  /** How many top candidates to fetch for enrichment. */
  enrichFetchLimit?: number
  /** How many enriched sources to keep. */
  enrichKeep?: number
  /** Concurrent enrichment page fetches. */
  enrichConcurrency?: number
  /** Per-enrichment-page fetch timeout (ms). */
  pageTimeoutMs?: number
  /** Snippet window size (chars). */
  snippetChars?: number
  /** Search cache TTL (ms). */
  searchCacheTtlMs?: number
  /** Page cache TTL (ms). */
  pageCacheTtlMs?: number
  /** SQLite store path. Defaults to `$DSH_HOME/web.db`. */
  storePath?: string
  /** Search-request rate limit per engine (requests per second). */
  rateLimitPerSec?: number
  /** `User-Agent` header sent on every request. */
  userAgent?: string
  /** Domains (suffix match) excluded from results. */
  blockedDomains?: string[]
  /** Overall search timeout (ms). */
  timeoutMs?: number
  /** Cooldown base after the first engine failure (ms). */
  cooldownBaseMs?: number
  /** Cooldown cap (ms). */
  cooldownMaxMs?: number
  /** Exa engine settings. */
  exa?: EngineConfig
  /** DeepSeek engine settings. */
  deepseek?: DeepSeekEngineConfig
  /** Jina engine settings. */
  jina?: EngineConfig
}

export const Config: z<Config> = z.object({
  engines: z.array(z.string()).default(['ddg', 'bing', 'exa', 'deepseek', 'jina']),
  mode: z.union(['fallback', 'fuse']).default('fallback'),
  region: z.string().default(''),
  enrich: z.boolean().default(true),
  enrichFetchLimit: z.number().default(10),
  enrichKeep: z.number().default(5),
  enrichConcurrency: z.number().default(4),
  pageTimeoutMs: z.number().default(10_000),
  snippetChars: z.number().default(300),
  searchCacheTtlMs: z.number().default(900_000),
  pageCacheTtlMs: z.number().default(21_600_000),
  rateLimitPerSec: z.number().default(1),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  blockedDomains: z.array(z.string()).default([]),
  timeoutMs: z.number().default(30_000),
  cooldownBaseMs: z.number().default(30_000),
  cooldownMaxMs: z.number().default(3_600_000),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Omit<Config, 'engine' | 'storePath' | 'exa' | 'deepseek' | 'jina'>>

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

/** A resource limit (byte/char/length/timeout cap) must be a positive finite number. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`web-search-multi: ${name} must be a positive finite number`)
  }
}

/** Node coerces larger timer delays to 1 ms, so reject them at configuration time. */
function assertTimeoutMs(value: number): void {
  assertPositiveFinite('timeoutMs', value)
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`web-search-multi: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
  }
}

/** Resolve an engine API key: literal config wins, then the launch environment. */
function resolveKey(config: EngineConfig | undefined, defaultEnv: string, env: ReturnType<typeof launchEnvironmentOf>): string {
  if (config?.apiKey !== undefined && config.apiKey.length > 0) return config.apiKey
  const ref = config?.apiKeyEnv ?? defaultEnv
  return env.get(ref)?.value ?? ''
}

/**
 * Build a per-search key resolver for one engine: the credential named by
 * `ref` wins, then the launch environment. Resolving per search (rather than
 * once at `apply`) lets a key written to the credentials domain take effect
 * without a restart.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param ref - the credential reference (environment variable name) to resolve.
 * @returns a resolver yielding the key, or undefined when no layer holds one.
 */
function makeResolver(ctx: Context, ref: string): () => Promise<string | undefined> {
  const credential = credentialRef(ref)
  return async () => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(credential)
      if (resolved !== undefined && resolved.value.length > 0) return resolved.value
    }
    const ambient = launchEnvironmentOf(ctx).get(ref)
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }
}

/** Register the multi-engine search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  // The settings section's resolved value (schema defaults → composition base
  // → user layer) is the authoritative source for the schema fields, so a
  // committed edit to engines/mode/region applies on the next launch. The
  // registration carries no resolved value: the provider is built once from
  // the current section, so a committed change needs no re-registration here.
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_MULTI_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
  })
  // schemastery (Config) has already filled every defaulted field.
  const resolved = current() as ResolvedConfig
  assertPositiveFinite('enrichFetchLimit', resolved.enrichFetchLimit)
  assertPositiveFinite('enrichKeep', resolved.enrichKeep)
  assertPositiveFinite('enrichConcurrency', resolved.enrichConcurrency)
  assertPositiveFinite('pageTimeoutMs', resolved.pageTimeoutMs)
  assertPositiveFinite('snippetChars', resolved.snippetChars)
  assertPositiveFinite('searchCacheTtlMs', resolved.searchCacheTtlMs)
  assertPositiveFinite('pageCacheTtlMs', resolved.pageCacheTtlMs)
  assertPositiveFinite('rateLimitPerSec', resolved.rateLimitPerSec)
  assertTimeoutMs(resolved.timeoutMs)
  assertPositiveFinite('cooldownBaseMs', resolved.cooldownBaseMs)
  assertPositiveFinite('cooldownMaxMs', resolved.cooldownMaxMs)

  // Runtime guard for direct `apply` callers that bypass schemastery.
  const mode: string = resolved.mode
  if (mode !== 'fallback' && mode !== 'fuse') {
    throw new Error(`web-search-multi: mode must be "fallback" or "fuse", got "${mode}"`)
  }
  const env = launchEnvironmentOf(ctx)
  const store = new WebStore({ path: config.storePath ?? dshHomePath('web.db') })
  const engines: SearchEngine[] = [
    new DuckDuckGoEngine({
      endpoint: DUCKDUCKGO_DEFAULT_ENDPOINT,
      region: resolved.region,
      userAgent: resolved.userAgent,
      rateLimitPerSec: resolved.rateLimitPerSec,
      maxSerpBytes: 5_000_000,
      blockedDomains: resolved.blockedDomains,
    }),
    new BingEngine({
      endpoint: BING_DEFAULT_ENDPOINT,
      market: resolved.region,
      userAgent: resolved.userAgent,
      rateLimitPerSec: resolved.rateLimitPerSec,
      maxSerpBytes: 5_000_000,
      blockedDomains: resolved.blockedDomains,
    }),
    new ExaEngine({
      apiKey: resolveKey(config.exa, 'EXA_API_KEY', env),
      resolveApiKey: makeResolver(ctx, config.exa?.apiKeyEnv ?? 'EXA_API_KEY'),
      ...(config.exa?.baseURL !== undefined ? { baseURL: config.exa.baseURL } : {}),
    }),
    new DeepSeekEngine({
      apiKey: resolveKey(config.deepseek, 'DEEPSEEK_API_KEY', env),
      resolveApiKey: makeResolver(ctx, config.deepseek?.apiKeyEnv ?? 'DEEPSEEK_API_KEY'),
      ...(config.deepseek?.baseURL !== undefined ? { baseURL: config.deepseek.baseURL } : {}),
      ...(config.deepseek?.model !== undefined ? { model: config.deepseek.model } : {}),
      ...(config.deepseek?.maxUses !== undefined ? { maxUses: config.deepseek.maxUses } : {}),
    }),
    new JinaEngine({
      apiKey: resolveKey(config.jina, 'JINA_API_KEY', env),
      resolveApiKey: makeResolver(ctx, config.jina?.apiKeyEnv ?? 'JINA_API_KEY'),
      baseURL: config.jina?.baseURL ?? JINA_DEFAULT_BASE_URL,
      userAgent: resolved.userAgent,
      maxResponseBytes: 5_000_000,
    }),
  ]
  const engineById = new Map(engines.map(engine => [engine.id, engine]))

  const provider = new MultiSearchProvider({
    engines: resolved.engines,
    ...(config.engine !== undefined ? { forcedEngine: config.engine } : {}),
    mode: resolved.mode,
    defaultMaxResults: 10,
    store,
    engineById,
    enrich: resolved.enrich,
    enrichFetchLimit: resolved.enrichFetchLimit,
    enrichKeep: resolved.enrichKeep,
    searchCacheTtlMs: resolved.searchCacheTtlMs,
    pageCacheTtlMs: resolved.pageCacheTtlMs,
    timeoutMs: resolved.timeoutMs,
    cooldownBaseMs: resolved.cooldownBaseMs,
    cooldownMaxMs: resolved.cooldownMaxMs,
    enrichOptions: {
      pageTimeoutMs: resolved.pageTimeoutMs,
      pageCacheTtlMs: resolved.pageCacheTtlMs,
      maxPageBytes: 5_000_000,
      maxBodyChars: 100_000,
      snippetChars: resolved.snippetChars,
      userAgent: resolved.userAgent,
      concurrency: resolved.enrichConcurrency,
    },
  })
  ctx.web.registerSearchProvider(provider)
}
