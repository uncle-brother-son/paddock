/**
 * Read-only: what is left on a booking to refund and where it came from. refundBooking and the
 * Part refund and Refund the rest dialogs all use this, so the screen and the server can't disagree.
 *
 * price_paid holds two things: money still paid toward the booking, and refund_owed_amount, money a
 * failed refund should have given back. `left` is the first of those, and is all a part refund can
 * give. `cardLeft` works out what giveBookingMoneyBack could reach, booking line by booking line.
 *
 * `parts` splits `left` for staff to read. Only the card figure is exact: nothing records which
 * non-card money a store credit refund came from, and a move's gift card and cash parts have no
 * order, so the rest is shown up to what each way of paying put in, and any remainder as cash.
 */
import { loadOrderCardPortion } from './orderCardPortion'

const round2 = (n: number) => Math.round(n * 100) / 100

/** Joined to a booking line `oli`: `inside.addons` is the paid add-ons its line_total includes, so
 *  its seat money is line_total less discount_amount less that. */
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

export interface BookingLineRow {
  id: string
  order_id: string
  net_remaining: string
  /** The line held no seat money to begin with (a same-tier guest's line holds only their add-on). */
  no_seat_money: boolean
}

/** A booking's lines, newest first: the order card refunds go back in. */
export async function loadBookingLines(bookingId: string): Promise<BookingLineRow[]> {
  const lookup = await paddockData.query<BookingLineRow>(
    `SELECT oli.id, oli.order_id,
            GREATEST(oli.line_total - COALESCE(oli.discount_amount, 0) - oli.card_refunded_amount - inside.addons, 0) AS net_remaining,
            oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons <= 0 AS no_seat_money
     FROM order_line_items oli
     ${ADDONS_INSIDE_LINE}
     WHERE oli.booking_id = $1 AND oli.item_type = 'booking'
     ORDER BY oli.created_at DESC, oli.id DESC`,
    [bookingId]
  )
  return lookup.data
}

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
  /** Where `left` came from. These add up to `left`. */
  parts: { card: number; giftCard: number; storeCredit: number; cash: number }
}

export async function loadBookingMoneyLeft(bookingId: string): Promise<BookingMoneyLeft | null> {
  const lookup = await paddockData.query<{ status: string; customer_id: string; price_paid: string | null; refund_owed_amount: string }>(
    'SELECT status, customer_id, price_paid, refund_owed_amount FROM bookings WHERE id = $1',
    [bookingId]
  )
  const booking = lookup.data[0]
  if (!booking) return null
  const lines = await loadBookingLines(bookingId)

  // Two lines can share an order, and its card money can only go back once.
  const portionLeft = new Map<string, number>()
  let cardLeft = 0
  for (const line of lines) {
    let portion = portionLeft.get(line.order_id)
    if (portion === undefined) {
      const loaded = await loadOrderCardPortion(line.order_id)
      portion = loaded?.paymentIntentId ? loaded.cardPortionRemaining : 0
    }
    const take = round2(Math.min(portion, Number.parseFloat(line.net_remaining)))
    portionLeft.set(line.order_id, round2(portion - Math.max(take, 0)))
    if (take > 0) cardLeft = round2(cardLeft + take)
  }

  const paidOtherWays = await paddockData.query<{ gift_card: string; store_credit: string }>(
    `SELECT COALESCE((SELECT SUM(gcr.amount_used) FROM gift_card_redemptions gcr WHERE gcr.order_id = ANY($1::uuid[])), 0) AS gift_card,
            GREATEST(COALESCE((SELECT -SUM(sct.amount) FROM store_credit_transactions sct
                               WHERE sct.reason IN ('redemption', 'redemption_reversal')
                                 AND (sct.order_id = ANY($2::uuid[]) OR sct.booking_id = $3)), 0), 0) AS store_credit`,
    [[...portionLeft.keys()], [...portionLeft.keys()], bookingId]
  )

  const pricePaid = round2(Number.parseFloat(booking.price_paid ?? '0'))
  const refundOwed = round2(Number.parseFloat(booking.refund_owed_amount))
  const left = Math.max(round2(pricePaid - refundOwed), 0)
  const card = Math.min(cardLeft, left)
  const notCard = round2(left - card)
  const giftCard = Math.min(notCard, round2(Number.parseFloat(paidOtherWays.data[0]?.gift_card ?? '0')))
  const storeCredit = Math.min(round2(notCard - giftCard), round2(Number.parseFloat(paidOtherWays.data[0]?.store_credit ?? '0')))
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
