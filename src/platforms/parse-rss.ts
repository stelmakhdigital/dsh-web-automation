/**
 * RSS / Atom feed parsing for `rss` platforms. The query argument is the feed
 * URL; the feed's entries are returned as sources (title, link, description,
 * publication date). Both RSS 2.0 (`<item>`) and Atom (`<entry>`) are supported.
 * @module @deepseek-ai/dsh-web-platforms/parse-rss
 */

import * as cheerio from 'cheerio'
import type { PlatformSource } from './types.ts'

/** Collapse internal whitespace to single spaces and trim. */
function cleanText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const value = text.replace(/\s+/g, ' ').trim()
  return value.length > 0 ? value : undefined
}

/** Resolve a (possibly relative) link against the feed URL. */
function resolveLink(link: string | undefined, base: string): string | undefined {
  const trimmed = link?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined
  try {
    const resolved = new URL(trimmed, base).toString()
    return /^https?:/i.test(resolved) ? resolved : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse an RSS or Atom feed into platform sources.
 * @param xml - the raw feed document.
 * @param feedUrl - the feed URL, used to resolve relative links.
 * @returns the parsed entries, in feed order (deduplicated by URL).
 */
export function parseRssResults(xml: string, feedUrl: string): PlatformSource[] {
  const $ = cheerio.load(xml, { xml: true })
  const sources: PlatformSource[] = []
  const seen = new Set<string>()
  const emit = (url: string | undefined, title: string | undefined, snippet: string | undefined, publishedAt: string | undefined): void => {
    if (url === undefined || seen.has(url)) return
    seen.add(url)
    const source: PlatformSource = { url }
    if (title !== undefined) source.title = title
    if (snippet !== undefined) source.snippet = snippet
    if (publishedAt !== undefined) source.publishedAt = publishedAt
    sources.push(source)
  }

  // RSS 2.0: <item> with <title>, <link> (text), <description>, <pubDate>.
  if ($('item').length > 0) {
    $('item').each((_index, element) => {
      const $item = $(element)
      const url = resolveLink($item.find('link').first().text(), feedUrl)
      const title = cleanText($item.find('title').first().text())
      const snippet = cleanText($item.find('description').first().text()) ?? cleanText($item.find('summary').first().text())
      // Note: `dc:date` is a namespaced element; cheerio's CSS engine reads the
      // colon as a pseudo-class, so only the un-namespaced `pubDate` is probed.
      const publishedAt = cleanText($item.find('pubDate').first().text())
      emit(url, title, snippet, publishedAt)
    })
    return sources
  }

  // Atom: <entry> with <title>, <link href>, <summary>/<content>, <published>/<updated>.
  $('entry').each((_index, element) => {
    const $entry = $(element)
    const href = $entry.find('link').first().attr('href')
    const url = resolveLink(href, feedUrl)
    const title = cleanText($entry.find('title').first().text())
    const snippet = cleanText($entry.find('summary').first().text()) ?? cleanText($entry.find('content').first().text())
    const publishedAt = cleanText($entry.find('published').first().text()) ?? cleanText($entry.find('updated').first().text())
    emit(url, title, snippet, publishedAt)
  })
  return sources
}
