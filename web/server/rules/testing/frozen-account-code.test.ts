import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEGACY_ACCOUNT_ACTIONS, legacyAccountDir, legacyBookingDir, legacyOrderDir, legacyRefundDir, oldFunctionPath } from './replay/harness'
import { staffAppDir } from './staff-app-dir'

// Brief W36 item 4 (F-plan 4.12 item 2, lead call L5): a frozen test-only copy of the old step F functions and the
// three legacy membership routes, beside W16's legacy-order/, W17's legacy-booking/ and W27's legacy-refund/, so step
// F's golden files keep replaying through the old code while step F deletes it slice by slice. This guards it: it
// stays exactly as frozen, it stands alone, and nothing but the replay harness and its legacy-routes binding may
// reach it: never the Worker's app code, never the staff app. It goes at step H.

const workerDir = path.resolve(__dirname, '../../..')
const appDir = staffAppDir()
// Named through the harness, so this guard isn't one more file naming the folder.
const COPY_CODE = legacyAccountDir
const COPY_DIR = path.resolve(COPY_CODE, '../..')
const COPY_NAME = path.basename(COPY_DIR)
const TESTING_DIR = __dirname
const HARNESS = path.join(TESTING_DIR, 'replay/harness.ts')
const LEGACY_ROUTES = path.join(TESTING_DIR, 'replay/legacy-routes.ts')
const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.git', 'storybook-static', 'coverage', '.wrangler'])
/** The three legacy membership routes, as the old functions call them. */
const ROUTES = ['cancel', 'undo-cancel', 'change-payment-date']
/**
 * The two files whose one import line was repointed so the copy stands alone, with the line as the copy has it. Their
 * originals (and the live routes, with the guards W40d and W41 gave them) left the app at W44: until then this test
 * held each copy to its original. Now manifest.json alone holds them, and removed-account-code.test.ts the removal.
 */
const REPOINTED: Record<string, string> = {
  'routes/memberships/cancel/core.ts': "from '../../../lib/membership-cancellation'",
  'lib/membership-cancellation.ts': "from '@/lib/london-time'",
}
/** Where each file of the route copy came from, in the app. */
const originalOf = (name: string): string => (name.startsWith('lib/') ? name : name.replace(/^routes\//, 'app/api/'))

/**
 * From W37 on: the step F functions the staff app has switched to the Worker (a thin wrapper there; the old body
 * only here). Each slice adds its own. None at W36. W37: credits and their history, Herd, and store credit. W38: the
 * five gift card functions. W39: the three customer functions. W40: the membership cancel and the Subscriptions list.
 */
const SWITCHED_TO_THE_WORKER: ReadonlySet<string> = new Set([
  'adjustCustomerStoreCredit.ts',
  'adjustMembershipCredits.ts',
  'getMembershipCreditAdjustments.ts',
  'setMembershipHerd.ts',
  // W38: the five gift card functions.
  'extendGiftCardExpiry.ts',
  'getGiftCardRedemptions.ts',
  'getGiftCards.ts',
  'setGiftCardPickedUp.ts',
  'setGiftCardShipped.ts',
  // W39: the three customer functions.
  'createCustomer.ts',
  'getCustomerDetail.ts',
  'getCustomers.ts',
  // W40: the membership cancel (and its undo) and the Subscriptions list.
  'setMembershipCancellation.ts',
  'getSubscriptions.ts',
  // W41: the payment date change and its quote.
  'changeMembershipPaymentDate.ts',
  'getMembershipPaymentDateQuote.ts',
])
/**
 * W44 (Wayne's yes, 18 Nov 2026, inventory D1, D3, D5, D6): four modules the staff app trimmed of exports nothing
 * there called any more. The copy keeps them whole: the old functions here still call them.
 */
const TRIMMED_IN_THE_STAFF_APP: Record<string, string[]> = {
  'shared/staffAccess.ts': ['requireCanIssueRefunds'],
  'shared/guestValidation.ts': ['validateGuests', 'findAccountHolderIndex', 'AccountHolderProfile', 'GuestValidationReason', 'GuestValidationResult', 'GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE'],
  'shared/londonTime.ts': ['startsWithinRealHours', 'addMonthsToIsoDate'],
  'shared/eventAttendance.ts': ['loadEventAttendeeState'],
}
/** W38: the two flag functions are one thin call, kept in a module they share; each names it, and it calls the Worker. */
const THIN_THROUGH: Record<string, string> = { 'setGiftCardPickedUp.ts': 'shared/giftCardFlag.ts', 'setGiftCardShipped.ts': 'shared/giftCardFlag.ts' }

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
 * called `from` (the legacy routes' supabase-js: `.from('customers')`).
 */
const importsOf = (code: string): string[] => [...code.matchAll(/(?<![.\w])(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')

/** Whether some code reaches the copy: by its folder's name, or through the harness's names for it. */
const reachesCopy = (code: string): boolean => literals(code).some((literal) => literal.includes(COPY_NAME)) || /\b(legacyAccountDir|LEGACY_ACCOUNT_ACTIONS)\b/.test(code)

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

describe('W36: the frozen copy of the old step F functions and the three legacy membership routes', () => {
  it('is exactly as frozen: every file, and only those, with the SHA-256 in manifest.json', () => {
    const manifest = JSON.parse(readFileSync(path.join(COPY_DIR, 'manifest.json'), 'utf8')) as Record<string, string>
    const actual = Object.fromEntries(copyFiles.map((file) => [inCopy(file), sha256(readFileSync(file))]))
    expect(Object.keys(manifest)).toHaveLength(35)
    expect(actual).toEqual(manifest)
    // 28 of the staff app's files, 6 of the Worker's route files and its one date helper.
    expect(backendFiles).toHaveLength(28)
    expect(copyFiles.filter((file) => inCopy(file).startsWith('routes/'))).toHaveLength(6)
    expect(copyFiles.filter((file) => inCopy(file).startsWith('lib/')).map(inCopy)).toEqual(['lib/membership-cancellation.ts'])
  })

  it('holds the sixteen step F functions, and each route with its core', () => {
    expect([...LEGACY_ACCOUNT_ACTIONS].sort()).toEqual(
      [
        'adjustCustomerStoreCredit',
        'adjustMembershipCredits',
        'changeMembershipPaymentDate',
        'createCustomer',
        'extendGiftCardExpiry',
        'getCustomerDetail',
        'getCustomers',
        'getGiftCardRedemptions',
        'getGiftCards',
        'getMembershipCreditAdjustments',
        'getMembershipPaymentDateQuote',
        'getSubscriptions',
        'setGiftCardPickedUp',
        'setGiftCardShipped',
        'setMembershipCancellation',
        'setMembershipHerd',
      ].sort()
    )
    for (const action of LEGACY_ACCOUNT_ACTIONS) expect(existsSync(path.join(COPY_CODE, `${action}.ts`)), action).toBe(true)
    for (const route of ROUTES) for (const file of ['core.ts', 'route.ts']) expect(existsSync(path.join(COPY_DIR, 'routes/memberships', route, file)), `${route}/${file}`).toBe(true)
    // The saved card's two functions are thin calls already (W11, W14a): there is no old body to keep (README).
    for (const thin of ['saveCustomerCardOnFile', 'createTerminalSetupIntent', 'getCustomerCreditOptions']) expect(existsSync(path.join(COPY_CODE, `${thin}.ts`)), thin).toBe(false)
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
    expect(importsOf(code(path.join(COPY_CODE, 'shared/storeCredit.ts')))).toContain('../globals')
    expect(code(path.join(COPY_CODE, 'globals.ts')).trim()).toBe('export {}')
  })

  it("the routes take nothing from the app but its London time helper: their cores, the copy's date sum, and three packages", () => {
    const routeFiles = copyFiles.filter((file) => !file.startsWith(COPY_CODE + path.sep))
    const imports = [...new Set(routeFiles.flatMap((file) => importsOf(code(file))))].sort()
    expect(imports).toEqual(['../../../lib/membership-cancellation', './core', '@/lib/london-time', '@supabase/supabase-js', 'next/server', 'stripe'].sort())
    // The relative ones land inside the copy.
    for (const file of routeFiles) {
      for (const target of importsOf(code(file)).filter((one) => one.startsWith('.'))) {
        const resolved = path.resolve(path.dirname(file), target)
        expect(existsSync(`${resolved}.ts`) && resolved.startsWith(COPY_DIR), `${shown(file)}: ${target}`).toBe(true)
      }
    }
    expect(existsSync(path.join(workerDir, 'lib/london-time.ts'))).toBe(true)
  })

  it("every old function and module is the staff app's own, byte for byte, while the staff app still has it", () => {
    // Step F deletes or thins these in the staff app slice by slice; a file still there must not have drifted from the copy.
    const compared: string[] = []
    for (const file of backendFiles) {
      const name = inBackend(file)
      const original = path.join(appDir, 'backend/paddock', name)
      if (SWITCHED_TO_THE_WORKER.has(name) || name in TRIMMED_IN_THE_STAFF_APP || !existsSync(original)) continue
      expect(sha256(readFileSync(file)), name).toBe(sha256(readFileSync(original)))
      compared.push(name)
    }
    // At W36 every one of the 28 was still in the staff app. The number only falls as slices switch or delete their old
    // bodies: W37 switched four functions, W38 five, W39 three and W40 two, and the 12 modules beside them (and the
    // other 2 functions) are untouched.
    expect(compared.length).toBeLessThanOrEqual(28)
    const trimmed = Object.keys(TRIMMED_IN_THE_STAFF_APP).filter((name) => existsSync(path.join(appDir, 'backend/paddock', name)))
    expect(compared.length).toBe(28 - SWITCHED_TO_THE_WORKER.size - trimmed.length - backendFiles.filter((file) => !existsSync(path.join(appDir, 'backend/paddock', inBackend(file)))).length)
    // W44: a trimmed module is the copy's with those exports gone: the staff app no longer names them, the copy does.
    for (const name of trimmed) {
      const now = code(path.join(appDir, 'backend/paddock', name))
      const frozen = code(path.join(COPY_CODE, name))
      for (const one of TRIMMED_IN_THE_STAFF_APP[name] ?? []) {
        expect(new RegExp(`\\b${one}\\b`).test(now), `${name}: ${one}`).toBe(false)
        expect(new RegExp(`\\b${one}\\b`).test(frozen), `${name}: ${one} (copy)`).toBe(true)
      }
      expect(now.length, name).toBeLessThan(frozen.length)
    }
    // A switched function is a thin wrapper, not a drifted copy: it calls the Worker and no longer touches the database.
    for (const name of SWITCHED_TO_THE_WORKER) {
      const wrapper = code(path.join(appDir, 'backend/paddock', name))
      const through = THIN_THROUGH[name]
      if (through) {
        expect(wrapper, name).toContain(`from './${through.replace(/\.ts$/, '')}'`)
        expect(code(path.join(appDir, 'backend/paddock', through)), through).toContain('callWorker')
        expect(code(path.join(appDir, 'backend/paddock', through)), through).not.toContain('paddockData')
      } else expect(wrapper, name).toContain('callWorker')
      expect(wrapper, name).not.toContain('paddockData')
      expect(wrapper, name).not.toContain('paddockBackendApi2')
    }
  })

  it('W44: the app no longer has the routes or the date sum, so the copy is the only one; its two repointed import lines are still there, once each', () => {
    const routeCopies = copyFiles.filter((one) => !one.startsWith(COPY_CODE + path.sep)).map(inCopy)
    expect(routeCopies).toHaveLength(7)
    expect(routeCopies.filter((name) => existsSync(path.join(workerDir, originalOf(name))))).toEqual([])
    expect(originalOf('routes/memberships/cancel/route.ts')).toBe('app/api/memberships/cancel/route.ts')
    for (const [name, copyLine] of Object.entries(REPOINTED)) expect(readFileSync(path.join(COPY_DIR, name), 'utf8').split(copyLine), name).toHaveLength(2)
  })

  it('the old side loads every step F function from it; the earlier copies still answer for what they hold; the rest from where it was', () => {
    for (const action of LEGACY_ACCOUNT_ACTIONS) expect(oldFunctionPath(action)).toBe(path.join(COPY_CODE, `${action}.ts`))
    // Modules only this copy holds.
    expect(oldFunctionPath('shared/membershipPaymentDate.ts')).toBe(path.join(COPY_CODE, 'shared/membershipPaymentDate.ts'))
    expect(oldFunctionPath('shared/formatIsoDate')).toBe(path.join(COPY_CODE, 'shared/formatIsoDate.ts'))
    // In an earlier copy too: named from there, as before W36.
    expect(oldFunctionPath('shared/staffAccess.ts')).toBe(path.join(legacyBookingDir, 'shared/staffAccess.ts'))
    expect(oldFunctionPath('refundBooking')).toBe(path.join(legacyBookingDir, 'refundBooking.ts'))
    expect(oldFunctionPath('refundOrder')).toBe(path.join(legacyRefundDir, 'refundOrder.ts'))
    expect(oldFunctionPath('createOrder')).toBe(path.join(legacyOrderDir, 'createOrder.ts'))
    // Not step F's: still the staff app's own (step G).
    expect(oldFunctionPath('getOrders')).toBe(path.join(appDir, 'backend/paddock/getOrders.ts'))
    expect(oldFunctionPath('getMembershipPlans')).toBe(path.join(appDir, 'backend/paddock/getMembershipPlans.ts'))
  })

  it('the replay calls the three legacy membership routes from the copy, never from app/', () => {
    const binding = code(LEGACY_ROUTES)
    for (const route of ROUTES) {
      expect(binding).toContain(`'/api/memberships/${route}': () => import('../${COPY_NAME}/routes/memberships/${route}/route')`)
      expect(binding).not.toContain(`@/app/api/memberships/${route}`)
    }
  })

  it("nothing in the Worker's app code reaches it: only tests, through the replay harness and its legacy-routes binding", () => {
    const users = workerFiles.filter((file) => !file.startsWith(COPY_DIR + path.sep) && file !== __filename)
    const appCode = users.filter((file) => !/\.test\.tsx?$/.test(file) && !file.startsWith(TESTING_DIR + path.sep))
    expect(appCode.filter((file) => reachesCopy(code(file))).map(shown)).toEqual([])
    // Only the harness and the legacy-routes binding name the folder itself.
    const naming = users.filter((file) => literals(code(file)).some((literal) => literal.includes(COPY_NAME)))
    expect(naming.map(shown).sort()).toEqual([shown(HARNESS), shown(LEGACY_ROUTES)].sort())
    // The other three copies don't reach into it: each copy stands alone.
    for (const other of [legacyOrderDir, legacyBookingDir, legacyRefundDir]) {
      expect(sourceFiles(path.resolve(other, '../..'), ['backend', 'routes']).filter((file) => reachesCopy(code(file))).map(shown)).toEqual([])
    }
  })

  it('nothing in the staff app reaches it', () => {
    expect(staffAppFiles.filter((file) => reachesCopy(code(file))).map(shown)).toEqual([])
  })

  it('the test itself would catch one (each check finds a planted use)', () => {
    const planted = withoutComments([`import cancel from '../../server/rules/testing/${COPY_NAME}/backend/paddock/setMembershipCancellation'`, `// ${COPY_NAME} named only in a comment`].join('\n'))
    expect(reachesCopy(planted)).toBe(true)
    expect(reachesCopy('const dir = legacyAccountDir')).toBe(true)
    expect(reachesCopy(withoutComments(`// ${COPY_NAME} named only in a comment`))).toBe(false)
    expect(importsOf("import '../globals'\nimport x from './shared/a'\nconst y = await import('./shared/b')")).toEqual(['../globals', './shared/a', './shared/b'])
    expect(importsOf("await supabase.from('customers').select('id')")).toEqual([])
    expect(COPY_NAME).toBe('legacy-account')
  })

  it('scans both repos and the copy (a wrong folder would pass with nothing to scan)', () => {
    expect(workerFiles.some((file) => file.endsWith(path.join('server', 'rules', 'memberships', 'left.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('frontend', 'components', 'CancelMembershipDialog.tsx')))).toBe(true)
    expect(copyFiles.length).toBe(35)
  })
})
