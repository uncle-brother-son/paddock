import { releaseSessionCapacity } from './sessionCapacity'
import { releaseMembershipAddonCredit, releaseSessionPassCredit } from './creditRedemption'
import {
  recordReaderChargeOrder,
  reversePendingMoneyParts,
  type PendingReaderPaymentRow,
  type PendingReaderSnapshot,
} from './pendingReaderFlows'

/**
 * Per-flow finalise + undo for the pending-first reader flows (move / settle / add_guest).
 * Checkout is NOT here — it has its own orders.reader_payment flow (finaliseReaderOrder.ts).
 *
 * Invariant for every flow: the writes happened while the payment was pending, so
 *  - FINALISE  = verify (done by the caller) → record the payment → release any capacity that is
 *    only held until payment lands;
 *  - UNDO      = put the record back exactly as it was and release what the pending writes held;
 *  - the money parts claimed while pending (store credit / gift card) are reversed by
 *    reversePendingMoneyParts (pendingReaderFlows.ts) in every undo.
 */

export interface FlowStepResult {
  problems: string[]
}

async function step(label: string, problems: string[], fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    problems.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Writes the gift card part claimed while pending into the card's redemption history: this booking,
 *  no order (the reader payment's order holds only the card money). Only at finalise, so an undo has
 *  no row to remove. Move, Settle and Add Guest all use it. */
async function recordGiftCardPart(row: PendingReaderPaymentRow, problems: string[]): Promise<void> {
  const giftCard = row.snapshot.gift_card
  if (!giftCard || giftCard.amount <= 0) return
  await step('record the gift card redemption', problems, async () => {
    await paddockData.query(
      `INSERT INTO gift_card_redemptions (gift_card_id, order_id, booking_id, amount_used, redeemed_at)
       VALUES ($1, NULL, $2, $3, now())`,
      [giftCard.gift_card_id, row.record_id, giftCard.amount]
    )
  })
}

// --- MOVE --------------------------------------------------------------------------------------------

/** Finalise a pending move: record the payment (throws on failure — the dispatcher refunds and
 *  undoes) and any gift card part, then release the OLD session's capacity (it was deliberately NOT
 *  released while pending, so the old seat could not be taken while the reader wait was open). A capacity
 *  release failure is a bookkeeping warning, not a payment failure. */
export async function finaliseMovePending(row: PendingReaderPaymentRow): Promise<FlowStepResult> {
  const problems: string[] = []
  const snapshot = row.snapshot
  await recordReaderChargeOrder({
    customerId: snapshot.customer_id,
    bookingId: row.record_id,
    amount: Number.parseFloat(row.expected_amount),
    paymentIntentId: row.payment_intent_id!,
    description: snapshot.description,
  })
  await recordGiftCardPart(row, problems)
  if (snapshot.old_session_id && snapshot.party_size) {
    await step('release the old session capacity', problems, async () => {
      await releaseSessionCapacity(snapshot.old_session_id!, snapshot.party_size!)
    })
  }
  if (snapshot.release_session_pass_on_finalise && snapshot.old_redeemed_session_pass_id) {
    await step('return the session to the pass', problems, async () => {
      await releaseSessionPassCredit(snapshot.old_redeemed_session_pass_id!)
    })
  }
  return { problems }
}

/** Puts a moved booking back as the move snapshot recorded it: old session, times, price_paid
 *  (less what the move added), band, credit and redemption fields (incl. the redeemed session pass
 *  when the snapshot carries it), and each seat's old unit_price / pay_by. Capacity is not touched.
 *  Returns the steps that failed — empty when everything was restored. */
async function restoreMovedBooking(snapshot: PendingReaderSnapshot): Promise<string[]> {
  const problems: string[] = []
  if (!snapshot.booking_id || !snapshot.old_session_id) return problems
  await step('restore the booking row', problems, async () => {
    await paddockData.query(
      `UPDATE bookings
       SET session_id = $1, start_time = $2, end_time = $3,
           price_paid = CASE WHEN $4::numeric IS NULL THEN $5::numeric ELSE price_paid - $6::numeric END,
           band_id = $7, credit_period_id = $8, redemption_source = $9, redeemed_membership_id = $10,
           redeemed_session_pass_id = CASE WHEN $11::boolean THEN $12::uuid ELSE redeemed_session_pass_id END,
           updated_at = now()
       WHERE id = $13`,
      [
        snapshot.old_session_id,
        snapshot.old_start_time ?? null,
        snapshot.old_end_time ?? null,
        snapshot.price_paid_change ?? null,
        snapshot.old_price_paid ?? null,
        snapshot.price_paid_change ?? null,
        snapshot.old_band_id ?? null,
        snapshot.old_credit_period_id ?? null,
        snapshot.old_redemption_source ?? 'paid',
        snapshot.old_redeemed_membership_id ?? null,
        snapshot.old_redeemed_session_pass_id !== undefined,
        snapshot.old_redeemed_session_pass_id ?? null,
        snapshot.booking_id,
      ]
    )
  })
  for (const seat of snapshot.seats ?? []) {
    await step('restore the seat price', problems, async () => {
      // The snapshot stores a missing unit_price (private and pre-band seats) as '' — put NULL back.
      await paddockData.query(`UPDATE booking_guests SET unit_price = $1, pay_by = $2 WHERE id = $3`, [
        seat.unit_price === '' ? null : seat.unit_price,
        seat.pay_by,
        seat.id,
      ])
    })
  }
  return problems
}

/** Undo a pending move: the booking goes back to its old session with its old seat prices,
 *  price_paid, band, credit and redemption fields; the NEW session's held capacity is released.
 *  The OLD session's capacity was never released while pending, so there is nothing to re-claim —
 *  no race window on the old seat. */
export async function undoMovePending(row: PendingReaderPaymentRow): Promise<FlowStepResult> {
  const problems: string[] = []
  const snapshot = row.snapshot
  if (!snapshot.booking_id || !snapshot.old_session_id) return { problems }

  if (snapshot.new_session_id && snapshot.party_size) {
    await step('release the new session capacity', problems, async () => {
      await releaseSessionCapacity(snapshot.new_session_id!, snapshot.party_size!, snapshot.new_session_booking_type)
    })
  }
  problems.push(...(await restoreMovedBooking(snapshot)))
  // Give back the store credit / gift card part claimed while the payment was pending (it was
  // recorded on the snapshot but never reversed, so a cancelled reader payment kept it).
  problems.push(...(await reversePendingMoneyParts(row.snapshot.customer_id, row.snapshot, row.record_id)))
  return { problems }
}

// --- SETTLE -------------------------------------------------------------------------------------------

/** Finalise a pending settle: the booking is already confirmed (flipped while pending, guarded on
 *  status = 'payment_needed'); record the payment and any gift card part. Capacity untouched (the
 *  payment_needed booking already held its seat). */
export async function finaliseSettlePending(row: PendingReaderPaymentRow): Promise<FlowStepResult> {
  const problems: string[] = []
  await recordReaderChargeOrder({
    customerId: row.snapshot.customer_id,
    bookingId: row.record_id,
    amount: Number.parseFloat(row.expected_amount),
    paymentIntentId: row.payment_intent_id!,
    description: row.snapshot.description,
  })
  await recordGiftCardPart(row, problems)
  return { problems }
}

/** Undo a pending settle: restore payment_needed and the booking's previous money fields
 *  (guarded on status = 'confirmed' — if the booking was cancelled by someone else while the
 *  reader wait was open, it is left cancelled and the problem is reported). */
export async function undoSettlePending(row: PendingReaderPaymentRow): Promise<FlowStepResult> {
  const problems: string[] = []
  const snapshot = row.snapshot
  await step('restore the booking to payment_needed', problems, async () => {
    const restored = await paddockData.query<{ id: string }>(
      `UPDATE bookings
       SET status = $1, redemption_source = $2, redeemed_membership_id = $3, credit_period_id = $4,
           price_paid = $5, payment_due_by = $6, updated_at = now()
       WHERE id = $7 AND status = 'confirmed'
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
    if (restored.data.length === 0) {
      problems.push('the booking was changed by someone else while the payment was pending — it was left as found; the payment has been refunded')
    }
  })
  if (snapshot.old_seat1_pay_by !== undefined) {
    await step('restore seat 1 coverage', problems, async () => {
      await paddockData.query(
        `UPDATE booking_guests SET pay_by = $1 WHERE booking_id = $2 AND guest_type = 'account_holder'`,
        [snapshot.old_seat1_pay_by ?? null, row.record_id]
      )
    })
  }
  // Give back the store credit / gift card part claimed while the payment was pending (it was
  // recorded on the snapshot but never reversed, so a cancelled reader payment kept it).
  problems.push(...(await reversePendingMoneyParts(row.snapshot.customer_id, row.snapshot, row.record_id)))
  return { problems }
}

// --- ADD GUEST ----------------------------------------------------------------------------------------

/** Finalise a pending add-guest (a guest and/or add-ons): the guest row, the party-size bump and
 *  the add-on lines already happened while pending; record the payment as its own order, link the
 *  add-on lines to it, and record any gift card part in the card's redemption history. */
export async function finaliseAddGuestPending(row: PendingReaderPaymentRow): Promise<FlowStepResult> {
  const problems: string[] = []
  const orderId = await recordReaderChargeOrder({
    customerId: row.snapshot.customer_id,
    bookingId: row.record_id,
    amount: Number.parseFloat(row.expected_amount),
    paymentIntentId: row.payment_intent_id!,
    description: row.snapshot.description,
    withBookingLine: Boolean(row.snapshot.guest_row_id),
  })
  const addonLineIds = row.snapshot.addon_line_ids ?? []
  if (addonLineIds.length > 0) {
    await step('link the add-ons to the reader payment order', problems, async () => {
      await paddockData.query('UPDATE addon_order_lines SET order_id = $1 WHERE id = ANY($2::uuid[])', [orderId, addonLineIds])
    })
  }
  await recordGiftCardPart(row, problems)
  return { problems }
}

/** Undo a pending add-guest: remove the guest row, undo the party-size/price bump, remove the
 *  order line (and order_total bump) the flow added, release the claimed extra seat, and reverse
 *  the money parts. */
export async function undoAddGuestPending(row: PendingReaderPaymentRow): Promise<FlowStepResult> {
  const problems: string[] = []
  const snapshot = row.snapshot
  const increment = snapshot.price_increment ?? 0
  if (snapshot.guest_row_id) {
    const guestRowId = snapshot.guest_row_id
    await step('remove the added guest row', problems, async () => {
      await paddockData.query(`DELETE FROM booking_guests WHERE id = $1`, [guestRowId])
    })
    // The party grew by one whenever a guest was added, even a free one (a guest whose seat cost
    // nothing still came with paid add-ons on the reader).
    await step('undo the booking price/party bump', problems, async () => {
      await paddockData.query(
        `UPDATE bookings SET price_paid = price_paid - $1, party_size = party_size - 1, updated_at = now() WHERE id = $2`,
        [increment, row.record_id]
      )
    })
  }
  const addonLineIds = snapshot.addon_line_ids ?? []
  if (addonLineIds.length > 0) {
    await step('remove the added add-ons', problems, async () => {
      await paddockData.query(`DELETE FROM addon_order_lines WHERE id = ANY($1::uuid[])`, [addonLineIds])
    })
  }
  for (const credit of snapshot.addon_credits ?? []) {
    await step('give the add-on credits back', problems, async () => {
      await releaseMembershipAddonCredit(credit.membership_id, credit.quantity)
    })
  }
  if (increment > 0) {
    if (snapshot.order_line_item_id) {
      const lineId = snapshot.order_line_item_id
      // The order total first: it finds the order through the line, so the line must still exist.
      await step('undo the order total bump', problems, async () => {
        await paddockData.query(
          `UPDATE orders SET order_total = order_total - $1, updated_at = now()
           WHERE id = (SELECT order_id FROM order_line_items WHERE id = $2)`,
          [increment, lineId]
        )
      })
      await step('remove the added order line', problems, async () => {
        await paddockData.query(`DELETE FROM order_line_items WHERE id = $1`, [lineId])
      })
    }
  }
  if (snapshot.claimed_extra_capacity && snapshot.session_id) {
    const sessionId = snapshot.session_id
    await step('release the claimed extra seat', problems, async () => {
      await paddockData.query(`UPDATE sessions SET total_booked = total_booked - 1, updated_at = now() WHERE id = $1`, [
        sessionId,
      ])
    })
  }
  // Give back the store credit / gift card part claimed while the payment was pending (it was
  // recorded on the snapshot but never reversed, so a cancelled reader payment kept it).
  problems.push(...(await reversePendingMoneyParts(row.snapshot.customer_id, row.snapshot, row.record_id)))
  return { problems }
}
