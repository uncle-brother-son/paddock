// New in W27 (E-plan 4.5; Wayne's Q39, 14 Nov): money owed on an order. Card money a refund on the order should have
// given back and didn't (Stripe refused it, or never got it) is left for staff as "£X still to refund", with Refund
// the rest and It already arrived, exactly as on a booking; the system never turns it into store credit. It lives in
// `orders.refund_owed_amount` (migration 023). Not called by any route yet: W28 raises it from R2 and reconcile and
// lowers it from the two buttons; W30 uses the same row for an event booking.
//
// An event booking's money owed is its order's (E-plan 4.4): an event booking is always paid by one order, the card
// refund that failed was on that order's payment, and Refund the rest sends it back to that same payment, so one
// figure on the order serves both and nothing can be owed twice. `moneyOwedOnEventBooking` reads it for the attendee
// list.
//
// Unlike a live booking, an order has no `price_paid` that falls and rises with what is owed: the order's lines stay
// stamped as refunded, and the money owed is this one figure alone (as on a cancelled booking, W25).
import 'server-only'
import type { Queryable, Tx } from '@/server/db'

const round2 = (n: number): number => Math.round(n * 100) / 100

/** What is owed on the order now, or null when the order doesn't exist. Never negative (the column's check). */
export async function moneyOwedOnOrder(db: Queryable, orderId: string): Promise<number | null> {
  const row = (await db.query<{ owed: string }>('SELECT refund_owed_amount::text AS owed FROM orders WHERE id = $1::uuid', [orderId]))[0]
  return row ? Number.parseFloat(row.owed) : null
}

/**
 * What is owed on the event booking's order, with that order, or null when the booking has no order line (none can be
 * sold without one). The attendee list shows it; the buttons act on the order.
 */
export async function moneyOwedOnEventBooking(db: Queryable, eventBookingId: string): Promise<{ orderId: string; owed: number } | null> {
  const row = (
    await db.query<{ order_id: string; owed: string }>(
      `SELECT o.id AS order_id, o.refund_owed_amount::text AS owed
       FROM order_line_items oli JOIN orders o ON o.id = oli.order_id
       WHERE oli.event_booking_id = $1::uuid AND oli.item_type = 'event'
       ORDER BY oli.created_at, oli.id LIMIT 1`,
      [eventBookingId]
    )
  )[0]
  return row ? { orderId: row.order_id, owed: Number.parseFloat(row.owed) } : null
}

function positive(amount: number, what: string): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error(`${what}: the amount isn't a number.`)
  const pounds = round2(amount)
  if (!(pounds > 0)) throw new Error(`${what}: the amount must be above £0.`)
  return pounds
}

/**
 * Raises what is owed on the order by `amount` (R2, reconcile or a close by hand, when card money never went), inside
 * the caller's transaction, which holds the order's lock. Answers what is owed after. Throws when the order is gone:
 * the caller's transaction then keeps nothing.
 */
export async function raiseMoneyOwed(tx: Tx, orderId: string, amount: number): Promise<number> {
  const add = positive(amount, 'Raising the money owed on an order')
  const row = (
    await tx.query<{ owed: string }>(
      'UPDATE orders SET refund_owed_amount = refund_owed_amount + $1::numeric, updated_at = now() WHERE id = $2::uuid RETURNING refund_owed_amount::text AS owed',
      [add, orderId]
    )
  )[0]
  if (!row) throw new Error(`Order ${orderId} no longer exists, so the money owed on it can't be recorded.`)
  return Number.parseFloat(row.owed)
}

/** What lowering did: the figure after, or why nothing was lowered (the caller turns it into its own refusal). */
export type Lowered = { ok: true; owed: number } | { ok: false; reason: 'order_not_found' } | { ok: false; reason: 'more_than_owed'; owed: number }

/**
 * Lowers what is owed on the order by `amount` (Refund the rest, It already arrived), inside the caller's
 * transaction, which holds the order's lock. Never below £0: an amount above what is owed lowers nothing and answers
 * `more_than_owed` with the figure. The amount is rounded to the penny first, so a figure within half a penny of all
 * that is owed clears it exactly (Q18). Any amount up to what is owed is taken (audit row 31: It already arrived
 * takes part of it).
 */
export async function lowerMoneyOwed(tx: Tx, orderId: string, amount: number): Promise<Lowered> {
  const take = positive(amount, 'Lowering the money owed on an order')
  const now = (await tx.query<{ owed: string }>('SELECT refund_owed_amount::text AS owed FROM orders WHERE id = $1::uuid FOR UPDATE', [orderId]))[0]
  if (!now) return { ok: false, reason: 'order_not_found' }
  const owed = Number.parseFloat(now.owed)
  // Both are whole pennies by now, so they are compared as pennies.
  if (Math.round(take * 100) > Math.round(owed * 100)) return { ok: false, reason: 'more_than_owed', owed }
  const row = (
    await tx.query<{ owed: string }>(
      'UPDATE orders SET refund_owed_amount = refund_owed_amount - $1::numeric, updated_at = now() WHERE id = $2::uuid AND refund_owed_amount >= $1::numeric RETURNING refund_owed_amount::text AS owed',
      [take, orderId]
    )
  )[0]
  if (!row) throw new Error(`The money owed on order ${orderId} changed under its lock.`)
  return { ok: true, owed: Number.parseFloat(row.owed) }
}
