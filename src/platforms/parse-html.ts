/**
 * HTML result extraction for `html` platforms. Each result item is selected by
 * a CSS selector; the link, title, and snippet are resolved relative to the
 * item. Relative hrefs are resolved against the search URL. Malformed items
 * (no usable URL) are skipped, never fatal.
 * @module @deepseek-ai/dsh-web-platforms/parse-html
 */

import * as cheerio from 'cheerio'
import type { HtmlSelectors, PlatformSource } from './types.ts'

/** Collapse internal whitespace to single spaces and trim. */
function cleanText(text: string): string | undefined {
  const value = text.replace(/\s+/g, ' ').trim()
  return value.length > 0 ? value : undefined
}

/** Resolve an href against a base URL; return undefined when not absolute-http. */
function resolveHref(href: string | undefined, base: string): string | undefined {
  if (href === undefined) return undefined
  const trimmed = href.trim()
  if (trimmed.length === 0) return undefined
  try {
    const resolved = new URL(trimmed, base).toString()
    return /^https?:/i.test(resolved) ? resolved : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse an HTML document into platform sources using the configured selectors.
 * @param html - the raw HTML document.
 * @param selectors - the platform's {@link HtmlSelectors}.
 * @param baseUrl - the search URL, used to resolve relative hrefs.
 * @returns the parsed sources, in document order (deduplicated by URL).
 */
export function parseHtmlResults(html: string, selectors: HtmlSelectors, baseUrl: string): PlatformSource[] {
  const $ = cheerio.load(html)
  const sources: PlatformSource[] = []
  const seen = new Set<string>()
  $(selectors.item).each((_index, element) => {
    const $item = $(element)
    // URL: an explicit url selector, else the item's own/first anchor.
    let href: string | undefined
    if (selectors.url !== undefined) {
      href = $item.find(selectors.url).first().attr('href')
    } else {
      const selfHref = $item.attr('href')
      href = selfHref !== undefined && selfHref.length > 0 ? selfHref : $item.find('a').first().attr('href')
    }
    const url = resolveHref(href, baseUrl)
    if (url === undefined || seen.has(url)) return
    seen.add(url)
    const source: PlatformSource = { url }
    const title = selectors.title !== undefined
      ? cleanText($item.find(selectors.title).first().text())
      : cleanText($item.text())
    if (title !== undefined) source.title = title
    const snippet = selectors.snippet !== undefined ? cleanText($item.find(selectors.snippet).first().text()) : undefined
    if (snippet !== undefined) source.snippet = snippet
    sources.push(source)
  })
  return sources
}
