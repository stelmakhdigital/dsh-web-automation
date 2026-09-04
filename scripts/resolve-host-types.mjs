#!/usr/bin/env node
/**
 * Resolve the host DSH source tree for a strict `typecheck:host` run.
 *
 * The plugin's `@deepseek-ai/*` peer deps are provided by the host DSH at
 * runtime. For a strict typecheck (instead of the local `types/deepseek-ai.d.ts`
 * stubs), this script maps every `@deepseek-ai/*` package to its SOURCE entry
 * in a DSH checkout, reusing the host's own `tsconfig.base.json` `paths` map
 * (the authoritative, maintained mapping — including subpath exports and
 * wildcards). The host typechecks from source (no `lib/` build needed); its
 * third-party deps resolve from the host's own `node_modules` (run
 * `pnpm install` in the host checkout first).
 *
 * Outputs (written into the plugin root):
 *   - tsconfig.host.json          — root package, real host types
 *   - tsconfig.host.browser.json  — browser sub-package, real host types
 *   - types/host-stubs.d.ts       — the local stubs MINUS the modules that are
 *                                   now mapped to real sources (kept: playwright
 *                                   and any @deepseek-ai module the host map
 *                                   does not cover)
 *
 * Usage:
 *   node scripts/resolve-host-types.mjs --host /path/to/deepseek-harness [--root .]
 *
 * Exit codes: 0 = ok; 1 = host checkout or tsconfig.base.json missing/unreadable.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function parseArgs(argv) {
  const args = { host: undefined, root: ROOT }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--host') args.host = argv[++i]
    else if (arg === '--root') args.root = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: resolve-host-types.mjs --host <dsh-checkout> [--root <plugin-root>]')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(1)
    }
  }
  return args
}

/**
 * Strip JSONC comments (// and /* *\/) outside of string literals.
 * @param {string} text - the JSONC document.
 * @returns {string} the JSON text.
 */
function stripJsoncComments(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    out += ch
  }
  return out
}

/**
 * Match a module name against a paths key that may carry one `*` wildcard.
 * @param {string} key - the paths key (e.g. `@deepseek-ai/dsh-*`).
 * @param {string} name - the module name to test.
 * @returns {boolean}
 */
function pathsKeyMatches(key, name) {
  if (!key.includes('*')) return key === name
  const pattern = `^${key.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`
  return new RegExp(pattern).test(name)
}

/**
 * Remove `declare module '<name>' { ... }` blocks from a stub file for every
 * name covered by the given paths keys (exact or wildcard match).
 * @param {string} stubText - the stub source.
 * @param {string[]} keys - the paths keys.
 * @returns {string} the filtered stub source.
 */
function filterStubs(stubText, keys) {
  const marker = /declare module '([^']+)'\s*\{/g
  let result = ''
  let cursor = 0
  let match
  while ((match = marker.exec(stubText)) !== null) {
    const name = match[1]
    const covered = keys.some(key => pathsKeyMatches(key, name))
    if (!covered) continue
    // Find the matching closing brace of this module block.
    let depth = 1
    let i = match.index + match[0].length
    let inString = false
    let stringChar = ''
    let escaped = false
    for (; i < stubText.length && depth > 0; i++) {
      const ch = stubText[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === stringChar) inString = false
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        inString = true
        stringChar = ch
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    result += stubText.slice(cursor, match.index)
    cursor = i
  }
  result += stubText.slice(cursor)
  return result
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.host === undefined) {
    console.error('error: --host <dsh-checkout> is required')
    process.exit(1)
  }
  const hostDir = isAbsolute(args.host) ? args.host : resolve(args.root, args.host)
  const basePath = join(hostDir, 'tsconfig.base.json')
  if (!existsSync(basePath)) {
    console.error(`error: ${basePath} not found — is --host a deepseek-harness checkout?`)
    process.exit(1)
  }

  const base = JSON.parse(stripJsoncComments(readFileSync(basePath, 'utf8')))
  const paths = base?.compilerOptions?.paths
  if (paths === undefined || typeof paths !== 'object' || Object.keys(paths).length === 0) {
    console.error('error: tsconfig.base.json has no compilerOptions.paths map')
    process.exit(1)
  }

  // Rebase every paths target from the host root to the plugin root.
  const hostRel = relative(args.root, hostDir).split(sep).join('/')
  const rebased = {}
  for (const [key, targets] of Object.entries(paths)) {
    rebased[key] = targets.map(target => (target.startsWith('./') ? `${hostRel}${target.slice(1)}` : target))
  }

  const compilerOptions = {
    baseUrl: '.',
    paths: rebased,
    esModuleInterop: true,
    // The host packages typecheck under per-package tsconfigs that relax
    // several strict sub-flags (e.g. vendor/cordis relaxes noImplicitAny,
    // noUncheckedIndexedAccess, ...). One mixed program needs the LOOSEST
    // common denominator so every host source file compiles; relaxing never
    // breaks the plugin sources (they were written under the stricter set).
    noImplicitAny: false,
    noImplicitThis: false,
    strictFunctionTypes: false,
    noUncheckedIndexedAccess: false,
    exactOptionalPropertyTypes: false,
    noImplicitOverride: false,
    noUnusedLocals: false,
    noUnusedParameters: false,
    verbatimModuleSyntax: false,
    rewriteRelativeImportExtensions: false,
    allowImportingTsExtensions: true,
  }

  const rootTsconfig = {
    extends: './tsconfig.json',
    compilerOptions,
    // The filtered stubs replace the full stubs (the mapped modules now
    // resolve to real host sources; the rest — playwright, unmapped modules —
    // keep their stubs).
    include: ['src/**/*.ts', 'test/**/*.ts', 'types/host-stubs.d.ts'],
  }
  const browserTsconfig = {
    extends: './browser/tsconfig.json',
    compilerOptions,
    include: ['browser/src/**/*.ts', 'browser/test/**/*.ts', 'types/host-stubs.d.ts'],
  }

  const stubText = readFileSync(join(args.root, 'types/deepseek-ai.d.ts'), 'utf8')
  const filteredStubs = `// GENERATED by scripts/resolve-host-types.mjs — do not edit.\n// Host-mapped @deepseek-ai/* modules resolve to real DSH sources via\n// tsconfig.host.json paths; this file keeps only the remaining stubs.\n\n${filterStubs(stubText, Object.keys(paths))}\n`

  writeFileSync(join(args.root, 'tsconfig.host.json'), `${JSON.stringify(rootTsconfig, null, 2)}\n`)
  writeFileSync(join(args.root, 'tsconfig.host.browser.json'), `${JSON.stringify(browserTsconfig, null, 2)}\n`)
  mkdirSync(join(args.root, 'types'), { recursive: true })
  writeFileSync(join(args.root, 'types/host-stubs.d.ts'), filteredStubs)

  const mapped = Object.keys(paths).length
  console.log(`host: ${hostDir} (relative: ${hostRel})`)
  console.log(`mapped ${mapped} paths entries; wrote tsconfig.host.json, tsconfig.host.browser.json, types/host-stubs.d.ts`)
  console.log('next: npx tsc -p tsconfig.host.json --noEmit && npx tsc -p tsconfig.host.browser.json --noEmit')
}

main()
