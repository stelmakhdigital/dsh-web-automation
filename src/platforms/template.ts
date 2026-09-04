/**
 * Search URL template expansion. A platform's `searchUrl` carries `{query}`
 * (always), and optional `{limit}` and `{page}` placeholders. The query value
 * is percent-encoded so it is safe inside a query string; the numeric
 * placeholders are substituted verbatim. Unknown `{...}` tokens are preserved.
 * @module @deepseek-ai/dsh-web-platforms/template
 */

/** Values available for template substitution. */
export interface TemplateValues {
  /** The search query (percent-encoded on substitution). */
  query: string
  /** Optional page size / result-count placeholder value. */
  limit?: number
  /** Optional page-number placeholder value (1-based). */
  page?: number
}

/**
 * Expand a search URL template.
 * @param template - the `searchUrl` template.
 * @param values - the substitution values.
 * @returns the expanded URL string.
 */
export function expandTemplate(template: string, values: TemplateValues): string {
  let out = template
  out = out.replaceAll('{query}', encodeURIComponent(values.query))
  if (values.limit !== undefined) out = out.replaceAll('{limit}', String(values.limit))
  if (values.page !== undefined) out = out.replaceAll('{page}', String(values.page))
  return out
}

/**
 * Validate that a template is a plausible absolute HTTP(S) URL once the query
 * is substituted. This is a cheap local check (no network) used to reject
 * misconfigured platforms before a fetch is attempted.
 * @param template - the `searchUrl` template.
 * @returns true when the template expands to an absolute http(s) URL.
 */
export function isPlausibleSearchUrl(template: string): boolean {
  // Substitute a benign probe so URL.canParse sees a concrete value.
  const probe = expandTemplate(template, { query: 'probe' })
  return URL.canParse(probe) && /^https?:/i.test(probe)
}
