/**
 * Parser for the Bing HTML SERP. Bing serves a server-rendered page to a
 * plain GET with a product user agent; organic results sit in
 * `<li class="b_algo">` items with an `h2 > a` title link and a
 * `.b_caption` snippet.
 * @module @deepseek-ai/dsh-web-search-multi/bingparse
 */

import * as cheerio from 'cheerio'

/** One parsed Bing organic result. */
export interface BingSerpResult {
  /** Absolute result URL. */
  url: string
  /** Result title. */
  title: string
  /** Result snippet (may be empty). */
  snippet: string
}

/** True for an absolute http(s) URL. */
function isHttpUrl(value: string): boolean {
  if (!value.startsWith('http://') && !value.startsWith('https://')) return false
  try {
    return URL.canParse(value)
  } catch {
    return false
  }
}

/**
 * Parse a Bing SERP document into organic results.
 * @param html - the SERP document.
 * @returns the parsed results in page order.
 */
export function parseBingSerp(html: string): BingSerpResult[] {
  const $ = cheerio.load(html)
  const results: BingSerpResult[] = []
  $('li.b_algo').each((_, el) => {
    const $el = $(el)
    const $title = $el.find('h2 a').first()
    const href = $title.attr('href')
    const title = $title.text().trim()
    if (href === undefined || !isHttpUrl(href) || title.length === 0) return
    const snippet = $el.find('.b_caption p, .b_caption').first().text().replace(/\s+/g, ' ').trim()
    results.push({ url: href, title, snippet })
  })
  return results
}

/**
 * Detect a Bing consent/challenge page (zero organic results plus a marker).
 * @param html - the fetched document.
 * @returns true when the document is not a usable SERP.
 */
export function isBlockedBingSerp(html: string): boolean {
  if (parseBingSerp(html).length > 0) return false
  return /consent\.microsoft|challenge-form|captcha|are you a robot/i.test(html)
}
