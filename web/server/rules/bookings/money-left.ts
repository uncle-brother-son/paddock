// Ported from backend/paddock/shared/bookingMoneyLeft.ts, shared/orderCardPortion.ts and
// shared/orderPaymentStatus.ts (new in W17, D-plan 4.1): what is left on a booking to refund and where it came from,
// what an order's card can still take back, and an order's payment status after a refund. The Part refund and
// Refund the rest dialogs show these figures (getBookingRefundFigures), and step D's refund routes check the same
// ones (W21), so the screen and the Worker can't disagree. Read-only, apart from recordOrderPaymentStatus.
//
// One deliberate difference from the old code (W05l later 1; Wayne's Q36 answer, 12 Nov, makes it permanent): a gift
// card part with no order (Move, Settle, and a reader flow's finalise record their gift card part against the booking
// with no order) counts as gift card money, where the old figures showed it as cash.
import 'server-only'
import type { Queryable } from '@/server/db'
import { leftLineWords, paidLineWords } from './failure-messages'

const round2 = (n: number): number => Math.round(n * 100) / 100
const amount = (value: string | null | undefined): number => Number.parseFloat(value ?? '0')

/**
 * Joined to a booking line `oli`: `inside.addons` is the paid add-ons its line_total includes, so its seat money is
 * line_total less discount_amount less that (as the old ADDONS_INSIDE_LINE).
 */
export const ADDONS_INSIDE_LINE = `JOIN orders o ON o.id = oli.order_id
       CROSS JOIN LATERAL (
         SELECT COALESCE(SUM(aol.price_at_purchase * aol.quantity), 0) AS paid
         FROM addon_order_lines aol
         WHERE aol.order_id = oli.order_id AND aol.redemption_source IS DISTINCT FROM 'membership_credit'
       ) addon
       CROSS JOIN LATERAL (
         SELECT LEAST(addon.paid, GREATEST(SUM(x.line_total) + addon.paid - o.order_total, 0)) AS addons
         FROM order_line_items x
         WHERE x.order_id = oli.order_id
       ) inside`

// Fixed text only: ADDONS_INSIDE_LINE is a constant, and the booking comes in as $1.
const BOOKING_LINES_SQL = `SELECT oli.id, oli.order_id,
            GREATEST(oli.line_total - COALESCE(oli.discount_amount, 0) - oli.card_refunded_amount - inside.addons, 0)::text AS net_remaining,
            oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons <= 0 AS no_seat_money
     FROM order_line_items oli
     ${ADDONS_INSIDE_LINE}
     WHERE oli.booking_id = $1::uuid AND oli.item_type = 'booking'
     ORDER BY oli.created_at DESC, oli.id DESC`

export interface BookingLine {
  id: string
  orderId: string
  /** Seat money still on the line: its net less card refunds and the paid add-ons inside it, never below 0. */
  netRemaining: number
  /** The line held no seat money to begin with (a same-tier guest's line holds only their add-on). */
  noSeatMoney: boolean
}

/** A booking's lines, newest first: the order card refunds go back in. */
export async function loadBookingLines(db: Queryable, bookingId: string): Promise<BookingLine[]> {
  const rows = await db.query<{ id: string; order_id: string; net_remaining: string; no_seat_money: boolean }>(BOOKING_LINES_SQL, [bookingId])
  return rows.map((row) => ({ id: row.id, orderId: row.order_id, netRemaining: amount(row.net_remaining), noSeatMoney: row.no_seat_money }))
}

export interface OrderCardPortion {
  orderId: string
  customerId: string
  paymentIntentId: string | null
  /** What the order's PaymentIntent took. */
  cardPortion: number
  /** Card refunds already made on the order's lines and its booking add-on lines. */
  alreadyCardRefunded: number
  /** cardPortion less alreadyCardRefunded, never negative. Not capped by paymentIntentId: callers decide. */
  cardPortionRemaining: number
}

/**
 * How much of an order can still go back to its card, exactly as loadOrderCardPortion: the total less its promo
 * discount, gift card and store credit parts; for a saved-card membership order with a remainder charge, that
 * remainder; less what has already gone back to the card on its lines.
 */
export async function loadOrderCardPortion(db: Queryable, orderId: string): Promise<OrderCardPortion | null> {
  const row = (
    await db.query<{
      customer_id: string
      stripe_payment_intent_id: string | null
      payment_method: string | null
      order_total: string
      order_discount_amount: string | null
      gift_card_used: string
      store_credit_used: string
      membership_net: string
      already_card_refunded: string
    }>(
      `SELECT o.customer_id, o.stripe_payment_intent_id, o.payment_method, o.order_total::text AS order_total,
              o.discount_amount::text AS order_discount_amount,
              COALESCE((SELECT SUM(gcr.amount_used) FROM gift_card_redemptions gcr WHERE gcr.order_id = o.id), 0)::text AS gift_card_used,
              COALESCE((SELECT -SUM(sct.amount) FROM store_credit_transactions sct
                        WHERE sct.order_id = o.id AND sct.amount < 0 AND sct.reason IN ('redemption', 'redemption_reversal')), 0)::text AS store_credit_used,
              COALESCE((SELECT SUM(oli.line_total - oli.discount_amount) FROM order_line_items oli
                        WHERE oli.order_id = o.id AND oli.item_type = 'membership'), 0)::text AS membership_net,
              (COALESCE((SELECT SUM(oli.card_refunded_amount) FROM order_line_items oli WHERE oli.order_id = o.id), 0)
                + COALESCE((SELECT SUM(aol.card_refunded_amount) FROM addon_order_lines aol WHERE aol.order_id = o.id), 0))::text
                AS already_card_refunded
       FROM orders o WHERE o.id = $1::uuid`,
      [orderId]
    )
  )[0]
  if (!row) return null
  const paidByCards = round2(amount(row.order_total) - amount(row.order_discount_amount) - amount(row.gift_card_used) - amount(row.store_credit_used))
  let cardPortion = Math.max(0, paidByCards)
  const membershipNet = amount(row.membership_net)
  if (membershipNet > 0.005 && row.payment_method !== 'reader') {
    // Gift card and store credit cover the rest of the basket first, then spill onto the membership, so the
    // remainder charge is what is left of the part that isn't the membership.
    const remainderCharge = round2(paidByCards - membershipNet)
    if (remainderCharge > 0.005) cardPortion = remainderCharge
  }
  const alreadyCardRefunded = round2(amount(row.already_card_refunded))
  return {
    orderId,
    customerId: row.customer_id,
    paymentIntentId: row.stripe_payment_intent_id,
    cardPortion,
    alreadyCardRefunded,
    cardPortionRemaining: Math.max(0, round2(cardPortion - alreadyCardRefunded)),
  }
}

/** What getBookingRefundFigures answers (the old BookingMoneyLeft), field for field. */
export interface BookingMoneyLeft {
  status: string
  customerId: string
  pricePaid: number
  /** The part of pricePaid owed to the customer after a refund failed. */
  refundOwed: number
  /** pricePaid less refundOwed: the most a part refund can give. */
  left: number
  /** Card money a refund can still reach, owed money included. */
  cardLeft: number
  /** Where `left` came from. These add up to `left`. Only the card figure is exact (Q31). */
  parts: { card: number; giftCard: number; storeCredit: number; cash: number }
}

/**
 * What is left on a booking to refund, and where it came from, as loadBookingMoneyLeft worked it out: card money
 * line by line (newest first, each order's card portion used once), then gift card and store credit up to what each
 * put in, the rest as cash. Null when the booking doesn't exist.
 */
export async function loadBookingMoneyLeft(db: Queryable, bookingId: string): Promise<BookingMoneyLeft | null> {
  const booking = (
    await db.query<{ status: string; customer_id: string; price_paid: string | null; refund_owed_amount: string }>(
      'SELECT status, customer_id, price_paid::text AS price_paid, refund_owed_amount::text AS refund_owed_amount FROM bookings WHERE id = $1::uuid',
      [bookingId]
    )
  )[0]
  if (!booking) return null
  const lines = await loadBookingLines(db, bookingId)

  // Two lines can share an order, and its card money can only go back once.
  const portionLeft = new Map<string, number>()
  let cardLeft = 0
  for (const line of lines) {
    let portion = portionLeft.get(line.orderId)
    if (portion === undefined) {
      const loaded = await loadOrderCardPortion(db, line.orderId)
      portion = loaded?.paymentIntentId ? loaded.cardPortionRemaining : 0
    }
    const take = round2(Math.min(portion, line.netRemaining))
    portionLeft.set(line.orderId, round2(portion - Math.max(take, 0)))
    if (take > 0) cardLeft = round2(cardLeft + take)
  }

  const orderIds = [...portionLeft.keys()]
  const paidOtherWays = (
    await db.query<{ gift_card: string; store_credit: string }>(
      // W05l later 1: a gift card part recorded against the booking with no order is gift card money too.
      `SELECT COALESCE((SELECT SUM(gcr.amount_used) FROM gift_card_redemptions gcr
                        WHERE gcr.order_id = ANY($1::uuid[]) OR (gcr.booking_id = $2::uuid AND gcr.order_id IS NULL)), 0)::text AS gift_card,
              GREATEST(COALESCE((SELECT -SUM(sct.amount) FROM store_credit_transactions sct
                                 WHERE sct.reason IN ('redemption', 'redemption_reversal')
                                   AND (sct.order_id = ANY($3::uuid[]) OR sct.booking_id = $4::uuid)), 0), 0)::text AS store_credit`,
      [orderIds, bookingId, orderIds, bookingId]
    )
  )[0]

  const pricePaid = round2(amount(booking.price_paid))
  const refundOwed = round2(amount(booking.refund_owed_amount))
  const left = Math.max(round2(pricePaid - refundOwed), 0)
  const card = Math.min(cardLeft, left)
  const notCard = round2(left - card)
  const giftCard = Math.min(notCard, round2(amount(paidOtherWays?.gift_card)))
  const storeCredit = Math.min(round2(notCard - giftCard), round2(amount(paidOtherWays?.store_credit)))
  return {
    status: booking.status,
    customerId: booking.customer_id,
    pricePaid,
    refundOwed,
    left,
    cardLeft,
    parts: { card, giftCard, storeCredit, cash: round2(notCard - giftCard - storeCredit) },
  }
}

/**
 * W21 (Q26, Wayne 6 Nov; lead call L2): the cash recorded for the booking that can be handed back. Per order with a
 * booking line for it and no Stripe payment, paid in cash (or `split`: a gift card with cash), the smaller of the
 * order's cash part (its total less promo, gift card and store credit) and the seat money its lines hold for this
 * booking; less what Worker refunds have already handed back in cash. Settle's and Move's cash has no order (Q36: keep
 * today's way), so it can't be found reliably and is left out: that money can still go back as store credit. Fixed
 * text: ADDONS_INSIDE_LINE is a constant; the booking comes in as $1 and $2.
 */
const CASH_SQL = `
WITH seat AS (
  SELECT oli.order_id, SUM(GREATEST(oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons, 0)) AS money
  FROM order_line_items oli
  ${ADDONS_INSIDE_LINE}
  WHERE oli.booking_id = $1::uuid AND oli.item_type = 'booking'
    AND o.stripe_payment_intent_id IS NULL AND o.payment_method IN ('cash', 'split')
  GROUP BY oli.order_id
),
recorded AS (
  SELECT COALESCE(SUM(LEAST(seat.money, GREATEST(
           o.order_total - COALESCE(o.discount_amount, 0)
           - COALESCE((SELECT SUM(gcr.amount_used) FROM gift_card_redemptions gcr WHERE gcr.order_id = o.id), 0)
           - COALESCE((SELECT -SUM(sct.amount) FROM store_credit_transactions sct
                       WHERE sct.order_id = o.id AND sct.amount < 0 AND sct.reason IN ('redemption', 'redemption_reversal')), 0),
           0))), 0) AS cash
  FROM seat JOIN orders o ON o.id = seat.order_id
)
SELECT recorded.cash::text AS recorded,
       COALESCE((SELECT SUM((c.details->>'amount')::numeric) FROM audit_log c
                 WHERE c.action = 'booking.refund_claimed' AND c.entity_type = 'booking' AND c.entity_id = $2::text
                   AND c.details->>'method' = 'cash'), 0)::text AS handed_back
FROM recorded`

/**
 * W21: the figures as the figures route sends them: the old ones, with Q26's cash and the line of what is left (W21a).
 * W26a (audit S5; Q37): and `paidWords`, how that money was paid, for the booking detail.
 */
export interface RefundFigures extends BookingMoneyLeft {
  cashLeft: number
  paidLine: string
  paidWords: string
}

/** The cash a Part refund can hand back (Q26): see CASH_SQL. Never more than the figures' cash part. */
export async function cashLeftOn(db: Queryable, bookingId: string, figures: BookingMoneyLeft): Promise<number> {
  const row = (await db.query<{ recorded: string; handed_back: string }>(CASH_SQL, [bookingId, bookingId]))[0]
  const recorded = round2(amount(row?.recorded) - amount(row?.handed_back))
  return Math.max(0, round2(Math.min(figures.parts.cash, recorded)))
}

/** getBookingRefundFigures on the Worker (W21): loadBookingMoneyLeft, field for field, plus `cashLeft` and `paidLine`. */
export async function loadRefundFigures(db: Queryable, bookingId: string): Promise<RefundFigures | null> {
  const figures = await loadBookingMoneyLeft(db, bookingId)
  if (!figures) return null
  return withCashAndLine(db, bookingId, figures)
}

/** The figures with Q26's cash, the line of what is left to refund (W21a, W21 review S1) and the paid line (W26a) added. */
export async function withCashAndLine(db: Queryable, bookingId: string, figures: BookingMoneyLeft): Promise<RefundFigures> {
  const { parts } = figures
  const named = { card: parts.card, giftCardOrStoreCredit: round2(parts.giftCard + parts.storeCredit), cash: parts.cash }
  return {
    ...figures,
    cashLeft: await cashLeftOn(db, bookingId, figures),
    paidLine: leftLineWords(named),
    paidWords: paidLineWords(named),
  }
}

export type OrderPaymentStatusAfterRefunds = 'refunded' | 'partially_refunded' | null

/**
 * An order's payment status worked out from its lines after a refund, as recomputeOrderPaymentStatus counted them:
 * every counted line refunded is 'refunded'; any refunded or partly refunded is 'partially_refunded'; otherwise null
 * (the status is left as it is). A booking cancelled with nothing back and its line never stamped isn't counted.
 */
export async function orderPaymentStatusAfterRefunds(db: Queryable, orderId: string): Promise<OrderPaymentStatusAfterRefunds> {
  const lines = (
    await db.query<{ total: number; refunded: number; partly: number }>(
      `SELECT
         COUNT(*) FILTER (
           WHERE oli.item_type <> 'booking' OR oli.refunded_at IS NOT NULL OR b.status IS DISTINCT FROM 'cancelled'
         )::int AS total,
         COUNT(*) FILTER (WHERE oli.refunded_at IS NOT NULL)::int AS refunded,
         COUNT(*) FILTER (
           WHERE oli.refunded_at IS NULL AND (
             (oli.item_type = 'booking' AND oli.card_refunded_amount > 0)
             OR (oli.item_type = 'booking' AND
                 COALESCE((SELECT SUM(sct.amount) FROM store_credit_transactions sct
                           WHERE sct.order_id = oli.order_id AND sct.booking_id = oli.booking_id AND sct.reason = 'refund'), 0) > 0)
             OR (oli.item_type = 'event' AND EXISTS (SELECT 1 FROM event_attendees ea
                                                      WHERE ea.event_booking_id = oli.event_booking_id AND ea.refunded_amount > 0))
           )
         )::int AS partly
       FROM order_line_items oli
       LEFT JOIN bookings b ON b.id = oli.booking_id AND oli.item_type = 'booking'
       WHERE oli.order_id = $1::uuid`,
      [orderId]
    )
  )[0]
  const addons = (
    await db.query<{ total: number; refunded: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE removed_at IS NOT NULL AND refund_method IS NOT NULL AND refund_method <> 'none')::int AS refunded
       FROM addon_order_lines WHERE order_id = $1::uuid`,
      [orderId]
    )
  )[0]
  const total = Number(lines?.total ?? 0) + Number(addons?.total ?? 0)
  const refunded = Number(lines?.refunded ?? 0) + Number(addons?.refunded ?? 0)
  const partly = Number(lines?.partly ?? 0)
  return total > 0 && refunded >= total ? 'refunded' : refunded > 0 || partly > 0 ? 'partially_refunded' : null
}

/** Writes the status orderPaymentStatusAfterRefunds works out, when there is one (the refund pipeline's R2, W21). */
export async function recordOrderPaymentStatus(db: Queryable, orderId: string): Promise<OrderPaymentStatusAfterRefunds> {
  const status = await orderPaymentStatusAfterRefunds(db, orderId)
  if (status) await db.query('UPDATE orders SET payment_status = $1::text, updated_at = now() WHERE id = $2::uuid', [status, orderId])
  return status
}
