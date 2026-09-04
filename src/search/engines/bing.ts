/**
 * `BingEngine`: a keyless search engine backed by the Bing HTML SERP.
 * Server-rendered results parsed with cheerio; a consent/challenge page is a
 * provider failure (the router cools the engine down and falls through).
 * @module @deepseek-ai/dsh-web-search-multi/engines/bing
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { isBlockedBingSerp, parseBingSerp } from '../bingparse.ts'
import { classifyWebError, readCappedText } from '../http.ts'
import { RateLimiter } from '../rate-limit.ts'
import { normalizeUrl } from '../url.ts'
import type { EngineSearchResult, SearchEngine } from './types.ts'

/** Engine options. */
export interface BingEngineOptions {
  /** SERP endpoint (absolute URL). */
  endpoint: string
  /** Region/market hint (`setmkt` parameter, e.g. `en-US`); empty allowed. */
  market: string
  /** `User-Agent` header sent on every request. */
  userAgent: string
  /** Search-request rate limit (requests per second). */
  rateLimitPerSec: number
  /** Hard cap on one SERP body (bytes). */
  maxSerpBytes: number
  /** Domains (suffix match) excluded from results. */
  blockedDomains: readonly string[]
}

/** Default Bing SERP endpoint. */
export const BING_DEFAULT_ENDPOINT = 'https://www.bing.com/search'

/** The keyless Bing HTML search engine. */
export class BingEngine implements SearchEngine {
  readonly id = 'bing'
  private readonly limiter: RateLimiter

  constructor(private readonly options: BingEngineOptions) {
    this.limiter = new RateLimiter({ perSec: options.rateLimitPerSec })
  }

  /** Cheap local check: the endpoint must parse as an absolute URL. No network. */
  available(): boolean {
    return URL.canParse(this.options.endpoint)
  }

  /** Fetch and parse one SERP. */
  async search(query: string, maxResults: number, signal: AbortSignal): Promise<EngineSearchResult> {
    const html = await this.fetchSerp(query, maxResults, signal)
    if (isBlockedBingSerp(html)) {
      throw new WebError(
        'Bing returned a consent or challenge page instead of results; slow down or try again later',
        'WEB_PROVIDER_ERROR',
      )
    }
    return { sources: this.filterAndDedupe(parseBingSerp(html)).slice(0, maxResults) }
  }

  private serpUrl(query: string, maxResults: number): string {
    const url = new URL(this.options.endpoint)
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(Math.min(maxResults, 50)))
    if (this.options.market.length > 0) url.searchParams.set('setmkt', this.options.market)
    return url.toString()
  }

  /** Fetch the SERP document; block-like failures surface as `WebError`. */
  private async fetchSerp(query: string, maxResults: number, signal: AbortSignal): Promise<string> {
    await this.limiter.acquire(signal)
    let response: Response
    try {
      response = await fetch(this.serpUrl(query, maxResults), {
        method: 'GET',
        redirect: 'follow',
        headers: { 'user-agent': this.options.userAgent, 'accept': 'text/html' },
        signal,
      })
    } catch (error: unknown) {
      throw classifyWebError(error, signal, 'Bing search request failed')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new WebError(`Bing search request failed (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR')
    }
    try {
      return await readCappedText(response, this.options.maxSerpBytes)
    } catch (error: unknown) {
      throw classifyWebError(error, signal, 'Bing search body read failed')
    }
  }

  /** Drop blocked domains and duplicate URLs (first occurrence wins). */
  private filterAndDedupe(results: readonly { url: string; title: string; snippet: string }[]): WebSearchSource[] {
    const seen = new Set<string>()
    const sources: WebSearchSource[] = []
    for (const result of results) {
      const key = normalizeUrl(result.url)
      if (seen.has(key)) continue
      if (this.isBlockedDomain(result.url)) continue
      seen.add(key)
      sources.push({
        url: result.url,
        ...result.title.length > 0 ? { title: result.title } : {},
        ...result.snippet.length > 0 ? { snippet: result.snippet } : {},
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
