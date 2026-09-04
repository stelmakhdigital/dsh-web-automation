/**
 * `@deepseek-ai/dsh-web-platforms`: a config-driven web platform registry and
 * the model-facing `web_platform_search` tool. Platforms are defined by a
 * search-URL template plus result selectors (HTML), field paths (JSON), an
 * embedded-JSON marker (JSON-in-HTML), or a feed reader (RSS). Built-in
 * platforms (GitHub, Reddit, YouTube, Bilibili, V2EX, RSS) can be overridden or
 * extended via config or versioned rule packs (hot-reloaded by mtime).
 * @module @deepseek-ai/dsh-web-platforms
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { BUILTIN_PLATFORMS } from './builtins.ts'
import { PlatformRegistry } from './registry.ts'
import { validatePlatform } from './rulepacks.ts'
import { searchPlatform } from './search.ts'
import { PLATFORM_SEARCH_MAX_LIMIT, type PlatformSearchResult, type PlatformSource } from './types.ts'

export { BUILTIN_PLATFORMS } from './builtins.ts'
export { PlatformRegistry, mergePlatforms } from './registry.ts'
export type { PlatformRegistryOptions } from './registry.ts'
export { importRulePack, exportRulePack, validatePlatform, validateRulePack } from './rulepacks.ts'
export { searchPlatform } from './search.ts'
export type { PlatformSearchDeps } from './search.ts'
export { expandTemplate, isPlausibleSearchUrl } from './template.ts'
export { parseHtmlResults } from './parse-html.ts'
export { parseJsonResults, resolvePath, extractJsonAfterMarker } from './parse-json.ts'
export { parseRssResults } from './parse-rss.ts'
export { RULE_PACK_VERSION } from './types.ts'
export type { Platform, PlatformFormat, HtmlSelectors, JsonFields, JsonInHtml, PlatformSource, PlatformSearchResult, PlatformSearchArgs, RulePack } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-platforms'

/** Services required by the web platform suite. */
export const inject = ['tools', 'systemPrompt']

/** Settings namespace carrying the web platform tool configuration. */
export const WEB_PLATFORMS_SETTINGS_NAMESPACE = settingsNamespace('web-platforms')

/** Default cap on sources returned by one `web_platform_search` call. */
export const DEFAULT_PLATFORM_MAX_RESULTS = 20

/** Default cooperative per-search timeout budget (ms). */
export const DEFAULT_PLATFORM_TIMEOUT_MS = 30_000

/** Default cap on one fetched platform body (bytes; 5 MiB). */
export const DEFAULT_PLATFORM_MAX_BYTES = 5_242_880

/**
 * Plugin config: which tool to register, search bounds, and the platform
 * sources. `platforms` are raw platform objects (validated at apply time);
 * `rulePackPaths` are rule-pack JSON files hot-reloaded by mtime.
 */
export interface Config {
  /** Register `web_platform_search`. Defaults to true. */
  tool?: boolean
  /** Upper bound on sources returned by one call. Defaults to 20. */
  maxResults?: number
  /** Cooperative per-search timeout budget (ms). Defaults to 30000. */
  timeoutMs?: number
  /** Cap on one fetched platform body (bytes). Defaults to 5242880. */
  maxBytes?: number
  /** Platform definitions (override built-ins by id, or add new ones). */
  platforms?: unknown[]
  /** Rule-pack JSON file paths (highest precedence; hot-reloaded). */
  rulePackPaths?: string[]
}

export const Config: z<Config> = z.object({
  tool: z.boolean().default(true),
  maxResults: z.number().default(DEFAULT_PLATFORM_MAX_RESULTS),
  timeoutMs: z.number().default(DEFAULT_PLATFORM_TIMEOUT_MS),
  maxBytes: z.number().default(DEFAULT_PLATFORM_MAX_BYTES),
  platforms: z.array(z.any()).default([]),
  rulePackPaths: z.array(z.string()).default([]),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Configured counts and caps must be positive integers. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`web-platforms: ${name} must be a positive integer`)
  }
}

/** Project one source into the model-facing output shape. */
function projectSource(source: PlatformSource): { url: string; title?: string; snippet?: string; publishedAt?: string } {
  return {
    url: source.url,
    ...(source.title !== undefined ? { title: source.title } : {}),
    ...(source.snippet !== undefined ? { snippet: source.snippet } : {}),
    ...(source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {}),
  }
}

/** Render the `web_platform_search` output as text. */
export function formatPlatformOutput(result: PlatformSearchResult): string {
  const lines: string[] = [`Platform: ${result.platform}`, `Query: ${result.query}`, '']
  if (result.sources.length === 0) {
    lines.push('No results.')
  } else {
    result.sources.forEach((source, index) => {
      const title = source.title !== undefined ? ` — ${source.title}` : ''
      lines.push(`${index + 1}. ${source.url}${title}`)
      if (source.snippet !== undefined) lines.push(`   ${source.snippet}`)
    })
    if (result.truncated) lines.push(`(truncated to ${result.sources.length} results)`)
  }
  return lines.join('\n')
}

/**
 * Register the web platform tool. The platform registry merges built-ins,
 * configured platforms, and rule-pack files; the tool is always registered when
 * enabled and fails with a structured error at execution time for unknown
 * platforms or fetch failures.
 */
export function apply(ctx: Context, config: Config): void {
  // The settings section's resolved value (schema defaults → composition base
  // → user layer) is the authoritative source, so a committed edit applies on
  // the next launch. The registration carries no resolved value: the tool is
  // built once from the current section, so a committed change needs no
  // re-registration here.
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_PLATFORMS_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
  })
  // schemastery (Config) has already filled every defaulted field.
  const resolved = current() as ResolvedConfig
  assertPositiveInteger('maxResults', resolved.maxResults)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  assertPositiveInteger('maxBytes', resolved.maxBytes)

  const configured = resolved.platforms.map((raw, index) => validatePlatform(raw, `platforms[${index}]`))
  const registry = new PlatformRegistry({
    builtins: BUILTIN_PLATFORMS,
    configured,
    rulePackPaths: resolved.rulePackPaths,
  })

  ctx.systemPrompt.section({
    name: 'tool:web_platform_search',
    order: 117,
    text: 'Use web_platform_search to search a specific platform instead of a general web search. Built-in platforms: github, reddit, youtube, bilibili, v2ex, rss (plus any configured platforms). For the rss platform, pass the feed URL as the query. It returns a list of result URLs with optional titles and snippets.',
  })

  if (!resolved.tool) return
  ctx.tools.register(defineTool({
    name: 'web_platform_search',
    description: 'Search a specific web platform (github, reddit, youtube, bilibili, v2ex, rss, or a configured platform) and return its results. For rss, the query is a feed URL.',
    parameters: {
      platform: { type: 'string', required: true, description: 'The platform id to search (e.g. "github", "reddit", "rss").' },
      query: { type: 'string', required: true, description: 'The search query; for the rss platform this is the feed URL.' },
      limit: { type: 'number', description: `Maximum number of results to return (1–${PLATFORM_SEARCH_MAX_LIMIT}). Defaults to ${DEFAULT_PLATFORM_MAX_RESULTS}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          platform: { type: 'string', required: true },
          query: { type: 'string', required: true },
          sources: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                title: { type: 'string' },
                snippet: { type: 'string' },
                publishedAt: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatPlatformOutput(value as PlatformSearchResult) }],
    },
    timeoutMs: resolved.timeoutMs,
    // Platform reads do not mutate parent-agent state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const result = await searchPlatform(
        { platform: args.platform, query: args.query, ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) },
        { registry, timeoutMs: resolved.timeoutMs, maxBytes: resolved.maxBytes, maxResults: resolved.maxResults },
        exec.signal,
      )
      return {
        platform: result.platform,
        query: result.query,
        sources: result.sources.map(projectSource),
        truncated: result.truncated,
      }
    },
  }))
}
