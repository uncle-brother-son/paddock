// T2 (W03-plan 2.1), new in W10 for the saved card. What it does is what old code did after the money
// came in: createOrder.ts's stages 34 and 35 (marked paid, the address saved) and finaliseReaderOrder.ts's
// checks on the PaymentIntent and its confirming of a pending event booking. W11 adds the reader: what
// finaliseReaderOrder did once the tap had taken the money (the card saved, the method recorded).
import 'server-only'
import type Stripe from 'stripe'
import { audit } from '@/server/audit'
import type { Db, Tx } from '@/server/db'
import type { ResolvedCard } from '@/server/stripe/saved-card'
import { pence } from './collect-saved-card'
import type { PendingSnapshot } from './pending-order'

export type FinaliseOutcome =
  /** Marked paid by this call, or found already paid with this PaymentIntent (safe twice). */
  | { finalised: true; alreadyPaid: boolean; cardSaved: boolean }
  /**
   * Nothing written. `order_gone`: the order was undone, so a charge that succeeded has no order (a
   * person must refund it; T2 records it in audit_log). `rollback_started`: the old code's rollback has
   * started on it (W11), so only the old code may finish it. Any other reason: the PaymentIntent isn't
   * what the order expects, so it stays pending for reconcile or a person (W03-plan 2.5, "amounts don't
   * match").
   */
  | {
      finalised: false
      reason:
        | 'order_gone'
        | 'paid_by_another_payment'
        | 'not_pending'
        | 'rollback_started'
        | 'payment_not_succeeded'
        | 'amount_mismatch'
        | 'currency_mismatch'
        | 'metadata_mismatch'
        | 'customer_mismatch'
    }

export type FinaliseMismatch = Extract<FinaliseOutcome, { finalised: false }>['reason']

export interface FinaliseOptions {
  actor: { type: 'staff' | 'customer' | 'system'; id: string | null }
  requestId: string
  /**
   * W11: the reusable card a reader tap left, when the customer agreed to save it and Stripe made one
   * (resolveSavedCard). Saved to the customer in the same statement that marks the order paid.
   */
  saveCard?: ResolvedCard | null
}

interface LockedOrder {
  customer_id: string
  payment_status: string
  stripe_payment_intent_id: string | null
  payment_method: string | null
  reader_payment: PendingSnapshot | null
}

/**
 * What the order must see in the PaymentIntent before it is paid, as finaliseReaderOrder checked, and
 * now to the exact penny (W03-plan 2.7; the old reader check allowed 1p either way). On the reader the
 * amount taken (`amount_received`, what finaliseReaderOrder compared) must be it too. The customer is
 * the one the order's pending record names (W10; on the reader, the one its intent was made for).
 */
export function paymentMismatch(snapshot: PendingSnapshot, orderId: string, paymentIntent: Stripe.PaymentIntent): FinaliseMismatch | null {
  if (paymentIntent.status !== 'succeeded') return 'payment_not_succeeded'
  if (paymentIntent.metadata?.['order_id'] !== orderId) return 'metadata_mismatch'
  if (paymentIntent.currency !== 'gbp') return 'currency_mismatch'
  const expected = pence(snapshot.expected_amount)
  if (paymentIntent.amount !== expected) return 'amount_mismatch'
  if (snapshot.method === 'reader' && paymentIntent.amount_received !== expected) return 'amount_mismatch'
  const customer = typeof paymentIntent.customer === 'string' ? paymentIntent.customer : (paymentIntent.customer?.id ?? null)
  if (customer === null || customer !== snapshot.stripe_customer_id) return 'customer_mismatch'
  return null
}

/** The old rollback (readerOrderRollback.ts) marks an order it has started on. */
export const oldRollbackStarted = (snapshot: PendingSnapshot | null): boolean =>
  Boolean(snapshot && 'rollback' in snapshot && snapshot.rollback !== null && snapshot.rollback !== undefined)

/**
 * What orders.payment_method records once a reader order is paid (W03-decisions Q9): the reader, or
 * `split` with a gift card. A reader order's T1 records none, as createOrder's reader branch left it
 * until finaliseReaderOrder wrote 'reader'. A saved-card order's T1 recorded it already, so none here.
 */
export function methodAtFinalise(snapshot: PendingSnapshot): string | null {
  if (snapshot.method !== 'reader') return null
  return snapshot.gift_card_redemption ? 'split' : 'reader'
}

/**
 * Marks paid (and, on the reader, records the method), confirms the event booking T1 left pending
 * (W8-5), and saves to the customer what staff asked for: the delivery address (as createOrder did after
 * the charge, and finaliseReaderOrder after the tap), from the order's own address, and on the reader
 * the card the tap left (as finaliseReaderOrder did through saveCustomerCardOnFile: the card's last
 * four and brand exactly as resolved, even when unknown). One statement: the customer is one UPDATE,
 * as a statement can't update a row twice. Each part waits on the order being marked: a second T2
 * finds it paid already and writes nothing.
 */
const PAID_SQL = `
WITH paid AS (
  UPDATE orders o
  SET payment_status = 'paid', stripe_payment_intent_id = $2::text,
      payment_method = COALESCE($3::text, o.payment_method),
      reader_payment = CASE WHEN o.reader_payment->>'method' = 'card'
                            THEN o.reader_payment || jsonb_build_object('charge_payment_intent_id', $2::text)
                            ELSE o.reader_payment END,
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
customer AS (
  UPDATE customers c
  SET address_line1 = CASE WHEN x.save_address THEN paid.shipping_address->>'line1' ELSE c.address_line1 END,
      address_line2 = CASE WHEN x.save_address THEN paid.shipping_address->>'line2' ELSE c.address_line2 END,
      city = CASE WHEN x.save_address THEN paid.shipping_address->>'city' ELSE c.city END,
      postcode = CASE WHEN x.save_address THEN paid.shipping_address->>'postcode' ELSE c.postcode END,
      country = CASE WHEN x.save_address THEN paid.shipping_address->>'country' ELSE c.country END,
      saved_payment_method_id = CASE WHEN $4::text IS NULL THEN c.saved_payment_method_id ELSE $4::text END,
      saved_card_last4 = CASE WHEN $4::text IS NULL THEN c.saved_card_last4 ELSE $5::text END,
      saved_card_brand = CASE WHEN $4::text IS NULL THEN c.saved_card_brand ELSE $6::text END,
      updated_at = now()
  FROM paid
  CROSS JOIN LATERAL (
    SELECT paid.shipping_address IS NOT NULL AND (paid.reader_payment->>'save_address_to_customer')::boolean IS TRUE AS save_address
  ) x
  WHERE c.id = paid.customer_id AND (x.save_address OR $4::text IS NOT NULL)
  RETURNING c.id, x.save_address AS address_saved, $4::text IS NOT NULL AS card_saved
)
SELECT (SELECT count(*)::int FROM paid) AS paid,
       (SELECT count(*)::int FROM event) AS events_confirmed,
       (SELECT count(*)::int FROM customer WHERE address_saved) AS addresses_saved,
       (SELECT count(*)::int FROM customer WHERE card_saved) AS cards_saved`

/*
 * Its audit row is stamped from the clock (audit.recordAll), as T1's are: T1 stamps its rows a
 * millisecond or two ahead, so a row stamped now() could sort before them when T2 or the undo follows
 * within that time (seen on real Postgres with an instant fake Stripe; not live, where the charge takes far longer).
 */

/**
 * T2, in one transaction: locks the order (LOCK_ORDER's first row), re-checks it is still pending,
 * checks the PaymentIntent, marks it paid, confirms its event booking, saves the address and (on the
 * reader) the card, and records `order.paid` (and `customer.card_saved`). Safe to call twice: the second
 * call finds it paid with the same PaymentIntent and writes nothing. An undo racing it holds the same
 * lock, so one of them goes first and the other sees what it did.
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
      return order.stripe_payment_intent_id === paymentIntent.id ? { finalised: true, alreadyPaid: true, cardSaved: false } : { finalised: false, reason: 'paid_by_another_payment' }
    }
    if (order.payment_status !== 'pending' || !order.reader_payment) return { finalised: false, reason: 'not_pending' }
    // W11: the old rollback has started on it (it may have given things back already): the old code's to finish.
    if (oldRollbackStarted(order.reader_payment)) return { finalised: false, reason: 'rollback_started' }

    const wrong = paymentMismatch(order.reader_payment, orderId, paymentIntent)
    if (wrong) return { finalised: false, reason: wrong }

    const method = methodAtFinalise(order.reader_payment)
    const card = order.reader_payment.method === 'reader' && order.reader_payment.save_card && options.saveCard?.reusable ? options.saveCard : null
    const written = (
      await tx.query<{ paid: number; events_confirmed: number; addresses_saved: number; cards_saved: number }>(PAID_SQL, [
        orderId,
        paymentIntent.id,
        method,
        card?.paymentMethodId ?? null,
        card?.last4 ?? null,
        card?.brand ?? null,
      ])
    )[0]
    if (written?.paid !== 1) throw new Error('The order was not marked paid.')
    if (card && written.cards_saved !== 1) throw new Error('The card was not saved to the customer.')
    await audit.recordAll(tx, [
      {
        ...entry,
        action: 'order.paid',
        details: {
          method: method ?? order.payment_method,
          collected: order.reader_payment.expected_amount,
          paymentIntentId: paymentIntent.id,
          eventBookingConfirmed: written.events_confirmed > 0,
          addressSaved: written.addresses_saved > 0,
          ...(order.reader_payment.method === 'reader' ? { cardSaved: written.cards_saved > 0 } : {}),
        },
      },
      ...(card
        ? [{
            ...entry,
            action: 'customer.card_saved',
            entityType: 'customer',
            entityId: order.customer_id,
            details: { paymentMethodId: card.paymentMethodId, last4: card.last4, brand: card.brand, fromPaymentIntent: paymentIntent.id, orderId },
          }]
        : []),
    ])
    return { finalised: true, alreadyPaid: false, cardSaved: written.cards_saved > 0 }
  })
}
