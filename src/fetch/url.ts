/**
 * URL normalization for cache keys. Intentionally parallel to the module in
 * `@deepseek-ai/dsh-web-search-multi` (each package owns its dependencies);
 * the two MUST evolve together.
 * @module @deepseek-ai/dsh-web-fetch-cached/url
 */

/* jscpd:ignore-start -- mirrors @deepseek-ai/dsh-web-search-multi/url; MUST evolve together */

/** Tracking-parameter prefixes stripped during normalization. */
const TRACKING_PARAM = /^(utm_|fbclid|gclid|mc_(eid|cid)|ref|source)/i

/**
 * Normalize a URL for cache keys: strip the fragment and common tracking
 * parameters. Unparseable input is returned unchanged — a cache key only
 * needs to be stable, not canonical.
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

/* jscpd:ignore-end */
