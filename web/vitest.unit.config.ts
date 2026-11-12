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
      // W16: the replay's test-only copy of the staff app's removed order code (server/rules/testing/legacy-order)
      // imports the staff app's remaining modules from its checkout, as staffAppDir() finds it.
      '@retool-app': process.env.RETOOL_APP_DIR ?? path.resolve(__dirname, '../../paddock-retool-app'),
    },
  },
  test: {
    name: 'unit',
    environment: 'node',
    include: ['app/**/*.test.ts', 'lib/**/*.test.ts', 'server/**/*.test.ts', 'contracts/**/*.test.ts'],
    // Brief W11 (W10a O1): any request to a Stripe host is refused before it is sent, and the test that
    // made it fails ("a test reached real Stripe"). Proof: server/rules/testing/no-real-stripe.test.ts.
    setupFiles: ['./server/rules/testing/no-real-stripe.ts'],
    // Each rule test file starts its own PGlite, which compiles a 9 MB WebAssembly Postgres. That
    // is quick alone but passes the 10-second default once the CPU is busy: four suites at once
    // failed every time, and pass in 20 to 30 seconds with this limit. Ten at once still fail.
    hookTimeout: 60_000,
  },
})
