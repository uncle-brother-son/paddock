import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Dedicated config for plain Node unit tests (API route logic, pure functions). The existing
// vitest.config.ts is Storybook/browser-only (playwright-based) — kept separate rather than
// merged, so this never risks altering the Storybook test runner's behavior.
export default defineConfig({
  resolve: {
    alias: {
      // Matches tsconfig.json's "@/*" -> "./*" path mapping, which Vitest doesn't resolve on its own.
      '@': path.resolve(__dirname, '.'),
      // Next swaps this marker package for an empty module on the server; tests need the same.
      'server-only': path.resolve(__dirname, 'node_modules/next/dist/compiled/server-only/empty.js'),
    },
  },
  test: {
    name: 'unit',
    environment: 'node',
    include: ['app/**/*.test.ts', 'lib/**/*.test.ts', 'server/**/*.test.ts', 'contracts/**/*.test.ts'],
  },
})
