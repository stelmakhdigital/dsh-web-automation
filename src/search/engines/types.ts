/**
 * The engine contract for `dsh-web-search-multi`: one search backend behind a
 * uniform interface. Engines are built by the plugin's `apply` (which owns
 * credential resolution) and handed to the provider in an id-keyed map.
 * @module @deepseek-ai/dsh-web-search-multi/engines/types
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'

/** One engine's raw search output (pre-routing, pre-enrichment). */
export interface EngineSearchResult {
  /** Ranked result sources (engine order = engine rank). */
  sources: readonly WebSearchSource[]
  /** Optional merged answer text (API engines that return one). */
  content?: string
}

/** A single search backend. */
export interface SearchEngine {
  /** Stable engine id (config, cache keys, diagnostics). */
  readonly id: string
  /**
   * Cheap local availability check (no network). An unavailable engine is
   * skipped by the router; a forced unavailable engine is an error.
   */
  available(): boolean
  /**
   * Run one search. The provider always passes its deadline signal so engine
   * failures classify against it. Throws {@link import('@deepseek-ai/dsh-web').WebError} on failure.
   */
  search(query: string, maxResults: number, signal: AbortSignal): Promise<EngineSearchResult>
}
