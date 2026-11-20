// New in W47r-b (W47r-a "Noticed" 1; the lead's call, 19 Nov 2026): a payment Stripe took for an invoice after its
// subscription had ended is always listed for a refund.
//
// Stripe leaves a cancelled subscription's open invoice payable: its own retry can land, or the customer can approve
// a payment with their bank, seconds or days after the subscription ended. The `invoice.paid` notice then finds the
// subscription ended and (W46) rightly marks nothing, and until W47r-b that was all: the money was kept with nothing
// listed. The retry's "already paid before the press" path had the same gap.
//
// The rule is in the one place both paths share (app/api/stripe/webhook/dispatch.ts, recordInvoicePaid): the
// subscription reads `canceled` or `incomplete_expired`, the invoice reads paid with money taken, and it was paid at
// or after the moment the subscription ended. This file is what that rule calls: the line for a person, on the
// Worker's own database connection.
//
//   listed    one audit row per invoice (`membership.invoice_paid_after_end`, against the invoice's id), written
//             under the membership's lock and only while (a) no row for the invoice is there (a notice sent again, or
//             a press after the notice, writes nothing more) and (b) no retry's record holds the same invoice: one
//             still open, which the retry's own `paid_after_end` hold lists (W47r-a), or one already marked refunded.
//   the list  orders/stuck-list.ts shows it with the retries (`paymentRetries`, reason `paid_after_end`), with the
//             same close as W47r-a's: Mark refunded (`retry_paid_after_end`; `orderId` is the line's own id).
//   refunded  Mark refunded (markInvoiceRefunded) reads the invoice's payments and their refunds in Stripe first, and
//             ends the line only when Stripe shows every payment refunded in full. Nothing here sends a refund.
//
// No new table (lead call L6, as the retry's record): the line is its audit rows. No membership here has the
// subscription: nothing is written (there is nobody to list it against), and the answer says so.
//
// W47r-c (W47r-b "Noticed" 2; Wayne's rule: a cancelled member is never charged with nothing listed): the same line
// for a renewal Stripe takes on a subscription that is still live there, when the membership's row has ended here
// (the paid write answered `ignored_cancelled`: a cancel that never reached Stripe). Stripe shows no end for it, so
// the rule's time is the row's own: its last day (`cancel_effective_date`), read here under the lock. Paid before
// that day, by London's date, was for a month the member had (a late or re-sent notice): owed, not listed
// (`paid_before_last_day`). Paid on the last day or after it, or a row with no last day, or no time for the payment:
// listed, with `cancelledHere` on the row, and words that add checking the subscription is cancelled in Stripe.
//
// W47r-d (W47r-c "Noticed" 2 and 3; W47r-b "Noticed" 4).
// - A payment taken before the subscription ended in Stripe was never listed. But that end can be a manager
//   cancelling in Stripe after a renewal was taken for a membership whose last day here had already passed. So for
//   such a payment (`beforeStripeEnd`) the row's last day is read here too, and it is listed when the row has one
//   and the payment was on or after it (London's date), with `pastLastDay` on the row. With no last day on the row,
//   or a payment before it, the answer is `paid_before_end` as it always was, and nothing is written.
// - A line whose money was in fact owed could only be cleared by refunding it. Mark as owed (markInvoiceOwed) ends it
//   with an `owed` row carrying the person's reason: Issue refunds and a reason (the close route checks both), no
//   Stripe call, nothing sent. An invoice with any row is never listed again, so it stays cleared.
import 'server-only'
import type { ListPaidAfterEnd, PaidAfterEndFound, PaidAfterEndListed } from '@/app/api/stripe/webhook/dispatch'
import { audit, type AuditEntry } from '@/server/audit'
import type { Db, Queryable } from '@/server/db'
import type { StripeClient } from '@/server/stripe/client'
import { sendOptions, type StripeTiming } from '@/server/stripe/deadline'
import { PAYMENT_RETRY_CLOSE_WORDS, PAYMENT_RETRY_OWED_WORDS } from './failure-messages'
import { PAYMENT_RETRY_ACTION, PAYMENT_RETRY_ENTITY } from './retry-record'

/** Every row about a listed invoice: `listed`, then `refunded` or (W47r-d) `owed`. Written against the invoice's id, so an invoice has one line. */
export const INVOICE_PAID_AFTER_END_ACTION = 'membership.invoice_paid_after_end'
export const INVOICE_PAID_AFTER_END_ENTITY = 'membership_invoice'

/** Who a row is written for: Stripe's notice (the system), or the staff member whose press found it. */
export interface PaidAfterEndBy {
  actor: { type: 'staff' | 'system'; id: string | null }
  requestId: string
}

const MEMBERSHIP_OF_SUBSCRIPTION_SQL = 'SELECT id, customer_id FROM customer_memberships WHERE stripe_subscription_id = $1::text'
const LOCK_MEMBERSHIP_SQL = 'SELECT id FROM customer_memberships WHERE id = $1::uuid FOR NO KEY UPDATE'

/**
 * W47r-c: the last day of a membership (`$2`) and whether a payment taken at `$1` (Stripe's seconds) was before it, by
 * London's date. `paid_before` is null, not true, when the row has no last day or the payment no time.
 */
const LAST_DAY_SQL = `
SELECT cancel_effective_date::text AS last_day,
       (to_timestamp($1::double precision) AT TIME ZONE 'Europe/London')::date < cancel_effective_date AS paid_before
FROM customer_memberships WHERE id = $2::uuid`

/** W47r-d: the rows that end a line. */
export const INVOICE_LINE_CLOSING_STATES = ['refunded', 'owed'] as const
export type InvoiceLineClosingState = (typeof INVOICE_LINE_CLOSING_STATES)[number]
const INVOICE_LINE_CLOSING_SQL = INVOICE_LINE_CLOSING_STATES.map((state) => `'${state}'`).join(', ')

/** Whether an invoice (`$1`) has a row already: listed, or listed and since marked refunded or (W47r-d) as owed. Either way it is never listed again. */
const INVOICE_ROW_SQL = `
SELECT 1 FROM audit_log
WHERE action = '${INVOICE_PAID_AFTER_END_ACTION}' AND entity_type = '${INVOICE_PAID_AFTER_END_ENTITY}' AND entity_id = $1::text
LIMIT 1`

/**
 * Whether a retry of the membership (`$1`, as text) holds the invoice (`$2`): its `started` row names the invoice and
 * it has not ended with nothing to give back. Still open: the retry's own check holds it as paid after the end
 * (retry-payment.ts, S1), so it is listed there. Ended `refunded`: a person has already been through Mark refunded
 * for this payment. A retry that ended `paid`, `declined`, `not_taken` or `not_sent` holds nothing.
 */
const RETRY_HOLDS_SQL = `
SELECT 1 FROM audit_log s
WHERE s.action = '${PAYMENT_RETRY_ACTION}' AND s.entity_type = '${PAYMENT_RETRY_ENTITY}' AND s.entity_id = $1::text
  AND s.details->>'state' = 'started' AND s.details->>'invoiceId' = $2::text
  AND NOT EXISTS (
    SELECT 1 FROM audit_log e
    WHERE e.action = '${PAYMENT_RETRY_ACTION}' AND e.entity_type = '${PAYMENT_RETRY_ENTITY}' AND e.entity_id = s.entity_id
      AND e.details->>'retryId' = s.details->>'retryId' AND e.details->>'state' IN ('paid', 'declined', 'not_taken', 'not_sent')
  )
LIMIT 1`

const isoOfSeconds = (seconds: number | null): string | null => (seconds === null ? null : new Date(seconds * 1000).toISOString())

/**
 * The line for one invoice, written once. One transaction under the membership's lock, which a retry's rows are
 * written under too, so "is it listed" and "does a retry hold it" are asked and answered with nothing in between.
 * `how`: who found it (`webhook`: Stripe's notice; `retry`: a press of "Try the payment again now").
 */
export function listPaidAfterEnd(db: Db, by: PaidAfterEndBy, how: 'webhook' | 'retry'): ListPaidAfterEnd {
  return (found: PaidAfterEndFound): Promise<PaidAfterEndListed> =>
    db.transaction(async (tx) => {
      const membership = (await tx.query<{ id: string; customer_id: string }>(MEMBERSHIP_OF_SUBSCRIPTION_SQL, [found.subscriptionId]))[0]
      // W47r-d: with no membership there is no last day to set a payment taken before Stripe's end against: owed, as before.
      if (!membership) return { listed: false, why: found.beforeStripeEnd && !found.cancelledHere ? 'paid_before_end' : 'no_membership' }
      await tx.query(LOCK_MEMBERSHIP_SQL, [membership.id])
      // Read in their own statements, after the lock (server/rules/README.md, "Locks before reads").
      // W47r-c: a row ended here with Stripe's subscription still live. Asked first, so a retry's record that holds
      // the invoice is told the payment was owed too (retry-payment.ts, paidAfterEnd).
      let lastDay: string | null = null
      if (found.cancelledHere || found.beforeStripeEnd) {
        const row = (await tx.query<{ last_day: string | null; paid_before: boolean | null }>(LAST_DAY_SQL, [found.paidAt, membership.id]))[0]
        lastDay = row?.last_day ?? null
        if (found.cancelledHere && row?.paid_before === true) return { listed: false, why: 'paid_before_last_day', last_day: lastDay }
        // W47r-d: paid before Stripe ended the subscription. Owed, as before, unless the row has a last day and the
        // payment was on or after it (`paid_before` is null with no last day: it can't be shown the payment came after).
        if (!found.cancelledHere && row?.paid_before !== false) return { listed: false, why: 'paid_before_end', ...(lastDay ? { last_day: lastDay } : {}) }
      }
      if ((await tx.query(INVOICE_ROW_SQL, [found.invoiceId])).length > 0) return { listed: false, why: 'already_listed' }
      if ((await tx.query(RETRY_HOLDS_SQL, [membership.id, found.invoiceId])).length > 0) return { listed: false, why: 'retry_holds' }
      const listingId = crypto.randomUUID()
      await audit.record(tx, {
        actorType: by.actor.type,
        actorId: by.actor.id,
        action: INVOICE_PAID_AFTER_END_ACTION,
        entityType: INVOICE_PAID_AFTER_END_ENTITY,
        entityId: found.invoiceId,
        requestId: by.requestId,
        details: {
          listingId,
          state: 'listed',
          how,
          membershipId: membership.id,
          customerId: membership.customer_id,
          subscriptionId: found.subscriptionId,
          invoiceId: found.invoiceId,
          amount: found.amountPaid / 100,
          status: found.status,
          paidAt: isoOfSeconds(found.paidAt),
          endedAt: isoOfSeconds(found.endedAt),
          livemode: found.livemode,
          ...(found.cancelledHere ? { cancelledHere: true, lastDay } : found.beforeStripeEnd ? { pastLastDay: true, lastDay } : {}),
        },
      })
      return { listed: true, why: 'listed', listing: listingId, ...(found.cancelledHere || found.beforeStripeEnd ? { last_day: lastDay } : {}) }
    })
}

// --- The stuck list

/**
 * The invoices listed and not yet marked refunded (or, W47r-d, as owed), oldest first, in the columns the list reads a
 * retry by (retry-payment.ts, ListedPaymentRetry): `id` is the line's own id, and no card is known (Stripe took the
 * payment). W47r-d: `last_day`, for a line listed by the row's last day after Stripe had ended the subscription.
 */
export const INVOICES_PAID_AFTER_END_LISTED_SQL = `
SELECT l.details->>'listingId' AS id, l.details->>'membershipId' AS membership_id, l.entity_id AS invoice_id,
       (l.details->>'amount')::numeric::text AS amount, l.at AS created_at,
       c.id AS customer_id, c.first_name, c.last_name,
       COALESCE(l.details->>'cancelledHere', '') = 'true' AS cancelled_here,
       CASE WHEN COALESCE(l.details->>'pastLastDay', '') = 'true' THEN l.details->>'lastDay' END AS past_last_day
FROM audit_log l
JOIN customer_memberships cm ON cm.id::text = l.details->>'membershipId'
JOIN customers c ON c.id = cm.customer_id
WHERE l.action = '${INVOICE_PAID_AFTER_END_ACTION}' AND l.entity_type = '${INVOICE_PAID_AFTER_END_ENTITY}' AND l.details->>'state' = 'listed'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log e
    WHERE e.action = '${INVOICE_PAID_AFTER_END_ACTION}' AND e.entity_type = '${INVOICE_PAID_AFTER_END_ENTITY}' AND e.entity_id = l.entity_id
      AND e.details->>'state' IN (${INVOICE_LINE_CLOSING_SQL})
  )
ORDER BY l.at, l.entity_id`

export interface ListedInvoicePaidAfterEnd {
  id: string
  membership_id: string
  invoice_id: string
  amount: string
  created_at: Date | string
  customer_id: string
  first_name: string
  last_name: string
  /** W47r-c: the membership's row had ended here while Stripe's subscription was still live. */
  cancelled_here: boolean
  /** W47r-d: the row's last day, when the line was listed by it (paid before Stripe's end, on or after that day); else null. */
  past_last_day: string | null
}

// --- What Stripe shows refunded (W47r-a's read, moved here so a retry's close and a listed invoice's are one read)

const idOf = (value: string | { id: string } | null | undefined): string | null => (typeof value === 'string' ? value : (value?.id ?? null))

/** What Stripe shows of an invoice's card payments and their refunds, in pence. Null: Stripe couldn't be read. */
export interface RefundsSeen {
  /** Taken by the invoice's payments that went through. */
  taken: number
  /** Refunds of those payments that Stripe shows as `succeeded`. */
  refunded: number
  /** Refunds still on their way (`pending`, `requires_action`): not money back yet. */
  onTheWay: number
  /** Every payment that went through has refunds that have succeeded for all of what it took. */
  inFull: boolean
  payments: Array<{ id: string; taken: number; refunded: number; refunds: Array<{ id: string; amount: number; status: string }> }>
}

/** Stripe lists 100 refunds a page at most. One payment with more is not something to conclude from. */
const REFUNDS_PAGE = 100

/**
 * The invoice's payments and each one's refunds, read now: the invoice with its payments, each payment's
 * PaymentIntent, and the refunds of each one that took money. Reads only. Null when any read gets no answer, or the
 * lists are longer than one page: nothing is concluded from part of the picture.
 */
export async function readRefunds(stripe: StripeClient, invoiceId: string, timing: StripeTiming | undefined): Promise<RefundsSeen | null> {
  try {
    const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['payments'] }, sendOptions(timing))
    if (invoice.payments?.has_more) return null
    const intentIds = (invoice.payments?.data ?? []).map((payment) => idOf(payment.payment?.payment_intent)).filter((id): id is string => id !== null)
    const payments: RefundsSeen['payments'] = []
    let onTheWay = 0
    for (const id of intentIds) {
      const intent = await stripe.paymentIntents.retrieve(id, undefined, sendOptions(timing))
      if (intent.status !== 'succeeded' || !(intent.amount_received > 0)) continue
      const listed = await stripe.refunds.list({ payment_intent: id, limit: REFUNDS_PAGE }, sendOptions(timing))
      if (listed.has_more) return null
      const refunds = listed.data.map((refund) => ({ id: refund.id, amount: refund.amount, status: refund.status ?? 'unknown' }))
      const sum = (statuses: readonly string[]): number => refunds.filter((refund) => statuses.includes(refund.status)).reduce((total, refund) => total + refund.amount, 0)
      onTheWay += sum(['pending', 'requires_action'])
      payments.push({ id, taken: intent.amount_received, refunded: sum(['succeeded']), refunds })
    }
    const taken = payments.reduce((total, payment) => total + payment.taken, 0)
    const refunded = payments.reduce((total, payment) => total + payment.refunded, 0)
    return { taken, refunded, onTheWay, inFull: payments.length > 0 && payments.every((payment) => payment.refunded >= payment.taken), payments }
  } catch {
    return null
  }
}

// --- Mark refunded, for a listed invoice

/** One line by its own id (`$1`): its `listed` row, and the state of the row that has since ended it (`refunded`, or W47r-d's `owed`), if any. */
const LISTING_SQL = `
SELECT l.entity_id AS invoice_id, l.details->>'membershipId' AS membership_id, (l.details->>'amount')::numeric::text AS amount,
       (SELECT e.details->>'state' FROM audit_log e
        WHERE e.action = '${INVOICE_PAID_AFTER_END_ACTION}' AND e.entity_type = '${INVOICE_PAID_AFTER_END_ENTITY}' AND e.entity_id = l.entity_id
          AND e.details->>'state' IN (${INVOICE_LINE_CLOSING_SQL})
        ORDER BY e.at LIMIT 1) AS closed_as
FROM audit_log l
WHERE l.action = '${INVOICE_PAID_AFTER_END_ACTION}' AND l.entity_type = '${INVOICE_PAID_AFTER_END_ENTITY}' AND l.details->>'state' = 'listed'
  AND l.details->>'listingId' = $1::text
LIMIT 1`

/** A listed invoice as its close reads it. */
export interface InvoicePaidAfterEnd {
  id: string
  invoiceId: string
  membershipId: string
  /** Pounds taken for the invoice when it was listed. */
  amount: number
  /** It has been marked refunded (and so is no longer listed). */
  refunded: boolean
  /** W47r-d: the state of the row that ended it: `refunded`, `owed`, or null while it is listed. */
  closedAs: InvoiceLineClosingState | null
}

/** One listed invoice by its line's id: null when there is no such line (the id is a retry's, or nothing's). */
export async function readInvoicePaidAfterEnd(db: Queryable, listingId: string): Promise<InvoicePaidAfterEnd | null> {
  const row = (await db.query<{ invoice_id: string; membership_id: string; amount: string; closed_as: string | null }>(LISTING_SQL, [listingId]))[0]
  if (!row) return null
  const closedAs = (INVOICE_LINE_CLOSING_STATES as readonly string[]).includes(row.closed_as ?? '') ? (row.closed_as as InvoiceLineClosingState) : null
  return { id: listingId, invoiceId: row.invoice_id, membershipId: row.membership_id, amount: Number.parseFloat(row.amount), refunded: closedAs === 'refunded', closedAs }
}

export type InvoiceRefundedAnswer = { closed: true; alreadyClosed?: boolean; message: string } | { closed: false; reason: string; message: string }

/**
 * Mark refunded for a listed invoice (Issue refunds; the close route checks it): the same press, the same read and
 * the same answers as a retry's (retry-payment.ts, markRetryRefunded). Stripe is read first, outside the transaction
 * (reads only; nothing is ever sent): refused, with nothing changed, unless Stripe shows every payment of the invoice
 * that went through refunded in full by refunds that have succeeded. Then, under the membership's lock and only while
 * the line is still open: its `refunded` row, with the refunds found, and the close's own row (`closeEntry`).
 */
export async function markInvoiceRefunded(
  db: Db,
  stripe: () => StripeClient,
  listing: InvoicePaidAfterEnd,
  why: string,
  by: PaidAfterEndBy,
  timing: StripeTiming | undefined,
  closeEntry: (listing: InvoicePaidAfterEnd, found: Record<string, unknown>) => AuditEntry
): Promise<InvoiceRefundedAnswer> {
  const words = PAYMENT_RETRY_CLOSE_WORDS
  const refused = (reason: string, message: string): InvoiceRefundedAnswer => ({ closed: false, reason, message })
  if (listing.refunded) return { closed: true, alreadyClosed: true, message: words.already }
  // W47r-d: marked as owed since the list was read. Nothing to check in Stripe: it is no longer listed.
  if (listing.closedAs !== null) return refused('not_listed', words.notListed)
  const seen = await readRefunds(stripe(), listing.invoiceId, timing)
  if (!seen) return refused('refunds_not_read', words.notRead)
  if (seen.payments.length === 0) return refused('payment_not_found', words.noPayment)
  if (!seen.inFull) return refused('not_refunded', words.notRefunded(seen.taken / 100, seen.refunded / 100, seen.onTheWay / 100))
  const found = { invoiceId: listing.invoiceId, amount: listing.amount, taken: seen.taken / 100, refunded: seen.refunded / 100, payments: seen.payments }
  return db.transaction(async (tx) => {
    await tx.query(LOCK_MEMBERSHIP_SQL, [listing.membershipId])
    // Read again under the lock: two presses queue, and the second finds the first's row.
    const now = await readInvoicePaidAfterEnd(tx, listing.id)
    if (!now) return refused('not_listed', words.notListed)
    if (now.refunded) return { closed: true, alreadyClosed: true, message: words.already }
    if (now.closedAs !== null) return refused('not_listed', words.notListed)
    await audit.recordAll(tx, [
      {
        actorType: by.actor.type,
        actorId: by.actor.id,
        action: INVOICE_PAID_AFTER_END_ACTION,
        entityType: INVOICE_PAID_AFTER_END_ENTITY,
        entityId: listing.invoiceId,
        requestId: by.requestId,
        details: { listingId: listing.id, state: 'refunded', how: 'close', why, membershipId: listing.membershipId, ...found },
      },
      closeEntry(listing, found),
    ])
    return { closed: true, message: words.refunded(seen.taken / 100) }
  })
}

// --- Mark as owed, for a listed invoice (W47r-d)

export type InvoiceOwedAnswer = { closed: true; alreadyClosed?: boolean; message: string } | { closed: false; reason: string; message: string }

/**
 * W47r-d (W47r-c "Noticed" 3; W47r-b "Noticed" 4): Mark as owed for a listed invoice (Issue refunds and a reason; the
 * close route checks both). For a line whose money was in fact owed: a payment for a period the member had, listed
 * because the row had no last day to set it against, or because it was taken on the last day itself. Stripe is never
 * called and nothing is sent: under the membership's lock, and only while the line is still open, its `owed` row with
 * the person's reason, and the close's own row (`closeEntry`), which carries the reason too.
 */
export async function markInvoiceOwed(db: Db, listing: InvoicePaidAfterEnd, why: string, by: PaidAfterEndBy, closeEntry: (listing: InvoicePaidAfterEnd, found: Record<string, unknown>) => AuditEntry): Promise<InvoiceOwedAnswer> {
  const words = PAYMENT_RETRY_OWED_WORDS
  const refused = (reason: string, message: string): InvoiceOwedAnswer => ({ closed: false, reason, message })
  return db.transaction(async (tx) => {
    await tx.query(LOCK_MEMBERSHIP_SQL, [listing.membershipId])
    // Read under the lock: two presses queue, and the second finds the first's row.
    const now = await readInvoicePaidAfterEnd(tx, listing.id)
    if (!now) return refused('not_listed', words.notListed)
    if (now.closedAs === 'owed') return { closed: true, alreadyClosed: true, message: words.already }
    if (now.closedAs !== null) return refused('not_listed', words.notListed)
    const found = { invoiceId: listing.invoiceId, amount: listing.amount }
    await audit.recordAll(tx, [
      {
        actorType: by.actor.type,
        actorId: by.actor.id,
        action: INVOICE_PAID_AFTER_END_ACTION,
        entityType: INVOICE_PAID_AFTER_END_ENTITY,
        entityId: listing.invoiceId,
        requestId: by.requestId,
        details: { listingId: listing.id, state: 'owed', how: 'close', why, membershipId: listing.membershipId, ...found },
      },
      closeEntry(listing, found),
    ])
    return { closed: true, message: words.owed(listing.amount) }
  })
}
