import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insert } from '../database'
import type { Recording } from './compare'
import { oldSide, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { ID, PROMO, scenarios, seed } from './scenarios'

// What the Q25 scenarios prove the old addBookingGuest now does, in pounds and pence. Each one's rows
// are also held to its golden file in replay.test.ts. The booking is £100 with 10% off, so £90 paid,
// and the next tier is £150 unless the scenario says otherwise.

const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
const pence = (recording: Recording, method: string) =>
  recording.stripeCalls.filter((call) => call.method === method).map((call) => (call.params as { amount: number }).amount)
const charged = (recording: Recording) => pence(recording, 'paymentIntents.create')
const refunds = (recording: Recording) => pence(recording, 'refunds.create')
const storeCredit = (recording: Recording) => added(recording, 'store_credit_transactions').map((row) => [row['reason'], row['amount']])
const booking = (recording: Recording) => added(recording, 'bookings')[0]
const lines = (recording: Recording) => added(recording, 'order_line_items').map((line) => [line['line_total'], line['discount_amount']])
const orders = (recording: Recording) => added(recording, 'orders').map((order) => [order['order_total'], order['payment_status']])
const totalOf = (amounts: number[]) => amounts.reduce((sum, amount) => sum + amount, 0)

describe('Q25 on the old functions', () => {
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

  describe('the same tier costs nothing and keeps the promo', () => {
    it.each([
      ['q25-same-tier-then-refund-to-the-card', '90.00'],
      ['q25-same-tier-then-refund-to-store-credit', '90.00'],
      ['q25-same-tier-cash-booking-then-refund', '90.00'],
      ['q25-same-tier-fixed-promo-then-refund', '95.00'],
      ['q25-same-tier-free-booking-then-cancel', '0.00'],
    ])('%s: the guest goes straight on, with no payment and no new order', async (name, paid) => {
      const recording = await run(name)
      expect(recording.results[1]).toMatchObject({ added: true })
      expect(added(recording, 'orders')).toHaveLength(1)
      expect(added(recording, 'order_line_items')).toHaveLength(1)
      expect(added(recording, 'promo_code_redemptions')).toHaveLength(1)
      expect(booking(recording)).toMatchObject({ price_paid: paid, party_size: 3 })
    })

    it('Cancel & Refund to the card gives back the £90 paid', async () => {
      const recording = await run('q25-same-tier-then-refund-to-the-card')
      expect(refunds(recording)).toEqual([9000])
      expect(storeCredit(recording)).toEqual([])
    })

    it('Cancel & Refund to store credit gives back the £90 paid', async () => {
      expect(storeCredit(await run('q25-same-tier-then-refund-to-store-credit'))).toEqual([['refund', '90.00']])
    })

    it('a free booking stays free and gives nothing back', async () => {
      const recording = await run('q25-same-tier-free-booking-then-cancel')
      expect(recording.stripeCalls).toEqual([])
      expect(recording.results[2]).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0 })
    })

    it('with an add-on, only the add-on is due', async () => {
      const recording = await run('q25-same-tier-guest-and-addon-on-the-card')
      expect(recording.results[1]).toMatchObject({ priceImpact: { amountDue: 5, guestAmount: 0, addonsAmount: 5 } })
      expect(booking(recording)).toMatchObject({ price_paid: '90.00' })
    })

    // Read inside the run: a recording tidies money to the penny, which would hide the fraction.
    it('leaves no stray fraction of a penny on the seat', async () => {
      const pennies = scenarios.find((s) => s.name === 'q25-same-tier-leaves-no-stray-pennies') as Scenario
      const answers: unknown[] = []
      const watched: Scenario = {
        ...pennies,
        run: (context) => pennies.run({ ...context, call: async (action, params) => {
          const answer = await context.call(action, params)
          answers.push(answer)
          return answer
        } }),
      }
      const recording = await replay(environment, watched, oldSide)
      expect(booking(recording)).toMatchObject({ price_paid: '9.27' })
      expect(answers[1]).toMatchObject({ priceImpact: { amountDue: 5, addonsAmount: 5 } })
      expect((answers[1] as { priceImpact: { guestAmount: number } }).priceImpact.guestAmount).toBe(0)
    })
  })

  describe('a higher tier charges the tier difference only', () => {
    const paidTheDifference = (recording: Recording) => {
      expect(recording.results[1]).toMatchObject({ added: false, priceImpact: { amountDue: 50, guestAmount: 50, addonsAmount: 0 } })
      expect(booking(recording)).toMatchObject({ price_paid: '140.00', party_size: 3, status: 'cancelled' })
    }

    it('in cash: its own £50 order, which comes back as store credit', async () => {
      const recording = await run('q25-higher-tier-in-cash-then-refund')
      paidTheDifference(recording)
      expect(lines(recording)).toEqual([
        ['100.00', '10.00'],
        ['50.00', '0.00'],
      ])
      expect(refunds(recording)).toEqual([9000])
      expect(storeCredit(recording)).toEqual([['refund', '50.00']])
      expect(orders(recording)).toEqual([
        ['100.00', 'refunded'],
        ['50.00', 'refunded'],
      ])
    })

    it('all in cash: £140 of store credit', async () => {
      const recording = await run('q25-higher-tier-all-cash-then-refund')
      paidTheDifference(recording)
      expect(storeCredit(recording)).toEqual([['refund', '140.00']])
    })

    it('on the card: £50 charged, then each charge refunded in full', async () => {
      const recording = await run('q25-higher-tier-on-the-card-then-refund')
      paidTheDifference(recording)
      expect(charged(recording)).toEqual([9000, 5000])
      expect(refunds(recording)).toEqual([5000, 9000])
      expect(storeCredit(recording)).toEqual([])
      expect(lines(recording)).toEqual([
        ['100.00', '10.00'],
        ['50.00', '0.00'],
      ])
    })

    it('on the card, refunded to store credit', async () => {
      const recording = await run('q25-higher-tier-on-the-card-to-store-credit')
      paidTheDifference(recording)
      expect(refunds(recording)).toEqual([])
      expect(storeCredit(recording)).toEqual([['refund', '140.00']])
    })

    it('on the reader: the tap is for £50, and it finalises', async () => {
      const recording = await run('q25-higher-tier-on-the-reader-then-refund')
      paidTheDifference(recording)
      expect(recording.results[2]).toMatchObject({ pendingReaderPayment: { amount: 50 } })
      expect(recording.results[3]).toMatchObject({ finalised: true })
      expect(added(recording, 'pending_reader_payments')).toMatchObject([{ status: 'finalised', expected_amount: '50.00' }])
      expect(charged(recording)).toEqual([9000, 5000])
      expect(refunds(recording)).toEqual([5000, 9000])
    })

    it('on the reader, refunded to store credit', async () => {
      const recording = await run('q25-higher-tier-on-the-reader-to-store-credit')
      paidTheDifference(recording)
      expect(refunds(recording)).toEqual([])
      expect(storeCredit(recording)).toEqual([['refund', '140.00']])
    })

    it('split on the card: the card gets its part back, the rest is store credit', async () => {
      const recording = await run('q25-higher-tier-split-on-the-card-then-refund')
      paidTheDifference(recording)
      expect(charged(recording)).toEqual([9000, 2000])
      expect(refunds(recording)).toEqual([2000, 9000])
      expect(storeCredit(recording)).toEqual([
        ['redemption', '-10.00'],
        ['refund', '30.00'],
      ])
    })

    it('split in cash', async () => {
      const recording = await run('q25-higher-tier-split-in-cash-then-refund')
      paidTheDifference(recording)
      expect(refunds(recording)).toEqual([9000])
      expect(storeCredit(recording)).toEqual([
        ['redemption', '-10.00'],
        ['refund', '50.00'],
      ])
    })

    it('split on the reader: the tap is for what the gift card leaves', async () => {
      const recording = await run('q25-higher-tier-split-on-the-reader-then-refund')
      paidTheDifference(recording)
      expect(charged(recording)).toEqual([9000, 3000])
      expect(refunds(recording)).toEqual([3000, 9000])
      expect(storeCredit(recording)).toEqual([['refund', '20.00']])
    })

    it('a free booking pays the tier difference, and gets that back', async () => {
      const recording = await run('q25-higher-tier-free-booking-then-refund')
      expect(charged(recording)).toEqual([5000])
      expect(refunds(recording)).toEqual([5000])
      expect(booking(recording)).toMatchObject({ price_paid: '50.00' })
    })

    it('the promo counts once, however many guests', async () => {
      const recording = await run('q25-guests-up-through-the-tiers-then-refund')
      expect(recording.results[2]).toMatchObject({ added: true })
      expect(booking(recording)).toMatchObject({ price_paid: '190.00', party_size: 5 })
      expect(charged(recording)).toEqual([9000, 5000])
      expect(refunds(recording)).toEqual([5000, 9000])
      expect(storeCredit(recording)).toEqual([['refund', '50.00']])
    })

    it('a removed guest leaves the higher tier paid for, so another costs nothing', async () => {
      const recording = await run('q25-guest-removed-then-another-added')
      expect(recording.results[3]).toMatchObject({ added: true })
      expect(charged(recording)).toEqual([9000, 5000])
      expect(refunds(recording)).toEqual([5000, 9000])
    })

    it('with an add-on, the booking refund stops at what the booking cost', async () => {
      const recording = await run('q25-higher-tier-guest-and-addon-on-the-card')
      expect(recording.results[1]).toMatchObject({ priceImpact: { amountDue: 55, guestAmount: 50, addonsAmount: 5 } })
      expect(booking(recording)).toMatchObject({ price_paid: '140.00' })
      expect(totalOf(refunds(recording))).toBe(14000)
    })
  })

  describe('every refund comes to what was paid', () => {
    it.each([
      ['q25-same-tier-then-refund-to-the-card', 9000],
      ['q25-higher-tier-on-the-card-then-refund', 14000],
      ['q25-higher-tier-on-the-reader-then-refund', 14000],
      ['q25-higher-tier-in-cash-then-refund', 14000],
      ['q25-higher-tier-split-on-the-card-then-refund', 14000],
      ['q25-higher-tier-split-on-the-reader-then-refund', 14000],
      ['q25-higher-tier-split-in-cash-then-refund', 14000],
      ['q25-guests-up-through-the-tiers-then-refund', 19000],
    ])('%s', async (name, paid) => {
      const recording = await run(name)
      const creditBack = added(recording, 'store_credit_transactions')
        .filter((row) => row['reason'] === 'refund')
        .map((row) => Math.round(Number(row['amount']) * 100))
      expect(totalOf(refunds(recording)) + totalOf(creditBack)).toBe(paid)
    })

    // An add-on paid with a guest sits on the guest's booking line as well as its own (W05c).
    it.each([
      ['q25-guest-and-addon-both-refunded-to-the-card', [5000, 9000, 500]],
      ['q25-no-promo-guest-and-addon-both-refunded-to-the-card', [5000, 10000, 500]],
    ])('%s: each part goes back to its own card', async (name, cards) => {
      const recording = await run(name)
      expect(refunds(recording)).toEqual(cards)
      expect(storeCredit(recording)).toEqual([])
    })
  })

  describe('nothing is kept when it does not go through', () => {
    it('a cash figure from the old sum is refused with the real one', async () => {
      const recording = await run('q25-refused-a-cash-figure-from-the-old-sum')
      expect(recording.results[2]).toMatchObject({ added: false, reason: 'cash_amount_changed', priceImpact: { amountDue: 50 } })
      expect((recording.results[2] as { message: string }).message).toContain('£50.00')
      expect(booking(recording)).toMatchObject({ price_paid: '90.00', party_size: 2 })
      expect(added(recording, 'orders')).toHaveLength(1)
    })

    it('cash for the £10 the old sum asked for, when nothing is due, is refused', async () => {
      const recording = await run('q25-refused-cash-when-nothing-is-due')
      expect(recording.results[1]).toMatchObject({ added: false, reason: 'cash_amount_changed', priceImpact: { amountDue: 0 } })
      expect(booking(recording)).toMatchObject({ price_paid: '90.00', party_size: 2 })
      expect(added(recording, 'booking_guests')).toHaveLength(2)
    })

    it('a declined card puts the store credit back and adds nobody', async () => {
      const recording = await run('q25-card-declined-rolls-back')
      expect(recording.results[1]).toMatchObject({ added: false })
      expect(charged(recording)).toEqual([9000, 4000])
      expect(booking(recording)).toMatchObject({ price_paid: '90.00', party_size: 2 })
      expect(storeCredit(recording)).toEqual([
        ['redemption', '-10.00'],
        ['redemption_reversal', '10.00'],
      ])
    })

    it('a cancelled reader payment puts the booking back to what was paid', async () => {
      const recording = await run('q25-reader-cancelled-puts-it-all-back')
      expect(recording.results[2]).toMatchObject({ cancelled: true })
      expect(booking(recording)).toMatchObject({ price_paid: '90.00', party_size: 2 })
      expect(added(recording, 'booking_guests')).toHaveLength(2)
      expect(added(recording, 'orders')).toHaveLength(1)
      expect(storeCredit(recording)).toEqual([
        ['redemption', '-10.00'],
        ['redemption_reversal', '10.00'],
      ])
    })
  })

  describe('what stays as it was', () => {
    it('no promo, same tier: free', async () => {
      const recording = await run('q25-no-promo-same-tier-then-refund')
      expect(recording.results[1]).toMatchObject({ added: true })
      expect(refunds(recording)).toEqual([10000])
    })

    it('no promo, higher tier: the difference', async () => {
      const recording = await run('q25-no-promo-higher-tier-then-refund')
      expect(charged(recording)).toEqual([10000, 5000])
      expect(refunds(recording)).toEqual([5000, 10000])
    })

    it('a public booking with a promo: the new seat pays the full band price, on the card', async () => {
      const recording = await run('q25-public-promo-guest-on-the-card-then-refund')
      expect(recording.results[1]).toMatchObject({ priceImpact: { amountDue: 20, guestAmount: 20 } })
      expect(added(recording, 'booking_guests').map((guest) => guest['unit_price'])).toEqual(['18.00', '18.00', '20.00'])
      expect(booking(recording)).toMatchObject({ price_paid: '56.00' })
      expect(refunds(recording)).toEqual([2000, 3600])
    })

    it('a public booking with a promo: the same in cash', async () => {
      const recording = await run('q25-public-promo-guest-in-cash-then-refund')
      expect(booking(recording)).toMatchObject({ price_paid: '56.00' })
      expect(refunds(recording)).toEqual([3600])
      expect(storeCredit(recording)).toEqual([['refund', '20.00']])
    })

    it('a tier price that has fallen asks for nothing and gives nothing back', async () => {
      const recording = await run('q25-tier-price-fell-since-the-booking')
      expect(recording.results[1]).toMatchObject({ added: false, priceImpact: { amountDue: 5, guestAmount: 0, addonsAmount: 5 } })
      expect(recording.results[2]).toMatchObject({ added: true })
      expect(booking(recording)).toMatchObject({ price_paid: '90.00', party_size: 3 })
      expect(charged(recording)).toEqual([9000])
    })

    it('a part refund is not asked for back by the same tier (Q27)', async () => {
      const recording = await run('q25-part-refund-then-a-guest')
      expect(recording.results[2]).toMatchObject({ added: true })
      expect(booking(recording)).toMatchObject({ price_paid: '60.00', party_size: 3 })
    })

    const laterSession = '20000000-0000-4000-8000-000000000002'
    const moved: Scenario = {
      name: 'a-move-after-adding-a-guest',
      async seed(db, stripe) {
        await seed(db, stripe)
        await insert(db, 'sessions', {
          id: laterSession,
          service_type_id: ID.privateType,
          start_time: '2026-11-20 10:00:00+00',
          end_time: '2026-11-20 12:00:00+00',
          type: 'private',
          capacity: 10,
          band_id: ID.band,
        })
      },
      async run({ call }) {
        const guests = [
          { name: 'Sam Test', email: 'sam@example.com', dateOfBirth: '1990-01-01' },
          { name: 'Alex Guest', email: 'alex@example.com' },
        ]
        const order = (await call('createOrder', {
          customerId: ID.customer,
          booking: { sessionId: ID.privateSession, guests, redemptionSource: 'paid', guestsOver18Confirmed: true },
          promoCode: PROMO.percent,
          payment: { method: 'card' },
        })) as { bookingId: string }
        await call('addBookingGuest', { bookingId: order.bookingId, guestName: 'Bea Guest', guestsOver18Confirmed: true })
        await call('moveBooking', { bookingId: order.bookingId, newSessionId: laterSession })
      },
    }

    it('a move is still refused once a guest has been added', async () => {
      const recording = await replay(environment, moved, oldSide)
      expect(recording.results[2]).toMatchObject({ moved: false, reason: 'promo_discounted_booking' })
    })
  })
})
