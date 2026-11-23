import type { Scenario, ScenarioContext } from '../sweep/run'

// The W05 invariants (W05d, W05k), moved here unchanged in W18 so the Worker's side could run them too
// (D-plan 4.11 item 3): no booking gets back more than was paid, price_paid is paid less given back, what is owed is
// never negative or more than that, Stripe's refunds are on the rows, every gift card lost what its redemptions say,
// and every PaymentIntent that took money is on exactly one order. Seat money only: add-ons have their own lines and
// their own refunds. Run on every scenario of the all-Worker sweep (sweep/sweep.ts).

/**
 * One scenario's exception on one list: exactly what breaks the check, the PaymentIntent named wherever there is one, and
 * why. W70a (the W70 audit's L5): until then an exception was a scenario's whole list, so a second breach of the same
 * kind in that scenario (another payment on no order, say) would have been let through with the first.
 */
export interface InvariantException {
  breaches: readonly string[]
  why: string
}
/** The three lists a run is allowed to break the checks below by. A use is named in `needed` (exceptionKey). */
export interface InvariantExceptions {
  stripeRefundsNotOnRows: Readonly<Record<string, InvariantException>>
  cancelledWithoutAllTheMoney: Readonly<Record<string, InvariantException>>
  chargesNotOnOneOrder: Readonly<Record<string, InvariantException>>
}
export const exceptionKey = (kind: keyof InvariantExceptions, name: string, breach: string): string => `${kind}/${name}: ${breach}`

/**
 * Allowed to break a check below, each for a reason nothing here can fix: the Worker's lists, which the all-Worker
 * sweep holds to exactly what it needs (W64a item 4, W64 review S3: sweep/sweep.ts). W65: the lists for the old
 * functions went with that code.
 */
/**
 * W13 on the Worker (W64a item 4): a membership order that can't finish after Stripe took money (the rest of the basket
 * declined, the old subscription's cancel refused, a reader card that can't be saved) is compensated: the subscription
 * cancelled, its first invoice or the tap refunded under the order's keys, then the order undone. That money went out
 * and back with no order left to hold it, so it is on no row.
 */
const MEMBERSHIP_ROLLED_BACK = "W13 on the Worker: a membership order compensated (the subscription cancelled, the payment refunded under the order's keys) and then undone, so that money is on no row"
const CLEARED = 'price_paid is forced to £0 by the scenario, so a cancel has nothing to give'
const PRICE_PAID_CLEARED: Record<string, InvariantException> = {
  'price-paid-cleared-nothing-back-then-cancel': { breaches: ['cancelled with £0.00 back on £100.00 paid'], why: CLEARED },
  'price-paid-cleared-half-back-then-cancel': { breaches: ['cancelled with £50.00 back on £100.00 paid'], why: CLEARED },
  'price-paid-cleared-addon-credit-is-not-seat-money': { breaches: ['cancelled with £95.00 back on £100.00 paid'], why: CLEARED },
  'credit-booking-price-paid-cleared-then-cancelled': { breaches: ['cancelled with £0.00 back on £20.00 paid'], why: CLEARED },
}
const FIRST_INVOICE = "a membership's first invoice belongs to its subscription, so no order names that PaymentIntent (Q21)"
/** The scenarios whose first invoice is on no order. */
const FIRST_INVOICES: Record<string, InvariantException> = {
  'event-at-member-price-with-a-new-membership': { breaches: ['pi_fake_0001 is on 0 orders'], why: FIRST_INVOICE },
  'buy-new-membership-covers-the-seat': { breaches: ['pi_fake_0001 is on 0 orders'], why: FIRST_INVOICE },
  'buy-new-membership-on-peak-pays-the-seat': { breaches: ['pi_fake_0001 is on 0 orders'], why: FIRST_INVOICE },
  'q3-buy-new-membership-with-a-pass': { breaches: ['pi_fake_0001 is on 0 orders'], why: FIRST_INVOICE },
  'q5-buy-new-keeps-address-and-requests': { breaches: ['pi_fake_0001 is on 0 orders'], why: FIRST_INVOICE },
  'q6-promo-on-buy-new-seats': { breaches: ['pi_fake_0001 is on 0 orders'], why: FIRST_INVOICE },
  'w13-card-membership-and-products': { breaches: ['pi_fake_0001 is on 0 orders'], why: FIRST_INVOICE },
  'w13-card-yearly-and-a-shipped-product': { breaches: ['pi_fake_0001 is on 0 orders'], why: FIRST_INVOICE },
  'w13-card-buy-new-membership-with-a-guest-and-an-addon': { breaches: ['pi_fake_0001 is on 0 orders'], why: FIRST_INVOICE },
  'w13-card-replace-exhausted-with-a-paid-guest': { breaches: ['pi_fake_0002 is on 0 orders'], why: FIRST_INVOICE },
  // W27's own: a membership bought with a robe on one card (E3). The order names the robe's payment.
  'w27-e3-membership-and-robe-on-one-card-refunded-to-card': { breaches: ['pi_fake_0001 is on 0 orders'], why: FIRST_INVOICE },
}
// W11: the reader took £44 for a £45 order, so finalise refuses it (amount_mismatch) and the order is
// left pending for a person, as finaliseReaderOrder did (W03-plan 2.5, "amounts don't match").
const AMOUNT_MISMATCH: Record<string, InvariantException> = {
  'w11-reader-amount-mismatch-a-pound-short': { breaches: ['pi_fake_0001 is on 0 orders'], why: 'W03-plan 2.5: a payment that does not match its order is left for a person, not finalised' },
}

/** W13's compensated membership orders on the Worker: the money out and back, on no row (REFUNDED) and on no order (CHARGED). */
const COMPENSATED_REFUNDS: Record<string, InvariantException> = {
  'w13-card-charge-declined-after-the-subscription': { breaches: ['Stripe refunded £40.00 of pi_fake_0001, the rows say £0'], why: MEMBERSHIP_ROLLED_BACK },
  'w13-card-old-cancel-refused': { breaches: ['Stripe refunded £40.00 of pi_fake_0002 and £20.00 of pi_fake_0006, the rows say £0'], why: MEMBERSHIP_ROLLED_BACK },
  'w13-reader-card-not-reusable': { breaches: ['Stripe refunded £40.00 of pi_fake_0001, the rows say £0'], why: MEMBERSHIP_ROLLED_BACK },
  'w13-reader-old-cancel-refused': { breaches: ['Stripe refunded £40.00 of pi_fake_0002, the rows say £0'], why: MEMBERSHIP_ROLLED_BACK },
}
const COMPENSATED_CHARGES: Record<string, InvariantException> = {
  'w13-card-charge-declined-after-the-subscription': { breaches: ['pi_fake_0001 is on 0 orders'], why: MEMBERSHIP_ROLLED_BACK },
  'w13-card-old-cancel-refused': { breaches: ['pi_fake_0002 is on 0 orders', 'pi_fake_0006 is on 0 orders'], why: MEMBERSHIP_ROLLED_BACK },
  'w13-reader-card-not-reusable': { breaches: ['pi_fake_0001 is on 0 orders'], why: MEMBERSHIP_ROLLED_BACK },
  'w13-reader-old-cancel-refused': { breaches: ['pi_fake_0002 is on 0 orders'], why: MEMBERSHIP_ROLLED_BACK },
}

/**
 * W64a item 4 (W64 review S3): the Worker's lists, which the all-Worker sweep uses. Each entry must still be needed:
 * sweep/sweep.ts holds what each sweep file uses to exactly its scenarios' entries here, so a stale one fails (it could
 * hide a new breach) and a needed one missing fails as a breach. Not here, because the Worker needs none of them: Q3 on
 * the reader and `w13-reader-buy-new-pass-event-and-membership` (the Worker finalises them and keeps the money: W13),
 * and `unsure-part-refund-card-arrived` (W47 item 8: It already arrived records the card money on the line).
 */
export const WORKER_EXCEPTIONS: InvariantExceptions = {
  stripeRefundsNotOnRows: COMPENSATED_REFUNDS,
  cancelledWithoutAllTheMoney: PRICE_PAID_CLEARED,
  chargesNotOnOneOrder: { ...FIRST_INVOICES, ...COMPENSATED_CHARGES, ...AMOUNT_MISMATCH },
}

export interface InvariantSweep {
  /** One line per breach, `<scenario>: <what>`. */
  wrong: string[]
  /** Which exceptions were used (exceptionKey), once for each time, so a stale one can be caught. */
  needed: string[]
  bookingsChecked: number
}

/**
 * W64: `scenario` with the invariants checked on what it leaves, into `sweep`, so a caller that keeps the recording (the
 * all-Worker sweep) checks them on the same run.
 */
export function watchedForInvariants(scenario: Scenario, sweep: InvariantSweep, exceptions: InvariantExceptions = WORKER_EXCEPTIONS): Scenario {
  const { wrong, needed } = sweep
  /** Each exception must still be needed, so a stale one can't hide a new problem. Each listed breach is let through once. */
  const left = new Map<keyof InvariantExceptions, string[]>()
  const allowed = (kind: keyof InvariantExceptions, name: string, breach: string) => {
    const listed = left.get(kind) ?? [...(exceptions[kind][name]?.breaches ?? [])]
    left.set(kind, listed)
    const at = listed.indexOf(breach)
    if (at === -1) return false
    listed.splice(at, 1)
    needed.push(exceptionKey(kind, name, breach))
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
        const answer = (result ?? {}) as { moved?: boolean; settled?: boolean; message?: string; reason?: string }
        // An unclear save (W05l) keeps everything taken, the cash too, until staff check. W65b: on the Worker that is a
        // press whose route's answer was lost (`no_answer`): the cash was handed over before the press.
        const unclear = answer.message?.includes('checking whether it was saved failed too') === true || answer.reason === 'no_answer'
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
        const cancelled = `cancelled with £${back.toFixed(2)} back on £${paid.toFixed(2)} paid`
        if (row.status === 'cancelled' && Math.abs(paid - back) > 0.005 && !allowed('cancelledWithoutAllTheMoney', scenario.name, cancelled)) {
          wrong.push(`${scenario.name}: ${cancelled}`)
        }
      }

      // What really left Stripe, however many calls asked for it, against what the rows say.
      const [recorded] = await context.db.query<{ card: string }>(
        `SELECT (SELECT COALESCE(SUM(card_refunded_amount), 0) FROM order_line_items)
                + (SELECT COALESCE(SUM(card_refunded_amount), 0) FROM addon_order_lines) AS card`
      )
      const stripeBack = context.stripe.refundedPence / 100
      // W53 (migration 033): the sum's text is to the penny now (`15.00`); said as it always was (`15`).
      const rowsSay = `the rows say £${String(Number.parseFloat(recorded?.card ?? '0'))}`
      const byIntent = [...context.stripe.refundedByIntent].filter(([, pence]) => pence !== 0).sort(([a], [b]) => a.localeCompare(b)).map(([intent, pence]) => `£${(pence / 100).toFixed(2)} of ${intent}`)
      if (Math.abs(stripeBack - Number.parseFloat(recorded?.card ?? '0')) > 0.005 && !allowed('stripeRefundsNotOnRows', scenario.name, `Stripe refunded ${byIntent.join(' and ')}, ${rowsSay}`)) {
        wrong.push(`${scenario.name}: Stripe refunded £${stripeBack.toFixed(2)}, ${rowsSay}`)
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
        const isOn = `${intent} is on ${orders.length} orders`
        if (orders.length !== 1 && !allowed('chargesNotOnOneOrder', scenario.name, isOn)) wrong.push(`${scenario.name}: ${isOn}`)
      }
    },
  }
  return watched
}
