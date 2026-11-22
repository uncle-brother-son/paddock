import type { Db } from '@/server/db'

/*
 * W64 (H-plan 3.3 step 1): states only the old code could make, written as SQL fixtures for the rule tests that need
 * them, now that those tests set up through the Worker. W25 says none can be made any more (the old checkout and the
 * old flows are gone), but rows from before can still be there, so the Worker's handling of them stays tested.
 */

/**
 * A reader order as the old checkout started it: an intent on the order's `reader_payment` and no `method` (the
 * Worker's mark, reader-order.ts and close-stuck.ts). The order is placed through the Worker; the mark is taken off.
 */
export async function asTheOldCheckoutStartedIt(db: Db, orderId: string): Promise<void> {
  // W64a item 8 (W64 review, "for later" 2): the same five keys asTheOldCodeStartedIt takes off a flow's record. The old
  // createOrder wrote none of them (`channel` and `livemode` too: the Worker's not-found branch reads `livemode`).
  await db.query("UPDATE orders SET reader_payment = reader_payment - 'method' - 'request_id' - 'channel' - 'stripe_customer_id' - 'livemode' WHERE id = $1::uuid", [orderId])
}

/**
 * What the old Cancel & Refund to store credit wrote on a booking whose card order was still held (W12 review P1): the
 * booking cancelled, its seat money given as store credit, the order moved out of pending to partially refunded, and
 * (W64a item 8, as `legacy-booking/backend/paddock/shared/bookingRefund.ts` did in the one statement after the money)
 * nothing left owed, the session's places released (a private session's all of them, else the party's) and the booking's
 * lines stamped refunded to store credit. Only the old screens could do this (the Worker refuses while a payment is
 * unconfirmed): the rows the old function wrote that reconcile, the stuck list and the manual close read.
 */
export async function theOldScreensCancelledItToStoreCredit(db: Db, { bookingId, orderId, customerId, amount }: { bookingId: string; orderId: string; customerId: string; amount: number }): Promise<void> {
  await db.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now(), refund_owed_amount = 0, updated_at = now() WHERE id = $1::uuid", [bookingId])
  const [balance] = await db.query<{ b: string }>('UPDATE customers SET store_credit_balance = store_credit_balance + $1::numeric WHERE id = $2::uuid RETURNING store_credit_balance::text AS b', [amount, customerId])
  await db.query("INSERT INTO store_credit_transactions (customer_id, amount, balance_after, reason, booking_id, note) VALUES ($1::uuid, $2::numeric, $3::numeric, 'refund', $4::uuid, 'Refund for cancelled booking')", [customerId, amount, balance?.b, bookingId])
  await db.query(
    `UPDATE sessions s SET total_booked = CASE WHEN s.type = 'private' THEN 0 ELSE GREATEST(s.total_booked - b.party_size, 0) END, updated_at = now()
     FROM bookings b WHERE b.id = $1::uuid AND s.id = b.session_id`,
    [bookingId]
  )
  await db.query(
    "UPDATE order_line_items SET refunded_at = COALESCE(refunded_at, now()), refund_method = 'credit' WHERE booking_id = $1::uuid AND item_type = 'booking'",
    [bookingId]
  )
  await db.query("UPDATE orders SET payment_status = 'partially_refunded' WHERE id = $1::uuid", [orderId])
}

/**
 * A guest as the old Add Guest left her: no `booking.guest_add` row names her line (the Worker writes one with every
 * guest, W20), so W53's price guess finds her line. Taken off as the tables' owner: the Worker's role only appends.
 */
export async function asTheOldAddGuestLeftIt(db: Db, bookingId: string): Promise<void> {
  await db.query('RESET ROLE')
  try {
    await db.query("DELETE FROM audit_log WHERE action = 'booking.guest_add' AND entity_type = 'booking' AND entity_id = $1", [bookingId])
  } finally {
    await db.query('SET ROLE paddock_worker')
  }
}

/** An order as the old Add Guest wrote it when store credit alone paid: no payment_method (W20; the Worker writes `store_credit`, L9). */
export async function asTheOldAddGuestPaidItByStoreCredit(db: Db, bookingId: string): Promise<void> {
  await db.query(
    "UPDATE orders o SET payment_method = NULL FROM order_line_items l WHERE l.order_id = o.id AND l.booking_id = $1::uuid AND l.item_type = 'booking' AND o.payment_method = 'store_credit'",
    [bookingId]
  )
}

/** A membership order as the old createOrder recorded it: the membership's own first payment not named on the order (W29, Q40's old shape). */
export async function asTheOldCreateOrderRecordedIt(db: Db, orderId: string): Promise<void> {
  await db.query("UPDATE orders SET reader_payment = reader_payment #- '{membership,subscription_payment_intent_id}' WHERE id = $1::uuid", [orderId])
}

/**
 * A reader flow (a Move, Add Guest or Settle on the reader) as the old code started it: its record carries neither the
 * Worker's method nor its request id (reader-flow.ts, isWorkerFlow). The flow is started through the Worker; the
 * mark is taken off.
 */
export async function asTheOldCodeStartedIt(db: Db, pendingId: string): Promise<void> {
  await db.query("UPDATE pending_reader_payments SET snapshot = snapshot - 'method' - 'request_id' - 'channel' - 'stripe_customer_id' - 'livemode' WHERE id = $1::uuid", [pendingId])
}
