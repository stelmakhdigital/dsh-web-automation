/**
 * Platform search execution: resolve the platform, build the search URL, fetch
 * it (with the platform's headers and a deadline), and parse the results by
 * format. Fetches go directly (not through `ctx.web`) because platforms need
 * per-request headers the fetch seam does not carry. Errors are classified into
 * the web family's `WebError` codes.
 * @module @deepseek-ai/dsh-web-platforms/search
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { parseHtmlResults } from './parse-html.ts'
import { extractJsonAfterMarker, parseJsonResults } from './parse-json.ts'
import { parseRssResults } from './parse-rss.ts'
import type { PlatformRegistry } from './registry.ts'
import { expandTemplate } from './template.ts'
import type { Platform, PlatformSearchArgs, PlatformSearchResult, PlatformSource } from './types.ts'

/** Execution dependencies for a platform search. */
export interface PlatformSearchDeps {
  /** The platform registry. */
  registry: PlatformRegistry
  /** Per-search deadline (ms). */
  timeoutMs: number
  /** Cap on one fetched body (bytes). */
  maxBytes: number
  /** The tool-level result cap (clamps `limit`). */
  maxResults: number
}

/**
 * Classify a thrown platform-search error against the deadline signal: a
 * deadline timeout wins (`WEB_SEARCH_TIMEOUT`), any other abort is
 * `WEB_ABORTED`, and an un-aborted throw is a provider failure
 * (`WEB_PROVIDER_ERROR`).
 */
function classifyPlatformError(error: unknown, signal: AbortSignal, context: string): WebError {
  const timeout = timeoutOf(signal, 'WEB_SEARCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('platform search timed out', 'WEB_SEARCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('platform search aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`${context}: ${error instanceof Error ? error.message : String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

/**
 * Read a response body as UTF-8 text up to a byte cap. A declared
 * `Content-Length` over the cap rejects immediately; a stream that grows past
 * the cap is cut short.
 */
async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`)
  }
  /* v8 ignore next -- a 2xx Response from fetch always exposes a body stream; the null guard is defensive. */
  if (response.body === null) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = maxBytes - total
      if (remaining <= 0) throw new Error(`body exceeds ${maxBytes} bytes`)
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value
      chunks.push(slice)
      total += slice.byteLength
      if (value.byteLength > remaining) break
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(concatBytes(chunks))
}

/** Concatenate byte chunks into one buffer. */
function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Fetch one URL and return its body text, enforcing the deadline and byte cap. */
async function fetchText(url: string, headers: Record<string, string> | undefined, signal: AbortSignal, maxBytes: number): Promise<string> {
  let response: Response
  try {
    const init: RequestInit = { signal, redirect: 'follow' }
    if (headers !== undefined) init.headers = headers
    response = await fetch(url, init)
  } catch (error) {
    throw classifyPlatformError(error, signal, `fetch ${url}`)
  }
  if (!response.ok) {
    throw new WebError(`platform search got HTTP ${response.status} from ${url}`, 'WEB_PROVIDER_ERROR')
  }
  try {
    return await readCappedText(response, maxBytes)
  } catch (error) {
    throw classifyPlatformError(error, signal, `read ${url}`)
  }
}

/** Parse a fetched body into sources using the platform's format. */
function parseByFormat(platform: Platform, body: string, url: string): PlatformSource[] {
  switch (platform.format) {
    case 'html':
      if (platform.selectors === undefined) throw new WebError(`platform "${platform.id}" is missing html selectors`, 'WEB_PROVIDER_ERROR')
      return parseHtmlResults(body, platform.selectors, url)
    case 'json':
      if (platform.fields === undefined) throw new WebError(`platform "${platform.id}" is missing json fields`, 'WEB_PROVIDER_ERROR')
      return parseJsonResults(body, platform.fields)
    case 'json-in-html':
      if (platform.jsonInHtml === undefined) throw new WebError(`platform "${platform.id}" is missing jsonInHtml config`, 'WEB_PROVIDER_ERROR')
      const jsonText = extractJsonAfterMarker(body, platform.jsonInHtml.marker)
      return parseJsonResults(jsonText, platform.jsonInHtml.fields)
    case 'rss':
      return parseRssResults(body, url)
  }
}

/**
 * Run one platform search.
 * @param args - the validated tool arguments.
 * @param deps - the execution dependencies.
 * @param signal - the caller cancellation signal.
 * @returns the parsed, capped result.
 */
export async function searchPlatform(
  args: PlatformSearchArgs,
  deps: PlatformSearchDeps,
  signal: AbortSignal,
): Promise<PlatformSearchResult> {
  const platform = deps.registry.get(args.platform)
  if (platform === undefined) {
    const available = deps.registry.ids().join(', ')
    throw new WebError(`unknown platform "${args.platform}"; available: ${available}`, 'WEB_PROVIDER_ERROR')
  }
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? deps.maxResults), 1), deps.maxResults)

  // Build the target URL: rss uses the query as the feed URL; others expand the template.
  let url: string
  if (platform.format === 'rss') {
    url = args.query.trim()
  } else {
    if (platform.searchUrl === undefined) throw new WebError(`platform "${platform.id}" has no searchUrl`, 'WEB_PROVIDER_ERROR')
    url = expandTemplate(platform.searchUrl, { query: args.query, limit })
  }
  if (!URL.canParse(url) || !/^https?:/i.test(url)) {
    throw new WebError(`platform "${platform.id}" produced an invalid URL: ${url}`, 'WEB_INVALID_URL')
  }

  using d = deadline(signal, deps.timeoutMs, 'WEB_SEARCH_TIMEOUT')
  const body = await fetchText(url, platform.headers, d.signal, deps.maxBytes)
  const parsed = parseByFormat(platform, body, url)

  const cap = platform.maxResults !== undefined ? Math.min(limit, platform.maxResults) : limit
  const truncated = parsed.length > cap
  return { platform: platform.id, query: args.query, sources: parsed.slice(0, cap), truncated }
}
