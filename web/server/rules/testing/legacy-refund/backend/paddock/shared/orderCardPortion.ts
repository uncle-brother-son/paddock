/**
 * Read-only: how much of an order can still go back to its card. refundOrder, the event
 * cancellation refunds and the cancellation quote all use this, so they can never disagree.
 *
 * The card portion is what the order's recorded PaymentIntent actually took:
 *  - the order total, less its promo discount, the gift card part (gift_card_redemptions) and the
 *    store credit part (store credit spent on the order: taking back a refund's store credit is a
 *    negative row too, and says nothing about how the order was paid);
 *  - EXCEPT a saved-card membership order (payment_method not 'reader'), where the membership's
 *    first payment was taken by its own Stripe subscription. When the rest of the basket was
 *    charged separately, the order's PaymentIntent is that remainder charge, so the membership's
 *    share (its line net of its promo) is left out. When nothing else was charged, the order's
 *    PaymentIntent is the subscription's first invoice, which the full formula already equals.
 *    (A card-reader membership order took everything in the one tap, so the full formula applies.)
 *
 * Card money already given back on any of the order's lines comes off, since the card portion can
 * only be refunded once: order_line_items.card_refunded_amount (refundOrder, the booking refund
 * flows, event cancellations) and addon_order_lines.card_refunded_amount for booking add-ons paid
 * on this order (refunded by the Worker since W22/W23). With no PaymentIntent (cash, gift card only, store credit
 * only) nothing can go back to a card.
 */
export interface OrderCardPortion {
  orderId: string
  customerId: string
  paymentIntentId: string | null
  /** What the order's PaymentIntent took. */
  cardPortion: number
  /** Card refunds already made on the order's lines. */
  alreadyCardRefunded: number
  /** cardPortion less alreadyCardRefunded (never negative). Not capped by paymentIntentId: callers
   *  decide what to do when there is a card portion but no PaymentIntent on record. */
  cardPortionRemaining: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

export async function loadOrderCardPortion(orderId: string): Promise<OrderCardPortion | null> {
  const lookup = await paddockData.query<{
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
    `SELECT o.customer_id, o.stripe_payment_intent_id, o.payment_method, o.order_total,
            o.discount_amount AS order_discount_amount,
            COALESCE((SELECT SUM(gcr.amount_used) FROM gift_card_redemptions gcr WHERE gcr.order_id = o.id), 0) AS gift_card_used,
            COALESCE((SELECT -SUM(sct.amount) FROM store_credit_transactions sct WHERE sct.order_id = o.id AND sct.amount < 0 AND sct.reason IN ('redemption', 'redemption_reversal')), 0) AS store_credit_used,
            COALESCE((SELECT SUM(oli.line_total - oli.discount_amount) FROM order_line_items oli
                      WHERE oli.order_id = o.id AND oli.item_type = 'membership'), 0) AS membership_net,
            COALESCE((SELECT SUM(oli.card_refunded_amount) FROM order_line_items oli WHERE oli.order_id = o.id), 0)
              + COALESCE((SELECT SUM(aol.card_refunded_amount) FROM addon_order_lines aol WHERE aol.order_id = o.id), 0)
              AS already_card_refunded
     FROM orders o WHERE o.id = $1`,
    [orderId]
  )
  const row = lookup.data[0]
  if (!row) return null

  const paidByCards = round2(
    Number.parseFloat(row.order_total) -
      Number.parseFloat(row.order_discount_amount ?? '0') -
      Number.parseFloat(row.gift_card_used) -
      Number.parseFloat(row.store_credit_used)
  )
  let cardPortion = Math.max(0, paidByCards)
  const membershipNet = Number.parseFloat(row.membership_net)
  if (membershipNet > 0.005 && row.payment_method !== 'reader') {
    // Gift card / store credit cover the rest of the basket first, then spill onto the
    // membership (createOrder), so the remainder charge is what's left of the non-membership part.
    const remainderCharge = round2(paidByCards - membershipNet)
    if (remainderCharge > 0.005) cardPortion = remainderCharge
  }
  const alreadyCardRefunded = round2(Number.parseFloat(row.already_card_refunded))
  return {
    orderId,
    customerId: row.customer_id,
    paymentIntentId: row.stripe_payment_intent_id,
    cardPortion,
    alreadyCardRefunded,
    cardPortionRemaining: Math.max(0, round2(cardPortion - alreadyCardRefunded)),
  }
}
