import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import type { Recording } from './compare'
import { oldSide, replay, startReplay, type ReplayEnvironment, type ReplaySide, type Scenario } from './harness'
import { cancelWriteFails, ID, noPromoOnCard, scenarios, seed, takeBackFails, whileFailing, type WriteFailure } from './scenarios'

// What the W05e scenarios prove the old functions now do, in pence. Each one's rows are also held to
// its golden file in replay.test.ts, and to the invariant in w05d.test.ts. Private: £100 at Core and
// £140 at Peak, £150 for three at Core. Public: two seats, £40 at Core and £51 at Peak.

const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
const pence = (recording: Recording, method: string) =>
  recording.stripeCalls.filter((call) => call.method === method).map((call) => (call.params as { amount: number }).amount)
const refunds = (recording: Recording) => pence(recording, 'refunds.create')
const creditMoves = (recording: Recording) =>
  added(recording, 'store_credit_transactions')
    .filter((row) => row['reason'] === 'refund')
    .map((row) => row['amount'])
const booking = (recording: Recording) => added(recording, 'bookings')[0]
const bookingLines = (recording: Recording) => added(recording, 'order_line_items').filter((line) => line['item_type'] === 'booking')
const orderStatuses = (recording: Recording) => added(recording, 'orders').map((order) => order['payment_status'])
const fromEnd = (recording: Recording, back: number) => recording.results[recording.results.length - back]

/** The old side, keeping what a throwing function says as its answer, as the screen would show it. */
const keepingErrors = (db: Db, stripe: FakeStripe): ReplaySide => {
  const side = oldSide(db, stripe)
  return {
    ...side,
    call: (action, params) => side.call(action, params).catch((err: Error) => ({ thrown: err.message })),
  }
}

describe('W05e on the old functions', () => {
  let environment: ReplayEnvironment

  beforeAll(async () => {
    environment = await startReplay()
  })
  afterAll(() => environment.stop())

  const named = (name: string) => {
    const scenario = scenarios.find((s) => s.name === name)
    if (!scenario) throw new Error(`No scenario ${name}`)
    return scenario
  }
  const run = (name: string) => replay(environment, named(name), oldSide)

  describe('Cancel & Refund fails after the card: the booking stays, and the money stays with the customer', () => {
    it('all £100 on the card: £0 left, and it counts as a part refund', async () => {
      const recording = await run('cancel-write-fails-after-the-card')
      expect(refunds(recording)).toEqual([10000])
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '0.00', part_refunded_amount: '100.00' })
      expect(bookingLines(recording)[0]).toMatchObject({ card_refunded_amount: '100.00', refunded_at: null })
    })

    it('staff are told the card money is recorded', async () => {
      const recording = await replay(environment, named('cancel-write-fails-after-the-card'), keepingErrors)
      expect(fromEnd(recording, 1)).toMatchObject({ thrown: expect.stringContaining("£100.00 had already gone back to the card; it is recorded on the order and taken off the booking's price paid") })
    })

    it('Move does not ask for it again: a same-price move is £0', async () => {
      const recording = await run('cancel-write-fails-then-a-same-price-move')
      expect(fromEnd(recording, 2)).toMatchObject({ moved: false, priceImpact: { amountDue: 0 } })
      expect(fromEnd(recording, 1)).toMatchObject({ moved: true, booking: { price_paid: 0 } })
      expect(booking(recording)).toMatchObject({ session_id: ID.laterPrivateSession, part_refunded_amount: '100.00' })
    })

    it('Add Guest does not ask for it again: only the £50 tier difference', async () => {
      const recording = await run('cancel-write-fails-then-a-guest')
      expect(fromEnd(recording, 2)).toMatchObject({ added: false, priceImpact: { amountDue: 50 } })
      expect(pence(recording, 'paymentIntents.create')).toEqual([10000, 5000])
      expect(booking(recording)).toMatchObject({ price_paid: '50.00', part_refunded_amount: '100.00' })
    })

    it('public: a same-price move is £0 too', async () => {
      const recording = await run('cancel-write-fails-public-then-a-same-price-move')
      expect(fromEnd(recording, 2)).toMatchObject({ moved: false, priceImpact: { amountDue: 0 } })
      expect(booking(recording)).toMatchObject({ price_paid: '0.00', part_refunded_amount: '40.00' })
    })

    it('card and store credit: only the card counts, and the retry gives the £10 taken back', async () => {
      const recording = await run('cancel-write-fails-card-and-credit-then-retried')
      expect(refunds(recording)).toEqual([9000])
      expect(creditMoves(recording)).toEqual(['10.00', '-10.00', '10.00'])
      expect(booking(recording)).toMatchObject({ status: 'cancelled', part_refunded_amount: '90.00' })
      expect(bookingLines(recording)[0]).toMatchObject({ refunded_at: '<set>', refund_method: 'card' })
      expect(orderStatuses(recording)).toEqual(['refunded'])
    })

    it('all to store credit: taken back, so nothing counts', async () => {
      const recording = await run('cancel-write-fails-to-store-credit')
      expect(creditMoves(recording)).toEqual(['100.00', '-100.00'])
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '100.00', part_refunded_amount: '0.00' })
    })

    it('store credit that could not be taken back stays on price_paid, for staff to remove by hand', async () => {
      // Not in `scenarios`: until staff act, the £10 is with the customer and on price_paid as well,
      // so it would fail the invariant by design. It stays there because taking it back may yet land.
      const scenario: Scenario = {
        name: 'cancel-write-fails-store-credit-stuck',
        seed,
        async run({ call, db }) {
          const order = { ...noPromoOnCard, payment: { method: 'card', storeCredit: { amount: 10 } } }
          const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...order })) as { bookingId: string }
          await whileFailing(db, takeBackFails, () => whileFailing(db, cancelWriteFails, () => call('refundBooking', { bookingId, refundMethod: 'card' })))
        },
      }
      const recording = await replay(environment, scenario, keepingErrors)
      expect(fromEnd(recording, 1)).toMatchObject({ thrown: expect.stringContaining('Taking back the £10.00 store credit failed — remove it by hand.') })
      expect(creditMoves(recording)).toEqual(['10.00'])
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '10.00', part_refunded_amount: '90.00' })
    })

    it('if recording it fails as well, both figures stay and staff are sent to Stripe', async () => {
      const onceCancelled: WriteFailure = { table: 'bookings', event: 'UPDATE', when: `OLD.status = 'cancelled'` }
      const scenario: Scenario = {
        name: 'cancel-and-its-recovery-both-fail',
        seed,
        async run({ call, db }) {
          const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...noPromoOnCard })) as { bookingId: string }
          await whileFailing(db, onceCancelled, () => call('refundBooking', { bookingId, refundMethod: 'card' }))
        },
      }
      const recording = await replay(environment, scenario, keepingErrors)
      expect(fromEnd(recording, 1)).toMatchObject({ thrown: expect.stringContaining('recording it failed — check in Stripe before retrying') })
      expect(fromEnd(recording, 1)).toMatchObject({ thrown: expect.stringContaining('The booking still shows as cancelled') })
      expect(booking(recording)).toMatchObject({ price_paid: '100.00', part_refunded_amount: '0.00' })
    })

    it('if the claim itself fails, nothing is refunded and the booking stays as it was', async () => {
      const everyBookingWrite: WriteFailure = { table: 'bookings', event: 'UPDATE', when: 'true' }
      const scenario: Scenario = {
        name: 'cancel-claim-fails',
        seed,
        async run({ call, db }) {
          const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...noPromoOnCard })) as { bookingId: string }
          await whileFailing(db, everyBookingWrite, () => call('refundBooking', { bookingId, refundMethod: 'card' }))
        },
      }
      const recording = await replay(environment, scenario, keepingErrors)
      expect(fromEnd(recording, 1)).toMatchObject({ thrown: expect.stringContaining('the booking was not cancelled and nothing was refunded') })
      expect(refunds(recording)).toEqual([])
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '100.00' })
    })
  })

  describe('a line whose seat money has all gone back is refunded', () => {
    it.each<[string, string, string[]]>([
      ['all-part-refunded-to-the-card-then-cancel', 'card', ['refunded']],
      ['all-part-refunded-to-store-credit-then-cancel', 'credit', ['refunded']],
      ['all-part-refunded-card-and-credit-then-cancel', 'card', ['refunded']],
      ['all-part-refunded-with-a-guest-then-cancel', 'card', ['refunded', 'refunded']],
      ['all-part-refunded-addon-ticked-then-cancel', 'card', ['refunded']],
      // The Towel wasn't refunded, so the order is right to say partly.
      ['all-part-refunded-addon-not-ticked-then-cancel', 'card', ['partially_refunded']],
      ['nearly-all-part-refunded-then-cancel', 'card', ['refunded']],
      // Got to £0 by other routes than a part refund alone.
      ['q28-private-cheaper-stops-at-what-is-left', 'card', ['refunded']],
      ['remove-guest-capped-then-cancel', 'card', ['refunded', 'refunded']],
      ['cancel-write-fails-card-and-credit-then-retried', 'card', ['refunded']],
      ['private-move-credit-fails-partway-then-retried', 'card', ['refunded']],
    ])('%s: stamped %s, order %j', async (name, method, statuses) => {
      const recording = await run(name)
      expect(booking(recording)).toMatchObject({ status: 'cancelled' })
      for (const line of bookingLines(recording)) expect(line).toMatchObject({ refunded_at: '<set>', refund_method: method })
      expect(orderStatuses(recording)).toEqual(statuses)
    })

    it('the cancel itself gives nothing back on a booking already at £0', async () => {
      const recording = await run('all-part-refunded-to-the-card-then-cancel')
      expect(refunds(recording)).toEqual([10000])
      expect(fromEnd(recording, 1)).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0 })
      expect(booking(recording)).toMatchObject({ price_paid: '0.00', part_refunded_amount: '100.00' })
    })

    it.each<[string, unknown, string]>([
      ['q24-free-booking-cancelled', null, 'paid'],
      ['price-paid-cleared-nothing-back-then-cancel', null, 'paid'],
      // Half went back: the line isn't refunded, and the order says partly.
      ['price-paid-cleared-half-back-then-cancel', null, 'partially_refunded'],
      // The Towel's store credit is not seat money, so £95 of £100 isn't all of it. The unstamped line
      // of a cancelled booking isn't counted, so the refunded Towel alone sets the order's status.
      ['price-paid-cleared-addon-credit-is-not-seat-money', null, 'refunded'],
    ])('%s: not all of it went back, so it stays unstamped', async (name, method, status) => {
      const recording = await run(name)
      expect(booking(recording)).toMatchObject({ status: 'cancelled' })
      expect(bookingLines(recording)[0]).toMatchObject({ refunded_at: null, refund_method: method })
      expect(orderStatuses(recording)).toEqual([status])
    })
  })

  describe('store credit fails partway through Remove Guest', () => {
    it('the guest goes, price_paid falls by the £10 given, the other £10 is owed, and staff are pointed to Refund the rest', async () => {
      const recording = await run('remove-guest-credit-fails-partway')
      expect(fromEnd(recording, 1)).toMatchObject({ removed: true, refundedAmount: 10, cardRefundedAmount: 10, storeCreditRefundedAmount: 0 })
      const { warning } = fromEnd(recording, 1) as { warning: string }
      // W05j: the store credit is looked for after the error and isn't there, so it is a clear no.
      expect(warning).toContain('£10.00 was refunded, but the other £10.00 may not have reached store credit. It is still on the booking')
      expect(warning).toContain('Refund the rest')
      expect(warning).not.toContain('by hand')
      expect(refunds(recording)).toEqual([1000])
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '50.00', part_refunded_amount: '0.00', refund_owed_amount: '10.00', party_size: 2 })
    })

    it('Refund the rest gives the £10, and Cancel & Refund what is left: £60 back on £60 paid', async () => {
      const recording = await run('remove-guest-credit-fails-partway-then-retried')
      expect(fromEnd(recording, 2)).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 10 })
      expect(fromEnd(recording, 1)).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 40 })
      expect(refunds(recording)).toEqual([1000])
      expect(creditMoves(recording)).toEqual(['10.00', '40.00'])
      expect(booking(recording)).toMatchObject({ status: 'cancelled', part_refunded_amount: '0.00', refund_owed_amount: '0.00' })
    })
  })

  describe('store credit fails partway through a move', () => {
    // The steps are the order, the part refund, the quote, then the confirmed move.
    it.each<[string, number, number, string, string, number[]]>([
      ['public-move-credit-fails-partway', -11, 30, '30.00', '£5.00', [1500, 600]],
      ['private-move-credit-fails-partway', -40, 30, '30.00', '£30.00', [10000, 1000]],
    ])('%s: price_paid falls only by what went back', async (name, amountDue, pricePaid, stored, rest, cardRefunds) => {
      const recording = await run(name)
      expect(recording.results[2]).toMatchObject({ moved: false, priceImpact: { amountDue } })
      expect(recording.results[3]).toMatchObject({ moved: true, booking: { price_paid: pricePaid } })
      const { warning } = recording.results[3] as { warning: string }
      // W05j: the store credit is looked for after the error and isn't there, so it is a clear no.
      expect(warning).toContain(`but the other ${rest} may not have reached store credit. It is still on the booking`)
      expect(warning).toContain('Refund the rest')
      expect(warning).not.toContain('by hand')
      expect(refunds(recording)).toEqual(cardRefunds)
      expect(creditMoves(recording)).toEqual([])
      expect(booking(recording)).toMatchObject({ price_paid: stored, refund_owed_amount: rest.slice(1) })
    })

    it('public: Refund the rest and the cancel bring it to £51 back on £51 paid', async () => {
      const recording = await run('public-move-credit-fails-partway-then-retried')
      expect(refunds(recording)).toEqual([1500, 600])
      expect(creditMoves(recording)).toEqual(['5.00', '25.00'])
      expect(booking(recording)).toMatchObject({ status: 'cancelled', part_refunded_amount: '15.00', refund_owed_amount: '0.00' })
    })

    it('private: Refund the rest and the cancel bring it to £140 back on £140 paid', async () => {
      const recording = await run('private-move-credit-fails-partway-then-retried')
      expect(refunds(recording)).toEqual([10000, 1000])
      expect(creditMoves(recording)).toEqual(['30.00'])
      expect(booking(recording)).toMatchObject({ status: 'cancelled', price_paid: '0.00', part_refunded_amount: '100.00', refund_owed_amount: '0.00' })
    })

    it('not given: the next same-price move costs nothing and the £30 stays owed', async () => {
      const recording = await run('private-move-credit-fails-then-a-same-price-move-leaves-it-owed')
      expect(fromEnd(recording, 2)).toMatchObject({ moved: false, priceImpact: { amountDue: 0 } })
      expect(creditMoves(recording)).toEqual([])
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '30.00', part_refunded_amount: '100.00', refund_owed_amount: '30.00' })
    })

    // Decision 2, fixed by W05g: this used to give the £10 a second time.
    it('given with Refund the rest, a later same-price private move gives nothing', async () => {
      const recording = await run('private-move-rest-retried-then-a-same-price-move')
      expect(fromEnd(recording, 2)).toMatchObject({ moved: false, priceImpact: { amountDue: 0 } })
      expect(refunds(recording)).toEqual([8000, 3000])
      expect(creditMoves(recording)).toEqual(['10.00'])
      expect(booking(recording)).toMatchObject({ price_paid: '20.00', part_refunded_amount: '80.00', refund_owed_amount: '0.00' })
    })

    it('if putting the rest back fails, staff are told to check before refunding', async () => {
      const partway = named('public-move-credit-fails-partway')
      const risesFail: WriteFailure = { table: 'bookings', event: 'UPDATE', when: 'NEW.price_paid > OLD.price_paid' }
      const scenario: Scenario = {
        ...partway,
        name: 'public-move-put-back-fails',
        run: (context) => whileFailing(context.db, risesFail, () => partway.run(context)),
      }
      const recording = await replay(environment, scenario, oldSide)
      expect(recording.results[3]).toMatchObject({ moved: true, booking: { price_paid: 25 } })
      expect((recording.results[3] as { warning: string }).warning).toContain("Putting the £5.00 back on the booking's price paid failed — check the booking before refunding it")
      expect(booking(recording)).toMatchObject({ price_paid: '25.00' })
    })
  })
})
