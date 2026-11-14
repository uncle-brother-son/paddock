import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEGACY_REFUND_ACTIONS, legacyBookingDir, legacyOrderDir, legacyRefundDir, oldFunctionPath } from './replay/harness'
import { staffAppDir } from './staff-app-dir'

// Brief W27 item 7 (E-plan 4.13 item 2, lead call L6; W17 later 1 / audit row 1): a frozen test-only copy of the old
// step E functions, beside W16's legacy-order/ and W17's legacy-booking/, so step E's golden files keep replaying
// through the old code while step E deletes it from the staff app slice by slice. This guards it: it stays exactly as
// frozen, it stands alone, and nothing but the replay harness (and the order copy's three imports) may reach it:
// never the Worker's app code, never the staff app. It goes at step H.

const workerDir = path.resolve(__dirname, '../../..')
const appDir = staffAppDir()
// Named through the harness, so this guard isn't one more file naming the folder.
const COPY_CODE = legacyRefundDir
const COPY_DIR = path.resolve(COPY_CODE, '../..')
const ORDER_COPY_DIR = path.resolve(legacyOrderDir, '../..')
const BOOKING_COPY_DIR = path.resolve(legacyBookingDir, '../..')
const TESTING_DIR = __dirname
const HARNESS = path.join(TESTING_DIR, 'replay/harness.ts')
const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.git', 'storybook-static', 'coverage', '.wrangler'])
/** The one file that isn't a copy: the stand-in for the staff app's typecheck barrel (the copy's README). */
const STAND_IN = 'typecheckAll.ts'
/** The three modules the frozen order copy took from the staff app's checkout until W27 (audit row 1). */
const ONCE_ALIASED = ['shared/cancelMembershipSubscription', 'shared/promoCodes', 'shared/stockAdjustments']

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
/** What a file imports: `from '...'`, a side-effect `import '...'`, and `import('...')` of a literal. */
const importsOf = (code: string): string[] => [...code.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')

/** Whether some code reaches the copy: by its folder's name, or through the harness's names for it. */
const reachesCopy = (code: string): boolean => literals(code).some((literal) => literal.includes('legacy-refund')) || /\b(legacyRefundDir|LEGACY_REFUND_ACTIONS)\b/.test(code)

const workerFiles = sourceFiles(workerDir, ['app', 'server', 'lib', 'contracts', 'scripts', 'components', 'features']).concat(
  ['custom-worker.ts', 'middleware.ts'].map((file) => path.join(workerDir, file)).filter((file) => existsSync(file))
)
const staffAppFiles = sourceFiles(appDir, ['backend', 'frontend'])
const copyFiles = sourceFiles(COPY_DIR, ['backend'])
const shown = (file: string) => path.relative(path.dirname(workerDir), file)
const code = (file: string) => withoutComments(readFileSync(file, 'utf8'))
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const inCopy = (file: string) => path.relative(COPY_CODE, file).split(path.sep).join('/')

describe('W27: the frozen copy of the old step E functions', () => {
  it('is exactly as frozen: every file, and only those, with the SHA-256 in manifest.json', () => {
    const manifest = JSON.parse(readFileSync(path.join(COPY_DIR, 'manifest.json'), 'utf8')) as Record<string, string>
    const actual = Object.fromEntries(copyFiles.map((file) => [inCopy(file), sha256(file)]))
    expect(Object.keys(manifest)).toHaveLength(29)
    expect(actual).toEqual(manifest)
  })

  it('holds the five step E functions and the three once-aliased modules', () => {
    expect([...LEGACY_REFUND_ACTIONS].sort()).toEqual(['cancelEvent', 'cancelEventPlaces', 'getEventCancellationOverview', 'getEventCancellationQuote', 'refundOrder'])
    for (const action of LEGACY_REFUND_ACTIONS) expect(existsSync(path.join(COPY_CODE, `${action}.ts`)), action).toBe(true)
    for (const name of ONCE_ALIASED) expect(existsSync(path.join(COPY_CODE, `${name}.ts`)), name).toBe(true)
  })

  it('stands alone: each import is relative and found inside it, side-effect imports included', () => {
    const outside: string[] = []
    for (const file of copyFiles) {
      for (const target of importsOf(code(file))) {
        const resolved = path.resolve(path.dirname(file), target)
        if (!target.startsWith('.') || !(existsSync(`${resolved}.ts`) || existsSync(resolved)) || !resolved.startsWith(COPY_CODE)) outside.push(`${shown(file)}: '${target}'`)
      }
    }
    expect(outside).toEqual([])
    // The side-effect import is seen (the booking copy's guard doesn't look for them: none of its files has one that matters).
    expect(importsOf(code(path.join(COPY_CODE, 'refundOrder.ts')))).toContain('./typecheckAll')
  })

  it("the stand-in for the staff app's typecheck barrel imports only ./globals, and exports and runs nothing", () => {
    const standIn = code(path.join(COPY_CODE, STAND_IN))
    expect(importsOf(standIn)).toEqual(['./globals'])
    expect(standIn.replace(/import\s+'\.\/globals'/, '').trim()).toBe('')
    expect(code(path.join(COPY_CODE, 'globals.ts')).trim()).toBe('export {}')
  })

  it("every file but the stand-in is the staff app's own, byte for byte, while the staff app still has it", () => {
    // Step E deletes these from the staff app slice by slice; a file still there must not have drifted from the copy.
    // (When the lead changes one in the staff app before its slice, this fails: decide then which the golden files hold to.)
    const compared: string[] = []
    for (const file of copyFiles) {
      const name = inCopy(file)
      const original = path.join(appDir, 'backend/paddock', name)
      if (name === STAND_IN || name === 'shared/workerContracts.ts' || !existsSync(original)) continue
      expect(sha256(file), name).toBe(sha256(original))
      compared.push(name)
    }
    // At W27 every one of them is still in the staff app: 27 compared (29 less the stand-in and the generated contracts,
    // which each Worker change regenerates). The number only falls as slices delete their old bodies.
    expect(compared.length).toBeLessThanOrEqual(27)
    for (const name of compared) expect(existsSync(path.join(COPY_CODE, name))).toBe(true)
  })

  it('the old side loads every step E function from it; the booking copy still answers for what it holds; the rest from where it was', () => {
    for (const action of LEGACY_REFUND_ACTIONS) expect(oldFunctionPath(action)).toBe(path.join(COPY_CODE, `${action}.ts`))
    expect(oldFunctionPath('shared/eventCancellation.ts')).toBe(path.join(COPY_CODE, 'shared/eventCancellation.ts'))
    expect(oldFunctionPath('shared/heldCardRefund.ts')).toBe(path.join(COPY_CODE, 'shared/heldCardRefund.ts'))
    // In both copies: named from the booking copy, as before W27.
    expect(oldFunctionPath('shared/staffAccess.ts')).toBe(path.join(legacyBookingDir, 'shared/staffAccess.ts'))
    expect(oldFunctionPath('refundBooking')).toBe(path.join(legacyBookingDir, 'refundBooking.ts'))
    expect(oldFunctionPath('createOrder')).toBe(path.join(ORDER_COPY_DIR, 'backend/paddock/createOrder.ts'))
    expect(oldFunctionPath('getOrders')).toBe(path.join(appDir, 'backend/paddock/getOrders.ts'))
  })

  it('audit row 1: the order copy takes the three once-aliased modules from here, and nothing from the staff app any more', () => {
    const orderCopyFiles = sourceFiles(ORDER_COPY_DIR, ['backend'])
    const imports = orderCopyFiles.flatMap((file) => importsOf(code(file)).map((target) => ({ file, target })))
    expect(imports.filter(({ target }) => target.startsWith('@retool-app/'))).toEqual([])
    const fromHere = imports.filter(({ file, target }) => target.startsWith('.') && path.resolve(path.dirname(file), target).startsWith(COPY_CODE))
    expect([...new Set(fromHere.map(({ file, target }) => path.relative(COPY_CODE, path.resolve(path.dirname(file), target)).split(path.sep).join('/')))].sort()).toEqual(ONCE_ALIASED)
    // Each lands on a file that is there.
    for (const { file, target } of fromHere) expect(existsSync(`${path.resolve(path.dirname(file), target)}.ts`), `${shown(file)}: ${target}`).toBe(true)
    // The six import lines W27 repointed, and no more.
    expect(fromHere).toHaveLength(6)
  })

  it("nothing in the Worker's app code reaches it: only tests, through the replay harness, and the order copy's three imports", () => {
    const users = workerFiles.filter((file) => !file.startsWith(COPY_DIR + path.sep) && file !== __filename)
    const appCode = users.filter((file) => !/\.test\.tsx?$/.test(file) && !file.startsWith(TESTING_DIR + path.sep))
    expect(appCode.filter((file) => reachesCopy(code(file))).map(shown)).toEqual([])
    // Only the harness names the folder itself, and the order copy's files that import from it.
    const naming = users.filter((file) => literals(code(file)).some((literal) => literal.includes('legacy-refund')))
    expect(naming.filter((file) => !file.startsWith(ORDER_COPY_DIR + path.sep)).map(shown)).toEqual([shown(HARNESS)])
    // In the order copy: exactly the files that import one of the three modules (the test above), four of them. Their
    // names aren't spelled here: two are modules W16 deleted from the staff app, and W16's guard counts any file that
    // names one (server/removed-order-code.test.ts).
    const orderCopyNaming = naming.filter((file) => file.startsWith(ORDER_COPY_DIR + path.sep))
    const orderCopyImporting = sourceFiles(ORDER_COPY_DIR, ['backend']).filter((file) =>
      importsOf(code(file)).some((target) => target.startsWith('.') && path.resolve(path.dirname(file), target).startsWith(COPY_CODE))
    )
    expect(orderCopyNaming.map(shown).sort()).toEqual(orderCopyImporting.map(shown).sort())
    expect(orderCopyNaming).toHaveLength(4)
    // The booking copy doesn't reach into it either: each copy stands alone.
    expect(sourceFiles(BOOKING_COPY_DIR, ['backend']).filter((file) => reachesCopy(code(file))).map(shown)).toEqual([])
  })

  it('nothing in the staff app reaches it', () => {
    expect(staffAppFiles.filter((file) => reachesCopy(code(file))).map(shown)).toEqual([])
  })

  it('the test itself would catch one (each check finds a planted use)', () => {
    const planted = withoutComments(["import refundOrder from '../../server/rules/testing/legacy-refund/backend/paddock/refundOrder'", '// legacy-refund named only in a comment'].join('\n'))
    expect(reachesCopy(planted)).toBe(true)
    expect(reachesCopy('const dir = legacyRefundDir')).toBe(true)
    expect(reachesCopy(withoutComments('// legacy-refund named only in a comment'))).toBe(false)
    expect(importsOf("import './typecheckAll'\nimport x from './shared/a'\nconst y = await import('./shared/b')")).toEqual(['./typecheckAll', './shared/a', './shared/b'])
  })

  it('scans both repos and the copy (a wrong folder would pass with nothing to scan)', () => {
    expect(workerFiles.some((file) => file.endsWith(path.join('server', 'rules', 'refunds', 'pipeline.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('frontend', 'components', 'RefundOrderDialog.tsx')))).toBe(true)
    expect(copyFiles.length).toBe(29)
  })
})
