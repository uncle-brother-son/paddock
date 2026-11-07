import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Recording } from './compare'
import { oldSide, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { scenarios } from './scenarios'

// What the W05c scenarios prove the old functions now do, in pence. Each one's rows are also held to
// its golden file in replay.test.ts. Q27: a £100 booking, 10% off, so £90 paid, a £30 part refund and
// a next tier of £150, unless the scenario says otherwise. Add-ons: the Towel is £5.

const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
const pence = (recording: Recording, method: string) =>
  recording.stripeCalls.filter((call) => call.method === method).map((call) => (call.params as { amount: number }).amount)
const charged = (recording: Recording) => pence(recording, 'paymentIntents.create')
const refunds = (recording: Recording) => pence(recording, 'refunds.create')
const creditBack = (recording: Recording) =>
  added(recording, 'store_credit_transactions')
    .filter((row) => row['reason'] === 'refund')
    .map((row) => row['amount'])
const booking = (recording: Recording) => added(recording, 'bookings')[0]

describe('W05c on the old functions', () => {
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

  describe('Q27: a part refund is not asked for again, and Cancel & Refund gives back what is left', () => {
    it.each<[string, number[], number[], string[]]>([
      ['q27-part-to-card-same-tier-then-to-the-card', [9000], [3000, 6000], []],
      ['q27-part-to-card-same-tier-then-to-store-credit', [9000], [3000], ['60.00']],
      ['q27-part-to-credit-same-tier-then-to-the-card', [9000], [6000], ['30.00']],
      ['q27-part-to-credit-higher-tier-on-the-card-then-to-the-card', [9000, 5000], [5000, 6000], ['30.00']],
      ['q27-part-to-credit-higher-tier-on-the-card-then-to-store-credit', [9000, 5000], [], ['30.00', '110.00']],
      ['q27-part-to-credit-higher-tier-on-the-reader-then-to-the-card', [9000, 5000], [5000, 6000], ['30.00']],
      ['q27-part-to-credit-higher-tier-on-the-reader-then-to-store-credit', [9000, 5000], [], ['30.00', '110.00']],
      ['q27-part-to-card-higher-tier-on-the-card-then-to-the-card', [9000, 5000], [3000, 5000, 6000], []],
      ['q27-part-to-card-higher-tier-on-the-reader-then-to-the-card', [9000, 5000], [3000, 5000, 6000], []],
      ['q27-part-to-card-higher-tier-in-cash-then-to-the-card', [9000], [3000, 6000], ['50.00']],
      ['q27-no-promo-part-to-card-same-tier-then-to-the-card', [10000], [3000, 7000], []],
      ['q27-no-promo-part-to-credit-higher-tier-then-to-the-card', [10000, 5000], [5000, 7000], ['30.00']],
      ['q27-cash-booking-part-refund-same-tier-then-refund', [], [], ['30.00', '60.00']],
      ['q27-part-refund-split-card-and-credit-counted-once', [6000], [6000], ['10.00', '20.00']],
      ['q27-two-part-refunds-then-a-higher-tier', [9000, 5000], [2000, 5000, 6000], ['10.00']],
      ['q27-whole-booking-part-refunded-then-same-tier', [9000], [9000], []],
      ['q27-guests-through-the-tiers-after-a-part-refund', [9000, 5000], [3000, 5000, 6000], ['50.00']],
      ['q27-public-booking-part-refund-is-unchanged', [4000, 2000], [1000, 2000, 3000], []],
    ])('%s', async (name, cardCharges, cardRefunds, credit) => {
      const recording = await run(name)
      expect(charged(recording)).toEqual(cardCharges)
      expect(refunds(recording)).toEqual(cardRefunds)
      expect(creditBack(recording)).toEqual(credit)
      expect(booking(recording)).toMatchObject({ status: 'cancelled' })
    })

    it('the same tier needs no payment and writes no new order', async () => {
      const recording = await run('q27-part-to-card-same-tier-then-to-the-card')
      expect(recording.results[2]).toMatchObject({ added: true })
      expect(added(recording, 'orders')).toHaveLength(1)
      expect(booking(recording)).toMatchObject({ price_paid: '60.00', party_size: 3 })
    })

    it('a higher tier charges the tier difference only, and price_paid grows by it', async () => {
      const recording = await run('q27-part-to-credit-higher-tier-on-the-card-then-to-the-card')
      expect(recording.results[2]).toMatchObject({ added: false, priceImpact: { amountDue: 50, guestAmount: 50 } })
      expect(booking(recording)).toMatchObject({ price_paid: '110.00', party_size: 3 })
    })

    it('a cancelled reader payment puts it all back, and the difference is still £50', async () => {
      const recording = await run('q27-reader-cancelled-after-a-part-refund')
      expect(recording.results[recording.results.length - 1]).toMatchObject({ added: false, priceImpact: { amountDue: 50 } })
      expect(booking(recording)).toMatchObject({ price_paid: '60.00', party_size: 2 })
    })
  })

  describe('Q27: what is recorded like a part refund but is not one', () => {
    it('a cheaper move on the card: the guest pays the full difference from the new price', async () => {
      const recording = await run('q27-cheaper-move-is-not-a-part-refund')
      expect(recording.results[3]).toMatchObject({ added: false, priceImpact: { amountDue: 50 } })
      expect(charged(recording)).toEqual([14000, 5000])
      expect(refunds(recording)).toEqual([4000, 5000, 10000])
      expect(creditBack(recording)).toEqual([])
    })

    it('a cheaper move to store credit: the same', async () => {
      const recording = await run('q27-cheaper-move-to-store-credit-is-not-a-part-refund')
      expect(recording.results[3]).toMatchObject({ added: false, priceImpact: { amountDue: 50 } })
      expect(refunds(recording)).toEqual([5000, 10000])
      expect(creditBack(recording)).toEqual(['40.00'])
    })

    it('a part refund after a cheaper move still counts, and the move refund still does not', async () => {
      const recording = await run('q27-part-refund-after-a-cheaper-move-still-counts')
      expect(recording.results[4]).toMatchObject({ added: true })
      expect(charged(recording)).toEqual([14000])
      expect(refunds(recording)).toEqual([4000, 3000, 7000])
    })

    // W05d: the move no longer collects the £30 (Q28), so it stays counted and the guest pays £50.
    it('a part refund before a same-price move is not collected, and still counts for a guest', async () => {
      const recording = await run('q27-part-refund-before-a-same-price-move-still-counts')
      expect(recording.results[2]).toMatchObject({ moved: false, priceImpact: { amountDue: 0 } })
      expect(recording.results[3]).toMatchObject({ moved: true })
      expect(recording.results[4]).toMatchObject({ added: false, priceImpact: { amountDue: 50 } })
      expect(charged(recording)).toEqual([10000, 5000])
      expect(refunds(recording)).toEqual([3000, 5000, 7000])
    })

    it("an add-on's store credit refund carries the booking but is not seat money", async () => {
      const recording = await run('q27-addon-refund-is-not-a-part-refund')
      expect(recording.results[recording.results.length - 2]).toMatchObject({ added: false, priceImpact: { amountDue: 20 } })
      expect(recording.results[recording.results.length - 1]).toMatchObject({ added: true })
      expect(booking(recording)).toMatchObject({ price_paid: '120.00' })
    })

    it('a charge reversed because its own action failed gave nothing back', async () => {
      const recording = await run('q27-a-reversed-charge-is-not-a-part-refund')
      expect(recording.results[1]).toMatchObject({ added: false, reason: 'guest_add_failed' })
      expect(refunds(recording)).toEqual([3000])
      expect(recording.results[2]).toMatchObject({ added: false, priceImpact: { amountDue: 50 } })
    })
  })

  // W05c's two side effects and the tier rise. part_refunded_amount replaced the limit in W05d.
  describe('Q27 exactly: tier price less price_paid, promo share and part_refunded_amount', () => {
    it('a guest removed, the difference refunded, then a guest added back: £0', async () => {
      const recording = await run('q27-guest-removed-then-a-part-refund-then-a-guest')
      expect(recording.results[recording.results.length - 1]).toMatchObject({ added: true })
      expect(charged(recording)).toEqual([10000, 5000])
      expect(booking(recording)).toMatchObject({ price_paid: '100.00', part_refunded_amount: '50.00', party_size: 3 })
    })

    it('a tier price cut, then a part refund: the guest pays £50, the tier difference', async () => {
      const recording = await run('q27-tier-price-fell-then-a-part-refund-then-a-guest')
      expect(recording.results[recording.results.length - 1]).toMatchObject({ added: false, priceImpact: { amountDue: 50 } })
    })

    it("a tier price rise after a cheaper move: the move's refund doesn't count, so the guest pays £70", async () => {
      const recording = await run('q27-tier-rise-after-a-cheaper-move')
      expect(recording.results[3]).toMatchObject({ added: false, priceImpact: { amountDue: 70 } })
      expect(charged(recording)).toEqual([14000, 7000])
      expect(booking(recording)).toMatchObject({ part_refunded_amount: '0.00' })
    })
  })

  describe('an add-on paid with a guest goes back to the card it was paid on', () => {
    it.each<[string, number[], string[]]>([
      ['addon-with-guest-private-card-not-ticked', [5000, 9000], []],
      ['addon-with-guest-private-reader-ticked', [5000, 9000, 500], []],
      ['addon-with-guest-private-reader-not-ticked', [5000, 9000], []],
      // £10 store credit and £45 on the card.
      ['addon-with-guest-private-split-card-ticked', [4000, 9000, 500], ['10.00']],
      ['addon-with-guest-private-split-card-not-ticked', [4000, 9000], ['10.00']],
      // £20 gift card and a £35 tap.
      ['addon-with-guest-private-split-reader-ticked', [3000, 9000, 500], ['20.00']],
      ['addon-with-guest-private-split-reader-not-ticked', [3000, 9000], ['20.00']],
      // Only true cash goes to store credit.
      ['addon-with-guest-private-cash-ticked', [9000], ['50.00', '5.00']],
      ['addon-with-guest-private-to-store-credit-ticked', [], ['140.00', '5.00']],
      ['addon-with-guest-same-tier-ticked', [9000, 500], []],
      ['addon-with-guest-same-tier-not-ticked', [9000], []],
      ['addon-with-no-guest-on-the-card-ticked', [9000, 500], []],
      ['addon-with-guest-public-card-ticked', [2000, 4000, 500], []],
      ['addon-with-guest-public-card-not-ticked', [2000, 4000], []],
      ['addon-with-guest-public-reader-ticked', [2000, 4000, 500], []],
      ['addon-with-guest-public-reader-not-ticked', [2000, 4000], []],
      // £10 store credit and £15 on the card.
      ['addon-with-guest-public-split-card-ticked', [1000, 4000, 500], ['10.00']],
      ['addon-with-guest-public-split-card-not-ticked', [1000, 4000], ['10.00']],
      // £10 gift card and a £15 tap.
      ['addon-with-guest-public-split-reader-ticked', [1000, 4000, 500], ['10.00']],
      ['addon-with-guest-public-split-reader-not-ticked', [1000, 4000], ['10.00']],
      ['addon-with-guest-public-cash-ticked', [4000], ['20.00', '5.00']],
    ])('%s', async (name, cardRefunds, credit) => {
      const recording = await run(name)
      expect(refunds(recording)).toEqual(cardRefunds)
      expect(creditBack(recording)).toEqual(credit)
    })

    it.each<[string, number[]]>([
      ['addon-on-the-first-order-public-ticked', [4000, 500]],
      ['addon-on-the-first-order-public-not-ticked', [4000]],
      ['addon-on-the-first-order-private-ticked', [9000, 500]],
      ['addon-on-the-first-order-private-not-ticked', [9000]],
    ])('%s: the booking line is the seat alone, so nothing comes off it', async (name, cardRefunds) => {
      const recording = await run(name)
      expect(refunds(recording)).toEqual(cardRefunds)
      expect(creditBack(recording)).toEqual([])
    })

    it.each<[string, number[], string[]]>([
      ['addon-with-guest-then-remove-guest-then-cancel', [2000, 4000, 500], []],
      ['addon-with-guest-removed-to-the-card-then-cancel', [500, 5000, 9000], []],
      ['addon-with-guest-removed-to-store-credit-then-cancel', [5000, 9000], ['5.00']],
      // A £60 part refund takes the guest's £50, not the add-on's £5, then £10 from the first order.
      ['addon-with-guest-part-refund-then-cancel', [5000, 1000, 8000, 500], []],
      // £40 of the guest's £50 goes back on the move, and the other £10 on the cancel.
      ['addon-with-guest-cheaper-move-then-cancel', [4000, 1000, 14000, 500], []],
    ])('%s: the other refunds that read the same figure', async (name, cardRefunds, credit) => {
      const recording = await run(name)
      expect(refunds(recording)).toEqual(cardRefunds)
      expect(creditBack(recording)).toEqual(credit)
    })

    it("an add-on on a membership credit was never paid for, so the guest's card money all goes back", async () => {
      const recording = await run('credit-addon-with-guest-on-the-card')
      expect(refunds(recording).reduce((sum, amount) => sum + amount, 0)).toBe(charged(recording).reduce((sum, amount) => sum + amount, 0))
      expect(creditBack(recording)).toEqual([])
      expect(recording.results[recording.results.length - 1]).toMatchObject({ addons: { creditsReturned: 1 } })
    })
  })

  describe('a public booking never gives back more than was paid after a part refund', () => {
    it('a same-price move leaves the part refund off price_paid: £40 back on £40 paid', async () => {
      const recording = await run('q28-public-same-price-part-to-the-card')
      expect(charged(recording)).toEqual([4000])
      expect(refunds(recording)).toEqual([1000, 3000])
      expect(creditBack(recording)).toEqual([])
    })

    it('Remove Guest stops at what is left: the old £20 is refused, and £60 back on £60 paid', async () => {
      const recording = await run('remove-guest-capped-an-old-quote-refused')
      expect(recording.results[recording.results.length - 3]).toMatchObject({ removed: false, quote: { refundAmount: 10 } })
      expect(recording.results[recording.results.length - 2]).toMatchObject({ removed: false, reason: 'refund_amount_mismatch', quote: { refundAmount: 10 } })
      expect(recording.results[recording.results.length - 1]).toMatchObject({ removed: true, refundedAmount: 10 })
      expect(charged(recording)).toEqual([4000, 2000])
      expect(refunds(recording)).toEqual([2000, 3000, 1000])
      expect(creditBack(recording)).toEqual([])
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '0.00', part_refunded_amount: '50.00', party_size: 2 })
    })
  })

  // The rows a charge has already written need no repair, because this is worked out at refund time.
  // This holds the test for "the add-on is inside the line" to every order any scenario writes.
  it('only a guest payment on a card or the reader ever counts as having add-ons inside its line', async () => {
    const inside: string[] = []
    for (const scenario of scenarios) {
      const watched: Scenario = {
        ...scenario,
        async run(context) {
          await scenario.run(context)
          const rows = await context.db.query<{ lines: number; on_booking_line: boolean; has_intent: boolean }>(
            `SELECT count(oli.id)::int AS lines, bool_and(oli.item_type = 'booking' AND oli.line_total = o.order_total) AS on_booking_line,
                    o.stripe_payment_intent_id IS NOT NULL AS has_intent
             FROM orders o
             JOIN order_line_items oli ON oli.order_id = o.id
             GROUP BY o.id
             HAVING sum(oli.line_total) + COALESCE((SELECT sum(aol.price_at_purchase * aol.quantity) FROM addon_order_lines aol
                                                    WHERE aol.order_id = o.id AND aol.redemption_source IS DISTINCT FROM 'membership_credit'), 0)
                    > o.order_total`
          )
          for (const row of rows) {
            if (row.lines !== 1 || !row.on_booking_line || !row.has_intent) inside.push(scenario.name)
          }
        },
      }
      await replay(environment, watched, oldSide)
    }
    expect(inside).toEqual([])
  }, 120_000)
})
