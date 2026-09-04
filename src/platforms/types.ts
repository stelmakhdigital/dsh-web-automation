/**
 * Vocabulary for the config-driven web platform registry. A {@link Platform}
 * describes how to build a search URL and how to parse its results; the
 * registry merges built-in, configured, and rule-pack platforms and the
 * `web_platform_search` tool executes one.
 * @module @deepseek-ai/dsh-web-platforms/types
 */

/** Result content format a platform produces. */
export type PlatformFormat = 'html' | 'json' | 'rss' | 'json-in-html'

/**
 * CSS selectors for an `html` platform. `item` is required; the others are
 * optional and, when present, are resolved relative to each matched item
 * element (a leading `:scope` is not needed — selectors are scoped to the item).
 */
export interface HtmlSelectors {
  /** CSS selector matching each result item element. */
  item: string
  /** CSS selector for the link element (its `href` is the result URL). */
  url?: string
  /** CSS selector for the title text. */
  title?: string
  /** CSS selector for the snippet / description text. */
  snippet?: string
}

/**
 * Dot-path field extraction for a `json` platform. `items` points at the
 * results array from the document root; the others point at a field within
 * each item. A missing field yields `undefined`, never an error.
 */
export interface JsonFields {
  /** Dot-separated path from the JSON root to the results array. */
  items: string
  /** Dot-separated path from each item to its URL (or URL id when `urlPrefix` is set). */
  url: string
  /**
   * Optional prefix prepended to the resolved `url` value. Use it when a
   * platform returns an id instead of a full URL (e.g. YouTube `videoId` →
   * `https://www.youtube.com/watch?v=<id>`).
   */
  urlPrefix?: string
  /** Dot-separated path from each item to its title. */
  title?: string
  /** Dot-separated path from each item to its snippet / description. */
  snippet?: string
  /** Dot-separated path from each item to a publication timestamp. */
  publishedAt?: string
}

/**
 * Extraction config for a `json-in-html` platform: a JSON object embedded in an
 * HTML document (e.g. YouTube's `ytInitialData`). The object following `marker`
 * is located by balanced-brace scanning and then parsed with {@link JsonFields}.
 */
export interface JsonInHtml {
  /** Marker text immediately preceding the embedded JSON object. */
  marker: string
  /** Field paths applied to the extracted JSON object. */
  fields: JsonFields
}

/**
 * One platform definition. Platform data is config-driven: it is authored in
 * `cordis.yml`, shipped as a built-in, or imported from a {@link RulePack}.
 * Fields are mutable because definitions are parsed from JSON/config.
 */
export interface Platform {
  /** Stable platform id (e.g. `github`); unique within the registry. */
  id: string
  /** Human display name (e.g. `GitHub`). */
  name: string
  /** Result content format. */
  format: PlatformFormat
  /**
   * Search URL template with `{query}` (always), and optional `{limit}` and
   * `{page}` placeholders. Required for `html`/`json`; for `rss` the `query`
   * argument is itself the feed URL and this field is ignored.
   */
  searchUrl?: string
  /** Optional request headers (e.g. a `User-Agent` or a `Cookie` a platform requires). */
  headers?: Record<string, string>
  /** Selectors for `html` platforms. */
  selectors?: HtmlSelectors
  /** Field paths for `json` platforms. */
  fields?: JsonFields
  /** Embedded-JSON extraction for `json-in-html` platforms. */
  jsonInHtml?: JsonInHtml
  /** Optional platform-specific cap on results (clamped by the tool's `limit`). */
  maxResults?: number
  /** Optional documentation note surfaced in the platform listing. */
  notes?: string
}

/** One parsed platform result. */
export interface PlatformSource {
  /** The result URL (absolute for html/json; the entry link for rss). */
  url: string
  /** The result title (may be absent). */
  title?: string
  /** The result snippet / description (may be absent). */
  snippet?: string
  /** Publication timestamp (ISO string) when the platform provides one. */
  publishedAt?: string
}

/** The outcome of one platform search. */
export interface PlatformSearchResult {
  /** The platform id that was searched. */
  platform: string
  /** The query that was searched (or the feed URL for `rss`). */
  query: string
  /** The parsed results, in platform rank order. */
  sources: readonly PlatformSource[]
  /** True when results were cut to the requested limit. */
  truncated: boolean
}

/** Current rule-pack schema version. */
export const RULE_PACK_VERSION = 1

/**
 * A versioned, portable bundle of platform definitions. Rule packs are the
 * import/export unit for sharing platform configurations; they are plain JSON
 * so they can be edited by hand or produced by tooling.
 */
export interface RulePack {
  /** Schema version (currently {@link RULE_PACK_VERSION}). */
  version: number
  /** Human-readable pack name. */
  name: string
  /** Optional description of the pack's purpose. */
  description?: string
  /** The platform definitions contributed by this pack. */
  platforms: Platform[]
}

/** Model-facing `web_platform_search` arguments. */
export interface PlatformSearchArgs {
  /** The platform id to search (e.g. `github`). */
  platform: string
  /** The search query; for `rss` platforms this is the feed URL. */
  query: string
  /** Maximum number of results to return (clamped to 1..100). */
  limit?: number
}

/** Upper bound on one `web_platform_search` call. */
export const PLATFORM_SEARCH_MAX_LIMIT = 100
