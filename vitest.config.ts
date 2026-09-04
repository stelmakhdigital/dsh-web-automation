import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'browser/test/**/*.test.ts'],
    // The plugin sources use `.ts` extensions in relative imports (ESM style);
    // vitest resolves them natively (no extra resolver needed).
  },
})
