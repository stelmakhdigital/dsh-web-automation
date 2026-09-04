/**
 * Built-in platform definitions. These ship with the package as a convenient
 * starting point; every field is overridable via config or a rule pack, and
 * the endpoints are best-effort (third-party markup/APIs change). The JSON
 * platforms (GitHub, Reddit, Bilibili) hit public, keyless endpoints and are
 * the most reliable; the HTML/SPA platforms (V2EX, YouTube) are best-effort.
 * @module @deepseek-ai/dsh-web-platforms/builtins
 */

import type { Platform } from './types.ts'

/** GitHub repository search via the public REST API (keyless, rate-limited). */
const GITHUB: Platform = {
  id: 'github',
  name: 'GitHub',
  format: 'json',
  searchUrl: 'https://api.github.com/search/repositories?q={query}&per_page={limit}',
  headers: {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'deepseek-harness/0.1.1 (web_platform_search)',
  },
  fields: {
    items: 'items',
    url: 'html_url',
    title: 'full_name',
    snippet: 'description',
    publishedAt: 'updated_at',
  },
  notes: 'Repository search via the GitHub REST API. Unauthenticated requests are rate-limited (10/min).',
}

/** Reddit search via the public `.json` endpoint (keyless, rate-limited). */
const REDDIT: Platform = {
  id: 'reddit',
  name: 'Reddit',
  format: 'json',
  searchUrl: 'https://www.reddit.com/search.json?q={query}&limit={limit}&sort=relevance',
  headers: {
    'User-Agent': 'deepseek-harness/0.1.1 (web_platform_search)',
  },
  fields: {
    items: 'data.children',
    url: 'data.url',
    title: 'data.title',
    snippet: 'data.selftext',
  },
  notes: 'Reddit search via the public .json endpoint. Unauthenticated requests are rate-limited.',
}

/**
 * YouTube search via the embedded `ytInitialData` JSON blob in the search HTML.
 * Best-effort: the blob is client-rendered data, so results depend on YouTube's
 * current page structure.
 */
const YOUTUBE: Platform = {
  id: 'youtube',
  name: 'YouTube',
  format: 'json-in-html',
  searchUrl: 'https://www.youtube.com/results?search_query={query}&hl=en',
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; deepseek-harness/0.1.1)',
  },
  jsonInHtml: {
    marker: 'ytInitialData = ',
    fields: {
      items: 'contents.twoColumnSearchResults.results',
      url: 'videoRenderer.navigationEndpoint.watchEndpoint.videoId',
      urlPrefix: 'https://www.youtube.com/watch?v=',
      title: 'videoRenderer.title.runs.0.text',
      snippet: 'videoRenderer.detailedMetadataSnippets.0.snippet.runs.0.text',
    },
  },
  notes: 'Best-effort: parses the embedded ytInitialData blob; may return few results if YouTube changes its page.',
}

/**
 * Bilibili video search via the public search API. Best-effort: the API
 * typically requires a `buvid3` cookie; set `headers.Cookie` in config to
 * supply one when the endpoint rejects unauthenticated requests.
 */
const BILIBILI: Platform = {
  id: 'bilibili',
  name: 'Bilibili',
  format: 'json',
  searchUrl: 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword={query}',
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; deepseek-harness/0.1.1)',
    Referer: 'https://www.bilibili.com',
  },
  fields: {
    items: 'data.result',
    url: 'bvid',
    urlPrefix: 'https://www.bilibili.com/video/',
    title: 'title',
    snippet: 'description',
  },
  notes: 'Best-effort: the search API may require a buvid3 cookie (set headers.Cookie in config).',
}

/** V2EX topic search via the server-rendered search page. Best-effort. */
const V2EX: Platform = {
  id: 'v2ex',
  name: 'V2EX',
  format: 'html',
  searchUrl: 'https://www.v2ex.com/?q={query}',
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; deepseek-harness/0.1.1)',
  },
  selectors: {
    item: 'div.cell.item',
    url: 'a',
    title: 'a',
  },
  notes: 'Best-effort: parses the server-rendered search page; markup may change.',
}

/**
 * RSS / Atom feed reader. The `query` argument is the feed URL (not a search
 * term); the feed's entries are returned as sources.
 */
const RSS: Platform = {
  id: 'rss',
  name: 'RSS / Atom feed',
  format: 'rss',
  notes: 'Pass a feed URL as the query; the feed entries are returned (title, link, description, date).',
}

/** The built-in platforms, in display order. */
export const BUILTIN_PLATFORMS: readonly Platform[] = [GITHUB, REDDIT, YOUTUBE, BILIBILI, V2EX, RSS]
