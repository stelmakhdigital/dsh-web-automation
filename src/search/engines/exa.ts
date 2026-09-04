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
 * @module @deepseek-ai/dsh-web-search-multi/engines/exa
 */

import { ExaSearchProvider, EXA_DEFAULT_BASE_URL } from '@deepseek-ai/dsh-web-search-exa'
import type { EngineSearchResult, SearchEngine } from './types.ts'

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
  private provider: ExaSearchProvider

  constructor(options: ExaEngineOptions) {
    this.options = options
    this.cachedKey = options.apiKey ?? ''
    this.provider = this.buildProvider(this.cachedKey)
  }

  private buildProvider(apiKey: string): ExaSearchProvider {
    return new ExaSearchProvider({
      apiKey,
      baseURL: this.options.baseURL ?? EXA_DEFAULT_BASE_URL,
      searchType: this.options.searchType ?? 'auto',
      highlightsPerResult: this.options.highlightsPerResult ?? 3,
    })
  }

  /** Available when a key is present (static, or a resolver that may yield one). */
  available(): boolean {
    return this.cachedKey.length > 0 || this.options.resolveApiKey !== undefined
  }

  /** Delegate to the wrapped provider, resolving the key per search when a resolver is set. */
  async search(query: string, maxResults: number, signal: AbortSignal): Promise<EngineSearchResult> {
    if (this.options.resolveApiKey !== undefined) {
      const resolved = (await this.options.resolveApiKey()) ?? ''
      if (resolved !== this.cachedKey) {
        this.cachedKey = resolved
        this.provider = this.buildProvider(resolved)
      }
    }
    const result = await this.provider.search({ query, maxResults }, signal)
    return { sources: result.sources, ...result.content !== undefined ? { content: result.content } : {} }
  }
}
