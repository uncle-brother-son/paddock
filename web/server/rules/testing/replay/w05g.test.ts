import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import type { Recording } from './compare'
import { oldSide, replay, startReplay, type ReplayEnvironment, type ReplaySide, type Scenario, type ScenarioContext } from './harness'
import { goodwill, ID, noPromoOnCard, publicOnCard, scenarios, seed, whileFailing, type WriteFailure } from './scenarios'

// What the W05g scenarios prove the old functions now do, in pence. Each one's rows are also held to
// its golden file in replay.test.ts, and to the invariant in w05d.test.ts. Private: up to two people
// £100 at Core and £140 at Peak, three or four £150 and £190. Public: two seats £40 at Core and £51
// at Peak. "Owed" is bookings.refund_owed_amount; "R" is part_refunded_amount.

const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
const pence = (recording: Recording, method: string) =>
  recording.stripeCalls.filter((call) => call.method === method).map((call) => (call.params as { amount: number }).amount)
const refunds = (recording: Recording) => pence(recording, 'refunds.create')
const charged = (recording: Recording) => pence(recording, 'paymentIntents.create')
const creditMoves = (recording: Recording) =>
  added(recording, 'store_credit_transactions')
    .filter((row) => row['reason'] === 'refund')
    .map((row) => row['amount'])
const booking = (recording: Recording) => added(recording, 'bookings')[0]
const orderStatuses = (recording: Recording) => added(recording, 'orders').map((order) => order['payment_status'])
const last = (recording: Recording) => recording.results[recording.results.length - 1]
const audits = (recording: Recording, action: string) => added(recording, 'audit_log').filter((row) => row['action'] === action)
const amountsDue = (recording: Recording) =>
  recording.results.flatMap((result) => {
    const answer = result as { moved?: boolean; added?: boolean; priceImpact?: { amountDue: number } }
    return answer.priceImpact && !answer.moved && !answer.added ? [answer.priceImpact.amountDue] : []
  })

/** The old side, keeping what a throwing function says as its answer, as the screen would show it. */
const keepingErrors = (db: Db, stripe: FakeStripe): ReplaySide => {
  const side = oldSide(db, stripe)
  return {
    ...side,
    call: (action, params) => side.call(action, params).catch((err: Error) => ({ thrown: err.message })),
  }
}

type Steps = (bookingId: string, context: ScenarioContext) => Promise<unknown>

describe('W05g on the old functions', () => {
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
  const runKeepingErrors = (name: string) => {
    const scenario = scenarios.find((s) => s.name === name)
    if (!scenario) throw new Error(`No scenario ${name}`)
    return replay(environment, scenario, keepingErrors)
  }
  /** An order, then `steps`. Not in `scenarios`: these are refusals, with no rows worth a golden file. */
  const attempt = (order: Record<string, unknown>, steps: Steps) => {
    const scenario: Scenario = {
      name: 'attempt',
      seed,
      async run(context) {
        const { bookingId } = (await context.call('createOrder', { customerId: ID.customer, ...order })) as { bookingId: string }
        await steps(bookingId, context)
      },
    }
    return replay(environment, scenario, keepingErrors)
  }
  const part = (params: Record<string, unknown>, order: Record<string, unknown> = noPromoOnCard) =>
    attempt(order, (bookingId, { call }) => call('refundBooking', { bookingId, refundMethod: 'card', ...goodwill, ...params }))
  const cashOrder = { booking: (noPromoOnCard as { booking: unknown }).booking, payment: { method: 'cash', confirmedCashAmount: 100 } }
  const cardAndCredit = { ...noPromoOnCard, payment: { method: 'card', storeCredit: { amount: 10 } } }

  describe('Part refund', () => {
    it('gives the amount, raises part_refunded_amount, keeps the booking and works out the order', async () => {
      const recording = await run('figures-after-a-part-refund')
      expect(refunds(recording)).toEqual([3000])
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '70.00', part_refunded_amount: '30.00', refund_owed_amount: '0.00' })
      expect(orderStatuses(recording)).toEqual(['partially_refunded'])
      expect(recording.results[1]).toMatchObject({ cardRefundedAmount: 30, storeCreditRefundedAmount: 0, pricePaid: 70 })
    })

    it('keeps the reason on the store credit movement and in audit_log, with who gave it', async () => {
      const recording = await run('part-refund-to-store-credit-stays-live')
      expect(added(recording, 'store_credit_transactions')[0]).toMatchObject({ amount: '30.00', note: expect.stringMatching(/^Booking partial refund: Goodwill\. \[ref /) })
      expect(audits(recording, 'booking.part_refund')).toEqual([
        expect.objectContaining({
          actor_type: 'staff',
          actor_id: ID.staff,
          action: 'booking.part_refund',
          entity_type: 'booking',
          details: { amount: 30, reason: 'Goodwill', method: 'credit', cardRefunded: 0, storeCreditRefunded: 30, owed: 0 },
        }),
      ])
    })

    it('a card refund has nowhere else to keep its reason, so audit_log holds it', async () => {
      const recording = await run('figures-after-a-part-refund')
      expect(audits(recording, 'booking.part_refund')[0]).toMatchObject({ details: { reason: 'Goodwill', method: 'card', cardRefunded: 30 } })
    })

    it('an audit_log failure is a warning: the money has gone and is recorded on the booking', async () => {
      const auditFails: WriteFailure = { table: 'audit_log', event: 'INSERT', when: `NEW.action = 'booking.part_refund'` }
      const recording = await attempt(noPromoOnCard, (bookingId, { call, db }) =>
        whileFailing(db, auditFails, () => call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill }))
      )
      expect(last(recording)).toMatchObject({ cardRefundedAmount: 30, warning: expect.stringContaining('recording it in the audit log failed') })
      expect(booking(recording)).toMatchObject({ price_paid: '70.00', part_refunded_amount: '30.00' })
    })

    describe('the amount staff confirmed', () => {
      it.each<[string, number, number]>([
        ['exactly what is left', 100, 10000],
        ['under half a penny over gives what is left', 100.004, 10000],
        ['half a penny over gives what is left, not a penny more', 100.005, 10000],
      ])('%s', async (_name, amount, given) => {
        const recording = await part({ amount })
        expect(refunds(recording)).toEqual([given])
        expect(booking(recording)).toMatchObject({ price_paid: '0.00', part_refunded_amount: '100.00', status: 'confirmed' })
      })

      it('over half a penny more than is left is refused with the new figures, and nothing moves', async () => {
        const recording = await part({ amount: 100.006 })
        expect(last(recording)).toMatchObject({
          refused: { message: 'Only £100.00 is left on this booking. Check the amount and confirm again.', figures: { left: 100, pricePaid: 100 } },
        })
        expect(refunds(recording)).toEqual([])
        expect(booking(recording)).toMatchObject({ price_paid: '100.00', part_refunded_amount: '0.00' })
        expect(added(recording, 'audit_log')).toEqual([])
      })

      it.each<[string, unknown]>([
        ['nothing', 0],
        ['under half a penny', 0.004],
        ['less than nothing', -5],
        ['not a number', Number.NaN],
        ['endless', Number.POSITIVE_INFINITY],
        ['words', '10'],
        ['nothing sent', null],
      ])('%s is refused, and nothing moves', async (_name, amount) => {
        const recording = await part({ amount })
        expect(last(recording)).toEqual({ thrown: 'The refund amount must be more than £0.' })
        expect(refunds(recording)).toEqual([])
      })

      it('£0 left is refused', async () => {
        const recording = await attempt(noPromoOnCard, async (bookingId, { call }) => {
          await call('refundBooking', { bookingId, refundMethod: 'card', amount: 100, ...goodwill })
          await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 1, ...goodwill })
        })
        expect(last(recording)).toMatchObject({ refused: { message: "There's nothing left to refund on this booking.", figures: { left: 0 } } })
        expect(creditMoves(recording)).toEqual([])
      })
    })

    describe('the reason', () => {
      it.each<[string, unknown]>([
        ['missing', undefined],
        ['empty', ''],
        ['only spaces', '   '],
        ['not words', 7],
      ])('%s is refused, and nothing moves', async (_name, reason) => {
        const recording = await part({ amount: 10, reason })
        expect(last(recording)).toEqual({ thrown: 'A reason is required for a part refund.' })
        expect(refunds(recording)).toEqual([])
      })

      it('201 characters is refused, and 200 is not', async () => {
        const tooLong = await part({ amount: 10, reason: 'x'.repeat(201) })
        expect(last(tooLong)).toEqual({ thrown: 'The reason must be 200 characters or fewer.' })
        expect(refunds(tooLong)).toEqual([])
        const longest = await part({ amount: 10, reason: `  ${'x'.repeat(200)}  ` })
        expect(refunds(longest)).toEqual([1000])
        expect(audits(longest, 'booking.part_refund')[0]).toMatchObject({ details: { reason: 'x'.repeat(200) } })
      })
    })

    describe('where it goes', () => {
      it('the card stops at the card money, and never spills into store credit', async () => {
        const over = await part({ amount: 95 }, cardAndCredit)
        expect(last(over)).toMatchObject({ refused: { message: 'Only £90.00 of card money is left on this booking. Check the amount and confirm again.', figures: { left: 100, parts: { card: 90 } } } })
        expect(refunds(over)).toEqual([])
        expect(creditMoves(over)).toEqual([])
        expect(refunds(await part({ amount: 90 }, cardAndCredit))).toEqual([9000])
      })

      it('store credit can take all that is left, whatever paid for it', async () => {
        const recording = await part({ amount: 100, refundMethod: 'credit' }, cardAndCredit)
        expect(creditMoves(recording)).toEqual(['100.00'])
        expect(refunds(recording)).toEqual([])
      })

      it('cash money: the card is refused, and store credit gives it', async () => {
        const toCard = await part({ amount: 30 }, cashOrder)
        expect(last(toCard)).toMatchObject({ refused: { message: 'No card money is left on this booking, so this can only go to store credit.' } })
        expect(creditMoves(await part({ amount: 30, refundMethod: 'credit' }, cashOrder))).toEqual(['30.00'])
      })

      it('card money already refunded is not offered again', async () => {
        const recording = await attempt(noPromoOnCard, async (bookingId, { call }) => {
          await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 30, ...goodwill })
          await call('refundBooking', { bookingId, refundMethod: 'card', amount: 60, ...goodwill })
          await call('refundBooking', { bookingId, refundMethod: 'card', amount: 10.01, ...goodwill })
        })
        expect(last(recording)).toMatchObject({ refused: { message: 'Only £10.00 is left on this booking. Check the amount and confirm again.' } })
        expect(refunds(recording)).toEqual([6000])
      })
    })

    describe('refused outright', () => {
      it('a cancelled booking', async () => {
        const recording = await attempt(noPromoOnCard, async (bookingId, { call }) => {
          await call('refundBooking', { bookingId, refundMethod: 'card' })
          await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 10, ...goodwill })
        })
        expect(last(recording)).toEqual({ thrown: 'This booking is already cancelled.' })
        expect(creditMoves(recording)).toEqual([])
      })

      it('an open reader payment, and it works once the reader is cancelled', async () => {
        const recording = await runKeepingErrors('part-refund-while-a-reader-move-is-open')
        expect(recording.results[2]).toEqual({ thrown: 'A card reader payment is still open on this booking. Finish or cancel it first, or use Resolve now on the Orders page after 15 minutes.' })
        expect(refunds(recording)).toEqual([1000])
        expect(booking(recording)).toMatchObject({ price_paid: '30.00', part_refunded_amount: '10.00' })
      })

      const open = 'A card reader payment is still open on this booking. Finish or cancel it first, or use Resolve now on the Orders page after 15 minutes.'

      it("a guest's reader payment still open, which price_paid already counts, and it works once cancelled", async () => {
        const recording = await attempt(publicOnCard, async (bookingId, { call }) => {
          const guest = { bookingId, guestName: 'Bea Guest', guestEmail: 'bea@example.com', guestsOver18Confirmed: true }
          const started = (await call('addBookingGuest', { ...guest, payment: { method: 'reader' } })) as { pendingReaderPayment: { pendingId: string } }
          await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 60, ...goodwill })
          await call('cancelReaderPayment', { pendingId: started.pendingReaderPayment.pendingId })
          await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 40, ...goodwill })
        })
        expect(recording.results[2]).toEqual({ thrown: open })
        expect(creditMoves(recording)).toEqual(['40.00'])
        expect(booking(recording)).toMatchObject({ price_paid: '0.00', part_refunded_amount: '40.00' })
      })

      it('a checkout still on the reader, where nothing has been collected', async () => {
        const recording = await attempt({ ...noPromoOnCard, payment: { method: 'reader' } }, async (_noIdYet, { call, db }) => {
          const [line] = await db.query<{ booking_id: string }>(`SELECT booking_id FROM order_line_items WHERE item_type = 'booking'`)
          await call('refundBooking', { bookingId: line?.booking_id, refundMethod: 'credit', amount: 10, ...goodwill })
        })
        expect(last(recording)).toEqual({ thrown: open })
        expect(creditMoves(recording)).toEqual([])
      })

      it.each<[string, Record<string, unknown>]>([
        ['Part refund', { amount: 10, ...goodwill }],
        ['Refund the rest', { amount: 10, refundOwed: true }],
      ])('%s without Issue refunds, and nothing moves', async (_name, params) => {
        const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
          await db.query('UPDATE staff SET can_issue_refunds = false')
          await call('refundBooking', { bookingId, refundMethod: 'card', ...params })
        })
        expect(last(recording)).toMatchObject({ thrown: expect.stringContaining('Issue refunds') })
        expect(refunds(recording)).toEqual([])
      })
    })
  })

  describe('money owed goes up by exactly what failed, in the statement that sets price_paid', () => {
    it.each<[string, string, string, string]>([
      // price_paid, owed, part refunds.
      ['move-refund-store-credit-fails-outright', '140.00', '40.00', '0.00'],
      ['move-refund-card-declined', '140.00', '40.00', '0.00'],
      ['private-move-credit-fails-partway', '30.00', '30.00', '100.00'],
      ['public-move-credit-fails-partway', '30.00', '5.00', '15.00'],
      ['remove-guest-credit-fails-partway', '50.00', '10.00', '0.00'],
      // £120 agreed, £50 reached the customer: see "a part refund failing partway".
      ['part-refund-fails-partway', '100.00', '70.00', '120.00'],
    ])('%s', async (name, pricePaid, owed, partRefunded) => {
      expect(booking(await run(name))).toMatchObject({ price_paid: pricePaid, refund_owed_amount: owed, part_refunded_amount: partRefunded })
    })

    it('a warning points to the button, and never asks for it again by another route', async () => {
      for (const name of ['move-refund-store-credit-fails-outright', 'private-move-credit-fails-partway', 'remove-guest-credit-fails-partway', 'part-refund-fails-partway']) {
        const warnings = (await run(name)).results.flatMap((result) => (result as { warning?: string }).warning ?? [])
        expect(warnings.join(' ')).toContain('Refund the rest')
        expect(warnings.join(' ')).not.toContain('refund it again')
      }
    })

    it('if the statement fails, nothing is owed and staff are told to check', async () => {
      const outright = scenarios.find((s) => s.name === 'move-refund-store-credit-fails-outright') as Scenario
      const risesFail: WriteFailure = { table: 'bookings', event: 'UPDATE', when: 'NEW.refund_owed_amount > OLD.refund_owed_amount' }
      const scenario: Scenario = { ...outright, name: 'owed-write-fails', run: (context) => whileFailing(context.db, risesFail, () => outright.run(context)) }
      const recording = await replay(environment, scenario, oldSide)
      expect(booking(recording)).toMatchObject({ price_paid: '100.00', refund_owed_amount: '0.00' })
      expect(recording.results[2]).toMatchObject({ warning: expect.stringContaining('check the booking before refunding it') })
    })
  })

  describe('Refund the rest', () => {
    it.each<[string, number[], string[], string, string, string]>([
      // Refunds asked of Stripe, store credit, price_paid, owed, part refunds.
      ['move-refund-store-credit-fails-outright-then-retried', [10000], ['40.00'], '100.00', '0.00', '0.00'],
      ['refund-the-rest-card-then-store-credit', [10000, 1000], ['30.00'], '0.00', '0.00', '100.00'],
      ['refund-the-rest-fails-partway-then-retried', [10000, 1000], ['30.00'], '0.00', '0.00', '100.00'],
    ])('%s: gives exactly what is owed, and part_refunded_amount stays put', async (name, cardRefunds, credit, pricePaid, owed, partRefunded) => {
      const recording = await run(name)
      expect(refunds(recording)).toEqual(cardRefunds)
      expect(creditMoves(recording)).toEqual(credit)
      expect(booking(recording)).toMatchObject({ price_paid: pricePaid, refund_owed_amount: owed, part_refunded_amount: partRefunded })
    })

    it('card first, and what the card cannot take goes to store credit, so the whole amount is given', async () => {
      expect(last(await run('refund-the-rest-card-then-store-credit'))).toMatchObject({ cardRefundedAmount: 10, storeCreditRefundedAmount: 30, pricePaid: 0 })
    })

    it('failing partway lowers both figures by what was given, and the rest stays owed', async () => {
      const recording = await run('refund-the-rest-fails-partway-then-retried')
      const failed = recording.results[recording.results.length - 2]
      expect(failed).toMatchObject({ cardRefundedAmount: 10, storeCreditRefundedAmount: 0, pricePaid: 30, warning: expect.stringContaining('Refund the rest') })
    })

    /** Peak £140 at £100 with £40 owed, then whatever a test does. */
    const withFortyOwed = (steps: Steps) => {
      const owed = scenarios.find((s) => s.name === 'move-refund-store-credit-fails-outright') as Scenario
      const scenario: Scenario = {
        ...owed,
        name: 'forty-owed',
        async run(context) {
          await owed.run(context)
          const [row] = await context.db.query<{ id: string }>('SELECT id FROM bookings WHERE refund_owed_amount > 0')
          await steps(row?.id as string, context)
        },
      }
      return replay(environment, scenario, keepingErrors)
    }
    const rest = (amount: unknown) => (bookingId: string, { call }: ScenarioContext) =>
      call('refundBooking', { bookingId, refundMethod: 'credit', amount, refundOwed: true })

    it.each<[string, number]>([
      ['less than is owed', 30],
      ['more than is owed', 50],
      ['a penny less', 39.99],
    ])('%s is refused with the new figures, and nothing moves', async (_name, amount) => {
      const recording = await withFortyOwed(rest(amount))
      expect(last(recording)).toMatchObject({ refused: { message: 'The amount owed has changed to £40.00. Check it and confirm again.', figures: { refundOwed: 40 } } })
      expect(creditMoves(recording)).toEqual([])
      expect(booking(recording)).toMatchObject({ price_paid: '140.00', refund_owed_amount: '40.00' })
    })

    it('within half a penny, it gives what is owed and not the figure sent', async () => {
      const recording = await withFortyOwed(rest(40.004))
      expect(creditMoves(recording)).toEqual(['40.00'])
      expect(booking(recording)).toMatchObject({ price_paid: '100.00', refund_owed_amount: '0.00' })
    })

    it('a figure that would round up a penny still gives only what is owed', async () => {
      const recording = await withFortyOwed(rest(40.0050004))
      expect(creditMoves(recording)).toEqual(['40.00'])
      expect(booking(recording)).toMatchObject({ price_paid: '100.00', refund_owed_amount: '0.00' })
    })

    it('with nothing owed it is refused, and nothing moves', async () => {
      const recording = await attempt(noPromoOnCard, rest(10))
      expect(last(recording)).toMatchObject({ refused: { message: 'Nothing is owed on this booking any more.' } })
      expect(creditMoves(recording)).toEqual([])
    })

    it('on a cancelled booking it is refused', async () => {
      const recording = await withFortyOwed(async (bookingId, context) => {
        await context.call('refundBooking', { bookingId, refundMethod: 'card' })
        await rest(40)(bookingId, context)
      })
      expect(last(recording)).toEqual({ thrown: 'This booking is already cancelled.' })
      expect(creditMoves(recording)).toEqual([])
    })

    it('with no amount it is refused, and never falls through to Cancel & Refund', async () => {
      const recording = await withFortyOwed((bookingId, { call }) => call('refundBooking', { bookingId, refundMethod: 'card', refundOwed: true }))
      expect(last(recording)).toEqual({ thrown: 'The amount owed is required.' })
      expect(booking(recording)).toMatchObject({ status: 'confirmed', refund_owed_amount: '40.00' })
      expect(refunds(recording)).toEqual([])
    })

    it('an open reader payment refuses it, and it works once the reader is cancelled', async () => {
      const recording = await runKeepingErrors('refund-the-rest-while-a-reader-move-is-open')
      const answers = recording.results.filter((result) => 'thrown' in (result as object))
      expect(answers).toEqual([{ thrown: 'A card reader payment is still open on this booking. Finish or cancel it first, or use Resolve now on the Orders page after 15 minutes.' }])
      expect(booking(recording)).toMatchObject({ price_paid: '40.00', refund_owed_amount: '0.00' })
    })

    it('a Part refund cannot reach money owed', async () => {
      const over = await withFortyOwed((bookingId, { call }) => call('refundBooking', { bookingId, refundMethod: 'credit', amount: 100.01, ...goodwill }))
      expect(last(over)).toMatchObject({ refused: { message: 'Only £100.00 is left on this booking. Check the amount and confirm again.', figures: { left: 100, refundOwed: 40 } } })
      const all = await withFortyOwed((bookingId, { call }) => call('refundBooking', { bookingId, refundMethod: 'card', amount: 100, ...goodwill }))
      expect(booking(all)).toMatchObject({ price_paid: '40.00', refund_owed_amount: '40.00', part_refunded_amount: '100.00' })
    })
  })

  // Money owed sits inside price_paid but paid for nothing, so these all use price_paid less owed.
  describe('Move and Add Guest treat money owed as still the customer\'s', () => {
    it.each<[string, number[], number[], string, string]>([
      // The quotes, the charges, price_paid, part refunds. Paid and given back come out equal.
      // Paid £140, £40 owed, at £100: moving at the same price costs £0.
      ['owed-then-a-same-price-move', [-40, 0], [14000], '100.00', '0.00'],
      // £140 less £100 paid toward it: the £40 owed does not pay for the dearer session.
      ['owed-then-a-dearer-move', [-40, 40], [14000, 4000], '140.00', '0.00'],
      ['owed-then-a-dearer-move-then-cancel', [-40, 40], [14000, 4000], '180.00', '0.00'],
      // Public seat differences never read price_paid, so only the cap could change them.
      ['owed-public-then-a-same-price-move', [-11, 0], [5100], '40.00', '0.00'],
      // £100 tier less £100 paid toward it.
      ['owed-then-a-guest-same-tier', [-40], [14000], '100.00', '0.00'],
      // £150 tier less £100 paid toward it: £50, where counting the owed money would say £10.
      ['owed-then-a-guest-higher-tier', [-40, 50], [14000, 5000], '150.00', '0.00'],
    ])('%s', async (name, quotes, charges, pricePaid, partRefunded) => {
      const recording = await run(name)
      expect(amountsDue(recording)).toEqual(quotes)
      expect(charged(recording)).toEqual(charges)
      expect(booking(recording)).toMatchObject({ price_paid: pricePaid, part_refunded_amount: partRefunded, refund_owed_amount: '0.00' })
    })

    it('a move stops at what is left, so it never gives money owed: £100 tier, £0 toward it, £110 part refunded', async () => {
      const recording = await run('owed-with-nothing-left-then-a-same-price-move')
      expect(amountsDue(recording)).toEqual([-30, 0])
      expect(refunds(recording)).toEqual([11000])
      expect(booking(recording)).toMatchObject({ price_paid: '30.00', refund_owed_amount: '30.00', part_refunded_amount: '110.00' })
    })

    it('not given: a same-price move leaves the £30 owed', async () => {
      expect(booking(await run('private-move-credit-fails-then-a-same-price-move-leaves-it-owed'))).toMatchObject({ price_paid: '30.00', refund_owed_amount: '30.00' })
    })

    it('Remove Guest stops at what is left and leaves the money owed alone: £76.50 back on £76.50 paid', async () => {
      const recording = await run('owed-then-remove-guest-stops-at-what-is-left')
      const quote = recording.results.find((result) => (result as { quote?: unknown }).quote) as { quote: { refundAmount: number } }
      expect(quote.quote.refundAmount).toBe(10)
      expect(refunds(recording)).toEqual([2550, 2450, 1000])
      expect(creditMoves(recording)).toEqual(['16.50'])
      expect(booking(recording)).toMatchObject({ price_paid: '0.00', refund_owed_amount: '0.00', part_refunded_amount: '50.00' })
    })
  })

  // Part refunds stay with the customer (Q27, Q28), and Refund the rest never raises
  // part_refunded_amount, so the whole amount staff agreed has to count from the start.
  describe('a part refund failing partway: £150 paid, £120 agreed, £50 reached the customer', () => {
    it('the £70 is owed, and only £30 is left', async () => {
      const recording = await run('part-refund-fails-partway')
      expect(last(recording)).toMatchObject({ cardRefundedAmount: 50, storeCreditRefundedAmount: 0, pricePaid: 100 })
      expect(audits(recording, 'booking.part_refund')[0]).toMatchObject({ details: { amount: 120, cardRefunded: 50, storeCreditRefunded: 0, owed: 70 } })
    })

    it('Refund the rest and the cancel: £150 back on £150 paid', async () => {
      const recording = await run('part-refund-fails-partway-then-the-rest')
      expect(creditMoves(recording)).toEqual(['70.00'])
      // The £70 in the middle is the card declining.
      expect(refunds(recording)).toEqual([5000, 7000, 3000])
      expect(booking(recording)).toMatchObject({ status: 'cancelled', part_refunded_amount: '120.00', refund_owed_amount: '0.00' })
    })

    it('a same-price move costs £0 before and after the rest is given', async () => {
      const recording = await run('part-refund-fails-partway-then-a-same-price-move')
      expect(amountsDue(recording)).toEqual([50, 0, 0])
      expect(booking(recording)).toMatchObject({ price_paid: '30.00', part_refunded_amount: '120.00', refund_owed_amount: '0.00' })
    })

    it('a guest in the same tier costs £0, and the cancel gives all that is left', async () => {
      const recording = await run('part-refund-fails-partway-then-a-guest')
      expect(charged(recording)).toEqual([10000, 5000])
      expect(last(recording)).toMatchObject({ cardRefundedAmount: 100, storeCreditRefundedAmount: 0 })
    })
  })

  describe('Cancel & Refund gives everything left, including what is owed', () => {
    it('all of it and clears the figure', async () => {
      const recording = await run('owed-then-cancel')
      expect(refunds(recording)).toEqual([14000])
      expect(booking(recording)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00', part_refunded_amount: '0.00' })
    })

    it('after a dearer move: £180 back on £180 paid', async () => {
      expect(refunds(await run('owed-then-a-dearer-move-then-cancel'))).toEqual([4000, 14000])
    })

    it('if the cancel fails after the card, the money owed is paid off first and only the rest is a part refund', async () => {
      const recording = await run('owed-then-cancel-write-fails')
      expect(refunds(recording)).toEqual([14000])
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '0.00', refund_owed_amount: '0.00', part_refunded_amount: '100.00' })
    })

    it('if it fails after part of it, nothing owed is left over and a retry gives the rest: £140 back on £140 paid', async () => {
      const recording = await run('owed-then-cancel-write-fails-after-part-of-it')
      expect(refunds(recording)).toEqual([11000])
      expect(creditMoves(recording)).toEqual(['30.00', '-30.00', '30.00'])
      expect(booking(recording)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00', part_refunded_amount: '70.00' })
    })
  })

  describe('what the dialogs show', () => {
    it.each<[string, Record<string, unknown>]>([
      ['figures-on-the-card', { left: 100, cardLeft: 100, refundOwed: 0, parts: { card: 100, giftCard: 0, storeCredit: 0, cash: 0 } }],
      ['figures-in-cash', { left: 100, cardLeft: 0, refundOwed: 0, parts: { card: 0, giftCard: 0, storeCredit: 0, cash: 100 } }],
      ['figures-card-gift-card-and-store-credit', { left: 100, cardLeft: 70, refundOwed: 0, parts: { card: 70, giftCard: 20, storeCredit: 10, cash: 0 } }],
      ['figures-after-a-part-refund', { pricePaid: 70, left: 70, cardLeft: 70, parts: { card: 70, giftCard: 0, storeCredit: 0, cash: 0 } }],
      ['figures-card-order-and-a-cash-guest', { left: 60, cardLeft: 40, parts: { card: 40, giftCard: 0, storeCredit: 0, cash: 20 } }],
      ['figures-card-order-and-a-guest-on-store-credit', { left: 60, cardLeft: 40, parts: { card: 40, giftCard: 0, storeCredit: 20, cash: 0 } }],
      // Left leaves out the £40 owed. All £140 is still within the card's reach.
      ['figures-with-money-owed', { pricePaid: 140, left: 100, refundOwed: 40, cardLeft: 140, parts: { card: 100, giftCard: 0, storeCredit: 0, cash: 0 } }],
    ])('%s', async (name, figures) => {
      expect(last(await run(name))).toMatchObject(figures)
    })

    // Nothing writes this today, as each guest gets an order of their own, but old rows can hold it.
    it("two lines on one order count that order's card money once", async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
        await db.query(
          `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, booking_id)
           SELECT order_id, 'booking', 1, 20, 20, booking_id FROM order_line_items WHERE booking_id = $1`,
          [bookingId]
        )
        await call('getBookingRefundFigures', { bookingId })
      })
      expect(last(recording)).toMatchObject({ cardLeft: 40 })
    })

    it('every scenario that shows figures adds up to what is left', async () => {
      for (const name of ['figures-card-gift-card-and-store-credit', 'figures-card-order-and-a-cash-guest']) {
        const { left, parts } = last(await run(name)) as { left: number; parts: Record<string, number> }
        expect(Object.values(parts).reduce((sum, part) => sum + part, 0)).toBeCloseTo(left, 2)
      }
    })
  })
})
