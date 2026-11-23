/*
 * W64 (H-plan 3.3 step 3): the invariant lines the all-Worker sweep expects on a scenario, each exactly, with why. The
 * sweep holds every scenario's breaches to this list exactly, so a new breach fails and so does one that stops
 * happening. Three kinds:
 *  - a hold the Worker leaves for reconcile, named by the family that moved the action (the line is the hold itself,
 *    not an end state; the family's rule test runs reconcile on the same state and puts it right);
 *  - a state the scenario makes by hand (a booking cancelled with an UPDATE, no refund asked for), which no code made;
 *  - a charge that belongs to something other than an order, as decided (Q21's first invoice; W41's payment date charge).
 */

export interface NamedBreaches {
  lines: readonly string[]
  why: string
}

const R2D = "W20 (R2d): the card paid and its order couldn't be written, so the Add Guest change is held for reconcile; add-guest.test.ts runs reconcile on the same hold and it writes the order"
const REMOVE_HELD = "W22: Remove Guest's card part went and its store credit write failed, so its refund is held; remove-guest.test.ts runs reconcile and it records both"
const MOVE_CREDIT_HELD = "W24: a cheaper move's card part went and its store credit write failed (R2 held); move.test.ts runs reconcile on the same hold and it finishes it"
const MOVE_GIFT_CARD_HELD = "W24: a card move whose gift card row failed in C2 is held, the £6 card payment on no order yet; move.test.ts runs reconcile and it is put right"
const SETTLE_GIFT_CARD_HELD = "W19: Settle's gift card row failed after the card paid, so the change is held for reconcile; settle.test.ts runs reconcile on the same state and every line is put right"
const EVENT_HELD = "W30: the recording ends inside its own planted failure (the store credit write keeps failing), so R2 can't be saved and the claim is still held; the family's next test shows reconcile recording it"
// W65a: E2_TAP went. E2's tap after the cancel completed a cancelled PaymentIntent, which only the fake allowed (W35 row
// 3): £24 taken on no order. The fake now refuses it, as Stripe does, so E2 has no tap and no breach.
const CANCELLED_BY_HAND = 'The scenario cancels the booking itself with an UPDATE and asks for no refund (a state for the read or flag it tests): no code made it'
const FIRST_INVOICE = "Q21 (W13): a membership's first invoice belongs to its subscription, so no order names that PaymentIntent (replay/invariants.ts FIRST_INVOICE; the old code put it on the order in these three)"
const MISMATCH_LEFT = 'W03-plan 2.5 (W11): a reader payment that does not match its order is left for a person, the order pending with nothing confirmed (orders/reader.test.ts holds it)'
const PAYMENT_DATE_CHARGE = "W41 (F-plan 4.7): a payment date change's charge is the membership's own, recorded on its membership_payment_date_changes row and its membership.payment_date_changed rows, not on an order"
const PAYMENT_DATE_HELD = `${PAYMENT_DATE_CHARGE}; here the scenario stops the press after the charge (or its writes fail), so the change is held and never charged again (memberships/payment-date.test.ts runs reconcile on it)`

export const NAMED_BREACHES: Readonly<Record<string, NamedBreaches>> = {
  'w17-r2d-add-guest-press-dies-while-the-worker-charges-and-writes-no-order': {
    lines: ['w17-r2d-add-guest-press-dies-while-the-worker-charges-and-writes-no-order: price_paid £60.00, but £45.00 paid less £0.00 back', 'w17-r2d-add-guest-press-dies-while-the-worker-charges-and-writes-no-order: pi_fake_0004 is on 0 orders'],
    why: R2D,
  },
  'remove-guest-credit-fails-partway': {
    lines: ['remove-guest-credit-fails-partway: price_paid £40.00, but £60.00 paid less £0.00 back', 'remove-guest-credit-fails-partway: Stripe refunded £10.00, the rows say £0'],
    why: REMOVE_HELD,
  },
  'public-move-credit-fails-partway': {
    lines: ['public-move-credit-fails-partway: price_paid £25.00, but £51.00 paid less £15.00 back', 'public-move-credit-fails-partway: Stripe refunded £21.00, the rows say £15'],
    why: MOVE_CREDIT_HELD,
  },
  'private-move-credit-fails-partway': {
    lines: ['private-move-credit-fails-partway: price_paid £0.00, but £140.00 paid less £100.00 back', 'private-move-credit-fails-partway: Stripe refunded £110.00, the rows say £100'],
    why: MOVE_CREDIT_HELD,
  },
  'w05l-move-gift-card-row-fails-then-cancel': {
    lines: [
      'w05l-move-gift-card-row-fails-then-cancel: price_paid £51.00, but £40.00 paid less £0.00 back',
      'w05l-move-gift-card-row-fails-then-cancel: gift card 10000000-0000-4000-8000-000000000009 lost £5.00, its redemptions say £0.00',
      'w05l-move-gift-card-row-fails-then-cancel: pi_fake_0004 is on 0 orders',
    ],
    why: MOVE_GIFT_CARD_HELD,
  },
  'w05l-settle-gift-card-row-fails': {
    lines: [
      'w05l-settle-gift-card-row-fails: price_paid £20.00, but £0.00 paid less £0.00 back',
      'w05l-settle-gift-card-row-fails: gift card 10000000-0000-4000-8000-000000000009 lost £5.00, its redemptions say £0.00',
      'w05l-settle-gift-card-row-fails: pi_fake_0002 is on 0 orders',
    ],
    why: SETTLE_GIFT_CARD_HELD,
  },
  'w27-event-cancel-store-credit-fails-after-the-card-part': {
    lines: [
      'w27-event-cancel-store-credit-fails-after-the-card-part: Stripe refunded £50.00, the rows say £0',
      'w27-event-cancel-store-credit-fails-after-the-card-part: the places say £0.00 went to the card, Stripe refunded £50.00',
    ],
    why: EVENT_HELD,
  },
  'w48-addon-prep-read': { lines: ['w48-addon-prep-read: cancelled with £0.00 back on £40.00 paid'], why: CANCELLED_BY_HAND },
  'w48-gb17-a-cancelled-booking-and-a-payment-needed-one-are-checked-in': {
    lines: ['w48-gb17-a-cancelled-booking-and-a-payment-needed-one-are-checked-in: cancelled with £0.00 back on £20.00 paid'],
    why: CANCELLED_BY_HAND,
  },
  'w48-gb17-a-cancelled-bookings-waiver-is-changed': { lines: ['w48-gb17-a-cancelled-bookings-waiver-is-changed: cancelled with £0.00 back on £40.00 paid'], why: CANCELLED_BY_HAND },
  'w48-session-start-time-refused-booking-on-it': { lines: ['w48-session-start-time-refused-booking-on-it: cancelled with £0.00 back on £20.00 paid'], why: CANCELLED_BY_HAND },
  'q3-buy-new-pass-with-a-membership': { lines: ['q3-buy-new-pass-with-a-membership: pi_fake_0001 is on 0 orders'], why: FIRST_INVOICE },
  'w13-card-buy-new-pass-event-and-membership': { lines: ['w13-card-buy-new-pass-event-and-membership: pi_fake_0001 is on 0 orders'], why: FIRST_INVOICE },
  'w13-card-declined-then-retried': { lines: ['w13-card-declined-then-retried: pi_fake_0001 is on 0 orders'], why: FIRST_INVOICE },
  'w11-reader-amount-a-penny-over': { lines: ['w11-reader-amount-a-penny-over: pi_fake_0001 is on 0 orders'], why: MISMATCH_LEFT },
  'w36-payment-date-move-refused-and-the-charge-refunded': {
    lines: ['w36-payment-date-move-refused-and-the-charge-refunded: Stripe refunded £21.94, the rows say £0', 'w36-payment-date-move-refused-and-the-charge-refunded: pi_fake_0003 is on 0 orders'],
    why: `${PAYMENT_DATE_CHARGE}; the refused move's refund is on the same rows and watched (refund.watch)`,
  },
  'w36-fb3-payment-date-move-refused-and-the-refund-fails': { lines: ['w36-fb3-payment-date-move-refused-and-the-refund-fails: pi_fake_0003 is on 0 orders'], why: PAYMENT_DATE_HELD },
  'w36-fb1-payment-date-worker-dies-after-the-charge-then-pressed-again': { lines: ['w36-fb1-payment-date-worker-dies-after-the-charge-then-pressed-again: pi_fake_0003 is on 0 orders'], why: PAYMENT_DATE_HELD },
  'w36-fb2-payment-date-charged-and-moved-then-recording-fails': { lines: ['w36-fb2-payment-date-charged-and-moved-then-recording-fails: pi_fake_0003 is on 0 orders'], why: PAYMENT_DATE_HELD },
  'w36-fb2-payment-date-charged-and-moved-then-nothing-can-be-recorded': { lines: ['w36-fb2-payment-date-charged-and-moved-then-nothing-can-be-recorded: pi_fake_0003 is on 0 orders'], why: PAYMENT_DATE_HELD },
}
