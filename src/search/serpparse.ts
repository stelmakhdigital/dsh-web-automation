/**
 * DuckDuckGo HTML SERP parsing — the pure, network-free half of the provider.
 * The HTML endpoint (`html.duckduckgo.com/html/`) returns server-rendered
 * results without JavaScript, so a static parse is sufficient.
 * @module @deepseek-ai/dsh-web-search-multi/serpparse
 */

import * as cheerio from 'cheerio'

/** One parsed search-engine result. */
export interface SerpResult {
  /** The decoded result URL. */
  url: string
  /** The result title (may be empty for malformed results). */
  title: string
  /** The engine-provided snippet (may be empty). */
  snippet: string
}

/**
 * Parse a DuckDuckGo HTML SERP page into results, in engine rank order.
 * Malformed entries (no usable URL) are skipped, never fatal.
 * @param html - the raw SERP document.
 * @returns the parsed results.
 */
export function parseDuckDuckGoSerp(html: string): SerpResult[] {
  const $ = cheerio.load(html)
  const results: SerpResult[] = []
  $('.result').each((_index, element) => {
    const $result = $(element)
    const $link = $result.find('a.result__a').first()
    const url = decodeDuckDuckGoHref($link.attr('href') ?? '')
    if (!isHttpUrl(url)) return
    const title = $link.text().replace(/\s+/g, ' ').trim()
    const snippet = $result.find('.result__snippet').first().text().replace(/\s+/g, ' ').trim()
    if (title.length === 0 && snippet.length === 0) return
    results.push({ url, title, snippet })
  })
  return results
}

/**
 * Decode a result link. DuckDuckGo wraps result URLs in its own redirect
 * (`//duckduckgo.com/l/?uddg=<urlencoded>&rut=…`); the `uddg` parameter carries
 * the real target. Plain absolute and protocol-relative URLs pass through.
 * @param href - the raw `href` attribute value.
 * @returns the decoded URL, or `''` when no usable target can be recovered.
 */
export function decodeDuckDuckGoHref(href: string): string {
  const trimmed = href.trim()
  if (trimmed.length === 0) return ''
  if (trimmed.startsWith('//duckduckgo.com/l/') || trimmed.startsWith('https://duckduckgo.com/l/')) {
    try {
      const wrapper = new URL(trimmed.startsWith('http') ? trimmed : `https:${trimmed}`)
      const target = wrapper.searchParams.get('uddg')
      if (target !== null && target.length > 0) return decodeURIComponent(target)
      return ''
    } catch {
      return ''
    }
  }
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  return trimmed
}

/** True for an absolute http(s) URL (the only scheme results may carry). */
export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Heuristic bot-block detection for a SERP document: a 200 response that is
 * actually a CAPTCHA/anomaly challenge page. Zero results WITHOUT these
 * markers is a legitimate empty result set, not a block.
 * @param html - the raw SERP document.
 * @returns true when the document looks like a bot challenge.
 */
export function isBlockedSerp(html: string): boolean {
  return /anomaly-modal|challenge-form|captcha|not a robot/i.test(html)
}
