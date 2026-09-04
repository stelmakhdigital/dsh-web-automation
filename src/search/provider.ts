/**
 * `MultiSearchProvider`: a `WebSearchProvider` that routes one search across
 * multiple engines (keyless HTML engines, API engines) with fallback or
 * RRF-fusion semantics, per-engine failure cooldowns, a persistent search
 * cache (web store), and local BM25 enrichment of the top candidates.
 *
 * The model-facing surface stays the standard `web_search` tool: the engine
 * mix, order, and mode are deployment/user configuration, not model choices.
 * @module @deepseek-ai/dsh-web-search-multi/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { WebStore } from '../store/index.ts'
import { enrichSources, type EnrichOptions } from './enrich.ts'
import { EngineCooldown } from './cooldown.ts'
import { reciprocalRankFuse } from './rrf.ts'
import { normalizeUrl } from './url.ts'
import type { EngineSearchResult, SearchEngine } from './engines/types.ts'

/** Stable id this provider registers under. */
export const MULTI_SEARCH_PROVIDER_ID = 'multi'

/** Provider options (built by the plugin's `apply`). */
export interface MultiSearchProviderOptions {
  /** Ordered engine ids to consider (already filtered to built engines). */
  engines: readonly string[]
  /** Forced single engine id; an error when unavailable. */
  forcedEngine?: string
  /** 'fallback' = first success wins; 'fuse' = parallel + RRF merge. */
  mode: 'fallback' | 'fuse'
  /** Default result count when a request carries none. */
  defaultMaxResults: number
  /** The shared web store (search cache + history + page cache). */
  store: WebStore
  /** Engine instances keyed by id. */
  engineById: ReadonlyMap<string, SearchEngine>
  /** Enrich top results with fetched page text + BM25 re-rank. */
  enrich: boolean
  /** How many top candidates to fetch for enrichment. */
  enrichFetchLimit: number
  /** How many enriched sources to keep. */
  enrichKeep: number
  /** Search cache TTL (ms). */
  searchCacheTtlMs: number
  /** Page cache TTL (ms). */
  pageCacheTtlMs: number
  /** Overall search timeout (ms). */
  timeoutMs: number
  /** Cooldown base (ms). */
  cooldownBaseMs: number
  /** Cooldown cap (ms). */
  cooldownMaxMs: number
  /** Enrichment options (page fetches). */
  enrichOptions: Omit<EnrichOptions, 'store'>
  /** Optional structured logger (observability). When set, search operations are logged. */
  logger?: { info: (message: string, ...meta: unknown[]) => void }
}

/** The multi-engine search provider. */
export class MultiSearchProvider implements WebSearchProvider {
  readonly id = MULTI_SEARCH_PROVIDER_ID
  private readonly cooldown: EngineCooldown

  constructor(private readonly options: MultiSearchProviderOptions) {
    this.cooldown = new EngineCooldown({ baseMs: options.cooldownBaseMs, maxMs: options.cooldownMaxMs })
  }

  /** At least one built engine must be available. */
  available(): boolean {
    return [...this.options.engineById.values()].some(engine => engine.available())
  }

  /** Run one search: cache check, routing, enrichment, history. */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const query = request.query.trim()
    if (query.length === 0) return { sources: [], truncated: false }
    const maxResults = request.maxResults ?? this.options.defaultMaxResults
    const startedAt = Date.now()

    // 1. Search cache: a fresh cached result short-circuits the whole operation.
    const cacheKey = searchCacheKey(query, this.options.engines, this.options.mode)
    const cached = await this.options.store.readSearch(cacheKey).catch(() => undefined)
    if (cached !== undefined && Date.now() - cached.createdAt < this.options.searchCacheTtlMs) {
      // The store is type-agnostic (`sources` is opaque JSON); the recorded
      // rows always came from this provider's own `WebSearchSource[]`.
      this.options.logger?.info('web-search: cache hit', { query, sources: (cached.sources as readonly unknown[]).length, latencyMs: Date.now() - startedAt })
      return cloneSearchResult({
        sources: cached.sources as readonly WebSearchSource[],
        ...cached.content !== undefined ? { content: cached.content } : {},
        truncated: cached.truncated,
      })
    }

    // 2. Routing under the overall backstop deadline.
    using d = deadline(signal, this.options.timeoutMs, 'WEB_SEARCH_TIMEOUT')
    const engineIds = this.selectEngines()
    if (engineIds.length === 0) {
      throw new WebError(
        'no search engine is available (missing credentials or all engines cooling down)',
        'WEB_PROVIDER_ERROR',
      )
    }
    const candidateLimit = Math.max(maxResults, this.options.enrichFetchLimit)
    const routed = this.options.mode === 'fuse' && engineIds.length > 1
      ? await this.fuse(engineIds, query, candidateLimit, d.signal)
      : await this.fallback(engineIds, query, candidateLimit, d.signal)

    let sources = filterAndDedupe(routed.sources)
    const content = routed.content

    // 3. Enrichment: fetch the top candidates, extract text, re-rank locally.
    if (this.options.enrich && sources.length > 1) {
      const keep = Math.min(this.options.enrichKeep, maxResults, sources.length)
      sources = await enrichSources(query, sources.slice(0, this.options.enrichFetchLimit), keep, {
        store: this.options.store,
        ...this.options.enrichOptions,
      }, d.signal)
    }

    const truncated = sources.length >= maxResults
    const result: WebSearchResult = {
      sources,
      ...content !== undefined ? { content } : {},
      truncated,
    }
    await this.options.store.recordSearch({
      cacheKey,
      query,
      engines: engineIds,
      createdAt: Date.now(),
      sources,
      truncated,
      ...content !== undefined ? { content } : {},
    }).catch(() => undefined)
    this.options.logger?.info('web-search: completed', { query, engines: engineIds, sources: sources.length, latencyMs: Date.now() - startedAt })
    return cloneSearchResult(result)
  }

  /** Resolve the engine list: forced engine, or ordered list minus unavailable/cooldown. */
  private selectEngines(): string[] {
    if (this.options.forcedEngine !== undefined) {
      const engine = this.options.engineById.get(this.options.forcedEngine)
      if (engine === undefined || !engine.available()) {
        throw new WebError(
          `forced search engine "${this.options.forcedEngine}" is not available`,
          'WEB_PROVIDER_ERROR',
        )
      }
      return [this.options.forcedEngine]
    }
    return this.options.engines.filter((id) => {
      const engine = this.options.engineById.get(id)
      return engine !== undefined && engine.available() && !this.cooldown.isCoolingDown(id)
    })
  }

  /** Sequential fallback: the first engine returning results wins. */
  private async fallback(ids: readonly string[], query: string, maxResults: number, signal: AbortSignal): Promise<EngineSearchResult> {
    const errors: string[] = []
    for (const id of ids) {
      const engine = this.options.engineById.get(id)
      if (engine === undefined) continue
      try {
        const result = await engine.search(query, maxResults, signal)
        this.cooldown.recordSuccess(id)
        if (result.sources.length > 0) return result
        errors.push(`${id}: no results`)
      } catch (error: unknown) {
        if (signal.aborted) throw toWebError(error, 'web search aborted')
        this.cooldown.recordFailure(id)
        errors.push(`${id}: ${errorMessage(error)}`)
      }
    }
    throw new WebError(`all search engines failed: ${errors.join('; ')}`, 'WEB_PROVIDER_ERROR')
  }

  /** Parallel fuse: all engines run; successes merge via RRF. */
  private async fuse(ids: readonly string[], query: string, maxResults: number, signal: AbortSignal): Promise<EngineSearchResult> {
    const settled = await Promise.allSettled(
      ids.map((id) => {
        const engine = this.options.engineById.get(id)
        if (engine === undefined) return Promise.resolve<EngineSearchResult>({ sources: [] })
        return engine.search(query, maxResults, signal)
      }),
    )
    const errors: string[] = []
    const lists: WebSearchSource[][] = []
    settled.forEach((outcome, index) => {
      const id = ids[index]
      if (id === undefined) return
      if (outcome.status === 'fulfilled') {
        this.cooldown.recordSuccess(id)
        if (outcome.value.sources.length > 0) lists.push([...outcome.value.sources])
        else errors.push(`${id}: no results`)
      } else {
        if (signal.aborted) throw toWebError(outcome.reason, 'web search aborted')
        this.cooldown.recordFailure(id)
        errors.push(`${id}: ${errorMessage(outcome.reason)}`)
      }
    })
    if (lists.length === 0) {
      throw new WebError(`all search engines failed: ${errors.join('; ')}`, 'WEB_PROVIDER_ERROR')
    }
    return { sources: reciprocalRankFuse(lists) }
  }
}

/**
 * Build the search cache key from the normalized query, engine list, and
 * mode. @param query - the trimmed query.
 * @param engines - the ordered engine list.
 * @param mode - the routing mode.
 * @returns the cache key.
 */
export function searchCacheKey(query: string, engines: readonly string[], mode: string): string {
  const normalized = query.toLowerCase().replace(/\s+/g, ' ')
  return `multi:${mode}:${[...engines].join(',')}:${normalized}`
}

/** Drop duplicate URLs across the merged list (first occurrence wins). */
export function filterAndDedupe(sources: readonly WebSearchSource[]): WebSearchSource[] {
  const seen = new Set<string>()
  const result: WebSearchSource[] = []
  for (const source of sources) {
    const key = normalizeUrl(source.url)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ ...source })
  }
  return result
}

/** Translate an unknown thrown value into a `WebError`. */
function toWebError(error: unknown, message: string): WebError {
  if (error instanceof WebError) return error
  return new WebError(message, 'WEB_ABORTED', { cause: error })
}

/** A short human-readable failure message. */
function errorMessage(error: unknown): string {
  if (error instanceof WebError) return error.message
  return String(error)
}

/** Defensive copy so callers never mutate the cached result. */
function cloneSearchResult(result: WebSearchResult): WebSearchResult {
  return {
    sources: result.sources.map(source => ({ ...source })),
    ...result.content !== undefined ? { content: result.content } : {},
    truncated: result.truncated,
  }
}
