// Build the plugin: bundle each entry to lib/ as Node ESM. The @deepseek-ai/*
// host packages and cheerio stay EXTERNAL — they resolve to the host DSH's
// node_modules at runtime (peer model), so the bundle carries no duplicated
// host state. Only the plugin's own source is inlined.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

// Everything under @deepseek-ai/ is provided by the host DSH deployment.
const external = [/^@deepseek-ai\//, 'cheerio']

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
