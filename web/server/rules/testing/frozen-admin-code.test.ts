import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEGACY_ADMIN_ACTIONS, legacyAccountDir, legacyAdminDir, legacyBookingDir, legacyOrderDir, legacyRefundDir, oldFunctionPath } from './replay/harness'
import { staffAppDir } from './staff-app-dir'

// Brief W48 item 4 (G-plan 4.9 item 2, lead call L5): a frozen test-only copy of the 82 old step G functions, every
// module they import and the seven legacy /api/catalog routes, beside W16's legacy-order/, W17's legacy-booking/,
// W27's legacy-refund/ and W36's legacy-account/, so step G's golden files keep replaying through the old code while
// step G deletes it slice by slice. This guards it: it stays exactly as frozen, it stands alone, and nothing but the
// replay harness and its legacy-routes binding may reach it: never the Worker's app code, never the staff app. It
// goes at step H.
//
// What is different from the four before it (G-plan 2.5, W45 row 4, W26 row 1): this copy is not held to the staff
// app's shared modules. manifest.json alone holds them, so a G slice can trim or delete a staff app shared module
// without touching a Worker test; and the two older guards that compared their shared modules with the staff app's
// (frozen-refund-code.test.ts, frozen-account-code.test.ts) compare with this copy's instead. Only the 82 functions
// themselves are still looked at in the staff app, and with no list to keep: each is the copy's own byte for byte
// (not switched yet), a thin call to the Worker (switched), or gone.

const workerDir = path.resolve(__dirname, '../../..')
const appDir = staffAppDir()
// Named through the harness, so this guard isn't one more file naming the folder.
const COPY_CODE = legacyAdminDir
const COPY_DIR = path.resolve(COPY_CODE, '../..')
const COPY_NAME = path.basename(COPY_DIR)
const TESTING_DIR = __dirname
const HARNESS = path.join(TESTING_DIR, 'replay/harness.ts')
const LEGACY_ROUTES = path.join(TESTING_DIR, 'replay/legacy-routes.ts')
const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.git', 'storybook-static', 'coverage', '.wrangler'])
/** The seven legacy catalogue routes, as the old functions call them. */
const ROUTES = ['create-gift-card-preset', 'create-variant', 'sync-stripe', 'toggle-active', 'update-gift-card-preset-price', 'update-price', 'update-tier-price']
/** The one file whose one import line was repointed so the copy stands alone: the line as the copy has it, and as the original has it. */
const REPOINTED: Record<string, { copy: string; original: string }> = {
  'routes/catalog/update-price/route.ts': { copy: "from '../../../lib/membership-price-migration'", original: "from '@/lib/membership-price-migration'" },
}
/** Where each file of the route copy came from, in the app. */
const originalOf = (name: string): string => (name.startsWith('lib/') ? name : name.replace(/^routes\//, 'app/api/'))
/** The 17 modules the 82 functions import, directly or through one another. */
const MODULES = [
  'globals.ts',
  'shared/bookingPaymentOpenWords.ts',
  'shared/eventAttendance.ts',
  'shared/eventAttendeeList.ts',
  'shared/eventCheckIn.ts',
  'shared/extractApiErrorMessage.ts',
  'shared/extractStructuredApiError.ts',
  'shared/isHtmlErrorPage.ts',
  'shared/isoDateTime.ts',
  'shared/londonTime.ts',
  'shared/pricingStaff.ts',
  'shared/promoCodes.ts',
  'shared/readerPaymentOpen.ts',
  'shared/resolveStaffId.ts',
  'shared/staffAccess.ts',
  'shared/stockAdjustments.ts',
  'shared/toggleItemActive.ts',
]

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

/** The code without its comments, so a comment naming the copy doesn't count. */
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
const literals = (code: string): string[] =>
  [...code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '')
/**
 * What a file imports: `from '...'`, a side-effect `import '...'`, and `import('...')` of a literal. Never a method
 * called `from` (the legacy routes' supabase-js: `.from('products')`).
 */
const importsOf = (code: string): string[] => [...code.matchAll(/(?<![.\w])(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')

/** Whether some code reaches the copy: by its folder's name, or through the harness's names for it. */
const reachesCopy = (code: string): boolean => literals(code).some((literal) => literal.includes(COPY_NAME)) || /\b(legacyAdminDir|LEGACY_ADMIN_ACTIONS)\b/.test(code)

/**
 * What a step G function is in the staff app today, from its source alone: `old` (it still reads the database or the
 * legacy resource, itself or through an old shared module), `thin` (it calls the Worker and touches neither), or
 * `mixed` (both, or neither: never right).
 */
const OLD_MODULES = MODULES.filter((name) => name.startsWith('shared/') && name !== 'shared/isHtmlErrorPage.ts').map((name) => name.replace(/^shared\//, '').replace(/\.ts$/, ''))
function kindOf(source: string): 'old' | 'thin' | 'mixed' {
  const imports = importsOf(source)
  const old = /\bpaddockData\b|\bpaddockBackendApi2\b/.test(source) || imports.some((target) => OLD_MODULES.some((name) => target.endsWith(`/shared/${name}`)))
  const thin = /\bcallWorker\b/.test(source) || imports.some((target) => /\/shared\/[a-zA-Z]*Worker$/.test(target))
  return old && !thin ? 'old' : thin && !old ? 'thin' : 'mixed'
}

// Briefs W55 + W56 held updateCatalogItemPrice here as the one old function moved in part (its membership plan branch
// still on the legacy update-price route). Brief W57 moved that branch to the plan's own route
// (/api/v1/staff/catalog/membership-plans/:id/details), so the exception is gone: every one of the 82 is the copy's
// own, a thin call, or gone, with none moved in part.

const workerFiles = sourceFiles(workerDir, ['app', 'server', 'lib', 'contracts', 'scripts', 'components', 'features']).concat(
  ['custom-worker.ts', 'middleware.ts'].map((file) => path.join(workerDir, file)).filter((file) => existsSync(file))
)
const staffAppFiles = sourceFiles(appDir, ['backend', 'frontend'])
const copyFiles = sourceFiles(COPY_DIR, ['backend', 'routes', 'lib'])
const backendFiles = copyFiles.filter((file) => file.startsWith(COPY_CODE + path.sep))
const shown = (file: string) => path.relative(path.dirname(workerDir), file)
const code = (file: string) => withoutComments(readFileSync(file, 'utf8'))
const sha256 = (source: string | Buffer) => createHash('sha256').update(source).digest('hex')
const inCopy = (file: string) => path.relative(COPY_DIR, file).split(path.sep).join('/')
const inBackend = (file: string) => path.relative(COPY_CODE, file).split(path.sep).join('/')

describe('W48: the frozen copy of the 82 old step G functions and the seven legacy catalogue routes', () => {
  it('is exactly as frozen: every file, and only those, with the SHA-256 in manifest.json', () => {
    const manifest = JSON.parse(readFileSync(path.join(COPY_DIR, 'manifest.json'), 'utf8')) as Record<string, string>
    const actual = Object.fromEntries(copyFiles.map((file) => [inCopy(file), sha256(readFileSync(file))]))
    expect(Object.keys(manifest)).toHaveLength(107)
    expect(actual).toEqual(manifest)
    // 99 of the staff app's files (82 functions and 17 modules), 7 of the Worker's route files and its one price-move helper.
    expect(backendFiles).toHaveLength(99)
    expect(copyFiles.filter((file) => inCopy(file).startsWith('routes/'))).toHaveLength(7)
    expect(copyFiles.filter((file) => inCopy(file).startsWith('lib/')).map(inCopy)).toEqual(['lib/membership-price-migration.ts'])
  })

  it('holds the 82 step G functions and the 17 modules they import, and each of the seven routes', () => {
    expect(LEGACY_ADMIN_ACTIONS.size).toBe(82)
    for (const action of LEGACY_ADMIN_ACTIONS) expect(existsSync(path.join(COPY_CODE, `${action}.ts`)), action).toBe(true)
    expect(backendFiles.map(inBackend).sort()).toEqual([...[...LEGACY_ADMIN_ACTIONS].map((action) => `${action}.ts`), ...MODULES].sort())
    for (const route of ROUTES) expect(existsSync(path.join(COPY_DIR, 'routes/catalog', route, 'route.ts')), route).toBe(true)
    // The four reads and the one check that were thin calls before step G began have no old body to keep.
    for (const thin of ['getPricingConfig', 'getPostageSettings', 'getWorkerConnection', 'getStuckReaderPayments', 'getMoneyOwed']) expect(existsSync(path.join(COPY_CODE, `${thin}.ts`)), thin).toBe(false)
  })

  it('the old functions stand alone: each import is relative and found inside the copy, side-effect imports included', () => {
    const outside: string[] = []
    for (const file of backendFiles) {
      for (const target of importsOf(code(file))) {
        const resolved = path.resolve(path.dirname(file), target)
        if (!target.startsWith('.') || !(existsSync(`${resolved}.ts`) || existsSync(resolved)) || !resolved.startsWith(COPY_CODE)) outside.push(`${shown(file)}: '${target}'`)
      }
    }
    expect(outside).toEqual([])
    expect(importsOf(code(path.join(COPY_CODE, 'shared/resolveStaffId.ts')))).toContain('../globals')
    expect(code(path.join(COPY_CODE, 'globals.ts')).trim()).toBe('export {}')
  })

  it("the routes take nothing from the app: the copy's price-move helper, and three packages", () => {
    const routeFiles = copyFiles.filter((file) => !file.startsWith(COPY_CODE + path.sep))
    const imports = [...new Set(routeFiles.flatMap((file) => importsOf(code(file))))].sort()
    expect(imports).toEqual(['../../../lib/membership-price-migration', '@supabase/supabase-js', 'next/server', 'stripe'].sort())
    for (const file of routeFiles) {
      for (const target of importsOf(code(file)).filter((one) => one.startsWith('.'))) {
        const resolved = path.resolve(path.dirname(file), target)
        expect(existsSync(`${resolved}.ts`) && resolved.startsWith(COPY_DIR), `${shown(file)}: ${target}`).toBe(true)
      }
    }
  })

  it('each route and the price-move helper is its original in the app, byte for byte but for the one repointed import line, while the app still has it (W61 removes them)', () => {
    const routeCopies = copyFiles.filter((one) => !one.startsWith(COPY_CODE + path.sep)).map(inCopy)
    expect(routeCopies).toHaveLength(8)
    let compared = 0
    for (const name of routeCopies) {
      const original = path.join(workerDir, originalOf(name))
      if (!existsSync(original)) continue
      const repointed = REPOINTED[name]
      const copy = readFileSync(path.join(COPY_DIR, name), 'utf8')
      expect(repointed ? copy.replace(repointed.copy, repointed.original) : copy, name).toBe(readFileSync(original, 'utf8'))
      compared += 1
    }
    // All eight while the live routes stand; none once W61 has removed them (never some: they go together).
    expect([0, 8]).toContain(compared)
    expect(originalOf('routes/catalog/update-price/route.ts')).toBe('app/api/catalog/update-price/route.ts')
    for (const [name, { copy }] of Object.entries(REPOINTED)) expect(readFileSync(path.join(COPY_DIR, name), 'utf8').split(copy), name).toHaveLength(2)
  })

  it("each of the 82 in the staff app is the copy's own byte for byte, or a thin call to the Worker, or gone: never a changed old body, and no list to keep", () => {
    const state = { same: 0, thin: 0, gone: 0 }
    const wrong: string[] = []
    for (const action of LEGACY_ADMIN_ACTIONS) {
      const original = path.join(appDir, 'backend/paddock', `${action}.ts`)
      if (!existsSync(original)) {
        state.gone += 1
        continue
      }
      const source = readFileSync(original)
      if (sha256(source) === sha256(readFileSync(path.join(COPY_CODE, `${action}.ts`)))) state.same += 1
      else if (kindOf(withoutComments(source.toString('utf8'))) === 'thin') state.thin += 1
      else wrong.push(action)
    }
    // A changed old body would mean the golden files no longer say what the staff app does: decide then which they hold to.
    expect(wrong).toEqual([])
    expect(state.same + state.thin + state.gone).toBe(82)
    // Every one the copy calls old is old by this test's own reading, so `thin` above can't be a body that merely moved its SQL.
    for (const action of LEGACY_ADMIN_ACTIONS) expect(kindOf(code(path.join(COPY_CODE, `${action}.ts`))), action).toBe('old')
  })

  it('the old side loads every step G function from it; the earlier copies still answer for what they hold; nothing old is left to load from the staff app', () => {
    for (const action of LEGACY_ADMIN_ACTIONS) expect(oldFunctionPath(action)).toBe(path.join(COPY_CODE, `${action}.ts`))
    // Modules only this copy holds.
    for (const only of ['shared/pricingStaff.ts', 'shared/toggleItemActive', 'shared/isoDateTime.ts', 'shared/eventCheckIn.ts', 'shared/bookingPaymentOpenWords.ts']) {
      expect(oldFunctionPath(only)).toBe(path.join(COPY_CODE, `${only.replace(/\.ts$/, '')}.ts`))
    }
    // In an earlier copy too: named from there, as before W48.
    expect(oldFunctionPath('shared/staffAccess.ts')).toBe(path.join(legacyBookingDir, 'shared/staffAccess.ts'))
    expect(oldFunctionPath('shared/promoCodes.ts')).toBe(path.join(legacyRefundDir, 'shared/promoCodes.ts'))
    expect(oldFunctionPath('refundBooking')).toBe(path.join(legacyBookingDir, 'refundBooking.ts'))
    expect(oldFunctionPath('refundOrder')).toBe(path.join(legacyRefundDir, 'refundOrder.ts'))
    expect(oldFunctionPath('createOrder')).toBe(path.join(legacyOrderDir, 'createOrder.ts'))
    expect(oldFunctionPath('getCustomers')).toBe(path.join(legacyAccountDir, 'getCustomers.ts'))
    // A thin wrapper that was never an old step G function is still the staff app's own.
    expect(oldFunctionPath('getPricingConfig')).toBe(path.join(appDir, 'backend/paddock/getPricingConfig.ts'))
  })

  it('the replay calls the seven legacy catalogue routes from the copy, never from app/', () => {
    const binding = code(LEGACY_ROUTES)
    for (const route of ROUTES) {
      expect(binding).toContain(`'/api/catalog/${route}': () => import('../${COPY_NAME}/routes/catalog/${route}/route')`)
      expect(binding).not.toContain(`@/app/api/catalog/${route}`)
    }
  })

  it("nothing in the Worker's app code reaches it: only tests, through the replay harness and its legacy-routes binding", () => {
    const users = workerFiles.filter((file) => !file.startsWith(COPY_DIR + path.sep) && file !== __filename)
    const appCode = users.filter((file) => !/\.test\.tsx?$/.test(file) && !file.startsWith(TESTING_DIR + path.sep))
    expect(appCode.filter((file) => reachesCopy(code(file))).map(shown)).toEqual([])
    // Only the harness and the legacy-routes binding name the folder itself.
    const naming = users.filter((file) => literals(code(file)).some((literal) => literal.includes(COPY_NAME)))
    expect(naming.map(shown).sort()).toEqual([shown(HARNESS), shown(LEGACY_ROUTES)].sort())
    // The other four copies don't reach into it: each copy stands alone.
    for (const other of [legacyOrderDir, legacyBookingDir, legacyRefundDir, legacyAccountDir]) {
      expect(sourceFiles(path.resolve(other, '../..'), ['backend', 'routes', 'lib']).filter((file) => reachesCopy(code(file))).map(shown)).toEqual([])
    }
  })

  it('nothing in the staff app reaches it', () => {
    expect(staffAppFiles.filter((file) => reachesCopy(code(file))).map(shown)).toEqual([])
  })

  it('the test itself would catch one (each check finds a planted use, and reads old from thin)', () => {
    const planted = withoutComments([`import getStaff from '../../server/rules/testing/${COPY_NAME}/backend/paddock/getStaff'`, `// ${COPY_NAME} named only in a comment`].join('\n'))
    expect(reachesCopy(planted)).toBe(true)
    expect(reachesCopy('const dir = legacyAdminDir')).toBe(true)
    expect(reachesCopy(withoutComments(`// ${COPY_NAME} named only in a comment`))).toBe(false)
    expect(importsOf("import '../globals'\nimport x from './shared/a'\nconst y = await import('./shared/b')")).toEqual(['../globals', './shared/a', './shared/b'])
    expect(importsOf("await supabase.from('products').select('id')")).toEqual([])
    expect(COPY_NAME).toBe('legacy-admin')
    // An old body: its own SQL or an old shared module. A thin call: callWorker or a Worker helper. A type taken from
    // another function's file says nothing either way.
    expect(kindOf("export default async function f() { return paddockData.query('SELECT 1') }")).toBe('old')
    expect(kindOf("import { toggleItemActive } from './shared/toggleItemActive'\nexport default async function f() { return toggleItemActive('product', 'x', true) }")).toBe('old')
    expect(kindOf("import { getStaffRowAnyStatus } from './shared/staffAccess'\nexport default async function f() { return getStaffRowAnyStatus('x') }")).toBe('old')
    expect(kindOf("import { callWorker } from './shared/callWorker'\nexport default async function f(req) { return callWorker(req.user.email, { path: '/staff' }) }")).toBe('thin')
    expect(kindOf("import { adminWrite } from './shared/adminWorker'\nexport default async function f(req) { return adminWrite(req) }")).toBe('thin')
    expect(kindOf("import type { EventRow } from './getEvents'\nimport { callWorker } from './shared/callWorker'\nexport default async function f(req) { return callWorker(req.user.email, {}) }")).toBe('thin')
    // Half switched is never right: a call to the Worker beside the old SQL, or neither.
    expect(kindOf("import { callWorker } from './shared/callWorker'\nexport default async function f() { await paddockData.query('UPDATE staff SET active = false'); return callWorker('x', {}) }")).toBe('mixed')
    expect(kindOf('export default async function f() { return null }')).toBe('mixed')
  })

  it('scans both repos and the copy (a wrong folder would pass with nothing to scan)', () => {
    expect(workerFiles.some((file) => file.endsWith(path.join('server', 'rules', 'orders', 'order-switch.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('frontend', 'components', 'BlockDayDialog.tsx')))).toBe(true)
    expect(copyFiles.length).toBe(107)
  })
})
