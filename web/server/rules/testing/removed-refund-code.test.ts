import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { legacyBookingDir, legacyOrderDir, legacyRefundDir } from './replay/harness'
import { staffAppDir } from './staff-app-dir'

// Brief W34 (E-plan 4.12, 5 "W34"; lead call L8), as W16's removed-order-code.test.ts and W25's
// removed-booking-code.test.ts: the old refund code step E left behind is gone. The staff app's ten shared modules
// that only the old order refund and event cancellation used, and the Worker's five legacy routes only that code (or
// nothing at all) called. Nothing left in either repo may import, load or call any of it. Comments may still name what
// was ported from where. The one exception, as before: the frozen test-only copies beside this file, which the replay
// alone uses, and which now hold the three routes the old functions still call. They go at step H.

const workerDir = path.resolve(__dirname, '../../..')
const appDir = staffAppDir()

/** The staff app's ten modules W34 deleted (Wayne's yes, 15 Nov). */
const GONE_STAFF_MODULES = [
  'eventCancellation',
  'eventCancellationQuote',
  'heldCardRefund',
  'cardRefundAttempts',
  'storeCreditRefund',
  'refundPaymentIntent',
  'stripeRefundLookup',
  'orderCardPortion',
  'orderPaymentStatus',
  'cancelMembershipSubscription',
]

/** Every file W34 took out of the Worker's app/ (three moved, byte for byte, into the frozen copy; four deleted). */
const DELETED_WORKER = [
  'app/api/payments/refund-order/route.ts',
  'app/api/v1/staff/payments/refunds/route.ts',
  'app/api/memberships/cancel-subscription/route.ts',
  'app/api/bookings/refund/route.ts',
  'app/api/bookings/refund/route.test.ts',
  'app/api/bookings/partial-refund/route.ts',
  'app/api/bookings/partial-refund/route.test.ts',
]

/** The three routes the frozen old functions still call, as they were at Worker 77705a5, where they live now. */
const MOVED: Record<string, { file: string; sha256: string }> = {
  '/api/payments/refund-order': { file: 'routes/payments/refund-order/route.ts', sha256: 'd88890c12c75ce148251d762ab0595d729f0771732ef8c546da352a6a8b48feb' },
  '/api/memberships/cancel-subscription': { file: 'routes/memberships/cancel-subscription/route.ts', sha256: 'e7aef36e737af9ce62ef4dd4354f335e6ae2f53fd808c25fde0e1555916f28b4' },
  '/api/v1/staff/payments/refunds': { file: 'routes/v1/staff/payments/refunds/route.ts', sha256: 'b197e13b7b95df7ceaf0cea4ce710169970ff689a027dac7ecb700f479a5a77a' },
}
/** The two with no caller anywhere, not even the frozen copies (L8): deleted outright. */
const DELETED_OUTRIGHT = ['/api/bookings/refund', '/api/bookings/partial-refund']
const DELETED_ROUTES = [...Object.keys(MOVED), ...DELETED_OUTRIGHT]

/** What the ten modules exported, and the frontend type that went with them (W31 "Noticed" 4): gone from the staff app. */
const REMOVED_STAFF_NAMES = [
  'cancelEventBookingPlaces',
  'quoteEventCancellation',
  'holdCardRefund',
  'settleHeldCardRefunds',
  'heldRefundMessage',
  'noteRefusedCardRefundOn',
  'refusedCardRefundsOn',
  'storeCreditLanded',
  'storeCreditMoved',
  'refundPaymentIntent',
  'cardRefundWithKey',
  'loadOrderCardPortion',
  'recomputeOrderPaymentStatus',
  'recomputeOrdersPaymentStatus',
  'cancelMembershipSubscription',
  'CancelPlacesFailureReason',
]

const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.git', 'storybook-static', 'coverage', '.wrangler'])

const ORDER_FIXTURE_DIR = path.resolve(legacyOrderDir, '../..')
const BOOKING_FIXTURE_DIR = path.resolve(legacyBookingDir, '../..')
const REFUND_FIXTURE_DIR = path.resolve(legacyRefundDir, '../..')
const FIXTURE_DIRS = [ORDER_FIXTURE_DIR, BOOKING_FIXTURE_DIR, REFUND_FIXTURE_DIR]
const REPLAY_DIR = path.join(__dirname, 'replay')
/** The guards of the frozen copies name the copies' files in their own lists. */
const FROZEN_GUARDS = ['frozen-refund-code.test.ts', 'frozen-booking-code.test.ts'].map((file) => path.join(__dirname, file))
/** How a line reaches a frozen copy rather than the staff app: through the harness's names for the copies. */
const FROZEN_MARKER = /\b(oldFunctionPath|legacyRefundDir|legacyBookingDir|legacyOrderDir)\b/

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

/** A literal that names a gone module as a path does (`./shared/x`, `shared/x.ts`, `../x`). */
const namesGoneModuleByPath = (literal: string): string | undefined => {
  const name = literal.replace(/\.ts$/, '')
  return GONE_STAFF_MODULES.find((module) => name === `shared/${module}` || name.endsWith(`/${module}`))
}
/** A literal that is a gone module's bare name, as staff-app-helpers.test.ts's `load('x')` takes it. */
const isGoneModuleName = (literal: string): boolean => GONE_STAFF_MODULES.includes(literal.replace(/\.ts$/, ''))

/** The uses of a gone staff module in some Worker code: each line that names one and doesn't go through a frozen copy. */
function goneModuleUses(code: string): string[] {
  const found: string[] = []
  for (const line of code.split('\n')) {
    if (FROZEN_MARKER.test(line)) continue
    for (const literal of literals(line)) {
      if (namesGoneModuleByPath(literal) || (isGoneModuleName(literal) && /\b(load|import|require)\s*\(/.test(line))) found.push(literal)
    }
  }
  return found
}

const workerFiles = sourceFiles(workerDir, ['app', 'server', 'lib', 'contracts', 'scripts', 'components', 'features']).concat(
  ['custom-worker.ts', 'middleware.ts', 'next.config.ts'].map((file) => path.join(workerDir, file)).filter((file) => existsSync(file))
)
/** The staff app's generated hooks (not in git, rebuilt from the files under /backend by every `retool check`) are left out. */
const GENERATED = [`${path.sep}hooks${path.sep}backend${path.sep}`, `${path.sep}hooks${path.sep}useBackendFunctions.ts`]
const staffAppFiles = sourceFiles(appDir, ['backend', 'frontend']).filter((file) => !GENERATED.some((generated) => file.includes(generated)))
const inFixture = (file: string) => FIXTURE_DIRS.some((dir) => file.startsWith(dir + path.sep))
/** The Worker's files scanned for uses: all of them, less this guard and the frozen copies. */
const scannedWorkerFiles = workerFiles.filter((file) => file !== __filename && !inFixture(file))
const read = (file: string) => withoutComments(readFileSync(file, 'utf8'))
const workerCode = new Map(scannedWorkerFiles.map((file) => [file, read(file)]))
const staffAppCode = new Map(staffAppFiles.map((file) => [file, read(file)]))
const shown = (file: string) => path.relative(path.dirname(workerDir), file)
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

// --- The deleted routes answer 404: Next routes by file, so a path with no route file under app/ is a 404.

/** A route file's folder, relative to app/, as the URL pattern Next serves it at (`[id]` one segment, `[...rest]` the rest, `(group)` none). */
function patternOf(routeDir: string): RegExp {
  const segments = routeDir.split(path.sep).filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment))
  const pattern = segments
    .map((segment) => (/^\[\[?\.\.\..*\]?\]$/.test(segment) ? '.*' : /^\[.*\]$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return new RegExp(`^/${pattern}/?$`)
}
function routePatterns(): Array<{ file: string; pattern: RegExp }> {
  return sourceFiles(workerDir, ['app'])
    .filter((file) => /[\\/]route\.(ts|js)$/.test(file))
    .map((file) => ({ file, pattern: patternOf(path.relative(path.join(workerDir, 'app'), path.dirname(file))) }))
}
const routesServing = (urlPath: string): string[] => routePatterns().filter(({ pattern }) => pattern.test(urlPath)).map(({ file }) => path.relative(workerDir, file))

describe('W34: nothing still needs what was removed', () => {
  it('every deleted file is gone, in both repos, and the frozen copies still hold all ten modules', () => {
    expect(GONE_STAFF_MODULES).toHaveLength(10)
    expect(GONE_STAFF_MODULES.filter((module) => existsSync(path.join(appDir, 'backend/paddock/shared', `${module}.ts`)))).toEqual([])
    expect(DELETED_WORKER).toHaveLength(7)
    expect(DELETED_WORKER.filter((file) => existsSync(path.join(workerDir, file)))).toEqual([])
    // Until step H: the replay's old side runs them from the frozen step E copy.
    expect(GONE_STAFF_MODULES.filter((module) => !existsSync(path.join(legacyRefundDir, 'shared', `${module}.ts`)))).toEqual([])
  })

  it('the three routes the old functions call live only in the frozen copy, byte for byte as they left app/', () => {
    for (const [route, { file, sha256: expected }] of Object.entries(MOVED)) {
      expect(sha256(path.join(ORDER_FIXTURE_DIR, file)), route).toBe(expected)
    }
    // The two with no caller have no copy anywhere.
    const copies = sourceFiles(workerDir, ['server']).map((file) => path.relative(workerDir, file).split(path.sep).join('/'))
    expect(copies.filter((file) => /bookings\/(refund|partial-refund)\/route(\.test)?\.ts$/.test(file))).toEqual([])
  })

  it('the deleted routes answer 404: no route file under app/ serves them (and the ones kept are still served)', () => {
    for (const route of DELETED_ROUTES) expect(routesServing(route), route).toEqual([])
    // No route file is left under the folders they had to themselves.
    for (const dir of ['app/api/bookings', 'app/api/payments', 'app/api/v1/staff/payments', 'app/api/memberships/cancel-subscription']) {
      expect(sourceFiles(workerDir, [dir]), dir).toEqual([])
    }
    // The same check finds the routes that replaced them (a resolver that found nothing would pass the lines above).
    const id = '0f0f0f0f-0000-4000-8000-000000000000'
    expect(routesServing(`/api/v1/staff/orders/${id}/refunds`)).toEqual([path.join('app', 'api', 'v1', 'staff', 'orders', '[orderId]', 'refunds', 'route.ts')])
    expect(routesServing(`/api/v1/staff/bookings/${id}/refunds`)).toHaveLength(1)
    expect(routesServing(`/api/v1/staff/bookings/${id}/cancel-and-refund`)).toHaveLength(1)
    expect(routesServing(`/api/v1/staff/event-bookings/${id}/cancel`)).toHaveLength(1)
    expect(routesServing(`/api/v1/staff/events/${id}/cancel`)).toHaveLength(1)
    // Nothing rewrites or redirects to them either.
    const config = path.join(workerDir, 'next.config.ts')
    const configCode = existsSync(config) ? read(config) : ''
    for (const route of DELETED_ROUTES) expect(configCode.includes(route), route).toBe(false)
  })

  it("nothing in the staff app imports one of its gone modules, and the typecheck barrel doesn't name one", () => {
    const found: string[] = []
    for (const [file, text] of staffAppCode) {
      for (const literal of literals(text)) if (namesGoneModuleByPath(literal)) found.push(`${shown(file)}: '${literal}'`)
    }
    expect(found).toEqual([])
  })

  it("no Worker code or test loads one of the staff app's gone modules, but through a frozen copy", () => {
    const found: string[] = []
    for (const [file, text] of workerCode) {
      if (FROZEN_GUARDS.includes(file)) continue
      for (const literal of goneModuleUses(text)) found.push(`${shown(file)}: '${literal}'`)
    }
    expect(found).toEqual([])
    // W31 review L2: the two tests that loaded the live eventCancellation are gone.
    const helpers = read(path.join(workerDir, 'server/staff-app-helpers.test.ts'))
    expect(/\bcancelEventBookingPlaces\b/.test(helpers)).toBe(false)
  })

  it('no code or test calls a deleted route, but the replay driving the frozen copies', () => {
    const found: string[] = []
    for (const [file, text] of [...workerCode, ...staffAppCode]) {
      if (file.startsWith(REPLAY_DIR + path.sep)) continue
      for (const literal of literals(text)) {
        // `/api/bookings/refund` and not `/api/v1/staff/bookings/:id/refunds`: the path itself, or with something after a slash.
        for (const route of DELETED_ROUTES) if (new RegExp(`${route.replace(/[/-]/g, '\\$&')}(?![\\w-])`).test(literal)) found.push(`${shown(file)}: '${literal}'`)
      }
    }
    expect(found).toEqual([])
    // The harness binds each moved one to the frozen copy's route, never to app/.
    const bindings = read(path.join(REPLAY_DIR, 'legacy-routes.ts'))
    for (const [route, { file }] of Object.entries(MOVED)) {
      expect(bindings).toContain(`'${route}': () => import('../${path.basename(ORDER_FIXTURE_DIR)}/${file.replace(/\.ts$/, '')}')`)
    }
    const appImports = literals(bindings).filter((literal) => literal.startsWith('@/app/api/'))
    expect(appImports.filter((literal) => DELETED_ROUTES.some((route) => literal === `@/app${route}/route`))).toEqual([])
    // The lookup route's own tests moved with it (they sit beside the frozen route and import it from there).
    expect(existsSync(path.join(ORDER_FIXTURE_DIR, 'routes/v1/staff/payments/refunds/route.test.ts'))).toBe(true)
    // The two deleted outright aren't bound, or named, by the replay either.
    for (const [file, text] of workerCode) {
      if (!file.startsWith(REPLAY_DIR + path.sep)) continue
      for (const route of DELETED_OUTRIGHT) expect(literals(text).some((literal) => new RegExp(`${route}(?![\\w-])`).test(literal)), `${shown(file)} ${route}`).toBe(false)
    }
  })

  it('the staff app uses none of the removed names', () => {
    const found: string[] = []
    for (const [file, text] of staffAppCode) {
      for (const name of REMOVED_STAFF_NAMES) if (new RegExp(`\\b${name}\\b`).test(text)) found.push(`${shown(file)}: ${name}`)
    }
    expect(found).toEqual([])
  })

  it('the test itself would catch one (each check finds a planted use)', () => {
    const planted = withoutComments(
      [
        "import { refundPaymentIntent } from './shared/refundPaymentIntent'",
        "const { cancelEventBookingPlaces } = await load('eventCancellation')",
        "const old = await import(oldFunctionPath('shared/orderPaymentStatus'))",
        "const status = String(r['orderPaymentStatus'])",
        "rawRequest({ path: '/api/payments/refund-order' })",
        "rawRequest({ path: '/api/bookings/refund' })",
        "rawRequest({ path: `/api/v1/staff/bookings/${id}/refunds` })",
        '// loadOrderCardPortion is only named in this comment',
        'return loadOrderCardPortion(orderId)',
      ].join('\n')
    )
    expect(literals(planted).filter((literal) => namesGoneModuleByPath(literal) !== undefined)).toEqual(['./shared/refundPaymentIntent', 'shared/orderPaymentStatus'])
    // Through a frozen copy, or a property that happens to share a module's name, isn't a use; a load from the staff app is.
    expect(goneModuleUses(planted)).toEqual(['./shared/refundPaymentIntent', 'eventCancellation'])
    const hits = literals(planted).filter((literal) => DELETED_ROUTES.some((route) => new RegExp(`${route.replace(/[/-]/g, '\\$&')}(?![\\w-])`).test(literal)))
    expect(hits).toEqual(['/api/payments/refund-order', '/api/bookings/refund'])
    expect(planted.match(/\bloadOrderCardPortion\b/g)).toHaveLength(1)
    // A route file put back under app/ is seen by the 404 check's resolver.
    for (const route of DELETED_ROUTES) {
      const restored = patternOf(path.join(...route.split('/').filter(Boolean)))
      expect(restored.test(route), route).toBe(true)
      expect(routePatterns().some(({ pattern }) => pattern.source === restored.source), route).toBe(false)
    }
  })

  it('scans both repos (a wrong folder would pass with nothing to scan)', () => {
    expect(scannedWorkerFiles.some((file) => file.endsWith(path.join('server', 'rules', 'orders', 'refund-lines.ts')))).toBe(true)
    expect(scannedWorkerFiles.some((file) => file.endsWith(path.join('server', 'staff-app-helpers.test.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('backend', 'paddock', 'refundOrder.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('backend', 'paddock', 'typecheckAll.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('frontend', 'types', 'paddock.ts')))).toBe(true)
    expect(routePatterns().length).toBeGreaterThan(30)
  })
})
