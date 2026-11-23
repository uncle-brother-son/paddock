import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { staffAppDir } from './staff-app-dir'

/*
 * W64a item 7 (H-plan 3.1): the one standing removal test. It merges what the five old removal guards hold
 * (server/removed-order-code.test.ts, W16; removed-booking-code, W25; removed-refund-code, W34; removed-account-code,
 * W44; removed-admin-code, W61), as explicit lists read from nothing but this file: the files deleted, the routes
 * deleted, the staff app modules gone, and the names removed. W65 deleted the five with the old
 * code; this stays, so removed code can't come back after them.
 *
 * Until W65 the old code and the test files that drove or guarded it were left out of the scan. W65 deleted them, so
 * the scan covers every file but this one. What W65 deleted is held gone by
 * old-code-reach.test.ts.
 */

const workerDir = path.resolve(__dirname, '../../..')
const appDir = staffAppDir()

// --- The lists (each from the guard named; nothing here is read from another file).

/** Every file deleted from the staff app. */
const DELETED_STAFF_APP_FILES = [
  // W16
  'backend/paddock/shared/orderQuoteShadow.ts',
  'backend/paddock/shared/shadowCompare.ts',
  'backend/paddock/shared/stableDiff.ts',
  'backend/paddock/shared/readerOrderRollback.ts',
  'backend/paddock/shared/createMembershipSubscription.ts',
  'backend/paddock/shared/eventOrders.ts',
  'backend/paddock/shared/promoCodeLookup.ts',
  'backend/paddock/shared/generateGiftCardCode.ts',
  'backend/paddock/createBooking.ts',
  // W25
  'backend/paddock/chargeSavedCard.ts',
  'backend/paddock/createTerminalPaymentIntent.ts',
  'backend/paddock/sweepPendingReaderPayments.ts',
  'backend/paddock/shared/workerItems.ts',
  'backend/paddock/shared/pendingReaderFlows.ts',
  'backend/paddock/shared/readerFlowFinalise.ts',
  'backend/paddock/shared/terminalPaymentIntent.ts',
  'backend/paddock/shared/creditRedemption.ts',
  'backend/paddock/shared/sessionCapacity.ts',
  // W34
  ...['eventCancellation', 'eventCancellationQuote', 'heldCardRefund', 'cardRefundAttempts', 'storeCreditRefund', 'refundPaymentIntent', 'stripeRefundLookup', 'orderCardPortion', 'orderPaymentStatus', 'cancelMembershipSubscription'].map(
    (module) => `backend/paddock/shared/${module}.ts`
  ),
  // W44
  'frontend/components/StarterCanvas.tsx',
  'frontend/components/ChangeSessionServiceTypeDialog.tsx',
  'frontend/notes/store-credit-changes.md',
  // W61
  ...[
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
    'validatePromoCode.ts',
  ].map((file) => `backend/paddock/${file}`),
]

/** Every file deleted from the Worker. */
const DELETED_WORKER_FILES = [
  // W16
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
  'server/rules/testing/reader-orders-schema.sql',
  // W25
  'app/api/payments/charge-saved-card/route.ts',
  'app/api/payments/charge-saved-card/core.ts',
  'app/api/payments/charge-saved-card/core.test.ts',
  'app/api/terminal/create-payment-intent/route.ts',
  'app/api/terminal/payment-intent/route.ts',
  'app/api/terminal/payment-intent/core.ts',
  'app/api/terminal/payment-intent/core.test.ts',
  'server/rules/orders/reconcile-contracts.ts',
  // W34
  'app/api/payments/refund-order/route.ts',
  'app/api/v1/staff/payments/refunds/route.ts',
  'app/api/memberships/cancel-subscription/route.ts',
  'app/api/bookings/refund/route.ts',
  'app/api/bookings/refund/route.test.ts',
  'app/api/bookings/partial-refund/route.ts',
  'app/api/bookings/partial-refund/route.test.ts',
  // W44
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
  // W61
  ...['toggle-active', 'update-price', 'update-tier-price', 'create-variant', 'sync-stripe', 'create-gift-card-preset', 'update-gift-card-preset-price'].map((name) => `app/api/catalog/${name}/route.ts`),
  'app/api/catalog/README.md',
  'lib/membership-price-migration.ts',
  'lib/membership-price-migration.test.ts',
  'lib/supabase/database.types.ts',
  // W65b (Wayne's yes, 22 Nov): unread since their route went at W34, and an older copy of the London time helpers
  // (the live ones are server/rules/time/london-time.ts).
  'server/rules/payments/payment-intent-refunds.ts',
  'server/rules/payments/payment-intent-refunds.test.ts',
  'lib/london-time.ts',
  'lib/london-time.test.ts',
  // W68 (H6; Wayne's yes, 23 Nov): a GET answering ok, with no caller.
  'app/api/test/route.ts',
  // W68a (Wayne's yes, 23 Nov): it only refused, and no screen called it.
  'app/api/v1/staff/catalog/service-types/[serviceTypeId]/price/route.ts',
]

/** Every route deleted, as a caller writes the path (W68a: `*` stands for one part of it, an id). */
const DELETED_ROUTES = [
  // W16
  '/api/v1/staff/orders/dry-run',
  '/api/v1/staff/parity',
  '/api/v1/staff/probes/transaction',
  '/api/terminal/connection-token',
  '/api/terminal/create-setup-intent',
  '/api/terminal/resolve-saved-card',
  '/api/memberships/create-subscription',
  '/api/payments/method',
  // W25
  '/api/payments/charge-saved-card',
  '/api/terminal/create-payment-intent',
  '/api/terminal/payment-intent',
  // W34
  '/api/payments/refund-order',
  '/api/memberships/cancel-subscription',
  '/api/v1/staff/payments/refunds',
  '/api/bookings/refund',
  '/api/bookings/partial-refund',
  // W44
  '/api/memberships/cancel',
  '/api/memberships/undo-cancel',
  '/api/memberships/change-payment-date',
  // W61
  '/api/catalog/toggle-active',
  '/api/catalog/update-price',
  '/api/catalog/update-tier-price',
  '/api/catalog/create-variant',
  '/api/catalog/sync-stripe',
  '/api/catalog/create-gift-card-preset',
  '/api/catalog/update-gift-card-preset-price',
  // W68
  '/api/test',
  // W68a
  '/api/v1/staff/catalog/service-types/*/price',
]

/** Names removed from both repos (W16, W25: each guard scanned both). */
const REMOVED_NAMES = [
  // W16
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
  // W25: the staff app's
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
  // W25: the Worker's
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

/** Names removed from the staff app (W34, W44: each guard scanned the staff app for them). */
const REMOVED_STAFF_NAMES = [
  // W34
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
  // W44
  'requireCanIssueRefunds',
  'applyPromoCode',
  'spreadFixedDiscount',
  'PROMO_FAILURE_MESSAGES',
  'PromoUsageCounts',
  'validateGuests',
  'findAccountHolderIndex',
  'AccountHolderProfile',
  'GuestValidationReason',
  'GuestValidationResult',
  'GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE',
  'anyReaderPaymentOpenOnBooking',
  'startsWithinRealHours',
  'addMonthsToIsoDate',
  'loadEventAttendeeState',
  'StarterCanvas',
  'ChangeSessionServiceTypeDialog',
]

/** Names removed from the Worker (W44: its guard scanned the Worker for them). */
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
  'legacyOff',
  // W68: the legacy routes' words, the old rollback's, and what card_moves and lapse_sweep off did instead.
  'LEGACY_CATALOG_ROUTE_WORDS',
  'OLD_ROLLBACK_WORDS',
  'OLD_ROLLBACK_STARTED_MESSAGE',
  'FINALISE_ROLLBACK_STARTED_MESSAGE',
  'oldRollbackStarted',
  'saveCustomerCard',
  'runLapseSweep',
  // W68a: what only the service type price route said.
  'privateServiceTypeUsesTiers',
  'publicServiceTypeUsesBands',
]

// --- The scan

const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.git', 'storybook-static', 'coverage', '.wrangler'])
const GENERATED = [`${path.sep}hooks${path.sep}backend${path.sep}`, `${path.sep}hooks${path.sep}useBackendFunctions.ts`]

function sourceFiles(root: string, dirs: string[]): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) found.push(full)
    }
  }
  for (const dir of dirs) walk(path.join(root, dir))
  return found
}

/** The code without its comments, so a comment naming what was removed doesn't count (as the old guards read it). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}
/** Every string literal in the code. */
function literals(code: string): string[] {
  return [...code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '')
}

const workerFiles = sourceFiles(workerDir, ['app', 'server', 'lib', 'contracts', 'scripts', 'components', 'features'])
  .concat(['custom-worker.ts', 'middleware.ts', 'next.config.ts'].map((file) => path.join(workerDir, file)).filter((file) => existsSync(file)))
  .filter((file) => file !== __filename)
const staffAppFiles = sourceFiles(appDir, ['backend', 'frontend']).filter((file) => !GENERATED.some((generated) => file.includes(generated)))
const workerCode = new Map(workerFiles.map((file) => [file, withoutComments(readFileSync(file, 'utf8'))]))
const staffAppCode = new Map(staffAppFiles.map((file) => [file, withoutComments(readFileSync(file, 'utf8'))]))
const shown = (file: string) => path.relative(path.dirname(workerDir), file)

const namesIn = (text: string, names: readonly string[]): string[] => names.filter((name) => new RegExp(`\\b${name}\\b`).test(text))
const deletedRouteIn = (literal: string): string | undefined => DELETED_ROUTES.find((route) => new RegExp(`${route.replace(/[/-]/g, '\\$&').replace('*', '[^/]+')}(?![\\w-])`).test(literal))
/** A staff app module gone, as an import, a require or a test's loader names it (with or without `.ts`). */
const GONE_STAFF_MODULES = DELETED_STAFF_APP_FILES.filter((file) => file.startsWith('backend/paddock/')).map((file) => file.replace(/^backend\/paddock\//, '').replace(/\.ts$/, ''))
function goneModulesIn(code: string): string[] {
  const found: string[] = []
  for (const line of code.split('\n')) {
    if (!/\b(from|import|require|load|loadOld)\b/.test(line)) continue
    for (const literal of literals(line)) {
      const name = literal.replace(/\.ts$/, '')
      const gone = GONE_STAFF_MODULES.find((module) => name === module || name.endsWith(`/${module}`) || (module.includes('/') && name === module.split('/').pop()))
      if (gone) found.push(literal)
    }
  }
  return found
}

/** W65b: a deleted Worker file, as an import names it (`@/…` or relative, with or without its extension). */
const DELETED_WORKER_MODULES: ReadonlySet<string> = new Set(DELETED_WORKER_FILES.map((file) => file.replace(/\.(ts|tsx)$/, '')))
function deletedWorkerImportsIn(file: string, code: string): string[] {
  return importsOf(code).filter((target) => {
    const resolved = target.startsWith('@/') ? target.slice(2) : target.startsWith('.') ? path.relative(workerDir, path.resolve(path.dirname(file), target)).split(path.sep).join('/') : null
    return resolved !== null && DELETED_WORKER_MODULES.has(resolved.replace(/\.(ts|tsx)$/, ''))
  })
}

/** Every route file under app/, as the URL pattern Next serves it at. */
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

// --- W64b (W64a check C3): two staff app checks the old guards held alone, kept here since W65 deleted them.

/** What a file imports: `from '...'`, a side-effect `import '...'`, and `import('...')` of a literal (as W61's guard read it). */
const importsOf = (code: string): string[] => [...code.matchAll(/(?<![.\w])(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')
/** The files typecheckAll.ts pulls in, as paths under backend/paddock/. */
const barrelFiles = (source: string): string[] => importsOf(withoutComments(source)).map((target) => `${target.replace(/^\.\//, '')}.ts`)
/** Every function and shared module the staff app has (backend/paddock/ and its shared/), but typecheckAll.ts itself. */
function staffBackendFiles(): string[] {
  const backend = path.join(appDir, 'backend/paddock')
  const top = readdirSync(backend).filter((name) => name.endsWith('.ts') && name !== 'typecheckAll.ts')
  const shared = readdirSync(path.join(backend, 'shared')).filter((name) => name.endsWith('.ts')).map((name) => `shared/${name}`)
  return [...top, ...shared]
}
/**
 * The backend function hooks a screen's code uses: `use` + any staff app function (the generated hooks), and any hook
 * named like a press (W25's filter), so one named for a function since deleted counts too. React's and the app's own
 * hooks (useState, useCurrentStaff) are neither.
 */
function backendHooksIn(code: string, functions: readonly string[]): string[] {
  const generated = new Set(functions.map((name) => `use${name.charAt(0).toUpperCase()}${name.slice(1)}`))
  const hooks = [...code.matchAll(/\buse[A-Z][A-Za-z]+\b/g)].map((match) => match[0])
  return [...new Set(hooks.filter((hook) => generated.has(hook) || /^use(Get|Reconcile|Close|Sweep|Charge|Create|Finalise|Cancel)/.test(hook)))].sort()
}
const staffFunctions = (): string[] => staffBackendFiles().filter((file) => !file.startsWith('shared/')).map((file) => file.replace(/\.ts$/, ''))

describe('removed code stays removed (H-plan 3.1; W64a item 7: the five removal guards in one, read from nothing but itself)', () => {
  it('every deleted file is gone, in both repos', () => {
    expect(DELETED_STAFF_APP_FILES.filter((file) => existsSync(path.join(appDir, file)))).toEqual([])
    expect(DELETED_WORKER_FILES.filter((file) => existsSync(path.join(workerDir, file)))).toEqual([])
    expect([DELETED_STAFF_APP_FILES.length, DELETED_WORKER_FILES.length]).toEqual([49, 62])
  })

  it('no code or test in the Worker imports a deleted Worker file (W65b)', () => {
    const found: string[] = []
    for (const [file, text] of workerCode) for (const target of deletedWorkerImportsIn(file, text)) found.push(`${shown(file)}: '${target}'`)
    expect(found).toEqual([])
  })

  it('every deleted route answers 404: no route file under app/ serves it (the routes that stay still are)', () => {
    for (const route of DELETED_ROUTES) expect(routesServing(route), route).toEqual([])
    for (const route of DELETED_ROUTES.filter((one) => one.includes('/payments/method'))) expect(routesServing(`${route}/pm_123`), route).toEqual([])
    // The same resolver finds routes that stay, so an empty answer above means something.
    expect(routesServing('/api/v1/staff/orders/0f0f0f0f-0000-4000-8000-000000000000/refunds')).toEqual([path.join('app', 'api', 'v1', 'staff', 'orders', '[orderId]', 'refunds', 'route.ts')])
    expect(routesServing('/api/v1/staff/reader-flows/0f0f0f0f-0000-4000-8000-000000000000/finalise')).toHaveLength(1)
    expect(routesServing('/api/v1/staff/orders/reconcile')).toHaveLength(1)
  })

  it('no code or test in either repo calls a deleted route', () => {
    const found: string[] = []
    for (const [file, text] of [...workerCode, ...staffAppCode]) {
      // W65: the kept scenario files' fault hooks are keyed by the Worker routes now, and GB15's dropped scenario went
      // with the old side, so they are scanned too. A route is a call only as a path, not as a word in a sentence that
      // names it.
      for (const literal of literals(text)) if (literal.startsWith('/api/') && deletedRouteIn(literal)) found.push(`${shown(file)}: '${literal}'`)
    }
    expect(found).toEqual([])
  })

  it('no code or test in either repo loads one of the staff app\'s gone modules', () => {
    const found: string[] = []
    for (const [file, text] of [...workerCode, ...staffAppCode]) for (const literal of goneModulesIn(text)) found.push(`${shown(file)}: '${literal}'`)
    expect(found).toEqual([])
  })

  it('no code or test uses a removed name: both repos for W16\'s and W25\'s, the staff app for W34\'s and W44\'s, the Worker for W44\'s own', () => {
    const found: string[] = []
    for (const [file, text] of [...workerCode, ...staffAppCode]) for (const name of namesIn(text, REMOVED_NAMES)) found.push(`${shown(file)}: ${name}`)
    for (const [file, text] of staffAppCode) for (const name of namesIn(text, REMOVED_STAFF_NAMES)) found.push(`${shown(file)}: ${name}`)
    for (const [file, text] of workerCode) for (const name of namesIn(text, REMOVED_WORKER_NAMES)) found.push(`${shown(file)}: ${name}`)
    expect(found).toEqual([])
  })

  it('scans what it says: both repos, hundreds of files; and each check finds what it looks for when it is there', () => {
    expect(workerCode.size).toBeGreaterThan(300)
    expect(staffAppCode.size).toBeGreaterThan(100)
    const planted = [
      "import { shadowCompare } from './shared/shadowCompare'",
      "const answer = await rawRequest({ path: '/api/bookings/refund', method: 'POST' })",
      "const { quoteEventCancellation } = await load('eventCancellationQuote')",
      '// old_reader_flow is only named in this comment',
      'if (legacyPaymentDateHeld(row)) return',
    ].join('\n')
    const code = withoutComments(planted)
    expect(namesIn(code, REMOVED_NAMES)).toEqual(['shadowCompare'])
    expect(namesIn(code, REMOVED_STAFF_NAMES)).toEqual(['quoteEventCancellation'])
    expect(namesIn(code, REMOVED_WORKER_NAMES)).toEqual(['legacyPaymentDateHeld'])
    expect(literals(code).filter((literal) => literal.startsWith('/api/') && deletedRouteIn(literal))).toEqual(['/api/bookings/refund'])
    expect(goneModulesIn(code)).toEqual(['./shared/shadowCompare', 'eventCancellationQuote'])
    // A route that only starts like a deleted one is not it.
    expect(deletedRouteIn('/api/bookings/refunds-report')).toBeUndefined()
    // W68a: a route with an id in it, written with one or built; its neighbours are not it.
    for (const path of ['/api/v1/staff/catalog/service-types/10000000-0000-4000-8000-000000000002/price', '/api/v1/staff/catalog/service-types/${encodeURIComponent(String(itemId))}/price']) expect(deletedRouteIn(path), path).toBe('/api/v1/staff/catalog/service-types/*/price')
    for (const path of ['/api/v1/staff/catalog/service-types/x/active', '/api/v1/staff/catalog/tiers/x/price', '/api/v1/staff/catalog/session-pass-types/x/price', '/api/v1/staff/catalog/service-types/x/price-list']) expect(deletedRouteIn(path), path).toBeUndefined()
    // W65b: an import of a deleted Worker file, by alias or relative path; the live London time helpers are not it.
    const importing = "import { getLondonOffsetMinutes } from '@/lib/london-time'\nimport { listPaymentIntentRefunds } from './payment-intent-refunds'\nimport { londonWallClockToUtc } from '@/server/rules/time/london-time'"
    expect(deletedWorkerImportsIn(path.join(workerDir, 'server/rules/payments/terminal.ts'), importing)).toEqual(['@/lib/london-time', './payment-intent-refunds'])
  })
})

describe('the staff app checks the old guards held alone (W64b: W64a check C3, kept when W65 deletes them)', () => {
  it('Resolve now calls reconcile only: the stuck banner calls exactly useCloseStuckOrder, useGetStuckReaderPayments and useReconcileOrders (W25)', () => {
    const banner = withoutComments(readFileSync(path.join(appDir, 'frontend/components/StuckPaymentsBanner.tsx'), 'utf8'))
    expect(backendHooksIn(banner, staffFunctions())).toEqual(['useCloseStuckOrder', 'useGetStuckReaderPayments', 'useReconcileOrders'])
  })

  it("typecheckAll.ts names every function and shared module the staff app has, and nothing it doesn't (W61, the lead's call on part 1's Noticed 3)", () => {
    const named = barrelFiles(readFileSync(path.join(appDir, 'backend/paddock/typecheckAll.ts'), 'utf8')).sort()
    expect(named).toEqual(staffBackendFiles().sort())
    expect(new Set(named).size).toBe(named.length)
    expect(named.length).toBeGreaterThan(100)
  })

  it('each check finds what it looks for when it is there', () => {
    const functions = staffFunctions()
    expect(functions).toEqual(expect.arrayContaining(['closeStuckOrder', 'getStuckReaderPayments', 'reconcileOrders', 'getMoneyOwed']))
    // A banner that also presses another function, or a deleted sweep's hook; React's and the app's own hooks don't count.
    const planted = withoutComments(
      [
        "import { useEffect, useState } from 'react'",
        "import { useCloseStuckOrder, useGetMoneyOwed, useReconcileOrders } from '../hooks/backend/paddock'",
        'const staff = useCurrentStaff()',
        'const sweep = useSweepPendingReaderPayments()',
        '// useRefundOrderOwed is only named in this comment',
      ].join('\n')
    )
    expect(backendHooksIn(planted, functions)).toEqual(['useCloseStuckOrder', 'useGetMoneyOwed', 'useReconcileOrders', 'useSweepPendingReaderPayments'])
    // The barrel read: side-effect imports, one commented out left out.
    expect(barrelFiles(["import './addBookingGuest'", "import './shared/catalogWorker'", "// import './gone'"].join('\n'))).toEqual(['addBookingGuest.ts', 'shared/catalogWorker.ts'])
  })
})
