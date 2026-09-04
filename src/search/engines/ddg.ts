/**
 * `DuckDuckGoEngine`: a keyless search engine backed by the DuckDuckGo HTML
 * endpoint. It parses the server-rendered SERP, decodes the `uddg` redirect
 * wrapper, and filters blocked domains. No credentials, no cloud account.
 * @module @deepseek-ai/dsh-web-search-multi/engines/ddg
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { classifyWebError, readCappedText } from '../http.ts'
import { RateLimiter } from '../rate-limit.ts'
import { isBlockedSerp, parseDuckDuckGoSerp, type SerpResult } from '../serpparse.ts'
import { normalizeUrl } from '../url.ts'
import type { EngineSearchResult, SearchEngine } from './types.ts'

/** Engine options. */
export interface DuckDuckGoEngineOptions {
  /** SERP endpoint (absolute URL). */
  endpoint: string
  /** Region hint (`kl` parameter); empty allowed. */
  region: string
  /** `User-Agent` header sent on every request. */
  userAgent: string
  /** Search-request rate limit (requests per second). */
  rateLimitPerSec: number
  /** Hard cap on one SERP body (bytes). */
  maxSerpBytes: number
  /** Domains (suffix match) excluded from results. */
  blockedDomains: readonly string[]
}

/** Default DuckDuckGo HTML SERP endpoint. */
export const DUCKDUCKGO_DEFAULT_ENDPOINT = 'https://html.duckduckgo.com/html/'

/** The keyless DuckDuckGo HTML search engine. */
export class DuckDuckGoEngine implements SearchEngine {
  readonly id = 'ddg'
  private readonly limiter: RateLimiter

  constructor(private readonly options: DuckDuckGoEngineOptions) {
    this.limiter = new RateLimiter({ perSec: options.rateLimitPerSec })
  }

  /** Cheap local check: the endpoint must parse as an absolute URL. No network. */
  available(): boolean {
    return URL.canParse(this.endpoint())
  }

  /** Fetch and parse one SERP. */
  async search(query: string, maxResults: number, signal: AbortSignal): Promise<EngineSearchResult> {
    const html = await this.fetchSerp(query, signal)
    if (isBlockedSerp(html)) {
      throw new WebError(
        'DuckDuckGo returned a bot challenge instead of results; slow down or try again later',
        'WEB_PROVIDER_ERROR',
      )
    }
    return { sources: this.filterAndDedupe(parseDuckDuckGoSerp(html)).slice(0, maxResults) }
  }

  private endpoint(): string {
    return this.options.endpoint.endsWith('/') ? this.options.endpoint : `${this.options.endpoint}/`
  }

  private serpUrl(query: string): string {
    const params = new URLSearchParams({ q: query })
    if (this.options.region.length > 0) params.set('kl', this.options.region)
    const base = this.endpoint()
    const separator = base.includes('?') ? '&' : '?'
    return `${base}${separator}${params.toString()}`
  }

  /** Fetch the SERP document; block-like failures surface as `WebError`. */
  private async fetchSerp(query: string, signal: AbortSignal): Promise<string> {
    await this.limiter.acquire(signal)
    let response: Response
    try {
      response = await fetch(this.serpUrl(query), {
        method: 'GET',
        redirect: 'follow',
        headers: { 'user-agent': this.options.userAgent, 'accept': 'text/html' },
        signal,
      })
    } catch (error: unknown) {
      throw classifyWebError(error, signal, 'DuckDuckGo search request failed')
    }
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 403 || response.status === 429 || response.status === 503) {
        throw new WebError(
          `DuckDuckGo blocked the search request (HTTP ${response.status}); slow down or try again later`,
          'WEB_PROVIDER_ERROR',
        )
      }
      throw new WebError(`DuckDuckGo search request failed (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR')
    }
    try {
      return await readCappedText(response, this.options.maxSerpBytes)
    } catch (error: unknown) {
      throw classifyWebError(error, signal, 'DuckDuckGo search body read failed')
    }
  }

  /** Drop blocked domains and duplicate URLs (first occurrence wins). */
  private filterAndDedupe(results: readonly SerpResult[]): WebSearchSource[] {
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
