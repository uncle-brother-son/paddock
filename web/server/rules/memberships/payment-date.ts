// New in W41 (F-plan 4.4 and 4.10; brief W41 items 2 to 5; bugs FB1 to FB4; Q10 / lead call L8; Q18; R7): a monthly
// membership's payment date moved forward, with the part-month charge for the extra days. Ported from the staff app's
// changeMembershipPaymentDate.ts, getMembershipPaymentDateQuote.ts and shared/membershipPaymentDate.ts and the legacy
// route /api/memberships/change-payment-date, rebuilt on the pattern a saved-card charge has had since step C: the
// record first, every Stripe key from the record, an unclear answer held and reconciled, and the card never charged
// a second time.
//
//   the quote (read only)  the old quote, field for field
//   P1 (one transaction, no Stripe)
//      who may: staff with Issue refunds, from the signed-in staff member (FB20)
//      the customer's lock, then the membership's
//      every old refusal in the old order; the window; the figure; the six-month rule and its override
//      W41a: refused on the day the renewal is due, or after it (`renewal_due_today`), in the quote too
//      Q10: refused while this customer has a card order on hold
//      Q18 / FB4: the figure worked out now must be the one the dialog showed, to half a penny
//      no Stripe step of a cancel or undo still open on the subscription
//      the pending row: one per membership at a time; the `started` audit row, with everything a later step needs
//   S1  read the subscription: the legacy route's checks, the stale-date guard included
//         refused -> the row failed; nothing was charged
//   S2  charge the saved card once, key `<changeId>:charge`, `metadata.change_id`
//         declined -> the row failed; unclear -> HELD (reconcile lists the customer's payments; never charged again, FB1)
//   S3  move the billing date (`trial_end`, no proration), key `<changeId>:move`
//         refused -> a `refunding` mark, then the charge refunded once, key `<changeId>:refund`, watched (W32; FB3);
//                    the row failed
//         unclear -> held (reconcile reads the subscription: as asked -> P2; else S1's checks again and, passed, S3
//                    again; failed, the change didn't happen and the charge is refunded, W41a B1)
//   Reconcile's own sends (the move, the refund) go under a key of that run's own, `<changeId>:<step>:<requestId>`:
//   Stripe saves a 500 against a key and replays it, so the press's key could never get another answer (W41a B2).
//   P2 (one transaction)
//      the order (paid, card, the payment) and its membership line; next_renewal_date; the row done; the audit row (FB2)
//
// The customer's Stripe balance is never touched (R7): the charge is a plain card payment, not an invoice, and the
// date moves with `proration_behavior: 'none'`, so Stripe makes no credit or debit of its own.
//
// A pending row holds the membership (payment-date-status.ts, cancel.ts): no second date change, no cancel, no undo,
// and no 15-minute expiry. Only the press, reconcile (orders/reconcile.ts, reconcilePaymentDateChange) or the manual
// close ends it. No new table (lead call L6): the row is the record, and what its later steps need rides on its
// `membership.payment_date_changed` audit rows.
import 'server-only'
import Stripe from 'stripe'
import type { ApiErrorCode, ChangePaymentDateInput, ChangePaymentDateOutput, PaymentDateQuoteOutput } from '@/contracts'
import { audit, type AuditEntry } from '@/server/audit'
import type { Db, Queryable } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import { accountRefusal } from '@/server/rules/account/refusal'
import { pence } from '@/server/rules/orders/collect-saved-card'
import { PROCESSING_MINUTES } from '@/server/rules/orders/pending-order'
import { watchCompensationRefund } from '@/server/rules/refunds/refund-watch'
import { londonWallClockToUtc } from '@/server/rules/time/london-time'
import type { StripeClient } from '@/server/stripe/client'
import { NoTimeLeft, sendOptions, stripeTiming, type StripeTiming } from '@/server/stripe/deadline'
import { readStripeFailure } from '@/server/stripe/outcome'
import { PAYMENT_DATE_CLOSE_WORDS, PAYMENT_DATE_HELD_MESSAGE, PAYMENT_DATE_NEW_WORDS, PAYMENT_DATE_REFUSALS, PAYMENT_DATE_WORDS } from './failure-messages'
import { openSteps } from './left'
import { formatIsoDate, formatIsoDatesIn, PAYMENT_DATE_FACTS_COLUMNS_SQL, PAYMENT_DATE_FACTS_JOIN_SQL, paymentDateRefusal, type PaymentDateFacts } from './payment-date-status'

/** Every row about a change: `started`, `held`, `refunding`, `failed`, `done`, `closed`, each naming the change (`changeId`). */
export const PAYMENT_DATE_ACTION = 'membership.payment_date_changed'
export const PAYMENT_DATE_ENTITY = 'membership'
/** What reconcile's `order.reconcile` rows for a change are written against (the change's own id). */
export const PAYMENT_DATE_RECONCILE_ENTITY = 'payment_date_change'

/** The Stripe steps of a change, each keyed `<changeId>:<step>`. */
export const PAYMENT_DATE_CHARGE_STEP = 'charge'
export const PAYMENT_DATE_MOVE_STEP = 'move'
export const PAYMENT_DATE_REFUND_STEP = 'refund'
/** The step a change's compensation refund is watched under (refund-watch.ts). */
export const PAYMENT_DATE_REFUND_WATCH_STEP = 'payment-date-refund'

/** What every Stripe object of a change names in its metadata, so reconcile can find it. */
export const PAYMENT_DATE_METADATA = 'change_id'

export const paymentDateChargeKey = (changeId: string): string => stripeIdempotencyKey(changeId, PAYMENT_DATE_CHARGE_STEP)
/** `attempt` (reconcile's run): a later send is a request of its own, as a left step's (left.ts, stepKey): Stripe replays a saved 500 for a repeated key. */
export const paymentDateMoveKey = (changeId: string, attempt?: string): string => {
  const key = stripeIdempotencyKey(changeId, PAYMENT_DATE_MOVE_STEP)
  return attempt ? `${key}:${attempt}` : key
}
/**
 * `attempt` (reconcile's run, W41a B2): as the move's. A second refund can't come of it: the refund names no amount,
 * so it is whatever is left of the charge, and Stripe refuses one on a charge already refunded in full.
 */
export const paymentDateRefundKey = (changeId: string, attempt?: string): string => {
  const key = stripeIdempotencyKey(changeId, PAYMENT_DATE_REFUND_STEP)
  return attempt ? `${key}:${attempt}` : key
}

/** The old route's request to the penny: London midnight at the start of a date, in seconds (BST or GMT as that day has it). */
export const londonMidnightSeconds = (isoDate: string): number => Math.floor(londonWallClockToUtc(`${isoDate}T00:00:00.000Z`).getTime() / 1000)
/** The London date of a moment in seconds, YYYY-MM-DD. */
export const londonDateOfSeconds = (seconds: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(seconds * 1000))

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** A date the calendar has. The old quote took any YYYY-MM-DD digits and let Postgres throw on 30 February. */
const isRealDate = (date: string): boolean => DATE_RE.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date

// --- The quote

interface QuoteRow extends PaymentDateFacts {
  id: string
  customer_id: string
  plan_id: string
  price_monthly: string | null
  saved_card_last4: string | null
  saved_card_brand: string | null
  stripe_customer_id: string | null
  saved_payment_method_id: string | null
  earliest_date: string | null
  latest_date: string | null
  days_in_period: number | string | null
  extra_days: number | string | null
}

/** The old quote's statement (shared/membershipPaymentDate, loadPaymentDateQuote), with the customer's Stripe ids for the press. `$1`: the new date or null. */
const QUOTE_SQL = `
SELECT cm.id, cm.customer_id, cm.plan_id, cm.billing_frequency, cm.subscription_status, cm.stripe_subscription_id,
       mp.price_monthly::text AS price_monthly, c.saved_card_last4, c.saved_card_brand,
       c.stripe_customer_id, c.saved_payment_method_id,
       (cm.next_renewal_date + 1)::text AS earliest_date,
       ((cm.next_renewal_date + interval '1 month')::date - 1)::text AS latest_date,
       ((cm.next_renewal_date + interval '1 month')::date - cm.next_renewal_date) AS days_in_period,
       ($1::date - cm.next_renewal_date) AS extra_days,
       ${PAYMENT_DATE_FACTS_COLUMNS_SQL}
FROM customer_memberships cm
JOIN membership_plans mp ON mp.id = cm.plan_id
JOIN customers c ON c.id = cm.customer_id
${PAYMENT_DATE_FACTS_JOIN_SQL}
WHERE cm.id = $2::uuid`

const isoTime = (value: Date | string | null): string | null => (value === null ? null : value instanceof Date ? value.toISOString() : String(value))

/** The quote from its row: the old function's sums, to the penny. */
function quoteFrom(row: QuoteRow, newRenewalDate: string | undefined): PaymentDateQuoteOutput {
  const date = newRenewalDate !== undefined && isRealDate(newRenewalDate) ? newRenewalDate : null
  // W41a: the renewal day's own refusal, for the quote and the press (the lists read the rule without it).
  const refusal = paymentDateRefusal(row, true)
  const monthlyPrice = row.price_monthly !== null ? Number.parseFloat(row.price_monthly) : null
  const quote: PaymentDateQuoteOutput = {
    membershipId: row.id,
    customerId: row.customer_id,
    planId: row.plan_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    refusal: refusal ?? (monthlyPrice !== null && monthlyPrice > 0 ? null : PAYMENT_DATE_REFUSALS.noMonthlyPrice),
    needsOverride: row.pdc_within_six_months,
    lastChangedAt: isoTime(row.pdc_last_done_at),
    currentRenewalDate: row.pdc_next_renewal_date,
    earliestDate: row.earliest_date,
    latestDate: row.latest_date,
    daysInPeriod: row.days_in_period !== null ? Number(row.days_in_period) : null,
    monthlyPrice,
    cardLast4: row.saved_card_last4,
    cardBrand: row.saved_card_brand,
  }
  if (newRenewalDate !== undefined) {
    const extraDays = date !== null && row.extra_days !== null ? Number(row.extra_days) : null
    const days = quote.daysInPeriod
    if (!date || extraDays === null || !row.earliest_date || !row.latest_date || date < row.earliest_date || date > row.latest_date) {
      quote.dateError = row.earliest_date && row.latest_date ? PAYMENT_DATE_WORDS.chooseDate(formatIsoDate(row.earliest_date), formatIsoDate(row.latest_date)) : PAYMENT_DATE_WORDS.noRenewalDate
    } else if (days && monthlyPrice !== null) {
      const pricePence = Math.round(monthlyPrice * 100)
      quote.newRenewalDate = date
      quote.extraDays = extraDays
      quote.amount = Math.round((pricePence * extraDays) / days) / 100
    }
  }
  return quote
}

async function readQuoteRow(db: Queryable, membershipId: string, newRenewalDate: string | undefined): Promise<QuoteRow | null> {
  const date = newRenewalDate !== undefined && isRealDate(newRenewalDate) ? newRenewalDate : null
  return (await db.query<QuoteRow>(QUOTE_SQL, [date, membershipId]))[0] ?? null
}

/**
 * getMembershipPaymentDateQuote: whether a change is allowed, the window, and for a picked date the extra days and
 * the part-month charge. Read only; any active staff member. The old `null` for no such membership is NOT_FOUND.
 */
export async function paymentDateQuote(db: Queryable, membershipId: string, newRenewalDate?: string): Promise<PaymentDateQuoteOutput> {
  const row = await readQuoteRow(db, membershipId, newRenewalDate)
  if (!row) throw accountRefusal('NOT_FOUND', 'payment_date_quote', 'membership_not_found', PAYMENT_DATE_WORDS.notFound)
  return quoteFrom(row, newRenewalDate)
}

// --- The record

export interface PaymentDateActor {
  type: 'staff'
  id: string
  canIssueRefunds: boolean
}

export interface PaymentDateOptions {
  actor: PaymentDateActor
  requestId: string
  /** The request's start, for the Stripe deadline. */
  startedAt: number
  /** Made only once P1's checks have passed. */
  stripe: () => StripeClient
  /** The clock for the Stripe deadline (tests). */
  now?: () => number
}

export interface ChangeBy {
  actor: { type: 'staff' | 'system'; id: string | null }
  requestId: string
}

/** What P1 writes on the `started` row: everything S1 to P2 need, from the record alone. */
export interface PaymentDateStarted {
  changeId: string
  state: 'started'
  channel: 'staff'
  customerId: string
  planId: string
  subscriptionId: string
  stripeCustomerId: string
  paymentMethodId: string
  /** The mode of the Stripe key the charge goes with (true live), for reconcile's "nothing found" rule. */
  livemode: boolean | null
  oldRenewalDate: string
  newRenewalDate: string
  extraDays: number
  /** Pounds. */
  amount: number
  /** What S3 sets: London midnight at the start of the new date, in seconds. */
  trialEnd: number
  description: string
}

/** A change as its later steps read it: the row, and what P1 recorded (null for a row the Worker didn't start). */
export interface PaymentDateChange {
  id: string
  membershipId: string
  status: 'pending' | 'done' | 'failed'
  paymentIntentId: string | null
  orderId: string | null
  createdAt: string
  started: PaymentDateStarted | null
  /** A `refunding` mark: S3 was refused and the refund may have been sent. Never S3 again. */
  refunding: { paymentIntentId: string; stripeSaid: string } | null
  /** Stripe refused the refund for good: for a person, never sent again. */
  refundRefused: boolean
}

const CHANGE_SQL = `
SELECT p.id, p.membership_id, p.status, p.stripe_payment_intent_id, p.order_id, p.created_at,
       (SELECT s.details FROM audit_log s
        WHERE s.action = '${PAYMENT_DATE_ACTION}' AND s.entity_type = '${PAYMENT_DATE_ENTITY}' AND s.entity_id = p.membership_id::text
          AND s.details->>'changeId' = p.id::text AND s.details->>'state' = 'started'
        LIMIT 1) AS started,
       (SELECT m.details FROM audit_log m
        WHERE m.action = '${PAYMENT_DATE_ACTION}' AND m.entity_type = '${PAYMENT_DATE_ENTITY}' AND m.entity_id = p.membership_id::text
          AND m.details->>'changeId' = p.id::text AND m.details->>'state' = 'refunding'
        LIMIT 1) AS refunding,
       EXISTS (SELECT 1 FROM audit_log h
        WHERE h.action = '${PAYMENT_DATE_ACTION}' AND h.entity_type = '${PAYMENT_DATE_ENTITY}' AND h.entity_id = p.membership_id::text
          AND h.details->>'changeId' = p.id::text AND h.details->>'state' = 'held' AND h.details->>'reason' = 'refund_refused') AS refund_refused
FROM membership_payment_date_changes p
WHERE p.id = $1::uuid`

interface ChangeRow {
  id: string
  membership_id: string
  status: PaymentDateChange['status']
  stripe_payment_intent_id: string | null
  order_id: string | null
  created_at: Date | string
  started: PaymentDateStarted | null
  refunding: { paymentIntentId?: string; stripeSaid?: string } | null
  refund_refused: boolean
}

/** One change by its id, or null. */
export async function readPaymentDateChange(db: Queryable, changeId: string): Promise<PaymentDateChange | null> {
  const row = (await db.query<ChangeRow>(CHANGE_SQL, [changeId]))[0]
  if (!row) return null
  return {
    id: row.id,
    membershipId: row.membership_id,
    status: row.status,
    paymentIntentId: row.stripe_payment_intent_id,
    orderId: row.order_id,
    createdAt: isoTime(row.created_at) ?? '',
    started: row.started?.state === 'started' ? row.started : null,
    refunding: row.refunding?.paymentIntentId ? { paymentIntentId: row.refunding.paymentIntentId, stripeSaid: row.refunding.stripeSaid ?? '' } : null,
    refundRefused: row.refund_refused === true,
  }
}

type Started = PaymentDateChange & { started: PaymentDateStarted }

const entry = (change: Pick<PaymentDateChange, 'id' | 'membershipId'>, by: ChangeBy, state: string, details: Record<string, unknown> = {}) => ({
  actorType: by.actor.type,
  actorId: by.actor.id,
  action: PAYMENT_DATE_ACTION,
  entityType: PAYMENT_DATE_ENTITY,
  entityId: change.membershipId,
  requestId: by.requestId,
  details: { changeId: change.id, state, ...details },
})

const MEMBERSHIP_CUSTOMER_SQL = 'SELECT customer_id FROM customer_memberships WHERE id = $1::uuid'
const LOCK_CUSTOMER_SQL = 'SELECT id FROM customers WHERE id = $1::uuid FOR NO KEY UPDATE'
const LOCK_MEMBERSHIP_SQL = 'SELECT id FROM customer_memberships WHERE id = $1::uuid FOR NO KEY UPDATE'
const LOCK_CHANGE_SQL = 'SELECT status, order_id, stripe_payment_intent_id FROM membership_payment_date_changes WHERE id = $1::uuid FOR UPDATE'

/**
 * Q10 (lead call L8): the order's own test (orders/load-basket.ts, `has_order_processing`), word for word: a Worker
 * card or reader order still pending, however old, or any other pending order for 15 minutes. Read after the
 * customer's lock, so a card order placed at the same moment is seen. payment-date.test.ts holds the two together.
 */
export const ORDER_PROCESSING_SQL = `
SELECT EXISTS (
  SELECT 1 FROM orders o
  WHERE o.customer_id = $1::uuid AND o.payment_status = 'pending'
    AND (o.reader_payment->>'method' IN ('card', 'reader') OR o.created_at > now() - interval '${PROCESSING_MINUTES} minutes')) AS processing`

/** The pending row, written only while the membership has none (the old statement's own guard, with no expiry). */
const INSERT_PENDING_SQL = `
INSERT INTO membership_payment_date_changes
  (membership_id, old_renewal_date, new_renewal_date, extra_days, amount_charged, staff_id, override_reason, status)
SELECT $1::uuid, $2::date, $3::date, $4::int, $5::numeric, $6::uuid, $7::text, 'pending'
WHERE NOT EXISTS (SELECT 1 FROM membership_payment_date_changes WHERE membership_id = $1::uuid AND status = 'pending')
RETURNING id, created_at`

const refuse = (code: ApiErrorCode, reason: string, message: string): ApiError => accountRefusal(code, 'payment_date', reason, message)

/** A held change's refusal: PAYMENT_UNCONFIRMED, naming the record so the screen can say what is on hold. */
function heldError(changeId: string, reason: string, message: string): ApiError {
  return new ApiError('PAYMENT_UNCONFIRMED', message, { details: { reason, message, action: 'payment_date', held: { changeId } } })
}

/**
 * P1: the checks and the record, in one transaction under the customer's lock and then the membership's. Throws the
 * refusal; nothing is written then. Answers the change with what its later steps need, and the Stripe client.
 */
async function recordChange(db: Db, membershipId: string, input: ChangePaymentDateInput, options: PaymentDateOptions): Promise<{ change: Started; stripe: StripeClient }> {
  const newRenewalDate = input.newRenewalDate ?? ''
  const overrideReason = input.overrideReason?.trim() ?? ''
  return db.transaction(async (tx) => {
    // The customer first, then the membership (LOCK_ORDER). A membership's customer never changes.
    const owner = (await tx.query<{ customer_id: string }>(MEMBERSHIP_CUSTOMER_SQL, [membershipId]))[0]
    if (!owner) throw refuse('NOT_FOUND', 'membership_not_found', PAYMENT_DATE_WORDS.notFound)
    await tx.query(LOCK_CUSTOMER_SQL, [owner.customer_id])
    await tx.query(LOCK_MEMBERSHIP_SQL, [membershipId])
    // Read in its own statement, after the locks (server/rules/README.md, "Locks before reads").
    const row = await readQuoteRow(tx, membershipId, newRenewalDate)
    if (!row) throw refuse('NOT_FOUND', 'membership_not_found', PAYMENT_DATE_WORDS.notFound)
    const quote = quoteFrom(row, newRenewalDate)
    // Every old refusal, in the old order.
    if (quote.refusal) throw refuse('CONFLICT', quote.refusal === PAYMENT_DATE_NEW_WORDS.renewalDueToday ? 'renewal_due_today' : 'refused', quote.refusal)
    if (quote.dateError) throw refuse('CONFLICT', 'date_out_of_range', quote.dateError)
    if (!quote.stripeSubscriptionId || !quote.currentRenewalDate || quote.extraDays === undefined || quote.amount === undefined || !row.stripe_customer_id || !row.saved_payment_method_id) {
      throw refuse('CONFLICT', 'cannot_work_out', PAYMENT_DATE_WORDS.cannotWorkOut)
    }
    if (!(quote.amount > 0)) throw refuse('CONFLICT', 'nothing_to_charge', PAYMENT_DATE_WORDS.nothingToCharge)
    if (quote.needsOverride && !(input.override === true && overrideReason)) throw refuse('CONFLICT', 'override_needed', PAYMENT_DATE_WORDS.overrideNeeded)
    // Q10: a new saved-card charge while this customer has a card order on hold.
    if ((await tx.query<{ processing: boolean }>(ORDER_PROCESSING_SQL, [row.customer_id]))[0]?.processing === true) {
      throw refuse('CONFLICT', 'order_still_processing', PAYMENT_DATE_NEW_WORDS.orderStillProcessing)
    }
    // Q18 / FB4: the figure staff were shown. Half a penny either way.
    const shown = input.confirmed?.amount
    if (typeof shown !== 'number' || !Number.isFinite(shown)) throw refuse('VALIDATION', 'amount_not_confirmed', PAYMENT_DATE_NEW_WORDS.figureMissing)
    if (Math.round(Math.abs(shown - quote.amount) * 1000) > 5) {
      const message = PAYMENT_DATE_NEW_WORDS.figureChanged(shown, quote.amount)
      throw new ApiError('TOTAL_CHANGED', message, { details: { reason: 'amount_changed', message, action: 'payment_date', quote } })
    }
    // A cancel or undo whose Stripe step is still open: Stripe may not yet show what the membership says.
    if ((await openSteps(tx)).some((step) => step.subscriptionId === quote.stripeSubscriptionId)) throw refuse('CONFLICT', 'step_open', PAYMENT_DATE_NEW_WORDS.stepOpen)

    const stripe = options.stripe()
    const inserted = (
      await tx.query<{ id: string; created_at: Date | string }>(INSERT_PENDING_SQL, [
        membershipId,
        quote.currentRenewalDate,
        newRenewalDate,
        quote.extraDays,
        quote.amount,
        options.actor.id,
        quote.needsOverride ? overrideReason : null,
      ])
    )[0]
    // The quote refuses first while one is pending; this is the statement's own guard, with the press's sentence.
    if (!inserted) throw refuse('CONFLICT', 'in_progress', PAYMENT_DATE_WORDS.inProgress)
    const details = {
      channel: 'staff' as const,
      customerId: row.customer_id,
      planId: row.plan_id,
      subscriptionId: quote.stripeSubscriptionId,
      stripeCustomerId: row.stripe_customer_id,
      paymentMethodId: row.saved_payment_method_id,
      livemode: stripe.keyLivemode,
      oldRenewalDate: quote.currentRenewalDate,
      newRenewalDate,
      extraDays: quote.extraDays,
      amount: quote.amount,
      trialEnd: londonMidnightSeconds(newRenewalDate),
      description: PAYMENT_DATE_WORDS.chargeDescription(quote.extraDays),
    }
    const started: PaymentDateStarted = { changeId: inserted.id, state: 'started', ...details }
    const change: Started = { id: inserted.id, membershipId, status: 'pending', paymentIntentId: null, orderId: null, createdAt: isoTime(inserted.created_at) ?? '', started, refunding: null, refundRefused: false }
    await audit.record(tx, entry(change, { actor: options.actor, requestId: options.requestId }, 'started', { ...details, shown, override: quote.needsOverride ? { reason: overrideReason } : null }))
    return { change, stripe }
  })
}

// --- Ending a change

const FAIL_CHANGE_SQL = `
UPDATE membership_payment_date_changes
SET status = 'failed', failure_message = $1::text, stripe_payment_intent_id = COALESCE($2::text, stripe_payment_intent_id)
WHERE id = $3::uuid AND status = 'pending'`

/**
 * The row failed, in one transaction under the membership's lock and then the row's: only while it is still pending.
 * `refund`: the compensation refund Stripe accepted, which gets its watch in the same transaction (W32, FB3). False
 * when the row was no longer pending (another press, reconcile or the close ended it first).
 */
export async function failPaymentDateChange(
  db: Db,
  change: PaymentDateChange,
  by: ChangeBy,
  failure: {
    at: 'subscription' | 'charge' | 'move' | 'reconcile' | 'close'
    message: string
    paymentIntentId?: string | null
    refund?: { refundId: string; status: string | null; amountPence: number | null }
    extra?: Record<string, unknown>
    /** More rows for the same transaction (the manual close's `order.close` row). */
    also?: readonly AuditEntry[]
  }
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.query(LOCK_MEMBERSHIP_SQL, [change.membershipId])
    const row = (await tx.query<{ status: string }>(LOCK_CHANGE_SQL, [change.id]))[0]
    if (row?.status !== 'pending') return false
    await tx.query(FAIL_CHANGE_SQL, [failure.message, failure.paymentIntentId ?? null, change.id])
    await audit.record(
      tx,
      entry(change, by, failure.at === 'close' ? 'closed' : 'failed', {
        at: failure.at,
        message: failure.message,
        paymentIntentId: failure.paymentIntentId ?? null,
        ...(failure.refund ? { refundId: failure.refund.refundId, refundStatus: failure.refund.status } : {}),
        ...(failure.extra ?? {}),
      })
    )
    if (failure.also && failure.also.length > 0) await audit.recordAll(tx, failure.also)
    if (failure.refund && failure.paymentIntentId) {
      await watchCompensationRefund(
        tx,
        { refundId: failure.refund.refundId, paymentIntentId: failure.paymentIntentId, amountPence: failure.refund.amountPence, status: failure.refund.status, step: PAYMENT_DATE_REFUND_WATCH_STEP },
        change.id,
        change.started?.livemode ?? null,
        by
      )
    }
    return true
  })
}

/** A `held` or `refunding` row for a change still pending, under the membership's lock. False when it isn't pending any more. */
async function markChange(db: Db, change: PaymentDateChange, by: ChangeBy, state: 'held' | 'refunding', details: Record<string, unknown>): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.query(LOCK_MEMBERSHIP_SQL, [change.membershipId])
    const row = (await tx.query<{ status: string }>(LOCK_CHANGE_SQL, [change.id]))[0]
    if (row?.status !== 'pending') return false
    await audit.record(tx, entry(change, by, state, details))
    return true
  })
}

/** The payment onto the row on its own, best effort, so the stuck list and a person can name it. Reconcile finds it by listing either way. */
const RECORD_INTENT_SQL = "UPDATE membership_payment_date_changes SET stripe_payment_intent_id = $2::text WHERE id = $1::uuid AND status = 'pending' AND stripe_payment_intent_id IS NULL"

const INSERT_ORDER_SQL = `
INSERT INTO orders (customer_id, order_total, payment_status, stripe_payment_intent_id, order_source, payment_method)
VALUES ($1::uuid, $2::numeric, 'paid', $3::text, 'staff_created', 'card')
RETURNING id`
const INSERT_LINE_SQL = `
INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, membership_plan_id)
VALUES ($1::uuid, 'membership', 1, $2::numeric, $2::numeric, $3::uuid)`
const MOVE_RENEWAL_SQL = 'UPDATE customer_memberships SET next_renewal_date = $1::date, updated_at = now() WHERE id = $2::uuid'
const DONE_CHANGE_SQL = "UPDATE membership_payment_date_changes SET status = 'done', stripe_payment_intent_id = $1::text, order_id = $2::uuid WHERE id = $3::uuid AND status = 'pending'"

export type FinishedChange = { finished: true; orderId: string | null; paymentIntentId: string | null; already: boolean } | { finished: false; status: string }

/**
 * P2 (FB2): the charge as its own order (paid, card, the payment) with one membership line, the membership's new
 * date, the row done and its audit row, all or nothing, under the membership's lock and then the row's. Run once:
 * a row already done answers its order; one already failed (closed by hand meanwhile) is left as it is.
 */
export async function finishPaymentDateChange(db: Db, change: Started, paymentIntentId: string, by: ChangeBy, how: 'press' | 'reconcile'): Promise<FinishedChange> {
  return db.transaction(async (tx): Promise<FinishedChange> => {
    await tx.query(LOCK_MEMBERSHIP_SQL, [change.membershipId])
    const row = (await tx.query<{ status: string; order_id: string | null; stripe_payment_intent_id: string | null }>(LOCK_CHANGE_SQL, [change.id]))[0]
    if (!row) return { finished: false, status: 'gone' }
    if (row.status === 'done') return { finished: true, orderId: row.order_id, paymentIntentId: row.stripe_payment_intent_id, already: true }
    if (row.status !== 'pending') return { finished: false, status: row.status }
    const s = change.started
    const order = (await tx.query<{ id: string }>(INSERT_ORDER_SQL, [s.customerId, s.amount, paymentIntentId]))[0]
    if (!order) throw new Error(`Payment date change ${change.id}'s order was not written.`)
    await tx.query(INSERT_LINE_SQL, [order.id, s.amount, s.planId])
    await tx.query(MOVE_RENEWAL_SQL, [s.newRenewalDate, change.membershipId])
    await tx.query(DONE_CHANGE_SQL, [paymentIntentId, order.id, change.id])
    await audit.record(tx, entry(change, by, 'done', { how, paymentIntentId, orderId: order.id, amount: s.amount, nextRenewalDate: { before: s.oldRenewalDate, after: s.newRenewalDate } }))
    return { finished: true, orderId: order.id, paymentIntentId, already: false }
  })
}

// --- Stripe

const explain = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const accessRefused = (err: unknown): boolean => err instanceof Stripe.errors.StripeAuthenticationError || err instanceof Stripe.errors.StripePermissionError
const idOf = (value: string | { id: string } | null | undefined): string | null => (typeof value === 'string' ? value : (value?.id ?? null))

export type SubscriptionCheck = { ok: true } | { ok: false; reason: string; message: string }

/**
 * S1: the legacy route's checks on Stripe's subscription, in its order and its words (dates worded "28 Nov 2026", as
 * the old function reworded them). The stale-date guard: Stripe's next charge must be on the date the row shows.
 * The route's own window check is not repeated: past the stale-date guard Stripe's date is the row's, and P1 has
 * checked the window against the row under its lock.
 */
export function checkSubscription(subscription: Stripe.Subscription, s: Pick<PaymentDateStarted, 'stripeCustomerId' | 'oldRenewalDate' | 'amount'>): SubscriptionCheck {
  const no = (reason: string, message: string): SubscriptionCheck => ({ ok: false, reason, message })
  if (idOf(subscription.customer as string | { id: string } | null) !== s.stripeCustomerId) return no('customer_mismatch', PAYMENT_DATE_WORDS.customerMismatch)
  if (subscription.status !== 'active') return no('not_active', PAYMENT_DATE_WORDS.stripeNotActive(subscription.status))
  if (subscription.cancel_at_period_end || subscription.cancel_at) return no('cancel_scheduled', PAYMENT_DATE_WORDS.stripeCancelScheduled)
  const item = subscription.items?.data?.[0]
  const recurring = item?.price?.recurring
  if (!item || subscription.items.data.length !== 1 || recurring?.interval !== 'month' || recurring.interval_count !== 1) return no('not_monthly', PAYMENT_DATE_WORDS.stripeNotMonthly)
  const stripeDate = londonDateOfSeconds(item.current_period_end)
  if (stripeDate !== s.oldRenewalDate) return no('stale_renewal_date', PAYMENT_DATE_WORDS.staleRenewalDate(formatIsoDate(stripeDate), formatIsoDate(s.oldRenewalDate)))
  const monthlyPence = (item.price.unit_amount ?? 0) * (item.quantity ?? 1)
  if (monthlyPence > 0 && pence(s.amount) > monthlyPence) return no('amount_too_high', PAYMENT_DATE_WORDS.amountTooHigh)
  return { ok: true }
}

/** The charge's request, built only from the record, so every send is the same request under the same key. The old route's own, plus the record's id. */
export function paymentDateChargeRequest(change: Started): Stripe.PaymentIntentCreateParams {
  const s = change.started
  return {
    amount: pence(s.amount),
    currency: 'gbp',
    customer: s.stripeCustomerId,
    payment_method: s.paymentMethodId,
    off_session: true,
    confirm: true,
    description: s.description,
    metadata: {
      purpose: 'membership_payment_date_change',
      stripe_subscription_id: s.subscriptionId,
      membership_id: change.membershipId,
      new_renewal_date: s.newRenewalDate,
      [PAYMENT_DATE_METADATA]: change.id,
    },
  }
}

type Charge =
  | { outcome: 'answered'; paymentIntent: Stripe.PaymentIntent }
  /** Stripe said no, or nothing was sent: nothing was taken. `message` is Stripe's own (or the old route's for a card that needs the customer). */
  | { outcome: 'definite'; message: string; needsAuthentication: boolean; stripeCode: string | null }
  /** No clear answer: the money may have moved. Held; never sent again by anyone but this loop's one retry. */
  | { outcome: 'unknown'; detail: string }

/**
 * S2: the saved card charged once, under `<changeId>:charge`, outside any transaction. The order's rules
 * (collect-saved-card.ts): a PaymentIntent back is Stripe's answer; a definite refusal (or a 401/403 on the first
 * send) means nothing was taken; anything else is sent once more with the same key and request, which Stripe answers
 * with its first answer, and is then unclear. Each send gets only the time left; the first isn't sent with too
 * little (nothing taken), the second isn't either (unclear).
 */
async function chargeCard(stripe: StripeClient, change: Started, timing: StripeTiming | undefined): Promise<Charge> {
  const request = paymentDateChargeRequest(change)
  let last = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let options: Stripe.RequestOptions
    try {
      options = sendOptions(timing, { idempotencyKey: paymentDateChargeKey(change.id) })
    } catch (err) {
      if (attempt === 1) return { outcome: 'definite', message: PAYMENT_DATE_NEW_WORDS.notSent, needsAuthentication: false, stripeCode: 'not_sent' }
      return { outcome: 'unknown', detail: `${last} (not sent again: ${explain(err)})` }
    }
    try {
      return { outcome: 'answered', paymentIntent: await stripe.paymentIntents.create(request, options) }
    } catch (err) {
      const failure = readStripeFailure(err)
      if (failure.outcome === 'definite' || (accessRefused(err) && attempt === 1)) {
        const needsAuthentication = failure.code === 'authentication_required'
        return { outcome: 'definite', message: needsAuthentication ? PAYMENT_DATE_WORDS.authenticationRequired : failure.message, needsAuthentication, stripeCode: failure.code }
      }
      last = `${failure.code ?? 'no code'}: ${failure.message}`
    }
  }
  return { outcome: 'unknown', detail: last }
}

/** PaymentIntent statuses that took nothing and can take nothing without a new confirm (reconcile.ts, CARD_NOTHING_TAKEN). */
export const NOTHING_TAKEN: ReadonlySet<string> = new Set(['requires_payment_method', 'canceled'])

type Moved =
  | { kind: 'moved'; warning?: string }
  /** Stripe answered and said no: the date has not moved. */
  | { kind: 'refused'; message: string }
  | { kind: 'unclear'; detail: string }

/**
 * S3: the billing date moved with `trial_end` and no proration (Stripe: "change the billing period using a trial
 * period"). Safe to repeat: it sets a value. The press sends it at most twice under `<changeId>:move`; reconcile reads
 * the subscription first and sends under a key of its own run (`attempt`).
 */
async function moveDate(stripe: StripeClient, change: Started, timing: StripeTiming | undefined, attempt?: string): Promise<Moved> {
  const s = change.started
  let last = ''
  for (let send = 1; send <= (attempt ? 1 : 2); send += 1) {
    let updated: Stripe.Subscription
    try {
      updated = await stripe.subscriptions.update(s.subscriptionId, { trial_end: s.trialEnd, proration_behavior: 'none' }, sendOptions(timing, { idempotencyKey: paymentDateMoveKey(change.id, attempt) }))
    } catch (err) {
      if (err instanceof NoTimeLeft) return { kind: 'unclear', detail: last ? `${last} (not sent again: ${err.message})` : err.message }
      const failure = readStripeFailure(err)
      if (failure.outcome === 'definite') return { kind: 'refused', message: failure.message }
      last = `${failure.code ?? 'no code'}: ${failure.message}`
      continue
    }
    const warnings: string[] = []
    if (updated.trial_end !== s.trialEnd || updated.billing_cycle_anchor !== s.trialEnd) warnings.push(PAYMENT_DATE_WORDS.stripeReports(updated.trial_end, updated.billing_cycle_anchor, s.trialEnd))
    const periodEnd = updated.items?.data?.[0]?.current_period_end
    if (typeof periodEnd === 'number' && londonDateOfSeconds(periodEnd) !== s.newRenewalDate) warnings.push(PAYMENT_DATE_WORDS.nextPaymentNowOn(formatIsoDate(londonDateOfSeconds(periodEnd)), formatIsoDate(s.newRenewalDate)))
    return { kind: 'moved', ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}) }
  }
  return { kind: 'unclear', detail: last }
}

type Refunded =
  | { kind: 'refunded'; refundId: string | null; status: string | null; amountPence: number | null }
  /** Stripe answered and said no (or made a refund that failed at once): for a person. */
  | { kind: 'refused'; message: string }
  | { kind: 'unclear'; detail: string }

/**
 * The compensation refund, once, under `<changeId>:refund` (FB3): whatever is left of the charge (no amount is named),
 * which is the whole of it unless someone has refunded a part by hand meanwhile. Sent only after the `refunding` mark
 * is committed. A charge Stripe says is already refunded is refunded (an earlier send whose answer was lost).
 * `attempt` (W41a B2): reconcile's run, which has just listed the payment's refunds and found none of the change's
 * own. Its send is a request of its own, so a 500 Stripe saved against an earlier key is not replayed for ever.
 */
async function refundCharge(stripe: StripeClient, change: Started, paymentIntentId: string, timing: StripeTiming | undefined, attempt?: string): Promise<Refunded> {
  const key = paymentDateRefundKey(change.id, attempt)
  let last = ''
  for (let send = 1; send <= 2; send += 1) {
    try {
      const made = await stripe.refunds.create(
        { payment_intent: paymentIntentId, metadata: { [PAYMENT_DATE_METADATA]: change.id, refund_key: key, reason: 'payment_date_not_moved' } },
        sendOptions(timing, { idempotencyKey: key })
      )
      if (made.status === 'failed' || made.status === 'canceled') return { kind: 'refused', message: `Stripe's refund ${made.id} ${made.status}` }
      return { kind: 'refunded', refundId: made.id, status: made.status, amountPence: made.amount }
    } catch (err) {
      if (err instanceof NoTimeLeft) return { kind: 'unclear', detail: last ? `${last} (not sent again: ${err.message})` : err.message }
      const failure = readStripeFailure(err)
      if (failure.code === 'charge_already_refunded') return { kind: 'refunded', refundId: null, status: null, amountPence: null }
      if (failure.outcome === 'definite') return { kind: 'refused', message: failure.message }
      last = `${failure.code ?? 'no code'}: ${failure.message}`
    }
  }
  return { kind: 'unclear', detail: last }
}

// --- After the charge: the press's and reconcile's one path

export type ChangeOutcome =
  | { kind: 'done'; orderId: string | null; paymentIntentId: string | null; already: boolean; warning?: string }
  /** The row failed: nothing is left taken. `reason` and `message` are what the press answers. */
  | { kind: 'failed'; code: ApiErrorCode; reason: string; message: string; detail: string }
  /** Still pending: reconcile (or a person, for `refund_refused`) settles it. */
  | { kind: 'held'; reason: string; message: string; detail: string }
  /** Ended by something else meanwhile. */
  | { kind: 'not_open'; status: string }

const held = (reason: string, message: string, detail: string): ChangeOutcome => ({ kind: 'held', reason, message, detail })

/** A held change's `held` row, best effort: reconcile settles it from Stripe whether or not the row was written. */
async function noteHeld(db: Db, change: Started, by: ChangeBy, outcome: ChangeOutcome & { kind: 'held' }, paymentIntentId: string | null): Promise<void> {
  await markChange(db, change, by, 'held', { reason: outcome.reason, detail: outcome.detail, paymentIntentId }).catch(() => false)
}

/** P2, with a database failure turned into a hold: the card is charged and the date moved, so it is never undone here. */
async function finish(db: Db, change: Started, paymentIntentId: string, by: ChangeBy, how: 'press' | 'reconcile', warning?: string): Promise<ChangeOutcome> {
  let finished: FinishedChange
  try {
    finished = await finishPaymentDateChange(db, change, paymentIntentId, by, how)
  } catch (err) {
    return held('finalise_failed', PAYMENT_DATE_NEW_WORDS.paidNotFinished, `P2 failed after ${paymentIntentId}: ${explain(err)}`)
  }
  if (!finished.finished) return { kind: 'not_open', status: finished.status }
  return { kind: 'done', orderId: finished.orderId, paymentIntentId: finished.paymentIntentId, already: finished.already, ...(warning ? { warning } : {}) }
}

/**
 * S3 was refused (or its `refunding` mark is already there): the charge given back, once, and the row failed with the
 * refund watched. The mark is committed before the refund is sent, so nothing ever moves the date for a charge that
 * may have been refunded. `known`: a refund of the change's own that reconcile already found on the payment.
 * `attempt`: reconcile's run, for the refund's key when it has to send one (W41a B2).
 */
export async function refundAndFail(
  db: Db,
  stripe: StripeClient,
  change: Started,
  paymentIntentId: string,
  stripeSaid: string,
  by: ChangeBy,
  timing: StripeTiming | undefined,
  known?: { refundId: string; status: string | null; amountPence: number | null },
  attempt?: string
): Promise<ChangeOutcome> {
  if (!change.refunding) {
    let marked: boolean
    try {
      marked = await markChange(db, change, by, 'refunding', { paymentIntentId, stripeSaid })
    } catch (err) {
      // No mark, so no refund: reconcile sends S3 again, which Stripe refuses again, and marks then.
      return held('move_unconfirmed', PAYMENT_DATE_NEW_WORDS.paidNotFinished, `S3 refused (${stripeSaid}); the refunding mark was not written: ${explain(err)}`)
    }
    if (!marked) return { kind: 'not_open', status: 'ended' }
  }
  const refund: Refunded = known ? { kind: 'refunded', ...known } : await refundCharge(stripe, change, paymentIntentId, timing, attempt)
  const s = change.started
  if (refund.kind === 'unclear') return held('refund_unconfirmed', PAYMENT_DATE_NEW_WORDS.refundHeld(formatIsoDatesIn(stripeSaid)), `S3 refused (${stripeSaid}); the refund of ${paymentIntentId}: ${refund.detail}`)
  if (refund.kind === 'refused') {
    // FB3: a refund Stripe refuses is a line for a person. The row stays pending (the membership stays held) until it is closed by hand.
    const message = PAYMENT_DATE_NEW_WORDS.refundRefused(formatIsoDatesIn(stripeSaid), s.amount, paymentIntentId, refund.message)
    await markChange(db, change, by, 'held', { reason: 'refund_refused', detail: refund.message, paymentIntentId, stripeSaid }).catch(() => false)
    return held('refund_refused', message, `S3 refused (${stripeSaid}); the refund of ${paymentIntentId} was refused: ${refund.message}`)
  }
  const message = formatIsoDatesIn(PAYMENT_DATE_WORDS.refundedInFull(stripeSaid))
  try {
    const failed = await failPaymentDateChange(db, change, by, {
      at: 'move',
      message,
      paymentIntentId,
      ...(refund.refundId ? { refund: { refundId: refund.refundId, status: refund.status, amountPence: refund.amountPence } } : {}),
      extra: { stripeSaid, refunded: true },
    })
    if (!failed) return { kind: 'not_open', status: 'ended' }
  } catch (err) {
    // Refunded, and not yet recorded: reconcile finds the refund on the payment and records it then.
    return held('refund_unconfirmed', PAYMENT_DATE_NEW_WORDS.refundHeld(formatIsoDatesIn(stripeSaid)), `refunded (${refund.refundId ?? 'already'}), not recorded: ${explain(err)}`)
  }
  return { kind: 'failed', code: 'CONFLICT', reason: 'subscription_update_failed', message, detail: `S3 refused (${stripeSaid}); ${paymentIntentId} refunded${refund.refundId ? ` (${refund.refundId})` : ''}` }
}

/**
 * From a charge that succeeded: S3, then P2; or, S3 refused, the refund. `attempt`: reconcile's run, which has read
 * the subscription first and found the date not yet moved.
 */
export async function moveAndFinish(db: Db, stripe: StripeClient, change: Started, paymentIntentId: string, by: ChangeBy, timing: StripeTiming | undefined, how: 'press' | 'reconcile', attempt?: string): Promise<ChangeOutcome> {
  const moved = await moveDate(stripe, change, timing, attempt)
  if (moved.kind === 'moved') return finish(db, change, paymentIntentId, by, how, moved.warning)
  if (moved.kind === 'unclear') return held('move_unconfirmed', PAYMENT_DATE_NEW_WORDS.paidNotFinished, `S3 after ${paymentIntentId}: ${moved.detail}`)
  return refundAndFail(db, stripe, change, paymentIntentId, moved.message, by, timing, undefined, attempt)
}

/** P2 alone, for reconcile once Stripe shows the date as asked. */
export function finishFound(db: Db, change: Started, paymentIntentId: string, by: ChangeBy): Promise<ChangeOutcome> {
  return finish(db, change, paymentIntentId, by, 'reconcile')
}

/** Whether the subscription shows the change's date: its no-charge period ends at London midnight on the new date. */
export const dateIsMoved = (subscription: Pick<Stripe.Subscription, 'trial_end'>, s: Pick<PaymentDateStarted, 'trialEnd'>): boolean => subscription.trial_end === s.trialEnd

/** Whether a payment is the change's own: the amount, in pounds, that it asked for. */
export const paymentMatches = (paymentIntent: Pick<Stripe.PaymentIntent, 'amount' | 'amount_received' | 'currency'>, s: Pick<PaymentDateStarted, 'amount'>): boolean =>
  paymentIntent.currency === 'gbp' && paymentIntent.amount === pence(s.amount) && paymentIntent.amount_received === pence(s.amount)

/** The press, after P1 has committed: S1, S2, then the shared path. Never throws for Stripe. */
async function runChange(db: Db, stripe: StripeClient, change: Started, by: ChangeBy, timing: StripeTiming): Promise<ChangeOutcome> {
  const s = change.started
  const fail = async (at: 'subscription' | 'charge', code: ApiErrorCode, reason: string, message: string, detail: string): Promise<ChangeOutcome> => {
    // Nothing was charged, so the refusal is the answer either way; a row that couldn't be marked stays pending, and
    // reconcile ends it once Stripe shows no payment for it.
    await failPaymentDateChange(db, change, by, { at, message }).catch(() => false)
    return { kind: 'failed', code, reason, message, detail }
  }

  // S1
  let subscription: Stripe.Subscription
  try {
    subscription = await stripe.subscriptions.retrieve(s.subscriptionId, undefined, sendOptions(timing))
  } catch (err) {
    // The old route's answer: Stripe's own words. Nothing was charged.
    const message = err instanceof NoTimeLeft ? PAYMENT_DATE_NEW_WORDS.notSent : formatIsoDatesIn(readStripeFailure(err).message)
    return fail('subscription', 'CONFLICT', 'subscription_unreadable', message, explain(err))
  }
  const checked = checkSubscription(subscription, s)
  if (!checked.ok) return fail('subscription', 'CONFLICT', checked.reason, checked.message, checked.reason)

  // S2
  let charge: Charge
  try {
    charge = await chargeCard(stripe, change, timing)
  } catch (err) {
    charge = { outcome: 'unknown', detail: explain(err) }
  }
  if (charge.outcome === 'definite') {
    const message = charge.stripeCode === 'not_sent' ? charge.message : PAYMENT_DATE_WORDS.declined(charge.message.trim().replace(/\.+$/, ''))
    return fail('charge', charge.needsAuthentication ? 'PAYMENT_NEEDS_AUTHENTICATION' : 'PAYMENT_FAILED', 'payment_failed', message, charge.stripeCode ?? 'declined')
  }
  if (charge.outcome === 'unknown') return held('payment_unconfirmed', PAYMENT_DATE_HELD_MESSAGE, charge.detail)
  const paymentIntent = charge.paymentIntent
  if (paymentIntent.status !== 'succeeded') {
    if (NOTHING_TAKEN.has(paymentIntent.status)) {
      return fail('charge', 'PAYMENT_FAILED', 'payment_failed', PAYMENT_DATE_WORDS.declined(PAYMENT_DATE_WORDS.paymentNotCompleted(paymentIntent.status)), `${paymentIntent.id} ${paymentIntent.status}`)
    }
    return held('payment_unconfirmed', PAYMENT_DATE_HELD_MESSAGE, `${paymentIntent.id} is ${paymentIntent.status}`)
  }
  await db.query(RECORD_INTENT_SQL, [change.id, paymentIntent.id]).catch(() => undefined)
  if (!paymentMatches(paymentIntent, s)) return held('amount_mismatch', PAYMENT_DATE_HELD_MESSAGE, `${paymentIntent.id}: ${paymentIntent.amount_received} ${paymentIntent.currency} taken, ${pence(s.amount)} gbp asked`)
  return moveAndFinish(db, stripe, change, paymentIntent.id, by, timing, 'press')
}

/**
 * changeMembershipPaymentDate. Answers the change that went through, in the old function's fields; throws the
 * refusal otherwise (the old words in its details). A change with no clear end is PAYMENT_UNCONFIRMED and stays
 * pending for reconcile: never charge again for it.
 */
export async function changePaymentDate(db: Db, membershipId: string, input: ChangePaymentDateInput, options: PaymentDateOptions): Promise<ChangePaymentDateOutput> {
  // The old order: the params, then who may, before anything is read.
  if (!input.newRenewalDate) throw refuse('VALIDATION', 'params_required', PAYMENT_DATE_WORDS.paramsRequired)
  if (!options.actor.canIssueRefunds) throw refuse('FORBIDDEN', 'permission_denied', PAYMENT_DATE_WORDS.permissionDenied)
  const by: ChangeBy = { actor: { type: 'staff', id: options.actor.id }, requestId: options.requestId }
  const { change, stripe } = await recordChange(db, membershipId, input, options)
  const timing = stripeTiming(options.startedAt, options.now)

  let outcome: ChangeOutcome
  try {
    outcome = await runChange(db, stripe, change, by, timing)
  } catch (err) {
    // Anything unexpected after the record: held, never guessed at.
    outcome = held('unexpected', PAYMENT_DATE_HELD_MESSAGE, explain(err))
  }
  if (outcome.kind === 'done') {
    const s = change.started
    return {
      newRenewalDate: s.newRenewalDate,
      extraDays: s.extraDays,
      amountCharged: s.amount,
      paymentIntentId: outcome.paymentIntentId ?? '',
      orderId: outcome.orderId,
      ...(outcome.warning ? { warning: outcome.warning } : {}),
    }
  }
  if (outcome.kind === 'failed') throw refuse(outcome.code, outcome.reason, outcome.message)
  if (outcome.kind === 'not_open') throw refuse('CONFLICT', 'ended_elsewhere', PAYMENT_DATE_CLOSE_WORDS.notListed)
  if (outcome.reason !== 'refund_refused') await noteHeld(db, change, by, outcome, null)
  throw heldError(change.id, outcome.reason, outcome.message)
}

// --- Reconcile, the stuck list and the manual close

/** The pending rows older than the window (`$1` minutes), oldest first: what reconcile settles. */
export const PAYMENT_DATE_CHANGES_DUE_SQL = `
SELECT id FROM membership_payment_date_changes
WHERE status = 'pending' AND created_at < now() - make_interval(mins => $1::int)
ORDER BY created_at, id`

/** The pending rows older than the window, for the stuck list, with reconcile's last row for each and whether the Worker started it. */
export const PAYMENT_DATE_CHANGES_LISTED_SQL = `
SELECT p.id, p.membership_id, p.new_renewal_date::text AS new_renewal_date, p.amount_charged::text AS amount, p.stripe_payment_intent_id, p.created_at,
       c.id AS customer_id, c.first_name, c.last_name,
       EXISTS (SELECT 1 FROM audit_log s
        WHERE s.action = '${PAYMENT_DATE_ACTION}' AND s.entity_type = '${PAYMENT_DATE_ENTITY}' AND s.entity_id = p.membership_id::text
          AND s.details->>'changeId' = p.id::text AND s.details->>'state' = 'started') AS started_here,
       (SELECT r.details FROM audit_log r
        WHERE r.entity_type = '${PAYMENT_DATE_RECONCILE_ENTITY}' AND r.entity_id = p.id::text AND r.action = 'order.reconcile'
        ORDER BY r.at DESC LIMIT 1) AS last
FROM membership_payment_date_changes p
JOIN customer_memberships cm ON cm.id = p.membership_id
JOIN customers c ON c.id = cm.customer_id
WHERE p.status = 'pending' AND p.created_at < now() - make_interval(mins => $1::int)
  AND ($2::text IS NULL OR p.id::text = $2::text)
ORDER BY p.created_at, p.id`

export interface ListedPaymentDateChange {
  id: string
  membership_id: string
  new_renewal_date: string
  amount: string
  stripe_payment_intent_id: string | null
  created_at: Date | string
  customer_id: string
  first_name: string
  last_name: string
  started_here: boolean
  last: { outcome?: string; reason?: string; detail?: string | null } | null
}

/**
 * The reasons reconcile leaves a change with that only a person can end: the manual close is offered for these, and
 * for no other. Everything else the automatic check is still working on.
 */
export const PAYMENT_DATE_CLOSE_REASONS: ReadonlySet<string> = new Set(['not_started_here', 'several_payments', 'amount_mismatch', 'other_mode', 'refund_refused', 'refunded_elsewhere', 'subscription_missing'])

/** Why a held change is listed: what reconcile last left it with, or that it hasn't looked yet, or that the Worker never started it. */
export function paymentDateListedReason(row: Pick<ListedPaymentDateChange, 'started_here' | 'last'>): string {
  if (!row.started_here) return 'not_started_here'
  return row.last?.outcome === 'left' && row.last.reason ? row.last.reason : 'waiting'
}

export type ClosedPaymentDateChange = { closed: true; message: string } | { closed: false; reason: 'not_listed' | 'still_checking'; message: string }

/**
 * The manual close of a held payment date change (Issue refunds, checked by the route): as for a held order, it
 * records what Stripe last showed (reconcile's own last row for it) and never sends anything. The row is marked
 * failed, which lets the membership be changed again. Only for a change reconcile has left for a person.
 */
export async function closePaymentDateChange(
  db: Db,
  changeId: string,
  why: string,
  by: ChangeBy,
  olderThanMinutes: number,
  closeRow?: (found: { membershipId: string; reason: string; detail: string | null; paymentIntentId: string | null }) => AuditEntry
): Promise<ClosedPaymentDateChange> {
  const listed = (await db.query<ListedPaymentDateChange>(PAYMENT_DATE_CHANGES_LISTED_SQL, [olderThanMinutes, changeId]))[0]
  if (!listed) return { closed: false, reason: 'not_listed', message: PAYMENT_DATE_CLOSE_WORDS.notListed }
  const reason = paymentDateListedReason(listed)
  if (!PAYMENT_DATE_CLOSE_REASONS.has(reason)) return { closed: false, reason: 'still_checking', message: PAYMENT_DATE_CLOSE_WORDS.stillChecking }
  const change = await readPaymentDateChange(db, changeId)
  if (!change || change.status !== 'pending') return { closed: false, reason: 'not_listed', message: PAYMENT_DATE_CLOSE_WORDS.notListed }
  const found = [reason, listed.last?.detail, listed.stripe_payment_intent_id ? `payment ${listed.stripe_payment_intent_id}` : null].filter((part): part is string => typeof part === 'string' && part !== '').join('; ')
  const failed = await failPaymentDateChange(db, change, by, {
    at: 'close',
    message: `Closed by hand: ${why}`,
    paymentIntentId: listed.stripe_payment_intent_id,
    extra: { why, found: { reason, detail: listed.last?.detail ?? null, paymentIntentId: listed.stripe_payment_intent_id } },
    ...(closeRow ? { also: [closeRow({ membershipId: listed.membership_id, reason, detail: listed.last?.detail ?? null, paymentIntentId: listed.stripe_payment_intent_id })] } : {}),
  })
  if (!failed) return { closed: false, reason: 'not_listed', message: PAYMENT_DATE_CLOSE_WORDS.notListed }
  return { closed: true, message: PAYMENT_DATE_CLOSE_WORDS.closed(found) }
}
