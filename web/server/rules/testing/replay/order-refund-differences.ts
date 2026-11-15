import type { AllowedDifference } from './compare'

/*
 * W28 (brief item 8; E-plan 4.13 items 3 and 4): the order refund golden families (W27's `w27-order-refund-*` and the
 * E2 and E5 recordings) through the Worker's route, and the only differences allowed in each, every one tied to a
 * decision. A scenario not named in ORDER_REFUND_DIFFERENCES must match its golden file exactly; an allowance that
 * stops being needed fails (compareRecordings).
 */

/**
 * The scenarios whose refund is of a membership line (or the payment date change charge). W28's route refused them;
 * W29 builds them, so they replay with the rest. Three match their golden files exactly (the row not found, to store
 * credit, no subscription), three differ only in the refund's key, and four have named differences of their own (E3,
 * E4, and E10 twice), below.
 */
export const MEMBERSHIP_SCENARIOS: ReadonlySet<string> = new Set([
  'w27-order-refund-membership-on-saved-card',
  'w27-order-refund-membership-to-store-credit',
  'w27-order-refund-membership-with-no-subscription',
  'w27-order-refund-membership-bought-on-the-reader',
  'w27-order-refund-refused-membership-row-not-found',
  'w27-order-refund-payment-date-change-charge-is-a-plain-line',
  'w27-order-refund-subscription-cancel-refused-after-the-money-went',
  'w27-order-refund-subscription-cancel-refused-before-any-money-is-taken-back',
  'w27-e3-membership-and-robe-on-one-card-refunded-to-card',
  'w27-e4-membership-refunded-in-full-after-a-credit-session',
])

/** True for a W27 scenario that calls refundOrder: the order refund families, and the E2 to E5 recordings. */
export const isOrderRefundScenario = (name: string): boolean => /^w27-(order-refund-|e[2345]-)/.test(name)


const W28 = 'Brief W28 (E-plan 4.3; lead call L2: claims in audit_log)'
const CLAIM_KEY = /^audit_log#\d+:refund:orders#\d+$/
const CLAIM_LABEL = /^audit_log#\d+$/
const KEY_PATHS = String.raw`^\.stripeCalls\[\d+\]\.(idempotencyKey|params\.metadata\.(refund_key|claim_id))$`

/**
 * A card refund's key and metadata come from its claim: `<claimId>:refund:<orderId>`, with `metadata.claim_id` naming
 * the claim and `refund_key` the key. The old key was built from the order, a hash of the lines, the card money the
 * order had had back, the amount and a count of refusals. Only those values pass.
 */
export const ORDER_CLAIM_KEYS: AllowedDifference = {
  name: "An order refund's card refund is keyed from its claim (`<claimId>:refund:<orderId>`) and names it in `metadata.claim_id`; the old key built from the lines, the figures and a count of refusals is replaced",
  decision: `${W28}: keys from the claim id; W05i noticed 2 and W05j call 1 (the old keys and their refusal counts go)`,
  path: new RegExp(KEY_PATHS),
  actual: (value, _expected, path) => (path.endsWith('.claim_id') ? typeof value === 'string' && CLAIM_LABEL.test(value) : typeof value === 'string' && CLAIM_KEY.test(value)),
}

const KEYS_ONLY = [
  'order-refund-refused-already-refunded',
  'order-refund-refused-by-stripe-then-pressed-again',
  'order-refund-product-to-card-no-restock',
  'order-refund-product-to-card-with-restock',
  'order-refund-split-card-and-store-credit',
  'order-refund-gift-card-part-paid-split',
  'order-refund-postage-line',
  'order-refund-shipped-product-and-its-postage',
  'order-refund-standalone-addon',
  'order-refund-gift-card-unspent-is-voided',
  'order-refund-pass-unused-is-emptied',
  'order-refund-promo-line-gives-back-what-was-paid',
  'order-refund-a-second-refund-on-the-same-order',
  'order-refund-two-lines-at-once-split',
  'order-refund-every-kind-of-line-at-once',
  // E5 (lead call L10): this recording models "2 of 5 used" by lowering the pass's sessions by hand, with no booking
  // that names the pass, so the rule ("a seat taken with this pass and not returned") reads it as unused and refunds
  // it as the old code did. The used case is proven with real bookings in orders/refund-lines.test.ts.
  'e5-used-pass-refunds-in-full-once-its-type-is-edited-down',
  // W29: a membership on one card payment (the first invoice's, or the reader's tap), and the payment date change
  // charge as a plain line: the old outcome exactly, the subscription cancelled after the refund as before.
  'order-refund-membership-on-saved-card',
  'order-refund-membership-bought-on-the-reader',
  'order-refund-payment-date-change-charge-is-a-plain-line',
]

type Check = (value: unknown, expected: unknown, path: string) => boolean
const said = (words: string | RegExp) => (value: unknown): boolean => (typeof words === 'string' ? value === words : typeof value === 'string' && words.test(value))
const result = (index: number, fields: string): string => String.raw`^\.results\[${index}\]\.(${fields})$`
const difference = (name: string, decision: string, paths: readonly string[], actual?: AllowedDifference['actual']): AllowedDifference => ({ name, decision, path: new RegExp(paths.join('|')), ...(actual ? { actual } : {}) })

const NO_ANSWER = /^The refund didn't get an answer, so it may or may not have gone through\./
const PRESSED_AGAIN = /^The last press didn't get an answer, so this can't be sent as a new one\./
const NOT_SAVED = "The refund couldn't be saved (the system was busy, or one of its records couldn't be written), so nothing was refunded. Try again."

/** A press that got no answer: the dialog's words, and its key kept. */
const noAnswerOn = (index: number): Check => (value, _expected, path) => {
  if (!path.startsWith(`.results[${index}].`)) return true
  if (path.endsWith('.reason')) return value === 'no_answer'
  if (path.endsWith('.message')) return said(NO_ANSWER)(value)
  if (path.endsWith('.noAnswer')) return value === true
  return value === undefined
}

/**
 * The refund the old code refused (or left undone) goes through on the Worker: `amount` back, all of it to the card,
 * the line stamped and the order's status worked out. Each path is held to exactly that.
 */
const goesThrough = (index: number, amount: number, status: 'refunded' | 'partially_refunded' = 'refunded'): Check => (value, _expected, path) => {
  if (path.startsWith(`.results[${index}].`)) {
    if (path.endsWith('.success')) return value === true
    if (path.endsWith('.refundedAmount') || path.endsWith('.cardRefundedAmount')) return value === amount
    if (path.endsWith('.refundMethod')) return value === 'card'
    if (path.endsWith('.orderPaymentStatus')) return value === status
    return value === undefined
  }
  if (/^\.stripeCalls\[\d+\]$/.test(path)) return (value as { method?: string; params?: { amount?: number } } | undefined)?.method === 'refunds.create' && (value as { params: { amount: number } }).params.amount === Math.round(amount * 100)
  if (path.endsWith('.refunded_at')) return value === '<set>'
  if (path.endsWith('.refund_method')) return value === 'card'
  if (path.endsWith('.restocked')) return value === false
  if (path.endsWith('.card_refunded_amount')) return value === amount.toFixed(2)
  if (path.endsWith('.payment_status')) return value === status
  if (path.endsWith('.sessions_remaining')) return value === 0
  return true
}
const THROUGH_PATHS = (index: number): string[] => [
  result(index, 'success|reason|message|refundedAmount|refundMethod|cardRefundedAmount|orderPaymentStatus'),
  String.raw`^\.stripeCalls\[\d+\]$`,
  String.raw`^\.tables\.order_line_items\.added\[0\]\.(refunded_at|refund_method|restocked|card_refunded_amount)$`,
  String.raw`^\.tables\.orders\.added\[0\]\.payment_status$`,
  String.raw`^\.tables\.customer_session_passes\.added\[0\]\.sessions_remaining$`,
]

const BY_DESIGN = `${W28}; E-plan "six things" item 4 (one transaction and a key from the claim replace the old safety machinery)`
const LOST_ANSWER = `${W28}; E11 (the press key, kept after no answer); W20's model of a lost answer (the route ran to the end)`

const named = (name: string, differences: readonly AllowedDifference[]): [string, readonly AllowedDifference[]] => [`w27-${name}`, differences]

// --- W29: the membership line (E-plan 4.3; Wayne's Q40 and Q41, 14 Nov; bugs E3, E4, E10)

const W29_CANCEL_LAST = 'Brief W29 item 1; E-plan 4.3 (the subscription is cancelled last, after the money is settled; a cancel refused or unclear is recorded as left, listed and retried by reconcile); bug E10'
const CANCEL_LEFT = /^The refund is done, but the membership's subscription \(sub_fake_\d+\) couldn't be confirmed cancelled in Stripe yet, so it could still take its next payment\. The automatic check tries again every 5 minutes, and it shows on the Orders page until it is cancelled\. Don't refund it again\.$/
/** The read that follows a cancel Stripe didn't confirm (cancelSubscriptionChecked): only `canceled` counts as cancelled. */
const isCancelRead = (value: unknown): boolean => {
  const call = value as { method?: string; params?: { id?: string }; idempotencyKey?: unknown } | undefined
  return call?.method === 'subscriptions.retrieve' && /^sub_fake_\d+$/.test(String(call.params?.id)) && call.idempotencyKey === null
}
const MEMBERSHIP_STATUS = String.raw`^\.tables\.customer_memberships\.added\[0\]\.subscription_status$`

/**
 * Every order refund golden scenario that differs on the new route, and the only differences allowed in each. The
 * rest of the families match their golden files exactly (19 of the 67: W28's 16 and three of W29's).
 */
export const ORDER_REFUND_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map<string, readonly AllowedDifference[]>([
  ...KEYS_ONLY.map((name) => named(name, [ORDER_CLAIM_KEYS])),

  // --- Who may refund: checked by the route before the rule runs (W01's staff auth; E-plan 4.10)
  named('order-refund-refused-no-staff-record', [
    difference(
      "Someone with no staff record is refused by the Worker's staff check, in its words (the old function's sentence, with what to do about it)",
      'E-plan 4.10 (checked on the Worker from the signed-in staff member); W01 staff auth',
      [result(1, 'message')],
      said("No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action.")
    ),
  ]),
  named('order-refund-refused-inactive-staff', [
    difference(
      'An inactive staff member is refused as data (`permission_denied`, the same words), where the old function threw them',
      'E-plan 4.10 (inactive staff: refused by defineRoute everywhere); E-plan 4.8 (refusals come back in the old result shape)',
      [result(1, 'thrown|success|reason|message')],
      (value, _expected, path) =>
        path.endsWith('.thrown') ? value === undefined : path.endsWith('.success') ? value === false : path.endsWith('.reason') ? value === 'permission_denied' : value === 'This staff account is inactive. Ask an admin to reactivate it.'
    ),
  ]),
  named('order-refund-refused-without-issue-refunds', [
    difference(
      "No Issue refunds: the Worker's own words for the permission (step D's), not the old function's column name",
      'E-plan 4.10 (Issue refunds checked on the Worker); W01 staff auth',
      [result(1, 'message')],
      said('Needs Issue refunds permission — this action moves money back to the customer.')
    ),
  ]),

  // --- Q42: cash is a way to refund an order now
  named('order-refund-refused-method-not-card-or-credit', [
    difference(
      "`cash` is a refund method now (Q42). This order was paid by card, so no cash can be handed back: refused `no_cash_left`, with the figures (the old function refused any method but card or credit)",
      "Wayne's Q42 (14 Nov): cash back only up to the cash paid on the order; E-plan 4.6",
      [result(1, 'reason|message|figures')],
      (value, _expected, path) =>
        path.endsWith('.reason') ? value === 'no_cash_left' : path.endsWith('.message') ? value === "No cash paid on this order is left to hand back, so it can't be handed back in cash." : typeof value === 'object' && value !== null && (value as { cashLeft?: number }).cashLeft === 0
    ),
  ]),

  // --- E5 (lead call L10): a pass is used when a seat was taken with it and not returned
  named('order-refund-refused-pass-used', [
    difference(
      "E5: the recording lowers the pass's sessions by hand (4 of 5), with no booking that names the pass. \"Used\" is read from the bookings that name it, so the pass is unused and £50 goes back; the old test compared what was left with the pass type's sessions",
      'E5; lead call L10 (W03-decisions, 14 Nov): a "used" pass is a seat taken with it and not returned',
      THROUGH_PATHS(1),
      goesThrough(1, 50)
    ),
  ]),
  named('e5-unused-pass-is-refused-once-its-type-is-edited-up', [
    difference(
      "E5: an unused pass whose type was edited from 5 to 10 sessions refunds (£50, the pass emptied); the old code refused it as used (5 is below 10)",
      'E5; lead call L10 (W03-decisions, 14 Nov)',
      THROUGH_PATHS(1),
      goesThrough(1, 50)
    ),
  ]),

  // --- Reads the old machinery made and the Worker doesn't (nothing to fail)
  named('order-refund-refused-when-the-card-check-cannot-be-read', [
    difference(
      "The old key needed a count of earlier refusals, and refused when that read failed. The claim's key needs no count, so there is no such read: the £24 refund goes through",
      `${BY_DESIGN}; W05j call 1 (refusal counts in the key go)`,
      THROUGH_PATHS(1),
      goesThrough(1, 24)
    ),
  ]),
  named('order-refund-refused-when-the-look-for-a-held-refund-fails', [
    difference(
      'The old code looked for an earlier held refund before every press, and refused when that read failed. An open claim is found under the order\'s lock instead (`refund_open`), so there is no such read: the £24 refund goes through',
      `${BY_DESIGN}; W05j calls 1 and 2 (held refunds settled on the next press are replaced by claims and reconcile)`,
      THROUGH_PATHS(1),
      goesThrough(1, 24)
    ),
  ]),

  // --- A write that fails: R1 is one transaction, so nothing is kept and nothing is taken back
  named('order-refund-store-credit-write-fails', [
    difference(
      "The store credit is given inside R1's transaction: when its write fails, the whole of R1 is rolled back and the words are the Worker's for that (the old function answered `store_credit_failed`). Nothing was refunded either way",
      `${W28}: R1 is one transaction (W05 review 2, item 9: no take-backs)`,
      [result(1, 'reason|message')],
      (value, _expected, path) => (path.endsWith('.reason') ? value === 'refund_not_saved' : value === NOT_SAVED)
    ),
  ]),
  named('order-refund-line-stamp-fails-to-store-credit-is-rolled-back', [
    difference(
      'The stamp and the store credit are one transaction: the stamp failing rolls it all back, so no store credit row is ever written (the old code gave £24, then took it back with a second row)',
      `${W28}: R1 is one transaction (W05 review 2, item 9; W05k later 3: no take-backs)`,
      [result(1, 'reason|message'), String.raw`^\.tables\.store_credit_transactions$`],
      (value, _expected, path) => (path.endsWith('.reason') ? value === 'refund_not_saved' : path.endsWith('.message') ? value === NOT_SAVED : value === undefined)
    ),
  ]),
  named('order-refund-line-stamp-fails-after-the-card-refund', [
    ORDER_CLAIM_KEYS,
    difference(
      "The lines are stamped in R1, before any card refund is sent: the stamp failing rolls R1 back and nothing is sent. The next press refunds £24 once and restocks once (the old code refunded first, then failed, and the second press restocked a second time: 7 in stock, not 5, and a third stock adjustment)",
      `${W28}: R1 before the send (the claim, the reversals and the stamps in one transaction)`,
      [result(1, 'success|refundedAmount|refundMethod|cardRefundedAmount|warning|reason|message'), String.raw`^\.stripeCalls\[2\]$`, String.raw`^\.tables\.product_variants$`, String.raw`^\.tables\.stock_adjustments\.added\[2\]$`],
      (value, _expected, path) => (path.endsWith('.success') ? value === false : path.endsWith('.reason') ? value === 'refund_not_saved' : path.endsWith('.message') ? value === NOT_SAVED : value === undefined)
    ),
  ]),
  named('order-refund-store-credit-fails-after-the-card-part', [
    ORDER_CLAIM_KEYS,
    difference(
      "The £14 card part went and R2's store credit write failed: the claim is held (`refund_unsure`, \"£14.00 went back to the card, but the refund couldn't be finished…\"), and reconcile finishes it (the £14 on the line, the planned £10 to store credit, R2's note). The next press finds the line refunded. The old code answered success with a warning, left the line unstamped, and gave the £10 on the next press",
      `${W28}: R2 is one transaction; held for reconcile (E-plan 4.9); W02 release review finding 4 (a retry can't pay the card money again as store credit)`,
      [
        result(1, 'success|refundedAmount|refundMethod|storeCreditRefundedAmount|warning|reason|message|held'),
        result(2, 'success|refundedAmount|refundMethod|storeCreditRefundedAmount|storeCreditBalance|orderPaymentStatus|reason|message'),
        String.raw`^\.tables\.store_credit_transactions\.added\[1\]\.note$`,
      ],
      (value, _expected, path) => {
        if (path.startsWith('.results[1].')) {
          if (path.endsWith('.success')) return value === false
          if (path.endsWith('.reason')) return value === 'refund_unsure'
          if (path.endsWith('.message')) return said(/^£14\.00 went back to the card, but the refund couldn't be finished on the order yet\./)(value)
          if (path.endsWith('.held')) return value === true
          return value === undefined
        }
        if (path.startsWith('.results[2].')) return path.endsWith('.success') ? value === false : path.endsWith('.reason') ? value === 'already_refunded' : path.endsWith('.message') ? said(/^Already refunded: /)(value) : value === undefined
        return value === 'Refund to store credit — the lines refunded exceeded the card portion of the payment; the card part went back to the card. [ref gone]'
      }
    ),
  ]),
  named('order-refund-store-credit-that-cannot-be-looked-for-counts-as-given', [
    difference(
      "A lost answer on the old store credit statement (the hook matches the old code's SQL, which the Worker doesn't run): R1 is one transaction, so the £24 is given once and answered with its balance, and there is no \"counted as given\" warning",
      `${W28}: R1 is one transaction (W05j call 2: store credit that can't be told is no longer counted as given)`,
      [result(1, 'warning|storeCreditBalance')],
      (value, _expected, path) => (path.endsWith('.warning') ? value === undefined : value === 54)
    ),
  ]),
  named('order-refund-store-credit-cannot-be-looked-for-then-the-stamp-fails', [
    difference(
      'The stamp failing rolls back the store credit with it: nothing is given and the balance is unchanged (the old code counted the £24 as given, then failed to stamp the line, so the line could be refunded again)',
      `${W28}: R1 is one transaction (W05j call 2; W05 review 2, item 9)`,
      [result(1, 'success|refundedAmount|refundMethod|storeCreditRefundedAmount|warning|reason|message'), String.raw`^\.tables\.(customers|store_credit_transactions)$`],
      (value, _expected, path) => (path.endsWith('.success') ? value === false : path.endsWith('.reason') ? value === 'refund_not_saved' : path.endsWith('.message') ? value === NOT_SAVED : value === undefined)
    ),
  ]),

  // --- A lost answer: the route ran to the end, so the refund went once and is recorded; the dialog keeps its key
  named('order-refund-answer-lost-then-pressed-again', [
    ORDER_CLAIM_KEYS,
    difference(
      "The Worker's answer is lost after its route ran to the end: the dialog gets no answer and keeps its key, and the same press again gets the first press's answer (£24 to the card), with nothing sent again. The old code held the refund and sent it again under the same key on the next press",
      LOST_ANSWER,
      [result(1, 'reason|message|noAnswer'), result(2, 'refundedAmount|cardRefundedAmount'), String.raw`^\.stripeCalls\[2\]$`],
      (value, expected, path) => (path.startsWith('.results[2].') ? value === 24 : path.startsWith('.stripeCalls') ? value === undefined : noAnswerOn(1)(value, expected, path))
    ),
  ]),
  named('order-refund-answer-lost-then-store-credit-chosen', [
    ORDER_CLAIM_KEYS,
    difference(
      'The answer is lost after the route ran (the £24 went to the card and is recorded). A changed press under the kept key (store credit) is refused as a changed press, nothing done: the dialog says to close it and check the order, which shows the lines refunded',
      LOST_ANSWER,
      [result(1, 'reason|message|noAnswer'), result(2, 'success|refundedAmount|refundMethod|orderPaymentStatus|reason|message|noAnswer'), String.raw`^\.stripeCalls\[2\]$`],
      (value, expected, path) => {
        if (path.startsWith('.results[2].')) return path.endsWith('.success') ? value === false : path.endsWith('.reason') ? value === 'pressed_after_no_answer' : path.endsWith('.message') ? said(PRESSED_AGAIN)(value) : path.endsWith('.noAnswer') ? value === true : value === undefined
        return path.startsWith('.stripeCalls') ? value === undefined : noAnswerOn(1)(value, expected, path)
      }
    ),
  ]),
  named('order-refund-held-two-days-then-found-by-its-key', [
    ORDER_CLAIM_KEYS,
    difference(
      "The answer is lost after the route ran. Two days later the same press gets the first press's stored answer (£24 to the card): no look in Stripe is needed, and nothing is sent (the old code listed the payment's refunds to find it by its key)",
      `${LOST_ANSWER}; W05j call 1 (the 23-hour look-up goes)`,
      [result(1, 'reason|message|noAnswer'), result(2, 'refundedAmount|cardRefundedAmount'), String.raw`^\.stripeCalls\[2\]$`],
      (value, expected, path) => (path.startsWith('.results[2].') ? value === 24 : path.startsWith('.stripeCalls') ? value === undefined : noAnswerOn(1)(value, expected, path))
    ),
  ]),
  named('order-refund-held-record-fails-too', [
    ORDER_CLAIM_KEYS,
    difference(
      "The answer is lost after the route ran; there is no held record to fail (the hook matches the old code's `card_refund_held` row, which the Worker never writes), so no warning about it. The same press again gets the stored answer and nothing is sent again",
      `${LOST_ANSWER}; W05j call 1`,
      [result(1, 'reason|message|warning|noAnswer'), String.raw`^\.stripeCalls\[2\]$`],
      (value, expected, path) => (path.startsWith('.stripeCalls') ? value === undefined : noAnswerOn(1)(value, expected, path))
    ),
  ]),
  named('order-refund-died-after-the-refund-then-pressed-again', [
    ORDER_CLAIM_KEYS,
    difference(
      "The function dies once the Worker has answered: the route ran to the end (the £24 went and is recorded), the dialog gets no answer and keeps its key, and the same press again gets the stored answer. The old function died after its refund with nothing recorded, and the next press sent the refund again under the same key",
      LOST_ANSWER,
      [result(1, 'success|refundedAmount|refundMethod|cardRefundedAmount|warning|reason|message|noAnswer'), String.raw`^\.stripeCalls\[2\]$`],
      (value, expected, path) => (path.startsWith('.stripeCalls') ? value === undefined : path.endsWith('.success') ? value === false : noAnswerOn(1)(value, expected, path))
    ),
  ]),
  named('order-refund-died-then-the-same-lines-in-the-other-order', [
    ORDER_CLAIM_KEYS,
    difference(
      'The function dies once the Worker has answered: the route ran to the end (£39 to the card, both lines stamped). The same lines chosen the other way round is a changed press under the kept key: refused, nothing done, and nothing sent again (the old key hashed the lines in any order, so the second press sent the same refund again)',
      LOST_ANSWER,
      [result(1, 'success|refundedAmount|refundMethod|cardRefundedAmount|warning|reason|message|noAnswer'), result(2, 'success|refundedAmount|refundMethod|cardRefundedAmount|orderPaymentStatus|reason|message|noAnswer'), String.raw`^\.stripeCalls\[2\]$`],
      (value, expected, path) => {
        if (path.startsWith('.results[2].')) return path.endsWith('.success') ? value === false : path.endsWith('.reason') ? value === 'pressed_after_no_answer' : path.endsWith('.message') ? said(PRESSED_AGAIN)(value) : path.endsWith('.noAnswer') ? value === true : value === undefined
        return path.startsWith('.stripeCalls') ? value === undefined : path.endsWith('.success') ? value === false : noAnswerOn(1)(value, expected, path)
      }
    ),
  ]),
  named('order-refund-died-on-one-line-then-another-line-at-the-same-figures', [
    ORDER_CLAIM_KEYS,
    difference(
      "The same death, on an order (W27's \"For the Worker step\"): the old function died after a £24 refund with nothing recorded, another line was then refunded, and £48 went back with £24 recorded. On the Worker the first press's route ran to the end: £24 back once, on the first line, stamped. The second press (another line, under the kept key) is refused as a changed press, and nothing more is sent",
      `${W28}: the claim is written before anything is sent (closed by design); ${LOST_ANSWER}`,
      [
        result(1, 'success|refundedAmount|refundMethod|cardRefundedAmount|warning|reason|message|noAnswer'),
        result(2, 'success|refundedAmount|refundMethod|cardRefundedAmount|orderPaymentStatus|reason|message|noAnswer'),
        String.raw`^\.stripeCalls\[2\]$`,
        String.raw`^\.tables\.order_line_items\.added\[[01]\]\.(refunded_at|refund_method|restocked|card_refunded_amount)$`,
      ],
      (value, expected, path) => {
        if (path.startsWith('.results[2].')) return path.endsWith('.success') ? value === false : path.endsWith('.reason') ? value === 'pressed_after_no_answer' : path.endsWith('.message') ? said(PRESSED_AGAIN)(value) : path.endsWith('.noAnswer') ? value === true : value === undefined
        if (path.startsWith('.stripeCalls')) return value === undefined
        if (path.startsWith('.tables.order_line_items.added[0]')) return path.endsWith('.refunded_at') ? value === '<set>' : path.endsWith('.refund_method') ? value === 'card' : path.endsWith('.restocked') ? value === false : value === '24.00'
        if (path.startsWith('.tables.order_line_items.added[1]')) return path.endsWith('.card_refunded_amount') ? value === '0.00' : value === null
        return path.endsWith('.success') ? value === false : noAnswerOn(1)(value, expected, path)
      }
    ),
  ]),
  named('order-refund-still-no-clear-answer-on-the-next-press', [
    ORDER_CLAIM_KEYS,
    difference(
      "The answer is lost after the route ran (the £24 went and is recorded). The next press (store credit) is a changed press under the kept key: refused, nothing done. The press after it (the first one again) gets the stored answer. Nothing is sent a second or third time (the old code sent the refund again on each press)",
      LOST_ANSWER,
      [result(1, 'reason|message|noAnswer'), result(2, 'reason|message|noAnswer'), result(3, 'refundedAmount|cardRefundedAmount'), String.raw`^\.stripeCalls\[[23]\]$`],
      (value, expected, path) => {
        if (path.startsWith('.results[2].')) return path.endsWith('.reason') ? value === 'pressed_after_no_answer' : path.endsWith('.message') ? said(PRESSED_AGAIN)(value) : value === true
        if (path.startsWith('.results[3].')) return value === 24
        return path.startsWith('.stripeCalls') ? value === undefined : noAnswerOn(1)(value, expected, path)
      }
    ),
  ]),
  named('order-refund-held-two-days-and-the-look-fails', [
    ORDER_CLAIM_KEYS,
    difference(
      "The answer is lost after the route ran: the £24 went and R2 recorded it (the line stamped, the order refunded). Two days later the same press gets the stored answer, with no look in Stripe to fail. The old code held the refund, and when its look failed left £24 back on the card with the line unstamped (one of W27's known faults)",
      `${LOST_ANSWER}; W27 review L8 (closed by design)`,
      [result(1, 'reason|message|noAnswer'), result(2, 'success|reason|message|refundedAmount|refundMethod|cardRefundedAmount|orderPaymentStatus'), String.raw`^\.stripeCalls\[2\]$`, ...THROUGH_PATHS(2).slice(2)],
      (value, expected, path) => {
        if (path.startsWith('.results[1].')) return noAnswerOn(1)(value, expected, path)
        if (path.startsWith('.stripeCalls')) return value === undefined
        return goesThrough(2, 24)(value, expected, path)
      }
    ),
  ]),

  // --- A send that got no answer is sent once more under its key
  named('order-refund-never-reached-stripe-then-two-days-later', [
    ORDER_CLAIM_KEYS,
    difference(
      "A refund that never reached Stripe is sent once more by the same press, under the same key and request, and goes: £24 back, recorded. Two days later the lines are already refunded. The old code held it, looked for it in Stripe two days later, found nothing and sent it then",
      `${W28}: one card part is sent once, and once more only on an unclear answer, under its key (pipeline.ts, as step D)`,
      [
        result(1, 'success|reason|message|refundedAmount|refundMethod|cardRefundedAmount|orderPaymentStatus'),
        result(2, 'success|refundedAmount|refundMethod|cardRefundedAmount|orderPaymentStatus|reason|message'),
        String.raw`^\.stripeCalls\[2\]\.(method|params\.(limit|amount|metadata)|idempotencyKey)$`,
        String.raw`^\.stripeCalls\[3\]$`,
      ],
      (value, expected, path) => {
        if (path.startsWith('.results[1].')) return goesThrough(1, 24)(value, expected, path)
        if (path.startsWith('.results[2].')) return path.endsWith('.success') ? value === false : path.endsWith('.reason') ? value === 'already_refunded' : path.endsWith('.message') ? said(/^Already refunded: /)(value) : value === undefined
        if (path === '.stripeCalls[2].method') return value === 'refunds.create'
        if (path === '.stripeCalls[2].params.amount') return value === 2400
        if (path === '.stripeCalls[2].idempotencyKey') return typeof value === 'string' && CLAIM_KEY.test(value)
        if (path === '.stripeCalls[2].params.metadata') return typeof value === 'object' && value !== null && CLAIM_KEY.test(String((value as { refund_key?: unknown }).refund_key))
        return value === undefined
      }
    ),
  ]),

  // --- E2: an order whose payment hasn't finished can't be refunded
  named('e2-order-refund-while-its-reader-payment-is-still-open', [
    difference(
      "E2: the refund is refused (`order_not_paid`) while the order's reader payment is still open, so nothing is given. The reader payment can then be cancelled as usual (the order undone and gone, its stock back), and a late tap finds no order. The old code gave £24 store credit, marked the order refunded, and left its payment unable to be cancelled or finalised",
      'E2 (E-plan section 3; W27 "For the Worker step": worse than planned); brief W28 item 2',
      [
        String.raw`^\.results\[0\]\.(orderId|pendingReaderPayment\.orderId)$`,
        result(1, 'success|refundedAmount|refundMethod|storeCreditRefundedAmount|storeCreditBalance|orderPaymentStatus|reason|message'),
        result(2, 'cancelled|orderId|reason|message'),
        result(3, 'orderId|reason|message'),
        String.raw`^\.stripeCalls\[0\]\.params\.(metadata\.order_id|description)$`,
        String.raw`^\.stripeCalls\[[12]\]$`,
        String.raw`^\.tables\.(customers|order_line_items|orders|product_variants|stock_adjustments|store_credit_transactions)$`,
      ],
      (value, _expected, path) => {
        if (path.startsWith('.results[1].')) return path.endsWith('.success') ? value === false : path.endsWith('.reason') ? value === 'order_not_paid' : path.endsWith('.message') ? said(/^This order's payment hasn't finished, so nothing on it can be refunded yet\./)(value) : value === undefined
        if (path === '.results[2].cancelled') return value === true
        if (path === '.results[2].reason') return value === undefined
        if (path === '.results[3].reason') return value === 'order_not_found'
        if (path.startsWith('.tables.')) return value === undefined
        if (path === '.stripeCalls[1]') return (value as { method?: string } | undefined)?.method === 'paymentIntents.retrieve'
        if (path === '.stripeCalls[2]') return (value as { method?: string } | undefined)?.method === 'paymentIntents.cancel'
        return true
      }
    ),
  ]),

  // --- W29, E10: the subscription's cancel fails after the refund
  named('order-refund-subscription-cancel-refused-after-the-money-went', [
    ORDER_CLAIM_KEYS,
    difference(
      "E10: the £40 went back to the card, then Stripe didn't confirm the cancel. The refund is finished like any other (the membership marked cancelled, the order `refunded`), the cancel is read back (still live), recorded as left, listed on the stuck list and retried by reconcile, and the answer says so. The old code answered \"needs a manual check\", left the membership active, and nothing listed the live subscription",
      W29_CANCEL_LAST,
      [result(1, 'warning|orderPaymentStatus'), String.raw`^\.stripeCalls\[5\]$`, MEMBERSHIP_STATUS],
      (value, _expected, path) => {
        if (path === '.results[1].warning') return said(CANCEL_LEFT)(value)
        if (path === '.results[1].orderPaymentStatus') return value === 'refunded'
        if (path === '.stripeCalls[5]') return isCancelRead(value)
        return value === 'cancelled'
      }
    ),
  ]),
  named('order-refund-subscription-cancel-refused-before-any-money-is-taken-back', [
    difference(
      "E10, to store credit: the £40 of store credit is given in R1 and stands, the membership is marked cancelled and the order `refunded`; the cancel Stripe didn't confirm is read back, recorded as left, listed and retried. The old code gave the £40, took it back when the cancel failed, and answered `refund_failed` with nothing done",
      W29_CANCEL_LAST,
      [
        result(1, 'success|reason|message|refundedAmount|refundMethod|storeCreditRefundedAmount|storeCreditBalance|orderPaymentStatus|warning'),
        String.raw`^\.stripeCalls\[4\]$`,
        MEMBERSHIP_STATUS,
        String.raw`^\.tables\.order_line_items\.added\[0\]\.(refunded_at|refund_method)$`,
        String.raw`^\.tables\.orders\.added\[0\]\.payment_status$`,
        String.raw`^\.tables\.store_credit_transactions\.added\[1\]$`,
        String.raw`^\.tables\.customers$`,
      ],
      (value, _expected, path) => {
        if (path.startsWith('.results[1].')) {
          if (path.endsWith('.success')) return value === true
          if (path.endsWith('.refundedAmount') || path.endsWith('.storeCreditRefundedAmount')) return value === 40
          if (path.endsWith('.refundMethod')) return value === 'credit'
          if (path.endsWith('.storeCreditBalance')) return value === 70
          if (path.endsWith('.orderPaymentStatus')) return value === 'refunded'
          if (path.endsWith('.warning')) return said(CANCEL_LEFT)(value)
          return value === undefined
        }
        if (path === '.stripeCalls[4]') return isCancelRead(value)
        if (path.endsWith('.subscription_status')) return value === 'cancelled'
        if (path.endsWith('.refunded_at')) return value === '<set>'
        if (path.endsWith('.refund_method')) return value === 'credit'
        if (path.endsWith('.payment_status')) return value === 'refunded'
        // The take-back row is never written: one store credit row (+£40), and the balance is £30 + £40.
        if (path.endsWith('.store_credit_transactions.added[1]')) return value === undefined
        const customers = value as { added?: unknown[]; changed?: Array<{ store_credit_balance?: unknown }>; removed?: unknown[] } | undefined
        return customers?.changed?.length === 1 && JSON.stringify(customers.changed[0]?.store_credit_balance) === JSON.stringify(['30.00', '70.00']) && customers.added?.length === 0 && customers.removed?.length === 0
      }
    ),
  ]),

  // --- W29, E3 (Q40): each line goes back to the card payment that took it
  named('e3-membership-and-robe-on-one-card-refunded-to-card', [
    ORDER_CLAIM_KEYS,
    difference(
      "E3 / Q40: the £40 membership was paid by the subscription's first invoice and the £10 robe by the order's own charge. The robe's Card refund comes from the robe's payment: £10 back on the card (the old code had already spent that £10 on the membership's refund, so the robe got £10 of store credit). The membership's Card refund is never taken from the robe's payment: this order was placed by the old createOrder, which recorded the membership's own payment nowhere, so Card is refused for it (`membership_payment_not_recorded`: store credit instead), nothing is cancelled, and the membership stays. On an order the Worker placed (every order since 11 Nov) the record names that payment and the £40 goes back to it: orders/membership-refund.test.ts, \"Q40: a £40 membership and £24 of soap\"",
      "Wayne's Q40 (14 Nov): each line goes back to the card payment that took it; bug E3; brief W29 items 1 and 4; Wayne's rule of 11 Nov (no work for an order only pre-go-live data can hold: no Stripe look-up for the old shape)",
      [
        result(1, 'success|refundedAmount|refundMethod|cardRefundedAmount|storeCreditRefundedAmount|storeCreditBalance|orderPaymentStatus|reason|message'),
        result(2, 'storeCreditRefundedAmount|storeCreditBalance|orderPaymentStatus|cardRefundedAmount'),
        String.raw`^\.stripeCalls\[5\]$`,
        MEMBERSHIP_STATUS,
        String.raw`^\.tables\.customers$`,
        String.raw`^\.tables\.order_line_items\.added\[[01]\]\.(refunded_at|refund_method|card_refunded_amount)$`,
        String.raw`^\.tables\.orders\.added\[0\]\.payment_status$`,
        String.raw`^\.tables\.store_credit_transactions$`,
      ],
      (value, _expected, path, recordings) => {
        if (path.startsWith('.results[1].')) {
          if (path.endsWith('.success')) return value === false
          if (path.endsWith('.reason')) return value === 'membership_payment_not_recorded'
          if (path.endsWith('.message')) return value === "This membership was paid by its own card payment, which this order doesn't name, so it can't go back to the card from here. Use store credit instead, or tell a manager."
          return value === undefined
        }
        if (path.startsWith('.results[2].')) {
          if (path.endsWith('.cardRefundedAmount')) return value === 10
          if (path.endsWith('.orderPaymentStatus')) return value === 'partially_refunded'
          return value === undefined
        }
        // The old code's cancel of the subscription: not sent, because the membership wasn't refunded.
        if (path === '.stripeCalls[5]') return value === undefined
        if (path.endsWith('.subscription_status')) return value === 'active'
        // No store credit at all: no row, and the customer's balance unchanged.
        if (path === '.tables.customers' || path === '.tables.store_credit_transactions') return value === undefined
        if (path.endsWith('.payment_status')) return value === 'partially_refunded'
        // The two lines, whichever comes first in the recording: the membership untouched, the robe £10 to the card.
        const index = Number(/added\[(\d)\]/.exec(path)?.[1])
        const line = (recordings.actual.tables['order_line_items']?.added ?? [])[index] as { item_type?: string } | undefined
        const robe = line?.item_type === 'addon'
        if (path.endsWith('.refunded_at')) return robe ? value === '<set>' : value === null
        if (path.endsWith('.refund_method')) return robe ? value === 'card' : value === null
        return robe ? value === '10.00' : value === '0.00'
      }
    ),
  ]),

  // --- W29, E4 (Q41): a used membership's future credit bookings are flagged in the same step
  named('e4-membership-refunded-in-full-after-a-credit-session', [
    ORDER_CLAIM_KEYS,
    difference(
      "E4 / Q41: the membership still refunds in full (£40), and its credit booking still to come is flagged payment needed, with a pay-by time, in the refund's own transaction. The old code left the booking confirmed, for Stripe's webhook to flag a moment later (the replay has no webhook, so the golden file shows it confirmed)",
      "Wayne's Q41 (14 Nov): a used membership can still be refunded, and its future credit bookings are flagged payment needed in the same step; bug E4; brief W29 items 1 and 2",
      [String.raw`^\.tables\.bookings\.added\[0\]\.(status|payment_due_by)$`],
      (value, _expected, path) => (path.endsWith('.status') ? value === 'payment_needed' : value === '<set>')
    ),
    // On its own, so that the row's allowance above fails as unused if the booking were ever left confirmed.
    difference(
      'Q41: the answer says how many future credit bookings the refund flagged (1), for the dialog to show after the press',
      "Wayne's Q41 (14 Nov); brief W29 item 2",
      [result(2, 'bookingsFlagged')],
      (value) => value === 1
    ),
  ]),
])
