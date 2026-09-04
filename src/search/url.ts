/**
 * URL normalization for cache keys and result de-duplication.
 * @module @deepseek-ai/dsh-web-search-multi/url
 */

/** Tracking-parameter prefixes stripped during normalization. */
const TRACKING_PARAM = /^(utm_|fbclid|gclid|mc_(eid|cid)|ref|source)/i

/**
 * Normalize a URL for cache keys and de-duplication: strip the fragment and
 * common tracking parameters. The scheme and host are kept as-is (the URL
 * parser already lower-cases the host). Unparseable input is returned
 * unchanged — a cache key only needs to be stable, not canonical.
 * @param url - the URL to normalize.
 * @returns the normalized URL string.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) parsed.searchParams.delete(key)
    }
    return parsed.toString()
  } catch {
    return url
  }
}
