import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEGACY_BOOKING_ACTIONS, legacyBookingDir, legacyOrderDir, oldFunctionPath } from './replay/harness'
import { staffAppDir } from './staff-app-dir'

// Brief W17 item 5 (D-plan 4.11 item 1): a frozen test-only copy of the old step D functions, beside W16's
// legacy-order/, so the golden scenarios keep setting up through the old code while step D deletes it from the staff
// app slice by slice. This guards it: it stays exactly as frozen, it stands alone, and nothing but the replay harness
// (and the order copy beside it) may reach it: never the Worker's app code, never the staff app. It goes at step H.

const workerDir = path.resolve(__dirname, '../../..')
const appDir = staffAppDir()
// Named through the harness, so this guard isn't one more file naming either folder (removed-order-code.test.ts).
const COPY_CODE = legacyBookingDir
const COPY_DIR = path.resolve(COPY_CODE, '../..')
const ORDER_COPY_DIR = path.resolve(legacyOrderDir, '../..')
const TESTING_DIR = __dirname
const HARNESS = path.join(TESTING_DIR, 'replay/harness.ts')
/** W16's guard names the folder to leave the copy out of its own scan. */
const REMOVED_ORDER_GUARD = path.join(workerDir, 'server/removed-order-code.test.ts')
const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.git', 'storybook-static', 'coverage', '.wrangler'])

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
/** What a file imports (static imports and `import()` of a literal). */
const importsOf = (code: string): string[] => [...code.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')

/** Whether some code reaches the copy: by its folder's name, or through the harness's names for it. */
const reachesCopy = (code: string): boolean =>
  literals(code).some((literal) => literal.includes('legacy-booking')) || /\b(legacyBookingDir|LEGACY_BOOKING_ACTIONS|oldFunctionPath)\b/.test(code)

const workerFiles = sourceFiles(workerDir, ['app', 'server', 'lib', 'contracts', 'scripts', 'components', 'features']).concat(
  ['custom-worker.ts', 'middleware.ts'].map((file) => path.join(workerDir, file)).filter((file) => existsSync(file))
)
const staffAppFiles = sourceFiles(appDir, ['backend', 'frontend'])
const copyFiles = sourceFiles(COPY_DIR, ['backend'])
const shown = (file: string) => path.relative(path.dirname(workerDir), file)
const code = (file: string) => withoutComments(readFileSync(file, 'utf8'))

describe('W17: the frozen copy of the old step D functions', () => {
  it('is exactly as frozen: every file, and only those, with the SHA-256 in manifest.json', () => {
    const manifest = JSON.parse(readFileSync(path.join(COPY_DIR, 'manifest.json'), 'utf8')) as Record<string, string>
    const actual = Object.fromEntries(
      copyFiles.map((file) => [path.relative(COPY_CODE, file).split(path.sep).join('/'), createHash('sha256').update(readFileSync(file)).digest('hex')])
    )
    expect(Object.keys(manifest)).toHaveLength(46)
    expect(actual).toEqual(manifest)
  })

  it('holds every step D function, and stands alone: each import is relative and found inside it', () => {
    for (const action of LEGACY_BOOKING_ACTIONS) expect(existsSync(path.join(COPY_CODE, `${action}.ts`)), action).toBe(true)
    const outside: string[] = []
    for (const file of copyFiles) {
      for (const target of importsOf(code(file))) {
        const resolved = path.resolve(path.dirname(file), target)
        if (!target.startsWith('.') || !(existsSync(`${resolved}.ts`) || existsSync(resolved)) || !resolved.startsWith(COPY_CODE)) {
          outside.push(`${shown(file)}: '${target}'`)
        }
      }
    }
    expect(outside).toEqual([])
  })

  it('the old side loads every step D function and module from it, and the rest from where it was', () => {
    for (const action of LEGACY_BOOKING_ACTIONS) expect(oldFunctionPath(action)).toBe(path.join(COPY_CODE, `${action}.ts`))
    expect(oldFunctionPath('shared/bookingMoneyClaim.ts')).toBe(path.join(COPY_CODE, 'shared/bookingMoneyClaim.ts'))
    expect(oldFunctionPath('createOrder')).toBe(path.join(ORDER_COPY_DIR, 'backend/paddock/createOrder.ts'))
    expect(oldFunctionPath('refundOrder')).toBe(path.join(appDir, 'backend/paddock/refundOrder.ts'))
  })

  it("the order copy takes the modules step D deletes from it, not from the staff app's checkout", () => {
    const fromStaffApp = sourceFiles(ORDER_COPY_DIR, ['backend'])
      .flatMap((file) => importsOf(code(file)))
      .filter((target) => target.startsWith('@retool-app/'))
    // Only the three modules steps E and G move (refundOrder's, the promo screens', the stock screen's).
    expect([...new Set(fromStaffApp)].sort()).toEqual([
      '@retool-app/backend/paddock/shared/cancelMembershipSubscription',
      '@retool-app/backend/paddock/shared/promoCodes',
      '@retool-app/backend/paddock/shared/stockAdjustments',
    ])
  })

  it("nothing in the Worker's app code reaches it: only tests, through the replay harness", () => {
    const users = workerFiles.filter((file) => !file.startsWith(COPY_DIR + path.sep) && !file.startsWith(ORDER_COPY_DIR + path.sep) && file !== __filename)
    const appCode = users.filter((file) => !/\.test\.tsx?$/.test(file) && !file.startsWith(TESTING_DIR + path.sep))
    expect(appCode.filter((file) => reachesCopy(code(file))).map(shown)).toEqual([])
    // Only the harness names the folder itself (and W16's guard, to leave it out of its scan).
    const naming = users.filter((file) => literals(code(file)).some((literal) => literal.includes('legacy-booking')))
    expect(naming.map(shown).sort()).toEqual([shown(HARNESS), shown(REMOVED_ORDER_GUARD)].sort())
  })

  it('nothing in the staff app reaches it', () => {
    expect(staffAppFiles.filter((file) => reachesCopy(code(file))).map(shown)).toEqual([])
  })

  it('the test itself would catch one (each check finds a planted use)', () => {
    const planted = withoutComments(
      [
        "import { moveBooking } from '../../server/rules/testing/legacy-booking/backend/paddock/moveBooking'",
        'const file = oldFunctionPath(action)',
        '// legacy-booking named only in a comment',
      ].join('\n')
    )
    expect(reachesCopy(planted)).toBe(true)
    expect(reachesCopy(withoutComments('// legacy-booking named only in a comment'))).toBe(false)
    expect(importsOf("import x from '@retool-app/backend/paddock/shared/bandPricing'")).toEqual(['@retool-app/backend/paddock/shared/bandPricing'])
  })

  // W18 (the W17 review's later 4): the name check above knows only some of the harness's names (app code importing
  // oldSide or newBookingSide would pass it). So, more simply: app code imports nothing at all under this folder.
  describe('app code imports nothing under server/rules/testing/', () => {
    /** Every module a file names: `from`, side-effect `import '...'`, `import(...)` and `require(...)`. */
    const allImportsOf = (source: string): string[] =>
      [...source.matchAll(/(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')
    /** Where one of the Worker's own imports lands ('@/...' or relative); null for a package. */
    const landsAt = (file: string, target: string): string | null =>
      target.startsWith('@/') ? path.join(workerDir, target.slice(2)) : target.startsWith('.') ? path.resolve(path.dirname(file), target) : null
    const importsTesting = (file: string, source: string): string[] =>
      allImportsOf(source).filter((target) => {
        const landed = landsAt(file, target)
        return landed !== null && (landed === TESTING_DIR || landed.startsWith(TESTING_DIR + path.sep))
      })

    it('no file outside tests and the testing folder imports from it', () => {
      const appCode = workerFiles.filter((file) => !/\.test\.tsx?$/.test(file) && !file.startsWith(TESTING_DIR + path.sep))
      expect(appCode.flatMap((file) => importsTesting(file, code(file)).map((target) => `${shown(file)}: '${target}'`))).toEqual([])
      // Scanned for real: 151 app files on 12 Nov, the routes and the rules among them.
      expect(appCode.length).toBeGreaterThan(100)
      expect(appCode).toContain(path.join(workerDir, 'server/rules/bookings/edits.ts'))
      expect(appCode).toContain(path.join(workerDir, 'app/api/v1/staff/bookings/[bookingId]/status/route.ts'))
    })

    it('a planted import of the harness is caught, however it is written', () => {
      const appFile = path.join(workerDir, 'server/rules/bookings/edits.ts')
      for (const planted of [
        "import { oldSide } from '@/server/rules/testing/replay/harness'",
        "import { newBookingSide } from '../testing/replay/booking-side'",
        "export { legacyOrderDir } from '@/server/rules/testing/replay/harness'",
        "import '@/server/rules/testing/database'",
        "const harness = await import('../testing/replay/harness')",
        "const race = require('@/server/rules/testing/race')",
      ]) {
        expect(importsTesting(appFile, withoutComments(planted)), planted).toHaveLength(1)
      }
      // Packages, other folders, and a comment naming the folder are not imports of it.
      expect(importsTesting(appFile, withoutComments("import { z } from 'zod'"))).toEqual([])
      expect(importsTesting(appFile, withoutComments("import { audit } from '@/server/audit'"))).toEqual([])
      expect(importsTesting(appFile, withoutComments("// import { oldSide } from '@/server/rules/testing/replay/harness'"))).toEqual([])
    })
  })

  it('scans both repos and the copy (a wrong folder would pass with nothing to scan)', () => {
    expect(workerFiles.some((file) => file.endsWith(path.join('server', 'rules', 'orders', 'place-order.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('frontend', 'components', 'MoveBookingDialog.tsx')))).toBe(true)
    expect(copyFiles.length).toBe(46)
  })
})
