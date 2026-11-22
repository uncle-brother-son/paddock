import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { replay, type ReplayEnvironment, type ReplaySide, type Scenario, type ScenarioContext } from '../sweep/run'

// The W05 invariants (W05d, W05k), moved here from w05d.test.ts unchanged in W18 so the new side can run them too
// (D-plan 4.11 item 3): no booking gets back more than was paid, price_paid is paid less given back, what is owed is
// never negative or more than that, Stripe's refunds are on the rows, every gift card lost what its redemptions say,
// and every PaymentIntent that took money is on exactly one order. Seat money only: add-ons have their own lines and
// their own refunds.

/**
 * Allowed to break a check below, each for a reason nothing here can fix. Two sets: the old replay's (its old side ran
 * the old functions; w05d.test.ts holds every one still needed there, and W65 deletes both), and the Worker's, which the
 * all-Worker sweep uses and holds to exactly what it needs (W64a item 4, W64 review S3: sweep/sweep.ts).
 */
/** W13 on the old functions: they put a membership's money back and rolled the order back: taken and refunded, on no row. */
const OLD_FUNCTIONS_ROLLED_BACK = "W13 on the old functions: a membership that couldn't be set up, its payment refunded and the order rolled back, so the money is on no row"
/**
 * W13 on the Worker (W64a item 4): a membership order that can't finish after Stripe took money (the rest of the basket
 * declined, the old subscription's cancel refused, a reader card that can't be saved) is compensated: the subscription
 * cancelled, its first invoice or the tap refunded under the order's keys, then the order undone. That money went out
 * and back with no order left to hold it, so it is on no row.
 */
export const MEMBERSHIP_ROLLED_BACK = "W13 on the Worker: a membership order compensated (the subscription cancelled, the payment refunded under the order's keys) and then undone, so that money is on no row"
export const STRIPE_REFUNDS_NOT_ON_ROWS: Record<string, string> = {
  'q3-reader-buy-new-pass-with-a-membership': 'W05a Q3 on the reader: £90 taken and refunded by the rollback of an order that never existed. Tracked for go-live',
  'w13-card-charge-declined-after-the-subscription': OLD_FUNCTIONS_ROLLED_BACK,
  'w13-card-old-cancel-refused': OLD_FUNCTIONS_ROLLED_BACK,
  'w13-reader-buy-new-pass-event-and-membership': OLD_FUNCTIONS_ROLLED_BACK,
  'w13-reader-card-not-reusable': OLD_FUNCTIONS_ROLLED_BACK,
  'w13-reader-old-cancel-refused': OLD_FUNCTIONS_ROLLED_BACK,
  'unsure-part-refund-card-arrived': 'It already arrived moves no money and records nothing on the line, so a refund that really left Stripe is on no row. It is capped by price_paid, so nothing can go twice',
}
const PRICE_PAID_CLEARED: Record<string, string> = {
  'price-paid-cleared-nothing-back-then-cancel': 'price_paid is forced to £0 by the scenario, so a cancel has nothing to give',
  'price-paid-cleared-half-back-then-cancel': 'the same',
  'price-paid-cleared-addon-credit-is-not-seat-money': 'the same',
  'credit-booking-price-paid-cleared-then-cancelled': 'the same',
}
export const CANCELLED_WITHOUT_ALL_THE_MONEY: Record<string, string> = {
  ...PRICE_PAID_CLEARED,
  'unsure-part-refund-card-arrived': 'It already arrived: the £40 reached the customer and is on no row',
}
export const FIRST_INVOICE = "a membership's first invoice belongs to its subscription, so no order names that PaymentIntent (Q21)"
/** The scenarios whose first invoice is on no order, on either side. */
const FIRST_INVOICES: Record<string, string> = {
  'event-at-member-price-with-a-new-membership': FIRST_INVOICE,
  'buy-new-membership-covers-the-seat': FIRST_INVOICE,
  'buy-new-membership-on-peak-pays-the-seat': FIRST_INVOICE,
  'q3-buy-new-membership-with-a-pass': FIRST_INVOICE,
  'q5-buy-new-keeps-address-and-requests': FIRST_INVOICE,
  'q6-promo-on-buy-new-seats': FIRST_INVOICE,
  'w13-card-membership-and-products': FIRST_INVOICE,
  'w13-card-yearly-and-a-shipped-product': FIRST_INVOICE,
  'w13-card-buy-new-membership-with-a-guest-and-an-addon': FIRST_INVOICE,
  'w13-card-replace-exhausted-with-a-paid-guest': FIRST_INVOICE,
  // W27's own: a membership bought with a robe on one card (E3). The order names the robe's payment.
  'w27-e3-membership-and-robe-on-one-card-refunded-to-card': FIRST_INVOICE,
}
// W11: the reader took £44 for a £45 order, so finalise refuses it (amount_mismatch) and the order is
// left pending for a person, as finaliseReaderOrder did (W03-plan 2.5, "amounts don't match").
const AMOUNT_MISMATCH: Record<string, string> = {
  'w11-reader-amount-mismatch-a-pound-short': 'W03-plan 2.5: a payment that does not match its order is left for a person, not finalised',
}
export const CHARGES_NOT_ON_ONE_ORDER: Record<string, string> = {
  ...FIRST_INVOICES,
  'q3-reader-buy-new-pass-with-a-membership': 'W05a Q3 on the reader: the order rolled back, so the £90 has none. Tracked for go-live',
  // W13's own on the old functions.
  'w13-card-charge-declined-after-the-subscription': OLD_FUNCTIONS_ROLLED_BACK,
  'w13-card-old-cancel-refused': OLD_FUNCTIONS_ROLLED_BACK,
  'w13-reader-buy-new-pass-event-and-membership': OLD_FUNCTIONS_ROLLED_BACK,
  'w13-reader-card-not-reusable': OLD_FUNCTIONS_ROLLED_BACK,
  'w13-reader-old-cancel-refused': OLD_FUNCTIONS_ROLLED_BACK,
  ...AMOUNT_MISMATCH,
}

/** The three lists a run is allowed to break the checks below by. */
export interface InvariantExceptions {
  stripeRefundsNotOnRows: Readonly<Record<string, string>>
  cancelledWithoutAllTheMoney: Readonly<Record<string, string>>
  chargesNotOnOneOrder: Readonly<Record<string, string>>
  /**
   * How a use is named in `needed`: `<list name>/<scenario>`. Without it, `<the list's first key>/<scenario>`, the form
   * w05d.test.ts reads for the old lists.
   */
  byListName?: boolean
}

/** The old replay's lists (its old side). */
const OLD_SIDE_EXCEPTIONS: InvariantExceptions = {
  stripeRefundsNotOnRows: STRIPE_REFUNDS_NOT_ON_ROWS,
  cancelledWithoutAllTheMoney: CANCELLED_WITHOUT_ALL_THE_MONEY,
  chargesNotOnOneOrder: CHARGES_NOT_ON_ONE_ORDER,
}

/** W13's compensated membership orders on the Worker: the money out and back, on no row and on no order. */
const COMPENSATED: Record<string, string> = {
  'w13-card-charge-declined-after-the-subscription': MEMBERSHIP_ROLLED_BACK,
  'w13-card-old-cancel-refused': MEMBERSHIP_ROLLED_BACK,
  'w13-reader-card-not-reusable': MEMBERSHIP_ROLLED_BACK,
  'w13-reader-old-cancel-refused': MEMBERSHIP_ROLLED_BACK,
}

/**
 * W64a item 4 (W64 review S3): the Worker's lists, which the all-Worker sweep uses. Each entry must still be needed:
 * sweep/sweep.ts holds what each sweep file uses to exactly its scenarios' entries here, so a stale one fails (it could
 * hide a new breach) and a needed one missing fails as a breach. Not here, because the Worker needs none of them: Q3 on
 * the reader and `w13-reader-buy-new-pass-event-and-membership` (the Worker finalises them and keeps the money: W13),
 * and `unsure-part-refund-card-arrived` (W47 item 8: It already arrived records the card money on the line).
 */
export const WORKER_EXCEPTIONS: InvariantExceptions = {
  stripeRefundsNotOnRows: COMPENSATED,
  cancelledWithoutAllTheMoney: PRICE_PAID_CLEARED,
  chargesNotOnOneOrder: { ...FIRST_INVOICES, ...COMPENSATED, ...AMOUNT_MISMATCH },
  byListName: true,
}

export interface InvariantSweep {
  /** One line per breach, `<scenario>: <what>`. */
  wrong: string[]
  /** Which exceptions were used (`<list's first key>/<scenario>`), so a stale one can be caught. */
  needed: Set<string>
  bookingsChecked: number
}

/** Runs each scenario through `makeSide` and checks the invariants on what it leaves. */
export async function sweepInvariants(
  environment: ReplayEnvironment,
  list: readonly Scenario[],
  makeSide: (db: Db, stripe: FakeStripe) => ReplaySide
): Promise<InvariantSweep> {
  const sweep: InvariantSweep = { wrong: [], needed: new Set<string>(), bookingsChecked: 0 }
  for (const scenario of list) await replay(environment, watchedForInvariants(scenario, sweep), makeSide)
  return sweep
}

/**
 * W64: `scenario` with the invariants checked on what it leaves, into `sweep`, so a caller that keeps the recording (the
 * all-Worker sweep) checks them on the same run. Moved out of sweepInvariants unchanged.
 */
export function watchedForInvariants(scenario: Scenario, sweep: InvariantSweep, exceptions: InvariantExceptions = OLD_SIDE_EXCEPTIONS): Scenario {
  const { wrong, needed } = sweep
  /** Each exception must still be needed, so a stale one can't hide a new problem. */
  const allowed = (kind: 'stripeRefundsNotOnRows' | 'cancelledWithoutAllTheMoney' | 'chargesNotOnOneOrder', name: string) => {
    const list = exceptions[kind]
    if (!(name in list)) return false
    needed.add(exceptions.byListName === true ? `${kind}/${name}` : `${Object.keys(list)[0]}/${name}`)
    return true
  }
  /** Cash that no order line or row records: a move or a settle paid in cash. Store credit and gift card
   *  parts are read from their rows below (W05k): from the request, a press that counted a part
   *  it never took would pass. */
  const offLines = new Map<string, number>()
  const watched: Scenario = {
    ...scenario,
    async run(context: ScenarioContext) {
      const call: ScenarioContext['call'] = async (action, params) => {
        const result = await context.call(action, params)
        const sent = params as { bookingId?: string; payment?: { method?: string; confirmedCashAmount?: number } }
        // W27: an old function can answer null (getEventCancellationOverview, for an event that is gone).
        const answer = (result ?? {}) as { moved?: boolean; settled?: boolean; message?: string }
        // An unclear save (W05l) keeps everything taken, the cash too, until staff check.
        const unclear = answer.message?.includes('checking whether it was saved failed too') === true
        const done = (action === 'moveBooking' && (answer.moved || unclear)) || (action === 'settleLapsedBooking' && (answer.settled || unclear))
        if (done && sent.bookingId && sent.payment?.method === 'cash') {
          offLines.set(sent.bookingId, (offLines.get(sent.bookingId) ?? 0) + (sent.payment.confirmedCashAmount ?? 0))
        }
        return result
      }
      const seeded = await context.db.query<{ id: string }>('SELECT id FROM bookings')
      const seededGiftCards = await context.db.query<{ id: string; balance: string }>('SELECT id, remaining_balance AS balance FROM gift_cards')
      await scenario.run({ ...context, call })
      const rows = await context.db.query<{ id: string; status: string; price_paid: string | null; refund_owed_amount: string; paid: string; card: string; credit: string; parts: string }>(
        `SELECT b.id, b.status, b.price_paid, b.refund_owed_amount,
                -- Store credit and gift card that paid for this booking outside any order line:
                -- redemptions less reversals with no order, and gift card redemptions with no order.
                (SELECT -COALESCE(SUM(sct.amount), 0) FROM store_credit_transactions sct
                 WHERE sct.booking_id = b.id AND sct.order_id IS NULL AND sct.reason IN ('redemption', 'redemption_reversal'))
                + (SELECT COALESCE(SUM(gcr.amount_used), 0) FROM gift_card_redemptions gcr
                   WHERE gcr.booking_id = b.id AND gcr.order_id IS NULL) AS parts,
                (SELECT COALESCE(SUM(oli.line_total - COALESCE(oli.discount_amount, 0) - inside.addons), 0)
                 FROM order_line_items oli
                 JOIN orders o ON o.id = oli.order_id
                 CROSS JOIN LATERAL (
                   SELECT COALESCE(SUM(aol.price_at_purchase * aol.quantity), 0) AS paid FROM addon_order_lines aol
                   WHERE aol.order_id = oli.order_id AND aol.redemption_source IS DISTINCT FROM 'membership_credit'
                 ) addon
                 CROSS JOIN LATERAL (
                   SELECT LEAST(addon.paid, GREATEST(SUM(x.line_total) + addon.paid - o.order_total, 0)) AS addons
                   FROM order_line_items x WHERE x.order_id = oli.order_id
                 ) inside
                 WHERE oli.booking_id = b.id AND oli.item_type = 'booking') AS paid,
                (SELECT COALESCE(SUM(oli.card_refunded_amount), 0) FROM order_line_items oli
                 WHERE oli.booking_id = b.id AND oli.item_type = 'booking') AS card,
                (SELECT COALESCE(SUM(sct.amount), 0) FROM store_credit_transactions sct
                 WHERE sct.booking_id = b.id AND sct.reason = 'refund')
                - (SELECT COALESCE(SUM(aol.refunded_amount - aol.card_refunded_amount), 0) FROM addon_order_lines aol
                   WHERE aol.booking_id = b.id) AS credit
         FROM bookings b`
      )
      // A seeded booking has no order behind it.
      for (const row of rows.filter((r) => !seeded.some((s) => s.id === r.id))) {
        sweep.bookingsChecked += 1
        const paid = Number.parseFloat(row.paid) + Number.parseFloat(row.parts) + (offLines.get(row.id) ?? 0)
        const back = Number.parseFloat(row.card) + Number.parseFloat(row.credit)
        const left = Number.parseFloat(row.price_paid ?? '0')
        const owed = Number.parseFloat(row.refund_owed_amount)
        if (back > paid + 0.005) wrong.push(`${scenario.name}: £${back.toFixed(2)} back on £${paid.toFixed(2)} paid`)
        if (owed < 0) wrong.push(`${scenario.name}: £${owed.toFixed(2)} owed`)
        if (back + owed > paid + 0.005) wrong.push(`${scenario.name}: £${back.toFixed(2)} back and £${owed.toFixed(2)} owed on £${paid.toFixed(2)} paid`)
        if (row.status === 'confirmed' && owed > left + 0.005) wrong.push(`${scenario.name}: £${owed.toFixed(2)} owed, but only £${left.toFixed(2)} on the booking`)
        if (row.status === 'cancelled' && owed > 0) wrong.push(`${scenario.name}: a cancelled booking still owes £${owed.toFixed(2)}`)
        if (row.status === 'confirmed' && Math.abs(left - (paid - back)) > 0.005) {
          wrong.push(`${scenario.name}: price_paid £${left.toFixed(2)}, but £${paid.toFixed(2)} paid less £${back.toFixed(2)} back`)
        }
        if (row.status === 'cancelled' && Math.abs(paid - back) > 0.005 && !allowed('cancelledWithoutAllTheMoney', scenario.name)) {
          wrong.push(`${scenario.name}: cancelled with £${back.toFixed(2)} back on £${paid.toFixed(2)} paid`)
        }
      }

      // What really left Stripe, however many calls asked for it, against what the rows say.
      const [recorded] = await context.db.query<{ card: string }>(
        `SELECT (SELECT COALESCE(SUM(card_refunded_amount), 0) FROM order_line_items)
                + (SELECT COALESCE(SUM(card_refunded_amount), 0) FROM addon_order_lines) AS card`
      )
      const stripeBack = context.stripe.refundedPence / 100
      if (Math.abs(stripeBack - Number.parseFloat(recorded?.card ?? '0')) > 0.005 && !allowed('stripeRefundsNotOnRows', scenario.name)) {
        // W53 (migration 033): the sum's text is to the penny now (`15.00`); said as it always was (`15`).
        wrong.push(`${scenario.name}: Stripe refunded £${stripeBack.toFixed(2)}, the rows say £${String(Number.parseFloat(recorded?.card ?? '0'))}`)
      }

      // Every gift card that was seeded lost exactly what its redemptions record (W05k): a part
      // taken and never written down, or written down and never taken, shows here.
      const giftCards = await context.db.query<{ id: string; balance: string; redeemed: string }>(
        `SELECT g.id, g.remaining_balance AS balance,
                (SELECT COALESCE(SUM(r.amount_used), 0) FROM gift_card_redemptions r WHERE r.gift_card_id = g.id) AS redeemed
         FROM gift_cards g WHERE g.id = ANY($1::uuid[])`,
        [seededGiftCards.map((g) => g.id)]
      )
      for (const card of giftCards) {
        const before = Number.parseFloat(seededGiftCards.find((g) => g.id === card.id)?.balance ?? '0')
        const taken = before - Number.parseFloat(card.balance)
        if (Math.abs(taken - Number.parseFloat(card.redeemed)) > 0.005) {
          wrong.push(`${scenario.name}: gift card ${card.id} lost £${taken.toFixed(2)}, its redemptions say £${Number.parseFloat(card.redeemed).toFixed(2)}`)
        }
      }

      // Event bookings and orders (W05k): no more back than was paid, and the places' card money
      // is what Stripe refunded on the event's payment.
      const events = await context.db.query<{ id: string; paid: string; card: string; credit: string; intent: string | null; only_events: boolean }>(
        `SELECT eb.id, oli.line_total - COALESCE(oli.discount_amount, 0) AS paid,
                (SELECT COALESCE(SUM(ea.card_refunded_amount), 0) FROM event_attendees ea WHERE ea.event_booking_id = eb.id) AS card,
                (SELECT COALESCE(SUM(sct.amount), 0) FROM store_credit_transactions sct
                 WHERE sct.order_id = oli.order_id AND sct.reason = 'refund' AND sct.booking_id IS NULL) AS credit,
                o.stripe_payment_intent_id AS intent,
                NOT EXISTS (SELECT 1 FROM order_line_items x WHERE x.order_id = o.id AND x.item_type <> 'event') AS only_events
         FROM event_bookings eb
         JOIN order_line_items oli ON oli.event_booking_id = eb.id AND oli.item_type = 'event'
         JOIN orders o ON o.id = oli.order_id`
      )
      for (const event of events) {
        const back = Number.parseFloat(event.card) + Number.parseFloat(event.credit)
        if (back > Number.parseFloat(event.paid) + 0.005) {
          wrong.push(`${scenario.name}: event booking £${back.toFixed(2)} back on £${Number.parseFloat(event.paid).toFixed(2)} paid`)
        }
        if (event.intent && event.only_events) {
          const stripeBackForIt = (context.stripe.refundedByIntent.get(event.intent) ?? 0) / 100
          if (Math.abs(stripeBackForIt - Number.parseFloat(event.card)) > 0.005) {
            wrong.push(`${scenario.name}: the places say £${Number.parseFloat(event.card).toFixed(2)} went to the card, Stripe refunded £${stripeBackForIt.toFixed(2)}`)
          }
        }
      }
      const orders = await context.db.query<{ id: string; total: string; card: string; credit: string }>(
        `SELECT o.id, o.order_total AS total,
                (SELECT COALESCE(SUM(oli.card_refunded_amount), 0) FROM order_line_items oli WHERE oli.order_id = o.id)
                + (SELECT COALESCE(SUM(aol.card_refunded_amount), 0) FROM addon_order_lines aol WHERE aol.order_id = o.id) AS card,
                (SELECT COALESCE(SUM(sct.amount), 0) FROM store_credit_transactions sct
                 WHERE sct.order_id = o.id AND sct.reason = 'refund' AND sct.booking_id IS NULL) AS credit
         FROM orders o
         WHERE NOT EXISTS (SELECT 1 FROM order_line_items x WHERE x.order_id = o.id AND x.item_type IN ('booking', 'event'))`
      )
      for (const order of orders) {
        const back = Number.parseFloat(order.card) + Number.parseFloat(order.credit)
        if (back > Number.parseFloat(order.total) + 0.005) {
          wrong.push(`${scenario.name}: an order got £${back.toFixed(2)} back on £${Number.parseFloat(order.total).toFixed(2)}`)
        }
      }

      // Every PaymentIntent that took money is on exactly one order, so its card money counts once.
      for (const [intent] of context.stripe.chargedByIntent) {
        const orders = await context.db.query<{ id: string }>('SELECT id FROM orders WHERE stripe_payment_intent_id = $1', [intent])
        if (orders.length !== 1 && !allowed('chargesNotOnOneOrder', scenario.name)) wrong.push(`${scenario.name}: ${intent} is on ${orders.length} orders`)
      }
    },
  }
  return watched
}
