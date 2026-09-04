#!/usr/bin/env node
/**
 * Strict host typecheck with a stub fallback.
 *
 * When `DSH_HOST` points at a deepseek-harness checkout (with its
 * `node_modules` installed — `pnpm install` in the host), this resolves the
 * `@deepseek-ai/*` peer deps to the host's REAL source types (via
 * `resolve-host-types.mjs`) and typechecks both packages against them.
 *
 * When `DSH_HOST` is unset or missing, it falls back to the local stub
 * typecheck (`npm run typecheck`) and exits with that result — so the script
 * is always a usable gate, strict when a host is available.
 *
 * Usage:
 *   DSH_HOST=/path/to/deepseek-harness npm run typecheck:host
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const host = process.env.DSH_HOST

function run(command, args, label) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined) {
    console.error(`typecheck:host: ${label} failed to start: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`typecheck:host: ${label} failed (exit ${result.status})`)
    process.exit(result.status ?? 1)
  }
}

if (host === undefined || host === '' || !existsSync(host)) {
  console.warn(`typecheck:host: DSH_HOST is not set or missing (${host ?? 'undefined'}) — falling back to the stub typecheck.`)
  run('npm', ['run', 'typecheck'], 'stub typecheck')
  process.exit(0)
}

run(process.execPath, [fileURLToPath(new URL('./resolve-host-types.mjs', import.meta.url)), '--host', host], 'resolve-host-types')
run('npx', ['tsc', '-p', 'tsconfig.host.json', '--noEmit'], 'host typecheck (root)')
run('npx', ['tsc', '-p', 'tsconfig.host.browser.json', '--noEmit'], 'host typecheck (browser)')
console.log('typecheck:host: OK — checked against the DSH host sources.')
