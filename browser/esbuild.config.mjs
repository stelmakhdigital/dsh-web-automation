// Build the browser plugin: bundle each entry to lib/ as Node ESM. The
// @deepseek-ai/* host packages and playwright stay EXTERNAL — they resolve to
// the host DSH's node_modules (peer model) and the installed playwright
// package at runtime, so the bundle carries no duplicated host/browser state.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

// Mark every @deepseek-ai/* import as external (provided by the host DSH).
const externalScope = /^@deepseek-ai\//
const externalPlugin = {
  name: 'external-deepseek-scope',
  setup(b) {
    b.onResolve({ filter: externalScope }, args => ({ path: args.path, external: true }))
  },
}

// Third-party deps that stay external (resolved from node_modules at runtime).
const externalThirdParty = ['playwright']

await build({
  entryPoints: [join(root, 'src/index.ts'), join(root, 'src/invariant.ts')],
  outdir: join(root, 'lib'),
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  bundle: true,
  external: externalThirdParty,
  plugins: [externalPlugin],
  sourcemap: false,
  logLevel: 'info',
})
