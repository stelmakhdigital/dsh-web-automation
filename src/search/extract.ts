/**
 * Readable-text extraction from an HTML document — a deliberately
 * conservative heuristic: strip non-content elements, prefer the main article
 * container, collapse whitespace. Pages with unusual structure degrade to
 * body text rather than failing. No readability dependency: the output feeds
 * BM25 re-ranking and snippet windows, not a reader view.
 * @module @deepseek-ai/dsh-web-search-multi/extract
 */

import * as cheerio from 'cheerio'

/** Element selectors removed before text extraction. */
const NON_CONTENT_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'canvas',
  'form',
  'nav',
  'header',
  'footer',
  'aside',
  'button',
  'select',
  'input',
].join(', ')

/**
 * Extract readable text from an HTML document.
 * @param html - the raw document.
 * @returns the collapsed text, or `''` when nothing readable remains.
 */
export function extractReadableText(html: string): string {
  const $ = cheerio.load(html)
  $(NON_CONTENT_SELECTORS).remove()
  const article = $('article').first()
  const main = article.length > 0 ? article : $('main').first()
  const roleMain = main.length > 0 ? main : $('[role="main"]').first()
  const container = roleMain.length > 0 ? roleMain : $('body').length > 0 ? $('body') : $('html')
  return container.text().replace(/\s+/g, ' ').trim()
}

/**
 * Take a snippet window from extracted page text: the region around the first
 * query-term occurrence, or the text head when no term occurs. Ellipses mark
 * elided context on either side.
 * @param query - the search query (its terms locate the window).
 * @param text - the extracted page text.
 * @param maxChars - the window length budget.
 * @returns the windowed snippet.
 */
export function snippetWindow(query: string, text: string, maxChars: number): string {
  const lower = text.toLowerCase()
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(term => term.length > 1)
  let start = -1
  for (const term of terms) {
    const index = lower.indexOf(term)
    if (index !== -1 && (start === -1 || index < start)) start = index
  }
  if (start === -1) return text.slice(0, maxChars)
  const from = Math.max(0, start - Math.floor(maxChars / 3))
  const window = text.slice(from, from + maxChars)
  return `${from > 0 ? '…' : ''}${window}${from + maxChars < text.length ? '…' : ''}`
}
