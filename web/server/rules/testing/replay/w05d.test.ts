import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import type { Recording } from './compare'
import { oldSide, replay, startReplay, type ReplayEnvironment, type ReplaySide, type Scenario } from './harness'
import { CANCELLED_WITHOUT_ALL_THE_MONEY, CHARGES_NOT_ON_ONE_ORDER, STRIPE_REFUNDS_NOT_ON_ROWS, sweepInvariants } from './invariants'
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


/** W17: what the golden gaps (w17-* in scenarios.ts) break, recorded from the old functions (W17 report, section 6). */
const W17_KNOWN_FAULTS = [
  'w17-r1a-settle-store-credit-and-gift-card-statement-lands-late: price_paid £20.00, but £5.00 paid less £0.00 back',
  'w17-r1a-settle-store-credit-and-gift-card-statement-lands-late: gift card 10000000-0000-4000-8000-000000000009 lost £0.00, its redemptions say £5.00',
  'w17-r1b-move-store-credit-and-gift-card-statement-lands-late: price_paid £51.00, but £45.00 paid less £0.00 back',
  'w17-r1b-move-store-credit-and-gift-card-statement-lands-late: gift card 10000000-0000-4000-8000-000000000009 lost £0.00, its redemptions say £5.00',
  'w17-r1c-add-guest-store-credit-and-gift-card-statement-lands-late: price_paid £60.00, but £45.00 paid less £0.00 back',
  'w17-r1c-add-guest-store-credit-and-gift-card-statement-lands-late: gift card 10000000-0000-4000-8000-000000000009 lost £0.00, its redemptions say £5.00',
  'w17-r1d-move-gift-card-and-reader-statement-lands-late-then-cancel: gift card 10000000-0000-4000-8000-000000000009 lost £-5.00, its redemptions say £0.00',
  'w17-r2a-add-guest-press-dies-after-the-charge-then-paid-on-the-card: price_paid £60.00, but £80.00 paid less £0.00 back',
  'w17-r2b-add-guest-press-dies-after-the-charge-then-resumed-with-a-gift-card: price_paid £60.00, but £65.00 paid less £0.00 back',
  'w17-r2b-add-guest-press-dies-after-the-charge-then-resumed-with-a-gift-card: gift card 10000000-0000-4000-8000-000000000009 lost £0.00, its redemptions say £5.00',
  'w17-r2d-add-guest-press-dies-while-the-worker-charges-and-writes-no-order: price_paid £60.00, but £65.00 paid less £0.00 back',
  'w17-r3-move-two-presses-the-new-session-full-for-both: price_paid £40.00, but £51.00 paid less £22.00 back',
  'w17-r3-move-two-presses-the-new-session-full-for-both: Stripe refunded £11.00, the rows say £22',
  'w17-r4a-add-guest-store-credit-claim-answer-lost-then-pressed-again: price_paid £60.00, but £75.00 paid less £0.00 back',
  'w17-r4b-move-store-credit-claim-answer-lost: price_paid £40.00, but £46.00 paid less £0.00 back',
  'w17-n3-status-set-to-cancelled-on-a-paid-booking: cancelled with £0.00 back on £40.00 paid',
  'w17-n3-status-set-to-payment-needed-then-settled-again: price_paid £60.00, but £40.00 paid less £0.00 back',
]

/**
 * W27 (E-plan 4.13 item 1, lead call L6): step E's golden files record the old order refund and event cancellation
 * functions' faults on purpose too, and these invariants are what catch them. Each must keep breaking them in exactly
 * these ways, until the slice that moves its action (W28 order refunds, W30 event places) names the difference on the
 * new side. Every other W27 scenario, 131 of the 137, is clean.
 */
const W27_KNOWN_FAULTS = [
  // The function died after its card refund: £24 went with nothing recorded. The same lines pressed again would get
  // that refund back (the same key); another line doesn't, so the first £24 stays on no row.
  'w27-order-refund-died-on-one-line-then-another-line-at-the-same-figures: Stripe refunded £48.00, the rows say £24',
  // A held refund that went, still held when the scenario ends: the look for it failed, so nothing is recorded yet.
  'w27-order-refund-held-two-days-and-the-look-fails: Stripe refunded £24.00, the rows say £0',
  // E2: the order was refunded while its reader payment was open; the customer then tapped, and the £24 is on no order.
  'w27-e2-order-refund-while-its-reader-payment-is-still-open: pi_fake_0001 is on 0 orders',
  // £40 went to the card, then the place was checked in before the cancel was recorded: on the line, on no place.
  'w27-event-cancel-changed-by-someone-else-a-place-checked-in-meanwhile: the places say £0.00 went to the card, Stripe refunded £40.00',
  // The function died after one place's refund; the other place then took the card's other £40. £80 back, one place still booked.
  'w27-event-cancel-died-on-one-place-then-the-other-at-the-same-figures: Stripe refunded £80.00, the rows say £40',
  'w27-event-cancel-died-on-one-place-then-the-other-at-the-same-figures: the places say £40.00 went to the card, Stripe refunded £80.00',
  // A held refund that went, still held when the scenario ends (as the order's above).
  'w27-event-cancel-held-two-days-and-the-look-fails: Stripe refunded £40.00, the rows say £0',
  'w27-event-cancel-held-two-days-and-the-look-fails: the places say £0.00 went to the card, Stripe refunded £40.00',
]

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

  // Seat money only: add-ons have their own lines and their own refunds. W18: the sweep is in invariants.ts, so the
  // new side runs it too (booking-replay.test.ts).
  it('in every scenario, no booking gets back more than was paid, price_paid is paid less given back, and what is owed is never negative or more than that', async () => {
    const { wrong, needed, bookingsChecked } = await sweepInvariants(environment, scenarios, oldSide)
    // W17 (L6): the golden gaps record the old functions' faults on purpose, and these invariants are what catch
    // them. Each must keep breaking them in exactly these ways, until the slice that moves its action names the
    // difference on the new side (D-plan 4.11 item 3: the invariants run on every new-side scenario too).
    const known = wrong.filter((line) => line.startsWith('w17-'))
    // W27: step E's golden files do the same for the old order refund and event cancellation functions.
    const knownOfStepE = wrong.filter((line) => line.startsWith('w27-'))
    expect(wrong.filter((line) => !line.startsWith('w17-') && !line.startsWith('w27-'))).toEqual([])
    expect(known).toEqual(W17_KNOWN_FAULTS)
    expect(knownOfStepE).toEqual(W27_KNOWN_FAULTS)
    const stale = [STRIPE_REFUNDS_NOT_ON_ROWS, CANCELLED_WITHOUT_ALL_THE_MONEY, CHARGES_NOT_ON_ONE_ORDER].flatMap((list) =>
      Object.keys(list).filter((name) => !needed.has(`${Object.keys(list)[0]}/${name}`))
    )
    expect(stale).toEqual([])
    expect(bookingsChecked).toBeGreaterThan(100)
    // W11 added 45 reader scenarios to this sweep (see w05c.test.ts's).
  }, 300_000)
})
