/**
 * Enrichment: fetch the top candidate pages, extract readable text, and
 * re-rank with local BM25. One failed page never fails the search: that
 * source keeps its engine snippet and its (possibly lower) score.
 *
 * Page bodies are cached in the shared web store (the same `web_pages` table
 * the fetch provider writes), so a page fetched for enrichment is reused by
 * `web_fetch` and vice versa.
 * @module @deepseek-ai/dsh-web-search-multi/enrich
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { WebStore } from '../store/index.ts'
import { bm25Rank } from './bm25.ts'
import { embeddingRerank, type EmbeddingOptions } from './embedding.ts'
import { extractReadableText, snippetWindow } from './extract.ts'
import { readCappedText } from './http.ts'
import { normalizeUrl } from './url.ts'

/** Enrichment options. */
export interface EnrichOptions {
  /** The shared web store (page cache). */
  store: WebStore
  /** Per-page fetch timeout (ms). */
  pageTimeoutMs: number
  /** Page cache TTL (ms). */
  pageCacheTtlMs: number
  /** Hard cap on one page body (bytes). */
  maxPageBytes: number
  /** Hard cap on one stored page body (chars). */
  maxBodyChars: number
  /** Snippet window size (chars). */
  snippetChars: number
  /** `User-Agent` header sent on page fetches. */
  userAgent: string
  /** Concurrent page fetches. */
  concurrency: number
  /** Optional embedding endpoint for semantic re-ranking (falls back to BM25 when off/fails). */
  embedding?: EmbeddingOptions
}

/**
 * Enrich sources: fetch the candidate pages, extract text, re-rank with BM25,
 * and replace snippets with query-focused windows.
 * @param query - the search query.
 * @param sources - the candidate sources (already sliced to the fetch limit).
 * @param keep - how many enriched sources to keep.
 * @param options - the enrichment options.
 * @param signal - the provider deadline signal.
 * @returns the re-ranked, snippet-replaced sources.
 */
export async function enrichSources(
  query: string,
  sources: readonly WebSearchSource[],
  keep: number,
  options: EnrichOptions,
  signal: AbortSignal,
): Promise<WebSearchSource[]> {
  const candidates = sources
  const texts: (string | undefined)[] = new Array<string | undefined>(candidates.length).fill(undefined)

  // Bounded-concurrency page fetches.
  let next = 0
  const workerCount = Math.min(options.concurrency, candidates.length)
  const workers: Promise<void>[] = []
  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push((async () => {
      while (next < candidates.length) {
        const index = next
        next += 1
        const candidate = candidates[index]
        if (candidate === undefined || signal.aborted) return
        const page = await fetchPageText(candidate.url, options, signal)
        if (page !== undefined) texts[index] = page
      }
    })())
  }
  await Promise.all(workers)

  if (signal.aborted) throw new WebError('web search aborted', 'WEB_ABORTED')

  const documents = candidates.map((source, index) =>
    [source.title ?? '', source.snippet ?? '', texts[index] ?? ''].filter(part => part.length > 0).join('\n'),
  )

  // Re-rank: embedding (semantic) when configured, BM25 (keyword) otherwise.
  let ranked: { source: WebSearchSource; index: number; score: number }[]
  const embedding = options.embedding
  if (embedding !== undefined && embedding.endpoint.length > 0) {
    try {
      const order = await embeddingRerank(query, documents, embedding, signal)
      ranked = order
        .map((index, rank) => ({ source: candidates[index]!, index, score: 1 / (rank + 1) }))
    } catch {
      // Embedding failed: fall back to BM25.
      const scores = bm25Rank(query, documents)
      ranked = candidates
        .map((source, index) => ({ source, index, score: scores[index] ?? 0 }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
    }
  } else {
    const scores = bm25Rank(query, documents)
    ranked = candidates
      .map((source, index) => ({ source, index, score: scores[index] ?? 0 }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
  }

  const kept = ranked.slice(0, Math.min(keep, candidates.length))
  return kept.map(({ source, index }) => {
    const text = texts[index]
    if (text === undefined || text.length === 0) return { ...source }
    const snippet = snippetWindow(query, text, options.snippetChars)
    return snippet.length > 0 ? { ...source, snippet } : { ...source }
  })
}

/** Fetch one page and return its extracted text, or `undefined` on any failure. */
async function fetchPageText(url: string, options: EnrichOptions, signal: AbortSignal): Promise<string | undefined> {
  const key = normalizeUrl(url)
  const cached = await options.store.readPage(key).catch(() => undefined)
  if (cached !== undefined && Date.now() - cached.fetchedAt < options.pageCacheTtlMs) {
    return cached.bodyKind === 'html' ? extractReadableText(cached.body) : cached.body
  }

  using d = deadline(signal, options.pageTimeoutMs, 'WEB_PAGE_TIMEOUT')
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': options.userAgent,
        'accept': 'text/html,application/xhtml+xml,text/*;q=0.9',
      },
      signal: d.signal,
    })
  } catch (error: unknown) {
    if (signal.aborted) throw new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
    return undefined
  }
  if (!response.ok) {
    await response.body?.cancel()
    return undefined
  }
  const mime = (response.headers.get('content-type') ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime !== '' && !mime.startsWith('text/') && mime !== 'application/xhtml+xml' && !mime.endsWith('+xml') && !mime.endsWith('+json')) {
    await response.body?.cancel()
    return undefined
  }
  let body: string
  try {
    body = await readCappedText(response, options.maxPageBytes)
  } catch (error: unknown) {
    if (signal.aborted) throw new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
    return undefined
  }
  const truncated = body.length > options.maxBodyChars
  const capped = truncated ? body.slice(0, options.maxBodyChars) : body
  const bodyKind = mime.startsWith('text/html') || mime === 'application/xhtml+xml' ? 'html' : 'text'
  const text = bodyKind === 'html' ? extractReadableText(capped) : capped
  if (text.length === 0) return undefined
  await options.store.recordPage({
    url,
    normalizedUrl: key,
    fetchedAt: Date.now(),
    statusCode: response.status,
    bodyKind,
    body: capped,
    truncated,
  }).catch(() => undefined)
  return text
}
