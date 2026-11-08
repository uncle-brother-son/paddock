import type { AllowedDifference } from './compare'

/**
 * W06's replay: the scenarios the new order route can take (bookings and add-ons, in cash or with
 * nothing owed), each a single createOrder call. They run through the new route and must match the
 * old function's golden file, except the differences below. A scenario that also calls something the
 * Worker hasn't built (a refund, a move) or holds something W06 answers NOT_BUILT for isn't here;
 * quote-shadow.test.ts checks that every single-order scenario left out really is NOT_BUILT.
 */
export const W06_SCENARIOS: readonly string[] = [
  // Every line kind W06 builds
  'cash-booking-two-guests-addon',
  'member-credit-seat-guest-and-addon-credit',
  'pass-credit-seat-and-guest',
  'private-booking-in-cash',
  'member-on-their-last-day-pays-the-member-price',
  'member-past-their-last-day-pays-the-list-price',
  'member-on-their-last-day-can-use-a-credit',
  'w06-standalone-addon-in-cash',
  'w06-booking-and-a-standalone-addon-in-cash',
  'w06-private-booking-with-an-addon',
  'w06-member-credit-and-nothing-owed',
  'w06-pass-credit-and-nothing-owed',
  'w06-cash-chosen-with-nothing-owed',
  'w06-two-addon-credits-on-one-membership',
  'w06-special-requests-kept',
  'w06-a-full-public-party',
  'w06-override-with-permission-in-cash',
  'w06-override-without-permission-is-ignored-in-cash',
  // Stages 1 to 3
  'w06-refused-no-customer',
  'w06-refused-empty-order',
  'w06-refused-gift-card-booking-source',
  'w06-refused-unknown-customer',
  'w06-refused-credit-on-a-private-booking',
  // Stages 11, 12 and 14
  'w06-refused-addon-quantity',
  'w06-refused-addon-credit-with-no-membership',
  'refused-standalone-addon-on-a-credit',
  'refused-standalone-addon-on-a-credit-with-no-membership',
  'w06-refused-unknown-addon',
  'w06-refused-inactive-addon',
  'w06-refused-a-changed-price-with-no-reason',
  'w06-refused-addon-checked-before-the-booking',
  'w06-refused-unknown-method',
  // Stage 18b: every createBooking reason, then the add-on credits
  'w06-refused-unknown-session',
  'refused-session-blocked',
  'refused-session-already-started',
  'w06-refused-no-guests',
  'w06-refused-too-many-guests',
  'w06-refused-guest-with-no-name',
  'w06-refused-no-date-of-birth',
  'w06-refused-a-date-of-birth-that-is-not-a-date',
  'refused-account-holder-under-18',
  'refused-guests-not-confirmed',
  'w06-refused-unknown-redemption-source',
  'w06-refused-membership-not-chosen',
  'refused-someone-elses-membership',
  'refused-no-membership-credit-left',
  'refused-a-credit-past-the-last-day',
  'w06-refused-pass-not-chosen',
  'refused-someone-elses-pass',
  'refused-no-pass-sessions-left',
  'refused-an-expired-pass',
  'refused-time-conflict',
  'w06-refused-a-session-with-no-band',
  'refused-private-price-not-set',
  'refused-private-price-pending',
  'refused-a-booking-that-day',
  'refused-session-full',
  'w06-refused-a-private-session-already-taken',
  'w06-refused-a-full-session-with-a-wrong-figure',
  'refused-pass-not-valid-for-the-band',
  'w06-refused-someone-elses-addon-credit',
  'w06-refused-addon-credit-not-herd-yet',
  'w06-refused-not-enough-addon-credit',
  // Stage 24: the cash figure, then the amount checks
  'w06-refused-cash-figure-changed',
  'w06-refused-cash-not-confirmed',
  'w06-refused-cash-but-nothing-owed',
  'w06-refused-something-owed-with-no-method',
]

/** The route keeps its answer against the request's key, refusals included: brief W06 item 5, W03-plan 2.6. */
export const IDEMPOTENCY_ROW: AllowedDifference = {
  name: 'The order route stores its answer against the Idempotency-Key',
  decision: 'Brief W06 item 5 (W03-plan 2.6)',
  path: /^\.tables\.api_idempotency$/,
}

/** order.create and order.paid, in the order's own transaction: brief W06 item 5, W03-plan 2.9. */
export const AUDIT_ROWS: AllowedDifference = {
  name: 'The order writes its audit rows in its own transaction',
  decision: 'Brief W06 item 5 (W03-plan 2.9)',
  path: /^\.tables\.audit_log$/,
}

/*
 * Named difference with no replay scenario: the credit gone at the claim.
 * - Old: when createBooking's guarded insert found no membership credit (createBooking.ts:445-451),
 *   it wrote the seat as paid, and on a saved card the customer was charged for it (W06 F2: £20 on
 *   a Core seat, staff told "Order completed").
 * - New: T1 refuses with insufficient_membership_credit (write-booking.ts, the guarded insert).
 * - Decision: W03-decisions, "W06 review calls" (lead, 8 Nov), from W06 F2.
 * - Why no scenario: under T1's period lock the facts see the credit gone first and refuse with the
 *   same reason, so a replay never reaches the guarded insert without a credit. Only a writer that
 *   takes no period lock (W05's uncancel() putting a cancelled credit booking back) could get there.
 * - Proof instead, in place-order.test.ts: "for the Worker step: the old createBooking when the
 *   credit has gone at the claim" (the old side charges £20), and "the guarded insert finds no credit
 *   after the place was taken: refused, not paid for" and "a credit period with nothing left:
 *   refused, not written as paid" (the new side).
 */

/** What each W06 scenario may differ by: a placed order has its audit rows, a refusal commits none. */
export function orderDifferences(placed: boolean): AllowedDifference[] {
  return placed ? [IDEMPOTENCY_ROW, AUDIT_ROWS] : [IDEMPOTENCY_ROW]
}

/**
 * One single-order scenario for each part W06 answers NOT_BUILT, and what it says is missing. Each
 * must answer that before anything is written.
 */
export const NOT_BUILT_SCENARIOS: Readonly<Record<string, readonly string[]>> = {
  'peak-member-pays-discounted-seat': ['card'],
  'session-pass-on-the-reader': ['reader', 'session_pass'],
  'membership-on-saved-card': ['card', 'membership'],
  'buy-new-pass-covers-the-seat': ['session_pass'],
  'refused-out-of-stock': ['products'],
  'gift-card-preset-in-cash': ['gift_card_purchase'],
  'event-with-a-guest-in-cash': ['event'],
  'promo-on-a-booking': ['promo_code'],
  'store-credit-covers-everything': ['products', 'store_credit'],
  'gift-card-and-cash': ['gift_card_redemption'],
  'q4-shipped-gift-card-earns-free-postage': ['gift_card_purchase'],
}
