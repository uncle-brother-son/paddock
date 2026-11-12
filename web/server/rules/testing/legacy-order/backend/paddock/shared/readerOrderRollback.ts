import { undoEventBooking } from './eventOrders'
import { refundPaymentIntent } from '@retool-app/backend/paddock/shared/refundPaymentIntent'
import { pence } from '@retool-app/backend/paddock/shared/cardRefundAttempts'

/**
 * Rows-based rollback for a PENDING reader order: the shared undo used by cancelReaderOrder.ts and
 * finaliseReaderOrder.ts's failure path, so the two can never drift.
 *
 * createOrder.ts's own failure path during creation keeps using its in-memory compensating
 * closures (they are strictly more precise while the request is still live); this helper
 * reimplements the same compensation list from the order's stored rows plus the
 * orders.reader_payment jsonb snapshot.
 *
 * This resource has no transaction across statements, and the rollback can fail part-way and be run
 * again by the sweep. So it works in three stages, and each thing happens exactly once:
 *
 *  1. Start. reader_payment.rollback is written first (finalise writes it before refunding). From
 *     then on the order can't be finalised, however its PaymentIntent reads: a refunded
 *     PaymentIntent still says 'succeeded'. Any refund still owed is taken next.
 *  2. Give back. Capacity, credits, stock, store credit and the gift card balance. Each give-back is
 *     ONE SQL statement that also records it in reader_payment.rollback.done, so it can't happen
 *     without being recorded or be recorded without happening, and a repeat finds it done. The
 *     statement locks the order row, so two rollbacks at once can't both do it either. Nothing is
 *     deleted until every give-back has worked: the rows being deleted are how a repeat finds its
 *     way, and the order is what holds the record.
 *  3. Delete, in the order the foreign keys need, the order itself last. Deleting twice is harmless
 *     and the first failure stops the run, so a repeat picks up where it stopped. Once the order has
 *     gone there is nothing left to repeat.
 *
 * Foreign keys that set that order (none cascades): addon_order_lines.order_id and
 * store_credit_transactions.order_id block the order; bookings.redeemed_membership_id and
 * redeemed_session_pass_id block those rows; order_line_items.booking_id and gift_card_id block the
 * booking and the purchased card; customer_memberships and customer_session_passes
 * .order_line_item_id block the order's lines, and so the order. gift_card_redemptions.order_id has
 * no foreign key, so a redemption would outlive the order if it weren't deleted here.
 *
 * Only the refund owed by finalise touches money. Cancelling a PaymentIntent is the caller's job
 * (cancel asks the Worker to cancel, and must finalise instead when the payment turns out succeeded).
 */

export interface ReaderPaymentSnapshot {
  flow?: string
  payment_intent_id?: string
  expected_amount?: number
  save_card?: boolean
  save_address_to_customer?: boolean
  membership?: {
    plan_id: string
    plan_name: string
    billing_frequency: 'monthly' | 'yearly'
    idempotency_key?: string
    price: number
    first_payment_amount: number
    /** Set only for the buy-new flow, where the membership row is created while pending. */
    membership_row_id?: string
  }
  exhausted_membership_stripe_id?: string
  exhausted_membership_previous?: { subscription_status: string; addon_credits_remaining: number; membership_id: string }
  gift_card_redemption?: { gift_card_id: string; amount: number }
  stock_adjustment_ids?: string[]
  /** The event booking created (status 'pending') with the order — confirmed by finalise,
   *  undone by the rollback. */
  event_booking_id?: string
  created_at?: string
  /** Written when a rollback starts. An order carrying this can only be rolled back. */
  rollback?: ReaderRollbackState
}

export interface ReaderRollbackState {
  started_at: string
  /** The give-backs already made, by key. Each is written by the statement that made it. */
  done: Record<string, true>
  /** Set when finalise took the money: the refund to make before anything is given back. `refused`
   *  counts Stripe's definite noes, and goes in the refund's key so a no isn't replayed. */
  refund: { payment_intent_id: string; amount: number; done?: true; refused?: number } | null
}

export interface ReaderOrderRows {
  order: { id: string; customer_id: string; payment_status: string; stripe_payment_intent_id: string | null; reader_payment: ReaderPaymentSnapshot | null }
  lines: Array<{
    id: string
    item_type: string
    quantity: number
    booking_id: string | null
    product_variant_id: string | null
    membership_plan_id: string | null
    session_pass_type_id: string | null
    gift_card_id: string | null
    event_booking_id: string | null
  }>
  booking: { id: string; session_id: string; party_size: number; redemption_source: string; redeemed_session_pass_id: string | null } | null
  addonCreditLines: Array<{ id: string; redeemed_membership_id: string; quantity: number }>
  membershipRowIds: string[]
  sessionPassRowIds: string[]
  giftCardId: string | null
  /** From the order's event line, falling back to the reader_payment snapshot. */
  eventBookingId: string | null
}

/** Loads everything the rollback needs. Returns null when the order no longer exists. */
export async function loadReaderOrderRows(orderId: string): Promise<ReaderOrderRows | null> {
  const orderLookup = await paddockData.query<{
    id: string
    customer_id: string
    payment_status: string
    stripe_payment_intent_id: string | null
    reader_payment: ReaderPaymentSnapshot | null
  }>('SELECT id, customer_id, payment_status, stripe_payment_intent_id, reader_payment FROM orders WHERE id = $1', [orderId])
  const order = orderLookup.data[0]
  if (!order) return null

  const linesLookup = await paddockData.query<{
    id: string
    item_type: string
    quantity: number
    booking_id: string | null
    product_variant_id: string | null
    membership_plan_id: string | null
    session_pass_type_id: string | null
    gift_card_id: string | null
    event_booking_id: string | null
  }>(
    `SELECT id, item_type, quantity, booking_id, product_variant_id, membership_plan_id, session_pass_type_id, gift_card_id,
            event_booking_id
     FROM order_line_items WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId]
  )
  const lines = linesLookup.data
  const bookingId = lines.find((l) => l.booking_id)?.booking_id ?? null

  let booking: ReaderOrderRows['booking'] = null
  if (bookingId) {
    const bookingLookup = await paddockData.query<{
      id: string
      session_id: string
      party_size: number
      redemption_source: string
      redeemed_session_pass_id: string | null
    }>(
      `SELECT id, session_id, party_size, redemption_source, redeemed_session_pass_id FROM bookings WHERE id = $1`,
      [bookingId]
    )
    booking = bookingLookup.data[0] ?? null
  }

  const membershipLineIds = lines.filter((l) => l.item_type === 'membership').map((l) => l.id)
  const passLineIds = lines.filter((l) => l.item_type === 'session_pass').map((l) => l.id)
  const membershipRowIds: string[] = []
  if (membershipLineIds.length > 0) {
    const lookup = await paddockData.query<{ id: string }>(
      `SELECT id FROM customer_memberships WHERE order_line_item_id = ANY($1::uuid[])`,
      [membershipLineIds]
    )
    membershipRowIds.push(...lookup.data.map((r) => r.id))
  }
  const sessionPassRowIds: string[] = []
  if (passLineIds.length > 0) {
    const lookup = await paddockData.query<{ id: string }>(
      `SELECT id FROM customer_session_passes WHERE order_line_item_id = ANY($1::uuid[])`,
      [passLineIds]
    )
    sessionPassRowIds.push(...lookup.data.map((r) => r.id))
  }

  let addonCreditLines: ReaderOrderRows['addonCreditLines'] = []
  if (bookingId) {
    const addonLookup = await paddockData.query<ReaderOrderRows['addonCreditLines'][number]>(
      `SELECT id, redeemed_membership_id, quantity FROM addon_order_lines
       WHERE booking_id = $1 AND redemption_source = 'membership_credit' AND redeemed_membership_id IS NOT NULL`,
      [bookingId]
    )
    addonCreditLines = addonLookup.data
  }

  const giftCardId = lines.find((l) => l.gift_card_id)?.gift_card_id ?? null
  const eventBookingId = lines.find((l) => l.event_booking_id)?.event_booking_id ?? order.reader_payment?.event_booking_id ?? null

  return {
    order: {
      id: order.id,
      customer_id: order.customer_id,
      payment_status: order.payment_status,
      stripe_payment_intent_id: order.stripe_payment_intent_id,
      reader_payment: order.reader_payment,
    },
    lines,
    booking,
    addonCreditLines,
    membershipRowIds,
    sessionPassRowIds,
    giftCardId,
    eventBookingId,
  }
}

export interface RollbackReaderOrderResult {
  rolledBack: boolean
  /** True when the order was already gone (another rollback won the race, or it never existed). */
  alreadyGone?: boolean
  /**
   * Why rolledBack is false.
   * 'already_paid': the order is paid; cancelling it would destroy a real sale.
   * 'refund_failed': the refund finalise owes didn't go through, so nothing was given back yet.
   * 'refund_unsure': that refund gave no clear answer, so it may have gone. Nothing was given back
   * yet. Running the rollback again sends it with the same key, so it can't be paid twice.
   * 'incomplete': a step failed and the order is still there. Running the rollback again finishes
   * it and gives nothing back twice.
   */
  reason?: 'already_paid' | 'refund_failed' | 'refund_unsure' | 'incomplete'
  refund?: { paymentIntentId: string; amount: number; message: string }
  /** What went wrong. With rolledBack true, only the closing refresh of credit periods failed. */
  problems?: string[]
}

/**
 * Marks the order as being rolled back, keeping an earlier mark if there is one. Finalise calls this
 * with the refund BEFORE taking it. False when the order isn't pending (paid, or gone).
 */
export async function startReaderRollback(
  orderId: string,
  refund: { paymentIntentId: string; amount: number } | null = null
): Promise<boolean> {
  const started = await paddockData.query<{ id: string }>(
    `UPDATE orders
     SET reader_payment = COALESCE(reader_payment, '{}'::jsonb) || jsonb_build_object(
           'rollback',
           COALESCE(
             reader_payment->'rollback',
             jsonb_build_object('started_at', now(), 'done', '{}'::jsonb, 'refund', $1::jsonb)
           )
         )
     WHERE id = $2 AND payment_status = 'pending'
     RETURNING id`,
    [refund ? JSON.stringify({ payment_intent_id: refund.paymentIntentId, amount: refund.amount }) : null, orderId]
  )
  return started.data.length > 0
}

/**
 * Opens every give-back statement: records the key on the order, unless it is already there. The
 * statement after it acts only when this row came back, so the two happen together or not at all.
 * Each statement carries on from $4. Keys are bound twice, as $1 and $3, because this driver can't
 * reuse a placeholder.
 */
const ONCE_ONLY = `WITH claim AS (
  UPDATE orders
  SET reader_payment = jsonb_set(reader_payment, ARRAY['rollback', 'done', $1::text], 'true'::jsonb)
  WHERE id = $2::uuid AND reader_payment->'rollback'->'done'->$3::text IS NULL
  RETURNING id
)`

/**
 * Undoes every local write of a pending reader order, and takes any refund finalise owes first.
 * Safe to run again after a failure, and at the same time as another run: see the top of this file.
 * An order that no longer exists reports `alreadyGone` (success). A paid order is refused: callers
 * must finalise instead.
 */
export async function rollbackReaderOrder(orderId: string): Promise<RollbackReaderOrderResult> {
  if (!(await startReaderRollback(orderId))) {
    const current = await loadReaderOrderRows(orderId)
    if (!current) return { rolledBack: true, alreadyGone: true }
    if (current.order.payment_status === 'paid') return { rolledBack: false, reason: 'already_paid' }
    return { rolledBack: false, reason: 'incomplete', problems: [`the order is in state "${current.order.payment_status}"`] }
  }

  const problems: string[] = []
  const step = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (err) {
      problems.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let rows: ReaderOrderRows | null
  try {
    rows = await loadReaderOrderRows(orderId)
  } catch (err) {
    return { rolledBack: false, reason: 'incomplete', problems: [`load the order: ${err instanceof Error ? err.message : String(err)}`] }
  }
  if (!rows) return { rolledBack: true, alreadyGone: true }
  const snapshot = rows.order.reader_payment ?? {}

  // --- The refund finalise owes -----------------------------------------------------------------
  // First, so nothing is given back while the customer is still out of pocket. A repeat is safe:
  // it carries the same key, so Stripe answers with the first refund if it went. And Stripe refuses
  // to refund more than was charged, a refusal that means the money is back, which is also how this
  // finishes after staff refund it by hand. A definite no is counted, so the next run has a new key.
  const refund = snapshot.rollback?.refund
  if (refund && !refund.done) {
    const refused = refund.refused ?? 0
    const key = `reader-order-refund:${orderId}:${refund.payment_intent_id}:${pence(refund.amount)}:${refused}`
    const refunded = await refundPaymentIntent(refund.payment_intent_id, refund.amount, key)
    const alreadyBack = !refunded.ok && !refunded.unsure && /already been refunded/i.test(refunded.message ?? '')
    if (!refunded.ok && refunded.unsure) {
      return {
        rolledBack: false,
        reason: 'refund_unsure',
        refund: {
          paymentIntentId: refund.payment_intent_id,
          amount: refund.amount,
          message: refunded.message ?? 'no clear answer',
        },
      }
    }
    if (!refunded.ok && !alreadyBack) {
      try {
        await paddockData.query(
          `UPDATE orders SET reader_payment = jsonb_set(reader_payment, '{rollback,refund,refused}', to_jsonb($1::int)) WHERE id = $2`,
          [refused + 1, orderId]
        )
      } catch {
        // The next run meets the same refusal.
      }
      return {
        rolledBack: false,
        reason: 'refund_failed',
        refund: {
          paymentIntentId: refund.payment_intent_id,
          amount: refund.amount,
          message: refunded.message ?? 'the refund failed',
        },
      }
    }
    await step('record the refund', async () => {
      await paddockData.query(
        `UPDATE orders SET reader_payment = jsonb_set(reader_payment, '{rollback,refund,done}', 'true'::jsonb) WHERE id = $1`,
        [orderId]
      )
    })
  }

  // --- Give back, each exactly once ---------------------------------------------------------------
  // The session pass, add-on credit and capacity statements are releaseSessionPassCredit,
  // releaseMembershipAddonCredit and releaseSessionCapacity with the record added. A test holds them
  // to the same results. Reverse order of createOrder's compensations.
  if (rows.booking && rows.booking.redemption_source === 'session_pass_credit' && rows.booking.redeemed_session_pass_id) {
    const passId = rows.booking.redeemed_session_pass_id
    await step('release session pass credit', async () => {
      await paddockData.query(
        `${ONCE_ONLY}
         UPDATE customer_session_passes SET sessions_remaining = sessions_remaining + 1, updated_at = now()
         WHERE id = $4 AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date
           AND EXISTS (SELECT 1 FROM claim)`,
        ['session_pass', orderId, 'session_pass', passId]
      )
    })
  }
  for (const line of rows.addonCreditLines) {
    const key = `addon_credit:${line.id}`
    await step('release add-on membership credit', async () => {
      await paddockData.query(
        `${ONCE_ONLY}
         UPDATE customer_memberships SET addon_credits_remaining = addon_credits_remaining + $4, updated_at = now()
         WHERE id = $5 AND EXISTS (SELECT 1 FROM claim)`,
        [key, orderId, key, line.quantity, line.redeemed_membership_id]
      )
    })
  }
  if (snapshot.exhausted_membership_previous) {
    const prev = snapshot.exhausted_membership_previous
    await step('restore previous exhausted membership', async () => {
      await paddockData.query(
        `${ONCE_ONLY}
         UPDATE customer_memberships SET subscription_status = $4, addon_credits_remaining = $5, updated_at = now()
         WHERE id = $6 AND EXISTS (SELECT 1 FROM claim)`,
        ['exhausted_membership', orderId, 'exhausted_membership', prev.subscription_status, prev.addon_credits_remaining, prev.membership_id]
      )
    })
  }
  // ALWAYS reverse the store-credit claim (not only when a gift card is involved): a reader order
  // paid partly with store credit must get every credit pound back. The claim is measured from the
  // order's negative 'redemption' movements, which stay until the deletes below.
  await step('reverse store credit claim', async () => {
    const claimed = await paddockData.query<{ total: string }>(
      `SELECT COALESCE(-SUM(amount), 0) AS total FROM store_credit_transactions
       WHERE order_id = $1 AND amount < 0 AND reason = 'redemption'`,
      [orderId]
    )
    const amount = Number.parseFloat(claimed.data[0]?.total ?? '0')
    if (amount <= 0.005) return
    const reversal = await paddockData.query<{ result: unknown }>(
      `${ONCE_ONLY}
       SELECT public.store_credit_apply($4::uuid, $5::numeric, $6::text, $7::uuid, $8::uuid, $9::uuid, $10::text, $11::uuid) AS result
       FROM claim`,
      [
        'store_credit',
        orderId,
        'store_credit',
        rows.order.customer_id,
        amount,
        'redemption_reversal',
        orderId,
        null,
        null,
        'Automatic reversal — the pending reader order was cancelled or its finalisation failed.',
        null,
      ]
    )
    // No row: an earlier run made this reversal. A row that isn't ok stops the deletes, leaving the
    // order and its claim for someone to check.
    const raw = reversal.data[0]?.result
    if (raw === undefined) return
    const applied = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { ok?: boolean; reason?: string } | null
    if (applied?.ok !== true) throw new Error(applied?.reason ?? 'the store credit reversal was refused')
  })
  if (rows.booking) {
    const { session_id: sessionId, party_size: partySize } = rows.booking
    await step('release session capacity', async () => {
      await paddockData.query(
        `${ONCE_ONLY}
         UPDATE sessions s
         SET total_booked = CASE WHEN st.booking_type = 'private' THEN 0 ELSE s.total_booked - $4 END, updated_at = now()
         FROM service_types st
         WHERE s.id = $5 AND st.id = s.service_type_id AND EXISTS (SELECT 1 FROM claim)`,
        ['session_capacity', orderId, 'session_capacity', partySize, sessionId]
      )
    })
  }
  if (rows.eventBookingId) {
    const eventBookingId = rows.eventBookingId
    await step('release event places and delete event booking', async () => {
      await undoEventBooking(eventBookingId)
    })
  }
  for (const line of rows.lines) {
    if (line.item_type !== 'product' || !line.product_variant_id) continue
    const key = `stock:${line.id}`
    const { quantity, product_variant_id: variantId } = line
    await step('restock product', async () => {
      await paddockData.query(
        `${ONCE_ONLY}
         UPDATE product_variants SET stock_quantity = stock_quantity + $4, updated_at = now()
         WHERE id = $5 AND EXISTS (SELECT 1 FROM claim)`,
        [key, orderId, key, quantity, variantId]
      )
    })
  }
  if (snapshot.gift_card_redemption) {
    const redemption = snapshot.gift_card_redemption
    await step('reverse gift card redemption claim', async () => {
      // A card at zero is marked redeemed; once it has money on it again it isn't, whether or not
      // it has been part-used before. As createOrder's own rollback does.
      await paddockData.query(
        `${ONCE_ONLY}
         UPDATE gift_cards
         SET remaining_balance = remaining_balance + $4,
             redeemed_at = CASE WHEN remaining_balance <= 0 THEN NULL ELSE redeemed_at END,
             updated_at = now()
         WHERE id = $5 AND EXISTS (SELECT 1 FROM claim)`,
        ['gift_card', orderId, 'gift_card', redemption.amount, redemption.gift_card_id]
      )
    })
  }
  if (problems.length > 0) return { rolledBack: false, reason: 'incomplete', problems }

  // --- Delete, the order last ---------------------------------------------------------------------
  const deletions: Array<[string, () => Promise<unknown>]> = [
    ['delete add-on lines', () => paddockData.query(`DELETE FROM addon_order_lines WHERE order_id = $1`, [orderId])],
  ]
  if (rows.booking) {
    const bookingId = rows.booking.id
    // Its order line goes in the same statement: alone, it would leave a retry no way to find the
    // booking. Foreign keys are checked when the statement ends. The rest of the booking's add-on
    // lines and guests cascade.
    deletions.push([
      'delete booking',
      () =>
        paddockData.query(
          `WITH booking_line AS (DELETE FROM order_line_items WHERE order_id = $1 AND booking_id = $2)
           DELETE FROM bookings WHERE id = $3`,
          [orderId, bookingId, bookingId]
        ),
    ])
  }
  if (rows.membershipRowIds.length > 0) {
    const ids = rows.membershipRowIds
    deletions.push(['delete membership rows', () => paddockData.query(`DELETE FROM customer_memberships WHERE id = ANY($1::uuid[])`, [ids])])
  }
  if (rows.sessionPassRowIds.length > 0) {
    const ids = rows.sessionPassRowIds
    deletions.push(['delete session pass rows', () => paddockData.query(`DELETE FROM customer_session_passes WHERE id = ANY($1::uuid[])`, [ids])])
  }
  if (snapshot.stock_adjustment_ids && snapshot.stock_adjustment_ids.length > 0) {
    const ids = snapshot.stock_adjustment_ids
    deletions.push(['delete stock adjustment audit rows', () => paddockData.query(`DELETE FROM stock_adjustments WHERE id = ANY($1::uuid[])`, [ids])])
  }
  // Fallback for older pending orders whose snapshot recorded no ids: the sale reason text is unique
  // per order ('Sale (Order #<uuid>)'), so this deletes exactly this order's sale audit rows.
  deletions.push([
    'delete stock adjustment audit rows',
    () => paddockData.query(`DELETE FROM stock_adjustments WHERE reason = $1`, [`Sale (Order #${orderId})`]),
  ])
  if (snapshot.gift_card_redemption) {
    const redemption = snapshot.gift_card_redemption
    deletions.push([
      'delete gift card redemption',
      () =>
        paddockData.query(`DELETE FROM gift_card_redemptions WHERE gift_card_id = $1 AND order_id = $2 AND amount_used = $3`, [
          redemption.gift_card_id,
          orderId,
          redemption.amount,
        ]),
    ])
  }
  if (rows.giftCardId) {
    const giftCardId = rows.giftCardId
    deletions.push([
      'delete purchased gift card',
      () =>
        paddockData.query(
          `WITH card_line AS (DELETE FROM order_line_items WHERE order_id = $1 AND gift_card_id = $2)
           DELETE FROM gift_cards WHERE id = $3`,
          [orderId, giftCardId, giftCardId]
        ),
    ])
  }
  // The claim row and its reversal row are bookkeeping for money fully put back above, and they
  // block the order: mirrors createOrder.ts's own failure path.
  deletions.push(['delete store credit rows', () => paddockData.query(`DELETE FROM store_credit_transactions WHERE order_id = $1`, [orderId])])
  deletions.push(['delete pending order', () => paddockData.query(`DELETE FROM orders WHERE id = $1`, [orderId])])

  for (const [label, remove] of deletions) {
    await step(label, async () => {
      await remove()
    })
    if (problems.length > 0) return { rolledBack: false, reason: 'incomplete', problems }
  }

  // After the order: the rollback has worked by now, so a failure here is only a warning.
  await step('refresh membership credit periods', async () => {
    await paddockData.query('SELECT public.allocate_membership_credit_periods()', [])
  })

  return { rolledBack: true, ...(problems.length > 0 ? { problems } : {}) }
}
