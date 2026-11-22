import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { vi } from 'vitest'
import type { Db, SqlParam } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { staffAppDir } from '../staff-app-dir'
import { EVENT_QUOTE_BEFORE_024, REPLAY_USER, type ReplaySide } from '../sweep/run'
import type { Recording, Row } from './compare'
import { bindLegacyRoutes, bindStaffRoutes } from './legacy-routes'

/**
 * Replays a scenario from the same seed through either side, and records what it did: the rows
 * written, the Stripe calls in order, and what staff were told. See README.md beside this file.
 *
 * The clock is fixed and moves 1ms per statement, which also moves PGlite's now(), because it reads
 * the same Date.now. So a run is exactly repeatable, dates included, and golden files don't go
 * stale. Statements still get different created_at values, as they do in production.
 *
 * W64: the part that runs and records a scenario (startReplay, replay, the types) moved unchanged to
 * `../sweep/run.ts`, which has nothing of the old code in it; it is re-exported here so the old replay's files
 * read it as before. What stays here is the old side and the golden files, which go at W65.
 */
export {
  EVENT_QUOTE_BEFORE_024,
  eventQuoteBefore024Sql,
  forgetSwitchedOffAnswers,
  putBackWhenEmpty,
  replay,
  REPLAY_NOW,
  REPLAY_USER,
  restoreSchema,
  startReplay,
  type ReplayEnvironment,
  type ReplayOptions,
  type ReplaySide,
  type Scenario,
  type ScenarioContext,
} from '../sweep/run'

export const backendDir = path.join(staffAppDir(), 'backend/paddock')

/**
 * W16 (Wayne, 12 Nov: option B): the staff app's old order code is deleted, but 687 of the golden scenarios set up
 * their booking through it before running the refund or flow code they test. Those three actions run from a
 * frozen test-only copy (legacy-order/README.md), so every golden file still replays exactly. Setup only: nothing
 * else may import it, and it goes at step H.
 */
export const LEGACY_ORDER_ACTIONS: ReadonlySet<string> = new Set(['createOrder', 'finaliseReaderOrder', 'cancelReaderOrder'])
export const legacyOrderDir = path.join(__dirname, '../legacy-order/backend/paddock')

/**
 * W17 (D-plan 4.11 item 1): step D deletes the staff app's booking-change functions slice by slice, but the golden
 * scenarios set up with an old Move, Add Guest, refund or reader flow before the step they test. Those functions,
 * and every module they import, run from a second frozen test-only copy (legacy-booking/README.md), so each golden
 * file keeps replaying exactly whichever actions have switched. Setup and the recorded side only; it goes at step H.
 */
export const LEGACY_BOOKING_ACTIONS: ReadonlySet<string> = new Set([
  'moveBooking',
  'addBookingGuest',
  'settleLapsedBooking',
  'removeBookingGuest',
  'refundBooking',
  'cancelCreditBooking',
  'removeBookingAddon',
  'setBookingSpecialRequests',
  'setBookingStatus',
  'getBookingRefundFigures',
  'finaliseReaderPayment',
  'cancelReaderPayment',
])
export const legacyBookingDir = path.join(__dirname, '../legacy-booking/backend/paddock')

/**
 * W27 (E-plan 4.13 item 2, lead call L6): step E deletes the staff app's order refund and event cancellation
 * functions slice by slice (W28 to W31). Its golden files were recorded through them, so those five functions, and
 * every module they import, run from a third frozen test-only copy (legacy-refund/README.md). The recorded side and
 * setup only; it goes at step H.
 */
export const LEGACY_REFUND_ACTIONS: ReadonlySet<string> = new Set(['refundOrder', 'cancelEventPlaces', 'cancelEvent', 'getEventCancellationQuote', 'getEventCancellationOverview'])
export const legacyRefundDir = path.join(__dirname, '../legacy-refund/backend/paddock')

/**
 * W36 (F-plan 4.12 items 1 and 2, lead call L5): step F moves the staff app's membership, customer, store credit and
 * gift card functions to the Worker slice by slice (W37 to W41), and each slice deletes that function's old body. Its
 * golden files were recorded through them and through the three legacy membership routes, so those sixteen functions
 * and every module they import run from a fourth frozen test-only copy (legacy-account/README.md), which also holds
 * the three routes (bound in legacy-routes.ts). The recorded side and setup only; it goes at step H.
 */
export const LEGACY_ACCOUNT_ACTIONS: ReadonlySet<string> = new Set([
  'setMembershipCancellation',
  'changeMembershipPaymentDate',
  'getMembershipPaymentDateQuote',
  'adjustMembershipCredits',
  'getMembershipCreditAdjustments',
  'setMembershipHerd',
  'getSubscriptions',
  'createCustomer',
  'getCustomers',
  'getCustomerDetail',
  'adjustCustomerStoreCredit',
  'extendGiftCardExpiry',
  'setGiftCardPickedUp',
  'setGiftCardShipped',
  'getGiftCards',
  'getGiftCardRedemptions',
])
export const legacyAccountDir = path.join(__dirname, '../legacy-account/backend/paddock')

/**
 * W48 (G-plan 4.9 items 1 and 2, lead call L5): step G moves the staff app's last 82 functions that are not a thin
 * call (the staff list, the catalogue, pricing, promo codes, sessions and the timetable, the booking and order
 * screens' reads and flags, event check-in) to the Worker slice by slice, and each slice deletes that function's old
 * body. Its golden files were recorded through them and through the seven legacy /api/catalog routes (removed from
 * the app at W61), so those 82
 * functions and every module they import run from a fifth frozen test-only copy (legacy-admin/README.md), which also
 * holds the seven routes (bound in legacy-routes.ts). The recorded side and setup only; it goes at step H. From here
 * on no old function is loaded from the staff app's own checkout: only its thin wrappers are.
 */
export const LEGACY_ADMIN_ACTIONS: ReadonlySet<string> = new Set([
  // Staff
  'getCurrentStaff',
  'getStaff',
  'createStaff',
  'setStaffRole',
  'setStaffPermission',
  'setStaffCanManagePricing',
  // Catalog: service types
  'getServiceTypes',
  'setServiceTypeActive',
  'setServiceTypeCapacityInfo',
  'createServiceTypePriceTier',
  'setServiceTypePriceTierRange',
  'updateTierPrice',
  'addServiceTypeScheduleSlot',
  'deleteServiceTypeScheduleSlot',
  // Catalog: products and add-ons
  'getProducts',
  'setProductActive',
  'setProductFulfillmentMethod',
  'setProductVariantDetails',
  'createProductVariant',
  'adjustVariantStock',
  'getStockAdjustments',
  'updateCatalogItemPrice',
  'getAddons',
  'setAddonActive',
  'setAddonSku',
  // Catalog: session passes and gift card types
  'getSessionPassTypes',
  'setSessionPassActive',
  'setSessionPassExpiry',
  'setSessionPassSessionsIncluded',
  'setSessionPassLevel',
  'getGiftCardTypes',
  'setGiftCardTypeActive',
  'setGiftCardPresetActive',
  'createGiftCardPreset',
  'updateGiftCardPresetPrice',
  'setGiftCardTypeCustomAmountSettings',
  'setGiftCardTypeExpiry',
  // Catalog: membership plans
  'getMembershipPlans',
  'createMembershipPlan',
  'setMembershipPlanActive',
  'setMembershipPlanDetails',
  'getMembershipSettings',
  'setMembershipSettings',
  // Catalog: events, and the attendee list
  'getEvents',
  'setEventActive',
  'setEventDetails',
  'getEventAttendees',
  'setEventAttendeeCheckIn',
  'setEventAttendeesCheckIn',
  'setEventAttendeeWaiver',
  // Promo codes
  'getPromoCodes',
  'getPromoCodeRedemptions',
  'createPromoCode',
  'updatePromoCode',
  // Pricing
  'setBandPrice',
  'setBandRules',
  'setMembershipBandTerm',
  'setPostageSettings',
  // Sessions and the timetable
  'getSessionsForRange',
  'getServiceTypesForSlot',
  'blockSession',
  'blockDay',
  'unblockSession',
  'unblockDay',
  'setSessionBand',
  'resetSessionBand',
  'setSessionStartTime',
  'createOneOffSession',
  'generateUpcomingSessions',
  // Bookings
  'getBookings',
  'getBookingById',
  'getBookingDetail',
  'getAddonPrepChecklistForRange',
  'setBookingCheckedIn',
  'setGuestWaiverStatus',
  'setAddonLinePrepared',
  // Orders
  'getOrders',
  'getOrderLineItems',
  'setOrderLineItemFulfilled',
  // Overview
  'getPaymentAttentionItems',
  'getWaiverGapsForRange',
  'getTodaysEvents',
])
export const legacyAdminDir = path.join(__dirname, '../legacy-admin/backend/paddock')

/**
 * Where the old side loads a staff app file from (`moveBooking.ts`, `shared/bookingMoneyClaim.ts`): the frozen
 * booking copy for anything it holds (step D), the frozen refund copy for the five old step E actions and the
 * modules only it holds (W27), the frozen order copy for the three old order actions, the frozen account copy for
 * the sixteen old step F functions and the modules only it holds (W36), the frozen admin copy for the 82 old step G
 * functions and the modules only it holds (W48: the catalogue, the Orders page, the reads), else the staff app's own
 * checkout (its thin wrappers: no old function is left to load from there). A module both the booking
 * and the refund copy hold (`shared/staffAccess.ts`) is named from the booking copy, as before W27; each copy's own
 * functions import their own, relatively, whatever this answers.
 */
export function oldFunctionPath(file: string): string {
  const name = file.replace(/\.ts$/, '')
  if (existsSync(path.join(legacyBookingDir, `${name}.ts`))) return path.join(legacyBookingDir, `${name}.ts`)
  if (LEGACY_REFUND_ACTIONS.has(name) || existsSync(path.join(legacyRefundDir, `${name}.ts`))) return path.join(legacyRefundDir, `${name}.ts`)
  if (LEGACY_ORDER_ACTIONS.has(name)) return path.join(legacyOrderDir, `${name}.ts`)
  // W36: the sixteen old step F functions, and the modules only that copy holds (`shared/membershipPaymentDate.ts`).
  if (LEGACY_ACCOUNT_ACTIONS.has(name) || existsSync(path.join(legacyAccountDir, `${name}.ts`))) return path.join(legacyAccountDir, `${name}.ts`)
  // W48: the 82 old step G functions, and the modules only that copy holds (`shared/pricingStaff.ts`).
  if (LEGACY_ADMIN_ACTIONS.has(name) || existsSync(path.join(legacyAdminDir, `${name}.ts`))) return path.join(legacyAdminDir, `${name}.ts`)
  return path.join(backendDir, `${name}.ts`)
}
const goldenDir = path.join(__dirname, 'golden')

function tick(): void {
  vi.setSystemTime(Date.now() + 1)
}

/** The old functions, run from the staff app's checkout with paddockData on the real driver. */
export function oldSide(db: Db, stripe: FakeStripe): ReplaySide {
  const query = async (sql: string, params: unknown[] = []) => {
    // Retool maps $N to params[N-1] only if they ascend and none repeats.
    const used = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
    if (used.some((n, i) => n !== i + 1)) throw new Error(`Placeholders out of order, which Retool would swap: ${sql}`)
    tick()
    // W33: the old functions read the event quote as it was when they were recorded (before migration 024).
    const asRecorded = sql.replace(/\bevent_cancellation_quote\(/g, `${EVENT_QUOTE_BEFORE_024}(`)
    return { data: await db.query<Row>(asRecorded, params.map((value) => value ?? null) as SqlParam[]) }
  }
  vi.stubGlobal('paddockData', { query })
  vi.stubGlobal('paddockBackendApi2', { rawRequest: bindLegacyRoutes(db, stripe) })
  vi.stubGlobal('paddockWorkerV1', { rawRequest: bindStaffRoutes() })
  // W14: the staff app's wrappers ask the Worker first; every kind is off here unless a test says otherwise.
  // W16: the old order functions run from the test-only copy (LEGACY_ORDER_ACTIONS), so they never ask.
  // W17: the old booking functions likewise (legacy-booking, oldFunctionPath).
  vi.stubEnv('ORDER_SWITCH', '')

  return {
    name: 'old',
    async call(action, params) {
      const loaded = (await import(/* @vite-ignore */ oldFunctionPath(action))) as {
        default: (req: { params: unknown; user: typeof REPLAY_USER }) => Promise<unknown>
      }
      return loaded.default({ params, user: REPLAY_USER })
    },
  }
}

const goldenFile = (scenario: string) => path.join(goldenDir, `${scenario}.json`)

/**
 * The saved recording of the old function. W02 lost its promo comparison when the old code went;
 * these outlive it, so the new routes can still be held to it after W16.
 */
export function readGolden(scenario: string): Recording | null {
  const file = goldenFile(scenario)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Recording) : null
}

export function writeGolden(recording: Recording): void {
  mkdirSync(goldenDir, { recursive: true })
  writeFileSync(goldenFile(recording.scenario), `${JSON.stringify(recording, null, 2)}\n`)
}
