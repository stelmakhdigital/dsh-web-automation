/**
 * `ExaEngine`: wraps the `ExaSearchProvider` from
 * `@deepseek-ai/dsh-web-search-exa` as a routing engine. The API key is
 * resolved from the config override or the launch environment at plugin
 * `apply` time, and re-resolved per search when a resolver is set (the
 * credentials domain, so a key written there takes effect without a
 * restart).
 *
 * `available()` reports *potentially* available: true when a static key is
 * present OR a resolver is set (the resolver may yield a key at search time).
 * A search issued without any key fails with a provider error, which the
 * router's cooldown handles — the engine is not silently skipped.
 *
 * The `@deepseek-ai/dsh-web-search-exa` package is OPTIONAL: it is not part
 * of the host DSH dependency graph, so it is loaded lazily on the first exa
 * search. A deployment without the package still loads the plugin; an exa
 * search then fails with a clear `WEB_ENGINE_UNAVAILABLE` error, which the
 * router's cooldown handles like any engine failure.
 * @module @deepseek-ai/dsh-web-search-multi/engines/exa
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { EngineSearchResult, SearchEngine } from './types.ts'

/** The optional exa package, loaded lazily (see the module docs). */
type ExaModule = typeof import('@deepseek-ai/dsh-web-search-exa')

/** The `ExaSearchProvider` instance type from the lazily loaded module. */
type ExaProvider = InstanceType<ExaModule['ExaSearchProvider']>

let exaModuleLoad: Promise<ExaModule> | undefined

/** Load the exa package on first use (the promise is cached, success or failure). */
function loadExaModule(): Promise<ExaModule> {
  exaModuleLoad ??= import('@deepseek-ai/dsh-web-search-exa')
  return exaModuleLoad
}

/** Engine options. */
export interface ExaEngineOptions {
  /** Resolved Exa API key (empty is fine when a resolver may yield one). */
  apiKey?: string
  /**
   * Resolve the key per search (credential reference over the launch
   * environment). Wins over {@link apiKey} when it yields a value, so a key
   * written to the credentials domain takes effect without a restart.
   */
  resolveApiKey?: () => Promise<string | undefined>
  /** Endpoint base; `/search` is appended. */
  baseURL?: string
  /** Retrieval mode sent as Exa's `type`. */
  searchType?: 'auto' | 'keyword' | 'neural'
  /** Highlight sentences requested per result. */
  highlightsPerResult?: number
}

/** The Exa API search engine. */
export class ExaEngine implements SearchEngine {
  readonly id = 'exa'
  private readonly options: ExaEngineOptions
  private cachedKey: string
  private provider: ExaProvider | undefined
  private providerKey: string | undefined

  constructor(options: ExaEngineOptions) {
    this.options = options
    this.cachedKey = options.apiKey ?? ''
  }

  /** Available when a key is present (static, or a resolver that may yield one). */
  available(): boolean {
    return this.cachedKey.length > 0 || this.options.resolveApiKey !== undefined
  }

  /**
   * Delegate to the wrapped provider, loading the optional package on first
   * use and resolving the key per search when a resolver is set.
   */
  async search(query: string, maxResults: number, signal: AbortSignal): Promise<EngineSearchResult> {
    let mod: ExaModule
    try {
      mod = await loadExaModule()
    } catch (error) {
      throw new WebError(
        'the exa engine is enabled, but the @deepseek-ai/dsh-web-search-exa package is not installed in this deployment; remove "exa" from search.engines or install the package',
        'WEB_ENGINE_UNAVAILABLE',
        { cause: error },
      )
    }
    if (this.options.resolveApiKey !== undefined) {
      const resolved = (await this.options.resolveApiKey()) ?? ''
      if (resolved !== this.cachedKey) this.cachedKey = resolved
    }
    if (this.provider === undefined || this.providerKey !== this.cachedKey) {
      this.provider = new mod.ExaSearchProvider({
        apiKey: this.cachedKey,
        baseURL: this.options.baseURL ?? mod.EXA_DEFAULT_BASE_URL,
        searchType: this.options.searchType ?? 'auto',
        highlightsPerResult: this.options.highlightsPerResult ?? 3,
      })
      this.providerKey = this.cachedKey
    }
    const result = await this.provider.search({ query, maxResults }, signal)
    return { sources: result.sources, ...result.content !== undefined ? { content: result.content } : {} }
  }
}
