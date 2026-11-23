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
  /**
   * W29 (Wayne's Q40): set when the order's membership was paid by a card payment of its own beside the order's: a
   * saved-card membership order with a remainder charge. The subscription's first invoice took the membership, and
   * the order's PaymentIntent took only the rest of the basket. What that payment took, what has gone back to it (the
   * card money on the membership lines), and what is left. `paymentIntentId` is the first invoice's, as T2 recorded it
   * on the order (orders.reader_payment, from W13); null on an order placed by the old code, which never recorded it.
   * Null on every other order (one card payment, or none).
   */
  membershipPayment: { paymentIntentId: string | null; took: number; refunded: number; remaining: number } | null
  /**
   * W53 (Q40; the W28 QA's step G note): true when the order's one card payment is its membership's own: a saved-card
   * membership order with no remainder charge, where store credit and a gift card covered the rest of the basket
   * first and the subscription's first invoice took what was left of the membership. Card money on such an order was
   * taken for the membership line, so a refund records it there first (orders/refund-lines.ts, planFor). False on
   * every other order: a reader order's tap took the whole basket, and with a remainder charge there are two payments
   * (`membershipPayment`).
   */
  cardTookMembership: boolean
}

/**
 * How much of an order can still go back to its card, exactly as loadOrderCardPortion: the total less its promo
 * discount, gift card and store credit parts; for a saved-card membership order with a remainder charge, that
 * remainder; less what has already gone back to the card on its lines.
 *
 * W29 (Q40: each line goes back to the card payment that took it): on a saved-card membership order with a remainder
 * charge, card money back on the membership line went to the membership's own payment, so it no longer comes off the
 * remainder. `membershipPayment` is that other payment's figures.
 *
 * W29a (W29 review S2): the old refundOrder, live until W28 + W29 are published, took a membership's card refund out
 * of the remainder charge (E3) and recorded it on the membership line too. On an order it refunded that way, this
 * reads that money as back on the membership's own payment, so the remainder's figure is too high by it. Stripe
 * refuses the extra, so nothing goes twice. The lead counts such orders live after the publish (0 on 14 Nov).
 *
 * W29a (W29 review S1): an order whose record is the reader's is one card payment, the tap, whatever
 * orders.payment_method says (T2 writes `split` for a reader order part-paid by gift card). Its whole tap is its card
 * money: no remainder charge, and no membership payment of its own.
 */
export async function loadOrderCardPortion(db: Queryable, orderId: string): Promise<OrderCardPortion | null> {
  const row = (await db.query<OrderPortionRow>(ORDER_CARD_PORTION_SQL, [orderId]))[0]
  return row ? cardPortionOf(orderId, row) : null
}

/**
 * W58b (W50 "For later" 4): what an order's card figures are worked out from, one row per order `o`. Read alone by
 * loadOrderCardPortion, and for every order of a booking at once by loadBookingMoneyLeft. Fixed text.
 */
const ORDER_PORTION_COLUMNS = `o.customer_id, o.stripe_payment_intent_id, o.payment_method, o.order_total::text AS order_total,
              o.discount_amount::text AS order_discount_amount,
              COALESCE((SELECT SUM(gcr.amount_used) FROM gift_card_redemptions gcr WHERE gcr.order_id = o.id), 0)::text AS gift_card_used,
              COALESCE((SELECT -SUM(sct.amount) FROM store_credit_transactions sct
                        WHERE sct.order_id = o.id AND sct.amount < 0 AND sct.reason IN ('redemption', 'redemption_reversal')), 0)::text AS store_credit_used,
              COALESCE((SELECT SUM(oli.line_total - oli.discount_amount) FROM order_line_items oli
                        WHERE oli.order_id = o.id AND oli.item_type = 'membership'), 0)::text AS membership_net,
              COALESCE((SELECT SUM(oli.card_refunded_amount) FROM order_line_items oli
                        WHERE oli.order_id = o.id AND oli.item_type = 'membership'), 0)::text AS membership_card_refunded,
              o.reader_payment->'membership'->>'subscription_payment_intent_id' AS membership_payment_intent_id,
              (o.reader_payment->>'method' = 'reader' OR o.reader_payment ? 'payment_intent_id') AS reader_record,
              (COALESCE((SELECT SUM(oli.card_refunded_amount) FROM order_line_items oli WHERE oli.order_id = o.id), 0)
                + COALESCE((SELECT SUM(aol.card_refunded_amount) FROM addon_order_lines aol WHERE aol.order_id = o.id), 0))::text
                AS already_card_refunded`
const ORDER_CARD_PORTION_SQL = `SELECT ${ORDER_PORTION_COLUMNS} FROM orders o WHERE o.id = $1::uuid`

interface OrderPortionRow {
  customer_id: string
  stripe_payment_intent_id: string | null
  payment_method: string | null
  order_total: string
  order_discount_amount: string | null
  gift_card_used: string
  store_credit_used: string
  membership_net: string
  membership_card_refunded: string
  membership_payment_intent_id: string | null
  reader_record: boolean | null
  already_card_refunded: string
}

/** loadOrderCardPortion's sums, from its row. */
function cardPortionOf(orderId: string, row: OrderPortionRow): OrderCardPortion {
  const paidByCards = round2(amount(row.order_total) - amount(row.order_discount_amount) - amount(row.gift_card_used) - amount(row.store_credit_used))
  let cardPortion = Math.max(0, paidByCards)
  let membershipPayment: OrderCardPortion['membershipPayment'] = null
  let cardTookMembership = false
  const membershipNet = amount(row.membership_net)
  if (membershipNet > 0.005 && row.payment_method !== 'reader' && row.reader_record !== true) {
    // Gift card and store credit cover the rest of the basket first, then spill onto the membership, so the
    // remainder charge is what is left of the part that isn't the membership.
    const remainderCharge = round2(paidByCards - membershipNet)
    if (remainderCharge > 0.005) {
      cardPortion = remainderCharge
      // W29 (Q40): the membership's first invoice took the membership itself, on a payment of its own.
      const refunded = round2(amount(row.membership_card_refunded))
      membershipPayment = { paymentIntentId: row.membership_payment_intent_id, took: round2(membershipNet), refunded, remaining: Math.max(0, round2(membershipNet - refunded)) }
    } else if (paidByCards > 0.005) {
      // W53 (Q40): no remainder charge, so the card money there is was taken by the membership's first invoice.
      cardTookMembership = true
    }
  }
  const alreadyCardRefunded = round2(amount(row.already_card_refunded) - (membershipPayment?.refunded ?? 0))
  return {
    orderId,
    customerId: row.customer_id,
    paymentIntentId: row.stripe_payment_intent_id,
    cardPortion,
    alreadyCardRefunded,
    cardPortionRemaining: Math.max(0, round2(cardPortion - alreadyCardRefunded)),
    membershipPayment,
    cardTookMembership,
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
 * W58b (W50 "For later" 4): everything loadBookingMoneyLeft works from, in one statement: the booking; its booking
 * lines (BOOKING_LINES_SQL's figures, newest first); each of their orders' card figures (ORDER_PORTION_COLUMNS); and
 * what gift cards and store credit put in, on each of those orders, and on the booking with no order (W05l later 1).
 * No row when the booking doesn't exist. Fixed text.
 *
 * W70b (QA1): until then the gift cards and store credit of all its orders were one sum, so what an order's add-ons or
 * products took was counted as seat money. Each order's is its own now (cardPortionOf's `gift_card_used`, and
 * `store_credit_net`: its redemptions less any put back), shared over its seat lines by loadBookingMoneyLeft. A row of
 * the booking's with an order that has no booking line (add-ons bought on their own) paid for no seat, so it isn't
 * read. `addons_off_order` is what paid add-ons took of the money with no order: a saved-card or reader Add Guest's
 * order holds only its card money, which covers its add-ons first, so what its add-ons cost above that came from the
 * gift card or store credit.
 *
 * W70c (Wayne's Q63): and `given`, the seat money that has gone back as store credit, from the Worker's own refund
 * records (as CASH_SQL reads the cash handed back): the store credit of each finished Part refund, Remove Guest and
 * cheaper Move (`seats`), and of each Refund the rest (`owed`). Refund the rest can also give what was owed for a removed
 * add-on, which is not seat money: `addon_lines` is the store credit the removed add-on lines say they got, and `addons`
 * what Remove add-on itself gave, so the difference is the add-ons' share of `owed`. A cancel's refund isn't read, nor
 * what came after a cancel: a cancelled booking keeps its price paid, so none of it came off that. Every other figure
 * here is what was paid; `given` is what loadBookingMoneyLeft takes off it.
 */
const BOOKING_MONEY_LEFT_SQL = `
WITH lines AS (
  SELECT oli.id, oli.order_id, oli.created_at,
         GREATEST(oli.line_total - COALESCE(oli.discount_amount, 0) - oli.card_refunded_amount - inside.addons, 0)::text AS net_remaining,
         oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons <= 0 AS no_seat_money
  FROM order_line_items oli
  ${ADDONS_INSIDE_LINE}
  WHERE oli.booking_id = $1::uuid AND oli.item_type = 'booking'
),
order_ids AS (SELECT DISTINCT order_id FROM lines)
SELECT b.status, b.customer_id, b.price_paid::text AS price_paid, b.refund_owed_amount::text AS refund_owed_amount,
       (SELECT json_agg(json_build_object('id', l.id, 'order_id', l.order_id, 'net_remaining', l.net_remaining, 'no_seat_money', l.no_seat_money)
                        ORDER BY l.created_at DESC, l.id DESC) FROM lines l) AS lines,
       (SELECT json_agg(p) FROM (SELECT o.id AS order_id, ${ORDER_PORTION_COLUMNS},
                                        COALESCE((SELECT -SUM(sct.amount) FROM store_credit_transactions sct
                                                  WHERE sct.order_id = o.id AND sct.reason IN ('redemption', 'redemption_reversal')), 0)::text AS store_credit_net
                                 FROM orders o WHERE o.id IN (SELECT order_id FROM order_ids)) p) AS portions,
       COALESCE((SELECT SUM(gcr.amount_used) FROM gift_card_redemptions gcr
                 WHERE gcr.booking_id = $1::uuid AND gcr.order_id IS NULL), 0)::text AS gift_card_no_order,
       GREATEST(COALESCE((SELECT -SUM(sct.amount) FROM store_credit_transactions sct
                          WHERE sct.reason IN ('redemption', 'redemption_reversal')
                            AND sct.booking_id = $1::uuid AND sct.order_id IS NULL), 0), 0)::text AS store_credit_no_order,
       COALESCE((SELECT SUM(GREATEST(addon.paid - o.order_total, 0))
                 FROM (SELECT aol.order_id, SUM(aol.price_at_purchase * aol.quantity) AS paid
                       FROM addon_order_lines aol
                       WHERE aol.booking_id = $1::uuid AND aol.redemption_source IS DISTINCT FROM 'membership_credit'
                       GROUP BY aol.order_id) addon
                 JOIN orders o ON o.id = addon.order_id), 0)::text AS addons_off_order,
       given.seats::text AS credit_given_seats, given.owed::text AS credit_given_owed, given.addons::text AS credit_given_addons,
       COALESCE((SELECT SUM(aol.refunded_amount - aol.card_refunded_amount)
                 FROM addon_order_lines aol
                 WHERE aol.booking_id = $1::uuid AND aol.removed_at < COALESCE(b.cancelled_at, 'infinity'::timestamptz)), 0)::text AS credit_on_addon_lines
FROM bookings b
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM((f.details->>'storeCreditRefunded')::numeric) FILTER (WHERE c.details->>'kind' IN ('part_refund', 'remove_guest', 'move')), 0) AS seats,
         COALESCE(SUM((f.details->>'storeCreditRefunded')::numeric) FILTER (WHERE c.details->>'kind' = 'refund_owed' AND f.at < COALESCE(b.cancelled_at, 'infinity'::timestamptz)), 0) AS owed,
         COALESCE(SUM((f.details->>'storeCreditRefunded')::numeric) FILTER (WHERE c.details->>'kind' = 'remove_addon'), 0) AS addons
  FROM audit_log c
  JOIN audit_log f ON f.action = 'booking.refund_finished' AND f.entity_type = 'booking' AND f.entity_id = c.entity_id AND f.details->>'claimId' = c.id::text
  WHERE c.action = 'booking.refund_claimed' AND c.entity_type = 'booking' AND c.entity_id = b.id::text
) given
WHERE b.id = $1::uuid`

interface MoneyLeftRow {
  status: string
  customer_id: string
  price_paid: string | null
  refund_owed_amount: string
  lines: Array<{ id: string; order_id: string; net_remaining: string; no_seat_money: boolean }> | null
  portions: Array<OrderPortionRow & { order_id: string; store_credit_net: string }> | null
  gift_card_no_order: string
  store_credit_no_order: string
  addons_off_order: string
  credit_given_seats: string
  credit_given_owed: string
  credit_given_addons: string
  credit_on_addon_lines: string
}

/**
 * What is left on a booking to refund, and where it came from, as loadBookingMoneyLeft worked it out: card money
 * line by line (newest first, each order's card portion used once), then gift card and store credit up to what each
 * put in, the rest as cash. Null when the booking doesn't exist.
 *
 * W70b (QA1, QA4): what a gift card and store credit put in is what they paid of this booking's SEAT lines, order by
 * order, as the card's is: an order's card, then its gift card, then its store credit, each up to what is left of its
 * seat lines. Example (the QA run's): two seats £40 and an add-on £5 on one £45 order, all store credit, and a guest's
 * £20 in cash. Until W70b the £45 counted whole: "£45 store credit and £15 cash", so a Part refund could hand back £15
 * of the £20. Now £40 and £20.
 *
 * W70c (Wayne's Q63): seat money given back as store credit comes off the store credit part first, then the gift card's,
 * so the cash paid stays available to hand back as cash. Examples: that booking with £20 part refunded to store credit
 * is £20 store credit and £20 cash (it read £40 store credit, no cash); seats £40 in cash and a guest's £20 on store
 * credit, the guest removed to store credit, is £40 cash (it read £20 and £20). The card's part is as before, and
 * cashLeftOn still never hands back more cash than was paid in cash (Q26, Q42).
 */
export async function loadBookingMoneyLeft(db: Queryable, bookingId: string): Promise<BookingMoneyLeft | null> {
  // W58b (W50 "For later" 4): one statement, where it was four reads one after another (and one more per order).
  const booking = (await db.query<MoneyLeftRow>(BOOKING_MONEY_LEFT_SQL, [bookingId]))[0]
  if (!booking) return null
  const lines = (booking.lines ?? []).map((row) => ({ id: row.id, orderId: row.order_id, netRemaining: amount(row.net_remaining), noSeatMoney: row.no_seat_money }))
  const portions = new Map((booking.portions ?? []).map((row) => [row.order_id, cardPortionOf(row.order_id, row)]))

  // Two lines can share an order, and its card money can only go back once.
  const portionLeft = new Map<string, number>()
  // W70b: the seat money on each order's lines that its card didn't pay.
  const seatLeft = new Map<string, number>()
  let cardLeft = 0
  for (const line of lines) {
    let portion = portionLeft.get(line.orderId)
    if (portion === undefined) {
      const loaded = portions.get(line.orderId)
      portion = loaded?.paymentIntentId ? loaded.cardPortionRemaining : 0
    }
    const take = round2(Math.min(portion, line.netRemaining))
    portionLeft.set(line.orderId, round2(portion - Math.max(take, 0)))
    if (take > 0) cardLeft = round2(cardLeft + take)
    seatLeft.set(line.orderId, round2((seatLeft.get(line.orderId) ?? 0) + line.netRemaining - Math.max(take, 0)))
  }

  // W70b (QA1): with no order behind it (Move, Settle, a card Add Guest), less what that Add Guest's add-ons took of it
  // (the gift card's first: store credit comes before a gift card, and the seat is paid before the add-ons)...
  const giftCardNoOrder = round2(amount(booking.gift_card_no_order))
  const addonsOffOrder = round2(amount(booking.addons_off_order))
  let giftCardPaid = Math.max(0, round2(giftCardNoOrder - addonsOffOrder))
  let storeCreditPaid = Math.max(0, round2(amount(booking.store_credit_no_order) - Math.max(0, round2(addonsOffOrder - giftCardNoOrder))))
  // ...and on each order, what its gift card and then its store credit paid of the seat lines.
  for (const portion of booking.portions ?? []) {
    const seat = seatLeft.get(portion.order_id) ?? 0
    const giftCardOnSeats = Math.min(seat, round2(amount(portion.gift_card_used)))
    const storeCreditOnSeats = Math.min(round2(seat - giftCardOnSeats), Math.max(0, round2(amount(portion.store_credit_net))))
    giftCardPaid = round2(giftCardPaid + giftCardOnSeats)
    storeCreditPaid = round2(storeCreditPaid + storeCreditOnSeats)
  }

  // W70c (Q63): less what has gone back as store credit, the store credit first and then the gift card.
  const addonsShareOfOwed = Math.max(0, round2(amount(booking.credit_on_addon_lines) - amount(booking.credit_given_addons)))
  const givenBack = round2(amount(booking.credit_given_seats) + Math.max(0, round2(amount(booking.credit_given_owed) - addonsShareOfOwed)))
  const offStoreCredit = Math.min(givenBack, storeCreditPaid)
  storeCreditPaid = round2(storeCreditPaid - offStoreCredit)
  giftCardPaid = Math.max(0, round2(giftCardPaid - round2(givenBack - offStoreCredit)))

  const pricePaid = round2(amount(booking.price_paid))
  const refundOwed = round2(amount(booking.refund_owed_amount))
  const left = Math.max(round2(pricePaid - refundOwed), 0)
  const card = Math.min(cardLeft, left)
  const notCard = round2(left - card)
  const giftCard = Math.min(notCard, giftCardPaid)
  const storeCredit = Math.min(round2(notCard - giftCard), storeCreditPaid)
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
 * W53 (the W26 audit's row 10): a booking line `oli` of order `o` that cash has been handed back for: its order was
 * paid in cash (no card payment; `cash`, or `split`: a gift card with cash) and its booking has a cash refund claim
 * (Q26: cash goes back only for cash paid on the booking's own orders, CASH_SQL). Nothing on the order records cash
 * handed back, so until W53 a cash part refund left its order reading `paid`. Fixed text.
 */
export const CASH_HANDED_BACK_ON_LINE_SQL = `(oli.item_type = 'booking' AND o.stripe_payment_intent_id IS NULL AND o.payment_method IN ('cash', 'split')
                 AND EXISTS (SELECT 1 FROM audit_log c
                             WHERE c.action = 'booking.refund_claimed' AND c.entity_type = 'booking' AND c.entity_id = oli.booking_id::text
                               AND c.details->>'method' = 'cash'))`

/**
 * W53 (W32 "Noticed" 4; the W35 audit's row 26): true when refund money is still owed on order `o`: on the order
 * itself (Q39), or on a booking that has a booking line or an add-on line on it. Fixed text.
 */
export const ORDER_MONEY_OWED_SQL = `(o.refund_owed_amount > 0 OR EXISTS (
         SELECT 1 FROM bookings owing
         WHERE owing.refund_owed_amount > 0
           AND (EXISTS (SELECT 1 FROM order_line_items x WHERE x.order_id = o.id AND x.booking_id = owing.id)
                OR EXISTS (SELECT 1 FROM addon_order_lines a WHERE a.order_id = o.id AND a.booking_id = owing.id))))`

/**
 * The order's (`$1`) lines as its status counts them (orderPaymentStatusAfterRefunds, below, says what each count
 * is). Fixed text: ADDONS_INSIDE_LINE and CASH_HANDED_BACK_ON_LINE_SQL are constants.
 */
const ORDER_LINE_COUNTS_SQL = `SELECT
         COUNT(*) FILTER (
           WHERE oli.item_type <> 'booking' OR oli.refunded_at IS NOT NULL OR b.status IS DISTINCT FROM 'cancelled'
              OR oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons > 0
         )::int AS total,
         COUNT(*) FILTER (WHERE oli.refunded_at IS NOT NULL)::int AS refunded,
         COUNT(*) FILTER (
           WHERE oli.refunded_at IS NULL AND (
             (oli.item_type = 'booking' AND oli.card_refunded_amount > 0)
             OR (oli.item_type = 'booking' AND
                 COALESCE((SELECT SUM(sct.amount) FROM store_credit_transactions sct
                           WHERE sct.order_id = oli.order_id AND sct.booking_id = oli.booking_id AND sct.reason = 'refund'), 0) > 0)
             OR ${CASH_HANDED_BACK_ON_LINE_SQL}
             OR (oli.item_type = 'event' AND EXISTS (SELECT 1 FROM event_attendees ea
                                                      WHERE ea.event_booking_id = oli.event_booking_id AND ea.refunded_amount > 0))
           )
         )::int AS partly
       FROM order_line_items oli
       ${ADDONS_INSIDE_LINE}
       LEFT JOIN bookings b ON b.id = oli.booking_id AND oli.item_type = 'booking'
       WHERE oli.order_id = $1::uuid`

/** Whether refund money is still owed on the order (`$1`): ORDER_MONEY_OWED_SQL, asked of one order. Fixed text. */
const ORDER_OWED_SQL = `SELECT ${ORDER_MONEY_OWED_SQL} AS owed FROM orders o WHERE o.id = $1::uuid`

/**
 * An order's payment status worked out from its lines after a refund, as recomputeOrderPaymentStatus counted them:
 * every counted line refunded is 'refunded'; any refunded or partly refunded is 'partially_refunded'; otherwise null
 * (the status is left as it is). A booking cancelled with nothing back and its line never stamped isn't counted.
 *
 * W53 (brief item 4: the labels; each case in server/rules/README.md, "W53"):
 *  - W47 review L5: a cancelled booking's line with no stamp IS counted when it still holds seat money: that money
 *    was kept (a lapse or a cancel inside 24 hours), or is still owed. So an order whose towels were refunded while
 *    the guest's £20 was kept reads `partially_refunded`, where it read `refunded`. A line that held no seat money (a
 *    credit seat's, or a same-tier guest's that holds only an add-on) is still left out.
 *  - The W26 audit's row 10: a cash part refund counts as part of the line refunded (CASH_HANDED_BACK_ON_LINE_SQL).
 *  - W32 "Noticed" 4: while refund money is still owed (ORDER_MONEY_OWED_SQL) an order never reads `refunded`, however
 *    its lines are stamped: it reads `partially_refunded` until the money is given (Refund the rest) or recorded as
 *    arrived, when the callers work the status out again.
 */
export async function orderPaymentStatusAfterRefunds(db: Queryable, orderId: string): Promise<OrderPaymentStatusAfterRefunds> {
  const lines = (await db.query<{ total: number; refunded: number; partly: number }>(ORDER_LINE_COUNTS_SQL, [orderId]))[0]
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
  if (!(total > 0 && refunded >= total)) return refunded > 0 || partly > 0 ? 'partially_refunded' : null
  // W53: every counted line is refunded, but not all of the money has reached the customer while some is owed.
  const owed = (await db.query<{ owed: boolean }>(ORDER_OWED_SQL, [orderId]))[0]?.owed === true
  return owed ? 'partially_refunded' : 'refunded'
}

/**
 * W53a (W53 review L5): only an order that was paid is ever recounted: `paid`, `partially_refunded` or `refunded`. A
 * `pending` order (T2's PAID_SQL marks it paid only `WHERE payment_status = 'pending'`, so a recount there would leave
 * its payment unrecorded) and a `failed` one are left alone. Fixed text.
 */
const RECOUNTABLE_ORDER_SQL = `payment_status IN ('paid', 'partially_refunded', 'refunded')`
const RECORD_STATUS_SQL = `UPDATE orders SET payment_status = $1::text, updated_at = now() WHERE id = $2::uuid AND ${RECOUNTABLE_ORDER_SQL}`
const RECORD_CHANGED_STATUS_SQL = `UPDATE orders SET payment_status = $1::text, updated_at = now()
     WHERE id = $2::uuid AND payment_status IS DISTINCT FROM $3::text AND ${RECOUNTABLE_ORDER_SQL}`

/**
 * Writes the status orderPaymentStatusAfterRefunds works out, when there is one (the refund pipeline's R2, W21).
 * W53a: only on an order that was paid (RECOUNTABLE_ORDER_SQL); the worked-out status is answered either way.
 */
export async function recordOrderPaymentStatus(db: Queryable, orderId: string): Promise<OrderPaymentStatusAfterRefunds> {
  const status = await orderPaymentStatusAfterRefunds(db, orderId)
  if (status) await db.query(RECORD_STATUS_SQL, [status, orderId])
  return status
}

/**
 * W53 (brief item 4): the status of every order with a line for the booking (a booking line, or an add-on line)
 * worked out again. Called when what is owed on the booking has changed (a refund that ended owed, one that failed
 * later, Refund the rest, It already arrived) and when cash was handed back: those change what the booking's orders
 * should read, on orders the refund itself never touched. An order whose status is already right isn't written, so
 * its row isn't locked. In id order, so two of these never wait on each other's orders. W53a (W53 review L5): only an
 * order that was paid (RECOUNTABLE_ORDER_SQL); a pending or failed order of the booking is left alone.
 */
export async function recordBookingOrdersPaymentStatus(db: Queryable, bookingId: string): Promise<void> {
  const orders = await db.query<{ order_id: string }>(
    `SELECT x.order_id FROM order_line_items x WHERE x.booking_id = $1::uuid AND x.item_type = 'booking'
     UNION
     SELECT a.order_id FROM addon_order_lines a WHERE a.booking_id = $2::uuid AND a.order_id IS NOT NULL
     ORDER BY order_id`,
    [bookingId, bookingId]
  )
  for (const { order_id: orderId } of orders) {
    const status = await orderPaymentStatusAfterRefunds(db, orderId)
    if (status) await db.query(RECORD_CHANGED_STATUS_SQL, [status, orderId, status])
  }
}
