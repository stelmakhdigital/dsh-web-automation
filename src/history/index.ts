/**
 * `@deepseek-ai/dsh-tool-web-history`: model-facing tools over the shared web
 * store (`$DSH_HOME/web.db`): `web_history` (recent searches/fetches),
 * `web_cache_clear` (clear search/page cache), and `web_search_stats`
 * (storage statistics).
 *
 * @module @deepseek-ai/dsh-tool-web-history
 */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { WebStore } from '../store/index.ts'
import type { StoredPage, StoredSearch, WebStoreStats } from '../store/index.ts'

export { WebStore } from '../store/index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-web-history'

/** Services required by the web history tool suite. */
export const inject = ['tools', 'systemPrompt']

/** Default upper bound on one `web_history` call. */
export const WEB_HISTORY_MAX_LIMIT = 100

/** Plugin config: which tools to register and the store path. */
export interface Config {
  /** Register `web_history`. Defaults to true. */
  history?: boolean
  /** Register `web_cache_clear`. Defaults to true. */
  cacheClear?: boolean
  /** Register `web_search_stats`. Defaults to true. */
  stats?: boolean
  /** SQLite store path. Defaults to `$DSH_HOME/web.db`. */
  storePath?: string
}

export const Config: z<Config> = z.object({
  history: z.boolean().default(true),
  cacheClear: z.boolean().default(true),
  stats: z.boolean().default(true),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Omit<Config, 'storePath'>>

/** Format one search history line. */
function searchLine(entry: StoredSearch): string {
  const when = new Date(entry.createdAt).toISOString()
  const engines = entry.engines.join('+')
  return `- [${when}] search "${entry.query}" (${engines}) — ${entry.sources.length} source(s)`
}

/** Format one fetch history line. */
function fetchLine(entry: StoredPage): string {
  const when = new Date(entry.fetchedAt).toISOString()
  return `- [${when}] fetch ${entry.url} — HTTP ${entry.statusCode}, ${entry.body.length} char(s)`
}

/** Render the `web_history` output. */
export function formatHistoryOutput(args: { kind: 'search' | 'fetch' | 'all' }, searches: readonly StoredSearch[], pages: readonly StoredPage[]): string {
  const sections: string[] = []
  if (args.kind === 'search' || args.kind === 'all') {
    sections.push(args.kind === 'all' ? 'Recent searches:' : '')
    sections.push(searches.length > 0 ? searches.map(searchLine).join('\n') : 'No search history.')
  }
  if (args.kind === 'fetch' || args.kind === 'all') {
    sections.push(args.kind === 'all' ? 'Recent fetches:' : '')
    sections.push(pages.length > 0 ? pages.map(fetchLine).join('\n') : 'No fetch history.')
  }
  return sections.filter(section => section.length > 0).join('\n')
}

/** Render the `web_search_stats` output. */
export function formatStatsOutput(stats: WebStoreStats): string {
  const lines: string[] = [
    `Searches stored: ${stats.searches}`,
    `Pages stored: ${stats.pages}`,
    `Page body bytes: ${stats.pageBytes}`,
  ]
  if (stats.lastSearchAt !== undefined) lines.push(`Last search: ${new Date(stats.lastSearchAt).toISOString()}`)
  if (stats.lastPageAt !== undefined) lines.push(`Last fetch: ${new Date(stats.lastPageAt).toISOString()}`)
  return lines.join('\n')
}

/** Optional apply options (used when the top-level plugin shares one store). */
export interface ApplyOptions {
  /** A shared store to use instead of creating one. */
  store?: WebStore
}

/** Register the enabled web history tools. */
export function apply(ctx: Context, config: Config, options: ApplyOptions = {}): void {
  const resolved = config as ResolvedConfig
  let store: WebStore
  if (options.store !== undefined) {
    // Shared store (owned by the top-level plugin); the history tools only
    // read/clear, so no eviction cap is merged.
    store = options.store
  } else {
    // Standalone: own the store and close it when this plugin's fiber is
    // disposed (HMR / context teardown).
    const owned = new WebStore({ path: config.storePath ?? dshHomePath('web.db') })
    ctx.effect(function* () {
      yield () => {
        void owned.close()
      }
    }, 'tool-web-history.store.close()')
    store = owned
  }

  ctx.systemPrompt.section({
    name: 'tool:web_history',
    order: 115,
    text: 'Use web_history to review recent web searches and fetches, web_search_stats for web storage statistics, and web_cache_clear to clear the web search/page cache. These tools read the shared local web store; they make no network requests.',
  })

  if (resolved.history) {
    ctx.tools.register(defineTool({
      name: 'web_history',
      description: 'Show recent web search and fetch history from the local web store. No network requests.',
      parameters: {
        kind: { type: 'string', enum: ['search', 'fetch', 'all'], description: 'History kind. Defaults to "all".' },
        query: { type: 'string', description: 'Optional substring filter on the query or URL.' },
        limit: { type: 'number', description: `Maximum entries to return (1–${WEB_HISTORY_MAX_LIMIT}). Defaults to 20.` },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
      },
      isConcurrencySafe: () => true,
      async execute(args): Promise<JsonValue> {
        const kind = args.kind ?? 'all'
        const query = typeof args.query === 'string' ? args.query.toLowerCase() : undefined
        const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 20), 1), WEB_HISTORY_MAX_LIMIT)
        const searches = kind === 'fetch' ? [] : await store.recentSearches(limit)
        const pages = kind === 'search' ? [] : await store.recentPages(limit)
        const filteredSearches = query === undefined ? searches : searches.filter(entry => entry.query.toLowerCase().includes(query))
        const filteredPages = query === undefined ? pages : pages.filter(entry => entry.url.toLowerCase().includes(query))
        return { text: formatHistoryOutput({ kind }, filteredSearches, filteredPages) }
      },
    }))
  }

  if (resolved.stats) {
    ctx.tools.register(defineTool({
      name: 'web_search_stats',
      description: 'Show web store statistics (stored searches, pages, bytes). No network requests.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
      },
      isConcurrencySafe: () => true,
      async execute(): Promise<JsonValue> {
        const stats = await store.stats()
        return { text: formatStatsOutput(stats) }
      },
    }))
  }

  if (resolved.cacheClear) {
    ctx.tools.register(defineTool({
      name: 'web_cache_clear',
      description: 'Clear the local web search and/or page cache. No network requests.',
      parameters: {
        scope: { type: 'string', enum: ['search', 'pages', 'all'], description: 'What to clear. Defaults to "all".' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
      },
      async execute(args): Promise<JsonValue> {
        const scope = args.scope ?? 'all'
        const cleared: string[] = []
        if (scope === 'search' || scope === 'all') cleared.push(`searches: ${await store.clearSearches()}`)
        if (scope === 'pages' || scope === 'all') cleared.push(`pages: ${await store.clearPages()}`)
        return { text: `Cleared web cache — ${cleared.join(', ')}` }
      },
    }))
  }
}
