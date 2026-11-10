import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import type { Recording } from './compare'
import { oldSide, replay, startReplay, type ReplayEnvironment, type ReplaySide, type Scenario, type ScenarioContext } from './harness'
import { ID, noPromoOnCard, scenarios, seed } from './scenarios'

// What the W05d scenarios prove the old functions now do, in pence. Each one's rows are also held to
// its golden file in replay.test.ts. Private: £100 at Core, £140 at Peak. Public: two seats, £40 at
// Core, £51 at Peak.

const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
const pence = (recording: Recording, method: string) =>
  recording.stripeCalls.filter((call) => call.method === method).map((call) => (call.params as { amount: number }).amount)
const charged = (recording: Recording) => pence(recording, 'paymentIntents.create')
const refunds = (recording: Recording) => pence(recording, 'refunds.create')
const total = (amounts: number[]) => amounts.reduce((sum, amount) => sum + amount, 0)
const creditBack = (recording: Recording) =>
  added(recording, 'store_credit_transactions')
    .filter((row) => row['reason'] === 'refund')
    .map((row) => row['amount'])
const booking = (recording: Recording) => added(recording, 'bookings')[0]
const bookingLines = (recording: Recording) => added(recording, 'order_line_items').filter((line) => line['item_type'] === 'booking')
const orderStatuses = (recording: Recording) => added(recording, 'orders').map((order) => order['payment_status'])
const fromEnd = (recording: Recording, back: number) => recording.results[recording.results.length - back]

type Query = (sql: string, params?: unknown[]) => Promise<unknown>

/** The old side with a statement failing as a database error would, while `armed.on`. */
const failing = (matches: (sql: string) => boolean, armed: { on: boolean }) => (db: Db, stripe: FakeStripe): ReplaySide => {
  const side = oldSide(db, stripe)
  const { query } = (globalThis as unknown as { paddockData: { query: Query } }).paddockData
  vi.stubGlobal('paddockData', {
    query: (sql: string, params?: unknown[]) => (armed.on && matches(sql) ? Promise.reject(new Error('connection lost')) : query(sql, params)),
  })
  return side
}

describe('W05d on the old functions', () => {
  let environment: ReplayEnvironment

  beforeAll(async () => {
    environment = await startReplay()
  })
  afterAll(() => environment.stop())

  const run = (name: string) => {
    const scenario = scenarios.find((s) => s.name === name)
    if (!scenario) throw new Error(`No scenario ${name}`)
    return replay(environment, scenario, oldSide)
  }

  describe('part_refunded_amount', () => {
    it.each<[string, string]>([
      ['q25-part-refund-then-a-guest', '30.00'],
      ['q27-part-to-credit-same-tier-then-to-the-card', '30.00'],
      // £60 to the card and £10 to store credit, counted once.
      ['q27-part-refund-split-card-and-credit-counted-once', '70.00'],
      // £20 to the card, then £10 to store credit.
      ['q27-two-part-refunds-then-a-higher-tier', '30.00'],
      ['q27-whole-booking-part-refunded-then-same-tier', '90.00'],
    ])('%s: the part refund raises it by what was given back', async (name, amount) => {
      expect(booking(await run(name))).toMatchObject({ part_refunded_amount: amount })
    })

    it.each<[string, string, string]>([
      ['q27-cheaper-move-is-not-a-part-refund', 'a cheaper move', '0.00'],
      ['q28-private-dearer-on-the-card', 'a dearer move', '30.00'],
      ['addon-with-guest-then-remove-guest-then-cancel', 'Remove Guest or a full Cancel & Refund', '0.00'],
      ['q27-a-reversed-charge-is-not-a-part-refund', 'a reversed charge', '0.00'],
      ['q27-addon-refund-is-not-a-part-refund', 'an add-on refund', '0.00'],
      ['addon-with-no-guest-on-the-card-ticked', 'a Cancel & Refund with an add-on', '0.00'],
    ])('%s: %s adds nothing to it', async (name, _what, amount) => {
      expect(booking(await run(name))).toMatchObject({ part_refunded_amount: amount })
    })

    it('a declined part refund leaves it and price_paid as they were', async () => {
      const recording = await run('part-refund-declined-changes-nothing')
      expect(refunds(recording)).toEqual([3000])
      expect(creditBack(recording)).toEqual([])
      expect(booking(recording)).toMatchObject({ price_paid: '100.00', part_refunded_amount: '0.00' })
    })

    // £10 store credit and £90 on the card: a £90 part refund is all the card money.
    const splitPartRefund = (name: string, armed: { on: boolean }): Scenario => ({
      name,
      seed,
      async run({ call }) {
        const payment = { method: 'card', storeCredit: { amount: 10 } }
        const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...noPromoOnCard, payment })) as { bookingId: string }
        armed.on = true
        await call('refundBooking', { bookingId, refundMethod: 'card', amount: 90, reason: 'Goodwill' })
        armed.on = false
      },
    })

    it('the claim failing stops the refund before any money moves, and the two figures still agree', async () => {
      const armed = { on: false }
      const side = failing((sql) => sql.includes('part_refunded_amount = b.part_refunded_amount'), armed)
      const failed = await replay(environment, splitPartRefund('split-write-fails', armed), (db, stripe) => {
        const inner = side(db, stripe)
        return { ...inner, call: (action, params) => inner.call(action, params).catch((err: Error) => ({ thrown: err.message })) }
      })
      expect(refunds(failed)).toEqual([])
      expect(fromEnd(failed, 1)).toEqual({ thrown: 'connection lost' })
      expect(booking(failed)).toMatchObject({ price_paid: '100.00', part_refunded_amount: '0.00' })
    })
  })

  describe('Q28: a move leaves a part refund with the customer', () => {
    // The steps are the order, the part refund, the quote, then the confirmed move.
    it.each<[string, number, number]>([
      ['q28-private-same-price-part-to-the-card', 0, 70],
      ['q28-private-same-price-part-to-store-credit', 0, 70],
      ['q28-private-dearer-on-the-card', 40, 110],
      ['q28-private-dearer-on-the-reader', 40, 110],
      ['q28-private-dearer-in-cash', 40, 110],
      ['q28-private-dearer-store-credit-and-card', 40, 110],
      ['q28-private-cheaper-to-the-card', -40, 70],
      ['q28-private-cheaper-to-store-credit', -40, 70],
      ['q28-private-cheaper-stops-at-what-is-left', -10, 0],
      ['q28-private-cheaper-with-nothing-left', 0, 0],
      ['q28-public-same-price-part-to-the-card', 0, 30],
      ['q28-public-same-price-part-to-store-credit', 0, 30],
      ['q28-public-dearer-on-the-card', 11, 41],
      ['q28-public-dearer-on-the-reader', 11, 41],
      ['q28-public-dearer-in-cash', 11, 41],
      ['q28-public-cheaper-to-the-card', -11, 30],
      ['q28-public-cheaper-to-store-credit', -11, 30],
      ['q28-public-cheaper-stops-at-what-is-left', -6, 0],
    ])('%s: quotes %d and leaves £%d on price_paid', async (name, amountDue, pricePaid) => {
      const recording = await run(name)
      expect(recording.results[2]).toMatchObject({ moved: false, priceImpact: { amountDue, refundDue: amountDue < 0 } })
      expect(recording.results[3]).toMatchObject({ moved: true, booking: { price_paid: pricePaid } })
    })

    it.each<[string, number[], number[], string[]]>([
      ['q28-private-same-price-part-to-the-card', [10000], [3000, 7000], []],
      ['q28-private-same-price-part-to-store-credit', [10000], [7000], ['30.00']],
      ['q28-private-dearer-on-the-card', [10000, 4000], [3000, 4000, 7000], []],
      ['q28-private-dearer-on-the-reader', [10000, 4000], [3000, 4000, 7000], []],
      // The move's £40 in cash can only go back as store credit.
      ['q28-private-dearer-in-cash', [10000], [3000, 7000], ['40.00']],
      // £10 store credit and £30 on the card.
      ['q28-private-dearer-store-credit-and-card', [10000, 3000], [3000, 3000, 7000], ['10.00']],
      ['q28-private-cheaper-to-the-card', [14000], [3000, 4000, 7000], []],
      ['q28-private-cheaper-to-store-credit', [14000], [3000, 7000], ['40.00']],
      ['q28-private-cheaper-stops-at-what-is-left', [14000], [13000, 1000], []],
      ['q28-private-cheaper-with-nothing-left', [14000], [14000], []],
      ['q28-private-there-and-back', [10000, 4000], [3000, 4000, 7000], []],
      ['q28-private-cheaper-move-then-part-then-dearer-move', [14000, 4000], [4000, 3000, 4000, 7000], []],
      ['q28-private-part-then-guest-then-move', [10000, 5000, 4000], [3000, 4000, 5000, 7000], []],
      ['q28-public-same-price-part-to-store-credit', [4000], [3000], ['10.00']],
      ['q28-public-dearer-on-the-card', [4000, 1100], [1000, 1100, 3000], []],
      ['q28-public-dearer-on-the-reader', [4000, 1100], [1000, 1100, 3000], []],
      ['q28-public-dearer-in-cash', [4000], [1000, 3000], ['11.00']],
      ['q28-public-cheaper-to-the-card', [5100], [1000, 1100, 3000], []],
      ['q28-public-cheaper-to-store-credit', [5100], [1000, 3000], ['11.00']],
      ['q28-public-cheaper-stops-at-what-is-left', [5100], [4500, 600], []],
    ])('%s: every penny of it comes back once, and no more', async (name, cardCharges, cardRefunds, credit) => {
      const recording = await run(name)
      expect(charged(recording)).toEqual(cardCharges)
      expect(refunds(recording)).toEqual(cardRefunds)
      expect(creditBack(recording)).toEqual(credit)
      expect(booking(recording)).toMatchObject({ status: 'cancelled' })
    })

    it('a reader move cancelled puts it all back, and the difference is still £40', async () => {
      const recording = await run('q28-private-reader-cancelled-puts-it-all-back')
      expect(fromEnd(recording, 1)).toMatchObject({ moved: false, priceImpact: { amountDue: 40 } })
      expect(booking(recording)).toMatchObject({ session_id: ID.privateSession, price_paid: '70.00', part_refunded_amount: '30.00' })
    })

    it('a promo booking still cannot be moved', async () => {
      const recording = await run('q28-promo-booking-still-cannot-move')
      expect(fromEnd(recording, 1)).toMatchObject({ moved: false, reason: 'promo_discounted_booking' })
    })

    it('a credit released on the move is paid in full, and the part refund stays off price_paid', async () => {
      const recording = await run('q28-public-credit-released-after-a-part-refund')
      const quote = recording.results[2] as { priceImpact: { amountDue: number; seatDeltas: Array<{ delta: number }> } }
      const { amountDue, seatDeltas } = quote.priceImpact
      expect(amountDue).toBeCloseTo(seatDeltas.reduce((sum, seat) => sum + seat.delta, 0), 2)
      expect(recording.results[3]).toMatchObject({ moved: true, booking: { price_paid: 15 + amountDue } })
      expect(total(refunds(recording))).toBe(total(charged(recording)))
    })

    it('a same-price move stays £0 after a Remove Guest that stopped at what was left', async () => {
      const recording = await run('q28-public-same-price-after-a-capped-remove-guest')
      const quote = recording.results.find((result) => (result as { priceImpact?: { seatDeltas?: unknown } }).priceImpact?.seatDeltas)
      expect(quote).toMatchObject({ moved: false, priceImpact: { amountDue: 0 } })
      expect(total(refunds(recording))).toBe(total(charged(recording)))
    })
  })

  describe('Remove Guest stops at what is left', () => {
    it.each<[string, number, number[], string[], string, number]>([
      ['remove-guest-more-left-than-the-seat', 20, [2000, 1000, 2000], [], '10.00', 2],
      ['remove-guest-capped-to-store-credit', 10, [2000, 3000], ['10.00'], '0.00', 2],
      ['remove-guest-nothing-left', 0, [2000, 4000], [], '0.00', 2],
    ])('%s', async (name, quoted, cardRefunds, credit, pricePaid, partySize) => {
      const recording = await run(name)
      expect(fromEnd(recording, 2)).toMatchObject({ removed: false, quote: { refundAmount: quoted, refundable: true } })
      expect(fromEnd(recording, 1)).toMatchObject({ removed: true, refundedAmount: quoted })
      expect(refunds(recording)).toEqual(cardRefunds)
      expect(creditBack(recording)).toEqual(credit)
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: pricePaid, party_size: partySize })
    })

    it('Cancel & Refund after it has nothing left to give', async () => {
      const recording = await run('remove-guest-capped-then-cancel')
      expect(fromEnd(recording, 3)).toMatchObject({ removed: false, quote: { refundAmount: 15 } })
      expect(refunds(recording)).toEqual([2000, 2500, 1500])
      expect(fromEnd(recording, 1)).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0 })
      expect(booking(recording)).toMatchObject({ status: 'cancelled' })
    })
  })

  describe('a line that gave nothing back is not stamped', () => {
    // The first order's seat money goes back; the guest's order holds only the Towel.
    it.each<[string, string, string]>([
      ['addon-with-guest-same-tier-not-ticked', 'card', 'paid'],
      ['addon-with-guest-same-tier-ticked', 'card', 'refunded'],
      ['addon-with-guest-same-tier-to-store-credit-not-ticked', 'credit', 'paid'],
      ['addon-with-guest-same-tier-to-store-credit-ticked', 'credit', 'refunded'],
    ])('%s', async (name, method, guestOrderStatus) => {
      const recording = await run(name)
      const [seat, addonOnly] = bookingLines(recording)
      expect(seat).toMatchObject({ refunded_at: '<set>', refund_method: method })
      expect(addonOnly).toMatchObject({ refunded_at: null, refund_method: null })
      expect(orderStatuses(recording)).toEqual(['refunded', guestOrderStatus])
    })

    it('a booking made free by a code stays paid, and the guest who paid is refunded', async () => {
      const recording = await run('q25-higher-tier-free-booking-then-refund')
      const [free, guest] = bookingLines(recording)
      expect(free).toMatchObject({ refunded_at: null, refund_method: null })
      expect(guest).toMatchObject({ refunded_at: '<set>', refund_method: 'card' })
      expect(orderStatuses(recording)).toEqual(['paid', 'refunded'])
    })

    it('a line whose seat money went back is still stamped, the add-on on it left alone', async () => {
      const recording = await run('addon-with-guest-private-card-not-ticked')
      expect(bookingLines(recording).map((line) => line['refund_method'])).toEqual(['card', 'card'])
    })
  })

  /** Allowed to break a check below, each for a reason nothing here can fix. */
  const STRIPE_REFUNDS_NOT_ON_ROWS: Record<string, string> = {
    'q3-reader-buy-new-pass-with-a-membership': 'W05a Q3 on the reader: £90 taken and refunded by the rollback of an order that never existed. Tracked for go-live',
    'unsure-part-refund-card-arrived': 'It already arrived moves no money and records nothing on the line, so a refund that really left Stripe is on no row. It is capped by price_paid, so nothing can go twice',
  }
  const CANCELLED_WITHOUT_ALL_THE_MONEY: Record<string, string> = {
    'price-paid-cleared-nothing-back-then-cancel': 'price_paid is forced to £0 by the scenario, so a cancel has nothing to give',
    'price-paid-cleared-half-back-then-cancel': 'the same',
    'price-paid-cleared-addon-credit-is-not-seat-money': 'the same',
    'credit-booking-price-paid-cleared-then-cancelled': 'the same',
    'unsure-part-refund-card-arrived': 'It already arrived: the £40 reached the customer and is on no row',
  }
  const FIRST_INVOICE = "a membership's first invoice belongs to its subscription, so no order names that PaymentIntent (Q21)"
  const CHARGES_NOT_ON_ONE_ORDER: Record<string, string> = {
    'event-at-member-price-with-a-new-membership': FIRST_INVOICE,
    'buy-new-membership-covers-the-seat': FIRST_INVOICE,
    'buy-new-membership-on-peak-pays-the-seat': FIRST_INVOICE,
    'q3-buy-new-membership-with-a-pass': FIRST_INVOICE,
    'q3-reader-buy-new-pass-with-a-membership': 'W05a Q3 on the reader: the order rolled back, so the £90 has none. Tracked for go-live',
    'q5-buy-new-keeps-address-and-requests': FIRST_INVOICE,
    'q6-promo-on-buy-new-seats': FIRST_INVOICE,
    // W11: the reader took £44 for a £45 order, so finalise refuses it (amount_mismatch) and the order is
    // left pending for a person, as finaliseReaderOrder did (W03-plan 2.5, "amounts don't match").
    'w11-reader-amount-mismatch-a-pound-short': 'W03-plan 2.5: a payment that does not match its order is left for a person, not finalised',
  }

  // Seat money only: add-ons have their own lines and their own refunds.
  it('in every scenario, no booking gets back more than was paid, price_paid is paid less given back, and what is owed is never negative or more than that', async () => {
    const wrong: string[] = []
    /** Each exception must still be needed, so a stale one can't hide a new problem. */
    const needed = new Set<string>()
    const allowed = (list: Record<string, string>, name: string) => {
      if (!(name in list)) return false
      needed.add(`${Object.keys(list)[0]}/${name}`)
      return true
    }
    let bookingsChecked = 0
    for (const scenario of scenarios) {
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
            const answer = result as { moved?: boolean; settled?: boolean; message?: string }
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
            bookingsChecked += 1
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
            if (row.status === 'cancelled' && Math.abs(paid - back) > 0.005 && !allowed(CANCELLED_WITHOUT_ALL_THE_MONEY, scenario.name)) {
              wrong.push(`${scenario.name}: cancelled with £${back.toFixed(2)} back on £${paid.toFixed(2)} paid`)
            }
          }

          // What really left Stripe, however many calls asked for it, against what the rows say.
          const [recorded] = await context.db.query<{ card: string }>(
            `SELECT (SELECT COALESCE(SUM(card_refunded_amount), 0) FROM order_line_items)
                    + (SELECT COALESCE(SUM(card_refunded_amount), 0) FROM addon_order_lines) AS card`
          )
          const stripeBack = context.stripe.refundedPence / 100
          if (Math.abs(stripeBack - Number.parseFloat(recorded?.card ?? '0')) > 0.005 && !allowed(STRIPE_REFUNDS_NOT_ON_ROWS, scenario.name)) {
            wrong.push(`${scenario.name}: Stripe refunded £${stripeBack.toFixed(2)}, the rows say £${recorded?.card}`)
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
            if (orders.length !== 1 && !allowed(CHARGES_NOT_ON_ONE_ORDER, scenario.name)) wrong.push(`${scenario.name}: ${intent} is on ${orders.length} orders`)
          }
        },
      }
      await replay(environment, watched, oldSide)
    }
    expect(wrong).toEqual([])
    const stale = [STRIPE_REFUNDS_NOT_ON_ROWS, CANCELLED_WITHOUT_ALL_THE_MONEY, CHARGES_NOT_ON_ONE_ORDER].flatMap((list) =>
      Object.keys(list).filter((name) => !needed.has(`${Object.keys(list)[0]}/${name}`))
    )
    expect(stale).toEqual([])
    expect(bookingsChecked).toBeGreaterThan(100)
    // W11 added 45 reader scenarios to this sweep (see w05c.test.ts's).
  }, 300_000)
})
