import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insert } from '../database'
import type { Recording } from './compare'
import { oldSide, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { ID, PROMO, scenarios, seed } from './scenarios'

// What the W05a scenarios prove the old functions now do, in pounds and pence. Each scenario's rows
// are also held to its golden file and to the quote, in replay.test.ts and quote-shadow.test.ts.

const sam = { name: 'Sam Test', email: 'sam@example.com', dateOfBirth: '1990-01-01' }
const alex = { name: 'Alex Guest', email: 'alex@example.com' }
const privateBooking = { sessionId: ID.privateSession, guests: [sam, alex], redemptionSource: 'paid', guestsOver18Confirmed: true }

const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
const changed = (recording: Recording, table: string) => recording.tables[table]?.changed ?? []
const refunds = (recording: Recording) => recording.stripeCalls.filter((call) => call.method === 'refunds.create').map((call) => (call.params as { amount: number }).amount)
const charged = (recording: Recording) => recording.stripeCalls.filter((call) => call.method === 'paymentIntents.create').map((call) => (call.params as { amount: number }).amount)
const storeCredit = (recording: Recording) => added(recording, 'store_credit_transactions').map((row) => [row['reason'], row['amount']])

describe('W05a on the old functions', () => {
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
  const postageLine = (recording: Recording) => added(recording, 'order_line_items').find((line) => line['item_type'] === 'postage')

  describe('Q23: free postage is judged on the corrected price', () => {
    it('a high price sent without Manage pricing earns no free postage', async () => {
      const recording = await run('q23-a-sent-price-cannot-earn-free-postage')
      expect(postageLine(recording)).toMatchObject({ line_total: '4.95' })
      expect(charged(recording)).toEqual([2495])
    })

    it('a low price sent without Manage pricing loses no free postage', async () => {
      const recording = await run('q23-a-sent-price-cannot-lose-free-postage')
      expect(postageLine(recording)).toMatchObject({ line_total: '0.00' })
      expect(charged(recording)).toEqual([6000])
    })

    it('a price staff may set still counts', async () => {
      const recording = await run('q23-an-allowed-price-still-counts')
      expect(postageLine(recording)).toMatchObject({ line_total: '0.00' })
      expect(charged(recording)).toEqual([6000])
    })
  })

  describe('Q24: a promo on a private booking', () => {
    const written = (recording: Recording) => ({
      order: added(recording, 'orders')[0],
      line: added(recording, 'order_line_items').find((line) => line['item_type'] === 'booking'),
      booking: added(recording, 'bookings')[0],
    })

    it('a percentage: the list price on the line, the share beside it, and what was paid on the booking', async () => {
      const recording = await run('q24-percent-promo-on-a-private-booking')
      expect(written(recording)).toMatchObject({
        order: { order_total: '100.00', discount_amount: '10.00', promo_code: PROMO.percent, payment_method: 'cash' },
        line: { line_total: '100.00', discount_amount: '10.00' },
        booking: { price_paid: '90.00' },
      })
      expect(added(recording, 'promo_code_redemptions')).toMatchObject([{ discount_amount: '10.00' }])
    })

    it('seats keep no price, so nothing can refund a list price from them', async () => {
      const recording = await run('q24-percent-promo-on-a-private-booking')
      expect(added(recording, 'booking_guests').map((guest) => guest['unit_price'])).toEqual([null, null])
    })

    it('a fixed code', async () => {
      const recording = await run('q24-fixed-promo-on-a-private-booking')
      expect(written(recording)).toMatchObject({ line: { discount_amount: '5.00' }, booking: { price_paid: '95.00' } })
    })

    it('a fixed code bigger than the price stops at the price, and nothing is owed', async () => {
      const recording = await run('q24-fixed-promo-bigger-than-the-private-price')
      expect(written(recording)).toMatchObject({ order: { discount_amount: '100.00', payment_status: 'paid', payment_method: null }, booking: { price_paid: '0.00' } })
      expect(recording.stripeCalls).toEqual([])
    })

    it('spread over other items, to the penny', async () => {
      const recording = await run('q24-fixed-promo-on-private-and-other-items')
      const shares = added(recording, 'order_line_items').map((line) => [line['item_type'], line['discount_amount']])
      expect(shares).toEqual([
        ['booking', '3.87'],
        ['addon', '0.19'],
        ['product', '0.94'],
      ])
      expect(charged(recording)).toEqual([12400])
    })

    it('with a membership: the share comes off the first payment too', async () => {
      const recording = await run('q24-big-fixed-promo-on-private-and-a-membership')
      const { order, line, booking } = written(recording)
      const shares = added(recording, 'order_line_items').map((row) => Number(row['discount_amount']))
      expect(order).toMatchObject({ order_total: '164.00', discount_amount: '150.00' })
      expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(150, 2)
      expect(Number(booking?.['price_paid'])).toBeCloseTo(100 - Number(line?.['discount_amount']), 2)
    })

    it('an attached add-on stays at full price', async () => {
      const recording = await run('q24-attached-addon-stays-out-of-the-promo')
      expect(written(recording)).toMatchObject({ order: { order_total: '105.00', discount_amount: '10.00' }, booking: { price_paid: '90.00' } })
    })

    it('a member gets it, whatever the code says about member prices', async () => {
      const recording = await run('q24-the-member-prices-flag-does-not-apply')
      expect(written(recording)).toMatchObject({ booking: { price_paid: '90.00' } })
    })

    it('min spend counts the private price', async () => {
      expect(written(await run('q24-min-spend-counts-the-private-price'))).toMatchObject({ booking: { price_paid: '90.00' } })
    })

    it.each([
      ['q24-refused-below-min-spend', 'The eligible items do not reach this code’s minimum spend.'],
      ['q24-refused-a-code-not-for-bookings', 'Nothing in this basket is eligible for that promo code.'],
      ['q24-refused-an-expired-code', 'That promo code has expired.'],
    ])('%s: refused, and nothing is left behind', async (name, words) => {
      const recording = await run(name)
      expect(recording.results[0]).toMatchObject({ success: false, reason: 'promo_code_invalid' })
      expect((recording.results[0] as { message: string }).message).toContain(words)
      expect(recording.tables).toEqual({})
    })

    it('on the reader the tap is for what is owed', async () => {
      const recording = await run('q24-promo-on-the-reader')
      expect(charged(recording)).toEqual([9000])
      expect(recording.results[1]).toMatchObject({ finalised: true })
      expect(written(recording)).toMatchObject({ order: { payment_status: 'paid' }, booking: { price_paid: '90.00' } })
    })

    it('a declined card gives everything back', async () => {
      const recording = await run('q24-card-declined-rolls-back')
      expect(recording.results[0]).toMatchObject({ success: false, reason: 'charge_failed' })
      expect(recording.tables).toEqual({})
    })
  })

  describe('Q24: refunds give back what was paid, never the list price', () => {
    it('Cancel & Refund to the card', async () => {
      const recording = await run('q24-cancel-and-refund-to-the-card')
      expect(refunds(recording)).toEqual([9000])
      expect(storeCredit(recording)).toEqual([])
      expect(recording.results[1]).toMatchObject({ cardRefundedAmount: 90, storeCreditRefundedAmount: 0 })
    })

    it('Cancel & Refund to store credit', async () => {
      const recording = await run('q24-cancel-and-refund-to-store-credit')
      expect(refunds(recording)).toEqual([])
      expect(storeCredit(recording)).toEqual([['refund', '90.00']])
    })

    it('a cash booking, asked to go to a card: there is no card, so store credit', async () => {
      const recording = await run('q24-cash-booking-refunded-as-card')
      expect(refunds(recording)).toEqual([])
      expect(storeCredit(recording)).toEqual([['refund', '90.00']])
    })

    it('a cash booking to store credit', async () => {
      const recording = await run('q24-cash-booking-refunded-as-credit')
      expect(storeCredit(recording)).toEqual([['refund', '90.00']])
    })

    it('card, gift card and store credit: the card gets its part back, the rest is store credit', async () => {
      const recording = await run('q24-split-payment-refunded')
      expect(charged(recording)).toEqual([6000])
      expect(refunds(recording)).toEqual([6000])
      expect(storeCredit(recording)).toEqual([
        ['redemption', '-10.00'],
        ['refund', '30.00'],
      ])
    })

    it('a part refund, then the rest: the two add up to what was paid', async () => {
      const recording = await run('q24-part-refund-then-the-rest')
      expect(refunds(recording)).toEqual([3000, 6000])
    })

    it('a free booking cancels with nothing to give back', async () => {
      const recording = await run('q24-free-booking-cancelled')
      expect(recording.results[1]).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0 })
      expect(storeCredit(recording)).toEqual([])
      expect(added(recording, 'bookings')[0]).toMatchObject({ status: 'cancelled' })
    })

    it("the booking's refund leaves the other items' money on the card", async () => {
      const recording = await run('q24-other-items-keep-their-money')
      expect(charged(recording)).toEqual([11160])
      expect(refunds(recording)).toEqual([9000])
    })

    const placed: Scenario = {
      name: 'a-part-refund-over-what-was-paid',
      seed,
      async run({ call }) {
        const order = (await call('createOrder', {
          customerId: ID.customer,
          booking: privateBooking,
          promoCode: PROMO.percent,
          payment: { method: 'card' },
        })) as { bookingId: string }
        const answer = await call('refundBooking', { bookingId: order.bookingId, refundMethod: 'card', amount: 95, reason: 'Goodwill' })
        expect(answer).toMatchObject({ refused: { message: 'Only £90.00 is left on this booking. Check the amount and confirm again.' } })
      },
    }

    it('a part refund above what was paid is refused, even under the list price', async () => {
      const recording = await replay(environment, placed, oldSide)
      expect(refunds(recording)).toEqual([])
    })

    const laterSession = '20000000-0000-4000-8000-000000000001'
    const moved: Scenario = {
      name: 'a-move-of-a-promo-booking',
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
        const order = (await call('createOrder', {
          customerId: ID.customer,
          booking: privateBooking,
          promoCode: PROMO.percent,
          payment: { method: 'card' },
        })) as { bookingId: string }
        await call('moveBooking', { bookingId: order.bookingId, newSessionId: laterSession })
      },
    }

    it('a move is refused, as on any promo booking, so it can refund nothing', async () => {
      const recording = await replay(environment, moved, oldSide)
      expect(recording.results[1]).toMatchObject({ moved: false, reason: 'promo_discounted_booking' })
    })
  })

  describe('migration 018: a membership past its last day', () => {
    const seatOf = (recording: Recording) => added(recording, 'booking_guests')[0]

    it('the last day still gets the member price', async () => {
      expect(seatOf(await run('member-on-their-last-day-pays-the-member-price'))).toMatchObject({ unit_price: '21.68', pay_by: 'paid' })
    })

    it('the day after pays the list price', async () => {
      expect(seatOf(await run('member-past-their-last-day-pays-the-list-price'))).toMatchObject({ unit_price: '25.50', pay_by: 'paid' })
    })

    it('the last day can still use a credit', async () => {
      expect(seatOf(await run('member-on-their-last-day-can-use-a-credit'))).toMatchObject({ pay_by: 'membership_credit' })
    })

    it('the day after cannot', async () => {
      expect((await run('refused-a-credit-past-the-last-day')).results[0]).toMatchObject({ success: false, reason: 'membership_not_found' })
    })
  })

  describe('a standalone add-on on a credit', () => {
    it.each(['refused-standalone-addon-on-a-credit', 'refused-standalone-addon-on-a-credit-with-no-membership'])('%s', async (name) => {
      const recording = await run(name)
      expect(recording.results[0]).toMatchObject({ success: false, stage: 'validation', reason: 'standalone_addon_credit_not_allowed' })
      expect(recording.tables).toEqual({})
    })
  })

  describe('replacing an exhausted membership', () => {
    it('the new one is billed, then the old one is cancelled, last', async () => {
      const recording = await run('replace-an-exhausted-membership')
      expect(recording.results[0]).toMatchObject({ success: true })
      const methods = recording.stripeCalls.map((call) => call.method)
      expect(methods.indexOf('subscriptions.cancel')).toBeGreaterThan(methods.indexOf('subscriptions.create'))
      expect(recording.stripeCalls.find((call) => call.method === 'subscriptions.cancel')?.params).toEqual({ id: 'sub_exhausted' })
      expect(changed(recording, 'customer_memberships')[0]).toMatchObject({ subscription_status: ['active', 'cancelled'] })
      expect(added(recording, 'customer_memberships')[0]).toMatchObject({ subscription_status: 'active' })
    })

    it.each([
      ['refused-exhausted-membership-not-found', 'exhausted_membership_not_found'],
      ['refused-exhausted-membership-cancelled', 'exhausted_membership_not_active'],
      ['refused-exhausted-membership-past-its-last-day', 'exhausted_membership_not_active'],
    ])('%s', async (name, reason) => {
      const recording = await run(name)
      expect(recording.results[0]).toMatchObject({ success: false, stage: 'validation', reason })
      expect(recording.stripeCalls).toEqual([])
    })
  })

  // Bug B3, fixed at W06/W07. These pin what the old code does today, so the report can say so.
  describe('Q3 on the reader, as the old code does it', () => {
    it('buy-new membership with a pass: the tap takes both, and the customer never gets the pass', async () => {
      const recording = await run('q3-reader-buy-new-membership-with-a-pass')
      expect(charged(recording)).toEqual([9000])
      expect(refunds(recording)).toEqual([])
      expect(recording.results[1]).toMatchObject({ finalised: true })
      expect(added(recording, 'orders')[0]).toMatchObject({ order_total: '90.00', payment_status: 'paid' })
      expect(added(recording, 'order_line_items').map((line) => line['item_type'])).toEqual(['membership', 'booking'])
      expect(added(recording, 'customer_session_passes')).toEqual([])
    })

    it('buy-new pass with a membership: fails after the tap, and everything is given back', async () => {
      const recording = await run('q3-reader-buy-new-pass-with-a-membership')
      expect(charged(recording)).toEqual([9000])
      expect(refunds(recording)).toEqual([9000])
      expect(recording.results[1]).toMatchObject({ finalised: false, reason: 'finalise_failed' })
      expect(recording.stripeCalls.map((call) => call.method)).toContain('subscriptions.cancel')
      expect(added(recording, 'orders')).toEqual([])
      expect(added(recording, 'bookings')).toEqual([])
    })
  })
})
