/**
 * The platform registry: merges built-in, configured, and rule-pack platform
 * definitions (later sources override earlier by id) and hot-reloads rule-pack
 * files by mtime. Rule-pack files are small local JSON; a missing or invalid
 * file keeps its last good state rather than breaking searches.
 * @module @deepseek-ai/dsh-web-platforms/registry
 */

import { statSync, readFileSync } from 'node:fs'
import { importRulePack } from './rulepacks.ts'
import type { Platform } from './types.ts'

/** Registry construction options. */
export interface PlatformRegistryOptions {
  /** Built-in platforms (lowest precedence). */
  builtins: readonly Platform[]
  /** Platforms from plugin config (cordis.yml); override built-ins by id. */
  configured: readonly Platform[]
  /** Rule-pack JSON file paths (highest precedence); hot-reloaded by mtime. */
  rulePackPaths: readonly string[]
}

/** One rule-pack file's cached load state. */
interface RulePackCacheEntry {
  /** The mtime (ms) the cached platforms were read at; -1 when the file is absent. */
  mtimeMs: number
  /** The last successfully loaded platforms (empty when never loaded). */
  platforms: Platform[]
  /** The most recent load error, if any (informational). */
  error?: string
}

/**
 * Merge platforms by id, later entries overriding earlier ones.
 * @param groups - platform groups in ascending precedence order.
 * @returns the merged, de-duplicated platforms (first-seen order, overridden in place).
 */
export function mergePlatforms(groups: readonly (readonly Platform[])[]): Platform[] {
  const byId = new Map<string, Platform>()
  const order: string[] = []
  for (const group of groups) {
    for (const platform of group) {
      if (!byId.has(platform.id)) order.push(platform.id)
      byId.set(platform.id, platform)
    }
  }
  return order.map(id => byId.get(id) as Platform)
}

/** The platform registry. */
export class PlatformRegistry {
  private readonly builtins: readonly Platform[]
  private readonly configured: readonly Platform[]
  private readonly rulePackPaths: readonly string[]
  private readonly rulePackCache = new Map<string, RulePackCacheEntry>()

  constructor(options: PlatformRegistryOptions) {
    this.builtins = options.builtins
    this.configured = options.configured
    this.rulePackPaths = options.rulePackPaths
  }

  /**
   * Re-read rule-pack files whose mtime changed (hot reload). Safe to call on
   * every search; unchanged files are not re-read.
   */
  refresh(): void {
    for (const path of this.rulePackPaths) {
      let mtimeMs: number
      try {
        mtimeMs = statSync(path).mtimeMs
      } catch {
        // Absent (or unreadable) file: contributes no platforms.
        this.rulePackCache.set(path, { mtimeMs: -1, platforms: [] })
        continue
      }
      const cached = this.rulePackCache.get(path)
      if (cached !== undefined && cached.mtimeMs === mtimeMs) continue
      try {
        const text = readFileSync(path, 'utf8')
        const pack = importRulePack(text)
        this.rulePackCache.set(path, { mtimeMs, platforms: pack.platforms })
      } catch (error) {
        // Keep the last good state; record the error for diagnostics.
        const previous = this.rulePackCache.get(path)
        this.rulePackCache.set(path, {
          mtimeMs,
          platforms: previous?.platforms ?? [],
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  /** The merged platform list (built-ins < configured < rule packs). */
  list(): Platform[] {
    this.refresh()
    const rulePackGroups = this.rulePackPaths.map(path => this.rulePackCache.get(path)?.platforms ?? [])
    return mergePlatforms([this.builtins, this.configured, ...rulePackGroups])
  }

  /** Look up one platform by id. */
  get(id: string): Platform | undefined {
    return this.list().find(platform => platform.id === id)
  }

  /** Whether a platform id is registered. */
  has(id: string): boolean {
    return this.get(id) !== undefined
  }

  /** All registered platform ids, in merge order. */
  ids(): string[] {
    return this.list().map(platform => platform.id)
  }

  /** The most recent rule-pack load errors (path → message), if any. */
  rulePackErrors(): Record<string, string> {
    const errors: Record<string, string> = {}
    for (const [path, entry] of this.rulePackCache) {
      if (entry.error !== undefined) errors[path] = entry.error
    }
    return errors
  }
}
