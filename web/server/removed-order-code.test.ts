import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'

// Brief W16 (W03-plan 3.3): the old order code, the shadow, the dry run, the parity and probe routes, and the legacy
// routes only the old order code called, are gone. Nothing left in either repo may import, load or call any of it.
// Comments may still name what was ported from where. The one exception (Wayne, 12 Nov, option B): a frozen
// test-only copy in server/rules/testing/legacy-order, which only the replay harness may use, to set up the golden
// scenarios that start from an old order. It goes at step H.

const workerDir = path.resolve(__dirname, '..')
const appDir = staffAppDir()

/** Every file W16 deleted, by repo. */
const DELETED = {
  staffApp: [
    'backend/paddock/shared/orderQuoteShadow.ts',
    'backend/paddock/shared/shadowCompare.ts',
    'backend/paddock/shared/stableDiff.ts',
    'backend/paddock/shared/readerOrderRollback.ts',
    'backend/paddock/shared/createMembershipSubscription.ts',
    'backend/paddock/shared/eventOrders.ts',
    'backend/paddock/shared/promoCodeLookup.ts',
    'backend/paddock/shared/generateGiftCardCode.ts',
    'backend/paddock/createBooking.ts',
  ],
  worker: [
    'app/api/v1/staff/orders/dry-run/route.ts',
    'app/api/v1/staff/parity/route.ts',
    'server/parity/index.ts',
    'server/parity/index.test.ts',
    'app/api/v1/staff/probes/transaction/route.ts',
    'server/probes/transaction.ts',
    'server/probes/transaction.test.ts',
    'app/api/terminal/connection-token/route.ts',
    'app/api/terminal/create-setup-intent/route.ts',
    'app/api/terminal/resolve-saved-card/route.ts',
    'app/api/memberships/create-subscription/route.ts',
    'app/api/memberships/create-subscription/core.ts',
    'app/api/memberships/create-subscription/core.test.ts',
    'app/api/payments/method/[id]/route.ts',
    'server/reader-rollback.test.ts',
    'server/rules/testing/replay/quote-shadow.test.ts',
    'server/rules/testing/replay/quote-differences.ts',
    // The W16 delete list's addendum: the old reader tests' schema, scanned here for existence only.
    'server/rules/testing/reader-orders-schema.sql',
  ],
}

/** The staff app's deleted modules, as an import or a test's loader names them (with or without `.ts`). */
const DELETED_STAFF_MODULES = DELETED.staffApp.map((file) => file.replace(/^backend\/paddock\//, '').replace(/\.ts$/, ''))

/** The Worker's deleted modules, as `@/` imports name them. */
const DELETED_WORKER_MODULES = DELETED.worker
  .filter((file) => !file.endsWith('.test.ts'))
  .map((file) => `@/${file.replace(/\.ts$/, '').replace(/\/index$/, '')}`)

/** The routes W16 deleted, as a caller would write the path. */
const DELETED_ROUTES = [
  '/api/v1/staff/orders/dry-run',
  '/api/v1/staff/parity',
  '/api/v1/staff/probes/transaction',
  '/api/terminal/connection-token',
  '/api/terminal/create-setup-intent',
  '/api/terminal/resolve-saved-card',
  '/api/memberships/create-subscription',
  '/api/payments/method/',
]

/** Functions W16 removed from files that stay (or deleted with their file). */
const REMOVED_NAMES = [
  'finaliseReaderOrderOld',
  'cancelReaderOrderOld',
  'saveCustomerCardOnFileUnguarded',
  'createBookingUnguarded',
  'withQuoteShadow',
  'shadowCompare',
  'stableDiff',
  'oldParams',
  'dryRunOrder',
  'orderDryRunOutputSchema',
  'OrderDryRunOutput',
  'recordParity',
  'staffParityInputSchema',
  'probeTransaction',
]

const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.git', 'storybook-static', 'coverage', '.wrangler'])

/** The test-only copy, and the two files that bind it for the replay's setup. */
const FIXTURE_DIR = path.join(workerDir, 'server/rules/testing/legacy-order')
const FIXTURE_USERS = ['server/rules/testing/replay/harness.ts', 'server/rules/testing/replay/legacy-routes.ts'].map((file) => path.join(workerDir, file))
/** The routes the copy still calls, bound in legacy-routes.ts to the copy's own routes. */
const FIXTURE_ROUTES = ['/api/memberships/create-subscription', '/api/terminal/resolve-saved-card']

function sourceFiles(root: string, dirs: string[]): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith('.d.ts')) found.push(full)
    }
  }
  for (const dir of dirs) walk(path.join(root, dir))
  return found
}

/** The code without its comments, so a comment naming what was ported from where doesn't count. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

/** Every string literal in the code. */
function literals(code: string): string[] {
  return [...code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '')
}

const workerFiles = sourceFiles(workerDir, ['app', 'server', 'lib', 'contracts', 'scripts', 'components', 'features']).concat(
  ['custom-worker.ts', 'middleware.ts'].map((file) => path.join(workerDir, file)).filter((file) => existsSync(file))
)
const staffAppFiles = sourceFiles(appDir, ['backend', 'frontend']).filter((file) => !file.includes(`${path.sep}hooks${path.sep}backend${path.sep}`))
/** W17: the frozen copy of the old step D functions, guarded by frozen-booking-code.test.ts. It is old code too. */
const BOOKING_FIXTURE_DIR = path.join(workerDir, 'server/rules/testing/legacy-booking')
const everyFile = [...workerFiles, ...staffAppFiles].filter(
  (file) => file !== __filename && !file.startsWith(FIXTURE_DIR + path.sep) && !file.startsWith(BOOKING_FIXTURE_DIR + path.sep)
)
const code = new Map(everyFile.map((file) => [file, withoutComments(readFileSync(file, 'utf8'))]))
const shown = (file: string) => path.relative(path.dirname(workerDir), file)

describe('W16: nothing still needs what was removed', () => {
  it('every deleted file is gone, in both repos', () => {
    expect(DELETED.staffApp.length + DELETED.worker.length).toBe(27)
    expect(DELETED.staffApp.filter((file) => existsSync(path.join(appDir, file)))).toEqual([])
    expect(DELETED.worker.filter((file) => existsSync(path.join(workerDir, file)))).toEqual([])
  })

  it("no code or test imports or loads one of the staff app's deleted modules", () => {
    const found: string[] = []
    for (const [file, text] of code) {
      for (const literal of literals(text)) {
        const name = literal.replace(/\.ts$/, '')
        const hit = DELETED_STAFF_MODULES.find(
          (module) => name === module || name.endsWith(`/${module}`) || (module.includes('/') && name === module.split('/').pop())
        )
        if (hit) found.push(`${shown(file)}: '${literal}'`)
      }
    }
    expect(found).toEqual([])
  })

  it("no code or test imports one of the Worker's deleted modules", () => {
    const found: string[] = []
    for (const [file, text] of code) {
      for (const literal of literals(text)) {
        if (DELETED_WORKER_MODULES.includes(literal.replace(/\.ts$/, ''))) found.push(`${shown(file)}: '${literal}'`)
        if (/quote-differences(\.ts)?$/.test(literal)) found.push(`${shown(file)}: '${literal}'`)
      }
    }
    expect(found).toEqual([])
  })

  it('no code or test calls a deleted route', () => {
    const found: string[] = []
    for (const [file, text] of code) {
      for (const literal of literals(text)) {
        for (const route of DELETED_ROUTES) {
          const standIn = FIXTURE_USERS.includes(file) && FIXTURE_ROUTES.includes(literal)
          if (literal.includes(route) && !standIn) found.push(`${shown(file)}: '${literal}'`)
        }
      }
    }
    expect(found).toEqual([])
  })

  it('no code or test uses a removed function', () => {
    const found: string[] = []
    for (const [file, text] of code) {
      for (const name of REMOVED_NAMES) if (new RegExp(`\\b${name}\\b`).test(text)) found.push(`${shown(file)}: ${name}`)
    }
    expect(found).toEqual([])
  })

  it('the test-only copy is used by the replay harness alone, never by the app or the staff app', () => {
    const users = [...code].filter(([, text]) => literals(text).some((literal) => literal.includes('legacy-order'))).map(([file]) => file)
    expect(users.map(shown).sort()).toEqual(FIXTURE_USERS.map(shown).sort())
    const viaHarness = [...code]
      .filter(([, text]) => /\b(legacyOrderDir|LEGACY_ORDER_ACTIONS)\b/.test(text))
      .map(([file]) => path.relative(workerDir, file))
      .filter((file) => !file.startsWith(path.join('server', 'rules', 'testing') + path.sep))
    expect(viaHarness).toEqual([])
    expect(readdirSync(path.join(FIXTURE_DIR, 'backend/paddock')).sort()).toEqual(
      ['cancelReaderOrder.ts', 'createBooking.ts', 'createOrder.ts', 'finaliseReaderOrder.ts', 'saveCustomerCardOnFile.ts', 'shared'].sort()
    )
  })

  it('the test itself would catch one (each check finds a planted use)', () => {
    const planted = withoutComments(
      [
        "import { stableDiff } from './shared/stableDiff'",
        "const fn = await load('readerOrderRollback.ts')",
        "await import('@/server/parity')",
        "rawRequest({ path: '/api/terminal/resolve-saved-card' })",
        '// finaliseReaderOrderOld is only named in this comment',
        'return finaliseReaderOrderOld(req)',
      ].join('\n')
    )
    const strings = literals(planted)
    expect(strings.some((literal) => DELETED_STAFF_MODULES.some((module) => literal.endsWith(`/${module}`)))).toBe(true)
    expect(strings.some((literal) => DELETED_STAFF_MODULES.some((module) => module.split('/').pop() === literal.replace(/\.ts$/, '')))).toBe(true)
    expect(strings.some((literal) => DELETED_WORKER_MODULES.includes(literal))).toBe(true)
    expect(strings.some((literal) => DELETED_ROUTES.some((route) => literal.includes(route)))).toBe(true)
    expect(planted.match(/\bfinaliseReaderOrderOld\b/g)).toHaveLength(1)
  })

  it('scans both repos (a wrong folder would pass with nothing to scan)', () => {
    expect(workerFiles.some((file) => file.endsWith(path.join('server', 'rules', 'orders', 'place-order.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('backend', 'paddock', 'createOrder.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('frontend', 'components', 'CheckoutDialog.tsx')))).toBe(true)
  })
})
