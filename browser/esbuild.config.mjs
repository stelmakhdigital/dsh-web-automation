// Build the browser plugin: bundle each entry to lib/ as Node ESM. The
// @deepseek-ai/* host packages and playwright stay EXTERNAL — they resolve to
// the host DSH's node_modules (peer model) and the installed playwright
// package at runtime, so the bundle carries no duplicated host/browser state.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

// @deepseek-ai/ is provided by the host DSH deployment; playwright is a
// regular dependency installed alongside the plugin.
const external = [/^@deepseek-ai\//, 'playwright']

await build({
  entryPoints: [join(root, 'src/index.ts'), join(root, 'src/invariant.ts')],
  outdir: join(root, 'lib'),
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  bundle: true,
  external,
  sourcemap: false,
  logLevel: 'info',
})
