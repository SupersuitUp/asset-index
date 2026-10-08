import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// One zone for every run, so a golden recorded anywhere matches on CI and on the publish run.
process.env.TZ = 'UTC'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['test/consumer/**', 'node_modules/**'],
    passWithNoTests: true,
  },
  resolve: {
    alias: [
      { find: 'server-only', replacement: fileURLToPath(new URL('./test/support/empty.ts', import.meta.url)) },
      { find: /^@supersuit\/asset-index$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
    ],
  },
})
