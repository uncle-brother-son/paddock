import { ID, paidSeat, whileFailing } from '../replay/scenarios'
import { W48_ID } from '../replay/w48-scenarios'
import type { Scenario } from './run'

/*
 * W64 (H-plan 3.3 step 3): the forms in which a family's replay pressed a scenario on the Worker, where the recording
 * hooked the old code itself or pressed in a way the screen no longer does. "Old-code-only hooks use the form their
 * family already has": each is copied here word for word from the family's replay test or its differences file (named
 * on each), so the all-Worker sweep presses every scenario as that family did, and keeps doing so after W65 deletes the
 * families. The old replay's files are unchanged.
 */

/** order-differences.ts NEW_SIDE_CONFIRMS: where Q4 changes the figure staff confirm, the figure the screen shows. */
export const NEW_SIDE_CONFIRMS: Readonly<Record<string, { toCollect: number }>> = {
  'q4-shipped-gift-card-earns-free-postage': { toCollect: 60 },
  'w07-q4-shipped-gift-card-and-product-reach-free-postage': { toCollect: 50 },
}

/** account-differences.ts and gift-card-differences.ts REPEATED_PRESS_SCENARIOS: the same press sent twice goes under one key (FB9, FB12, FB15). */
export const REPEATED_PRESS_SCENARIOS: ReadonlySet<string> = new Set([
  'w36-fb9-the-same-adjustment-pressed-twice-adds-twice',
  'w36-fb12-the-same-adjustment-pressed-twice-gives-twice',
  'w36-fb15-extend-pressed-twice-adds-twice',
])

/** admin-differences.ts GB14_SCENARIO and customer-differences.ts FB16_SCENARIO: every read made with `call`; a refused read answers `{ thrown }`. */
export const REFUSED_READS_AS_ANSWERS: ReadonlySet<string> = new Set(['w48-gb14-the-reads-check-nobody', 'w36-fb16-every-read-answers-an-inactive-staff-member'])

/** catalog-differences.ts and plan-differences.ts REFUSED_NOW: a press the old code let through and the Worker refuses answers `{ thrown }`. */
export const REFUSED_PRESSES_AS_ANSWERS: ReadonlySet<string> = new Set([
  'w48-gb10-a-pass-type-saved-with-no-sessions-and-a-negative-expiry',
  'w48-gb10-a-gift-card-type-saved-with-a-negative-expiry',
  'w48-gb12-a-variant-made-without-manage-pricing',
  'w48-gb21-a-range-may-overlap-the-next-size-group',
  'w48-gb23-variant-details-have-no-checks',
  'w48-tier-create-where-one-band-already-has-the-group',
  'w48-gb1-the-legacy-route-answers-the-counts-the-plan-function-drops',
  'w48-gb1-an-ended-subscription-is-skipped',
])

const SATURDAY = 6
const recut = { dayOfWeek: SATURDAY, rules: [{ bandId: ID.peakBand, fromTime: '12:00', toTime: '24:00' }, { bandId: ID.band, fromTime: '00:00', toTime: '12:00' }] }
const allTen = { id: ID.promoPercent, code: 'ALLTEN', discountType: 'percentage', discountValue: 10, appliesTo: ['booking', 'addon', 'product', 'session_pass', 'membership', 'event'], appliesOnMemberPrices: false, expiresOn: null, maxTotalUses: null, oneUsePerCustomer: false, minSpend: null, restrictedCustomerId: null, active: true }
const block = { sessionId: ID.session, reason: 'Staff training' }
const moved = { sessionId: ID.session, startTime: '2026-11-12T18:00:00.000Z' }
const samBooks = (call: (action: string, params: unknown) => Promise<unknown>) => call('createOrder', { customerId: ID.customer, booking: paidSeat(), payment: { method: 'cash', confirmedCashAmount: 20 } })

/**
 * admin-replay.test.ts and session-admin-replay.test.ts TOLD_AGAIN: recordings whose gap or failure sat between the old
 * function's own statements, told again as what can still happen on a route that is one transaction (the two presses
 * one after the other; a write failing inside the transaction). The races run on real Postgres.
 */
export const TOLD_AGAIN: Readonly<Record<string, Scenario['run']>> = {
  'w48-gb16-two-admins-remove-each-others-manage-pricing': async ({ attempt, db }) => {
    await db.query('UPDATE staff SET can_manage_pricing = false, updated_at = now() WHERE id = $1', [ID.staff])
    await attempt('setStaffCanManagePricing', { staffId: W48_ID.secondAdmin, canManagePricing: false })
  },
  'w48-gb18-the-text-lock-is-a-read-then-a-write': async ({ call }) => {
    await call('createOrder', { customerId: ID.customer, booking: paidSeat(), promoCode: 'ALLTEN', payment: { method: 'cash', confirmedCashAmount: 18 } })
    await call('updatePromoCode', { ...allTen, code: 'ALLTWENTY', discountValue: 20 })
  },
  'w48-gb8-band-windows-deleted-then-an-insert-fails-and-the-old-ones-are-put-back': async ({ attempt, db }) => {
    await whileFailing(db, { table: 'band_rules', event: 'INSERT', when: "NEW.from_time = '00:00'" }, () => attempt('setBandRules', recut))
  },
  'w48-gb8-band-windows-deleted-and-the-put-back-fails-too': async ({ attempt, db }) => {
    await whileFailing(db, { table: 'band_rules', event: 'INSERT', when: 'true' }, () => attempt('setBandRules', recut))
  },
  'w48-gb8-band-windows-half-saved-then-the-put-back-overlaps': async ({ attempt, db }) => {
    await whileFailing(db, { table: 'band_rules', event: 'INSERT', when: "NEW.from_time = '12:00'" }, () => attempt('setBandRules', recut))
  },
  'w48-gb5-a-booking-placed-between-the-check-and-the-block': async ({ call }) => {
    await samBooks(call)
    await call('blockSession', block)
  },
  'w48-session-start-time-refused-booking-placed-between-the-check-and-the-write': async ({ call }) => {
    await samBooks(call)
    await call('setSessionStartTime', moved)
  },
}

/**
 * session-admin-replay.test.ts ATTEMPTED and booking-admin-replay.test.ts GB17_RECORDINGS: recordings made with `call`,
 * which stops at the first throw, whose steps the Worker now refuses: each step is attempted, so the scenario runs to
 * its end as the recording did.
 */
export const ATTEMPTED: ReadonlySet<string> = new Set([
  'w48-block-session',
  'w48-session-band-set-for-one-session',
  'w48-gb7-a-day-block-and-unblock-loses-an-earlier-block',
  'w48-gb17-a-cancelled-booking-and-a-payment-needed-one-are-checked-in',
  'w48-gb17-a-cancelled-bookings-waiver-is-changed',
  'w48-gb17-a-removed-addon-is-marked-prepared',
])

/** A scenario as its family pressed it on the Worker (TOLD_AGAIN, ATTEMPTED), else as it is. */
export function asPressedNow(scenario: Scenario): Scenario {
  const toldAgain = TOLD_AGAIN[scenario.name]
  if (toldAgain) return { ...scenario, run: toldAgain }
  if (ATTEMPTED.has(scenario.name)) return { ...scenario, run: (context) => scenario.run({ ...context, call: context.attempt }) }
  return scenario
}
