/**
 * `DeepSeekEngine`: wraps the `DeepSeekSearchProvider` from
 * `@deepseek-ai/dsh-web-search-deepseek` as a routing engine. The API key is
 * resolved once at plugin `apply` time (config override or launch
 * environment); without a key the engine reports itself unavailable and the
 * router skips it.
 * @module @deepseek-ai/dsh-web-search-multi/engines/deepseek
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekSearchProvider,
} from '@deepseek-ai/dsh-web-search-deepseek'
import type { EngineSearchResult, SearchEngine } from './types.ts'

/** Engine options. */
export interface DeepSeekEngineOptions {
  /** Resolved DeepSeek API key (empty makes the engine unavailable). */
  apiKey?: string
  /**
   * Resolve the key per search (credential reference over the launch
   * environment). The wrapped provider resolves it on every request, so a key
   * written to the credentials domain takes effect without a restart.
   */
  resolveApiKey?: () => Promise<string | undefined>
  /** Endpoint base; `/messages` is appended. */
  baseURL?: string
  /** Anthropic-format model name. */
  model?: string
  /** Maximum `web_search` server-tool uses per request. */
  maxUses?: number
}

/** The DeepSeek official search engine. */
export class DeepSeekEngine implements SearchEngine {
  readonly id = 'deepseek'
  private readonly provider: DeepSeekSearchProvider

  constructor(options: DeepSeekEngineOptions) {
    this.provider = new DeepSeekSearchProvider(() => ({
      baseURL: options.baseURL ?? DEEPSEEK_DEFAULT_BASE_URL,
      model: options.model ?? DEEPSEEK_DEFAULT_MODEL,
      apiVersion: DEEPSEEK_DEFAULT_API_VERSION,
      maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
      maxUses: options.maxUses ?? DEEPSEEK_DEFAULT_MAX_USES,
      ...(options.apiKey !== undefined && options.apiKey.length > 0 ? { apiKey: options.apiKey } : {}),
      ...(options.resolveApiKey !== undefined ? { resolveApiKey: options.resolveApiKey } : {}),
      apiKeyEnv: credentialRef('DEEPSEEK_API_KEY'),
    }))
  }

  /** Available when a key is present (static, or a resolver that may yield one). */
  available(): boolean {
    return this.provider.available()
  }

  /** Delegate to the wrapped provider. */
  async search(query: string, maxResults: number, signal: AbortSignal): Promise<EngineSearchResult> {
    const result = await this.provider.search({ query, maxResults }, signal)
    return { sources: result.sources, ...result.content !== undefined ? { content: result.content } : {} }
  }
}
