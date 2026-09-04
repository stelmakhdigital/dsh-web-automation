/**
 * Rule-pack import/export. A rule pack is a versioned JSON bundle of platform
 * definitions — the portable unit for sharing platform configurations. Import
 * validates the schema and normalizes each platform; export serializes a pack
 * to pretty-printed JSON.
 * @module @deepseek-ai/dsh-web-platforms/rulepacks
 */

import { isPlausibleSearchUrl } from './template.ts'
import { RULE_PACK_VERSION, type HtmlSelectors, type JsonFields, type JsonInHtml, type Platform, type PlatformFormat, type RulePack } from './types.ts'

/** Stable platform id: letters, digits, `_`, `-`; must start alphanumeric. */
const PLATFORM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i

/** The formats a platform may declare. */
const FORMATS = new Set(['html', 'json', 'rss', 'json-in-html'])

/** Read a non-empty string field or throw a descriptive error. */
function requireString(value: unknown, field: string, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`rulepack: ${context}: ${field} must be a non-empty string`)
  }
  return value
}

/** Read an optional string field, returning undefined when absent/empty. */
function optionalString(value: unknown, field: string, context: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`rulepack: ${context}: ${field} must be a string when present`)
  }
  return value
}

/** Read an optional positive-integer field. */
function optionalPositiveInt(value: unknown, field: string, context: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`rulepack: ${context}: ${field} must be a positive integer when present`)
  }
  return value as number
}

/** Validate and normalize a headers record (string → string). */
function validateHeaders(value: unknown, context: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`rulepack: ${context}: headers must be an object when present`)
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') throw new Error(`rulepack: ${context}: headers.${key} must be a string`)
    out[key] = entry
  }
  return out
}

/** Validate and normalize the `selectors` block (required for `html`). */
function validateSelectors(value: unknown, context: string): HtmlSelectors {
  if (value === null || typeof value !== 'object') {
    throw new Error(`rulepack: ${context}: selectors must be an object for html platforms`)
  }
  const item = requireString((value as Record<string, unknown>).item, 'selectors.item', context)
  const url = optionalString((value as Record<string, unknown>).url, 'selectors.url', context)
  const title = optionalString((value as Record<string, unknown>).title, 'selectors.title', context)
  const snippet = optionalString((value as Record<string, unknown>).snippet, 'selectors.snippet', context)
  return {
    item,
    ...(url !== undefined ? { url } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
  }
}

/** Validate and normalize the `fields` block (required for `json`). */
function validateFields(value: unknown, context: string): JsonFields {
  if (value === null || typeof value !== 'object') {
    throw new Error(`rulepack: ${context}: fields must be an object for json platforms`)
  }
  const items = requireString((value as Record<string, unknown>).items, 'fields.items', context)
  const url = requireString((value as Record<string, unknown>).url, 'fields.url', context)
  const urlPrefix = optionalString((value as Record<string, unknown>).urlPrefix, 'fields.urlPrefix', context)
  const title = optionalString((value as Record<string, unknown>).title, 'fields.title', context)
  const snippet = optionalString((value as Record<string, unknown>).snippet, 'fields.snippet', context)
  const publishedAt = optionalString((value as Record<string, unknown>).publishedAt, 'fields.publishedAt', context)
  return {
    items,
    url,
    ...(urlPrefix !== undefined ? { urlPrefix } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  }
}

/** Validate and normalize the `jsonInHtml` block (required for `json-in-html`). */
function validateJsonInHtml(value: unknown, context: string): JsonInHtml {
  if (value === null || typeof value !== 'object') {
    throw new Error(`rulepack: ${context}: jsonInHtml must be an object for json-in-html platforms`)
  }
  const marker = requireString((value as Record<string, unknown>).marker, 'jsonInHtml.marker', context)
  const fields = validateFields((value as Record<string, unknown>).fields, context)
  return { marker, fields }
}

/**
 * Validate and normalize one raw platform definition.
 * @param raw - the parsed (untrusted) platform object.
 * @param context - a human-readable location label for errors.
 * @returns the normalized {@link Platform}.
 */
export function validatePlatform(raw: unknown, context: string): Platform {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`rulepack: ${context}: platform must be an object`)
  }
  const obj = raw as Record<string, unknown>
  const id = requireString(obj.id, 'id', context)
  if (!PLATFORM_ID_PATTERN.test(id)) throw new Error(`rulepack: ${context}: id "${id}" is not a valid platform id`)
  const name = requireString(obj.name, 'name', context)
  const formatRaw = requireString(obj.format, 'format', context)
  if (!FORMATS.has(formatRaw)) throw new Error(`rulepack: ${context}: format "${formatRaw}" is not one of html|json|rss|json-in-html`)
  const format = formatRaw as PlatformFormat

  const platform: Platform = { id, name, format }
  const searchUrl = optionalString(obj.searchUrl, 'searchUrl', context)
  if (searchUrl !== undefined) platform.searchUrl = searchUrl
  const headers = validateHeaders(obj.headers, context)
  if (headers !== undefined) platform.headers = headers
  const maxResults = optionalPositiveInt(obj.maxResults, 'maxResults', context)
  if (maxResults !== undefined) platform.maxResults = maxResults
  const notes = optionalString(obj.notes, 'notes', context)
  if (notes !== undefined) platform.notes = notes

  switch (format) {
    case 'html': {
      if (searchUrl === undefined || !isPlausibleSearchUrl(searchUrl)) {
        throw new Error(`rulepack: ${context}: html platforms need a plausible absolute searchUrl`)
      }
      platform.selectors = validateSelectors(obj.selectors, context)
      break
    }
    case 'json': {
      if (searchUrl === undefined || !isPlausibleSearchUrl(searchUrl)) {
        throw new Error(`rulepack: ${context}: json platforms need a plausible absolute searchUrl`)
      }
      platform.fields = validateFields(obj.fields, context)
      break
    }
    case 'json-in-html': {
      if (searchUrl === undefined || !isPlausibleSearchUrl(searchUrl)) {
        throw new Error(`rulepack: ${context}: json-in-html platforms need a plausible absolute searchUrl`)
      }
      platform.jsonInHtml = validateJsonInHtml(obj.jsonInHtml, context)
      break
    }
    case 'rss': {
      // The query argument is the feed URL; searchUrl is not required.
      break
    }
  }
  return platform
}

/**
 * Validate and normalize a parsed rule-pack object.
 * @param raw - the parsed (untrusted) rule-pack object.
 * @returns the validated {@link RulePack}.
 */
export function validateRulePack(raw: unknown): RulePack {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('rulepack: top level must be an object')
  }
  const obj = raw as Record<string, unknown>
  if (obj.version !== RULE_PACK_VERSION) {
    throw new Error(`rulepack: unsupported version ${String(obj.version)} (expected ${RULE_PACK_VERSION})`)
  }
  const name = requireString(obj.name, 'name', 'pack')
  const description = optionalString(obj.description, 'description', 'pack')
  if (!Array.isArray(obj.platforms)) throw new Error('rulepack: platforms must be an array')
  const platforms = obj.platforms.map((entry, index) => validatePlatform(entry, `platforms[${index}]`))
  const seen = new Set<string>()
  for (const platform of platforms) {
    if (seen.has(platform.id)) throw new Error(`rulepack: duplicate platform id "${platform.id}"`)
    seen.add(platform.id)
  }
  return { version: RULE_PACK_VERSION, name, ...(description !== undefined ? { description } : {}), platforms }
}

/**
 * Import a rule pack from a JSON string or object.
 * @param input - a JSON string or an already-parsed object.
 * @returns the validated {@link RulePack}.
 */
export function importRulePack(input: string | object): RulePack {
  const parsed: unknown = typeof input === 'string' ? JSON.parse(input) : input
  return validateRulePack(parsed)
}

/**
 * Export a rule pack to pretty-printed JSON.
 * @param pack - the rule pack to serialize.
 * @returns the JSON text.
 */
export function exportRulePack(pack: RulePack): string {
  return `${JSON.stringify(pack, null, 2)}\n`
}
