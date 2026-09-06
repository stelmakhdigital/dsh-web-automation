/**
 * `CachedHttpFetchProvider`: an anonymous public HTTP(S) `WebFetchProvider`
 * with a SQLite-backed page cache (the shared web store). Transport hygiene
 * mirrors `@deepseek-ai/dsh-web-fetch-http` (the two MUST evolve together);
 * this provider adds TTL caching, ETag/Last-Modified conditional
 * revalidation, and stale-on-error serving.
 *
 * Only 2xx results are cached: a 404 or 500 may become a 200, so non-2xx
 * responses always pass through to the network. The page cache is shared with
 * the search provider's enrichment (same `web_pages` table), so a page
 * fetched by `web_fetch` is reused by `web_search` and vice versa.
 *
 * Private-network and SSRF protection is enforced by default: the guard
 * blocks requests to loopback, private, link-local, and otherwise reserved
 * targets (checked on the literal host and after DNS resolution, against
 * rebinding). Set `allowPrivateNetworks: true` to disable the guard in a
 * trusted, network-isolated environment.
 * @module dsh-web-automation/fetch/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { StoredPage, WebStore } from '../store/index.ts'
import { classifyContentType, decoderForCharset, isSameOrigin, parseCharset, validateFetchUrl } from './policy.ts'
import { normalizeUrl } from './url.ts'
import { checkSsrf } from './ssrf.ts'

/** Resolved provider limits and cache settings. */
export interface CachedFetchLimits {
  /** Maximum accepted request URL length. */
  maxUrlLength: number
  /** Maximum response body size in bytes (read is aborted past this). */
  maxResponseBytes: number
  /** Maximum decoded body length in characters (truncated past this). */
  maxBodyChars: number
  /** Fetch timeout in milliseconds. */
  timeoutMs: number
  /** Maximum number of (same-origin) redirect hops to follow. */
  maxRedirects: number
  /** `User-Agent` header sent on every request. */
  userAgent: string
  /** Time-to-live in milliseconds for cached pages. */
  cacheTtlMs: number
  /** The shared web store (page cache). */
  store: WebStore
  /** Issue conditional revalidation requests for fresh-but-expired entries. */
  revalidate: boolean
  /**
   * Allow requests to private/reserved network targets (loopback, LAN,
   * link-local). Defaults to false: the SSRF guard blocks these so the
   * plugin cannot probe internal infrastructure. Enable only in a trusted,
   * network-isolated environment (e.g. a container with no internal routes).
   */
  allowPrivateNetworks: boolean
}

/** Stable id this provider registers under. */
export const CACHED_FETCH_PROVIDER_ID = 'cached-http'

/** The accept header sent on every request. */
const ACCEPT_HEADER = 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8'

/** The SQLite-cached anonymous public HTTP(S) fetch provider. */
export class CachedHttpFetchProvider implements WebFetchProvider {
  readonly id = CACHED_FETCH_PROVIDER_ID

  constructor(private readonly limits: CachedFetchLimits) {}

  /** No credentials to check — an anonymous public fetcher is always usable. */
  available(): boolean {
    return isPositiveFinite(this.limits.maxUrlLength)
      && isPositiveFinite(this.limits.maxResponseBytes)
      && isPositiveFinite(this.limits.maxBodyChars)
      && isPositiveFinite(this.limits.timeoutMs)
      && Number.isInteger(this.limits.maxRedirects) && this.limits.maxRedirects >= 0
      && isPositiveFinite(this.limits.cacheTtlMs)
  }

  /** Fetch one URL, serving from the cache when fresh. */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    const url = validateFetchUrl(request.url, this.limits.maxUrlLength)
    await this.assertPublic(url)
    const key = normalizeUrl(url.toString())
    const cached = await this.limits.store.readPage(key).catch(() => undefined)
    if (cached !== undefined) {
      if (Date.now() - cached.fetchedAt < this.limits.cacheTtlMs) {
        // Fresh: serve from cache with no network round-trip.
        return cloneResult(pageToResult(cached))
      }
      // Expired: conditional revalidation when enabled — a 304 serves the
      // stale body, a changed body falls through to a full fetch, and a
      // transport failure serves the stale body (stale-on-error).
      if (this.limits.revalidate) return await this.revalidate(url, key, cached, signal)
    }
    using d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    return await this.fetchFresh(url, d.signal)
  }

  /**
   * Assert a URL is public (not a private/reserved network target). Throws a
   * `WEB_SSRF_BLOCKED` error when the guard blocks the URL. The check runs on
   * the literal host and after DNS resolution (against rebinding).
   * @param url - the URL to check.
   */
  private async assertPublic(url: URL): Promise<void> {
    const check = await checkSsrf(url.toString(), { allowPrivate: this.limits.allowPrivateNetworks })
    if (!check.allowed) {
      throw new WebError(`request to ${url.host} blocked by the SSRF guard: ${check.reason}`, 'WEB_SSRF_BLOCKED')
    }
  }

  /** Fetch from the network, cache a 2xx result, and return it. */
  private async fetchFresh(url: URL, signal: AbortSignal): Promise<WebFetchResult> {
    const { result, etag, lastModified } = await this.followAndRead(url, signal)
    if (result.statusCode >= 200 && result.statusCode < 300) {
      await this.limits.store.recordPage({
        url: result.url,
        normalizedUrl: normalizeUrl(url.toString()),
        fetchedAt: Date.now(),
        ...etag !== undefined ? { etag } : {},
        ...lastModified !== undefined ? { lastModified } : {},
        statusCode: result.statusCode,
        bodyKind: result.body.kind,
        body: result.body.content,
        truncated: result.truncated,
      }).catch(() => undefined)
    }
    return result
  }

  /**
   * Conditional revalidation of a TTL-expired cache entry. A 304 refreshes
   * the timestamp and serves the stale body; anything else falls through to a
   * full fetch. A transport failure serves the stale body (stale-on-error)
   * rather than failing the call; caller cancellation and our own timeout
   * still fail loudly.
   */
  private async revalidate(url: URL, key: string, cached: StoredPage, signal?: AbortSignal): Promise<WebFetchResult> {
    using d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': this.limits.userAgent,
          'accept': ACCEPT_HEADER,
          ...cached.etag !== undefined ? { 'if-none-match': cached.etag } : {},
          ...cached.lastModified !== undefined ? { 'if-modified-since': cached.lastModified } : {},
        },
        signal: d.signal,
      })
    } catch (error: unknown) {
      const translated = translateAbortOrNetwork(error, d.signal)
      if (translated.code === 'WEB_ABORTED' || translated.code === 'WEB_FETCH_TIMEOUT') throw translated
      return cloneResult(pageToResult(cached))
    }
    if (response.status === 304) {
      await response.body?.cancel()
      await this.limits.store.refreshPage(key, Date.now(), cached.etag, cached.lastModified).catch(() => undefined)
      return cloneResult(pageToResult(cached))
    }
    await response.body?.cancel()
    return await this.fetchFresh(url, d.signal)
  }

  /* jscpd:ignore-start -- transport mirrors @deepseek-ai/dsh-web-fetch-http/provider; MUST evolve together */

  /** Follow same-origin redirects up to the hop cap, then read the final response. */
  private async followAndRead(
    initialUrl: URL,
    signal: AbortSignal,
  ): Promise<{ result: WebFetchResult; etag?: string; lastModified?: string }> {
    let currentUrl = initialUrl
    let redirectsFollowed = 0

    for (;;) {
      const response = await this.requestOnce(currentUrl, signal)

      if (isRedirectStatus(response.status)) {
        if (redirectsFollowed >= this.limits.maxRedirects) {
          await response.body?.cancel()
          throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
        }
        const location = response.headers.get('location')
        if (location === null) {
          await response.body?.cancel()
          throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
        }
        const target = resolveRedirect(location, currentUrl)
        let validatedTarget: URL
        try {
          validatedTarget = validateFetchUrl(target.toString(), this.limits.maxUrlLength)
          if (!isSameOrigin(validatedTarget, currentUrl)) {
            throw new WebError(
              `cross-origin redirect to ${validatedTarget.origin} is not followed automatically; retry against that URL directly`,
              'WEB_REDIRECT_BLOCKED',
            )
          }
        } catch (error: unknown) {
          await response.body?.cancel()
          throw error
        }
        await response.body?.cancel()
        currentUrl = validatedTarget
        redirectsFollowed++
        continue
      }

      const result = await this.readBody(response, currentUrl, signal)
      const etag = response.headers.get('etag') ?? undefined
      const lastModified = response.headers.get('last-modified') ?? undefined
      return { result, ...etag !== undefined ? { etag } : {}, ...lastModified !== undefined ? { lastModified } : {} }
    }
  }

  private async requestOnce(url: URL, signal: AbortSignal): Promise<Response> {
    try {
      return await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': this.limits.userAgent, 'accept': ACCEPT_HEADER },
        signal,
      })
    } catch (error: unknown) {
      throw translateAbortOrNetwork(error, signal)
    }
  }

  /** Read, byte-cap, classify, and decode the final response body. */
  private async readBody(response: Response, finalUrl: URL, signal: AbortSignal): Promise<WebFetchResult> {
    const contentType = response.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      await response.body?.cancel()
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }

    let decoder: TextDecoder
    try {
      decoder = decoderForCharset(parseCharset(contentType))
    } catch (error: unknown) {
      await response.body?.cancel()
      throw error
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response, signal)
    const decoded = decoder.decode(bytes)
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded
    const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }

    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body,
      truncated: truncatedByBytes || truncatedByChars,
    }
  }

  /**
   * Read the response stream up to `maxResponseBytes`. A `Content-Length` over
   * the cap rejects immediately with `WEB_FETCH_TOO_LARGE`; a stream that grows
   * past the cap is cut short (`truncatedByBytes`) rather than rejected.
   */
  private async readCapped(response: Response, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        await response.body?.cancel()
        throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
    }

    /* v8 ignore next -- a 2xx Response from fetch always exposes a body stream; the null guard is defensive. */
    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }

    const chunks: Uint8Array[] = []
    let total = 0
    let truncatedByBytes = false
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = this.limits.maxResponseBytes - total
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } catch (error: unknown) {
      /* v8 ignore next -- mid-stream read fault needs a network drop after headers; translate path covered by request-phase tests. */
      throw translateAbortOrNetwork(error, signal)
    } finally {
      /* v8 ignore next 4 -- cancel() after a completed/broken read settles without rejecting; unobserved best-effort cleanup. */
      await reader.cancel().catch(() => {
        /* best-effort cleanup; the bytes we need are already collected */
      })
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }

  /* jscpd:ignore-end */
}

/** HTTP redirect status codes that carry a `Location`. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Resolve a (possibly relative) `Location` against the current URL. */
function resolveRedirect(location: string, base: URL): URL {
  try {
    return new URL(location, base)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- URL resolution against a valid absolute base effectively never throws; defensive guard. */
    throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/**
 * Translate a thrown fetch/stream error into a `WebError`, classified by the
 * deadline signal: our timeout wins (`WEB_FETCH_TIMEOUT`), any other abort is
 * `WEB_ABORTED`, and a throw with the signal not aborted is a transport
 * failure (`WEB_PROVIDER_ERROR`).
 */
function translateAbortOrNetwork(error: unknown, signal: AbortSignal): WebError {
  const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

/** True for a positive finite number (config sanity). */
function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

/** Rebuild a `WebFetchResult` from a stored page row. */
function pageToResult(page: { url: string; statusCode: number; bodyKind: 'html' | 'text'; body: string; truncated: boolean }): WebFetchResult {
  return {
    url: page.url,
    statusCode: page.statusCode,
    body: page.bodyKind === 'html' ? { kind: 'html', content: page.body } : { kind: 'text', content: page.body },
    truncated: page.truncated,
  }
}

/** Defensive copy so callers never mutate the cached result. */
function cloneResult(result: WebFetchResult): WebFetchResult {
  return { url: result.url, statusCode: result.statusCode, body: { ...result.body }, truncated: result.truncated }
}
