import { ID, paidSeat } from '../replay/scenarios'
import type { Scenario } from './run'

/*
 * W64 (H-plan 3.3 step 3): the forms in which the sweep presses a scenario on the Worker, where the scenario's own steps
 * press in a way the screen no longer does. Each came word for word from the family test that first pressed it so
 * (named on each; those tests went at W65), so the all-Worker sweep presses every scenario as that family did.
 */

/** W07 (Q4): where Q4 changes the figure staff confirm, the figure the screen shows. */
export const NEW_SIDE_CONFIRMS: Readonly<Record<string, { toCollect: number }>> = {
  'q4-shipped-gift-card-earns-free-postage': { toCollect: 60 },
  'w07-q4-shipped-gift-card-and-product-reach-free-postage': { toCollect: 50 },
}

/** W37, W38 (FB9, FB12, FB15): the same press sent twice goes under one key (FB9, FB12, FB15). */
export const REPEATED_PRESS_SCENARIOS: ReadonlySet<string> = new Set([
  'w36-fb9-the-same-adjustment-pressed-twice-adds-twice',
  'w36-fb12-the-same-adjustment-pressed-twice-gives-twice',
  'w36-fb15-extend-pressed-twice-adds-twice',
])

/** GB14 (W49) and FB16 (W39): every read made with `call`; a refused read answers `{ thrown }`. */
export const REFUSED_READS_AS_ANSWERS: ReadonlySet<string> = new Set(['w48-gb14-the-reads-check-nobody', 'w36-fb16-every-read-answers-an-inactive-staff-member'])

/** W55 to W57: a press the old code let through and the Worker refuses answers `{ thrown }`. */
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

const samBooks = (call: (action: string, params: unknown) => Promise<unknown>) => call('createOrder', { customerId: ID.customer, booking: paidSeat(), payment: { method: 'cash', confirmedCashAmount: 20 } })

// W65b: TOLD_AGAIN (seven step G scenarios whose gap or failure sat between the old function's own statements, pressed
// here as the two presses one after the other or a write failing inside the transaction) went: each scenario now holds
// its Worker form itself (w48-scenarios.ts: the overlaps at the route's first transaction, the GB8 failing inserts).

/**
 * W50, W51 (GB7, GB17): recordings made with `call`,
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

/**
 * W64a item 5 (W64 review S4): a press the screen could never send, pressed on the Worker as its dialog sends it. W50's
 * read of "the method of the booking's own order" needs a guest added on an order of its own: the recording added Bea
 * with `payment: { method: 'store_credit' }`, which the Worker refuses (`invalid_payment_method`: store credit is a part,
 * not a method), so the read was never reached with two orders. With store credit covering the £20, AddGuestDialog.tsx
 * sends `payment: { storeCredit: { amount: 20 } }` and no method (a method only when something is left to pay); the
 * press adds the figures, and Bea's over-18 tick is the scenario's.
 */
export const AS_THE_DIALOG_SENDS: Readonly<Record<string, Scenario['run']>> = {
  'w48-bookings-read-the-method-of-the-bookings-own-order': async ({ call }) => {
    const { bookingId } = (await samBooks(call)) as { bookingId: string }
    await call('addBookingGuest', { bookingId, guestName: 'Bea Guest', guestEmail: 'bea@example.com', guestsOver18Confirmed: true, payment: { storeCredit: { amount: 20 } } })
    await call('getBookingById', { bookingId })
  },
}

/** A scenario as its family pressed it on the Worker (ATTEMPTED), or as its dialog sends it (AS_THE_DIALOG_SENDS), else as it is. */
export function asPressedNow(scenario: Scenario): Scenario {
  const asSent = AS_THE_DIALOG_SENDS[scenario.name]
  if (asSent) return { ...scenario, run: asSent }
  if (ATTEMPTED.has(scenario.name)) return { ...scenario, run: (context) => scenario.run({ ...context, call: context.attempt }) }
  return scenario
}
