// Ported from backend/paddock/finaliseReaderPayment.ts and cancelReaderPayment.ts, with
// shared/readerFlowFinalise.ts and shared/pendingReaderFlows.ts (new in W12): the reader's finalise and
// cancel for Move, Settle and Add Guest. The rows keep the old shapes (the flow's pending row, its order
// and line, the gift card's redemption, the store credit's reversal). What changes is how they are written:
// finalise records the payment, gives back what the flow held until it was paid, and marks the row, in
// ONE transaction (bug 12, W5-17, R2); the undo puts the booking back, gives the money parts back and marks
// the row, in ONE transaction (W03a later 1, R1). Each locks the flow's row first and re-checks it, so a
// second finalise, a second cancel, and a finalise racing a cancel each end in one outcome. The money is
// checked to the penny (W03-plan 2.7). Nothing here refunds: a payment that doesn't check out, or a database
// fault after it succeeded, leaves the row pending for reconcile or a person (W6-3); a payment that
// succeeds on a flow already undone is recorded for reconcile's automatic refund (W12 calls).
//
// Only flows the Worker started are taken (their record carries the Worker's `method` and `request_id`,
// as an order's does). Until step D moves Move, Settle and Add Guest, the old functions start every flow
// and finish it too, so these routes refuse them (`old_reader_flow`), as W11's do the old checkout's.
import 'server-only'
import type Stripe from 'stripe'
import { audit } from '@/server/audit'
import { inOpenTransaction, isDeadlock, type Db, type Tx } from '@/server/db'
import type { StripeClient } from '@/server/stripe/client'
import { sendOptions, stripeTiming, type StripeTiming } from '@/server/stripe/deadline'
import { pence } from './collect-saved-card'
import { lockForOrder } from './locks'
import { isMissing, settleIntent, stripeMessage, type ReaderRouteOptions } from './reader-order'

export type ReaderFlow = 'move' | 'settle' | 'add_guest'

/**
 * A flow's record (pending_reader_payments.snapshot), as the old flows write it (pendingReaderFlows.ts,
 * PendingReaderSnapshot), plus what a flow the Worker starts adds, as an order's pending record does:
 * `method`, `channel`, `request_id`, the Stripe customer and the intent's mode (W11a). Step D writes those.
 */
export interface FlowSnapshot {
  customer_id: string
  description: string
  store_credit_amount?: number
  gift_card?: { gift_card_id: string; amount: number; stamped_redeemed_at?: boolean }
  booking_id?: string
  old_session_id?: string
  old_start_time?: string
  old_end_time?: string
  old_price_paid?: string | null
  price_paid_change?: number
  old_band_id?: string | null
  old_credit_period_id?: string | null
  old_redemption_source?: string
  old_redeemed_membership_id?: string | null
  old_redeemed_session_pass_id?: string | null
  release_session_pass_on_finalise?: boolean
  seats?: Array<{ id: string; unit_price: string; pay_by: string | null }>
  new_session_id?: string
  new_session_booking_type?: 'public' | 'private'
  party_size?: number
  old_status?: string
  old_payment_due_by?: string | null
  old_seat1_pay_by?: string | null
  amount?: number
  session_id?: string
  guest_row_id?: string
  order_line_item_id?: string
  price_increment?: number
  claimed_extra_capacity?: boolean
  addon_line_ids?: string[]
  addon_credits?: Array<{ membership_id: string; quantity: number }>
  // A flow the Worker started (W12; written by step D).
  method?: 'reader'
  channel?: 'staff'
  request_id?: string
  stripe_customer_id?: string | null
  livemode?: boolean
}

export interface FlowRow {
  id: string
  flow: string
  record_id: string
  payment_intent_id: string | null
  /** In pounds, as text (numeric). */
  expected_amount: string
  snapshot: FlowSnapshot
  status: string
  created_at: string
}

/** A flow the Worker started: its record carries the Worker's method and request id. */
export const isWorkerFlow = (snapshot: FlowSnapshot | null | undefined): boolean =>
  snapshot?.method === 'reader' && typeof snapshot.request_id === 'string'

const READ_FLOW_SQL =
  'SELECT id, flow, record_id, payment_intent_id, expected_amount::text AS expected_amount, snapshot, status, created_at FROM pending_reader_payments WHERE id = $1::uuid'
const LOCK_FLOW_SQL = `${READ_FLOW_SQL} FOR UPDATE`

/** The flow's row; with `lock`, locked FOR UPDATE (inside a transaction), the first lock its finalise and undo take. */
export async function readFlow(db: Db | Tx, pendingId: string, lock = false): Promise<FlowRow | null> {
  const rows = await db.query<FlowRow>(lock ? LOCK_FLOW_SQL : READ_FLOW_SQL, [pendingId])
  return rows[0] ?? null
}

// --- The answers, in the old functions' shapes (finaliseReaderPayment.ts, cancelReaderPayment.ts)

export interface FinaliseFlowOutput {
  finalised: boolean
  pendingId?: string
  flow?: string
  recordId?: string
  paymentIntentId?: string
  alreadyFinalised?: boolean
  paymentNotSucceeded?: boolean
  piStatus?: string
  reason?: string
  message?: string
  warning?: string
}

export interface CancelFlowOutput {
  cancelled: boolean
  pendingId?: string
  flow?: string
  recordId?: string
  alreadyDone?: boolean
  finalisedInstead?: boolean
  finaliseResult?: FinaliseFlowOutput
  reason?: string
  message?: string
  warning?: string
}

export function flowLabel(flow: string): string {
  if (flow === 'move') return 'booking move'
  if (flow === 'settle') return 'booking payment'
  if (flow === 'add_guest') return 'added guest'
  return flow
}

// The old words.
export const FLOW_GONE_MESSAGE = 'That pending payment no longer exists.'
export const FLOW_ALREADY_FINALISED_MESSAGE = 'This payment was already finalised — nothing further was done.'
export const FLOW_ALREADY_CANCELLED_MESSAGE = 'This pending payment was already cancelled.'
export const FLOW_LOOK_UP_FAILED_MESSAGE = 'Failed to look up the PaymentIntent in Stripe.'
export const FLOW_GONE_CANCEL_MESSAGE = 'That pending payment no longer exists — nothing to do.'
export const FLOW_CANCEL_ALREADY_DONE_MESSAGE = 'Already cancelled — nothing to do.'
export const FLOW_CANCEL_FINALISED_MESSAGE =
  'This payment was already finalised — the change is complete and cannot be cancelled. Refund it through the normal refund flow instead.'
export const FLOW_CANCEL_FAILED_MESSAGE = 'Failed to cancel the PaymentIntent in Stripe — retry after checking the payment in Stripe.'
export const flowNotSucceededMessage = (status: string): string =>
  `The reader payment has not succeeded yet (status: ${status}). Cancel it or retry the card on the reader.`
export const flowCancelledMessage = (flow: string): string => `Payment not taken. The ${flowLabel(flow)} was undone and nothing was charged.`

// W12's words (new; adjustable at W14).
export const OLD_READER_FLOW_MESSAGE = 'This card-reader payment was started by the old booking screens, so the old screens must finish or cancel it.'
export const FLOW_INTENT_UNCONFIRMED_MESSAGE =
  "The card reader payment couldn't be started: Stripe gave no clear answer. Nothing has been taken, but the change is on hold while it's checked: don't take payment for it again. Check the Orders page in a few minutes."
export const FLOW_PAID_NOT_FINISHED_MESSAGE =
  "The reader payment went through, but the change couldn't be finished. It's on hold: don't take payment again. Check the Orders page in a few minutes."
export const FLOW_CHARGED_WITHOUT_RECORD_MESSAGE =
  "The reader took the payment, but the change had already been undone, so the payment needs refunding. Don't take payment again: check the Orders page."
export const FLOW_UNDO_INCOMPLETE_MESSAGE =
  "The change couldn't be undone yet: nothing was given back. It's still on the Orders page, and Resolve now will finish it once it's 15 minutes old."
export const flowCustomerMismatchMessage = (paymentIntentId: string): string =>
  `This PaymentIntent was made for a different Stripe customer — do NOT finalise automatically. Check the PaymentIntent (${paymentIntentId}) in Stripe before doing anything.`

type FlowMismatch = 'payment_not_succeeded' | 'metadata_mismatch' | 'currency_mismatch' | 'amount_mismatch' | 'customer_mismatch'

/**
 * What the flow must see in the PaymentIntent, as finaliseReaderPayment checked (succeeded, the flow and
 * its record in the metadata, gbp, the amount), now to the exact penny on `amount` and `amount_received`
 * (W03-plan 2.7; the old check allowed 1p of `amount_received` either way). A flow the Worker starts
 * names its row (`metadata.pending_id`) and its Stripe customer, and both are checked when present.
 */
export function flowPaymentMismatch(row: FlowRow, paymentIntent: Stripe.PaymentIntent): FlowMismatch | null {
  if (paymentIntent.status !== 'succeeded') return 'payment_not_succeeded'
  const metadata = paymentIntent.metadata ?? {}
  if ((metadata['flow'] ?? '') !== row.flow || (metadata['record_id'] ?? '') !== row.record_id) return 'metadata_mismatch'
  if (metadata['pending_id'] !== undefined && metadata['pending_id'] !== row.id) return 'metadata_mismatch'
  if (paymentIntent.currency !== 'gbp') return 'currency_mismatch'
  const expected = pence(Number.parseFloat(row.expected_amount))
  if (paymentIntent.amount !== expected || paymentIntent.amount_received !== expected) return 'amount_mismatch'
  const wanted = row.snapshot.stripe_customer_id
  if (typeof wanted === 'string') {
    const customer = typeof paymentIntent.customer === 'string' ? paymentIntent.customer : (paymentIntent.customer?.id ?? null)
    if (customer !== wanted) return 'customer_mismatch'
  }
  return null
}

function mismatchAnswer(reason: FlowMismatch, row: FlowRow, paymentIntent: Stripe.PaymentIntent): FinaliseFlowOutput {
  const pendingId = row.id
  switch (reason) {
    case 'payment_not_succeeded':
      return { finalised: false, pendingId, reason, paymentNotSucceeded: true, piStatus: paymentIntent.status, message: flowNotSucceededMessage(paymentIntent.status) }
    case 'metadata_mismatch':
      return { finalised: false, pendingId, reason, message: 'This PaymentIntent does not belong to this payment (metadata mismatch) — check it in Stripe before doing anything.' }
    case 'currency_mismatch':
      return { finalised: false, pendingId, reason, message: `The reader payment is in ${paymentIntent.currency.toUpperCase()}, not GBP — check it in Stripe before doing anything.` }
    case 'amount_mismatch':
      return {
        finalised: false,
        pendingId,
        reason,
        message: `The reader charged £${(paymentIntent.amount_received / 100).toFixed(2)} but £${Number.parseFloat(row.expected_amount).toFixed(2)} was expected — do NOT retry. Check the PaymentIntent (${paymentIntent.id}) in Stripe and refund/adjust manually.`,
      }
    case 'customer_mismatch':
      return { finalised: false, pendingId, reason, message: flowCustomerMismatchMessage(paymentIntent.id) }
  }
}

// --- The transactions

const actorEntry = (options: Pick<ReaderRouteOptions, 'actor' | 'requestId'>, pendingId: string) => ({
  actorType: options.actor.type,
  actorId: options.actor.id,
  entityType: 'reader_payment',
  entityId: pendingId,
  requestId: options.requestId,
})

/** Runs `work` in a transaction of its own, once more after a deadlock (it calls nothing outside the database). */
async function inTransaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const opensItsOwn = !inOpenTransaction(db)
  try {
    return await db.transaction(work)
  } catch (err) {
    if (!opensItsOwn || !isDeadlock(err)) throw err
    return db.transaction(work)
  }
}

/** The session's places given back, as releaseSessionCapacity did: a private session back to empty. */
async function releasePlaces(tx: Tx, sessionId: string, partySize: number, bookingType?: string): Promise<void> {
  await tx.query(
    `UPDATE sessions s
     SET total_booked = CASE WHEN COALESCE($2::text, st.booking_type) = 'private' THEN 0 ELSE s.total_booked - $3::int END, updated_at = now()
     FROM service_types st
     WHERE s.id = $1::uuid AND st.id = s.service_type_id`,
    [sessionId, bookingType ?? null, partySize]
  )
}

export type FlowFinaliseOutcome =
  | { finalised: true; alreadyFinalised: boolean; orderId: string | null }
  /** The row was undone (or is gone) while the payment succeeded: recorded for the automatic refund. */
  | { finalised: false; reason: 'charged_without_record' }
  | { finalised: false; reason: FlowMismatch }

/**
 * The flow's T2, in one transaction: locks the row, re-checks it is pending and the payment still checks
 * out, then what finaliseMovePending, finaliseSettlePending and finaliseAddGuestPending did: the payment
 * recorded as its own paid order with its booking line (none for add-ons alone), the gift card part in the
 * card's history, a move's old places and pass session given back, an Add Guest's add-on lines linked to
 * the order; then the row marked finalised and `reader_payment.finalise` recorded. All or nothing. An
 * order already carrying this PaymentIntent (the old finalise recorded it and then failed to mark the row)
 * is taken as recorded: only the mark is left, as the old code did.
 */
export async function finaliseFlowInTransaction(
  db: Db,
  pendingId: string,
  paymentIntent: Stripe.PaymentIntent,
  options: Pick<ReaderRouteOptions, 'actor' | 'requestId'>
): Promise<FlowFinaliseOutcome> {
  return inTransaction(db, async (tx) => {
    const row = await readFlow(tx, pendingId, true)
    const entry = actorEntry(options, pendingId)
    if (!row || row.status === 'cancelled') {
      // The money is on its way to nobody: kept where reconcile refunds it (W12 calls) and the stuck list shows it.
      await audit.recordAll(tx, [{
        ...entry,
        action: 'reader_payment.charge_without_record',
        details: { paymentIntentId: paymentIntent.id, amount: paymentIntent.amount_received, flow: row?.flow ?? null, recordId: row?.record_id ?? null },
      }])
      return { finalised: false, reason: 'charged_without_record' }
    }
    if (row.status === 'finalised') {
      const recorded = await tx.query<{ id: string }>('SELECT id FROM orders WHERE stripe_payment_intent_id = $1 LIMIT 1', [paymentIntent.id])
      return { finalised: true, alreadyFinalised: true, orderId: recorded[0]?.id ?? null }
    }
    const wrong = flowPaymentMismatch(row, paymentIntent)
    if (wrong) return { finalised: false, reason: wrong }

    const snapshot = row.snapshot
    const isMove = row.flow === 'move'
    await lockForOrder(tx, {
      customerId: snapshot.customer_id,
      promoCode: null,
      sessionId: isMove ? (snapshot.old_session_id ?? null) : null,
      creditMembershipId: null,
      sessionPassId: isMove && snapshot.release_session_pass_on_finalise ? (snapshot.old_redeemed_session_pass_id ?? null) : null,
      addonMembershipIds: [],
      productVariantIds: [],
      eventId: null,
      giftCardId: null,
    })

    const recorded = await tx.query<{ id: string }>('SELECT id FROM orders WHERE stripe_payment_intent_id = $1 LIMIT 1', [paymentIntent.id])
    let orderId = recorded[0]?.id ?? null
    if (!orderId) {
      const amount = Number.parseFloat(row.expected_amount)
      // recordReaderChargeOrder: one paid order, and its booking line unless only add-ons were paid for.
      orderId = (
        await tx.query<{ id: string }>(
          `INSERT INTO orders (customer_id, order_total, payment_status, order_source, payment_method, stripe_payment_intent_id, created_at)
           VALUES ($1::uuid, $2::numeric, 'paid', 'staff_created', 'reader', $3::text, clock_timestamp())
           RETURNING id`,
          [snapshot.customer_id, amount, paymentIntent.id]
        )
      )[0]?.id as string
      const withBookingLine = row.flow !== 'add_guest' || Boolean(snapshot.guest_row_id)
      if (withBookingLine) {
        await tx.query(
          `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, booking_id, created_at)
           VALUES ($1::uuid, 'booking', 1, $2::numeric, $2::numeric, $3::uuid, clock_timestamp())`,
          [orderId, amount, row.record_id]
        )
      }
      if (row.flow === 'add_guest' && (snapshot.addon_line_ids ?? []).length > 0) {
        await tx.query('UPDATE addon_order_lines SET order_id = $1::uuid WHERE id = ANY($2::uuid[])', [orderId, snapshot.addon_line_ids ?? []])
      }
      // recordGiftCardPart: this booking, no order (the reader payment's order holds only the card money).
      if (snapshot.gift_card && snapshot.gift_card.amount > 0) {
        await tx.query(
          `INSERT INTO gift_card_redemptions (gift_card_id, order_id, booking_id, amount_used, redeemed_at)
           VALUES ($1::uuid, NULL, $2::uuid, $3::numeric, now())`,
          [snapshot.gift_card.gift_card_id, row.record_id, snapshot.gift_card.amount]
        )
      }
      // A move held the old session's places (and a pass session it released) until the payment landed.
      if (isMove && snapshot.old_session_id && snapshot.party_size) {
        await releasePlaces(tx, snapshot.old_session_id, snapshot.party_size)
      }
      if (isMove && snapshot.release_session_pass_on_finalise && snapshot.old_redeemed_session_pass_id) {
        await tx.query(
          `UPDATE customer_session_passes SET sessions_remaining = sessions_remaining + 1, updated_at = now()
           WHERE id = $1::uuid AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date`,
          [snapshot.old_redeemed_session_pass_id]
        )
      }
    }
    const marked = await tx.query("UPDATE pending_reader_payments SET status = 'finalised', updated_at = now() WHERE id = $1::uuid AND status = 'pending' RETURNING id", [pendingId])
    if (marked.length !== 1) throw new Error('The reader payment was not marked finalised.')
    await audit.recordAll(tx, [{
      ...entry,
      action: 'reader_payment.finalise',
      details: { flow: row.flow, recordId: row.record_id, paymentIntentId: paymentIntent.id, collected: Number.parseFloat(row.expected_amount), orderId, alreadyRecorded: recorded.length > 0 },
    }])
    return { finalised: true, alreadyFinalised: false, orderId }
  })
}

export type FlowUndoOutcome =
  | { undone: true; problems: string[] }
  | { undone: false; reason: 'already_cancelled' | 'already_finalised' | 'gone' }

/**
 * The flow's undo, in one transaction: locks the row, re-checks it is pending, then what undoMovePending,
 * undoSettlePending and undoAddGuestPending did, and reversePendingMoneyParts after them, then the row marked
 * cancelled and `reader_payment.cancel` recorded. All or nothing, so nothing is given back twice and nothing
 * is given back without the mark (W03a later 1). The locks are taken in LOCK_ORDER after the row: the
 * customer (store credit), the session, the memberships (add-on credits), the gift card. What the old code
 * reported as a problem without failing (a settled booking someone else changed, left as found; store
 * credit Postgres refused to give) is still a warning; anything that fails rolls the whole undo back.
 */
export async function undoFlowInTransaction(db: Db, pendingId: string, options: Pick<ReaderRouteOptions, 'actor' | 'requestId'> & { why: string }): Promise<FlowUndoOutcome> {
  return inTransaction(db, async (tx) => {
    const row = await readFlow(tx, pendingId, true)
    if (!row) return { undone: false, reason: 'gone' }
    if (row.status === 'cancelled') return { undone: false, reason: 'already_cancelled' }
    if (row.status === 'finalised') return { undone: false, reason: 'already_finalised' }
    const snapshot = row.snapshot
    const problems: string[] = []

    const placesSession =
      row.flow === 'move' ? (snapshot.new_session_id ?? null) : row.flow === 'add_guest' && snapshot.claimed_extra_capacity ? (snapshot.session_id ?? null) : null
    await lockForOrder(tx, {
      customerId: snapshot.customer_id,
      promoCode: null,
      sessionId: placesSession,
      creditMembershipId: null,
      sessionPassId: null,
      addonMembershipIds: row.flow === 'add_guest' ? (snapshot.addon_credits ?? []).map((credit) => credit.membership_id) : [],
      productVariantIds: [],
      eventId: null,
      giftCardId: snapshot.gift_card?.gift_card_id ?? null,
    })

    if (row.flow === 'move' && snapshot.booking_id && snapshot.old_session_id) {
      // The new session's places; the old session's were never given back while pending.
      if (snapshot.new_session_id && snapshot.party_size) await releasePlaces(tx, snapshot.new_session_id, snapshot.party_size, snapshot.new_session_booking_type)
      await tx.query(
        `UPDATE bookings
         SET session_id = $1::uuid, start_time = $2::timestamptz, end_time = $3::timestamptz,
             price_paid = CASE WHEN $4::numeric IS NULL THEN $5::numeric ELSE price_paid - $4::numeric END,
             band_id = $6::uuid, credit_period_id = $7::uuid, redemption_source = $8::text, redeemed_membership_id = $9::uuid,
             redeemed_session_pass_id = CASE WHEN $10::boolean THEN $11::uuid ELSE redeemed_session_pass_id END,
             updated_at = now()
         WHERE id = $12::uuid`,
        [
          snapshot.old_session_id,
          snapshot.old_start_time ?? null,
          snapshot.old_end_time ?? null,
          snapshot.price_paid_change ?? null,
          snapshot.old_price_paid ?? null,
          snapshot.old_band_id ?? null,
          snapshot.old_credit_period_id ?? null,
          snapshot.old_redemption_source ?? 'paid',
          snapshot.old_redeemed_membership_id ?? null,
          snapshot.old_redeemed_session_pass_id !== undefined,
          snapshot.old_redeemed_session_pass_id ?? null,
          snapshot.booking_id,
        ]
      )
      for (const seat of snapshot.seats ?? []) {
        // The snapshot keeps a missing unit_price (private and pre-band seats) as '': NULL goes back.
        await tx.query('UPDATE booking_guests SET unit_price = $1::numeric, pay_by = $2::text WHERE id = $3::uuid', [seat.unit_price === '' ? null : seat.unit_price, seat.pay_by, seat.id])
      }
    }

    if (row.flow === 'settle') {
      const restored = await tx.query(
        `UPDATE bookings
         SET status = $1::text, redemption_source = $2::text, redeemed_membership_id = $3::uuid, credit_period_id = $4::uuid,
             price_paid = $5::numeric, payment_due_by = $6::timestamptz, updated_at = now()
         WHERE id = $7::uuid AND status = 'confirmed'
         RETURNING id`,
        [
          snapshot.old_status ?? 'payment_needed',
          snapshot.old_redemption_source ?? null,
          snapshot.old_redeemed_membership_id ?? null,
          snapshot.old_credit_period_id ?? null,
          snapshot.old_price_paid ?? null,
          snapshot.old_payment_due_by ?? null,
          row.record_id,
        ]
      )
      if (restored.length === 0) {
        problems.push('restore the booking to payment_needed: the booking was changed by someone else while the payment was pending — it was left as found; no payment was taken')
      }
      if (snapshot.old_seat1_pay_by !== undefined) {
        await tx.query("UPDATE booking_guests SET pay_by = $1::text WHERE booking_id = $2::uuid AND guest_type = 'account_holder'", [snapshot.old_seat1_pay_by ?? null, row.record_id])
      }
    }

    if (row.flow === 'add_guest') {
      const increment = snapshot.price_increment ?? 0
      if (snapshot.guest_row_id) {
        await tx.query('DELETE FROM booking_guests WHERE id = $1::uuid', [snapshot.guest_row_id])
        // The party grew by one whenever a guest was added, even a free one.
        await tx.query('UPDATE bookings SET price_paid = price_paid - $1::numeric, party_size = party_size - 1, updated_at = now() WHERE id = $2::uuid', [increment, row.record_id])
      }
      if ((snapshot.addon_line_ids ?? []).length > 0) await tx.query('DELETE FROM addon_order_lines WHERE id = ANY($1::uuid[])', [snapshot.addon_line_ids ?? []])
      for (const credit of snapshot.addon_credits ?? []) {
        await tx.query('UPDATE customer_memberships SET addon_credits_remaining = addon_credits_remaining + $1::int, updated_at = now() WHERE id = $2::uuid', [credit.quantity, credit.membership_id])
      }
      if (increment > 0 && snapshot.order_line_item_id) {
        // The order total first: it finds the order through the line, so the line must still exist.
        await tx.query(
          'UPDATE orders SET order_total = order_total - $1::numeric, updated_at = now() WHERE id = (SELECT order_id FROM order_line_items WHERE id = $2::uuid)',
          [increment, snapshot.order_line_item_id]
        )
        await tx.query('DELETE FROM order_line_items WHERE id = $1::uuid', [snapshot.order_line_item_id])
      }
      if (snapshot.claimed_extra_capacity && snapshot.session_id) {
        await tx.query('UPDATE sessions SET total_booked = total_booked - 1, updated_at = now() WHERE id = $1::uuid', [snapshot.session_id])
      }
    }

    // reversePendingMoneyParts: the store credit and gift card parts claimed while the payment was pending.
    if (snapshot.store_credit_amount && snapshot.store_credit_amount > 0) {
      const given = (
        await tx.query<{ result: { ok?: boolean } | null }>(
          'SELECT public.store_credit_apply($1::uuid, $2::numeric, $3::text, NULL::uuid, $4::uuid, NULL::uuid, $5::text, NULL::uuid) AS result',
          [
            snapshot.customer_id,
            snapshot.store_credit_amount,
            'redemption_reversal',
            row.record_id,
            `Automatic reversal — the reader payment was cancelled or its finalisation failed. [ref ${crypto.randomUUID()}]`,
          ]
        )
      )[0]?.result
      if (given?.ok !== true) problems.push('store credit reversal failed: check their balance before putting it back by hand')
    }
    if (snapshot.gift_card) {
      await tx.query(
        `UPDATE gift_cards
         SET remaining_balance = remaining_balance + $1::numeric,
             redeemed_at = CASE WHEN remaining_balance <= 0 THEN NULL ELSE redeemed_at END,
             updated_at = now()
         WHERE id = $2::uuid`,
        [snapshot.gift_card.amount, snapshot.gift_card.gift_card_id]
      )
      if (snapshot.gift_card.stamped_redeemed_at) {
        await tx.query('UPDATE gift_cards SET redeemed_at = NULL WHERE id = $1::uuid AND redeemed_at IS NOT NULL', [snapshot.gift_card.gift_card_id])
      }
    }

    const marked = await tx.query("UPDATE pending_reader_payments SET status = 'cancelled', updated_at = now() WHERE id = $1::uuid AND status = 'pending' RETURNING id", [pendingId])
    if (marked.length !== 1) throw new Error('The reader payment was not marked cancelled.')
    await audit.recordAll(tx, [{ ...actorEntry(options, pendingId), action: 'reader_payment.cancel', details: { why: options.why, flow: row.flow, recordId: row.record_id, snapshot, problems } }])
    return { undone: true, problems }
  })
}

// --- Finalise

type FoundFlow =
  | { kind: 'gone' }
  | { kind: 'old'; row: FlowRow }
  | { kind: 'no_intent'; row: FlowRow }
  | { kind: 'flow'; row: FlowRow & { payment_intent_id: string } }

async function findFlow(db: Db, pendingId: string): Promise<FoundFlow> {
  const row = await readFlow(db, pendingId)
  if (!row) return { kind: 'gone' }
  if (!isWorkerFlow(row.snapshot)) return { kind: 'old', row }
  if (typeof row.payment_intent_id !== 'string') return { kind: 'no_intent', row }
  return { kind: 'flow', row: row as FlowRow & { payment_intent_id: string } }
}

const basics = (row: FlowRow) => ({ pendingId: row.id, flow: row.flow, recordId: row.record_id })

async function finaliseFound(
  db: Db,
  stripe: StripeClient,
  pendingId: string,
  found: FoundFlow,
  options: ReaderRouteOptions,
  timing: StripeTiming | undefined,
  known?: Stripe.PaymentIntent
): Promise<FinaliseFlowOutput> {
  if (found.kind === 'gone') return { finalised: false, pendingId, reason: 'not_found', message: FLOW_GONE_MESSAGE }
  if (found.kind === 'old') return { finalised: false, ...basics(found.row), reason: 'old_reader_flow', message: OLD_READER_FLOW_MESSAGE }
  const { row } = found
  if (row.status === 'finalised') {
    return { finalised: true, ...basics(row), ...(row.payment_intent_id ? { paymentIntentId: row.payment_intent_id } : {}), alreadyFinalised: true, message: FLOW_ALREADY_FINALISED_MESSAGE }
  }
  if (row.status === 'cancelled') return { finalised: false, pendingId, reason: 'unexpected_state', message: FLOW_ALREADY_CANCELLED_MESSAGE }
  // Its intent may exist, though nobody has its secret: reconcile finds it in Stripe by the row's id.
  if (found.kind === 'no_intent') return { finalised: false, ...basics(row), reason: 'intent_unconfirmed', message: FLOW_INTENT_UNCONFIRMED_MESSAGE }

  let paymentIntent: Stripe.PaymentIntent
  try {
    paymentIntent = known ?? (await stripe.paymentIntents.retrieve(found.row.payment_intent_id, undefined, sendOptions(timing)))
  } catch (err) {
    return { finalised: false, pendingId, reason: 'unexpected_state', message: isMissing(err) ? 'PaymentIntent not found' : (stripeMessage(err) ?? FLOW_LOOK_UP_FAILED_MESSAGE) }
  }
  const wrong = flowPaymentMismatch(row, paymentIntent)
  if (wrong) return mismatchAnswer(wrong, row, paymentIntent)

  let outcome: FlowFinaliseOutcome
  try {
    outcome = await finaliseFlowInTransaction(db, pendingId, paymentIntent, options)
  } catch {
    // Nothing was written (one transaction): held for reconcile, which finalises it again; never refunded (W6-3).
    return { finalised: false, ...basics(row), reason: 'finalise_failed', message: FLOW_PAID_NOT_FINISHED_MESSAGE }
  }
  if (!outcome.finalised) {
    if (outcome.reason === 'charged_without_record') return { finalised: false, ...basics(row), reason: 'charged_without_record', message: FLOW_CHARGED_WITHOUT_RECORD_MESSAGE }
    return mismatchAnswer(outcome.reason, row, paymentIntent)
  }
  if (outcome.alreadyFinalised) return { finalised: true, ...basics(row), paymentIntentId: paymentIntent.id, alreadyFinalised: true, message: FLOW_ALREADY_FINALISED_MESSAGE }
  return { finalised: true, ...basics(row), paymentIntentId: paymentIntent.id }
}

/**
 * The Stripe deadline: the caller's own (W14b, W12-6: a staff member's reconcile run, which ends its Stripe calls
 * sooner than a press's 30 s, as its orders already do), else the press's from the request's start, else none.
 */
function flowTiming(options: ReaderRouteOptions): StripeTiming | undefined {
  if (options.timing) return options.timing
  return options.startedAt === undefined ? undefined : stripeTiming(options.startedAt, options.now ?? Date.now)
}

/**
 * finaliseReaderPayment: the reader has taken (or should have taken) a Move, Settle or Add Guest
 * payment. Reads the PaymentIntent, checks it to the penny, then the flow's T2 records it in one
 * transaction. Safe twice and racing cancel. Never refunds: a database fault in T2 holds it for
 * reconcile (`finalise_failed`), where the old function refunded the card and undid the flow.
 */
export async function finaliseReaderFlow(db: Db, stripe: StripeClient, pendingId: string, options: ReaderRouteOptions): Promise<FinaliseFlowOutput> {
  const timing = flowTiming(options)
  return finaliseFound(db, stripe, pendingId, await findFlow(db, pendingId), options, timing)
}

// --- Cancel

/**
 * cancelReaderPayment: the reader payment was cancelled, declined or timed out. Asks Stripe to cancel
 * the intent (the legacy route's cancel, W11's settleIntent, with its rule that a 404 means "never
 * existed" only from a key of the intent's own mode). Succeeded: the flow is finalised instead (the money
 * moved). Cancelled: the flow's undo, in one transaction. Anything unclear changes nothing. Safe twice.
 */
export async function cancelReaderFlow(db: Db, stripe: StripeClient, pendingId: string, options: ReaderRouteOptions): Promise<CancelFlowOutput> {
  const timing = flowTiming(options)
  const found = await findFlow(db, pendingId)
  if (found.kind === 'gone') return { cancelled: true, pendingId, alreadyDone: true, message: FLOW_GONE_CANCEL_MESSAGE }
  if (found.kind === 'old') return { cancelled: false, ...basics(found.row), reason: 'old_reader_flow', message: OLD_READER_FLOW_MESSAGE }
  const { row } = found
  if (row.status === 'cancelled') return { cancelled: true, ...basics(row), alreadyDone: true, message: FLOW_CANCEL_ALREADY_DONE_MESSAGE }
  if (row.status === 'finalised') return { cancelled: false, ...basics(row), reason: 'already_finalised', message: FLOW_CANCEL_FINALISED_MESSAGE }
  if (found.kind === 'no_intent') return { cancelled: false, ...basics(row), reason: 'intent_unconfirmed', message: FLOW_INTENT_UNCONFIRMED_MESSAGE }

  const settled = await settleIntent(stripe, { payment_intent_id: found.row.payment_intent_id, livemode: row.snapshot.livemode }, timing)
  if (settled.kind === 'unclear') return { cancelled: false, ...basics(row), reason: 'stripe_error', message: settled.message || FLOW_CANCEL_FAILED_MESSAGE }
  if (settled.kind === 'succeeded') {
    // Finalised with the PaymentIntent just read: the old function read it once more.
    const finaliseResult = await finaliseFound(db, stripe, pendingId, found, options, timing, settled.paymentIntent)
    return {
      cancelled: false,
      ...basics(row),
      finalisedInstead: finaliseResult.finalised,
      finaliseResult,
      message: finaliseResult.finalised
        ? `The reader payment actually succeeded — the ${flowLabel(row.flow)} was completed instead of cancelled.`
        : `The reader payment actually succeeded, but completing the ${flowLabel(row.flow)} failed: ${finaliseResult.message ?? finaliseResult.reason ?? ''}`,
      ...(finaliseResult.warning ? { warning: finaliseResult.warning } : {}),
    }
  }

  let undone: FlowUndoOutcome
  try {
    undone = await undoFlowInTransaction(db, pendingId, { actor: options.actor, requestId: options.requestId, why: `The card reader payment was cancelled (${settled.status}).` })
  } catch {
    // Nothing was changed (one transaction): still pending, for the next try.
    return { cancelled: false, ...basics(row), reason: 'undo_incomplete', message: FLOW_UNDO_INCOMPLETE_MESSAGE }
  }
  if (!undone.undone) {
    if (undone.reason === 'already_finalised') return { cancelled: false, ...basics(row), reason: 'already_finalised', message: FLOW_CANCEL_FINALISED_MESSAGE }
    return { cancelled: true, ...basics(row), alreadyDone: true, message: undone.reason === 'gone' ? FLOW_GONE_CANCEL_MESSAGE : FLOW_CANCEL_ALREADY_DONE_MESSAGE }
  }
  return {
    cancelled: true,
    ...basics(row),
    ...(undone.problems.length > 0 ? { warning: `The ${flowLabel(row.flow)} was undone with warnings that need a manual check: ${undone.problems.join('; ')}` } : {}),
    message: flowCancelledMessage(row.flow),
  }
}
