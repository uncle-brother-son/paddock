import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import type { Recording } from './compare'
import { oldSide, replay, startReplay, type ReplayEnvironment, type ReplaySide, type Scenario } from './harness'
import { ID, noPromoOnCard, publicOnCard, scenarios, seed, whileFailing, type WriteFailure } from './scenarios'

// What the W05f scenarios prove the old functions now do, in pence. Each one's rows are also held to
// its golden file in replay.test.ts, and to the invariant in w05d.test.ts. Private: £100 at Core and
// £140 at Peak. Public: two seats, £40 at Core and £51 at Peak, £20 a guest.

const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
const pence = (recording: Recording, method: string) =>
  recording.stripeCalls.filter((call) => call.method === method).map((call) => (call.params as { amount: number }).amount)
const refunds = (recording: Recording) => pence(recording, 'refunds.create')
const creditBack = (recording: Recording) =>
  added(recording, 'store_credit_transactions')
    .filter((row) => row['reason'] === 'refund')
    .map((row) => row['amount'])
const booking = (recording: Recording) => added(recording, 'bookings')[0]
const bookingLines = (recording: Recording) => added(recording, 'order_line_items').filter((line) => line['item_type'] === 'booking')
const stamps = (recording: Recording) => bookingLines(recording).map((line) => line['refund_method'])
const orderStatuses = (recording: Recording) => added(recording, 'orders').map((order) => order['payment_status'])

/** The old side, keeping what a throwing function says as its answer, as the screen would show it. */
const keepingErrors = (db: Db, stripe: FakeStripe): ReplaySide => {
  const side = oldSide(db, stripe)
  return {
    ...side,
    call: (action, params) => side.call(action, params).catch((err: Error) => ({ thrown: err.message })),
  }
}

describe('W05f on the old functions', () => {
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

  describe("a move's refund fails outright", () => {
    // The steps are the order, the quote, then the confirmed move.
    it.each<[string, string, string]>([
      // W05j: the store credit is looked for after the error and isn't there, so it is a clear no.
      ['move-refund-store-credit-fails-outright', 'refund_failed: Adding the store credit failed, so nothing was refunded', 'The £40.00 is still on the booking: check their store credit balance'],
      ['move-refund-card-declined', 'refund_failed: The card refund failed, so nothing was refunded', 'The card refund of £40.00 failed, so it is still on the booking'],
    ])('%s: the move stands and all £40 stays on price_paid', async (name, reason, warning) => {
      const recording = await run(name)
      expect(recording.results[1]).toMatchObject({ moved: false, priceImpact: { amountDue: -40 } })
      expect(recording.results[2]).toMatchObject({ moved: true, booking: { price_paid: 140 }, reason: expect.stringContaining(reason) })
      expect((recording.results[2] as { warning: string }).warning).toContain(warning)
      expect(creditBack(recording)).toEqual([])
      expect(booking(recording)).toMatchObject({ session_id: ID.laterPrivateSession, price_paid: '140.00', part_refunded_amount: '0.00', refund_owed_amount: '40.00' })
    })

    it.each<[string, number[], string[], string]>([
      // £40 to store credit, then the £100 left to the card.
      ['move-refund-store-credit-fails-outright-then-retried', [10000], ['40.00'], '0.00'],
      // The declined try, the £40 to the card, then the £100 left.
      ['move-refund-card-declined-then-retried', [4000, 4000, 10000], [], '0.00'],
      ['public-move-refund-fails-outright-then-retried', [4000], ['11.00'], '0.00'],
    ])('%s: the retry and the cancel bring money back to money paid', async (name, cardRefunds, credit, partRefunded) => {
      const recording = await run(name)
      expect(refunds(recording)).toEqual(cardRefunds)
      expect(creditBack(recording)).toEqual(credit)
      expect(booking(recording)).toMatchObject({ status: 'cancelled', part_refunded_amount: partRefunded })
      expect(orderStatuses(recording)).toEqual(['refunded'])
    })

    it('£140 back on £140 paid after store credit failed', async () => {
      const recording = await run('move-refund-store-credit-fails-outright-then-retried')
      expect(recording.results[recording.results.length - 1]).toMatchObject({ cardRefundedAmount: 100, storeCreditRefundedAmount: 0 })
    })

    it('if putting it back fails too, staff are told to check before refunding', async () => {
      const outright = named('move-refund-store-credit-fails-outright')
      const risesFail: WriteFailure = { table: 'bookings', event: 'UPDATE', when: 'NEW.price_paid > OLD.price_paid' }
      const scenario: Scenario = { ...outright, name: 'move-put-back-fails-outright', run: (context) => whileFailing(context.db, risesFail, () => outright.run(context)) }
      const recording = await replay(environment, scenario, oldSide)
      expect(recording.results[2]).toMatchObject({ moved: true, booking: { price_paid: 100 } })
      expect((recording.results[2] as { warning: string }).warning).toContain("Putting the £40.00 back on the booking's price paid failed — check the booking before refunding it")
    })
  })

  describe('a failed cancel works out the order status', () => {
    it.each<[string, string[]]>([
      ['cancel-write-fails-after-the-card', ['partially_refunded']],
      ['cancel-write-fails-then-a-same-price-move', ['partially_refunded']],
      ['cancel-write-fails-public-then-a-same-price-move', ['partially_refunded']],
      // The guest's own order had nothing refunded.
      ['cancel-write-fails-then-a-guest', ['partially_refunded', 'paid']],
    ])('%s', async (name, statuses) => {
      expect(orderStatuses(await run(name))).toEqual(statuses)
    })

    it('nothing went to the card, and the store credit was taken back: the order stays paid', async () => {
      expect(orderStatuses(await run('cancel-write-fails-to-store-credit'))).toEqual(['paid'])
    })
  })

  describe('store credit counts as money back on a live booking', () => {
    it.each<[string, string]>([
      ['part-refund-to-store-credit-stays-live', 'a part refund'],
      ['cheaper-move-to-store-credit-stays-live', 'a cheaper move'],
    ])('%s: %s leaves the order partly refunded', async (name) => {
      const recording = await run(name)
      expect(booking(recording)).toMatchObject({ status: 'confirmed' })
      expect(bookingLines(recording)[0]).toMatchObject({ refunded_at: null, refund_method: null })
      expect(orderStatuses(recording)).toEqual(['partially_refunded'])
    })
  })

  describe("Remove Guest leaves the guest's order refunded", () => {
    // Lines and orders oldest first: the booking's own, then the guests'.
    it.each<[string, unknown[], string[]]>([
      ['remove-guest-on-the-card', [null, 'card'], ['paid', 'refunded']],
      // Store credit is recorded on the booking's own order, which then says partly: see the report.
      ['remove-guest-to-store-credit', [null, 'credit'], ['partially_refunded', 'refunded']],
      ['remove-guest-paid-in-cash', [null, 'credit'], ['partially_refunded', 'refunded']],
      // Same price, so the newest line stands for the seat, as the card refund does.
      ['remove-guest-the-older-of-two', [null, null, 'card'], ['paid', 'paid', 'refunded']],
      ['remove-guest-both-of-two', [null, 'card', 'card'], ['paid', 'refunded', 'refunded']],
      // Their Towel is unrefunded.
      ['remove-guest-their-addon-left', [null, 'card'], ['paid', 'partially_refunded']],
      ['remove-a-seat-from-the-first-order', [null], ['partially_refunded']],
      // Only one seat held money, so with nothing left the first line is all of it.
      ['credit-booking-paid-seat-removed', ['card'], ['refunded']],
      // The line holds more than the seat, so it isn't stamped. See the report, "For step E".
      ['remove-guest-after-a-cheaper-move', [null, null], ['partially_refunded', 'partially_refunded']],
    ])('%s', async (name, methods, statuses) => {
      const recording = await run(name)
      expect(booking(recording)).toMatchObject({ status: 'confirmed' })
      expect(stamps(recording)).toEqual(methods)
      expect(orderStatuses(recording)).toEqual(statuses)
    })

    it('the first line stays unstamped while money is left on the booking', async () => {
      // Not in `scenarios`: the seat and price_paid are forced, so the invariant can't hold. Alex's seat
      // as big as the first line, with £20 still on the booking, is what a much dearer move leaves.
      const scenario: Scenario = {
        name: 'remove-a-seat-as-big-as-the-first-line',
        seed,
        async run({ call, db }) {
          const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...publicOnCard })) as { bookingId: string }
          await db.query(`UPDATE bookings SET price_paid = 60 WHERE id = $1`, [bookingId])
          await db.query(`UPDATE booking_guests SET unit_price = 40 WHERE booking_id = $1 AND guest_type = 'additional_guest'`, [bookingId])
          const [seat] = await db.query<{ id: string }>(`SELECT id FROM booking_guests WHERE booking_id = $1 AND guest_type = 'additional_guest'`, [bookingId])
          await call('removeBookingGuest', { guestId: seat?.id, confirmedRefundAmount: 40, refundMethod: 'card' })
        },
      }
      const recording = await replay(environment, scenario, oldSide)
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '20.00' })
      expect(stamps(recording)).toEqual([null])
      expect(orderStatuses(recording)).toEqual(['partially_refunded'])
    })

    it('where it stopped at what was left, the rest had gone already', async () => {
      const recording = await run('remove-guest-capped-to-store-credit')
      expect(stamps(recording)[1]).toBe('card')
      expect(orderStatuses(recording)[1]).toBe('refunded')
    })

    it('nothing left to give: still refunded, with no refund on the removal', async () => {
      const recording = await run('remove-guest-nothing-left')
      expect(stamps(recording)[1]).toBe('card')
      expect(orderStatuses(recording)[1]).toBe('refunded')
    })

    it('store credit that fell short: the line waits, because not all of it went back', async () => {
      const recording = await run('remove-guest-credit-fails-partway')
      expect(stamps(recording)).toEqual([null, null])
      expect(orderStatuses(recording)).toEqual(['partially_refunded', 'paid'])
    })

    it('Cancel & Refund afterwards leaves both orders refunded, and money is unchanged', async () => {
      const recording = await run('remove-guest-then-cancel')
      expect(refunds(recording)).toEqual([2000, 2000])
      expect(creditBack(recording)).toEqual(['20.00'])
      expect(orderStatuses(recording)).toEqual(['refunded', 'refunded'])
    })
  })

  describe('Cancel & return credit uses the same check', () => {
    it.each<[string, string, string]>([
      ['credit-booking-paid-seat-part-refunded-to-the-card-then-cancelled', 'card', 'refunded'],
      ['credit-booking-paid-seat-part-refunded-to-store-credit-then-cancelled', 'credit', 'refunded'],
    ])('%s: the line is stamped %s', async (name, method, status) => {
      const recording = await run(name)
      expect(booking(recording)).toMatchObject({ status: 'cancelled', price_paid: '0.00' })
      expect(stamps(recording)).toEqual([method])
      expect(orderStatuses(recording)).toEqual([status])
    })

    it('a paid guest removed first: their order is refunded, the credit seat left alone', async () => {
      const recording = await run('credit-booking-paid-guest-removed-then-cancelled')
      expect(stamps(recording)).toEqual([null, 'card'])
      expect(orderStatuses(recording)[1]).toBe('refunded')
    })

    it('price_paid at £0 with the seat money never given back: nothing is stamped', async () => {
      const recording = await run('credit-booking-price-paid-cleared-then-cancelled')
      expect(booking(recording)).toMatchObject({ status: 'cancelled' })
      expect(stamps(recording)).toEqual([null])
      expect(orderStatuses(recording)).toEqual(['paid'])
    })

    it('no money on the booking: nothing is stamped', async () => {
      const recording = await run('credit-booking-no-money-cancelled')
      expect(booking(recording)).toMatchObject({ status: 'cancelled' })
      expect(stamps(recording)).toEqual([null])
      expect(orderStatuses(recording)).toEqual(['paid'])
    })
  })

  // Found under the brief's scope rule. Before this, removing a guest and cancelling the reader gave
  // £85.50 back on £60 paid: the cancel put price_paid back from its snapshot, over the refund.
  describe('nothing changes price_paid while a reader move is open', () => {
    const refused = { reason: 'reader_payment_open', message: 'A card reader payment is still open on this booking. Finish or cancel it first, or use Resolve now on the Orders page after 15 minutes.' }

    it('Remove Guest is refused, and works once the reader is cancelled: £60 back on £60 paid', async () => {
      const recording = await run('remove-guest-while-a-reader-move-is-open')
      expect(recording.results[recording.results.length - 5]).toMatchObject({ removed: false, ...refused })
      expect(recording.results[recording.results.length - 2]).toMatchObject({ removed: true, refundedAmount: 20 })
      expect(refunds(recording)).toEqual([2000, 4000])
      expect(creditBack(recording)).toEqual([])
    })

    it('Cancel & Refund is refused, and works once the reader is cancelled: £40 back on £40 paid', async () => {
      const recording = await replay(environment, named('cancel-while-a-reader-move-is-open'), keepingErrors)
      expect(recording.results[2]).toEqual({ thrown: refused.message })
      expect(refunds(recording)).toEqual([4000])
      expect(booking(recording)).toMatchObject({ status: 'cancelled', session_id: ID.session })
    })

    it('Add Guest is refused, so nothing is charged', async () => {
      const recording = await run('add-guest-while-a-reader-move-is-open')
      expect(recording.results[2]).toMatchObject({ added: false, ...refused })
      expect(pence(recording, 'paymentIntents.create')).toEqual([4000, 1100])
      expect(refunds(recording)).toEqual([4000])
    })

    it('a second move is refused', async () => {
      const recording = await run('second-move-while-a-reader-move-is-open')
      expect(recording.results[2]).toMatchObject({ moved: false, ...refused })
      expect(refunds(recording)).toEqual([])
      expect(booking(recording)).toMatchObject({ session_id: ID.session, price_paid: '40.00' })
    })

    it('a finished reader payment blocks nothing', async () => {
      const recording = await run('reader-move-finished-then-remove-guest')
      expect(recording.results[recording.results.length - 1]).toMatchObject({ removed: true, refundedAmount: 25.5 })
    })
  })

  // Found under the brief's scope rule: price_paid stays on a cancelled booking, so this paid twice.
  it('a part refund on a cancelled booking is refused, and nothing moves', async () => {
    const scenario: Scenario = {
      name: 'part-refund-after-cancel',
      seed,
      async run({ call }) {
        const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...noPromoOnCard })) as { bookingId: string }
        await call('refundBooking', { bookingId, refundMethod: 'card' })
        await call('refundBooking', { bookingId, refundMethod: 'card', amount: 100, reason: 'Goodwill' })
      },
    }
    const recording = await replay(environment, scenario, keepingErrors)
    expect(recording.results[2]).toEqual({ thrown: 'This booking is already cancelled.' })
    expect(refunds(recording)).toEqual([10000])
    expect(creditBack(recording)).toEqual([])
    expect(booking(recording)).toMatchObject({ part_refunded_amount: '0.00' })
  })
})
