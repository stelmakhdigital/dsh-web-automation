/**
 * JSON result extraction for `json` and `json-in-html` platforms. Fields are
 * addressed by dot-separated paths; a missing field yields `undefined` (never
 * an error), and items without a string URL are skipped rather than fatal.
 * @module @deepseek-ai/dsh-web-platforms/parse-json
 */

import type { JsonFields, PlatformSource } from './types.ts'

/**
 * Resolve a dot-separated path against a parsed JSON value. Array indices are
 * addressed as numeric segments (e.g. `runs.0.text`).
 * @param value - the parsed JSON root (or a nested node).
 * @param path - a dot-separated field path (e.g. `data.children`).
 * @returns the resolved value, or `undefined` when any segment is missing.
 */
export function resolvePath(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Coerce a resolved field to a trimmed non-empty string. HTML tags are
 * stripped (platforms like Bilibili embed markup in titles); internal
 * whitespace collapses to single spaces.
 */
function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  return text.length > 0 ? text : undefined
}

/**
 * Parse a JSON document into platform sources using the configured field paths.
 * @param text - the raw JSON body.
 * @param fields - the platform's {@link JsonFields}.
 * @returns the parsed sources, in document order.
 * @throws a `SyntaxError` when the body is not valid JSON.
 */
export function parseJsonResults(text: string, fields: JsonFields): PlatformSource[] {
  const root: unknown = JSON.parse(text)
  return itemsToSources(root, fields)
}

/** Project a parsed root's items array into sources (shared by json/json-in-html). */
function itemsToSources(root: unknown, fields: JsonFields): PlatformSource[] {
  const items = resolvePath(root, fields.items)
  if (!Array.isArray(items)) return []
  const sources: PlatformSource[] = []
  for (const item of items) {
    const rawUrl = asText(resolvePath(item, fields.url))
    if (rawUrl === undefined) continue
    const url = fields.urlPrefix !== undefined ? `${fields.urlPrefix}${rawUrl}` : rawUrl
    const source: PlatformSource = { url }
    if (fields.title !== undefined) {
      const title = asText(resolvePath(item, fields.title))
      if (title !== undefined) source.title = title
    }
    if (fields.snippet !== undefined) {
      const snippet = asText(resolvePath(item, fields.snippet))
      if (snippet !== undefined) source.snippet = snippet
    }
    if (fields.publishedAt !== undefined) {
      const publishedAt = asText(resolvePath(item, fields.publishedAt))
      if (publishedAt !== undefined) source.publishedAt = publishedAt
    }
    sources.push(source)
  }
  return sources
}

/**
 * Locate and extract the JSON object that follows `marker` in an HTML document,
 * using balanced-brace scanning that respects string literals and escapes.
 * @param html - the raw HTML document.
 * @param marker - the text immediately preceding the JSON object.
 * @returns the extracted JSON object as text.
 * @throws an `Error` when the marker or a balanced object is not found.
 */
export function extractJsonAfterMarker(html: string, marker: string): string {
  const markerIndex = html.indexOf(marker)
  if (markerIndex < 0) throw new Error(`json-in-html marker not found: ${marker}`)
  const start = html.indexOf('{', markerIndex + marker.length)
  if (start < 0) throw new Error(`json-in-html: no object after marker ${marker}`)
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < html.length; i++) {
    const ch = html[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return html.slice(start, i + 1)
    }
  }
  throw new Error('json-in-html: unbalanced object after marker')
}
