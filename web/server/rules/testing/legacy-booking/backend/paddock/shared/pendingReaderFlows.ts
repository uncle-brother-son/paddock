import { storeCreditMoved } from './storeCreditRefund'

/**
 * Shared pending-reader-payment ledger for the flows that now create their writes FIRST and take
 * the reader charge SECOND (checkout keeps its own orders.reader_payment jsonb — it predates this
 * table and is not refactored). One row per pending reader payment; `finaliseReaderPayment.ts` /
 * `cancelReaderPayment.ts` dispatch on `flow` and use `snapshot` to undo exactly what the flow
 * wrote while pending. Each flow creates the PaymentIntent first and inserts its row in the SAME
 * statement that changes the booking: for as long as price_paid holds money not yet collected, this
 * row must exist, or a refund could give that money away.
 *
 * Snapshot contract (what each flow stores):
 *  - common: customer_id, description, money parts claimed while pending (store_credit_amount,
 *    gift_card) so the undo can reverse them.
 *  - move: booking_id, old_* (session/times/price_paid/band/credit/redemption, incl. the redeemed
 *    session pass), seats (old unit_price/pay_by per guest row), new_session_id + its booking_type,
 *    party_size, and release_session_pass_on_finalise when the move released a pass credit.
 *  - settle: booking_id, old_status/price_paid/payment_due_by/redemption_source/
 *    redeemed_membership_id/credit_period_id, old_seat1_pay_by, amount.
 *  - add_guest: booking_id, session_id, guest_row_id (absent when only add-ons were added),
 *    order_line_item_id, price_increment, claimed_extra_capacity, addon_line_ids and addon_credits
 *    (add-on lines written while pending, and the membership add-on credits they claimed).
 */

export type PendingReaderFlow = 'checkout' | 'move' | 'settle' | 'add_guest'
export type PendingReaderStatus = 'pending' | 'finalised' | 'cancelled'

export interface PendingReaderSnapshot {
  customer_id: string
  description: string
  // Shared money parts claimed while pending — reversed by the undo.
  store_credit_amount?: number
  gift_card?: { gift_card_id: string; amount: number; stamped_redeemed_at?: boolean }
  // move
  booking_id?: string
  old_session_id?: string
  old_start_time?: string
  old_end_time?: string
  old_price_paid?: string | null
  /** What the move added to price_paid. An undo takes this off, so a refund that was on its way when
   *  the move started and then failed isn't lost. Absent on older rows: old_price_paid is used. */
  price_paid_change?: number
  old_band_id?: string | null
  old_credit_period_id?: string | null
  old_redemption_source?: string
  old_redeemed_membership_id?: string | null
  /** Absent on rows written before pass levels existed — the undo then leaves the column alone. */
  old_redeemed_session_pass_id?: string | null
  /** The move released a session-pass credit (Core pass into Peak): finalise returns the session
   *  to old_redeemed_session_pass_id; an undo has nothing to re-claim. */
  release_session_pass_on_finalise?: boolean
  seats?: Array<{ id: string; unit_price: string; pay_by: string | null }>
  new_session_id?: string
  new_session_booking_type?: 'public' | 'private'
  party_size?: number
  // settle
  old_status?: string
  old_payment_due_by?: string | null
  old_seat1_pay_by?: string | null
  amount?: number
  // add guest
  session_id?: string
  guest_row_id?: string
  order_line_item_id?: string
  price_increment?: number
  claimed_extra_capacity?: boolean
  addon_line_ids?: string[]
  addon_credits?: Array<{ membership_id: string; quantity: number }>
}

export interface PendingReaderPaymentRow {
  id: string
  flow: PendingReaderFlow
  record_id: string
  order_id: string | null
  payment_intent_id: string | null
  expected_amount: string
  snapshot: PendingReaderSnapshot
  status: PendingReaderStatus
}

export async function loadPendingReaderPayment(id: string): Promise<PendingReaderPaymentRow | null> {
  const result = await paddockData.query<PendingReaderPaymentRow>(
    `SELECT id, flow, record_id, order_id, payment_intent_id, expected_amount, snapshot, status
     FROM pending_reader_payments WHERE id = $1`,
    [id]
  )
  return result.data[0] ?? null
}

export async function markPendingReaderPayment(id: string, status: 'finalised' | 'cancelled'): Promise<void> {
  await paddockData.query(
    `UPDATE pending_reader_payments SET status = $1, updated_at = now() WHERE id = $2`,
    [status, id]
  )
}

/**
 * Claims a pending row for its undo. An undo isn't safe to run twice: it takes money off price_paid
 * and gives store credit back, so only the caller this answers true may run it, and the row is
 * marked first. The sweep and a press of Cancel can arrive together.
 */
export async function claimPendingReaderPaymentForUndo(id: string): Promise<boolean> {
  const claimed = await paddockData.query<{ id: string }>(
    `UPDATE pending_reader_payments SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id]
  )
  return claimed.data.length > 0
}

/**
 * Records a reader charge as the booking-payment order row — the same shape the Worker's
 * charge-saved-card route writes for move/settle/add-guest (one 'paid' orders row plus a single
 * 'booking' line item), so reports and the refund flows see reader payments exactly like
 * saved-card payments.
 */
export async function recordReaderChargeOrder(args: {
  customerId: string
  bookingId: string
  amount: number
  paymentIntentId: string
  description: string
  /** Default true. False for an add-ons-only payment (its money is on the add-on lines). */
  withBookingLine?: boolean
}): Promise<string> {
  const order = await paddockData.query<{ id: string }>(
    `INSERT INTO orders (customer_id, order_total, payment_status, order_source, payment_method, stripe_payment_intent_id)
     VALUES ($1, $2, 'paid', 'staff_created', 'reader', $3)
     RETURNING id`,
    [args.customerId, args.amount, args.paymentIntentId]
  )
  const orderId = order.data[0]!.id
  if (args.withBookingLine === false) return orderId
  await paddockData.query(
    `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, booking_id)
     VALUES ($1, 'booking', 1, $2, $3, $4)`,
    [orderId, args.amount, args.amount, args.bookingId]
  )
  return orderId
}

/** Reverses the money parts a pending flow claimed while waiting for the reader. Best-effort;
 *  returns the problems encountered (empty when everything was put back). */
export async function reversePendingMoneyParts(
  customerId: string,
  snapshot: PendingReaderSnapshot,
  bookingId: string | null
): Promise<string[]> {
  const problems: string[] = []
  if (snapshot.store_credit_amount && snapshot.store_credit_amount > 0) {
    // Found by its note if its answer is lost (shared/storeCreditRefund), so it is never put back twice.
    const back = await storeCreditMoved({
      customerId,
      amount: snapshot.store_credit_amount,
      reason: 'redemption_reversal',
      bookingId,
      staffId: null,
      note: 'Automatic reversal — the reader payment was cancelled or its finalisation failed.',
    })
    if (!back) problems.push('store credit reversal failed: check their balance before putting it back by hand')
  }
  if (snapshot.gift_card) {
    try {
      await paddockData.query(
        `UPDATE gift_cards
         SET remaining_balance = remaining_balance + $1,
             redeemed_at = CASE WHEN remaining_balance <= 0 THEN NULL ELSE redeemed_at END,
             updated_at = now()
         WHERE id = $2`,
        [snapshot.gift_card.amount, snapshot.gift_card.gift_card_id]
      )
      if (snapshot.gift_card.stamped_redeemed_at) {
        // Only un-stamp when this pending flow's claim is what drained the card — mirrored from
        // settleLapsedBooking's own restore logic.
        await paddockData.query(`UPDATE gift_cards SET redeemed_at = NULL WHERE id = $1 AND redeemed_at IS NOT NULL`, [
          snapshot.gift_card.gift_card_id,
        ])
      }
    } catch (err) {
      problems.push(`gift card restore failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return problems
}
