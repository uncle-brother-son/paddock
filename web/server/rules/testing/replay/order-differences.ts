import type { AllowedDifference, Recording } from './compare'

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

/**
 * W07's replay: products, the delivery address and postage, session passes and gift cards bought, in
 * cash or with nothing owed. Existing scenarios W07 brings into scope come first, then W07's own.
 */
export const W07_SCENARIOS: readonly string[] = [
  'buy-new-pass-covers-the-seat',
  'gift-card-preset-in-cash',
  'refused-out-of-stock',
  'refused-no-method-chosen',
  'q4-shipped-gift-card-earns-free-postage',
  // Products
  'w07-pickup-product-in-cash',
  'w07-shipped-product-in-cash',
  'w07-shipped-and-pickup-products-in-cash',
  'w07-a-both-product-picked-up-needs-no-address',
  'w07-an-address-with-nothing-to-ship-is-not-kept',
  'w07-two-lines-of-one-variant-take-the-last-stock',
  'w07-the-last-item-in-stock',
  'w07-two-shipped-variants-reach-free-postage',
  'w07-member-price-on-a-product',
  'w07-variant-price-override',
  'w07-product-override-with-permission-in-cash',
  'w07-product-override-without-permission-is-ignored-in-cash',
  'w07-booking-and-products-in-cash',
  'w07-member-credit-seat-and-a-product',
  'w07-every-kind-in-cash',
  'w07-refused-product-quantity-zero',
  'w07-refused-product-quantity-not-whole',
  'w07-refused-unknown-variant',
  'w07-refused-inactive-product',
  'w07-refused-two-lines-over-the-stock',
  'w07-refused-product-checked-before-the-address',
  'w07-refused-a-full-session-before-the-stock',
  'w07-refused-a-changed-product-price-with-no-reason',
  // The delivery address
  'w07-refused-no-delivery-address',
  'w07-refused-delivery-address-missing-the-postcode',
  'w07-refused-delivery-address-missing-several-parts',
  'w07-delivery-address-trimmed-with-defaults',
  'w07-delivery-address-saved-to-the-customer',
  'w07-address-save-fails',
  // Postage
  'w07-refused-no-postage-method',
  'w07-refused-an-unknown-postage-method',
  'w07-refused-postage-settings-missing',
  'w07-free-standard-postage-exactly-at-the-threshold',
  'w07-express-postage-is-never-free',
  'w07-no-free-postage-when-the-threshold-is-0',
  'w07-q23-a-sent-price-cannot-earn-free-postage-in-cash',
  'w07-q23-a-sent-price-cannot-lose-free-postage-in-cash',
  'w07-q23-an-allowed-price-still-counts-in-cash',
  'w07-q4-shipped-gift-card-and-product-reach-free-postage',
  'w07-a-picked-up-gift-card-does-not-count-towards-postage',
  // Gift cards bought
  'w07-gift-card-custom-amount-picked-up-in-cash',
  'w07-gift-card-shipped-under-the-threshold',
  'w07-gift-card-blank-recipient-kept-as-sent',
  'w07-refused-gift-card-preset-and-custom',
  'w07-refused-gift-card-neither',
  'w07-refused-unknown-gift-card-preset',
  'w07-refused-inactive-gift-card-preset',
  'w07-refused-unknown-gift-card-type',
  'w07-refused-inactive-gift-card-type',
  'w07-refused-gift-card-custom-amount-not-allowed',
  'w07-refused-gift-card-amount-zero',
  'w07-refused-gift-card-no-amount',
  'w07-refused-gift-card-below-the-minimum',
  'w07-refused-gift-card-above-the-maximum',
  'w07-refused-gift-card-fulfilment',
  'w07-refused-postage-checked-before-the-gift-card',
  // Session passes
  'w07-pass-on-its-own-in-cash',
  'w07-buy-new-pass-covers-the-seat-alone',
  'w07-pass-bought-beside-a-paid-booking',
  'w07-pass-bought-beside-a-booking-on-another-pass',
  'w07-a-pass-with-no-price',
  'w07-a-pass-lasts-its-own-months',
  'w07-a-gift-card-lasts-its-types-months',
  'w07a-q33-pass-and-gift-card-bought-on-29-february',
  'w07-q5-buy-new-pass-keeps-address-and-requests',
  'w07-worst-basket',
  'w07-refused-unknown-pass-type',
  'w07-refused-inactive-pass-type',
  'w07-refused-buy-new-pass-not-chosen',
  'w07-refused-buy-new-pass-with-no-sessions',
  'w07-refused-buy-new-core-pass-on-peak',
  'w07-refused-buy-new-pass-on-a-private-booking',
  'w07-refused-buy-new-pass-session-full',
  'w07-refused-buy-new-pass-a-booking-that-day',
]

/**
 * W08's replay: events, in cash or with nothing owed, alone and beside every kind W06 and W07 build.
 * The existing scenario W08 brings into scope comes first, then W08's own.
 */
export const W08_SCENARIOS: readonly string[] = [
  'event-with-a-guest-in-cash',
  // Who attends, and at what price
  'w08-event-account-holder-alone-in-cash',
  'w08-event-guests-only-in-cash',
  'w08-event-account-holder-listed-second',
  'w08-event-attendee-details-trimmed',
  'w08-event-herd-member-and-a-guest',
  'w08-event-pre-herd-member',
  'w08-event-member-not-attending-guests-pay-public',
  'w08-event-members-only-for-a-member',
  'w08-event-members-only-member-on-their-last-day',
  'w08-event-members-first-member-before-release',
  'w08-event-members-first-public-after-release',
  'w08-event-account-holder-18-on-the-day',
  'w08-event-takes-the-last-places',
  'w08-free-event-nothing-owed',
  // Beside the other kinds
  'w08-event-and-a-booking-in-cash',
  'w08-member-credit-seat-and-an-event-in-cash',
  'w08-event-and-a-product-in-cash',
  'w08-every-kind-in-cash',
  'w08-worst-basket',
  // Stage 8: event_booking_block_reason's six
  'w08-refused-event-not-found',
  'w08-refused-event-cancelled',
  'w08-refused-event-not-on-sale',
  'w08-refused-event-started',
  'w08-refused-event-members-only',
  'w08-refused-event-members-only-lapsed-member',
  'w08-refused-event-not-released-yet',
  // Stage 8: the attendees, the ages, the 18+ tick and the quote
  'w08-refused-event-no-places',
  'w08-refused-event-attending-with-no-account-holder',
  'w08-refused-event-not-attending-with-an-account-holder',
  'w08-refused-event-two-account-holders',
  'w08-refused-event-attendee-with-no-name',
  'w08-refused-event-account-holder-with-no-date-of-birth',
  'w08-refused-event-date-of-birth-not-a-date',
  'w08-refused-event-account-holder-under-18',
  'w08-refused-event-guests-not-confirmed',
  'w08-refused-event-with-no-prices',
  // Stage 21: the places
  'w08-refused-event-sold-out',
  'w08-refused-event-one-place-left-for-two',
  // Where stages 8 and 21 come among the others, then stage 24
  'w08-refused-product-checked-before-the-event',
  'w08-refused-event-checked-before-the-address',
  'w08-refused-event-checked-before-the-addons',
  'w08-refused-event-checked-before-the-booking',
  'w08-refused-a-full-session-before-a-sold-out-event',
  'w08-refused-out-of-stock-before-a-sold-out-event',
  'w08-refused-sold-out-event-with-a-wrong-figure',
  'w08-refused-event-cash-figure-changed',
  'w08-refused-event-owed-with-no-method',
]

/**
 * W09's replay: promo codes, store credit and gift cards used to pay, in cash or with nothing owed,
 * alone and beside every kind W06 to W08 build. The existing scenarios W09 brings into scope come
 * first, then W09's own.
 */
export const W09_SCENARIOS: readonly string[] = [
  'store-credit-covers-everything',
  'gift-card-and-cash',
  'promo-on-a-booking',
  'promo-on-a-standalone-addon',
  'promo-on-a-product',
  'promo-on-a-pass',
  'promo-on-an-event',
  'refused-an-expired-promo',
  'refused-store-credit-over-the-total',
  'q24-percent-promo-on-a-private-booking',
  'q24-fixed-promo-on-a-private-booking',
  'q24-fixed-promo-bigger-than-the-private-price',
  'q24-attached-addon-stays-out-of-the-promo',
  'q24-the-member-prices-flag-does-not-apply',
  'q24-min-spend-counts-the-private-price',
  'q24-refused-below-min-spend',
  'q24-refused-a-code-not-for-bookings',
  'q24-refused-an-expired-code',
  // W09's own
  'w09-fixed-promo-spread-across-three-seats',
  'w09-fixed-promo-spread-across-event-places',
  'w09-fixed-promo-on-a-member-place-and-a-guest',
  'w09-fixed-promo-skips-a-member-place',
  'w09-promo-skips-a-member-priced-seat',
  'w09-promo-on-a-guest-beside-a-credit-seat',
  'w09-promo-on-a-buy-new-pass-and-its-guest',
  'w09-promo-skips-a-member-priced-addon',
  'w09-percent-promo-on-every-kind-in-cash',
  'w09-fixed-promo-spread-across-every-kind',
  'w09-promo-covers-everything-nothing-owed',
  'w09-promo-does-not-touch-free-postage',
  'w09-promo-does-not-touch-postage',
  'w09-promo-typed-in-lower-case-with-spaces',
  'w09-promo-with-a-use-left',
  'w09-promo-once-per-customer-used-by-someone-else',
  'w09-promo-for-this-customer',
  'w09-promo-on-its-last-day',
  'w09-refused-unknown-promo',
  'w09-refused-inactive-promo',
  'w09-refused-promo-at-its-limit',
  'w09-refused-promo-already-used-by-the-customer',
  'w09-refused-promo-for-another-customer',
  'w09-refused-promo-nothing-eligible',
  'w09-refused-promo-below-min-spend',
  'w09-refused-promo-after-the-stock',
  'w09-refused-a-full-session-before-the-promo',
  'w09-refused-promo-before-the-event-places',
  'w09-refused-buy-new-promo-before-the-booking',
  'w09-refused-promo-cash-figure-changed',
  'w09-refused-promo-owed-with-no-method',
  'w09-store-credit-and-cash',
  'w09-store-credit-uses-the-whole-balance',
  'w09-refused-store-credit-amount-zero',
  'w09-refused-store-credit-amount-negative',
  'w09-refused-store-credit-more-than-the-balance',
  'w09-refused-store-credit-for-a-customer-with-none',
  'w09-refused-store-credit-with-nothing-owed',
  'w09-refused-store-credit-checked-before-the-booking',
  'w09-refused-store-credit-leaves-something-owed-with-no-method',
  'w09-refused-cash-figure-before-the-store-credit-over-the-total',
  'w09-gift-card-covers-everything',
  'w09-gift-card-uses-the-whole-balance',
  'w09-gift-card-already-marked-redeemed-stays-so',
  'w09-gift-card-on-its-last-day',
  'w09-refused-gift-card-amount-zero',
  'w09-refused-gift-card-not-found',
  'w09-refused-gift-card-voided',
  'w09-refused-gift-card-expired',
  'w09-refused-gift-card-with-nothing-left',
  'w09-refused-gift-card-more-than-its-balance',
  'w09-refused-gift-card-over-the-total',
  'w09-refused-gift-card-checked-before-store-credit',
  'w09-refused-method-checked-before-the-gift-card',
  'w09-refused-a-gift-card-bought-in-the-same-basket',
  'w09-refused-cash-figure-before-the-gift-card-over-the-total',
  'w09-gift-card-and-store-credit-cover-everything',
  'w09-gift-card-store-credit-and-cash',
  'w09-exact-cover-gift-card-and-store-credit',
  'w09-exact-cover-ninety-five-and-five-pence',
  'w09-half-penny-store-credit',
  'w09-half-penny-store-credit-covers-it',
  'w09-half-penny-price-in-cash',
  'w09-every-part-in-cash',
  'w09-worst-basket',
  // Brief W09a (W09 review S1): a customer with an address on file
  'w09a-saved-address-with-no-second-line-replaces-one-with-it',
  'w09a-store-credit-alone-leaves-the-address-on-file',
]

/**
 * W10's replay: the saved card. Existing single-order card scenarios first (W06 to W09 answered
 * NOT_BUILT for them), then W10's own: every kind T1 takes on the card, alone and with a gift card,
 * store credit and a promo, then declined, needing authentication and with no saved card.
 */
export const W10_CHARGED: readonly string[] = [
  'saved-card-product-gift-card-store-credit',
  'peak-member-pays-discounted-seat',
  'standalone-addon-at-member-price',
  'pickup-and-shipped-products-standard-postage',
  'shipped-product-over-threshold-is-free',
  'shipped-product-express-postage',
  'gift-card-custom-amount-on-card',
  'fixed-promo-spread-across-a-basket',
  'override-with-permission',
  'override-without-permission-is-ignored',
  'q23-a-sent-price-cannot-earn-free-postage',
  'q23-a-sent-price-cannot-lose-free-postage',
  'q23-an-allowed-price-still-counts',
  'q24-fixed-promo-on-private-and-other-items',
  'q24-percent-promo-on-private-and-other-items',
  'q24-promo-with-gift-card-and-store-credit',
  'w10-card-public-booking-with-an-addon',
  'w10-card-private-booking',
  'w10-card-member-credit-seat-paid-guest-and-addon-credit',
  'w10-card-pass-seat-and-a-paid-guest',
  'w10-card-standalone-addons',
  'w10-card-products-picked-up',
  'w10-card-shipped-product-address-saved',
  'w10-card-pass-alone',
  'w10-card-buy-new-pass-booking',
  'w10-card-gift-card-digital',
  'w10-card-gift-card-shipped',
  'w10-card-event-with-guests',
  'w10-card-every-kind',
  'w10-card-with-a-gift-card',
  'w10-card-with-store-credit',
  'w10-card-with-a-promo-code',
  'w10-card-with-all-three',
  'w10-card-worst-basket',
  'w10-card-gift-card-uses-its-whole-balance',
]

/** The card refused: T1 committed, the undo gave it all back. */
export const W10_REFUSED_AT_THE_CHARGE: readonly string[] = [
  'saved-card-declined-rolls-back',
  'q24-card-declined-rolls-back',
  'w10-declined-every-kind-with-all-three',
  'w10-declined-worst-basket',
  'w10-declined-gift-card-used-up',
  'w10-declined-member-credit-and-addon-credit',
  'w10-declined-pass-seat',
  'w10-declined-buy-new-pass-booking',
  'w10-declined-private-booking',
  'w10-authentication-needed',
  'w10-authentication-needed-with-store-credit',
]

export const W10_SCENARIOS: readonly string[] = [
  ...W10_CHARGED,
  ...W10_REFUSED_AT_THE_CHARGE,
  // No saved card: refused inside T1, before Stripe, as createOrder's route refused it.
  'w10-no-saved-card',
  // The card chosen with nothing left for it: no Stripe call, finished in T1.
  'w10-card-chosen-with-nothing-left-to-charge',
  // An unclear answer: createOrder rolled back; the Worker holds the order (OUTCOME_DIFFERS).
  'w10-unclear-answer',
]

/**
 * W11's replay: the reader, through createOrder and then finaliseReaderOrder or cancelReaderOrder on
 * the old side, and the order route and then the finalise or cancel route on the new. Existing reader
 * scenarios first (W06 to W10 answered NOT_BUILT for them), then W11's own.
 */
/** Tapped and finalised (or left pending), the order kept: its pending record differs by design. */
export const W11_KEPT: readonly string[] = [
  'reader-booking-then-finalise',
  'q24-promo-on-the-reader',
  'session-pass-on-the-reader',
  'w11-reader-public-booking-with-an-addon',
  'w11-reader-private-booking',
  'w11-reader-member-credit-seat-paid-guest-and-addon-credit',
  'w11-reader-pass-seat-and-a-paid-guest',
  'w11-reader-standalone-addons',
  'w11-reader-products-picked-up',
  'w11-reader-shipped-product-address-saved',
  'w11-reader-pass-alone',
  'w11-reader-buy-new-pass-booking',
  'w11-reader-gift-card-digital',
  'w11-reader-gift-card-shipped',
  'w11-reader-event-with-guests',
  'w11-reader-every-kind',
  'w11-reader-with-a-gift-card',
  'w11-reader-with-store-credit',
  'w11-reader-with-a-promo-code',
  'w11-reader-with-all-three',
  'w11-reader-worst-basket',
  'w11-reader-gift-card-uses-its-whole-balance',
  'w11-reader-save-card-reusable',
  'w11-reader-save-card-simulated-reader',
  'w11-reader-save-card-with-all-three',
  'w11-reader-new-stripe-customer',
  'w11-reader-new-stripe-customer-saves-the-card',
  'w11-reader-cancel-finds-it-paid',
  'w11-reader-cancel-finds-it-paid-and-saves-the-card',
  'w11-reader-amount-mismatch-a-pound-short',
  'w11-reader-finalise-twice',
]

/** No tap: cancelled, and the undo gave everything back. */
export const W11_CANCELLED: readonly string[] = [
  'w11-reader-cancelled-public-booking-with-an-addon',
  'w11-reader-cancelled-every-kind-with-all-three',
  'w11-reader-cancelled-worst-basket',
  'w11-reader-cancelled-gift-card-used-up',
  'w11-reader-cancelled-member-credit-and-addon-credit',
  'w11-reader-cancelled-pass-seat',
  'w11-reader-cancelled-buy-new-pass-booking',
  'w11-reader-cancelled-private-booking',
  'w11-reader-cancelled-event',
  'w11-reader-cancel-twice',
  'w11-reader-finalise-before-the-tap-then-cancel',
  'w11-reader-cancelled-then-finalised-late',
]

export const W11_SCENARIOS: readonly string[] = [
  ...W11_KEPT,
  ...W11_CANCELLED,
  // The intent refused, or no Stripe customer could be made: T1 committed, the undo gave it all back.
  'w11-reader-intent-refused',
  'w11-reader-stripe-customer-not-made',
  // Nothing left for the reader: refused inside T1, as createOrder refused it.
  'w11-reader-nothing-to-charge',
  // Outcomes a decision changes (OUTCOME_DIFFERS), each with its own test.
  'w11-reader-amount-a-penny-over',
  'w11-reader-intent-unclear',
]

/**
 * W13's replay: memberships. The existing scenarios W06 to W12 answered NOT_BUILT for (on the saved card,
 * on the reader, and in cash, which T1 refuses as createOrder did), then W13's own (w13-*).
 */
export const W13_EXISTING: readonly string[] = [
  'membership-on-saved-card',
  'yearly-membership-on-saved-card',
  'membership-on-the-reader',
  'event-at-member-price-with-a-new-membership',
  'promo-on-a-membership',
  'spill-onto-a-membership',
  'buy-new-membership-covers-the-seat',
  'buy-new-membership-on-peak-pays-the-seat',
  'q1-postage-before-the-spill',
  'q2-standalone-addon-before-the-spill',
  'q3-buy-new-membership-with-a-pass',
  'q3-buy-new-pass-with-a-membership',
  'q3-reader-buy-new-membership-with-a-pass',
  'q3-reader-buy-new-pass-with-a-membership',
  'q5-buy-new-keeps-address-and-requests',
  'q6-promo-on-buy-new-seats',
  'replace-an-exhausted-membership',
  'refused-exhausted-membership-not-found',
  'refused-exhausted-membership-cancelled',
  'refused-exhausted-membership-past-its-last-day',
  'q24-big-fixed-promo-on-private-and-a-membership',
  'w08-event-with-a-membership-bought-in-cash',
  'w09-promo-with-a-membership-bought-in-cash',
]

/** W13's own, recorded from the old functions (scenarios.ts, w13Scenarios). */
export const W13_OWN: readonly string[] = [
  'w13-card-all-access-monthly',
  'w13-card-all-access-yearly-buy-new-on-peak',
  'w13-card-membership-and-products',
  'w13-card-yearly-and-a-shipped-product',
  'w13-card-membership-with-a-gift-card',
  'w13-card-membership-covered-by-gift-card-and-store-credit',
  'w13-card-promo-and-spill',
  'w13-card-buy-new-membership-with-a-guest-and-an-addon',
  'w13-card-replace-exhausted-with-a-paid-guest',
  'w13-card-buy-new-pass-event-and-membership',
  'w13-card-subscription-declined',
  'w13-card-charge-declined-after-the-subscription',
  'w13-card-old-cancel-refused',
  'w13-card-stripe-price-differs',
  'w13-card-stripe-price-archived',
  'w13-card-subscription-unclear',
  'w13-card-declined-then-retried',
  'w13-reader-membership',
  'w13-reader-all-access-yearly',
  'w13-reader-membership-products-and-store-credit',
  'w13-reader-buy-new-membership-with-a-guest',
  'w13-reader-replace-an-exhausted-membership',
  'w13-reader-buy-new-pass-event-and-membership',
  'w13-reader-card-not-reusable',
  'w13-reader-membership-cancelled',
  'w13-reader-buy-new-membership-cancelled',
  'w13-reader-old-cancel-refused',
]

export const W13_SCENARIOS: readonly string[] = [...W13_EXISTING, ...W13_OWN]

/** Every scenario the order route takes. */
export const ORDER_SCENARIOS: readonly string[] = [...W06_SCENARIOS, ...W07_SCENARIOS, ...W08_SCENARIOS, ...W09_SCENARIOS, ...W10_SCENARIOS, ...W11_SCENARIOS, ...W13_SCENARIOS]

const Q4 = 'W03-decisions Q4'
const Q5 = 'W03-decisions Q5'
const ADDRESS_IN_T1 = 'Brief W07 item 2 (the delivery address is saved inside T1)'
const Q33 = 'W03-decisions Q33'
const Q9 = 'W03-decisions Q9'

/** Q9: what orders.payment_method records, where createOrder recorded something else. */
function q9Method(was: string, now: string): AllowedDifference[] {
  return [
    { name: `The order records ${now} where createOrder recorded ${was}`, decision: Q9, path: /^\.tables\.orders\.added\[0\]\.payment_method$/ },
    { name: `The answer names ${now} where createOrder named ${was}`, decision: Q9, path: /^\.results\[0\]\.paymentMethodUsed$/ },
  ]
}

/** Q4: a shipped gift card counts towards free postage, so the order charges none. `postageLine` is its index. */
function freePostage(postageLine: number): AllowedDifference[] {
  return [
    { name: 'No postage on the order total', decision: Q4, path: /^\.tables\.orders\.added\[0\]\.order_total$/ },
    { name: 'No postage on the postage line', decision: Q4, path: new RegExp(`^\\.tables\\.order_line_items\\.added\\[${postageLine}\\]\\.(unit_price|line_total)$`) },
    { name: 'No postage in the cash taken', decision: Q4, path: /^\.results\[0\]\.cardAmount$/ },
  ]
}

/** Q5: a buy-new booking's order keeps the delivery address the old one dropped. */
const ADDRESS_KEPT: AllowedDifference = { name: "The buy-new order keeps its delivery address", decision: Q5, path: /^\.tables\.orders\.added\[0\]\.shipping_address$/ }
/** Q5: and the booking its special requests. */
const REQUESTS_KEPT: AllowedDifference = { name: 'The buy-new booking keeps its special requests', decision: Q5, path: /^\.tables\.bookings\.added\[0\]\.special_requests$/ }

/**
 * W07's and W09's named differences, beyond the idempotency row and the audit rows. Each names its decision;
 * anything else fails, and so does an entry that stops happening. Q23 needs none: W05a fixed the old
 * createOrder too, and its cash scenarios match exactly. Gift card codes need none in the replay: the
 * comparator labels every code (compare.ts), and place-order.test.ts holds the new codes to the format.
 */
export const W07_DIFFERENCES: Readonly<Record<string, readonly AllowedDifference[]>> = {
  'q4-shipped-gift-card-earns-free-postage': freePostage(1),
  'w07-q4-shipped-gift-card-and-product-reach-free-postage': freePostage(2),
  'w07-q5-buy-new-pass-keeps-address-and-requests': [ADDRESS_KEPT, REQUESTS_KEPT],
  'w07-worst-basket': [ADDRESS_KEPT],
  'w07a-q33-pass-and-gift-card-bought-on-29-february': [
    { name: "A pass bought on 29 Feb ends on the next year's 28 Feb, not 1 Mar", decision: Q33, path: /^\.tables\.customer_session_passes\.added\[0\]\.expiry_date$/ },
    { name: "A gift card bought on 29 Feb ends on the next year's 28 Feb, not 1 Mar", decision: Q33, path: /^\.tables\.gift_cards\.added\[0\]\.expiry_date$/ },
  ],
  'w07-address-save-fails': [
    {
      name: 'A failed address save refuses the whole order (nothing kept) instead of warning after a paid order',
      decision: ADDRESS_IN_T1,
      path: /^\.results\[0\](\.|$)|^\.tables\.(orders|order_line_items|product_variants|stock_adjustments)$/,
    },
  ],
  // W09, Q9: store credit alone records store_credit (createOrder: none); a gift card with store credit records split (createOrder: gift_card).
  'store-credit-covers-everything': q9Method('none', 'store_credit'),
  'w09-half-penny-store-credit-covers-it': q9Method('none', 'store_credit'),
  'w09-gift-card-and-store-credit-cover-everything': q9Method('gift_card', 'split'),
  'w09-exact-cover-gift-card-and-store-credit': q9Method('gift_card', 'split'),
  'w09-exact-cover-ninety-five-and-five-pence': q9Method('gift_card', 'split'),
  'w09a-store-credit-alone-leaves-the-address-on-file': q9Method('none', 'store_credit'),
}

const KEYS = 'Checklist 3 and W5-15 (W03-plan 2.5: Stripe keys from the order id, metadata.order_id)'
const PENDING_RECORD = 'W03-plan 2.5 (the pending record is the order itself, kept in orders.reader_payment)'

/** W10: the charge carries the order's key and names its order, where createOrder's had neither. */
const CHARGE_KEY_AND_ORDER: readonly AllowedDifference[] = [
  { name: "The charge carries the order's key, <orderId>:charge", decision: KEYS, path: /^\.stripeCalls\[0\]\.idempotencyKey$/ },
  { name: 'The charge names its order in metadata.order_id', decision: KEYS, path: /^\.stripeCalls\[0\]\.params\.metadata$/ },
]
/** W10: the paid card order keeps the pending record T1 wrote before the charge. */
const PENDING_RECORD_KEPT: AllowedDifference = { name: 'The paid card order keeps its pending record', decision: PENDING_RECORD, path: /^\.tables\.orders\.added\[0\]\.reader_payment$/ }
/** W10: T1 committed before the charge, so the refused order's create and undo are both on record (W03-decisions Q20). */
const UNDO_AUDIT_ROWS: AllowedDifference = { ...AUDIT_ROWS, name: 'The refused card order is recorded as created and undone', decision: 'W03-plan 2.9 and W03-decisions Q20' }

/** W10's named differences, by scenario. */
export const W10_DIFFERENCES: Readonly<Record<string, readonly AllowedDifference[]>> = {
  ...Object.fromEntries(W10_CHARGED.map((name) => [name, [...CHARGE_KEY_AND_ORDER, PENDING_RECORD_KEPT]])),
  ...Object.fromEntries(W10_REFUSED_AT_THE_CHARGE.map((name) => [name, [...CHARGE_KEY_AND_ORDER, UNDO_AUDIT_ROWS]])),
  // A gift card with store credit records split (Q9), where createOrder recorded gift_card.
  'w10-card-chosen-with-nothing-left-to-charge': q9Method('gift_card', 'split'),
  // createOrder took a 500 as a decline and rolled back; the Worker retries once with the same key, then
  // holds the order pending with its claims (its own test in order-replay.test.ts says exactly what).
  'w10-unclear-answer': [
    {
      name: 'An unclear answer is held pending, never undone, after one retry with the same key',
      decision: 'W03-plan 2.5 (reading Stripe\'s answers)',
      path: /^\.results\[0\](\.|$)|^\.stripeCalls(\[|$)|^\.tables\.(orders|order_line_items|bookings|booking_guests|sessions|customers|store_credit_transactions|audit_log)$/,
    },
  ],
}

/** W11: the reader's intent carries the order's key, at its place among the Stripe calls. */
const readerIntentKey = (index: number): AllowedDifference => ({
  name: "The reader's intent carries the order's key, <orderId>:reader-intent",
  decision: KEYS,
  path: new RegExp(`^\\.stripeCalls\\[${index}\\]\\.idempotencyKey$`),
})
/** W11: a Stripe customer made for the reader carries the customer's key (W10's ensureStripeCustomer). */
const STRIPE_CUSTOMER_KEY: AllowedDifference = {
  name: "A Stripe customer is made under the customer's key, <customerId>:stripe-customer, so a retry can't make a second",
  decision: 'Brief W10 (ensureStripeCustomer) and W03-plan 2.5 (keys)',
  path: /^\.stripeCalls\[1\]\.idempotencyKey$/,
}
/** W11: the reader order's pending record is the old snapshot's superset (method, channel, Stripe customer, request id; W11a: the intent's mode). */
const READER_RECORD: AllowedDifference = {
  name: "The reader order's pending record is the old snapshot's superset: method, channel, Stripe customer, request id, the intent's Stripe mode (livemode, W11a) and the booking as T1 wrote it (held_booking, W12) added; the stock ledger and the event booking found through the order's own rows, not ids kept in it",
  decision: `${PENDING_RECORD}; W03-decisions "W11 review calls" (L1); brief W12 item 1 (W10 review L1)`,
  path: /^\.tables\.orders\.added\[0\]\.reader_payment\.(method|channel|stripe_customer_id|request_id|livemode|held_booking|stock_adjustment_ids|event_booking_id)$/,
}
/** W11, Q9: a gift card beside the reader records split, where finaliseReaderOrder wrote reader. */
const Q9_READER: AllowedDifference = {
  name: 'A gift card beside the reader records split, where finaliseReaderOrder recorded reader',
  decision: Q9,
  path: /^\.tables\.orders\.added\[0\]\.payment_method$/,
}
/** W11: cancel that finds the payment taken finalises with the PaymentIntent it has just read, where cancelReaderOrder had finalise read it again. */
const ONE_READ_FEWER: AllowedDifference = {
  name: 'Cancel finding the payment taken finalises with the PaymentIntent it has just read: one read fewer',
  decision: 'Brief W11 item 6 (finalise and cancel well inside Retool\'s 60 s)',
  path: /^\.stripeCalls(\[[23]\]|$)/,
}
const READER_WITH_A_GIFT_CARD = new Set([
  'w11-reader-with-a-gift-card',
  'w11-reader-with-all-three',
  'w11-reader-worst-basket',
  'w11-reader-gift-card-uses-its-whole-balance',
  'w11-reader-save-card-with-all-three',
  'w11-reader-cancel-finds-it-paid-and-saves-the-card',
])
const NEW_STRIPE_CUSTOMER = new Set(['w11-reader-new-stripe-customer', 'w11-reader-new-stripe-customer-saves-the-card'])

/** W11's named differences, by scenario. */
export const W11_DIFFERENCES: Readonly<Record<string, readonly AllowedDifference[]>> = {
  ...Object.fromEntries(
    W11_KEPT.map((name) => [
      name,
      [
        ...(NEW_STRIPE_CUSTOMER.has(name) ? [STRIPE_CUSTOMER_KEY, readerIntentKey(2)] : [readerIntentKey(0)]),
        READER_RECORD,
        ...(READER_WITH_A_GIFT_CARD.has(name) ? [Q9_READER] : []),
        ...(name.startsWith('w11-reader-cancel-finds-it-paid') ? [ONE_READ_FEWER] : []),
      ],
    ])
  ),
  ...Object.fromEntries(W11_CANCELLED.map((name) => [name, [readerIntentKey(0)]])),
  'w11-reader-intent-refused': [readerIntentKey(0), UNDO_AUDIT_ROWS],
  'w11-reader-stripe-customer-not-made': [STRIPE_CUSTOMER_KEY, UNDO_AUDIT_ROWS],
  // finaliseReaderOrder let a penny either way through; the Worker checks to the penny (W03-plan 2.7):
  // the order stays pending, and finalise answers amount_mismatch. Its own test says exactly what.
  'w11-reader-amount-a-penny-over': [
    {
      name: 'A payment a penny off is not finalised: checked to the exact penny',
      decision: 'W03-plan 2.7 (the reader: finalise tightens from 1p tolerance to exact pence)',
      path: /^\.results\[1\](\.|$)|^\.stripeCalls\[0\]\.idempotencyKey$|^\.tables\.(orders|event_bookings|customers)(\.|$)/,
    },
  ],
  // createOrder took a 500 as a refusal and rolled back; the Worker sends it once more with the same key,
  // then holds the order pending with its claims (its own test in order-replay.test.ts says exactly what).
  'w11-reader-intent-unclear': [
    {
      name: "An unclear answer to the reader's intent is held pending, never undone, after one retry with the same key",
      decision: "W03-plan 2.5 (reading Stripe's answers)",
      path: /^\.results\[0\](\.|$)|^\.stripeCalls(\[|$)|^\.tables\.(orders|order_line_items|addon_order_lines|bookings|booking_guests|sessions|customers|store_credit_transactions|audit_log)$/,
    },
  ],
}

/**
 * Where a decision changes the figure staff confirm, the new side is sent the figure its screen would
 * show (from W14, the quote's): the same basket with the old figure is refused as a changed total.
 */
export const NEW_SIDE_CONFIRMS: Readonly<Record<string, { toCollect: number; decision: string }>> = {
  'q4-shipped-gift-card-earns-free-postage': { toCollect: 60, decision: Q4 },
  'w07-q4-shipped-gift-card-and-product-reach-free-postage': { toCollect: 50, decision: Q4 },
}

/** Scenarios whose outcome itself differs by decision: the new side's answer is checked by its own test. */
export const OUTCOME_DIFFERS: readonly string[] = [
  'w07-address-save-fails',
  'w10-unclear-answer',
  'w11-reader-amount-a-penny-over',
  'w11-reader-intent-unclear',
  // W13: each with its own test; the reader's Q3 the other way round (createOrder failed at finalise and refunded).
  'w13-card-stripe-price-differs',
  'w13-card-stripe-price-archived',
  'w13-card-subscription-unclear',
  'w13-card-declined-then-retried',
  'q3-reader-buy-new-pass-with-a-membership',
  'w13-reader-buy-new-pass-event-and-membership',
]

/*
 * Named differences with no replay scenario (W07):
 * - A gift card's code is drawn from the platform's cryptographic generator, not Math.random, in the
 *   same format (gift-card-code.ts). Codes are labelled in every recording, so no scenario shows it.
 * - gift_card_code_exhausted now comes after the cash figure is checked. createOrder issued the card
 *   (stage 22) before it checked the cash (stage 24); T1 checks every figure before it writes. Both
 *   only differ when five codes in a row are taken and the cash figure is wrong as well. Proof of the
 *   exhaustion itself: place-order.test.ts, "gift card codes".
 * - A database failure writing the gift card answers INTERNAL with the safe words (W03-plan 2.9's
 *   deliberate difference for unexpected_error), where createOrder answered gift_card_creation_failed
 *   with the database's own text. Proof: place-order.test.ts, B11's gift card row.
 * - Within T1 the stock is claimed once per variant for every line of it, not once per line; the
 *   ledger still has a row per line, and the stock ends the same (W07 brief item 1).
 */

/*
 * Named differences with no replay scenario (W09). A replay is one connection, so it can't race:
 * - createOrder's stage 25a counted a promo's uses after inserting its own, and refused a code that had
 *   just reached its limit with "has just reached its maximum number of uses (N)" or "this customer has
 *   just used it in another order" (and refused both orders when two raced for the last use). T1 locks
 *   the code before it counts (W03-plan 2.4 item 1), so the second order waits and is refused by the
 *   facts, with the ordinary "Promo code \"X\" cannot be used: …" words. Proof: place-order-postgres.test.ts,
 *   "the last use of a promo code (W09)".
 * - createOrder's stage 30 refused a store credit or gift card balance spent between its check and its
 *   claim at stage `payment`. Under T1's locks the facts see it first and refuse at stage `validation`,
 *   with the same reason and words. The claims' own refusals (stage `payment`) remain, for what the locks
 *   should make impossible. Proof: place-order-postgres.test.ts, "a store credit balance spent by another
 *   order at the same time (W09)", "a gift card balance spent elsewhere (W09)"; place-order.test.ts, "the
 *   claims refuse on their own".
 * - promo_booking_price_changed can't happen: T1 writes a buy-new booking's seats from the very quote the
 *   promo was spread on, under the session lock, in one transaction.
 */

/** What each scenario may differ by: a placed order has its audit rows, a refusal commits none. W13 reads its golden file too. */
export function orderDifferences(placed: boolean, name?: string, golden?: Recording): AllowedDifference[] {
  return [
    ...(placed ? [IDEMPOTENCY_ROW, AUDIT_ROWS] : [IDEMPOTENCY_ROW]),
    ...((name && W07_DIFFERENCES[name]) || []),
    ...((name && W10_DIFFERENCES[name]) || []),
    ...((name && W11_DIFFERENCES[name]) || []),
    ...(name && golden && W13_SCENARIOS.includes(name) ? w13Differences(name, golden) : []),
  ]
}

// --- W13

const Q8 = 'W03-decisions Q8'
const MEMBERSHIP_KEYS = `${KEYS}; the coupon's fixed id order-<orderId> (W03-plan 2.5, bug 13)`

/**
 * W13: the Stripe calls are held to the old ones call by call in their own test (order-replay.test.ts, "W13:
 * the Stripe calls"), where the order of the steps differs by decision (Q8: the old subscription cancelled
 * last; the reader's price checked before the tap and again before the subscription; the compensation's
 * refunds keyed). Elsewhere, only the keys, `metadata.order_id` and the coupon's fixed id differ.
 */
const STRIPE_CALLS_BY_THEIR_OWN_TEST: AllowedDifference = {
  name: "The membership's Stripe calls, compared call by call in their own test (steps in the Worker's order, keys, metadata.order_id, the coupon's fixed id)",
  decision: `${MEMBERSHIP_KEYS}; ${Q8}; brief W13 items 1 to 4`,
  path: /^\.stripeCalls(\[|$)/,
}
const CALL_KEYS: AllowedDifference = { name: "Every money call carries the order's key (<orderId>:coupon, :subscription, :charge)", decision: MEMBERSHIP_KEYS, path: /^\.stripeCalls\[\d+\]\.idempotencyKey$/ }
const CALL_ORDER_ID: AllowedDifference = { name: 'The coupon, the subscription and the charge name their order (metadata.order_id)', decision: MEMBERSHIP_KEYS, path: /^\.stripeCalls\[\d+\]\.params\.metadata(\.order_id)?$/ }
const COUPON_ID: AllowedDifference = { name: "The coupon's fixed id, order-<orderId>, and the subscription naming it", decision: MEMBERSHIP_KEYS, path: /^\.stripeCalls\[\d+\]\.params\.(id|discounts\[0\]\.coupon)$/ }
const MEMBERSHIP_RECORD: AllowedDifference = {
  name: "The membership order's pending record: W10's and W11's fields, and the membership's (what the subscription needs, the reader finalise's start of it (W13a B1), and the subscription once made); none of the old reader snapshot's idempotency_key or stock ids",
  decision: `${PENDING_RECORD}; brief W13 item 1; brief W13a item 1 (B1a)`,
  path: /^\.tables\.orders\.added\[0\]\.reader_payment(\.(method|channel|stripe_customer_id|request_id|livemode|held_booking|stock_adjustment_ids|event_booking_id|replaces_membership_id|exhausted_membership_previous|membership\.(addons_included|coupon_amount|coupon_name|first_invoice|stripe_price_id|idempotency_key|subscription_id|subscription_payment_intent_id|subscription_started_at|subscription_started_by)))?$/,
}
const Q1 = 'W03-decisions Q1'
const Q2 = 'W03-decisions Q2'
const Q3 = 'W03-decisions Q3'

/** A broad allowance for a scenario whose outcome a decision changes, with its own test saying exactly what. */
const decided = (name: string, decision: string, path: RegExp): AllowedDifference => ({ name, decision, path })

/** Q1 and Q2: the spill counts postage and standalone add-ons, so the first payment is bigger and the coupon smaller. */
const spillFixed = (decision: string): AllowedDifference[] => [
  { name: 'The card pays what the screen showed: the first invoice is larger by what the spill used to skip', decision, path: /^\.results\[0\]\.(cardAmount|membershipAmountPaid)$/ },
  { name: 'and the first-invoice coupon smaller by the same', decision, path: /^\.stripeCalls\[\d+\]\.params\.amount_off$/ },
]

/** Q3: a buy-new membership booking with a pass chosen as well: the pass is written (its line and its row), where createOrder charged for it and wrote neither. */
const Q3_PASS_WRITTEN: AllowedDifference = {
  name: 'The pass bought beside a buy-new membership is written: its line and its row (createOrder charged for it and wrote neither)',
  decision: Q3,
  path: /^\.results\[0\]\.sessionPassId$|^\.tables\.(customer_session_passes|order_line_items)(\.|$)/,
}
/**
 * Q3 the other way: a buy-new pass booking with a membership chosen as well: the membership is sold (its
 * line, its row, its subscription and credit period), where createOrder charged the pass alone (on the
 * card) or failed at finalise and refunded the tap (on the reader). Its own test says exactly what.
 */
const Q3_MEMBERSHIP_WRITTEN: AllowedDifference = {
  name: 'The membership bought beside a buy-new pass booking is sold: its line, row, subscription and credit period (createOrder sold the pass alone, or failed and refunded on the reader)',
  decision: Q3,
  path: /^\.results(\[|$)|^\.stripeCalls(\[|$)|^\.tables\./,
}
const Q3_BOTH_WAYS = new Set(['q3-buy-new-pass-with-a-membership', 'w13-card-buy-new-pass-event-and-membership', 'q3-reader-buy-new-pass-with-a-membership', 'w13-reader-buy-new-pass-event-and-membership'])

/** Refused after T1 had committed (by Stripe, or a step Stripe answered): created, then undone, both on record (Q20). */
const W13_REFUSED_AFTER_T1 = new Set(['w13-card-subscription-declined', 'w13-card-charge-declined-after-the-subscription', 'w13-card-old-cancel-refused'])

/** Decided outcomes, each with its own test in order-replay.test.ts. */
export const W13_OUTCOME_DIFFERS: readonly string[] = [
  'w13-card-stripe-price-differs',
  'w13-card-stripe-price-archived',
  'w13-card-subscription-unclear',
  'w13-card-declined-then-retried',
]
const OUTCOME_DECIDED: Readonly<Record<string, AllowedDifference>> = {
  'w13-card-stripe-price-differs': decided("Stripe's price isn't the plan's: refused before anything is taken, where createOrder charged Stripe's price", 'W03-plan 2.7 (the Stripe price check)', /^\.results\[0\](\.|$)|^\.stripeCalls(\[|$)|^\.tables\./),
  'w13-card-stripe-price-archived': decided('An archived price: refused at the price check with new words, before the default card or the subscription', 'Brief W13 item 1 (the price must be active)', /^\.results\[0\](\.|$)|^\.stripeCalls(\[|$)|^\.tables\./),
  'w13-card-subscription-unclear': decided('No clear answer from the subscription: held pending, never undone, after one more send with the same key', "W03-plan 2.5 (reading Stripe's answers)", /^\.results\[0\](\.|$)|^\.stripeCalls(\[|$)|^\.tables\./),
  'w13-card-declined-then-retried': decided('A decline is undone, so pressing again is a new order with new keys and a new coupon id, and it goes through', 'W03-plan 1.6 bug 13 and 2.5 (keys from the order id)', /^\.results\[1\](\.|$)|^\.stripeCalls(\[|$)|^\.tables\./),
}

/** A refunded reader finalise says so as data (`rolledBack`), so reconcile counts it as undone; finaliseReaderOrder said it only in words. */
const ROLLED_BACK_SAID: AllowedDifference = {
  name: "The finalise that refunded the tap and rolled the order back says so as data (rolledBack), beside finaliseReaderOrder's own words",
  decision: 'Brief W13 item 5 (reconcile: the tap refunded and the order undone is an undo)',
  path: /^\.results\[1\]\.rolledBack$/,
}

/** The reader's refused membership leaves the customer's card as it was: the card is saved by T2, with the paid order (W11). */
const CARD_NOT_SAVED_WHEN_REFUNDED: AllowedDifference = {
  name: "A reader membership refunded at finalise leaves the customer's saved card as it was (finaliseReaderOrder saved it before the membership failed)",
  decision: 'Brief W11 item 3 (the card is saved by T2, in the transaction that marks the order paid)',
  path: /^\.tables\.customers$/,
}


const W13_DECIDED: Readonly<Record<string, readonly AllowedDifference[]>> = {
  'q1-postage-before-the-spill': spillFixed(Q1),
  'q2-standalone-addon-before-the-spill': spillFixed(Q2),
  'q5-buy-new-keeps-address-and-requests': [ADDRESS_KEPT, REQUESTS_KEPT],
  'q3-buy-new-membership-with-a-pass': [Q3_PASS_WRITTEN],
  'q3-reader-buy-new-membership-with-a-pass': [Q3_PASS_WRITTEN],
  // Q9: a gift card beside the card records split, where createOrder recorded card for any subscription.
  'w13-card-membership-with-a-gift-card': q9Method('card', 'split'),
  'w13-card-membership-covered-by-gift-card-and-store-credit': q9Method('card', 'split'),
  'w13-reader-old-cancel-refused': [CARD_NOT_SAVED_WHEN_REFUNDED, ROLLED_BACK_SAID],
  'w13-reader-card-not-reusable': [ROLLED_BACK_SAID],
}

const stripeCallsOf = (golden: Recording) => golden.stripeCalls.map((call) => call.method)

/** W13's named differences for a scenario, from what its golden file shows the old functions did. */
export function w13Differences(name: string, golden: Recording): AllowedDifference[] {
  const methods = stripeCallsOf(golden)
  const outcome = OUTCOME_DECIDED[name]
  if (outcome) return [outcome]
  if (Q3_BOTH_WAYS.has(name)) return [Q3_MEMBERSHIP_WRITTEN]
  const fixed = W13_DECIDED[name] ?? []
  const reader = name.includes('reader')
  const allowances: AllowedDifference[] = [...fixed, ...(W13_REFUSED_AFTER_T1.has(name) ? [UNDO_AUDIT_ROWS] : [])]
  if (W13_CALLS_BY_THEIR_OWN_TEST.has(name) || reader) allowances.push(STRIPE_CALLS_BY_THEIR_OWN_TEST)
  else {
    if (methods.includes('subscriptions.create') || methods.includes('paymentIntents.create')) allowances.push(CALL_KEYS, CALL_ORDER_ID)
    if (methods.includes('coupons.create')) allowances.push(COUPON_ID)
  }
  const kept = (golden.tables['orders']?.added.length ?? 0) > 0
  if (kept && (methods.includes('subscriptions.create') || reader)) allowances.push(MEMBERSHIP_RECORD)
  return allowances
}

/** W13 scenarios whose Stripe calls differ in order or number by decision: held call by call in their own test. */
export const W13_CALLS_BY_THEIR_OWN_TEST = new Set<string>([
  'w13-card-replace-exhausted-with-a-paid-guest',
  'w13-card-charge-declined-after-the-subscription',
  'w13-card-old-cancel-refused',
])

/**
 * One single-order scenario for each part T1 answers NOT_BUILT, and what it says is missing. Each
 * must answer that before anything is written.
 */
export const NOT_BUILT_SCENARIOS: Readonly<Record<string, readonly string[]>> = {
  // W13 built memberships, the last part T1 answered NOT_BUILT for: nothing is left here.
}
