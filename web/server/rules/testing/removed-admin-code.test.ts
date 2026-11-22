import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { legacyAccountDir, legacyAdminDir } from './replay/harness'
import { staffAppDir } from './staff-app-dir'

// Brief W61 (G-plan 5 "W61", 4.10; Wayne's yes, 22 Nov 2026, on briefs/W61-report.md part 1: S1 to S18, W1 to W11),
// as W16's removed-order-code.test.ts, W25's removed-booking-code.test.ts, W34's removed-refund-code.test.ts and W44's
// removed-account-code.test.ts: the old code step G left behind is gone. In the Worker: the seven legacy /api/catalog
// routes, their README, the price-move helper and its test, and the empty database.types.ts. In the staff app: the
// sixteen shared modules and the empty globals.ts with no caller left, and validatePromoCode (no screen called it since
// W14a). Nothing left in either repo may import, load or call any of it. Comments may still say what was ported from
// where. The one exception, as before: the frozen test-only copies beside this file, which the replay alone uses and
// which have held the seven routes, the helper and the step G modules since W48. They go at step H.

const workerDir = path.resolve(__dirname, '../../..')
const appDir = staffAppDir()
const ADMIN_COPY = path.resolve(legacyAdminDir, '../..')

/** The seven routes, as the old staff app called them, and the Worker route that does each job now (an example path). */
const DELETED_ROUTES: Record<string, string> = {
  '/api/catalog/toggle-active': '/api/v1/staff/catalog/products/0f0f0f0f-0000-4000-8000-000000000000/active',
  '/api/catalog/update-price': '/api/v1/staff/catalog/products/0f0f0f0f-0000-4000-8000-000000000000/price',
  '/api/catalog/update-tier-price': '/api/v1/staff/catalog/tiers/0f0f0f0f-0000-4000-8000-000000000000/price',
  '/api/catalog/create-variant': '/api/v1/staff/catalog/products/0f0f0f0f-0000-4000-8000-000000000000/variants',
  '/api/catalog/sync-stripe': '/api/v1/staff/catalog/membership-plans',
  '/api/catalog/create-gift-card-preset': '/api/v1/staff/catalog/gift-card-types/0f0f0f0f-0000-4000-8000-000000000000/presets',
  '/api/catalog/update-gift-card-preset-price': '/api/v1/staff/catalog/gift-card-presets/0f0f0f0f-0000-4000-8000-000000000000/price',
}
const ROUTE_NAMES = Object.keys(DELETED_ROUTES).map((route) => route.replace(/^\/api\/catalog\//, ''))

/** Every file W61 took out of the Worker (nothing was moved: the frozen copy has held its own since W48). */
const DELETED_WORKER = [
  ...ROUTE_NAMES.map((name) => `app/api/catalog/${name}/route.ts`),
  'app/api/catalog/README.md',
  'lib/membership-price-migration.ts',
  'lib/membership-price-migration.test.ts',
  'lib/supabase/database.types.ts',
]
/** What the frozen step G copy still holds of them, for the replay's old side. */
const KEPT_IN_THE_COPY = [...ROUTE_NAMES.map((name) => `routes/catalog/${name}/route.ts`), 'routes/catalog/README.md', 'lib/membership-price-migration.ts']

/** Every file W61 took out of the staff app. */
const DELETED_STAFF_MODULES = [
  'shared/pricingStaff.ts',
  'shared/staffAccess.ts',
  'shared/resolveStaffId.ts',
  'shared/toggleItemActive.ts',
  'shared/extractApiErrorMessage.ts',
  'shared/extractStructuredApiError.ts',
  'shared/stockAdjustments.ts',
  'shared/promoCodes.ts',
  'shared/eventAttendance.ts',
  'shared/eventCheckIn.ts',
  'shared/eventAttendeeList.ts',
  'shared/readerPaymentOpen.ts',
  'shared/bookingPaymentOpenWords.ts',
  'shared/isoDateTime.ts',
  'shared/guestValidation.ts',
  'shared/londonTime.ts',
  'globals.ts',
]
const DELETED_STAFF_FUNCTIONS = ['validatePromoCode.ts']
const DELETED_STAFF_APP = [...DELETED_STAFF_MODULES, ...DELETED_STAFF_FUNCTIONS].map((file) => `backend/paddock/${file}`)
/** Where the replay's old side still finds each module (validatePromoCode was a thin call: there is nothing old to keep). */
const frozenOf = (module: string): string => path.join(module === 'shared/guestValidation.ts' ? legacyAccountDir : legacyAdminDir, module)

const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.git', 'storybook-static', 'coverage', '.wrangler'])
const TESTING_DIR = __dirname
const REPLAY_DIR = path.join(TESTING_DIR, 'replay')
/** The guards that list the copies' files and the old exports by name (each reads the copies, never the staff app). */
const GUARDS = new Set(readdirSync(TESTING_DIR).filter((name) => /^(frozen|removed)-.*\.test\.ts$/.test(name)).map((name) => path.join(TESTING_DIR, name)))

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
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
/** Every string literal in the code. */
const literals = (code: string): string[] => [...code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '')
/** What a file imports: `from '...'`, a side-effect `import '...'`, and `import('...')` of a literal. Never a method called `from`. */
const importsOf = (code: string): string[] => [...code.matchAll(/(?<![.\w])(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')

/** A deleted Worker file an import lands on, from a file in the Worker (`@/…` from the root, `./…` from the file's folder). */
function deletedWorkerTargetOf(file: string, target: string): string | undefined {
  const from = target.startsWith('@/') ? path.join(workerDir, target.slice(2)) : target.startsWith('.') ? path.resolve(path.dirname(file), target) : null
  if (!from) return undefined
  const landed = path.relative(workerDir, from).split(path.sep).join('/').replace(/\.(ts|js)$/, '')
  return DELETED_WORKER.find((deleted) => deleted.replace(/\.ts$/, '') === landed)
}
/** A deleted staff app file an import lands on, from a file in the staff app. */
function deletedStaffTargetOf(file: string, target: string): string | undefined {
  if (!target.startsWith('.')) return undefined
  const landed = path.relative(appDir, path.resolve(path.dirname(file), target)).split(path.sep).join('/').replace(/\.(ts|tsx)$/, '')
  return DELETED_STAFF_APP.find((deleted) => deleted.replace(/\.ts$/, '') === landed)
}
/**
 * A literal that calls or loads one of the seven routes: the path itself (with something after a slash or a query),
 * or the app's route file. A sentence that only mentions one (the old words kept for the words test) is not a call.
 */
const deletedRouteIn = (literal: string): string | undefined =>
  Object.keys(DELETED_ROUTES).find((route) => new RegExp(`^(@/app)?${route.replace(/[/-]/g, '\\$&')}(?![\\w-])`).test(literal))
/**
 * Where a Worker test still reads a deleted staff app file: the staff app's loader (`load('name')`, in the two tests
 * whose `load` is the staff app's folder) or a path into the staff app's checkout.
 */
const STAFF_APP_LOADERS = [path.join(workerDir, 'server/staff-app-helpers.test.ts'), path.join(workerDir, 'server/rules/staff-wrappers.test.ts')]
const staffNames = (file: string): string[] => {
  const bare = file.replace(/^backend\/paddock\//, '').replace(/\.ts$/, '')
  return [bare, `${bare}.ts`, bare.replace(/^shared\//, ''), `${bare.replace(/^shared\//, '')}.ts`, file]
}
function deletedStaffReadsIn(code: string, isLoader: boolean): string[] {
  const found: string[] = []
  for (const deleted of DELETED_STAFF_APP) {
    const names = staffNames(deleted)
    if (isLoader) {
      for (const match of code.matchAll(/(?<![.\w])(load|same|wrapper)\(\s*'([^']+)'/g)) if (names.includes(match[2] ?? '')) found.push(`${match[1] ?? ''}('${match[2] ?? ''}')`)
      for (const match of code.matchAll(/\bname:\s*'([^']+)'/g)) if (names.includes(match[1] ?? '')) found.push(`name: '${match[1] ?? ''}'`)
    }
    for (const match of code.matchAll(/path\.join\(\s*(appDir|shared|functions)\s*,\s*'([^']+)'/g)) {
      const target = (match[2] ?? '').replace(/^\.\//, '')
      if (names.includes(target)) found.push(`path.join(${match[1] ?? ''}, '${target}')`)
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
const COPY_DIRS = [path.resolve(legacyAdminDir, '../..'), path.resolve(legacyAccountDir, '../..')]
const inACopy = (file: string) => file.includes(`${path.sep}testing${path.sep}legacy-`) || COPY_DIRS.some((dir) => file.startsWith(dir + path.sep))
/** The Worker's files scanned for uses: all of them, less this guard and the frozen copies. */
const scannedWorkerFiles = workerFiles.filter((file) => file !== __filename && !inACopy(file))
const read = (file: string) => withoutComments(readFileSync(file, 'utf8'))
const workerCode = new Map(scannedWorkerFiles.map((file) => [file, read(file)]))
const staffAppCode = new Map(staffAppFiles.map((file) => [file, read(file)]))
const shown = (file: string) => path.relative(path.dirname(workerDir), file)

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

/** typecheckAll.ts's import lines, as the files they name (relative to backend/paddock, with `.ts`). */
const barrelFiles = (source: string): string[] => importsOf(withoutComments(source)).map((target) => `${target.replace(/^\.\//, '')}.ts`)
/** Every function and shared module the staff app has: what typecheckAll.ts says it pulls in. */
function staffBackendFiles(): string[] {
  const backend = path.join(appDir, 'backend/paddock')
  const top = readdirSync(backend).filter((name) => name.endsWith('.ts') && name !== 'typecheckAll.ts')
  const shared = readdirSync(path.join(backend, 'shared')).filter((name) => name.endsWith('.ts')).map((name) => `shared/${name}`)
  return [...top, ...shared]
}

describe('W61: nothing still needs what was removed', () => {
  it('every deleted file is gone, in both repos, and the frozen copies still hold what the replay runs', () => {
    expect(DELETED_WORKER).toHaveLength(11)
    expect(DELETED_WORKER.filter((file) => existsSync(path.join(workerDir, file)))).toEqual([])
    expect(DELETED_STAFF_APP).toHaveLength(18)
    expect(DELETED_STAFF_APP.filter((file) => existsSync(path.join(appDir, file)))).toEqual([])
    // Until step H: the replay's old side runs the seven routes and the helper from step G's copy...
    expect(KEPT_IN_THE_COPY.filter((file) => !existsSync(path.join(ADMIN_COPY, file)))).toEqual([])
    // ...and every module from a copy, byte for byte as the staff app had it (frozen-admin-code.test.ts holds the bytes).
    expect(DELETED_STAFF_MODULES.filter((module) => !existsSync(frozenOf(module)))).toEqual([])
  })

  it('the seven routes answer 404: no route file under app/ serves them, and the routes that do their jobs now are served', () => {
    for (const route of Object.keys(DELETED_ROUTES)) expect(routesServing(route), route).toEqual([])
    // Nothing at all is left under the folder they had to themselves.
    expect(existsSync(path.join(workerDir, 'app/api/catalog'))).toBe(false)
    // The same check finds the routes that do the jobs now (a resolver that found nothing would pass the lines above).
    for (const [route, now] of Object.entries(DELETED_ROUTES)) expect(routesServing(now), route).toHaveLength(1)
    // Nothing rewrites or redirects to them either.
    const config = path.join(workerDir, 'next.config.ts')
    const configCode = existsSync(config) ? read(config) : ''
    for (const route of Object.keys(DELETED_ROUTES)) expect(configCode.includes(route), route).toBe(false)
  })

  it('no Worker code or test imports a deleted Worker file', () => {
    const found: string[] = []
    for (const [file, text] of workerCode) {
      // frozen-admin-code.test.ts names the copy's repointed import line and the original's, as data (REPOINTED).
      if (GUARDS.has(file)) continue
      for (const target of importsOf(text)) if (deletedWorkerTargetOf(file, target)) found.push(`${shown(file)}: '${target}'`)
    }
    expect(found).toEqual([])
  })

  it('no code or test calls a deleted route, in either repo, but the replay driving the frozen copy and the guards that name the copy', () => {
    const found: string[] = []
    for (const [file, text] of [...workerCode, ...staffAppCode]) {
      if (file.startsWith(REPLAY_DIR + path.sep) || GUARDS.has(file)) continue
      for (const literal of literals(text)) if (deletedRouteIn(literal)) found.push(`${shown(file)}: '${literal}'`)
    }
    expect(found).toEqual([])
    // The harness binds each one to the frozen copy's route, never to app/.
    const bindings = read(path.join(REPLAY_DIR, 'legacy-routes.ts'))
    for (const route of Object.keys(DELETED_ROUTES)) expect(bindings).toContain(`'${route}': () => import('../${path.basename(ADMIN_COPY)}/routes${route.replace(/^\/api/, '')}/route')`)
    expect(literals(bindings).filter((literal) => literal.startsWith('@/app/api/catalog'))).toEqual([])
  })

  it("the Worker never answers the old private service type words, which sent staff to a deleted route (the lead's call)", () => {
    const users = [...workerCode].filter(([, text]) => /\bprivateServiceTypesUsePriceTiers\b/.test(text)).map(([file]) => shown(file))
    // Only the words file, which keeps the old sentence for the words test (admin/words.test.ts reads them all).
    expect(users).toEqual([shown(path.join(workerDir, 'server/rules/catalog/failure-messages.ts'))])
    expect(read(path.join(workerDir, 'server/rules/catalog/items.ts'))).toContain("'private_service_type', NEW_WORDS.privateServiceTypeUsesTiers)")
  })

  it('nothing in the staff app imports a deleted file', () => {
    const found: string[] = []
    for (const [file, text] of staffAppCode) {
      for (const target of importsOf(text)) if (deletedStaffTargetOf(file, target)) found.push(`${shown(file)}: '${target}'`)
    }
    expect(found).toEqual([])
  })

  it("no Worker test loads a deleted staff app file from the staff app's checkout (the frozen copies only)", () => {
    const found: string[] = []
    for (const [file, text] of workerCode) {
      if (GUARDS.has(file)) continue
      for (const hit of deletedStaffReadsIn(text, STAFF_APP_LOADERS.includes(file))) found.push(`${shown(file)}: ${hit}`)
    }
    expect(found).toEqual([])
  })

  it("typecheckAll.ts names every function and shared module the staff app has, and nothing it doesn't: its comment is true", () => {
    const named = barrelFiles(readFileSync(path.join(appDir, 'backend/paddock/typecheckAll.ts'), 'utf8')).sort()
    expect(named).toEqual(staffBackendFiles().sort())
    expect(new Set(named).size).toBe(named.length)
    for (const gone of DELETED_STAFF_APP) expect(named, gone).not.toContain(gone.replace(/^backend\/paddock\//, ''))
    // The twelve it lacked before W61 (the lead's call on part 1's Noticed 3).
    for (const added of [
      'getMembershipRetryPaymentQuote.ts',
      'getMembershipSettingsQuote.ts',
      'getMoneyOwed.ts',
      'getOrderRefundFigures.ts',
      'getSessionPassLevelQuote.ts',
      'refundOrderOwed.ts',
      'retryMembershipPayment.ts',
      'shared/catalogWorker.ts',
      'shared/eventCancelWorker.ts',
      'shared/orderRefundWorker.ts',
      'shared/passTypeWorker.ts',
      'shared/planWorker.ts',
    ]) {
      expect(named, added).toContain(added)
    }
  })

  it("createOrder keeps New Order's guest type itself, now its shared module is gone", () => {
    const source = read(path.join(appDir, 'backend/paddock/createOrder.ts'))
    expect(source).toMatch(/export interface GuestInput \{\s+name: string\s+email\?: string\s+dateOfBirth\?: string\s+\}/)
    expect(source).toContain('guests: GuestInput[]')
    expect(importsOf(source).filter((target) => target.includes('guestValidation'))).toEqual([])
  })

  it('the test itself would catch one (each check finds a planted use)', () => {
    const planted = withoutComments(
      [
        "import { migrateSubscriptionsToPlanPrices } from '@/lib/membership-price-migration'",
        "import type { Database } from '../supabase/database.types'",
        "const route = await import('@/app/api/catalog/update-price/route')",
        "import { londonToday } from '@/lib/london-time'",
        "rawRequest({ path: '/api/catalog/toggle-active' })",
        "rawRequest({ path: '/api/catalog/sync-stripe?x=1' })",
        // Not one of the seven: a longer path that only starts like one, and a sentence that only mentions one.
        "rawRequest({ path: '/api/catalog/toggle-active-all' })",
        "const words = 'Use /api/catalog/update-tier-price instead.'",
        '// /api/catalog/update-price is only named in this comment',
      ].join('\n')
    )
    const at = path.join(workerDir, 'lib/stripe-thing/planted.ts')
    expect(importsOf(planted).map((target) => deletedWorkerTargetOf(at, target))).toEqual([
      'lib/membership-price-migration.ts',
      'lib/supabase/database.types.ts',
      'app/api/catalog/update-price/route.ts',
      undefined,
    ])
    expect(literals(planted).filter((literal) => deletedRouteIn(literal) !== undefined)).toEqual(['@/app/api/catalog/update-price/route', '/api/catalog/toggle-active', '/api/catalog/sync-stripe?x=1'])

    // A staff app import of a deleted module, from a function and from a shared module.
    const fn = path.join(appDir, 'backend/paddock/someFunction.ts')
    const helper = path.join(appDir, 'backend/paddock/shared/someHelper.ts')
    expect(deletedStaffTargetOf(fn, './shared/staffAccess')).toBe('backend/paddock/shared/staffAccess.ts')
    expect(deletedStaffTargetOf(fn, './globals')).toBe('backend/paddock/globals.ts')
    expect(deletedStaffTargetOf(helper, '../validatePromoCode')).toBe('backend/paddock/validatePromoCode.ts')
    expect(deletedStaffTargetOf(helper, './callWorker')).toBeUndefined()

    // A Worker test reading one from the staff app, in each way; through the frozen copy is not a read.
    const loads = withoutComments(
      [
        "const access = await load('staffAccess')",
        "await same('validatePromoCode', {})",
        "const reads = [{ name: 'validatePromoCode', path: '/x' }]",
        "readFileSync(path.join(appDir, 'backend/paddock/shared/eventAttendeeList.ts'), 'utf8')",
        "const old = await loadOld('staffAccess')",
        "readFileSync(path.join(legacyAdminDir, 'shared/eventAttendeeList.ts'), 'utf8')",
        "const { callWorker } = await load('callWorker')",
      ].join('\n')
    )
    // In the order of the deleted list: staffAccess, then eventAttendeeList, then validatePromoCode.
    expect(deletedStaffReadsIn(loads, true)).toEqual([
      "load('staffAccess')",
      "path.join(appDir, 'backend/paddock/shared/eventAttendeeList.ts')",
      "same('validatePromoCode')",
      "name: 'validatePromoCode'",
    ])
    // Outside the two loader tests a bare name is somebody else's word (a negative check, a Worker module's name).
    expect(deletedStaffReadsIn(loads, false)).toEqual(["path.join(appDir, 'backend/paddock/shared/eventAttendeeList.ts')"])

    // A barrel line missing or left behind is seen.
    expect(barrelFiles("import './a'\nimport './shared/b'\n// import './c'")).toEqual(['a.ts', 'shared/b.ts'])

    // A route file put back under app/ is seen by the 404 check's resolver.
    for (const route of Object.keys(DELETED_ROUTES)) {
      const restored = patternOf(path.join(...route.split('/').filter(Boolean)))
      expect(restored.test(route), route).toBe(true)
      expect(routePatterns().some(({ pattern }) => pattern.source === restored.source), route).toBe(false)
    }
  })

  it('scans both repos (a wrong folder would pass with nothing to scan)', () => {
    expect(scannedWorkerFiles.some((file) => file.endsWith(path.join('server', 'rules', 'catalog', 'items.ts')))).toBe(true)
    expect(scannedWorkerFiles.some((file) => file.endsWith(path.join('server', 'staff-app-helpers.test.ts')))).toBe(true)
    expect(scannedWorkerFiles.some((file) => file.endsWith(path.join('server', 'rules', 'staff-wrappers.test.ts')))).toBe(true)
    expect(STAFF_APP_LOADERS.every((file) => workerCode.has(file))).toBe(true)
    expect(scannedWorkerFiles.some(inACopy)).toBe(false)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('backend', 'paddock', 'createOrder.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('frontend', 'components', 'CheckoutDialog.tsx')))).toBe(true)
    expect(staffBackendFiles().length).toBeGreaterThan(140)
    expect(GUARDS.size).toBeGreaterThanOrEqual(8)
    expect(routePatterns().length).toBeGreaterThan(30)
  })
})
