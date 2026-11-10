// T2 (W03-plan 2.1), new in W10 for the saved card. What it does is what old code did after the money
// came in: createOrder.ts's stages 34 and 35 (marked paid, the address saved) and finaliseReaderOrder.ts's
// checks on the PaymentIntent and its confirming of a pending event booking.
import 'server-only'
import type Stripe from 'stripe'
import { audit } from '@/server/audit'
import type { Db, Tx } from '@/server/db'
import { pence } from './collect-saved-card'
import type { PendingSnapshot } from './pending-order'

export type FinaliseOutcome =
  /** Marked paid by this call, or found already paid with this PaymentIntent (safe twice). */
  | { finalised: true; alreadyPaid: boolean }
  /**
   * Nothing written. `order_gone`: the order was undone, so a charge that succeeded has no order (a
   * person must refund it; T2 records it in audit_log). Any other reason: the PaymentIntent isn't what
   * the order expects, so it stays pending for reconcile or a person (W03-plan 2.5, "amounts don't
   * match").
   */
  | {
      finalised: false
      reason: 'order_gone' | 'paid_by_another_payment' | 'not_pending' | 'payment_not_succeeded' | 'amount_mismatch' | 'currency_mismatch' | 'metadata_mismatch' | 'customer_mismatch'
    }

export interface FinaliseOptions {
  actor: { type: 'staff' | 'customer' | 'system'; id: string | null }
  requestId: string
}

interface LockedOrder {
  customer_id: string
  payment_status: string
  stripe_payment_intent_id: string | null
  payment_method: string | null
  reader_payment: PendingSnapshot | null
}

/** What the order must see in the PaymentIntent before it is paid, as finaliseReaderOrder checked. */
function mismatch(order: LockedOrder & { reader_payment: PendingSnapshot }, orderId: string, paymentIntent: Stripe.PaymentIntent): FinaliseOutcome | null {
  const snapshot = order.reader_payment
  if (paymentIntent.status !== 'succeeded') return { finalised: false, reason: 'payment_not_succeeded' }
  if (paymentIntent.metadata?.['order_id'] !== orderId) return { finalised: false, reason: 'metadata_mismatch' }
  if (paymentIntent.currency !== 'gbp') return { finalised: false, reason: 'currency_mismatch' }
  // Exact pence: the charge was asked for exactly this (W03-plan 2.7).
  if (paymentIntent.amount !== pence(snapshot.expected_amount)) return { finalised: false, reason: 'amount_mismatch' }
  const customer = typeof paymentIntent.customer === 'string' ? paymentIntent.customer : (paymentIntent.customer?.id ?? null)
  if (customer !== snapshot.stripe_customer_id) return { finalised: false, reason: 'customer_mismatch' }
  return null
}

/**
 * Marks paid, confirms the event booking T1 left pending (W8-5), and saves the delivery address to
 * the customer when staff asked for it (as createOrder did after the charge, and finaliseReaderOrder
 * after the tap), in one statement. Each part waits on the order being marked: a second T2 finds it
 * paid already and writes nothing.
 */
const PAID_SQL = `
WITH paid AS (
  UPDATE orders o
  SET payment_status = 'paid', stripe_payment_intent_id = $2::text,
      reader_payment = o.reader_payment || jsonb_build_object('charge_payment_intent_id', $2::text),
      updated_at = now()
  WHERE o.id = $1::uuid AND o.payment_status = 'pending'
  RETURNING o.id, o.customer_id, o.shipping_address, o.reader_payment
),
event AS (
  UPDATE event_bookings eb
  SET status = 'confirmed', updated_at = now()
  FROM paid
  JOIN order_line_items l ON l.order_id = paid.id AND l.item_type = 'event'
  WHERE eb.id = l.event_booking_id AND eb.status = 'pending'
  RETURNING eb.id
),
address AS (
  UPDATE customers c
  SET address_line1 = paid.shipping_address->>'line1',
      address_line2 = paid.shipping_address->>'line2',
      city = paid.shipping_address->>'city',
      postcode = paid.shipping_address->>'postcode',
      country = paid.shipping_address->>'country',
      updated_at = now()
  FROM paid
  WHERE c.id = paid.customer_id AND paid.shipping_address IS NOT NULL
    AND (paid.reader_payment->>'save_address_to_customer')::boolean IS TRUE
  RETURNING c.id
)
SELECT (SELECT count(*)::int FROM paid) AS paid,
       (SELECT count(*)::int FROM event) AS events_confirmed,
       (SELECT count(*)::int FROM address) AS addresses_saved`

/*
 * Its audit row is stamped from the clock (audit.recordAll), as T1's are: T1 stamps its rows a
 * millisecond or two ahead, so a row stamped now() could sort before them when T2 or the undo follows
 * within that time (seen on real Postgres with an instant fake Stripe; not live, where the charge takes far longer).
 */

/**
 * T2, in one transaction: locks the order (LOCK_ORDER's first row), re-checks it is still pending,
 * checks the PaymentIntent, marks it paid, confirms its event booking, saves the address, and records
 * `order.paid`. Safe to call twice: the second call finds it paid with the same PaymentIntent and
 * writes nothing. An undo racing it holds the same lock, so one of them goes first and the other sees
 * what it did.
 *
 * A database failure here throws, and the transaction rolls back: the order stays pending with its
 * charge taken, for reconcile to finalise (W12). The caller never refunds a good sale for it (W6-3).
 */
export async function finaliseOrder(db: Db, orderId: string, paymentIntent: Stripe.PaymentIntent, options: FinaliseOptions): Promise<FinaliseOutcome> {
  return db.transaction(async (tx: Tx) => {
    const order = (
      await tx.query<LockedOrder>(
        `SELECT customer_id, payment_status, stripe_payment_intent_id, payment_method, reader_payment
         FROM orders WHERE id = $1::uuid FOR UPDATE`,
        [orderId]
      )
    )[0]
    const entry = { actorType: options.actor.type, actorId: options.actor.id, entityType: 'order', entityId: orderId, requestId: options.requestId }

    if (!order) {
      // The money is on its way to nobody: kept where a person (and reconcile, W12) will find it.
      await audit.recordAll(tx, [{
        ...entry,
        action: 'order.charge_without_order',
        details: { paymentIntentId: paymentIntent.id, amount: paymentIntent.amount, status: paymentIntent.status },
      }])
      return { finalised: false, reason: 'order_gone' }
    }
    if (order.payment_status === 'paid') {
      return order.stripe_payment_intent_id === paymentIntent.id ? { finalised: true, alreadyPaid: true } : { finalised: false, reason: 'paid_by_another_payment' }
    }
    if (order.payment_status !== 'pending' || !order.reader_payment) return { finalised: false, reason: 'not_pending' }

    const wrong = mismatch({ ...order, reader_payment: order.reader_payment }, orderId, paymentIntent)
    if (wrong) return wrong

    const written = (await tx.query<{ paid: number; events_confirmed: number; addresses_saved: number }>(PAID_SQL, [orderId, paymentIntent.id]))[0]
    if (written?.paid !== 1) throw new Error('The order was not marked paid.')
    await audit.recordAll(tx, [{
      ...entry,
      action: 'order.paid',
      details: {
        method: order.payment_method,
        collected: order.reader_payment.expected_amount,
        paymentIntentId: paymentIntent.id,
        eventBookingConfirmed: written.events_confirmed > 0,
        addressSaved: written.addresses_saved > 0,
      },
    }])
    return { finalised: true, alreadyPaid: false }
  })
}
