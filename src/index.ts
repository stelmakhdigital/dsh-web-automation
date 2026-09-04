/**
 * `dsh-web-automation` — a standalone DeepSeek Harness plugin that gives a
 * local model a local-first web stack: multi-engine keyless search (DuckDuckGo
 * + Bing by default, plus Exa/DeepSeek/Jina when their API keys are present),
 * a SQLite-cached fetch provider, the `web_platform_search` tool, and the
 * history/stats/cache tools. Everything runs against local state
 * (`$DSH_HOME/web.db`); no paid search API or third-party data broker is
 * required for the keyless engines.
 * @module dsh-web-automation
 */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'

import type { Config as FetchConfig } from './fetch/index.ts'
import { apply as applyFetch, Config as FetchConfigSchema } from './fetch/index.ts'
import type { Config as HistoryConfig } from './history/index.ts'
import { apply as applyHistory, Config as HistoryConfigSchema } from './history/index.ts'
import type { Config as PlatformsConfig } from './platforms/index.ts'
import { apply as applyPlatforms, Config as PlatformsConfigSchema } from './platforms/index.ts'
import type { Config as SearchConfig } from './search/index.ts'
import { apply as applySearch, Config as SearchConfigSchema } from './search/index.ts'
import { WebStore } from './store/index.ts'

/** The plugin name (Cordis companion identity). */
export const name = 'dsh-web-automation'

/** Services this plugin touches: the web seam, tools, and the system prompt. */
export const inject = ['web', 'tools', 'systemPrompt']

/**
 * Plugin config. Each capability is a nested block (search, fetch, platforms,
 * history) that defaults to its built-in values, so an empty config enables
 * the full local web stack.
 */
export interface Config {
  /** Multi-engine search provider settings. */
  search?: SearchConfig
  /** Cached HTTP(S) fetch provider settings. */
  fetch?: FetchConfig
  /** `web_platform_search` tool settings. */
  platforms?: PlatformsConfig
  /** History/stats/cache tool settings. */
  history?: HistoryConfig
}

export const Config: z<Config> = z.object({
  search: SearchConfigSchema.default({}),
  fetch: FetchConfigSchema.default({}),
  platforms: PlatformsConfigSchema.default({}),
  history: HistoryConfigSchema.default({}),
})

/**
 * Register the local web stack: the multi-engine search provider, the cached
 * fetch provider, the `web_platform_search` tool, and the history/stats/cache
 * tools. Each sub-capability applies its own defaults and validation.
 *
 * Store sharing: when every module uses the default store path
 * (`$DSH_HOME/web.db`), ONE `WebStore` is created here and shared by the
 * search, fetch, and history modules (one connection instead of three; WAL
 * keeps them safe either way). The store starts cap-less: each module merges
 * its own resolved eviction cap after resolving its config (the settings
 * section is the authoritative source for the caps). A custom `storePath` in
 * any module keeps that module on its own store. The shared store is closed
 * when this plugin's fiber is disposed.
 * @param ctx - the Cordis plugin context.
 * @param config - the resolved plugin config (schemastery has applied defaults).
 */
export function apply(ctx: Context, config: Config): void {
  const shared = config.search?.storePath === undefined
    && config.fetch?.storePath === undefined
    && config.history?.storePath === undefined
  let sharedStore: WebStore | undefined
  if (shared) {
    sharedStore = new WebStore({ path: dshHomePath('web.db') })
    const owned = sharedStore
    ctx.effect(function* () {
      yield () => {
        void owned.close()
      }
    }, 'web-automation.store.close()')
  }
  applySearch(ctx, config.search ?? {}, shared ? { store: sharedStore } : {})
  applyFetch(ctx, config.fetch ?? {}, shared ? { store: sharedStore } : {})
  applyPlatforms(ctx, config.platforms ?? {})
  applyHistory(ctx, config.history ?? {}, shared ? { store: sharedStore } : {})
}
