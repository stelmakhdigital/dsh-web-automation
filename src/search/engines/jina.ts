/**
 * `JinaEngine`: a search engine backed by the Jina search API
 * (`https://s.jina.ai/{query}`). Requires a Jina API key (resolved at plugin
 * `apply` time); without one the engine reports itself unavailable and the
 * router skips it.
 * @module @deepseek-ai/dsh-web-search-multi/engines/jina
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { classifyWebError, readCappedText } from '../http.ts'
import type { EngineSearchResult, SearchEngine } from './types.ts'

/** Engine options. */
export interface JinaEngineOptions {
  /** Resolved Jina API key (empty makes the engine unavailable). */
  apiKey?: string
  /**
   * Resolve the key per search (credential reference over the launch
   * environment). Wins over {@link apiKey} when it yields a value, so a key
   * written to the credentials domain takes effect without a restart.
   */
  resolveApiKey?: () => Promise<string | undefined>
  /** Endpoint base; the query path is appended. */
  baseURL?: string
  /** `User-Agent` header sent on every request. */
  userAgent: string
  /** Hard cap on one response body (bytes). */
  maxResponseBytes: number
}

/** Default Jina search endpoint base. */
export const JINA_DEFAULT_BASE_URL = 'https://s.jina.ai'

/** One item of the Jina search JSON response. */
interface JinaSearchItem {
  title?: string
  url?: string
  content?: string
  description?: string
}

/** The Jina API search engine. */
export class JinaEngine implements SearchEngine {
  readonly id = 'jina'

  constructor(private readonly options: JinaEngineOptions) {}

  /** Available when a key is present (static, or a resolver that may yield one). */
  available(): boolean {
    const hasKey = (this.options.apiKey?.length ?? 0) > 0 || this.options.resolveApiKey !== undefined
    return hasKey && URL.canParse(this.options.baseURL ?? JINA_DEFAULT_BASE_URL)
  }

  /** Run one search against the Jina API. */
  async search(query: string, maxResults: number, signal: AbortSignal): Promise<EngineSearchResult> {
    const apiKey = this.options.resolveApiKey !== undefined
      ? ((await this.options.resolveApiKey()) ?? this.options.apiKey ?? '')
      : (this.options.apiKey ?? '')
    const url = `${(this.options.baseURL ?? JINA_DEFAULT_BASE_URL).replace(/\/$/, '')}/${encodeURIComponent(query)}`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'user-agent': this.options.userAgent,
          'authorization': `Bearer ${apiKey}`,
          'accept': 'application/json',
          'x-retain-images': 'false',
        },
        signal,
      })
    } catch (error: unknown) {
      throw classifyWebError(error, signal, 'Jina search request failed')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new WebError(`Jina search request failed (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR')
    }
    let body: string
    try {
      body = await readCappedText(response, this.options.maxResponseBytes)
    } catch (error: unknown) {
      throw classifyWebError(error, signal, 'Jina search body read failed')
    }
    let parsed: { data?: JinaSearchItem[] }
    try {
      parsed = JSON.parse(body) as { data?: JinaSearchItem[] }
    } catch (error: unknown) {
      throw new WebError(`Jina search returned a non-JSON response: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    const sources: WebSearchSource[] = []
    for (const item of parsed.data ?? []) {
      if (item.url === undefined || item.url.length === 0) continue
      sources.push({
        url: item.url,
        ...(item.title !== undefined && item.title.length > 0 ? { title: item.title } : {}),
        ...(item.description !== undefined && item.description.length > 0
          ? { snippet: item.description }
          : item.content !== undefined && item.content.length > 0
            ? { snippet: item.content.slice(0, 300) }
            : {}),
      })
      if (sources.length >= maxResults) break
    }
    return { sources }
  }
}
