/**
 * `SearXNGEngine`: a self-hosted metasearch engine backed by a SearXNG
 * instance's JSON API. SearXNG aggregates multiple search engines (Google,
 * Bing, DuckDuckGo, etc.) behind a single local endpoint, so the plugin gets
 * multi-engine results without calling any external API or data broker.
 *
 * The JSON API must be enabled on the SearXNG instance (`search.formats:
 * [html, json]` in `settings.yml`). The engine queries
 * `{endpoint}/search?q=...&format=json` and maps the results to
 * `WebSearchSource`.
 * @module dsh-web-automation/search/engines/searxng
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { classifyWebError, readCappedText } from '../http.ts'
import { RateLimiter } from '../rate-limit.ts'
import { normalizeUrl } from '../url.ts'
import type { EngineSearchResult, SearchEngine } from './types.ts'

/** Engine options. */
export interface SearXNGEngineOptions {
  /** SearXNG instance base URL (e.g., `http://localhost:8080`). */
  endpoint: string
  /** `User-Agent` header sent on every request. */
  userAgent: string
  /** Search-request rate limit (requests per second). */
  rateLimitPerSec: number
  /** Hard cap on one response body (bytes). */
  maxSerpBytes: number
  /** Domains (suffix match) excluded from results. */
  blockedDomains: readonly string[]
}

/** Default SearXNG endpoint (local instance). */
export const SEARXNG_DEFAULT_ENDPOINT = 'http://localhost:8080'

/** One raw SearXNG JSON result. */
interface SearXNGResult {
  url?: string
  title?: string
  content?: string
  engine?: string
  score?: number
}

/** The self-hosted SearXNG metasearch engine. */
export class SearXNGEngine implements SearchEngine {
  readonly id = 'searxng'
  private readonly limiter: RateLimiter

  constructor(private readonly options: SearXNGEngineOptions) {
    this.limiter = new RateLimiter({ perSec: options.rateLimitPerSec })
  }

  /** Cheap local check: the endpoint must parse as an absolute URL. No network. */
  available(): boolean {
    return URL.canParse(this.endpoint())
  }

  /** Query the SearXNG JSON API and map the results. */
  async search(query: string, maxResults: number, signal: AbortSignal): Promise<EngineSearchResult> {
    const body = await this.fetchJson(query, signal)
    const results = (body.results ?? []) as SearXNGResult[]
    return { sources: this.filterAndDedupe(results).slice(0, maxResults) }
  }

  private endpoint(): string {
    return this.options.endpoint.replace(/\/$/, '')
  }

  private searchUrl(query: string): string {
    const params = new URLSearchParams({ q: query, format: 'json' })
    return `${this.endpoint()}/search?${params.toString()}`
  }

  /** Fetch and parse one SearXNG JSON response. */
  private async fetchJson(query: string, signal: AbortSignal): Promise<{ results?: SearXNGResult[] }> {
    await this.limiter.acquire(signal)
    let response: Response
    try {
      response = await fetch(this.searchUrl(query), {
        method: 'GET',
        redirect: 'follow',
        headers: { 'user-agent': this.options.userAgent, 'accept': 'application/json' },
        signal,
      })
    } catch (error: unknown) {
      throw classifyWebError(error, signal, 'SearXNG search request failed')
    }
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 403 || response.status === 429 || response.status === 503) {
        throw new WebError(
          `SearXNG blocked the search request (HTTP ${response.status}); slow down or try again later`,
          'WEB_PROVIDER_ERROR',
        )
      }
      throw new WebError(`SearXNG search request failed (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR')
    }
    let text: string
    try {
      text = await readCappedText(response, this.options.maxSerpBytes)
    } catch (error: unknown) {
      throw classifyWebError(error, signal, 'SearXNG search body read failed')
    }
    try {
      return JSON.parse(text) as { results?: SearXNGResult[] }
    } catch {
      throw new WebError('SearXNG returned a non-JSON response (is the JSON API enabled?)', 'WEB_PROVIDER_ERROR')
    }
  }

  /** Drop blocked domains and duplicate URLs (first occurrence wins). */
  private filterAndDedupe(results: readonly SearXNGResult[]): WebSearchSource[] {
    const seen = new Set<string>()
    const sources: WebSearchSource[] = []
    for (const result of results) {
      if (result.url === undefined || result.url.length === 0) continue
      const key = normalizeUrl(result.url)
      if (seen.has(key)) continue
      if (this.isBlockedDomain(result.url)) continue
      seen.add(key)
      sources.push({
        url: result.url,
        ...(result.title?.length ? { title: result.title } : {}),
        ...(result.content?.length ? { snippet: result.content } : {}),
      })
    }
    return sources
  }

  private isBlockedDomain(url: string): boolean {
    if (this.options.blockedDomains.length === 0) return false
    let hostname: string
    try {
      hostname = new URL(url).hostname.toLowerCase()
    } catch {
      return true
    }
    return this.options.blockedDomains.some((domain) => {
      const normalized = domain.toLowerCase().replace(/^\./, '')
      return hostname === normalized || hostname.endsWith(`.${normalized}`)
    })
  }
}
