import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { legacyBookingDir, legacyOrderDir } from './replay/harness'
import { staffAppDir } from './staff-app-dir'

// Brief W25 (D-plan 4.12, 4.13, 5 "W25"), as W16's removed-order-code.test.ts: the old payment code step D left behind
// is gone. The staff app's chargeSavedCard and createTerminalPaymentIntent, the old sweep's flow part, the stuck
// list's old parts, the flow wrappers' old bodies, the `old_reader_flow` and old-order paths and words, W23's look-up
// of old `booking.card_refund_unsure` notes, and the Worker's three legacy routes only that code called. Nothing left in
// either repo may import, load or call any of it. Comments may still name what was ported from where. The one
// exception, as at W16: the frozen test-only copies beside this file (the old order code's and the old step D
// functions'), which the replay harness alone uses to set up golden scenarios, and which now hold the three routes
// too. They go at step H. This guard names them through the harness, as frozen-booking-code.test.ts does, so it isn't
// one more file naming either folder.

const workerDir = path.resolve(__dirname, '../../..')
const appDir = staffAppDir()

/** Every file W25 took out of the app, by repo (the Worker's three routes moved, byte for byte, into the frozen copy). */
const DELETED = {
  staffApp: [
    'backend/paddock/chargeSavedCard.ts',
    'backend/paddock/createTerminalPaymentIntent.ts',
    // No caller left after the above; deleted with Wayne's yes (13 Nov, brief W25 item 3).
    'backend/paddock/sweepPendingReaderPayments.ts',
    'backend/paddock/shared/workerItems.ts',
    'backend/paddock/shared/pendingReaderFlows.ts',
    'backend/paddock/shared/readerFlowFinalise.ts',
    'backend/paddock/shared/terminalPaymentIntent.ts',
    'backend/paddock/shared/creditRedemption.ts',
    'backend/paddock/shared/sessionCapacity.ts',
  ],
  worker: [
    'app/api/payments/charge-saved-card/route.ts',
    'app/api/payments/charge-saved-card/core.ts',
    'app/api/payments/charge-saved-card/core.test.ts',
    'app/api/terminal/create-payment-intent/route.ts',
    'app/api/terminal/payment-intent/route.ts',
    'app/api/terminal/payment-intent/core.ts',
    'app/api/terminal/payment-intent/core.test.ts',
    // Nothing imported it since W14b; deleted with Wayne's yes (13 Nov).
    'server/rules/orders/reconcile-contracts.ts',
  ],
}

/**
 * Staff app files with no caller left, listed for Wayne's yes before they are deleted (brief W25 item 3: not
 * pre-approved). Empty since his yes on 13 Nov (the seven are in DELETED above). While a file is on this list, nothing
 * but the typecheck barrel and the other files on it may import it.
 */
const AWAITING_YES: string[] = []
const TYPECHECK_BARREL = 'backend/paddock/typecheckAll.ts'

/** A staff app module as an import or a test's loader names it (with or without `.ts`). */
const moduleName = (file: string): string => file.replace(/^backend\/paddock\//, '').replace(/\.ts$/, '')
const GONE_STAFF_MODULES = [...DELETED.staffApp, ...AWAITING_YES].map(moduleName)

/** The Worker's deleted modules, as `@/` imports name them. */
const DELETED_WORKER_MODULES = DELETED.worker.filter((file) => !file.endsWith('.test.ts')).map((file) => `@/${file.replace(/\.ts$/, '')}`)

/** The routes W25 deleted, as a caller writes the path. */
const DELETED_ROUTES = ['/api/payments/charge-saved-card', '/api/terminal/create-payment-intent', '/api/terminal/payment-intent']

/** Names W25 removed from files that stay (or deleted with their file). */
const REMOVED_NAMES = [
  // The staff app.
  'chargeSavedCardUnguarded',
  'createTerminalPaymentIntentUnguarded',
  'finaliseOldFlow',
  'cancelOldFlow',
  'OLD_FLOWS_ONLY',
  'OLD_ORDERS_ONLY',
  'WORKER_FLOWS_ONLY',
  'OLD_ITEM_WORDS',
  'sweepLine',
  'useSweepPendingReaderPayments',
  'useChargeSavedCard',
  'useCreateTerminalPaymentIntent',
  'ReaderSweepSummary',
  // The Worker.
  'old_reader_flow',
  'old_reader_order',
  'OLD_READER_FLOW_MESSAGE',
  'OLD_READER_ORDER_MESSAGE',
  'old_code',
  'oldLeftAlone',
  'OLD_DUE_SQL',
  'oldUnsureRefundsThatWent',
  'matchOldRefunds',
  'OldRefundsLooked',
  'MatchedPart',
  'REFUND_CHECK_FAILED_MESSAGE',
  'oldRefundReachedCustomerMessage',
]

const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.git', 'storybook-static', 'coverage', '.wrangler'])

/** The frozen test-only copies, and the replay harness and tests that drive them (they name the old routes to bind and to interrupt them). */
const ORDER_FIXTURE_DIR = path.resolve(legacyOrderDir, '../..')
const BOOKING_FIXTURE_DIR = path.resolve(legacyBookingDir, '../..')
const REPLAY_DIR = path.join(__dirname, 'replay')
/** W16's guard names some of the same things in its own lists. */
const W16_GUARD = path.join(workerDir, 'server/removed-order-code.test.ts')

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
  ['custom-worker.ts', 'middleware.ts', 'next.config.ts'].map((file) => path.join(workerDir, file)).filter((file) => existsSync(file))
)
const awaitingYesFiles = AWAITING_YES.map((file) => path.join(appDir, file))
/** The staff app's generated hooks (not in git, rebuilt from the files under /backend by every `retool check`) are left out. */
const GENERATED = [`${path.sep}hooks${path.sep}backend${path.sep}`, `${path.sep}hooks${path.sep}useBackendFunctions.ts`]
const staffAppFiles = sourceFiles(appDir, ['backend', 'frontend']).filter((file) => !GENERATED.some((generated) => file.includes(generated)))
/** Everything scanned for uses: both repos, less this guard, W16's, the frozen copies, and the files waiting for a yes. */
const everyFile = [...workerFiles, ...staffAppFiles].filter(
  (file) =>
    file !== __filename &&
    file !== W16_GUARD &&
    !file.startsWith(ORDER_FIXTURE_DIR + path.sep) &&
    !file.startsWith(BOOKING_FIXTURE_DIR + path.sep) &&
    !awaitingYesFiles.includes(file)
)
const code = new Map(everyFile.map((file) => [file, withoutComments(readFileSync(file, 'utf8'))]))
const shown = (file: string) => path.relative(path.dirname(workerDir), file)

/** Whether a literal names one of the staff app's gone modules. */
const namesGoneModule = (literal: string): string | undefined => {
  const name = literal.replace(/\.ts$/, '')
  return GONE_STAFF_MODULES.find((module) => name === module || name.endsWith(`/${module}`) || (module.includes('/') && name === module.split('/').pop()))
}

// --- The deleted routes answer 404: Next routes by file, so a path with no route file under app/ is a 404.

/** Every route file under app/, as the URL pattern Next serves it at (`[id]` one segment, `[...rest]` the rest, `(group)` none). */
function routePatterns(): Array<{ file: string; pattern: RegExp }> {
  return sourceFiles(workerDir, ['app'])
    .filter((file) => /[\\/]route\.(ts|js)$/.test(file))
    .map((file) => {
      const segments = path
        .relative(path.join(workerDir, 'app'), path.dirname(file))
        .split(path.sep)
        .filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment))
      const pattern = segments
        .map((segment) => (/^\[\[?\.\.\..*\]?\]$/.test(segment) ? '.*' : /^\[.*\]$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('/')
      return { file, pattern: new RegExp(`^/${pattern}/?$`) }
    })
}
const routesServing = (urlPath: string): string[] => routePatterns().filter(({ pattern }) => pattern.test(urlPath)).map(({ file }) => path.relative(workerDir, file))

describe('W25: nothing still needs what was removed', () => {
  it('every deleted file is gone, in both repos, and the three routes live only in the frozen copy', () => {
    expect(DELETED.staffApp.length + DELETED.worker.length).toBe(17)
    expect(DELETED.staffApp.filter((file) => existsSync(path.join(appDir, file)))).toEqual([])
    expect(DELETED.worker.filter((file) => existsSync(path.join(workerDir, file)))).toEqual([])
    for (const moved of [
      'routes/payments/charge-saved-card/route.ts',
      'routes/payments/charge-saved-card/core.ts',
      'routes/terminal/create-payment-intent/route.ts',
      'routes/terminal/payment-intent/route.ts',
      'routes/terminal/payment-intent/core.ts',
    ]) {
      expect(existsSync(path.join(ORDER_FIXTURE_DIR, moved)), moved).toBe(true)
    }
  })

  it('the deleted routes answer 404: no route file under app/ serves them (and the ones kept are still served)', () => {
    for (const route of DELETED_ROUTES) expect(routesServing(route), route).toEqual([])
    // The same check finds the routes that stay (a resolver that found nothing would pass the lines above).
    expect(routesServing('/api/payments/refund-order')).toEqual([path.join('app', 'api', 'payments', 'refund-order', 'route.ts')])
    expect(routesServing('/api/bookings/refund')).toHaveLength(1)
    expect(routesServing('/api/bookings/partial-refund')).toHaveLength(1)
    expect(routesServing('/api/v1/staff/payments/refunds')).toHaveLength(1)
    expect(routesServing('/api/v1/staff/reader-flows/0f0f0f0f-0000-4000-8000-000000000000/finalise')).toHaveLength(1)
    expect(routesServing('/api/v1/staff/orders/reconcile')).toHaveLength(1)
    // Nothing rewrites or redirects to them either.
    const config = path.join(workerDir, 'next.config.ts')
    const configCode = existsSync(config) ? withoutComments(readFileSync(config, 'utf8')) : ''
    for (const route of DELETED_ROUTES) expect(configCode.includes(route), route).toBe(false)
  })

  it("no code or test imports or loads one of the staff app's gone modules", () => {
    const found: string[] = []
    for (const [file, text] of code) {
      // The typecheck barrel still names a file waiting for Wayne's yes, until it is deleted.
      const barrel = file === path.join(appDir, TYPECHECK_BARREL)
      for (const literal of literals(text)) {
        const hit = namesGoneModule(literal)
        if (!hit) continue
        const waiting = AWAITING_YES.map(moduleName).includes(hit) && existsSync(path.join(appDir, 'backend/paddock', `${hit}.ts`))
        if (barrel && waiting) continue
        found.push(`${shown(file)}: '${literal}'`)
      }
    }
    expect(found).toEqual([])
  })

  it("a file waiting for Wayne's yes is imported by nothing but the typecheck barrel and the other files on the list", () => {
    // Covered for every other file by the check above; here, the list itself: each file is either gone or still whole.
    const still = AWAITING_YES.filter((file) => existsSync(path.join(appDir, file)))
    const barrel = withoutComments(readFileSync(path.join(appDir, TYPECHECK_BARREL), 'utf8'))
    for (const file of AWAITING_YES) {
      const named = literals(barrel).some((literal) => literal === `./${moduleName(file)}`)
      // Deleted with its barrel line, or neither.
      expect(named, file).toBe(still.includes(file))
    }
  })

  it("no code or test imports one of the Worker's deleted modules", () => {
    const found: string[] = []
    for (const [file, text] of code) {
      for (const literal of literals(text)) {
        if (DELETED_WORKER_MODULES.includes(literal.replace(/\.ts$/, ''))) found.push(`${shown(file)}: '${literal}'`)
      }
    }
    expect(found).toEqual([])
  })

  it('no code or test calls a deleted route, but the replay harness driving the frozen copy', () => {
    const found: string[] = []
    for (const [file, text] of code) {
      if (file.startsWith(REPLAY_DIR + path.sep)) continue
      for (const literal of literals(text)) {
        for (const route of DELETED_ROUTES) if (literal.includes(route)) found.push(`${shown(file)}: '${literal}'`)
      }
    }
    expect(found).toEqual([])
    // The harness binds each one to the frozen copy's route, never to app/.
    const bindings = withoutComments(readFileSync(path.join(REPLAY_DIR, 'legacy-routes.ts'), 'utf8'))
    for (const route of DELETED_ROUTES) {
      expect(bindings).toContain(`'${route}': () => import('../${path.basename(ORDER_FIXTURE_DIR)}/routes${route.replace('/api', '')}/route')`)
    }
    expect(literals(bindings).filter((literal) => literal.startsWith('@/app/api/') && DELETED_ROUTES.some((route) => literal.includes(route.replace('/api/', ''))))).toEqual([])
  })

  it('no code or test uses a removed name', () => {
    const found: string[] = []
    for (const [file, text] of code) {
      for (const name of REMOVED_NAMES) if (new RegExp(`\\b${name}\\b`).test(text)) found.push(`${shown(file)}: ${name}`)
    }
    expect(found).toEqual([])
  })

  it('Resolve now calls reconcile only: the stuck banner and the stuck list reach nothing but the Worker', () => {
    const banner = withoutComments(readFileSync(path.join(appDir, 'frontend/components/StuckPaymentsBanner.tsx'), 'utf8'))
    const hooks = [...banner.matchAll(/\buse[A-Z][A-Za-z]+\b/g)].map((match) => match[0]).filter((name) => /^use(Get|Reconcile|Close|Sweep|Charge|Create|Finalise|Cancel)/.test(name))
    expect([...new Set(hooks)].sort()).toEqual(['useCloseStuckOrder', 'useGetStuckReaderPayments', 'useReconcileOrders'])
    // The list, the run and the flow wrappers: thin calls, with no query of their own.
    for (const name of ['getStuckReaderPayments', 'reconcileOrders', 'finaliseReaderPayment', 'cancelReaderPayment']) {
      const text = withoutComments(readFileSync(path.join(appDir, 'backend/paddock', `${name}.ts`), 'utf8'))
      expect(text.includes('paddockData'), name).toBe(false)
      expect(text.includes('paddockBackendApi2'), name).toBe(false)
      expect(text.includes('callWorker'), name).toBe(true)
    }
  })

  it('the test itself would catch one (each check finds a planted use)', () => {
    const planted = withoutComments(
      [
        "import { chargeSavedCardUnguarded } from './chargeSavedCard'",
        "const fn = await load('shared/pendingReaderFlows.ts')",
        "await import('@/app/api/terminal/payment-intent/core')",
        "rawRequest({ path: '/api/payments/charge-saved-card' })",
        '// old_reader_flow is only named in this comment',
        "return { reason: 'old_reader_flow' }",
      ].join('\n')
    )
    const strings = literals(planted)
    expect(strings.filter((literal) => namesGoneModule(literal) !== undefined)).toEqual(['./chargeSavedCard', 'shared/pendingReaderFlows.ts'])
    expect(strings.some((literal) => DELETED_WORKER_MODULES.includes(literal))).toBe(true)
    expect(strings.some((literal) => DELETED_ROUTES.some((route) => literal.includes(route)))).toBe(true)
    expect(planted.match(/\bold_reader_flow\b/g)).toHaveLength(1)
    // A route file put back is seen by the 404 check's resolver.
    const pattern = /^\/api\/terminal\/payment-intent\/?$/
    expect(pattern.test('/api/terminal/payment-intent')).toBe(true)
    expect(routePatterns().some((route) => route.pattern.source === pattern.source)).toBe(false)
  })

  it('scans both repos (a wrong folder would pass with nothing to scan)', () => {
    expect(workerFiles.some((file) => file.endsWith(path.join('server', 'rules', 'orders', 'reader-flow.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('backend', 'paddock', 'finaliseReaderPayment.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('frontend', 'components', 'StuckPaymentsBanner.tsx')))).toBe(true)
    expect(routePatterns().length).toBeGreaterThan(30)
  })
})
