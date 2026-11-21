// New in W47r (Wayne, 18 Nov 2026: "Try the payment again now"; the W47 review's point 10, all five points): a
// past-due member's failed renewal, charged from the desk.
//
// When a renewal fails, the member's credit bookings in the unpaid month are flagged payment needed and lapse at 72
// hours (migration 030, Q48). Replacing the card at the desk (W42) takes no payment, so they still lapse unless one
// of Stripe's own retries lands in time. This pays the subscription's open invoice there and then, on the card the
// Worker has recorded as the customer's saved card, on the pattern a card charge has had since step C and W41: the
// record first, one send under a key from the record, an unclear answer held, and reconcile only ever reading.
//
//   the quote (read only)   what the window shows: the amount, the card, what happens to the flagged bookings
//   R1  who may (Issue refunds, from the signed-in staff member); the membership's own row, read without a lock
//         refused -> nothing read from Stripe
//   S1  Stripe read now (review point 2): the subscription, then its newest invoice. Two reads, nothing sent.
//         `canceled`, a cancel date reached, not behind on a payment, the invoice not `open` -> refused
//         paid up with its newest invoice paid (one of Stripe's own retries got there first) -> no charge: straight
//           to the paid write (review point 3)
//   P1  one transaction, no Stripe: the customer's lock, then the membership's; the row read again
//         the card (review point 1): the subscription's default card, as S1 read it, must be the customer's saved
//           card as it is under the lock, and no card step of the customer's may be open, held or left for a person
//         taking turns (W40): no payment date change pending, no step open on the subscription, no other retry open
//         what the window showed: the invoice and the amount (Q18's rule)
//         the `started` row: the membership, the subscription, the invoice, the amount and the card
//   S2  ONE `invoices.pay` with `payment_method`, key `<retryId>:pay`. Never a second send for a record, by the
//       press, by reconcile or by anything else (review point 5): the same key sent again after Stripe drops it (24
//       hours) would be a new attempt, so the rule is that nothing ever sends for a record but this line.
//         paid -> the paid write
//         Stripe answered and said no -> the invoice is read: paid (already paid) -> the paid write; its payment
//           still at the bank or waiting on the customer -> HELD; else declined: the record ends, nothing is
//           written to the membership
//         no clear answer -> the invoice is read once: paid -> the paid write; anything else HELD (the send may
//           still land)
//   the paid write (review point 4): the webhook's own `invoice.paid` steps (dispatch.ts, recordInvoicePaid): the
//       subscription read now, `membership_mark_paid` only when it is paid up and the invoice is its newest (W46b),
//       read again after the write (L8). The flagged bookings go back to confirmed at once; the event, when it
//       arrives, finds nothing to change. A write that fails leaves the record held (`paid_not_recorded`).
//   reconcile (orders/reconcile.ts, reconcilePaymentRetry -> settlePaymentRetry), for a record still open: reads the
//       invoice and its payment, and nothing else. Paid -> the paid write, the record ends `paid`. Still open with
//       its payment ended and nothing taken (or void) -> the record ends `not_taken`. Its payment still at the bank
//       or waiting on the customer -> left, however long it takes. No time limit, and no close by hand for a payment
//       that can still land (W47a S2).
//
// W47r-a (the W47r review's S1 to S3):
//   S1  paid after the subscription ended. Stripe can end a subscription between the press's read of it and the one
//       send (its own dunning, or a manager), and a cancelled subscription's open invoice can still be paid. The paid
//       write then rightly marks nothing; until W47r-a the record ended `paid` all the same and the money was kept
//       with nothing listed. Now the record stays OPEN, held with the reason `paid_after_end`, at the press and in
//       reconcile alike: listed for a person, with one close, Mark refunded (markRetryRefunded), which reads the
//       payment's refunds in Stripe and ends the record `refunded` only when Stripe shows it refunded in full.
//       Nothing here sends a refund.
//   S2  recorded fast. Reconcile takes an open record as soon as it has a `held` row (the press has finished with
//       it); the window is only for a record with no `held` row (a press that may still be running). Inside the
//       window a run records a payment it finds paid, and never ends a record as not taken: a send that got no clear
//       answer may still land. The lapse sweep leaves a credit booking whose membership has an open record younger
//       than an hour (bookings/cancel.ts; retry-record.ts).
//   S3  the press confirms the card the window showed, as it does the invoice and the amount: refused
//       (`card_changed`) when it is no longer the customer's saved card under the lock.
//
// W47r-b (W47r-a "Noticed" 1): the paid write itself (recordInvoicePaid) now lists an invoice paid at or after the
//   moment its subscription ended, for the webhook and for this file alike (paid-after-end.ts). Here that is the
//   "already paid before the press" path, which has no record to hold. A retry WITH a record is not listed a second
//   time: while its record is open, or once it has ended `refunded`, the listing leaves the invoice to it (S1's hold
//   is unchanged). A row cancelled here while Stripe's subscription is still live says so on its `held` row
//   (`cancelledHere`), and its words add checking the subscription in Stripe.
//
// W47r-c (W47r-b "Noticed" 1 and 2): S1's hold goes by the same time rule as the line. The paid write says when the
//   payment was taken against the end (`detail.paid_after_end.why`): `paid_before_end` (before Stripe ended the
//   subscription) or `paid_before_last_day` (before the last day of a row ended here) is money that was owed, so the
//   record ends `paid` and nothing is listed. Paid at or after the end, or a time missing, is held as before. A
//   record once held for a person stays held whatever a later read shows: only Mark refunded ends it. And a renewal
//   Stripe takes for a row ended here is listed by the paid write itself (paid-after-end.ts), with no retry at all.
//
// No new table (lead call L6, as left.ts): the record is its `membership.payment_retried` audit rows, each naming the
// retry (`retryId`). `started` opens it; `held` is a note on an open one; `paid`, `declined`, `not_taken`, `not_sent`
// and `refunded` close it. A row is written under the membership's lock, and a closing row only while none is there.
//
// Money: the invoice is Stripe's own debt record, and Stripe never takes an invoice's amount twice (a paid invoice
// refuses a pay). The one-send rule is ours on top of that. Nothing here refunds: a decline took nothing, and money
// taken after the subscription ended is refunded by a person in Stripe.
import 'server-only'
import Stripe from 'stripe'
import { ENDED_IN_STRIPE, getSubscriptionLatestInvoiceId, recordInvoicePaid, type DispatchResult, type RpcClient, type SubscriptionReader } from '@/app/api/stripe/webhook/dispatch'
import type { ApiErrorCode, RetryPaymentInput, RetryPaymentOutput, RetryPaymentQuoteOutput, RetryPaymentRefusalDetails } from '@/contracts'
import { audit, type AuditEntry } from '@/server/audit'
import type { Db, Queryable, SqlParam } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StripeClient } from '@/server/stripe/client'
import { NoTimeLeft, sendOptions, stripeTiming, type StripeTiming } from '@/server/stripe/deadline'
import { readStripeFailure } from '@/server/stripe/outcome'
import { PROCESSING_MINUTES } from '@/server/rules/orders/pending-order'
import { PAYMENT_RETRY_CLOSE_WORDS, PAYMENT_RETRY_OWED_WORDS, PAYMENT_RETRY_REFUSALS, PAYMENT_RETRY_WORDS } from './failure-messages'
import { openSteps } from './left'
import { listPaidAfterEnd, readRefunds } from './paid-after-end'
import { londonDateOfSeconds, NOTHING_TAKEN, paymentStillGoingReason } from './payment-date'
import { formatIsoDate } from './payment-date-status'
import { PAYMENT_RETRY_ACTION, PAYMENT_RETRY_CLOSING_SQL, PAYMENT_RETRY_CLOSING_STATES, PAYMENT_RETRY_ENTITY, type PaymentRetryClosingState } from './retry-record'

// The record's names live in retry-record.ts (W47r-a), which imports nothing; they are exported from here as before.
export { PAYMENT_RETRY_ACTION, PAYMENT_RETRY_CLOSING_STATES, PAYMENT_RETRY_ENTITY }
/** What reconcile's `order.reconcile` rows for a retry are written against (the retry's own id). */
export const PAYMENT_RETRY_RECONCILE_ENTITY = 'payment_retry'
/** The one Stripe step of a retry, keyed `<retryId>:pay`. */
export const PAYMENT_RETRY_PAY_STEP = 'pay'
export const paymentRetryKey = (retryId: string): string => stripeIdempotencyKey(retryId, PAYMENT_RETRY_PAY_STEP)

type ClosingState = PaymentRetryClosingState
const CLOSING_SQL = PAYMENT_RETRY_CLOSING_SQL

/**
 * W47r-a (W47r review S1): why an open retry is held when its payment was taken after the membership's subscription
 * had ended. Written on the record's own `held` row, by the press or by reconcile; while it stands the retry is
 * listed for a person with Mark refunded.
 */
export const PAID_AFTER_END = 'paid_after_end'
/** What Mark refunded's close is called on the stuck list and at the close route. `orderId` there is the retry's id. */
export const PAID_AFTER_END_CLOSE_KIND = 'retry_paid_after_end'
/**
 * W47r-d: what Mark as owed's close is called on the stuck list (`closeOwed`) and at the close route: the second close
 * of the same line, for a payment that was for a period the member had. `orderId` is the retry's id, or the line's.
 */
export const PAID_AFTER_END_OWED_KIND = 'paid_after_end_owed'

/** A subscription whose newest invoice is still owed: what Stripe must show for a retry to be sent. */
const BEHIND: readonly Stripe.Subscription.Status[] = ['past_due', 'unpaid']
/** A subscription that is paid up (`trialing`: the days a payment date change adds), as the webhook has it. */
const PAID_UP: readonly Stripe.Subscription.Status[] = ['active', 'trialing']

// --- The membership's own row

interface Facts {
  id: string
  customer_id: string
  subscription_status: string | null
  stripe_subscription_id: string | null
  last_day: string | null
  last_day_passed: boolean | null
  next_renewal_date: string | null
  plan_name: string | null
  first_name: string | null
  last_name: string | null
  stripe_customer_id: string | null
  saved_payment_method_id: string | null
  saved_card_last4: string | null
  saved_card_brand: string | null
  bookings_waiting: number | string
  date_change_pending: boolean
}

/** The row, its customer's card, how many of its credit bookings are waiting for payment, and whether a date change is pending. `$1`: the membership. */
const FACTS_SQL = `
SELECT cm.id, cm.customer_id, cm.subscription_status, cm.stripe_subscription_id,
       cm.cancel_effective_date::text AS last_day,
       cm.cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date AS last_day_passed,
       cm.next_renewal_date::text AS next_renewal_date,
       mp.name AS plan_name, c.first_name, c.last_name,
       c.stripe_customer_id, c.saved_payment_method_id, c.saved_card_last4, c.saved_card_brand,
       (SELECT count(*)::int FROM bookings b
        WHERE b.redeemed_membership_id = cm.id AND b.redemption_source = 'membership_credit' AND b.status = 'payment_needed') AS bookings_waiting,
       EXISTS (SELECT 1 FROM membership_payment_date_changes p WHERE p.membership_id = cm.id AND p.status = 'pending') AS date_change_pending
FROM customer_memberships cm
JOIN membership_plans mp ON mp.id = cm.plan_id
JOIN customers c ON c.id = cm.customer_id
WHERE cm.id = $1::uuid`

const readFacts = async (db: Queryable, membershipId: string): Promise<Facts | null> => (await db.query<Facts>(FACTS_SQL, [membershipId]))[0] ?? null

/** The retries of a membership (`$1`, as text) still open: a `started` row with no closing row. */
const OPEN_RETRIES_SQL = `
SELECT s.details->>'retryId' AS retry_id
FROM audit_log s
WHERE s.action = '${PAYMENT_RETRY_ACTION}' AND s.entity_type = '${PAYMENT_RETRY_ENTITY}' AND s.entity_id = $1::text AND s.details->>'state' = 'started'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log e
    WHERE e.action = '${PAYMENT_RETRY_ACTION}' AND e.entity_type = '${PAYMENT_RETRY_ENTITY}' AND e.entity_id = s.entity_id
      AND e.details->>'retryId' = s.details->>'retryId' AND e.details->>'state' IN (${CLOSING_SQL})
  )`

type Refusal = { code: ApiErrorCode; reason: string; message: string; amountNow?: number }
const no = (code: ApiErrorCode, reason: string, message: string): Refusal => ({ code, reason, message })

function refusalError(action: RetryPaymentRefusalDetails['action'], refusal: Refusal): ApiError {
  const details: RetryPaymentRefusalDetails = { reason: refusal.reason, message: refusal.message, action, ...(refusal.amountNow !== undefined ? { amountNow: refusal.amountNow } : {}) }
  return new ApiError(refusal.code, refusal.message, { details })
}

/** What every later step needs of the row, once `rowRefusal` has passed. */
type Ready = Facts & { stripe_subscription_id: string; stripe_customer_id: string; saved_payment_method_id: string }

/** The row's own refusals, first to last: not past due, its last day passed, no subscription, no saved card. */
function rowRefusal(row: Facts): Refusal | null {
  if (row.subscription_status !== 'past_due') return no('CONFLICT', 'not_past_due', PAYMENT_RETRY_REFUSALS.notPastDue)
  if (row.last_day && row.last_day_passed === true) return no('CONFLICT', 'last_day_passed', PAYMENT_RETRY_REFUSALS.lastDayPassed(formatIsoDate(row.last_day)))
  if (!row.stripe_subscription_id) return no('CONFLICT', 'no_subscription', PAYMENT_RETRY_REFUSALS.noSubscription)
  if (!row.stripe_customer_id || !row.saved_payment_method_id) return no('CONFLICT', 'no_saved_card', PAYMENT_RETRY_REFUSALS.noSavedCard)
  return null
}

/**
 * The card and the turns (review points 1 and 3; W40), from the database alone. In the press it is asked under the
 * customer's lock and the membership's, which every action that leaves a card step, starts a date change or starts a
 * retry holds, so none of them can slip in between this and the `started` row.
 * - `defaultPaymentMethod`: the subscription's default card as Stripe showed it a moment ago.
 * - A card step of ANY of the customer's memberships that is open: still being sent, held past its window, or
 *   refused by Stripe and left for a person (`openSteps` lists all three until a closing row).
 */
async function cardAndTurnRefusal(db: Queryable, row: Ready, defaultPaymentMethod: string | null): Promise<Refusal | null> {
  if (defaultPaymentMethod !== row.saved_payment_method_id) return no('CONFLICT', 'card_not_moved', PAYMENT_RETRY_REFUSALS.cardNotMoved)
  const steps = await openSteps(db)
  if (steps.some((step) => step.kind === 'payment_method' && step.customerId === row.customer_id)) return no('CONFLICT', 'card_step_open', PAYMENT_RETRY_REFUSALS.cardStepOpen)
  if (row.date_change_pending) return no('CONFLICT', 'payment_date_changing', PAYMENT_RETRY_REFUSALS.paymentDateChanging)
  if (steps.some((step) => step.subscriptionId === row.stripe_subscription_id)) return no('CONFLICT', 'step_open', PAYMENT_RETRY_REFUSALS.stepOpen)
  if ((await db.query(OPEN_RETRIES_SQL, [row.id])).length > 0) return no('CONFLICT', 'retry_held', PAYMENT_RETRY_REFUSALS.retryHeld)
  return null
}

// --- Stripe, read now (S1)

const idOf = (value: string | { id: string } | null | undefined): string | null => (typeof value === 'string' ? value : (value?.id ?? null))
const explain = (err: unknown): string => (err instanceof Error ? err.message : String(err))

type Live =
  | { kind: 'refused'; refusal: Refusal }
  /** Paid up, with its newest invoice paid: one of Stripe's own retries got there first. Nothing is sent. */
  | { kind: 'already_paid'; invoiceId: string }
  /** Behind, with its newest invoice open: `amountPence` is still to pay on it. */
  | { kind: 'payable'; invoiceId: string; amountPence: number; defaultPaymentMethod: string | null }

/** A read that failed, as a refusal: nothing was sent, so nothing was charged. */
function unread(err: unknown): Live {
  if (err instanceof NoTimeLeft) return { kind: 'refused', refusal: no('CONFLICT', 'not_sent', PAYMENT_RETRY_REFUSALS.notSent) }
  if (readStripeFailure(err).code === 'resource_missing') return { kind: 'refused', refusal: no('CONFLICT', 'subscription_missing', PAYMENT_RETRY_REFUSALS.subscriptionMissing) }
  return { kind: 'refused', refusal: no('CONFLICT', 'not_read', PAYMENT_RETRY_REFUSALS.notRead) }
}

/**
 * S1 (review point 2): the subscription as Stripe has it now, then its newest invoice. The membership row's "past
 * due" is not enough: Stripe can leave a cancelled subscription's invoices open, and paying one charges a member
 * whose membership has ended. Two reads; nothing is sent. `nowMs`: the press's clock.
 */
async function readLive(stripe: StripeClient, row: Ready, timing: StripeTiming | undefined, nowMs: number): Promise<Live> {
  const refused = (reason: string, message: string): Live => ({ kind: 'refused', refusal: no('CONFLICT', reason, message) })
  let subscription: Stripe.Subscription
  try {
    subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id, undefined, sendOptions(timing))
  } catch (err) {
    return unread(err)
  }
  if (idOf(subscription.customer as string | { id: string } | null) !== row.stripe_customer_id) return refused('customer_mismatch', PAYMENT_RETRY_REFUSALS.customerMismatch)
  if (subscription.status === 'canceled') return refused('subscription_cancelled', PAYMENT_RETRY_REFUSALS.stripeCancelled)
  // A cancel date that has been reached: Stripe is about to end it (or has, and the status hasn't caught up).
  if (typeof subscription.cancel_at === 'number' && subscription.cancel_at * 1000 <= nowMs) {
    return refused('cancel_date_reached', PAYMENT_RETRY_REFUSALS.stripeCancelDateReached(formatIsoDate(londonDateOfSeconds(subscription.cancel_at))))
  }
  const paidUp = PAID_UP.includes(subscription.status)
  if (!paidUp && !BEHIND.includes(subscription.status)) return refused('not_behind', PAYMENT_RETRY_REFUSALS.stripeNotBehind(subscription.status))
  // The invoice to pay is the subscription's newest, and no other (W46b: its events are the ones that set the state).
  const invoiceId = getSubscriptionLatestInvoiceId(subscription)
  if (!invoiceId) return refused('no_invoice', PAYMENT_RETRY_REFUSALS.noInvoice)
  let invoice: Stripe.Invoice
  try {
    invoice = await stripe.invoices.retrieve(invoiceId, undefined, sendOptions(timing))
  } catch (err) {
    return unread(err)
  }
  if (paidUp) {
    // Review point 3: paid already, and the membership here hasn't caught up (the notice is late, or in error).
    if (invoice.status === 'paid') return { kind: 'already_paid', invoiceId }
    return refused('not_behind', PAYMENT_RETRY_REFUSALS.stripeNotBehind(subscription.status))
  }
  if (invoice.status !== 'open') return refused('invoice_not_open', PAYMENT_RETRY_REFUSALS.invoiceNotOpen(String(invoice.status)))
  if (invoice.currency !== 'gbp') return refused('not_pounds', PAYMENT_RETRY_REFUSALS.notPounds)
  if (!(invoice.amount_remaining > 0)) return refused('nothing_to_pay', PAYMENT_RETRY_REFUSALS.nothingToPay)
  return { kind: 'payable', invoiceId, amountPence: invoice.amount_remaining, defaultPaymentMethod: idOf(subscription.default_payment_method) }
}

// --- The quote

export interface RetryPaymentReadOptions {
  /** Made only once the row's own refusals have passed. */
  stripe: () => StripeClient
  /** The request's start, for the Stripe deadline. */
  startedAt: number
  /** The clock (tests). */
  now?: () => number
}

/**
 * What the window shows. Read only: the row, then Stripe's subscription and invoice, then the card and the turns from
 * the database (without the locks: the press asks again under them). Any active staff member; the press needs Issue
 * refunds. No such membership is NOT_FOUND.
 */
export async function retryPaymentQuote(db: Queryable, membershipId: string, options: RetryPaymentReadOptions): Promise<RetryPaymentQuoteOutput> {
  const row = await readFacts(db, membershipId)
  if (!row) throw refusalError('payment_retry_quote', no('NOT_FOUND', 'membership_not_found', PAYMENT_RETRY_REFUSALS.notFound))
  const waiting = Number(row.bookings_waiting)
  const base = {
    membershipId: row.id,
    customerId: row.customer_id,
    customerName: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
    planName: row.plan_name,
    cardBrand: row.saved_card_brand,
    cardLast4: row.saved_card_last4,
    // W47r-a (review S3): the card the window names, which the press sends back and the Worker checks under its lock.
    paymentMethodId: row.saved_payment_method_id,
    bookingsWaiting: waiting,
  }
  const refused = (refusal: Refusal, invoiceId: string | null = null, amount: number | null = null): RetryPaymentQuoteOutput => ({
    ...base,
    refusal: refusal.message,
    reason: refusal.reason,
    alreadyPaid: false,
    invoiceId,
    amount,
    ifPaid: PAYMENT_RETRY_WORDS.ifPaid(waiting),
  })
  const early = rowRefusal(row)
  if (early) return refused(early)
  const ready = row as Ready
  const now = options.now ?? Date.now
  const live = await readLive(options.stripe(), ready, stripeTiming(options.startedAt, now), now())
  if (live.kind === 'refused') return refused(live.refusal)
  if (live.kind === 'already_paid') return { ...base, refusal: null, reason: null, alreadyPaid: true, invoiceId: live.invoiceId, amount: 0, ifPaid: PAYMENT_RETRY_WORDS.ifAlreadyPaid(waiting) }
  const amount = live.amountPence / 100
  const turn = await cardAndTurnRefusal(db, ready, live.defaultPaymentMethod)
  if (turn) return refused(turn, live.invoiceId, amount)
  return { ...base, refusal: null, reason: null, alreadyPaid: false, invoiceId: live.invoiceId, amount, ifPaid: PAYMENT_RETRY_WORDS.ifPaid(waiting) }
}

// --- The record

export interface RetryPaymentActor {
  type: 'staff'
  id: string
  canIssueRefunds: boolean
}

export interface RetryPaymentOptions extends RetryPaymentReadOptions {
  actor: RetryPaymentActor
  requestId: string
}

export interface RetryBy {
  actor: { type: 'staff' | 'system'; id: string | null }
  requestId: string
}

/** What P1 writes on the `started` row: everything the send, the paid write and reconcile need, from the record alone. */
export interface PaymentRetryStarted {
  retryId: string
  state: 'started'
  channel: 'staff'
  customerId: string
  subscriptionId: string
  stripeCustomerId: string
  /** The subscription's newest invoice when the press read it: the one invoice this retry pays. */
  invoiceId: string
  /** Pounds still to pay on it then. */
  amount: number
  /** The card named on the one send: the customer's saved card as the Worker had it under the lock. */
  paymentMethodId: string
  cardBrand: string | null
  cardLast4: string | null
  /** The mode of the Stripe key the send goes with (true live), for reconcile's "not found" rule. */
  livemode: boolean | null
}

/** A retry as its later steps read it. */
export interface PaymentRetry {
  id: string
  membershipId: string
  started: PaymentRetryStarted
}

const entry = (retry: Pick<PaymentRetry, 'id' | 'membershipId'>, by: RetryBy, state: string, details: Record<string, unknown> = {}): AuditEntry => ({
  actorType: by.actor.type,
  actorId: by.actor.id,
  action: PAYMENT_RETRY_ACTION,
  entityType: PAYMENT_RETRY_ENTITY,
  entityId: retry.membershipId,
  requestId: by.requestId,
  details: { retryId: retry.id, state, ...details },
})

const MEMBERSHIP_CUSTOMER_SQL = 'SELECT customer_id FROM customer_memberships WHERE id = $1::uuid'
const LOCK_CUSTOMER_SQL = 'SELECT id FROM customers WHERE id = $1::uuid FOR NO KEY UPDATE'
const LOCK_MEMBERSHIP_SQL = 'SELECT id FROM customer_memberships WHERE id = $1::uuid FOR NO KEY UPDATE'

/**
 * P1: the checks again and the record, in one transaction under the customer's lock and then the membership's
 * (LOCK_ORDER). Throws the refusal; nothing is written then. `seen`: the row as S1 was asked about it.
 */
async function recordRetry(db: Db, seen: Ready, live: Live & { kind: 'payable' }, input: RetryPaymentInput, by: RetryBy, livemode: boolean | null): Promise<PaymentRetry> {
  const refuse = (refusal: Refusal): ApiError => refusalError('payment_retry', refusal)
  return db.transaction(async (tx) => {
    const owner = (await tx.query<{ customer_id: string }>(MEMBERSHIP_CUSTOMER_SQL, [seen.id]))[0]
    if (!owner) throw refuse(no('NOT_FOUND', 'membership_not_found', PAYMENT_RETRY_REFUSALS.notFound))
    await tx.query(LOCK_CUSTOMER_SQL, [owner.customer_id])
    await tx.query(LOCK_MEMBERSHIP_SQL, [seen.id])
    // Read in its own statement, after the locks (server/rules/README.md, "Locks before reads").
    const row = await readFacts(tx, seen.id)
    if (!row) throw refuse(no('NOT_FOUND', 'membership_not_found', PAYMENT_RETRY_REFUSALS.notFound))
    const early = rowRefusal(row)
    if (early) throw refuse(early)
    const locked = row as Ready
    // S1 was asked about this subscription of this Stripe customer: if either has changed since, its answer isn't about this row.
    if (locked.stripe_subscription_id !== seen.stripe_subscription_id || locked.stripe_customer_id !== seen.stripe_customer_id) {
      throw refuse(no('CONFLICT', 'changed_since', PAYMENT_RETRY_REFUSALS.changedSince))
    }
    const turn = await cardAndTurnRefusal(tx, locked, live.defaultPaymentMethod)
    if (turn) throw refuse(turn)
    // What the window showed (Q18's rule): the invoice, the amount to half a penny, and (W47r-a, review S3) the card.
    const shown = input.confirmed
    if (!shown?.invoiceId || typeof shown.amount !== 'number' || !Number.isFinite(shown.amount) || !shown.paymentMethodId) {
      throw refuse(no('VALIDATION', 'amount_not_confirmed', PAYMENT_RETRY_REFUSALS.figureMissing))
    }
    // S3: the card charged is the saved card as it is under this lock. If that is no longer the card the window named
    // (a second desk saved another card and its move went through meanwhile), nothing is charged: staff agreed the
    // card on screen with the customer, not this one.
    if (shown.paymentMethodId !== locked.saved_payment_method_id) throw refuse(no('CONFLICT', 'card_changed', PAYMENT_RETRY_REFUSALS.cardChanged))
    if (shown.invoiceId !== live.invoiceId) throw refuse(no('CONFLICT', 'invoice_changed', PAYMENT_RETRY_REFUSALS.invoiceChanged))
    const amount = live.amountPence / 100
    if (Math.round(Math.abs(shown.amount - amount) * 1000) > 5) {
      throw refuse({ code: 'TOTAL_CHANGED', reason: 'amount_changed', message: PAYMENT_RETRY_REFUSALS.amountChanged(shown.amount, amount), amountNow: amount })
    }
    const details = {
      channel: 'staff' as const,
      customerId: locked.customer_id,
      subscriptionId: locked.stripe_subscription_id,
      stripeCustomerId: locked.stripe_customer_id,
      invoiceId: live.invoiceId,
      amount,
      paymentMethodId: locked.saved_payment_method_id,
      cardBrand: locked.saved_card_brand,
      cardLast4: locked.saved_card_last4,
      livemode,
    }
    const retryId = crypto.randomUUID()
    const retry: PaymentRetry = { id: retryId, membershipId: locked.id, started: { retryId, state: 'started', ...details } }
    await audit.record(tx, entry(retry, by, 'started', { ...details, shown: { invoiceId: shown.invoiceId, amount: shown.amount, paymentMethodId: shown.paymentMethodId } }))
    return retry
  })
}

/** Whether a retry (`$1` the membership as text, `$2` the retry) has a closing row. */
const CLOSED_SQL = `
SELECT 1 FROM audit_log
WHERE action = '${PAYMENT_RETRY_ACTION}' AND entity_type = '${PAYMENT_RETRY_ENTITY}' AND entity_id = $1::text
  AND details->>'retryId' = $2::text AND details->>'state' IN (${CLOSING_SQL})
LIMIT 1`

/**
 * One more row for a retry, under the membership's lock and only while the retry is still open (no closing row):
 * its ending, or a `held` note. False when it was ended meanwhile (the press and a run can both get to it; one ends it).
 */
async function writeRow(db: Db, retry: PaymentRetry, by: RetryBy, state: ClosingState | 'held', details: Record<string, unknown>): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.query(LOCK_MEMBERSHIP_SQL, [retry.membershipId])
    if ((await tx.query(CLOSED_SQL, [retry.membershipId, retry.id])).length > 0) return false
    await audit.record(tx, entry(retry, by, state, details))
    return true
  })
}

// --- Stripe: the one send, and what the invoice shows afterwards

/** The request, built only from the record: the invoice, and the card named (review point 1). Off session: the customer isn't at a payment page. */
export function paymentRetryRequest(retry: PaymentRetry): Stripe.InvoicePayParams {
  return { payment_method: retry.started.paymentMethodId, off_session: true }
}

type Sent =
  | { outcome: 'answered'; invoice: Stripe.Invoice }
  /** Stripe answered and said no: this send took nothing. `stripeCode` is Stripe's own; `card`: the bank's no (a card error), not Stripe's own refusal of the request. */
  | { outcome: 'refused'; message: string; stripeCode: string | null; card: boolean }
  /** Never sent (no time left), or turned away before the endpoint ran (the key refused): nothing reached the invoice. */
  | { outcome: 'not_sent'; reason: 'not_sent' | 'key_refused'; detail: string }
  /** No clear answer: the money may have moved. */
  | { outcome: 'unknown'; detail: string }

const accessRefused = (err: unknown): boolean => err instanceof Stripe.errors.StripeAuthenticationError || err instanceof Stripe.errors.StripePermissionError

/**
 * S2: `invoices.pay`, once. This is the only place a retry is ever sent from, and it sends once: no second send with
 * the same key (W41's charge allows itself one), because the brief's rule is one send per record, whatever the key
 * would do (review point 5). An answer that isn't clear is settled by reading the invoice, never by sending again.
 */
async function payOnce(stripe: StripeClient, retry: PaymentRetry, timing: StripeTiming | undefined): Promise<Sent> {
  let options: Stripe.RequestOptions
  try {
    options = sendOptions(timing, { idempotencyKey: paymentRetryKey(retry.id) })
  } catch (err) {
    return { outcome: 'not_sent', reason: 'not_sent', detail: explain(err) }
  }
  try {
    return { outcome: 'answered', invoice: await stripe.invoices.pay(retry.started.invoiceId, paymentRetryRequest(retry), options) }
  } catch (err) {
    // A 401 or 403: Stripe turns the request away before the endpoint runs, so nothing was tried on the invoice.
    if (accessRefused(err)) return { outcome: 'not_sent', reason: 'key_refused', detail: explain(err) }
    const failure = readStripeFailure(err)
    if (failure.outcome === 'definite') return { outcome: 'refused', message: failure.message, stripeCode: failure.code, card: err instanceof Stripe.errors.StripeCardError }
    return { outcome: 'unknown', detail: `${failure.code ?? 'no code'}: ${failure.message}` }
  }
}

export type InvoiceState =
  | { kind: 'paid' }
  /** Not paid, and a payment of it hasn't ended: it may still take the money. `reason`: what it is waiting on. */
  | { kind: 'moving'; reason: 'payment_processing' | 'payment_needs_action' | 'unclear'; detail: string }
  /** Not paid, and every payment of it has ended with nothing taken (or it has none). */
  | { kind: 'not_taken'; detail: string }
  /** Stripe couldn't be read. `missing`: it answered that it has no such invoice or payment with the key in use. */
  | { kind: 'unread'; detail: string; missing: boolean }

/**
 * How an invoice stands in Stripe now (review point 3): reads only, the invoice with its payments and then each
 * payment's PaymentIntent. "Still open" is "not taken" only when no payment of it is `processing`, waiting on the
 * customer (`requires_action`) or in any other state that can still take money.
 */
export async function readInvoiceState(stripe: StripeClient, invoiceId: string, timing: StripeTiming | undefined): Promise<InvoiceState> {
  const failed = (err: unknown): InvoiceState => ({ kind: 'unread', detail: explain(err), missing: !(err instanceof NoTimeLeft) && readStripeFailure(err).code === 'resource_missing' })
  let invoice: Stripe.Invoice
  try {
    invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['payments'] }, sendOptions(timing))
  } catch (err) {
    return failed(err)
  }
  if (invoice.status === 'paid') return { kind: 'paid' }
  // More payments than one page holds: never seen for a subscription's invoice, and not something to conclude from.
  if (invoice.payments?.has_more) return { kind: 'moving', reason: 'unclear', detail: `invoice ${invoiceId} has more payments than were read` }
  const intentIds = (invoice.payments?.data ?? []).map((payment) => idOf(payment.payment?.payment_intent)).filter((id): id is string => id !== null)
  const payments: Array<{ id: string; status: string }> = []
  for (const id of intentIds) {
    try {
      payments.push({ id, status: (await stripe.paymentIntents.retrieve(id, undefined, sendOptions(timing))).status })
    } catch (err) {
      return failed(err)
    }
  }
  const said = (list: typeof payments): string => list.map((payment) => `${payment.id} ${payment.status}`).join(', ')
  const going = payments.filter((payment) => !NOTHING_TAKEN.has(payment.status))
  if (going.length === 0) return { kind: 'not_taken', detail: `invoice ${invoiceId} is ${String(invoice.status)}; ${payments.length > 0 ? said(payments) : 'it has no payment'}` }
  const notSucceeded = going.map((payment) => payment.status).filter((status) => status !== 'succeeded')
  // A payment that succeeded on an invoice Stripe doesn't show as paid yet: it will; read again.
  return { kind: 'moving', reason: notSucceeded.length === 0 ? 'unclear' : paymentStillGoingReason(notSucceeded), detail: `invoice ${invoiceId} is ${String(invoice.status)}; ${said(going)}` }
}

// --- The paid write (review point 4)

/** The two database functions the webhook's payment write can call, on the Worker's own connection. */
const PAYMENT_FUNCTIONS: Readonly<Record<string, { sql: string; params: readonly string[] }>> = {
  membership_mark_paid: {
    sql: 'SELECT public.membership_mark_paid(p_stripe_subscription_id => $1::text, p_period_end => $2::timestamptz) AS data',
    params: ['p_stripe_subscription_id', 'p_period_end'],
  },
  membership_mark_payment_failed: {
    sql: 'SELECT public.membership_mark_payment_failed(p_stripe_subscription_id => $1::text) AS data',
    params: ['p_stripe_subscription_id'],
  },
}

/**
 * The webhook's `rpc` on the Worker's database connection: as Supabase's, it never throws, and a failure comes back
 * as `error`. Only the two functions a payment's write calls; each is its own statement (the function locks the
 * membership's row itself).
 */
export function membershipRpc(db: Queryable): RpcClient {
  return {
    async rpc(fn, params = {}) {
      const known = PAYMENT_FUNCTIONS[fn]
      if (!known) return { data: null, error: new Error(`The retry's payment write has no function ${fn}.`) }
      try {
        const rows = await db.query<{ data: unknown }>(known.sql, known.params.map((name) => (params[name] ?? null) as SqlParam))
        const data = rows[0]?.data ?? null
        return { data: typeof data === 'string' ? JSON.parse(data) : data, error: null }
      } catch (err) {
        return { data: null, error: err }
      }
    },
  }
}

/** The reads the write makes, each inside the press's deadline (none for a run): the subscription, and (W47r-b) the invoice of one that has ended. */
const subscriptionReader = (stripe: StripeClient, timing: StripeTiming | undefined): SubscriptionReader => ({
  subscriptions: { retrieve: async (id) => stripe.subscriptions.retrieve(id, undefined, sendOptions(timing)) },
  invoices: { retrieve: async (id) => stripe.invoices.retrieve(id, undefined, sendOptions(timing)) },
})

/**
 * The webhook's own `invoice.paid` steps for this invoice (dispatch.ts, recordInvoicePaid), run now. Throws when
 * Stripe can't be read or the database fails: the caller leaves the retry held (`paid_not_recorded`). The mode is the
 * key's: only a test key ignores "no such subscription", as only a test-mode event does (W46b).
 * W47r-b: with the listing the webhook's route gives it (paid-after-end.ts), so an invoice paid after its
 * subscription had ended is listed for a refund by the same rule whichever of the two finds it first.
 */
function writePaid(db: Db, stripe: StripeClient, subscriptionId: string, invoiceId: string, timing: StripeTiming | undefined, by: RetryBy): Promise<DispatchResult> {
  return recordInvoicePaid(subscriptionReader(stripe, timing), membershipRpc(db), subscriptionId, invoiceId, stripe.keyLivemode !== false, listPaidAfterEnd(db, by, 'retry'))
}

/** W47r-b: what the write's listing answered (`detail.paid_after_end`), when the subscription had ended: why it was or wasn't listed. */
function listingOf(detail: Record<string, unknown>): string | null {
  const listing = detail['paid_after_end']
  return typeof listing === 'object' && listing !== null && typeof (listing as { why?: unknown }).why === 'string' ? (listing as { why: string }).why : null
}

/** Whether the write marked the membership paid, and how many flagged bookings it put back. */
function written(result: DispatchResult): { updated: boolean; restored: number; why: string | null } {
  const detail = result.detail ?? {}
  const updated = result.outcome === 'processed' && detail['action'] === 'reactivated'
  if (updated) return { updated, restored: Number(detail['bookings_restored'] ?? 0), why: null }
  const words = PAYMENT_RETRY_WORDS.notUpdated
  const reason = detail['reason']
  if (reason === 'subscription_not_paid_up') return { updated, restored: 0, why: words.subscription_not_paid_up(String(detail['status'] ?? 'not paid up'), listingOf(detail)) }
  if (reason === 'not_latest_invoice') return { updated, restored: 0, why: words.not_latest_invoice }
  if (reason === 'no_period_end') return { updated, restored: 0, why: words.no_period_end }
  if (reason === 'subscription_missing') return { updated, restored: 0, why: words.subscription_missing }
  if (detail['found'] === false) return { updated, restored: 0, why: words.not_found }
  if (detail['action'] === 'ignored_cancelled') return { updated, restored: 0, why: words.ignored_cancelled(listingOf(detail)) }
  return { updated, restored: 0, why: words.other }
}

/**
 * W47r-a (W47r review S1): the invoice is paid and the write found the membership ended, so the money has nothing to
 * pay for. What it found, for the record; null when the membership was marked paid or was left alone for any other
 * reason (a newer invoice, Stripe not caught up yet: those are not money to give back).
 * - Stripe shows the subscription `canceled` or `incomplete_expired`;
 * - the row here is cancelled (`ignored_cancelled`);
 * - no membership here has the subscription any more (`found: false`).
 * W47r-b (W47r-a "Noticed" 2): `cancelledHere` is the second of those, and only it. The write got as far as the
 * membership's row, so Stripe showed the subscription paid up a moment before: it is still live there and would bill
 * again next month, and the line's words add checking it.
 * W47r-c (W47r-b "Noticed" 1): the hold goes by the time rule the line goes by, which the write has already asked
 * (`detail.paid_after_end.why`). Taken before Stripe ended the subscription (`paid_before_end`), or before the last
 * day of a row ended here (`paid_before_last_day`): the money was owed, so null, and the record ends `paid`. Taken at
 * or after the end, or with a time missing (the write then answers anything else): held, as before.
 */
export function paidAfterEnd(result: DispatchResult): { found: string; cancelledHere: boolean } | null {
  const detail = result.detail ?? {}
  const timeRule = listingOf(detail)
  if (detail['reason'] === 'subscription_not_paid_up' && (ENDED_IN_STRIPE as readonly string[]).includes(String(detail['status']))) {
    return timeRule === 'paid_before_end' ? null : { found: `Stripe shows the subscription as ${String(detail['status'])}`, cancelledHere: false }
  }
  if (detail['action'] === 'ignored_cancelled') return timeRule === 'paid_before_last_day' ? null : { found: 'the membership here has ended', cancelledHere: true }
  if (detail['found'] === false) return { found: 'no membership here has the subscription any more', cancelledHere: false }
  return null
}

/** The press's answer once the invoice is paid, from the write and the row as it is afterwards. */
async function paidAnswer(
  db: Queryable,
  membershipId: string,
  paid: { retryId: string | null; invoiceId: string; amount: number; alreadyPaid: boolean; cardBrand: string | null; cardLast4: string | null },
  result: DispatchResult
): Promise<RetryPaymentOutput> {
  const after = await readFacts(db, membershipId).catch(() => null)
  const { updated, restored, why } = written(result)
  const stillWaiting = Number(after?.bookings_waiting ?? 0)
  const membership = updated
    ? PAYMENT_RETRY_WORDS.membershipActive(restored, stillWaiting, after?.next_renewal_date ? formatIsoDate(after.next_renewal_date) : null)
    : PAYMENT_RETRY_WORDS.membershipNotUpdated(why ?? PAYMENT_RETRY_WORDS.notUpdated.other)
  return {
    retryId: paid.retryId,
    invoiceId: paid.invoiceId,
    amountCharged: paid.alreadyPaid ? 0 : paid.amount,
    alreadyPaid: paid.alreadyPaid,
    cardBrand: paid.cardBrand,
    cardLast4: paid.cardLast4,
    membershipUpdated: updated,
    bookingsRestored: restored,
    bookingsWaiting: stillWaiting,
    subscriptionStatus: after?.subscription_status ?? null,
    nextRenewalDate: after?.next_renewal_date ?? null,
    message: paid.alreadyPaid ? PAYMENT_RETRY_WORDS.alreadyPaid(membership) : PAYMENT_RETRY_WORDS.paid(paid.amount, paid.cardBrand, paid.cardLast4, membership),
  }
}

// --- The press

type Outcome =
  | { kind: 'paid'; alreadyPaid: boolean; result: DispatchResult }
  /** The record ended with nothing taken. `reason` and `message` are what the press answers. */
  | { kind: 'ended'; code: ApiErrorCode; reason: string; message: string }
  /** Still open: reconcile settles it, by reading. */
  | { kind: 'held'; reason: string; message: string; detail: string; cancelledHere?: boolean }

const held = (reason: string, message: string, detail: string): Outcome => ({ kind: 'held', reason, message, detail })
const heldFor = (state: InvoiceState & { kind: 'moving' }): Outcome =>
  held(state.reason, state.reason === 'payment_processing' ? PAYMENT_RETRY_WORDS.heldProcessing : state.reason === 'payment_needs_action' ? PAYMENT_RETRY_WORDS.heldNeedsAction : PAYMENT_RETRY_WORDS.held, state.detail)

/**
 * The invoice is paid: the write, then the record's `paid` row. A write that fails holds the record for reconcile.
 * W47r-a (S1): a write that finds the membership ended holds it too, for a person: the record is never ended `paid`
 * for money that paid for nothing.
 * W47r-c: unless the write found the money was taken before the end (`paidAfterEnd` answers null): it was owed, and
 * the record ends `paid` with the write's answer on its row.
 */
async function settlePaid(db: Db, stripe: StripeClient, retry: PaymentRetry, by: RetryBy, timing: StripeTiming | undefined, how: 'press' | 'reconcile', alreadyPaid: boolean): Promise<Outcome> {
  const s = retry.started
  let result: DispatchResult
  try {
    result = await writePaid(db, stripe, s.subscriptionId, s.invoiceId, timing, by)
  } catch (err) {
    return held('paid_not_recorded', PAYMENT_RETRY_WORDS.paidNotRecorded, `invoice ${s.invoiceId} is paid; the membership's write failed: ${explain(err)}`)
  }
  const ended = paidAfterEnd(result)
  if (ended) {
    return { ...held(PAID_AFTER_END, PAYMENT_RETRY_WORDS.paidAfterEndAtThePress(s.amount, s.cardLast4, ended.cancelledHere), `invoice ${s.invoiceId} is paid; ${ended.found}`), ...(ended.cancelledHere ? { cancelledHere: true } : {}) }
  }
  // If this row can't be written the record stays open: a run reads the invoice as paid, makes the same write (it
  // changes nothing a second time) and writes it then.
  await writeRow(db, retry, by, 'paid', { how, invoiceId: s.invoiceId, amount: s.amount, alreadyPaid, membership: { outcome: result.outcome, ...(result.detail ?? {}) } }).catch(() => false)
  return { kind: 'paid', alreadyPaid, result }
}

/** The press, after P1 has committed: S2, then what the invoice shows. Never throws for Stripe. */
async function runRetry(db: Db, stripe: StripeClient, retry: PaymentRetry, by: RetryBy, timing: StripeTiming): Promise<Outcome> {
  const s = retry.started
  const sent = await payOnce(stripe, retry, timing)
  if (sent.outcome === 'not_sent') {
    // Nothing reached the invoice. A record that can't be ended stays open, and a run ends it once Stripe shows nothing taken.
    await writeRow(db, retry, by, 'not_sent', { reason: sent.reason, detail: sent.detail }).catch(() => false)
    return { kind: 'ended', code: 'CONFLICT', reason: sent.reason, message: sent.reason === 'key_refused' ? PAYMENT_RETRY_REFUSALS.keyRefused : PAYMENT_RETRY_REFUSALS.notSent }
  }
  if (sent.outcome === 'answered' && sent.invoice.status === 'paid') return settlePaid(db, stripe, retry, by, timing, 'press', false)
  // Anything else is settled by what the invoice shows now.
  const state = await readInvoiceState(stripe, s.invoiceId, timing)
  if (state.kind === 'paid') {
    // After a refusal: paid by something else first (review point 3). After no clear answer: this send, or something else.
    return settlePaid(db, stripe, retry, by, timing, 'press', sent.outcome === 'refused')
  }
  if (sent.outcome === 'unknown') {
    // The send may still land, whatever the invoice shows this second: held, and read again past the window.
    return held('payment_unconfirmed', PAYMENT_RETRY_WORDS.held, `${sent.detail}; ${state.kind === 'unread' ? `not read (${state.detail})` : state.detail}`)
  }
  if (state.kind === 'moving') return heldFor(state)
  if (state.kind === 'unread') return held('unclear', PAYMENT_RETRY_WORDS.held, `Stripe answered the payment (${sent.outcome === 'refused' ? sent.message : `invoice ${String(sent.invoice.status)}`}); the invoice was then not read: ${state.detail}`)
  // Stripe answered, and nothing of the invoice is still going: this send took nothing.
  const needsAuthentication = sent.outcome === 'refused' && sent.stripeCode === 'authentication_required'
  const stripeSaid = sent.outcome === 'refused' ? sent.message.trim().replace(/\.+$/, '') : PAYMENT_RETRY_WORDS.notCompleted(String(sent.invoice.status))
  await writeRow(db, retry, by, 'declined', { stripeCode: sent.outcome === 'refused' ? sent.stripeCode : null, stripeSaid, found: state.detail }).catch(() => false)
  // A card error is the bank's no. Anything else Stripe refused the request for is said as Stripe's, in its words.
  const byTheBank = sent.outcome === 'refused' && sent.card
  return {
    kind: 'ended',
    code: needsAuthentication ? 'PAYMENT_NEEDS_AUTHENTICATION' : 'PAYMENT_FAILED',
    reason: 'payment_failed',
    message: needsAuthentication ? PAYMENT_RETRY_WORDS.authenticationRequired : byTheBank ? PAYMENT_RETRY_WORDS.declined(stripeSaid) : PAYMENT_RETRY_WORDS.notTaken(stripeSaid),
  }
}

/**
 * "Try the payment again now". Answers a payment that went through (or one Stripe showed had already gone through);
 * throws the refusal otherwise. A payment with no clear end is PAYMENT_UNCONFIRMED and stays held for reconcile:
 * never press again for it (a new press is refused while it is held).
 */
export async function retryPayment(db: Db, membershipId: string, input: RetryPaymentInput, options: RetryPaymentOptions): Promise<RetryPaymentOutput> {
  const refuse = (refusal: Refusal): ApiError => refusalError('payment_retry', refusal)
  if (!options.actor.canIssueRefunds) throw refuse(no('FORBIDDEN', 'permission_denied', PAYMENT_RETRY_REFUSALS.permissionDenied))
  const by: RetryBy = { actor: { type: 'staff', id: options.actor.id }, requestId: options.requestId }
  const row = await readFacts(db, membershipId)
  if (!row) throw refuse(no('NOT_FOUND', 'membership_not_found', PAYMENT_RETRY_REFUSALS.notFound))
  const early = rowRefusal(row)
  if (early) throw refuse(early)
  const seen = row as Ready
  const stripe = options.stripe()
  const now = options.now ?? Date.now
  const timing = stripeTiming(options.startedAt, now)

  const live = await readLive(stripe, seen, timing, now())
  if (live.kind === 'refused') throw refuse(live.refusal)
  const card = { cardBrand: seen.saved_card_brand, cardLast4: seen.saved_card_last4 }
  if (live.kind === 'already_paid') {
    // Review point 3, found before anything was sent: no record to hold (nothing can be in flight), only the write
    // and one row saying who pressed and what it did. A write that fails changes nothing: the press says so.
    let result: DispatchResult
    try {
      result = await writePaid(db, stripe, seen.stripe_subscription_id, live.invoiceId, timing, by)
    } catch {
      throw refuse(no('CONFLICT', 'not_read', PAYMENT_RETRY_REFUSALS.notRead))
    }
    await db
      .transaction((tx) =>
        audit.record(tx, entry({ id: crypto.randomUUID(), membershipId: seen.id }, by, 'paid', { how: 'press', sent: false, alreadyPaid: true, invoiceId: live.invoiceId, subscriptionId: seen.stripe_subscription_id, amount: 0, membership: { outcome: result.outcome, ...(result.detail ?? {}) } }))
      )
      .catch(() => undefined)
    return paidAnswer(db, seen.id, { retryId: null, invoiceId: live.invoiceId, amount: 0, alreadyPaid: true, ...card }, result)
  }

  const retry = await recordRetry(db, seen, live, input, by, stripe.keyLivemode)
  let outcome: Outcome
  try {
    outcome = await runRetry(db, stripe, retry, by, timing)
  } catch (err) {
    // Anything unexpected after the record: held, never guessed at.
    outcome = held('unexpected', PAYMENT_RETRY_WORDS.held, explain(err))
  }
  const s = retry.started
  if (outcome.kind === 'paid') return paidAnswer(db, retry.membershipId, { retryId: retry.id, invoiceId: s.invoiceId, amount: s.amount, alreadyPaid: outcome.alreadyPaid, cardBrand: s.cardBrand, cardLast4: s.cardLast4 }, outcome.result)
  if (outcome.kind === 'ended') throw refuse(no(outcome.code, outcome.reason, outcome.message))
  // Held: the note is best effort (a run settles the record from Stripe whether or not it was written).
  await writeRow(db, retry, by, 'held', { reason: outcome.reason, detail: outcome.detail, ...(outcome.cancelledHere ? { cancelledHere: true } : {}) }).catch(() => false)
  const details: RetryPaymentRefusalDetails = { reason: outcome.reason, message: outcome.message, action: 'payment_retry', held: { retryId: retry.id } }
  throw new ApiError('PAYMENT_UNCONFIRMED', outcome.message, { details })
}

// --- Reconcile and the stuck list

/** Whether the retry of the `started` row `s` has a `held` row (`andReason`: with that reason). */
const heldRowSql = (andReason = ''): string => `EXISTS (
    SELECT 1 FROM audit_log h
    WHERE h.action = '${PAYMENT_RETRY_ACTION}' AND h.entity_type = '${PAYMENT_RETRY_ENTITY}' AND h.entity_id = s.entity_id
      AND h.details->>'retryId' = s.details->>'retryId' AND h.details->>'state' = 'held'${andReason})`

/**
 * W47r-a (W47r review S2 a): when an open retry is reconcile's to read and the stuck list's to show. As soon as it
 * has a `held` row: the press writes that last, so it has finished and a run can't race it. With none (the press may
 * still be running, or died before it could say), once it is older than the window (`$1` minutes).
 */
const TAKEN_UP_SQL = `(s.at < now() - make_interval(mins => $1::int) OR ${heldRowSql()})`

/** The open retries a run reads Stripe for (TAKEN_UP_SQL; `$1` the window in minutes), oldest first. */
export const PAYMENT_RETRIES_DUE_SQL = `
SELECT s.details->>'retryId' AS id
FROM audit_log s
WHERE s.action = '${PAYMENT_RETRY_ACTION}' AND s.entity_type = '${PAYMENT_RETRY_ENTITY}' AND s.details->>'state' = 'started'
  AND ${TAKEN_UP_SQL}
  AND NOT EXISTS (
    SELECT 1 FROM audit_log e
    WHERE e.action = '${PAYMENT_RETRY_ACTION}' AND e.entity_type = '${PAYMENT_RETRY_ENTITY}' AND e.entity_id = s.entity_id
      AND e.details->>'retryId' = s.details->>'retryId' AND e.details->>'state' IN (${CLOSING_SQL})
  )
ORDER BY s.at, s.details->>'retryId'`

/**
 * One retry's `started` row by its id (`$1`): the state of its closing row if it has one, whether it is past the
 * window (`$2` minutes), and whether it is held as paid after the subscription ended.
 */
const RETRY_SQL = `
SELECT s.entity_id AS membership_id, s.details AS started,
       (SELECT e.details->>'state' FROM audit_log e
        WHERE e.action = '${PAYMENT_RETRY_ACTION}' AND e.entity_type = '${PAYMENT_RETRY_ENTITY}' AND e.entity_id = s.entity_id
          AND e.details->>'retryId' = s.details->>'retryId' AND e.details->>'state' IN (${CLOSING_SQL})
        ORDER BY e.at LIMIT 1) AS closed_as,
       s.at < now() - make_interval(mins => $2::int) AS past_window,
       ${heldRowSql(` AND h.details->>'reason' = '${PAID_AFTER_END}'`)} AS paid_after_end
FROM audit_log s
WHERE s.action = '${PAYMENT_RETRY_ACTION}' AND s.entity_type = '${PAYMENT_RETRY_ENTITY}' AND s.details->>'state' = 'started' AND s.details->>'retryId' = $1::text
LIMIT 1`

export interface ReadPaymentRetry extends PaymentRetry {
  /** It has ended. `closedAs`: the state of the row that ended it. */
  closed: boolean
  closedAs: string | null
  /** Older than the window (W47r-a, S2): only then may a run end it as not taken. */
  pastWindow: boolean
  /** W47r-a (S1): its record has a `held` row saying the payment was taken after the subscription ended. */
  paidAfterEnd: boolean
}

/** One retry by its id: null when it was never recorded. `windowMinutes`: the window `pastWindow` is counted on. */
export async function readPaymentRetry(db: Queryable, retryId: string, windowMinutes: number = PROCESSING_MINUTES): Promise<ReadPaymentRetry | null> {
  const row = (await db.query<{ membership_id: string; started: PaymentRetryStarted; closed_as: string | null; past_window: boolean; paid_after_end: boolean }>(RETRY_SQL, [retryId, windowMinutes]))[0]
  if (!row || row.started?.state !== 'started' || !row.started.invoiceId || !row.started.subscriptionId) return null
  return { id: retryId, membershipId: row.membership_id, started: row.started, closed: row.closed_as !== null, closedAs: row.closed_as, pastWindow: row.past_window === true, paidAfterEnd: row.paid_after_end === true }
}

/**
 * The open retries a run reads (TAKEN_UP_SQL: the same ones, so nothing is being checked that the list doesn't show),
 * for the stuck list, with reconcile's last row for each and whether it is held as paid after the subscription ended.
 * `$1`: the window in minutes.
 */
export const PAYMENT_RETRIES_LISTED_SQL = `
SELECT s.details->>'retryId' AS id, s.entity_id AS membership_id, s.details->>'invoiceId' AS invoice_id,
       (s.details->>'amount')::numeric::text AS amount, s.details->>'cardBrand' AS card_brand, s.details->>'cardLast4' AS card_last4, s.at AS created_at,
       c.id AS customer_id, c.first_name, c.last_name,
       (SELECT r.details FROM audit_log r
        WHERE r.entity_type = '${PAYMENT_RETRY_RECONCILE_ENTITY}' AND r.entity_id = s.details->>'retryId' AND r.action = 'order.reconcile'
        ORDER BY r.at DESC LIMIT 1) AS last,
       (SELECT h.details->>'reason' FROM audit_log h
        WHERE h.action = '${PAYMENT_RETRY_ACTION}' AND h.entity_type = '${PAYMENT_RETRY_ENTITY}' AND h.entity_id = s.entity_id
          AND h.details->>'retryId' = s.details->>'retryId' AND h.details->>'state' = 'held'
        ORDER BY h.at DESC, h.id DESC LIMIT 1) AS held_reason,
       ${heldRowSql(` AND h.details->>'reason' = '${PAID_AFTER_END}'`)} AS paid_after_end,
       ${heldRowSql(` AND h.details->>'reason' = '${PAID_AFTER_END}' AND h.details->>'cancelledHere' = 'true'`)} AS cancelled_here
FROM audit_log s
JOIN customer_memberships cm ON cm.id::text = s.entity_id
JOIN customers c ON c.id = cm.customer_id
WHERE s.action = '${PAYMENT_RETRY_ACTION}' AND s.entity_type = '${PAYMENT_RETRY_ENTITY}' AND s.details->>'state' = 'started'
  AND ${TAKEN_UP_SQL}
  AND NOT EXISTS (
    SELECT 1 FROM audit_log e
    WHERE e.action = '${PAYMENT_RETRY_ACTION}' AND e.entity_type = '${PAYMENT_RETRY_ENTITY}' AND e.entity_id = s.entity_id
      AND e.details->>'retryId' = s.details->>'retryId' AND e.details->>'state' IN (${CLOSING_SQL})
  )
ORDER BY s.at, s.details->>'retryId'`

export interface ListedPaymentRetry {
  id: string
  membership_id: string
  invoice_id: string
  amount: string
  card_brand: string | null
  card_last4: string | null
  created_at: Date | string
  customer_id: string
  first_name: string
  last_name: string
  last: { outcome?: string; reason?: string; detail?: string | null } | null
  /** W53 (W47r review L3): why the press itself held the record (its newest `held` row's reason), or null when it wrote none. */
  held_reason?: string | null
  /** W47r-a (S1): its record has a `held` row saying the payment was taken after the subscription ended. */
  paid_after_end: boolean
  /** W47r-b: that row says the membership's row had ended here while Stripe's subscription was still live. */
  cancelled_here: boolean
}

/**
 * Why a held retry is listed. W47r-a (S1): `paid_after_end` whenever its record says so (the press's own row, so the
 * line is right before any run has looked, and stays right on a run that couldn't read Stripe). Otherwise what
 * reconcile last left it with, or that it hasn't looked yet.
 */
export function paymentRetryListedReason(row: Pick<ListedPaymentRetry, 'last' | 'paid_after_end' | 'held_reason'>): string {
  if (row.paid_after_end === true) return PAID_AFTER_END
  if (row.last?.outcome === 'left' && row.last.reason) return row.last.reason
  // W53 (W47r review L3; W47r "Noticed" 3): before any run has looked, the press's own reason when the press knew what
  // it was waiting on. Until W53 the line said "may or may not have been charged" for up to 5 minutes about a payment
  // the press had seen go through (`paid_not_recorded`), or seen waiting at the bank or on the customer.
  return row.held_reason && PRESS_KNEW.has(row.held_reason) ? row.held_reason : 'waiting'
}

/** The reasons a press holds a retry with when it knows what the payment is waiting on (each has its own stuck words). */
const PRESS_KNEW: ReadonlySet<string> = new Set(['paid_not_recorded', 'payment_processing', 'payment_needs_action'])

export type RetrySettled =
  /** The invoice is paid: the paid write was made and the record ended. */
  | { kind: 'paid'; detail: string }
  /** The invoice is not paid and nothing of it is still going: the record ended, nothing taken. */
  | { kind: 'not_taken'; detail: string }
  /** Still open: read again next run. */
  | { kind: 'left'; reason: string; detail: string }
  /** Ended by something else meanwhile, or never recorded. */
  | { kind: 'closed' }

/**
 * Reconcile's turn at one open retry. It reads the invoice and its payment, and nothing else: no send, no cancel, no
 * refund. Paid: the same write as the press (it changes nothing if the webhook, or the press, already made it), and
 * the record ends. Not paid with nothing still going: the record ends `not_taken`. A payment still at the bank or
 * waiting on the customer: left, with no limit on how long (W47a S2). Stripe not readable: left, and read next run;
 * "no such invoice" is `other_mode` when the key isn't of the record's own mode, else `invoice_missing`.
 *
 * W47r-a. S1: paid, and the write finds the membership ended: left as `paid_after_end`, with a `held` row on the
 * record saying so (once), which lists it for a person with Mark refunded; never ended `paid`. S2: a record younger
 * than the window (`windowMinutes`; a run has it early because the press wrote its `held` row) is never ended as not
 * taken: a send that got no clear answer may still land, and "nothing taken" a minute after it proves nothing. It is
 * left (`waiting`) until it is past the window, as every record was before a run could have it early.
 *
 * W47r-c: paid, and the write found the money was taken before the end: the record ends `paid` (it was owed). Not a
 * record that already has its `paid_after_end` row: that one stays for a person.
 */
export async function settlePaymentRetry(db: Db, stripe: StripeClient, retryId: string, by: RetryBy, timing: StripeTiming | undefined, windowMinutes: number = PROCESSING_MINUTES): Promise<RetrySettled> {
  const retry = await readPaymentRetry(db, retryId, windowMinutes)
  if (!retry || retry.closed) return { kind: 'closed' }
  const s = retry.started
  const state = await readInvoiceState(stripe, s.invoiceId, timing)
  if (state.kind === 'unread') {
    if (!state.missing) return { kind: 'left', reason: 'unclear', detail: state.detail }
    const sameMode = typeof s.livemode === 'boolean' && s.livemode === stripe.keyLivemode
    return { kind: 'left', reason: sameMode ? 'invoice_missing' : 'other_mode', detail: state.detail }
  }
  if (state.kind === 'moving') return { kind: 'left', reason: state.reason, detail: state.detail }
  if (state.kind === 'paid') {
    let result: DispatchResult
    try {
      result = await writePaid(db, stripe, s.subscriptionId, s.invoiceId, timing, by)
    } catch (err) {
      return { kind: 'left', reason: 'paid_not_recorded', detail: `invoice ${s.invoiceId} is paid; the membership's write failed: ${explain(err)}` }
    }
    const after = paidAfterEnd(result)
    // W47r-c: a record already held for a person stays held, whatever this read shows. Held because the row had ended
    // here, its subscription is then cancelled in Stripe (as the line's words ask), and the payment now reads as taken
    // "before the end" in Stripe: it was still taken after the membership ended here. Only Mark refunded ends it.
    if (!after && retry.paidAfterEnd) return { kind: 'left', reason: PAID_AFTER_END, detail: `invoice ${s.invoiceId} is paid; held for a refund since an earlier look, and only Mark refunded ends it` }
    if (after) {
      // S1: open, and held for a person. The note goes on the record once; if it can't be written the next run writes it.
      const detail = `invoice ${s.invoiceId} is paid; ${after.found}`
      if (!retry.paidAfterEnd) {
        try {
          if (!(await writeRow(db, retry, by, 'held', { reason: PAID_AFTER_END, detail, how: 'reconcile', ...(after.cancelledHere ? { cancelledHere: true } : {}) }))) return { kind: 'closed' }
        } catch (err) {
          return { kind: 'left', reason: 'close_failed', detail: explain(err) }
        }
      }
      return { kind: 'left', reason: PAID_AFTER_END, detail }
    }
    try {
      const ended = await writeRow(db, retry, by, 'paid', { how: 'reconcile', invoiceId: s.invoiceId, amount: s.amount, membership: { outcome: result.outcome, ...(result.detail ?? {}) } })
      return ended ? { kind: 'paid', detail: `invoice ${s.invoiceId} is paid${written(result).updated ? '; the membership was marked paid' : '; the membership was not changed'}` } : { kind: 'closed' }
    } catch (err) {
      return { kind: 'left', reason: 'close_failed', detail: explain(err) }
    }
  }
  // S2: not yet. Nothing is taken so far, and the send may still land.
  if (!retry.pastWindow) return { kind: 'left', reason: 'waiting', detail: `${state.detail}; not ended as not taken until it is ${windowMinutes} minutes old` }
  try {
    const ended = await writeRow(db, retry, by, 'not_taken', { how: 'reconcile', found: state.detail })
    return ended ? { kind: 'not_taken', detail: state.detail } : { kind: 'closed' }
  } catch (err) {
    return { kind: 'left', reason: 'close_failed', detail: explain(err) }
  }
}

// --- Mark refunded (W47r-a, W47r review S1): the one close of a retry held as paid after the subscription ended

// What Stripe shows refunded is read by `readRefunds` (paid-after-end.ts since W47r-b: a listed invoice's close makes the same read).

export type RetryRefundedAnswer = { closed: true; alreadyClosed?: boolean; message: string } | { closed: false; reason: string; message: string }

/**
 * Mark refunded (Issue refunds; the close route checks it): ends a retry held as paid after the subscription ended,
 * once a person has refunded the payment in Stripe. As W47b's Mark sorted, Stripe is read first, outside the
 * transaction (reads only; nothing is ever sent): the invoice's payments and their refunds. Refused, with nothing
 * changed, unless Stripe shows every payment that went through refunded in full by refunds that have succeeded (one
 * still on its way is not money back yet). Then, under the membership's lock and only while the record is still open:
 * its `refunded` row, with the refunds found, and the close's own row (`closeEntry`).
 */
export async function markRetryRefunded(
  db: Db,
  stripe: () => StripeClient,
  retryId: string,
  why: string,
  by: RetryBy,
  timing: StripeTiming | undefined,
  closeEntry: (retry: PaymentRetry, found: Record<string, unknown>) => AuditEntry
): Promise<RetryRefundedAnswer> {
  const words = PAYMENT_RETRY_CLOSE_WORDS
  const refused = (reason: string, message: string): RetryRefundedAnswer => ({ closed: false, reason, message })
  const retry = await readPaymentRetry(db, retryId)
  if (!retry) return refused('not_listed', words.notListed)
  if (retry.closed) return retry.closedAs === 'refunded' ? { closed: true, alreadyClosed: true, message: words.already } : refused('not_listed', words.notListed)
  if (!retry.paidAfterEnd) return refused('not_paid_after_end', words.notForAPerson)
  const s = retry.started
  const seen = await readRefunds(stripe(), s.invoiceId, timing)
  if (!seen) return refused('refunds_not_read', words.notRead)
  if (seen.payments.length === 0) return refused('payment_not_found', words.noPayment)
  if (!seen.inFull) return refused('not_refunded', words.notRefunded(seen.taken / 100, seen.refunded / 100, seen.onTheWay / 100))
  const found = { invoiceId: s.invoiceId, amount: s.amount, taken: seen.taken / 100, refunded: seen.refunded / 100, payments: seen.payments }
  return db.transaction(async (tx) => {
    await tx.query(LOCK_MEMBERSHIP_SQL, [retry.membershipId])
    // Read again under the lock: two presses queue, and the second finds the first's row.
    const now = await readPaymentRetry(tx, retryId)
    if (!now || now.closed) return now?.closedAs === 'refunded' ? { closed: true, alreadyClosed: true, message: words.already } : refused('not_listed', words.notListed)
    await audit.recordAll(tx, [entry(retry, by, 'refunded', { how: 'close', why, ...found }), closeEntry(retry, found)])
    return { closed: true, message: words.refunded(seen.taken / 100) }
  })
}

// --- Mark as owed (W47r-d): the second close of a retry held as paid after the end

export type RetryOwedAnswer = { closed: true; alreadyClosed?: boolean; message: string } | { closed: false; reason: string; message: string }

/**
 * W47r-d (W47r-c "Noticed" 3; W47r-b "Noticed" 4): Mark as owed (Issue refunds and a reason; the close route checks
 * both): ends a retry held as paid after the end when the payment was in fact for a period the member had. Stripe is
 * never called and nothing is sent. Under the membership's lock and only while the record is still open and held as
 * `paid_after_end`: its `owed` row, with the person's reason, and the close's own row (`closeEntry`). A record ended
 * `owed` still holds its invoice (paid-after-end.ts, RETRY_HOLDS_SQL), so the invoice is never listed again by a
 * notice sent later.
 */
export async function markRetryOwed(db: Db, retryId: string, why: string, by: RetryBy, closeEntry: (retry: PaymentRetry, found: Record<string, unknown>) => AuditEntry): Promise<RetryOwedAnswer> {
  const words = PAYMENT_RETRY_OWED_WORDS
  const refused = (reason: string, message: string): RetryOwedAnswer => ({ closed: false, reason, message })
  const ended = (retry: ReadPaymentRetry): RetryOwedAnswer => (retry.closedAs === 'owed' ? { closed: true, alreadyClosed: true, message: words.already } : refused('not_listed', words.notListed))
  const retry = await readPaymentRetry(db, retryId)
  if (!retry) return refused('not_listed', words.notListed)
  if (retry.closed) return ended(retry)
  if (!retry.paidAfterEnd) return refused('not_paid_after_end', words.notForAPerson)
  const s = retry.started
  const found = { invoiceId: s.invoiceId, amount: s.amount }
  return db.transaction(async (tx) => {
    await tx.query(LOCK_MEMBERSHIP_SQL, [retry.membershipId])
    // Read again under the lock: two presses queue, and the second finds the first's row.
    const now = await readPaymentRetry(tx, retryId)
    if (!now) return refused('not_listed', words.notListed)
    if (now.closed) return ended(now)
    if (!now.paidAfterEnd) return refused('not_paid_after_end', words.notForAPerson)
    await audit.recordAll(tx, [entry(retry, by, 'owed', { how: 'close', why, ...found }), closeEntry(retry, found)])
    return { closed: true, message: words.owed(s.amount) }
  })
}
