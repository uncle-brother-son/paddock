// T2 (W03-plan 2.1), new in W10 for the saved card. What it does is what old code did after the money
// came in: createOrder.ts's stages 34 and 35 (marked paid, the address saved) and finaliseReaderOrder.ts's
// checks on the PaymentIntent and its confirming of a pending event booking. W11 adds the reader: what
// finaliseReaderOrder did once the tap had taken the money (the card saved, the method recorded). W13 adds
// the membership: createOrder's and finaliseReaderOrder's customer_memberships row (written, or a buy-new
// row patched), its first credit period, and the exhausted membership marked cancelled (Q8).
import 'server-only'
import type Stripe from 'stripe'
import { audit, type AuditEntry } from '@/server/audit'
import type { Db, Tx } from '@/server/db'
import type { ResolvedCard } from '@/server/stripe/saved-card'
import { londonToday } from '@/server/rules/time/london-time'
import { pence } from './collect-saved-card'
import { LEFT_AT_T2, subscriptionLeftEntry, subscriptionMismatch, type MadeSubscription, type SubscriptionPutBackReason } from './membership'
import type { PendingSnapshot } from './pending-order'

export type FinaliseOutcome =
  /** Marked paid by this call, or found already paid with this PaymentIntent (safe twice). */
  | { finalised: true; alreadyPaid: boolean; cardSaved: boolean; membershipId?: string | null }
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
        /** W13: a compensation has started on it (membership.ts): never paid after that. */
        | 'compensating'
        /** W13: a membership order with no subscription given, or no payment where one is due. */
        | 'membership_not_started'
        | 'payment_missing'
        /**
         * W13, definite (a rule the data breaks, W11 review L3): the subscription isn't what the order asked
         * for, the order has no membership line to hang the membership on, or the buy-new row T1 wrote is gone
         * or already has a subscription. The caller compensates.
         */
        | 'subscription_mismatch'
        | 'membership_line_missing'
        | 'membership_row_missing'
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
  /** W13: the membership's subscription, made for this order (membership.ts). Required on a membership order. */
  subscription?: MadeSubscription | null
  /**
   * W13c (W13a review S1): the caller's press made `subscription` (the saved card's press, the screen's reader
   * finalise), so if the order is gone or carrying the compensation mark, T2 records it as left live
   * (`order.subscription_left`, `left`) in its own transaction, before anything is put back.
   * W13d (W13c review S-1): likewise when the old rollback has started on the order, or it was paid with another
   * payment, or it is otherwise not pending (SubscriptionPutBackReason): none can be paid with this subscription.
   * W13d (S-2): reconcile's saved-card path passes it too, for the subscription it found, so an order undone by
   * another actor between its list and T2 leaves a row that the next run's retry puts back.
   */
  subscriptionMadeHere?: boolean
}

interface LockedOrder {
  customer_id: string
  payment_status: string
  stripe_payment_intent_id: string | null
  payment_method: string | null
  reader_payment: PendingSnapshot | null
  /** W13: the order's membership line, and whether a buy-new row T1 wrote is still there, this order's, with no subscription. */
  membership_line_id: string | null
  membership_row_ready: boolean | null
}

/** W13: the definite reasons a membership order's T2 gives, which the caller compensates (W11 review L3). */
export const MEMBERSHIP_DEFINITE = new Set<FinaliseMismatch>(['subscription_mismatch', 'membership_line_missing', 'membership_row_missing'])

/**
 * W13: the order's membership line, and whether the buy-new row T1 wrote is still there, this order's customer's,
 * on one of this order's lines, with no subscription. Read by T2 under its lock, and by the pre-check (W13a L1).
 */
const MEMBERSHIP_READY_COLUMNS = `(SELECT l.id FROM order_line_items l WHERE l.order_id = o.id AND l.item_type = 'membership' ORDER BY l.created_at, l.id LIMIT 1) AS membership_line_id,
                (SELECT m.stripe_subscription_id IS NULL FROM customer_memberships m
                 WHERE m.id = (o.reader_payment->'membership'->>'membership_row_id')::uuid AND m.customer_id = o.customer_id
                   AND m.order_line_item_id IN (SELECT l.id FROM order_line_items l WHERE l.order_id = o.id)) AS membership_row_ready`

/** T2's first statement: the order, locked, with its membership's line and row. */
const LOCK_ORDER_SQL = `SELECT o.customer_id, o.payment_status, o.stripe_payment_intent_id, o.payment_method, o.reader_payment,
                ${MEMBERSHIP_READY_COLUMNS}
         FROM orders o WHERE o.id = $1::uuid FOR UPDATE OF o`

/** W13a (L1): the same, read without a lock, before Q8. */
const PRECHECK_SQL = `SELECT o.payment_status, o.reader_payment,
              ${MEMBERSHIP_READY_COLUMNS}
       FROM orders o WHERE o.id = $1::uuid`

/** T2's definite membership checks, on what T2 reads: the reason it would refuse, or null. */
function membershipRefusal(
  subscription: MadeSubscription,
  orderId: string,
  record: PendingSnapshot,
  membership: NonNullable<PendingSnapshot['membership']>,
  ready: { membership_line_id: string | null; membership_row_ready: boolean | null }
): FinaliseMismatch | null {
  if (subscriptionMismatch(subscription, orderId, record.stripe_customer_id ?? '', membership)) return 'subscription_mismatch'
  if (!ready.membership_line_id) return 'membership_line_missing'
  if (membership.membership_row_id && ready.membership_row_ready !== true) return 'membership_row_missing'
  return null
}

export type MembershipPrecheck =
  /** T2 will write the membership: cancel the old subscription (Q8), then T2. */
  | { kind: 'ready' }
  /** T2 would refuse it for good: compensate now, with the old subscription left as it is. */
  | { kind: 'refused'; reason: FinaliseMismatch }
  /** The order is gone, paid, marked or the old rollback's: no Q8; T2 gives the answer (and the caller acts on it). */
  | { kind: 'not_pending' }

/**
 * W13a (L1): T2's definite membership checks, read before Q8's cancel, so a definite T2 refusal can't follow a
 * confirmed cancel of the customer's old subscription (which would leave them with neither membership). One read,
 * no lock: something outside the order would have to remove its line or row between this read and T2 for T2 to
 * refuse after all, and then the refusal says the old membership was cancelled too.
 *
 * W13c (W13a review S1): in a transaction, so the server's 8 s statement limit bounds it (8.1 s with BEGIN and
 * COMMIT; it was a bare read, bounded only by the client's 10 s). It can start as the last Stripe call answers, so
 * its time is counted after the press's Stripe window, not inside it.
 */
export async function membershipPrecheck(db: Db, orderId: string, subscription: MadeSubscription): Promise<MembershipPrecheck> {
  const order = (
    await db.transaction((tx) =>
      tx.query<{ payment_status: string; reader_payment: PendingSnapshot | null; membership_line_id: string | null; membership_row_ready: boolean | null }>(PRECHECK_SQL, [orderId])
    )
  )[0]
  const record = order?.reader_payment ?? null
  if (!order || order.payment_status !== 'pending' || !record || oldRollbackStarted(record) || record.compensation || !record.membership) return { kind: 'not_pending' }
  const reason = membershipRefusal(subscription, orderId, record, record.membership, order)
  return reason ? { kind: 'refused', reason } : { kind: 'ready' }
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
      reader_payment = $7::jsonb,
      updated_at = now()
  WHERE o.id = $1::uuid AND o.payment_status = 'pending'
  RETURNING o.id, o.customer_id, o.shipping_address, o.reader_payment
),
new_membership AS (
  INSERT INTO customer_memberships
    (customer_id, plan_id, start_date, next_renewal_date, addon_credits_remaining, subscription_status,
     stripe_subscription_id, order_line_item_id, billing_frequency, is_herd)
  SELECT paid.customer_id, x.plan_id, x.start_date, x.next_renewal_date, x.addons_included, 'active',
         x.subscription_id, x.line_id, x.billing_frequency, x.billing_frequency = 'yearly'
  FROM paid
  CROSS JOIN jsonb_to_recordset($8::jsonb)
    AS x(row_id uuid, plan_id uuid, start_date date, next_renewal_date date, addons_included int, subscription_id text, line_id uuid, billing_frequency text)
  WHERE x.row_id IS NULL
  RETURNING id
),
patched_membership AS (
  UPDATE customer_memberships m
  SET stripe_subscription_id = x.subscription_id, subscription_status = 'active', start_date = x.start_date,
      next_renewal_date = x.next_renewal_date, updated_at = now()
  FROM paid
  CROSS JOIN jsonb_to_recordset($8::jsonb)
    AS x(row_id uuid, start_date date, next_renewal_date date, subscription_id text, line_id uuid)
  WHERE x.row_id IS NOT NULL AND m.id = x.row_id AND m.customer_id = paid.customer_id
    AND m.order_line_item_id = x.line_id AND m.stripe_subscription_id IS NULL
  RETURNING m.id
),
replaced AS (
  UPDATE customer_memberships m
  SET subscription_status = 'cancelled', addon_credits_remaining = 0, updated_at = now()
  FROM paid
  WHERE m.id = $9::uuid AND m.customer_id = paid.customer_id
  RETURNING m.id
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
       (SELECT COALESCE((SELECT id FROM new_membership), (SELECT id FROM patched_membership))) AS membership_id,
       (SELECT count(*)::int FROM new_membership) + (SELECT count(*)::int FROM patched_membership) AS memberships_written,
       (SELECT count(*)::int FROM replaced) AS memberships_replaced,
       (SELECT count(*)::int FROM event) AS events_confirmed,
       (SELECT count(*)::int FROM customer WHERE address_saved) AS addresses_saved,
       (SELECT count(*)::int FROM customer WHERE card_saved) AS cards_saved`

/*
 * Its audit row is stamped from the clock (audit.recordAll), as T1's are: T1 stamps its rows a
 * millisecond or two ahead, so a row stamped now() could sort before them when T2 or the undo follows
 * within that time (seen on real Postgres with an instant fake Stripe; not live, where the charge takes far longer).
 */

/** The London date of a Stripe time (seconds), as createOrder and finaliseReaderOrder stored the period. */
const londonDateOf = (seconds: number): string => londonToday(new Date(seconds * 1000))

/**
 * T2, in one transaction: locks the order (LOCK_ORDER's first row), re-checks it is still pending,
 * checks the PaymentIntent, marks it paid, confirms its event booking, saves the address and (on the
 * reader) the card, and records `order.paid` (and `customer.card_saved`). Safe to call twice: the second
 * call finds it paid with the same PaymentIntent and writes nothing. An undo racing it holds the same
 * lock, so one of them goes first and the other sees what it did.
 *
 * W13, a membership order: `options.subscription` is the subscription Stripe made for it, checked again
 * here (active, this order's, this customer's, this price, the first invoice's amount). The same statement
 * writes the membership row (or patches the buy-new row T1 wrote, which must still be this order's with no
 * subscription), marks the exhausted membership cancelled with no add-on credits (createOrder's local
 * cancel, once the old subscription is cancelled in Stripe, Q8), and records the subscription on the
 * pending record; then the membership's first credit period is allocated, as createOrder did. A saved-card
 * membership order with nothing on the card has no PaymentIntent of its own: `paymentIntent` is null, and
 * the order records the first invoice's, as createOrder did (none when the coupon covered all of it). An
 * order carrying the compensation mark is never paid.
 *
 * A database failure here throws, and the transaction rolls back: the order stays pending with its
 * charge taken, for reconcile to finalise (W12). The caller never refunds a good sale for it (W6-3).
 */
export async function finaliseOrder(db: Db, orderId: string, paymentIntent: Stripe.PaymentIntent | null, options: FinaliseOptions): Promise<FinaliseOutcome> {
  return db.transaction(async (tx: Tx) => {
    const order = (
      await tx.query<LockedOrder>(LOCK_ORDER_SQL, [orderId])
    )[0]
    const entry = { actorType: options.actor.type, actorId: options.actor.id, entityType: 'order', entityId: orderId, requestId: options.requestId }
    const subscription = options.subscription ?? null
    // What the order records as its payment: the charge or the tap, else (W13) the first invoice's.
    const recordedIntent = paymentIntent?.id ?? subscription?.invoicePaymentIntentId ?? null
    // W13c (S1b): the caller's own subscription, for an order gone or being put back, recorded as left live here,
    // in the same statement as the rest of this branch's rows, so nothing need be written after T2. W13d (S-1): and
    // for an order the old rollback has started on, paid with another payment, or not pending.
    const leftHere = (found: SubscriptionPutBackReason): AuditEntry[] =>
      subscription && options.subscriptionMadeHere ? [subscriptionLeftEntry(options.actor, options.requestId, orderId, subscription, found, [], [LEFT_AT_T2])] : []

    if (!order) {
      // The money is on its way to nobody: kept where a person (and reconcile, W12) will find it. The subscription's
      // row first: recordAll stamps rows a millisecond apart in the order given, and a later put-back's row (stamped
      // from its own clock reading, plus one) must never sort before it.
      await audit.recordAll(tx, [
        ...leftHere('order_gone'),
        ...(paymentIntent
          ? [{
              ...entry,
              action: 'order.charge_without_order',
              details: { paymentIntentId: paymentIntent.id, amount: paymentIntent.amount, status: paymentIntent.status },
            }]
          : []),
      ])
      return { finalised: false, reason: 'order_gone' }
    }
    if (order.payment_status === 'paid') {
      if (order.stripe_payment_intent_id === recordedIntent) return { finalised: true, alreadyPaid: true, cardSaved: false }
      await audit.recordAll(tx, leftHere('paid_by_another_payment'))
      return { finalised: false, reason: 'paid_by_another_payment' }
    }
    if (order.payment_status !== 'pending' || !order.reader_payment) {
      await audit.recordAll(tx, leftHere('not_pending'))
      return { finalised: false, reason: 'not_pending' }
    }
    const record = order.reader_payment
    // W11: the old rollback has started on it (it may have given things back already): the old code's to finish.
    // W13d (S-1): the caller's own subscription is recorded as left, and the caller puts it back (the old rollback
    // refunds the tap, never the subscription's first invoice).
    if (oldRollbackStarted(record)) {
      await audit.recordAll(tx, leftHere('rollback_started'))
      return { finalised: false, reason: 'rollback_started' }
    }
    // W13: money is being put back: a refunded payment still reads succeeded, so it is never paid now.
    if (record.compensation) {
      await audit.recordAll(tx, leftHere('compensating'))
      return { finalised: false, reason: 'compensating' }
    }

    const membership = record.membership ?? null
    if (membership && !subscription) return { finalised: false, reason: 'membership_not_started' }
    if (paymentIntent) {
      const wrong = paymentMismatch(record, orderId, paymentIntent)
      if (wrong) return { finalised: false, reason: wrong }
    } else if (!(membership && record.method === 'card' && pence(record.expected_amount) === 0)) {
      return { finalised: false, reason: 'payment_missing' }
    }
    if (membership && subscription) {
      const refused = membershipRefusal(subscription, orderId, record, membership, order)
      if (refused) return { finalised: false, reason: refused }
    }

    const method = methodAtFinalise(record)
    const card = record.method === 'reader' && record.save_card && options.saveCard?.reusable ? options.saveCard : null
    const newRecord: PendingSnapshot =
      record.method === 'card'
        ? { ...record, charge_payment_intent_id: paymentIntent?.id ?? null }
        : record
    const withSubscription: PendingSnapshot =
      membership && subscription
        ? { ...newRecord, membership: { ...membership, subscription_id: subscription.id, subscription_payment_intent_id: subscription.invoicePaymentIntentId } }
        : newRecord
    const membershipWrite =
      membership && subscription && order.membership_line_id
        ? [{
            row_id: membership.membership_row_id ?? null,
            plan_id: membership.plan_id,
            start_date: londonDateOf(subscription.periodStart as number),
            next_renewal_date: londonDateOf(subscription.periodEnd as number),
            addons_included: membership.addons_included,
            subscription_id: subscription.id,
            line_id: order.membership_line_id,
            billing_frequency: membership.billing_frequency,
          }]
        : []
    const replaced = membership && record.replaces_membership_id ? record.replaces_membership_id : null
    const written = (
      await tx.query<{
        paid: number
        membership_id: string | null
        memberships_written: number
        memberships_replaced: number
        events_confirmed: number
        addresses_saved: number
        cards_saved: number
      }>(PAID_SQL, [
        orderId,
        recordedIntent,
        method,
        card?.paymentMethodId ?? null,
        card?.last4 ?? null,
        card?.brand ?? null,
        withSubscription,
        membershipWrite,
        replaced,
      ])
    )[0]
    if (written?.paid !== 1) throw new Error('The order was not marked paid.')
    if (card && written.cards_saved !== 1) throw new Error('The card was not saved to the customer.')
    if (written.memberships_written !== membershipWrite.length) throw new Error(`The membership was not written: ${written.memberships_written} of ${membershipWrite.length}.`)
    if (replaced && written.memberships_replaced !== 1) throw new Error('The exhausted membership was not marked cancelled.')
    // createOrder and finaliseReaderOrder allocated the new membership's first credit period at once.
    if (membershipWrite.length > 0) await tx.query('SELECT public.allocate_membership_credit_periods()')
    await audit.recordAll(tx, [
      {
        ...entry,
        action: 'order.paid',
        details: {
          method: method ?? order.payment_method,
          collected: record.expected_amount,
          paymentIntentId: recordedIntent,
          eventBookingConfirmed: written.events_confirmed > 0,
          addressSaved: written.addresses_saved > 0,
          ...(record.method === 'reader' ? { cardSaved: written.cards_saved > 0 } : {}),
          ...(membership && subscription
            ? { membership: { membershipId: written.membership_id, subscriptionId: subscription.id, firstInvoice: subscription.amountPaid, replaced } }
            : {}),
        },
      },
      ...(card
        ? [{
            ...entry,
            action: 'customer.card_saved',
            entityType: 'customer',
            entityId: order.customer_id,
            details: { paymentMethodId: card.paymentMethodId, last4: card.last4, brand: card.brand, fromPaymentIntent: paymentIntent?.id ?? null, orderId },
          }]
        : []),
    ])
    return { finalised: true, alreadyPaid: false, cardSaved: written.cards_saved > 0, ...(membership ? { membershipId: written.membership_id } : {}) }
  })
}
