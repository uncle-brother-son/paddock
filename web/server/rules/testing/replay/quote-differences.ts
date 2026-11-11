import type { AllowedDifference } from './compare'

/**
 * Where the basket quote may differ from what the old createOrder writes. Every entry names the
 * decision in W03-decisions.md that allows it: anything else fails quote-shadow.test.ts, and so does
 * an entry that stops happening. Paths are stableDiff's, under `figures`.
 */
const firstInvoice = /^figures\.firstInvoice$/

export const QUOTE_DIFFERENCES: Record<string, readonly AllowedDifference[]> = {
  'q1-postage-before-the-spill': [
    { name: 'Postage is paid before credit spills onto the membership, so the first invoice is higher', decision: 'W03-decisions Q1', path: firstInvoice },
  ],
  'q2-standalone-addon-before-the-spill': [
    { name: 'A standalone add-on is paid before credit spills onto the membership', decision: 'W03-decisions Q2', path: firstInvoice },
  ],
  'q3-buy-new-membership-with-a-pass': [
    { name: 'The pass gets its line, which the old order never wrote', decision: 'W03-decisions Q3', path: /^figures\.lines\./ },
  ],
  'q3-buy-new-pass-with-a-membership': [
    { name: 'The membership gets its line, which the old order never wrote', decision: 'W03-decisions Q3', path: /^figures\.lines\./ },
    { name: 'The membership gets its first invoice, which the old order never raised', decision: 'W03-decisions Q3', path: firstInvoice },
  ],
  'q3-reader-buy-new-membership-with-a-pass': [
    { name: 'The pass gets its line, which the old order never wrote, on the reader too', decision: 'W03-decisions Q3', path: /^figures\.lines\./ },
  ],
  'q3-reader-buy-new-pass-with-a-membership': [
    { name: 'The membership gets its line, which the old order never wrote, on the reader too', decision: 'W03-decisions Q3', path: /^figures\.lines\./ },
  ],
  'q4-shipped-gift-card-earns-free-postage': [
    { name: 'No postage on the order total', decision: 'W03-decisions Q4', path: /^figures\.orderTotal$/ },
    { name: 'No postage on the postage line', decision: 'W03-decisions Q4', path: /^figures\.lines\.1\.(unitPrice|lineTotal)$/ },
    { name: 'No postage in what is collected', decision: 'W03-decisions Q4', path: /^figures\.collected$/ },
  ],
  'q5-buy-new-keeps-address-and-requests': [
    { name: 'The delivery address is kept', decision: 'W03-decisions Q5', path: /^figures\.hasShippingAddress$/ },
    { name: 'The special requests are kept', decision: 'W03-decisions Q5', path: /^figures\.booking\.hasSpecialRequests$/ },
  ],
  // W07's scenarios
  'w07-q4-shipped-gift-card-and-product-reach-free-postage': [
    { name: 'No postage on the order total', decision: 'W03-decisions Q4', path: /^figures\.orderTotal$/ },
    { name: 'No postage on the postage line', decision: 'W03-decisions Q4', path: /^figures\.lines\.2\.(unitPrice|lineTotal)$/ },
    { name: 'No postage in what is collected', decision: 'W03-decisions Q4', path: /^figures\.collected$/ },
  ],
  'w07-q5-buy-new-pass-keeps-address-and-requests': [
    { name: 'The delivery address is kept on a buy-new pass order', decision: 'W03-decisions Q5', path: /^figures\.hasShippingAddress$/ },
    { name: 'The special requests are kept on a buy-new pass booking', decision: 'W03-decisions Q5', path: /^figures\.booking\.hasSpecialRequests$/ },
  ],
  'w07-worst-basket': [{ name: 'The delivery address is kept on a buy-new pass order', decision: 'W03-decisions Q5', path: /^figures\.hasShippingAddress$/ }],
  // W13's scenarios
  'w13-card-buy-new-pass-event-and-membership': [
    { name: 'The membership gets its line, which the old order never wrote (with an event too)', decision: 'W03-decisions Q3', path: /^figures\.lines\./ },
    { name: 'The membership gets its first invoice, which the old order never raised', decision: 'W03-decisions Q3', path: firstInvoice },
  ],
  'w13-reader-buy-new-pass-event-and-membership': [
    { name: 'The membership gets its line, which the old order never wrote, on the reader with an event too', decision: 'W03-decisions Q3', path: /^figures\.lines\./ },
  ],
  // createOrder charged Stripe's £45 where the plan says £40; the Worker refuses it (W13's price check).
  'w13-card-stripe-price-differs': [{ name: "The quote charges the plan's price; createOrder charged Stripe's", decision: 'W03-plan 2.7 (the Stripe price check)', path: firstInvoice }],
}

/**
 * Where the Worker's dry run may differ from what the old createOrder writes (from W07, as the dry run
 * takes products, postage, passes and gift cards). Paths are the shadow's stableDiff paths. Each
 * names its decision, as above.
 */
const dryRunQ5Address = [
  { name: 'The buy-new order keeps its delivery address', decision: 'W03-decisions Q5', path: /^rows\.order\.(has_shipping_address|shipping_address)$/ },
]
/** Q3: the pass bought beside a buy-new membership gets its line and row, which createOrder never wrote. */
const dryRunQ3Pass: readonly AllowedDifference[] = [
  { name: 'The pass gets its line and its row, which the old order never wrote', decision: 'W03-decisions Q3', path: /^rows\.(lines|session_passes)\./ },
  { name: 'The answer names the pass', decision: 'W03-decisions Q3', path: /^result\.hasSessionPass$/ },
]
/** Q3 the other way: the membership beside a buy-new pass booking is sold (its line, its row, its first invoice). */
const dryRunQ3Membership: readonly AllowedDifference[] = [
  { name: 'The membership gets its line (and the lines after it move along), which the old order never wrote', decision: 'W03-decisions Q3', path: /^rows\.(lines|memberships)\./ },
  { name: 'The card pays the membership too', decision: 'W03-decisions Q3', path: /^result\.cardAmount$/ },
]
/** W03-decisions Q9: the method the Worker's order records, where createOrder recorded another. */
const dryRunQ9Method: readonly AllowedDifference[] = [
  { name: 'The order records the method Q9 names', decision: 'W03-decisions Q9', path: /^rows\.order\.payment_method$/ },
  { name: 'The answer names the method Q9 names', decision: 'W03-decisions Q9', path: /^result\.paymentMethodUsed$/ },
]

export const DRY_RUN_DIFFERENCES: Record<string, readonly AllowedDifference[]> = {
  // The cash figure staff confirmed includes the postage the Worker no longer charges, so its dry run
  // is refused as a changed total where the old order went through.
  'q4-shipped-gift-card-earns-free-postage': [
    { name: 'Refused as a changed total: the confirmed cash includes postage the order no longer charges', decision: 'W03-decisions Q4', path: /^(refusal|result|rows)$/ },
  ],
  'w07-q4-shipped-gift-card-and-product-reach-free-postage': [
    { name: 'Refused as a changed total: the confirmed cash includes postage the order no longer charges', decision: 'W03-decisions Q4', path: /^(refusal|result|rows)$/ },
  ],
  'w07-q5-buy-new-pass-keeps-address-and-requests': [
    ...dryRunQ5Address,
    { name: 'The buy-new booking keeps its special requests', decision: 'W03-decisions Q5', path: /^rows\.booking\.special_requests$/ },
  ],
  'w07-worst-basket': dryRunQ5Address,
  // The old createOrder's dates roll over a month end; the Worker's end on the month's last day.
  'w07a-q33-pass-and-gift-card-bought-on-29-february': [
    { name: "A pass bought on 29 Feb ends on the next year's 28 Feb, not 1 Mar", decision: 'W03-decisions Q33', path: /^rows\.session_passes\.0\.expiry_date$/ },
    { name: "A gift card bought on 29 Feb ends on the next year's 28 Feb, not 1 Mar", decision: 'W03-decisions Q33', path: /^rows\.gift_cards\.0\.expiry_date$/ },
  ],
  // The address save fails inside T1, so the dry run fails where the old order warned after it.
  'w07-address-save-fails': [{ name: 'The dry run fails: the address save is inside T1', decision: 'Brief W07 item 2 (the delivery address is saved inside T1)', path: /^$/ }],
  // W09: what orders.payment_method records (Q9): store credit alone, and a gift card with store credit.
  'store-credit-covers-everything': dryRunQ9Method,
  'w09-half-penny-store-credit-covers-it': dryRunQ9Method,
  'w09-gift-card-and-store-credit-cover-everything': dryRunQ9Method,
  'w09-exact-cover-gift-card-and-store-credit': dryRunQ9Method,
  'w09-exact-cover-ninety-five-and-five-pence': dryRunQ9Method,
  'w09a-store-credit-alone-leaves-the-address-on-file': dryRunQ9Method,
  // W10: the card chosen with a gift card and store credit covering it all records split (Q9).
  'w10-card-chosen-with-nothing-left-to-charge': dryRunQ9Method,
  // W13: memberships.
  'q1-postage-before-the-spill': [{ name: 'Postage is paid before credit spills onto the membership: the card pays what the screen showed', decision: 'W03-decisions Q1', path: /^result\.cardAmount$/ }],
  'q2-standalone-addon-before-the-spill': [{ name: 'A standalone add-on is paid before credit spills onto the membership', decision: 'W03-decisions Q2', path: /^result\.cardAmount$/ }],
  'q3-buy-new-membership-with-a-pass': dryRunQ3Pass,
  'q3-reader-buy-new-membership-with-a-pass': dryRunQ3Pass.filter((a) => a !== dryRunQ3Pass[1]),
  'q3-buy-new-pass-with-a-membership': dryRunQ3Membership,
  'q3-reader-buy-new-pass-with-a-membership': dryRunQ3Membership.slice(0, 1),
  'w13-card-buy-new-pass-event-and-membership': dryRunQ3Membership,
  'w13-reader-buy-new-pass-event-and-membership': dryRunQ3Membership.slice(0, 1),
  'q5-buy-new-keeps-address-and-requests': [
    ...dryRunQ5Address,
    { name: 'The buy-new booking keeps its special requests', decision: 'W03-decisions Q5', path: /^rows\.booking\.special_requests$/ },
  ],
  'w13-card-membership-with-a-gift-card': dryRunQ9Method,
  'w13-card-membership-covered-by-gift-card-and-store-credit': dryRunQ9Method,
  'w13-card-stripe-price-differs': [{ name: "The dry run takes the plan's price; createOrder took Stripe's (refused by W13's price check)", decision: 'W03-plan 2.7 (the Stripe price check)', path: /^result\.cardAmount$/ }],
}

/**
 * Q6 keeps the server's rule, so the quote matches what the order writes. The difference is with the
 * old screen's preview, which left a buy-new booking's seats out of the promo.
 */
export const SCREEN_DIFFERENCE: AllowedDifference = {
  name: "The quote shows the promo on a buy-new booking's paid seats, which the old screen left out",
  decision: 'W03-decisions Q6',
  path: /^promoDiscount$/,
}
