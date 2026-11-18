import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PAYMENT_DATE_NEW_WORDS } from '@/server/rules/memberships/failure-messages'
import { legacyAccountDir, legacyBookingDir, legacyOrderDir, legacyRefundDir } from './replay/harness'
import { staffAppDir } from './staff-app-dir'

// Brief W44 (F-plan 5 "W44"; Wayne's yes, 18 Nov 2026, on briefs/W44-inventory.md lines A1 to A6, D1 to D6, D8, D9),
// as W16's removed-order-code.test.ts, W25's removed-booking-code.test.ts and W34's removed-refund-code.test.ts: the
// old code step F left behind is gone. In the Worker: the three legacy membership routes (cancel, undo-cancel,
// change-payment-date) with their cores and tests, the old cancel's date sum, and the guards W40d and W41 gave the
// routes, with the words and reads only the guards used. In the staff app: fifteen exports with no caller, two screen
// files nothing imported and one stale note. Nothing left in either repo may import, load or call any of it. Comments
// may still say what was ported from where. The one exception, as before: the frozen test-only copies beside this
// file, which the replay alone uses and which have held the three routes and the date sum since W36. They go at step H.

const workerDir = path.resolve(__dirname, '../../..')
const appDir = staffAppDir()

/** Every file W44 took out of the Worker (nothing was moved: the frozen copy already had its own). */
const DELETED_WORKER = [
  'app/api/memberships/cancel/route.ts',
  'app/api/memberships/cancel/core.ts',
  'app/api/memberships/cancel/core.test.ts',
  'app/api/memberships/undo-cancel/route.ts',
  'app/api/memberships/undo-cancel/core.ts',
  'app/api/memberships/undo-cancel/core.test.ts',
  'app/api/memberships/change-payment-date/route.ts',
  'app/api/memberships/change-payment-date/core.ts',
  'app/api/memberships/change-payment-date/core.test.ts',
  'lib/membership-cancellation.ts',
  'lib/membership-cancellation.test.ts',
  'server/rules/memberships/legacy-guard.ts',
]
/** The three routes, as the old staff app called them, and the route that does each job now. */
const DELETED_ROUTES: Record<string, string> = {
  '/api/memberships/cancel': 'cancel',
  '/api/memberships/undo-cancel': 'undo-cancel',
  '/api/memberships/change-payment-date': 'payment-date',
}
/** What the frozen step F copy still holds of them, for the replay's old side. */
const KEPT_IN_THE_COPY = [
  'routes/memberships/cancel/route.ts',
  'routes/memberships/cancel/core.ts',
  'routes/memberships/undo-cancel/route.ts',
  'routes/memberships/undo-cancel/core.ts',
  'routes/memberships/change-payment-date/route.ts',
  'routes/memberships/change-payment-date/core.ts',
  'lib/membership-cancellation.ts',
]
/** What the deleted Worker files exported, and what only the guards used: gone from the Worker's own code. */
const REMOVED_WORKER_NAMES = [
  'legacyMembershipChangeHeld',
  'legacyPaymentDateOff',
  'legacyPaymentDateHeld',
  'stepsUnsettled',
  'workerPaymentDateChangePending',
  'LEGACY_MEMBERSHIP_CHANGE_HELD_MESSAGE',
  'LEGACY_PAYMENT_DATE_HELD_MESSAGE',
  'computeMembershipCancellation',
  'computeMembershipEndDate',
]

/** The staff app's three files W44 deleted. */
const DELETED_STAFF_APP = ['frontend/components/StarterCanvas.tsx', 'frontend/components/ChangeSessionServiceTypeDialog.tsx', 'frontend/notes/store-credit-changes.md']
/** The fifteen exports W44 took out of six shared modules that stay (inventory D1 to D6). */
const REMOVED_STAFF_EXPORTS: Record<string, string[]> = {
  'shared/staffAccess.ts': ['requireCanIssueRefunds'],
  'shared/promoCodes.ts': ['applyPromoCode', 'spreadFixedDiscount', 'PROMO_FAILURE_MESSAGES', 'PromoUsageCounts'],
  'shared/guestValidation.ts': ['validateGuests', 'findAccountHolderIndex', 'AccountHolderProfile', 'GuestValidationReason', 'GuestValidationResult', 'GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE'],
  'shared/readerPaymentOpen.ts': ['anyReaderPaymentOpenOnBooking'],
  'shared/londonTime.ts': ['startsWithinRealHours', 'addMonthsToIsoDate'],
  'shared/eventAttendance.ts': ['loadEventAttendeeState'],
}
const REMOVED_STAFF_NAMES = [...Object.values(REMOVED_STAFF_EXPORTS).flat(), 'StarterCanvas', 'ChangeSessionServiceTypeDialog']

const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.git', 'storybook-static', 'coverage', '.wrangler'])
const COPY_DIR = path.resolve(legacyAccountDir, '../..')
const FIXTURE_DIRS = [legacyOrderDir, legacyBookingDir, legacyRefundDir, legacyAccountDir].map((dir) => path.resolve(dir, '../..'))
const REPLAY_DIR = path.join(__dirname, 'replay')
/** The frozen copy's guard names the copy's files, their import lines and where each came from, in its own lists. */
const FROZEN_GUARD = path.join(__dirname, 'frozen-account-code.test.ts')

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
function deletedTargetOf(file: string, target: string): string | undefined {
  const from = target.startsWith('@/') ? path.join(workerDir, target.slice(2)) : target.startsWith('.') ? path.resolve(path.dirname(file), target) : null
  if (!from) return undefined
  const landed = path.relative(workerDir, from).split(path.sep).join('/').replace(/\.(ts|js)$/, '')
  return DELETED_WORKER.find((deleted) => deleted.replace(/\.ts$/, '') === landed)
}
/** A literal that is one of the three deleted paths: the path itself, or with something after a slash or a query. */
const deletedRouteIn = (literal: string): string | undefined => Object.keys(DELETED_ROUTES).find((route) => new RegExp(`${route.replace(/[/-]/g, '\\$&')}(?![\\w-])`).test(literal))

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

describe('W44: nothing still needs what was removed', () => {
  it('every deleted file is gone, in both repos, and the frozen copy still holds the three routes and the date sum', () => {
    expect(DELETED_WORKER).toHaveLength(12)
    expect(DELETED_WORKER.filter((file) => existsSync(path.join(workerDir, file)))).toEqual([])
    expect(DELETED_STAFF_APP).toHaveLength(3)
    expect(DELETED_STAFF_APP.filter((file) => existsSync(path.join(appDir, file)))).toEqual([])
    // Until step H: the replay's old side runs them from the frozen step F copy.
    expect(KEPT_IN_THE_COPY.filter((file) => !existsSync(path.join(COPY_DIR, file)))).toEqual([])
    // Kept on purpose (inventory A7): the copy's date sum imports the app's London time helper.
    expect(existsSync(path.join(workerDir, 'lib/london-time.ts'))).toBe(true)
  })

  it('the three routes answer 404: no route file under app/ serves them, and the routes that replaced them are served', () => {
    for (const route of Object.keys(DELETED_ROUTES)) expect(routesServing(route), route).toEqual([])
    // No source file at all is left under the folder they had to themselves (its README stays).
    expect(sourceFiles(workerDir, ['app/api/memberships'])).toEqual([])
    // The same check finds the routes that replaced them (a resolver that found nothing would pass the lines above).
    const id = '0f0f0f0f-0000-4000-8000-000000000000'
    for (const [route, now] of Object.entries(DELETED_ROUTES)) {
      expect(routesServing(`/api/v1/staff/memberships/${id}/${now}`), route).toEqual([path.join('app', 'api', 'v1', 'staff', 'memberships', '[membershipId]', now, 'route.ts')])
    }
    // Nothing rewrites or redirects to them either.
    const config = path.join(workerDir, 'next.config.ts')
    const configCode = existsSync(config) ? read(config) : ''
    for (const route of Object.keys(DELETED_ROUTES)) expect(configCode.includes(route), route).toBe(false)
  })

  it('no Worker code or test imports a deleted file', () => {
    const found: string[] = []
    for (const [file, text] of workerCode) {
      if (file === FROZEN_GUARD) continue
      for (const target of importsOf(text)) if (deletedTargetOf(file, target)) found.push(`${shown(file)}: '${target}'`)
    }
    expect(found).toEqual([])
  })

  it("no Worker code or test uses what the deleted files exported or what only the guards used, and the guard's words are gone", () => {
    const found: string[] = []
    for (const [file, text] of workerCode) {
      for (const name of REMOVED_WORKER_NAMES) if (new RegExp(`\\b${name}\\b`).test(text)) found.push(`${shown(file)}: ${name}`)
    }
    expect(found).toEqual([])
    expect('legacyOff' in PAYMENT_DATE_NEW_WORDS).toBe(false)
    for (const text of workerCode.values()) expect(/\blegacyOff\b/.test(text)).toBe(false)
  })

  it('no code or test calls a deleted route, in either repo, but the replay driving the frozen copy', () => {
    const found: string[] = []
    for (const [file, text] of [...workerCode, ...staffAppCode]) {
      if (file.startsWith(REPLAY_DIR + path.sep) || file === FROZEN_GUARD) continue
      for (const literal of literals(text)) if (deletedRouteIn(literal)) found.push(`${shown(file)}: '${literal}'`)
    }
    expect(found).toEqual([])
    // The harness binds each one to the frozen copy's route, never to app/.
    const bindings = read(path.join(REPLAY_DIR, 'legacy-routes.ts'))
    for (const route of Object.keys(DELETED_ROUTES)) {
      expect(bindings).toContain(`'${route}': () => import('../${path.basename(COPY_DIR)}/routes${route.replace(/^\/api/, '')}/route')`)
    }
    expect(literals(bindings).filter((literal) => literal.startsWith('@/app/api/memberships'))).toEqual([])
  })

  it('the staff app uses none of the removed names, and each trimmed module is still there without them', () => {
    const found: string[] = []
    for (const [file, text] of staffAppCode) {
      for (const name of REMOVED_STAFF_NAMES) if (new RegExp(`\\b${name}\\b`).test(text)) found.push(`${shown(file)}: ${name}`)
    }
    expect(found).toEqual([])
    expect(REMOVED_STAFF_NAMES).toHaveLength(17)
    for (const file of Object.keys(REMOVED_STAFF_EXPORTS)) expect(existsSync(path.join(appDir, 'backend/paddock', file)), file).toBe(true)
    // What stays in them is still exported (the inventory's "stay" list).
    const exported = (file: string, name: string) => new RegExp(`export (async )?(function|const|interface|type) ${name}\\b`).test(read(path.join(appDir, 'backend/paddock', file)))
    for (const [file, name] of [
      ['shared/staffAccess.ts', 'getStaffAccessRow'],
      ['shared/staffAccess.ts', 'requireStaffAdmin'],
      ['shared/promoCodes.ts', 'validatePromoCodeFields'],
      ['shared/promoCodes.ts', 'normalizePromoCodeText'],
      ['shared/guestValidation.ts', 'GuestInput'],
      ['shared/readerPaymentOpen.ts', 'NO_READER_PAYMENT_OPEN'],
      ['shared/readerPaymentOpen.ts', 'READER_PAYMENT_OPEN_MESSAGE'],
      ['shared/londonTime.ts', 'londonToday'],
      ['shared/londonTime.ts', 'londonWallClockToUtc'],
      ['shared/eventAttendance.ts', 'ATTENDEE_STATE_COLUMNS_SQL'],
    ] as const) {
      expect(exported(file, name), `${file}: ${name}`).toBe(true)
    }
  })

  it('the test itself would catch one (each check finds a planted use)', () => {
    const planted = withoutComments(
      [
        "import { legacyMembershipChangeHeld } from '@/server/rules/memberships/legacy-guard'",
        "import { computeMembershipCancellation } from './membership-cancellation'",
        "const route = await import('@/app/api/memberships/cancel/route')",
        "import { cancelMembership } from '@/server/rules/memberships/cancel'",
        "rawRequest({ path: '/api/memberships/cancel' })",
        "rawRequest({ path: '/api/memberships/change-payment-date?x=1' })",
        // Not one of the three: a longer path that only starts like one.
        "rawRequest({ path: '/api/memberships/cancellations' })",
        'callWorker(user, { path: `/api/v1/staff/memberships/${id}/cancel` })',
        '// stepsUnsettled is only named in this comment',
        'return stepsUnsettled(db, id)',
      ].join('\n')
    )
    const at = path.join(workerDir, 'lib/planted.ts')
    expect(importsOf(planted).map((target) => deletedTargetOf(at, target))).toEqual([
      'server/rules/memberships/legacy-guard.ts',
      'lib/membership-cancellation.ts',
      'app/api/memberships/cancel/route.ts',
      undefined,
    ])
    expect(literals(planted).filter((literal) => deletedRouteIn(literal) !== undefined)).toEqual(['@/app/api/memberships/cancel/route', '/api/memberships/cancel', '/api/memberships/change-payment-date?x=1'])
    expect(planted.match(/\bstepsUnsettled\b/g)).toHaveLength(1)
    expect(REMOVED_WORKER_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(planted))).toEqual(['legacyMembershipChangeHeld', 'stepsUnsettled', 'computeMembershipCancellation'])
    // A route file put back under app/ is seen by the 404 check's resolver.
    for (const route of Object.keys(DELETED_ROUTES)) {
      const restored = patternOf(path.join(...route.split('/').filter(Boolean)))
      expect(restored.test(route), route).toBe(true)
      expect(routePatterns().some(({ pattern }) => pattern.source === restored.source), route).toBe(false)
    }
  })

  it('scans both repos (a wrong folder would pass with nothing to scan)', () => {
    expect(scannedWorkerFiles.some((file) => file.endsWith(path.join('server', 'rules', 'memberships', 'left.ts')))).toBe(true)
    expect(scannedWorkerFiles.some((file) => file.endsWith(path.join('server', 'rules', 'memberships', 'cancel.test.ts')))).toBe(true)
    expect(scannedWorkerFiles.some((file) => file.endsWith(path.join('server', 'staff-app-helpers.test.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('backend', 'paddock', 'setMembershipCancellation.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('backend', 'paddock', 'typecheckAll.ts')))).toBe(true)
    expect(staffAppFiles.some((file) => file.endsWith(path.join('frontend', 'components', 'CancelMembershipDialog.tsx')))).toBe(true)
    expect(routePatterns().length).toBeGreaterThan(30)
  })

  // W45a items 3 (W45 audit F1, F2): two header comments still described what W44 took out.
  it("the Worker's own headers no longer describe what W44 removed: left.ts's \"Not guaranteed\" has no legacy routes or their guard, and membership-switch.ts no longer calls switching back a Retool rollback", () => {
    /** A file's comment lines as one run of text, so a sentence is found however it is wrapped. */
    const comments = (file: string) =>
      readFileSync(path.join(workerDir, file), 'utf8')
        .split('\n')
        .filter((line) => line.trimStart().startsWith('//'))
        .map((line) => line.trimStart().replace(/^\/\/\s?/, '').trim())
        .join(' ')
    const left = comments('server/rules/memberships/left.ts')
    expect(left).toContain('- A wish with no step: a membership with no subscription has none.')
    expect(left).not.toContain('a change made through the two legacy routes')
    expect(left).not.toContain('Their guard is a read before the change')
    // The history line stays: it says the guard left, which is true.
    expect(left).toContain("(W40d's guard on the two legacy routes, cancel and undo, left with them at W44.)")
    const membershipSwitch = comments('server/rules/memberships/membership-switch.ts')
    expect(membershipSwitch).toContain('switching back is the kind off, then fixing forward')
    expect(membershipSwitch).not.toContain('switching back is a Retool rollback')
  })

  // W46 item 7 (W45a "Noticed" 4): the same sentence was in two more headers. Their old routes left at W25 and W34.
  it.each(['server/rules/bookings/booking-switch.ts', 'server/rules/refunds/refund-switch.ts'])("%s no longer calls switching back a Retool rollback: a kind off has no old route behind it", (file) => {
    const comments = readFileSync(path.join(workerDir, file), 'utf8')
      .split('\n')
      .filter((line) => line.trimStart().startsWith('//'))
      .map((line) => line.trimStart().replace(/^\/\/\s?/, '').trim())
      .join(' ')
    expect(comments).toContain('switching back is the kind off, then fixing forward')
    expect(comments).toContain('a kind off has no old route behind it')
    expect(comments).not.toMatch(/Retool rollback/)
  })
})
