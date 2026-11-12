import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { CARD_PAYMENT_OPEN_MESSAGE } from '../../bookings/failure-messages'
import type { Recording } from './compare'
import { oldSide, replay, startReplay, type ReplayEnvironment, type ReplaySide, type Scenario, type ScenarioContext } from './harness'
import {
  cancelWriteFails,
  goodwill,
  ID,
  creditCantBeTold,
  noPromoOnCard,
  publicOnCard,
  refundCreditFails,
  scenarios,
  seed,
  sessionsToMoveBetween,
  whileFailing,
  type WriteFailure,
} from './scenarios'

// What W05h proves on the old functions, in pence, on one connection. Two connections are in
// refund-races.test.ts. Private: up to two people £100 at Core and £140 at Peak. Public: two seats
// £40 at Core and £51 at Peak, a third seat £20. "Owed" is bookings.refund_owed_amount.

const OPEN = 'A card reader payment is still open on this booking. Finish or cancel it first, or use Resolve now on the Orders page after 15 minutes.'
const bea = { guestName: 'Bea Guest', guestEmail: 'bea@example.com', guestsOver18Confirmed: true }
const cy = { guestName: 'Cy Guest', guestEmail: 'cy@example.com', guestsOver18Confirmed: true }
const peakPrivateOnCard = { ...noPromoOnCard, booking: { ...(noPromoOnCard as { booking: object }).booking, sessionId: ID.peakPrivateSession } }
const arrived = { refundMethod: 'credit', amount: 40, owedArrived: true, reason: 'Found on their balance' }

const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
const pence = (recording: Recording, method: string) =>
  recording.stripeCalls.filter((call) => call.method === method).map((call) => (call.params as { amount: number }).amount)
const refunds = (recording: Recording) => pence(recording, 'refunds.create')
const creditMoves = (recording: Recording) =>
  added(recording, 'store_credit_transactions')
    .filter((row) => row['reason'] === 'refund')
    .map((row) => row['amount'])
const booking = (recording: Recording) => added(recording, 'bookings')[0]
const last = (recording: Recording) => recording.results[recording.results.length - 1]
const audits = (recording: Recording, action: string) => added(recording, 'audit_log').filter((row) => row['action'] === action)

const keepingErrors = (db: Db, stripe: FakeStripe): ReplaySide => {
  const side = oldSide(db, stripe)
  return { ...side, call: (action, params) => side.call(action, params).catch((err: Error) => ({ thrown: err.message })) }
}

type Steps = (bookingId: string, context: ScenarioContext) => Promise<unknown>
interface Pending {
  pendingReaderPayment: { pendingId: string; paymentIntentId: string }
}

describe('W05h on the old functions', () => {
  let environment: ReplayEnvironment

  beforeAll(async () => {
    environment = await startReplay()
  })
  afterAll(() => environment.stop())

  const run = (name: string) => {
    const scenario = scenarios.find((s) => s.name === name)
    if (!scenario) throw new Error(`No scenario ${name}`)
    return replay(environment, scenario, keepingErrors)
  }
  /** An order, then `steps`. Not in `scenarios`: these are refusals, with no rows worth a golden file. */
  const attempt = (order: Record<string, unknown>, steps: Steps) => {
    const scenario: Scenario = {
      name: 'attempt',
      async seed(db, stripe) {
        await seed(db, stripe)
        await sessionsToMoveBetween(db)
      },
      async run(context) {
        const { bookingId } = (await context.call('createOrder', { customerId: ID.customer, ...order })) as { bookingId: string }
        await steps(bookingId, context)
      },
    }
    return replay(environment, scenario, keepingErrors)
  }
  const moveToLater = async ({ call }: ScenarioContext, bookingId: string) => {
    await call('moveBooking', { bookingId, newSessionId: ID.laterPrivateSession })
    await call('moveBooking', { bookingId, newSessionId: ID.laterPrivateSession, confirmed: true, refundMethod: 'credit' })
  }
  /** £140 paid, moved to £100, and £40 of store credit that landed with its answer lost. */
  const fortyLanded = (bookingId: string, context: ScenarioContext) => creditCantBeTold(() => moveToLater(context, bookingId))
  /** The same, with the store credit really failing. */
  const fortyOwed = (bookingId: string, context: ScenarioContext) => whileFailing(context.db, refundCreditFails, () => moveToLater(context, bookingId))
  const owed = (steps: Steps) =>
    attempt(peakPrivateOnCard, async (bookingId, context) => {
      await fortyOwed(bookingId, context)
      await steps(bookingId, context)
    })
  const guestOnTheReader = async (bookingId: string, call: ScenarioContext['call']) =>
    (await call('addBookingGuest', { bookingId, ...cy, payment: { method: 'reader' } })) as Pending
  const bookingOnTheReader = async (db: Db) => {
    const [line] = await db.query<{ booking_id: string }>(`SELECT booking_id FROM order_line_items WHERE item_type = 'booking'`)
    return line?.booking_id
  }

  describe('It already arrived', () => {
    it('takes what is owed off the booking, moves no money, and says who and why', async () => {
      const recording = await run('owed-arrived-after-a-lost-answer')
      expect(creditMoves(recording)).toEqual(['40.00'])
      expect(refunds(recording)).toEqual([])
      expect(last(recording)).toEqual({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, pricePaid: 100 })
      expect(booking(recording)).toMatchObject({ price_paid: '100.00', refund_owed_amount: '0.00', part_refunded_amount: '0.00' })
      expect(audits(recording, 'booking.refund_owed_arrived')).toEqual([
        expect.objectContaining({ actor_type: 'staff', actor_id: ID.staff, entity_type: 'booking', details: { amount: 40, reason: 'Found on their balance' } }),
      ])
    })

    it('then the customer has had £140 of £140 by the time the booking is cancelled', async () => {
      const recording = await run('owed-arrived-then-cancel')
      expect(creditMoves(recording)).toEqual(['40.00'])
      expect(refunds(recording)).toEqual([10000])
      expect(booking(recording)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
    })

    it('then a same-price move costs nothing and gives nothing', async () => {
      const recording = await run('owed-arrived-then-a-same-price-move')
      expect(refunds(recording)).toEqual([])
      expect(pence(recording, 'paymentIntents.create')).toEqual([14000])
      expect(booking(recording)).toMatchObject({ price_paid: '100.00', session_id: ID.privateSession })
    })

    it('without it, Refund the rest gives the same £40 a second time, so the button is needed', async () => {
      const recording = await attempt(peakPrivateOnCard, async (bookingId, context) => {
        await fortyLanded(bookingId, context)
        await context.call('refundBooking', { bookingId, refundMethod: 'credit', amount: 40, refundOwed: true })
      })
      expect(creditMoves(recording)).toEqual(['40.00', '40.00'])
    })

    it('needs Issue refunds', async () => {
      const recording = await owed(async (bookingId, { call, db }) => {
        await db.query('UPDATE staff SET can_issue_refunds = false')
        await call('refundBooking', { bookingId, ...arrived })
      })
      expect(last(recording)).toMatchObject({ thrown: expect.stringContaining('permission') })
      expect(booking(recording)).toMatchObject({ refund_owed_amount: '40.00', price_paid: '140.00' })
    })

    it.each<[string, unknown, string]>([
      ['no reason', undefined, 'A reason is required for this.'],
      ['a blank reason', '   ', 'A reason is required for this.'],
      ['201 characters', 'x'.repeat(201), 'The reason must be 200 characters or fewer.'],
    ])('%s is refused, and nothing changes', async (_name, reason, message) => {
      const recording = await owed((bookingId, { call }) => call('refundBooking', { bookingId, ...arrived, reason }))
      expect(last(recording)).toEqual({ thrown: message })
      expect(booking(recording)).toMatchObject({ refund_owed_amount: '40.00', price_paid: '140.00' })
      expect(audits(recording, 'booking.refund_owed_arrived')).toEqual([])
    })

    it('200 characters is enough', async () => {
      const recording = await owed((bookingId, { call }) => call('refundBooking', { bookingId, ...arrived, reason: 'x'.repeat(200) }))
      expect(booking(recording)).toMatchObject({ refund_owed_amount: '0.00' })
    })

    it.each<[string, number]>([
      ['more', 41],
      ['less', 39],
    ])('a stale amount, %s than is owed, is refused with the new figures', async (_name, amount) => {
      const recording = await owed((bookingId, { call }) => call('refundBooking', { bookingId, ...arrived, amount }))
      expect(last(recording)).toMatchObject({
        refused: { message: 'The amount owed has changed to £40.00. Check it and confirm again.', figures: { refundOwed: 40, pricePaid: 140 } },
      })
      expect(booking(recording)).toMatchObject({ refund_owed_amount: '40.00' })
    })

    it('nothing owed is refused', async () => {
      const recording = await attempt(noPromoOnCard, (bookingId, { call }) => call('refundBooking', { bookingId, ...arrived }))
      expect(last(recording)).toMatchObject({ refused: { message: 'Nothing is owed on this booking any more.' } })
      expect(booking(recording)).toMatchObject({ price_paid: '100.00' })
    })

    it('with no amount it is refused, and never falls through to Cancel & Refund', async () => {
      const recording = await owed((bookingId, { call }) => call('refundBooking', { bookingId, refundMethod: 'credit', owedArrived: true, reason: 'Found it' }))
      expect(last(recording)).toEqual({ thrown: 'The amount owed is required.' })
      expect(booking(recording)).toMatchObject({ status: 'confirmed', refund_owed_amount: '40.00' })
      expect(refunds(recording)).toEqual([])
    })

    it('a cancelled booking and an open reader are refused', async () => {
      const cancelled = await owed(async (bookingId, { call }) => {
        await call('refundBooking', { bookingId, refundMethod: 'card' })
        await call('refundBooking', { bookingId, ...arrived })
      })
      expect(last(cancelled)).toEqual({ thrown: 'This booking is already cancelled.' })
      const reader = await owed(async (bookingId, { call }) => {
        await guestOnTheReader(bookingId, call)
        await call('refundBooking', { bookingId, ...arrived })
      })
      expect(last(reader)).toEqual({ thrown: OPEN })
    })

    it('if its audit row fails, nothing changes: nothing else would record it', async () => {
      const auditFails: WriteFailure = { table: 'audit_log', event: 'INSERT', when: `NEW.action = 'booking.refund_owed_arrived'` }
      const recording = await owed((bookingId, { call, db }) => whileFailing(db, auditFails, () => call('refundBooking', { bookingId, ...arrived })))
      expect(last(recording)).toEqual({ thrown: 'connection lost' })
      expect(booking(recording)).toMatchObject({ refund_owed_amount: '40.00', price_paid: '140.00' })
    })
  })

  describe('Refund the rest writes audit_log', () => {
    it('with who gave it and how it went', async () => {
      const recording = await owed((bookingId, { call }) => call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true }))
      expect(audits(recording, 'booking.refund_owed')).toEqual([
        expect.objectContaining({
          actor_type: 'staff',
          actor_id: ID.staff,
          entity_type: 'booking',
          details: { amount: 40, method: 'card', cardRefunded: 40, storeCreditRefunded: 0, owed: 0 },
        }),
      ])
    })

    it('if that fails it is a warning, as the money has gone', async () => {
      const auditFails: WriteFailure = { table: 'audit_log', event: 'INSERT', when: `NEW.action = 'booking.refund_owed'` }
      const recording = await owed((bookingId, { call, db }) =>
        whileFailing(db, auditFails, () => call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true }))
      )
      expect(last(recording)).toMatchObject({ cardRefundedAmount: 40, warning: expect.stringContaining('recording it in the audit log failed') })
      expect(booking(recording)).toMatchObject({ refund_owed_amount: '0.00', price_paid: '100.00' })
    })
  })

  describe('money that fails after the claim goes back exactly', () => {
    const declined = (stripe: FakeStripe) => stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })

    it('a part refund that moved nothing: price_paid and part refunds as they were, and nothing owed', async () => {
      const recording = await attempt(noPromoOnCard, async (bookingId, { call, stripe }) => {
        declined(stripe)
        await call('refundBooking', { bookingId, refundMethod: 'card', amount: 30, ...goodwill })
      })
      expect(last(recording)).toMatchObject({ thrown: expect.stringContaining('The card refund failed, so nothing was refunded') })
      expect(booking(recording)).toMatchObject({ price_paid: '100.00', part_refunded_amount: '0.00', refund_owed_amount: '0.00' })
    })

    it('Refund the rest that moved nothing: still owed', async () => {
      const recording = await owed(async (bookingId, { call, stripe }) => {
        declined(stripe)
        await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
      })
      expect(booking(recording)).toMatchObject({ price_paid: '140.00', refund_owed_amount: '40.00' })
    })

    it('Remove Guest that moved nothing: the guest stays with their seat price', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, stripe }) => {
        const { guest } = (await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })) as { guest: { id: string } }
        declined(stripe)
        await call('removeBookingGuest', { guestId: guest.id, confirmedRefundAmount: 20, refundMethod: 'card' })
      })
      expect(last(recording)).toMatchObject({ removed: false })
      expect(booking(recording)).toMatchObject({ price_paid: '60.00', party_size: 3 })
      expect(added(recording, 'booking_guests').map((g) => g['unit_price'])).toContain('20.00')
    })

    it('Cancel & Refund that moved nothing: live again, and the place was never released', async () => {
      const recording = await attempt(noPromoOnCard, async (bookingId, { call, stripe }) => {
        declined(stripe)
        await call('refundBooking', { bookingId, refundMethod: 'card' })
      })
      expect(last(recording)).toMatchObject({ thrown: expect.stringContaining('The card refund failed, so nothing was refunded') })
      expect(booking(recording)).toMatchObject({ status: 'confirmed', cancelled_at: null, price_paid: '100.00' })
    })
  })

  describe('a cancelled booking stays cancelled', () => {
    it('a status change from a screen opened before the cancel is refused, so its money can\'t go twice', async () => {
      const recording = await attempt(noPromoOnCard, async (bookingId, { call }) => {
        await call('refundBooking', { bookingId, refundMethod: 'card' })
        await call('setBookingStatus', { bookingId, status: 'completed' })
        await call('refundBooking', { bookingId, refundMethod: 'card', amount: 100, ...goodwill })
      })
      expect(recording.results[2]).toEqual({ thrown: 'This booking is cancelled, so its status can no longer be changed.' })
      expect(refunds(recording)).toEqual([10000])
      expect(booking(recording)).toMatchObject({ status: 'cancelled' })
    })

    it('a live booking still changes status', async () => {
      const recording = await attempt(noPromoOnCard, (bookingId, { call }) => call('setBookingStatus', { bookingId, status: 'completed' }))
      expect(booking(recording)).toMatchObject({ status: 'completed' })
    })
  })

  describe('a guest on the reader, in price_paid but not collected', () => {
    it('Cancel & Refund is refused, and gives only what was paid once the reader is cancelled', async () => {
      const recording = await run('cancel-while-a-guest-is-on-the-reader')
      expect(recording.results[2]).toEqual({ thrown: OPEN })
      expect(refunds(recording)).toEqual([4000])
      expect(booking(recording)).toMatchObject({ status: 'cancelled' })
    })

    it('Remove Guest is refused, and works once the reader is cancelled', async () => {
      const recording = await run('remove-guest-while-a-guest-is-on-the-reader')
      expect(recording.results.filter((r) => (r as { reason?: string }).reason === 'reader_payment_open')).toHaveLength(1)
      expect(refunds(recording)).toEqual([2000])
    })

    it('a second guest is refused: the first guest\'s money would pay for them', async () => {
      const recording = await run('second-guest-while-a-guest-is-on-the-reader')
      expect(recording.results.filter((r) => (r as { reason?: string }).reason === 'reader_payment_open')).toHaveLength(1)
      expect(booking(recording)).toMatchObject({ party_size: 3, price_paid: '60.00' })
    })

    it('add-ons on their own are refused too', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call }) => {
        await guestOnTheReader(bookingId, call)
        await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }] })
      })
      expect(last(recording)).toEqual({ added: false, reason: 'reader_payment_open', message: OPEN })
    })

    it('removing an add-on still on the reader is refused, as nobody has paid for it', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
        const started = (await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }], payment: { method: 'reader' } })) as Pending
        const [line] = await db.query<{ id: string }>('SELECT id FROM addon_order_lines WHERE booking_id = $1', [bookingId])
        await call('removeBookingAddon', { addonLineId: line?.id, refund: 'credit' })
        await call('cancelReaderPayment', { pendingId: started.pendingReaderPayment.pendingId })
      })
      expect(recording.results[recording.results.length - 2]).toEqual({ removed: false, reason: 'reader_payment_open', message: OPEN })
      expect(creditMoves(recording)).toEqual([])
      expect(added(recording, 'addon_order_lines')).toEqual([])
    })

    it('an add-on paid for already still comes off once the reader has finished', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
        await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }], payment: { method: 'card' } })
        const [line] = await db.query<{ id: string }>('SELECT id FROM addon_order_lines WHERE booking_id = $1', [bookingId])
        await call('removeBookingAddon', { addonLineId: line?.id, refund: 'credit' })
      })
      expect(last(recording)).toMatchObject({ removed: true })
    })

    it('a move is refused, and works once the reader is cancelled', async () => {
      const recording = await run('move-while-a-guest-is-on-the-reader')
      expect(recording.results.filter((r) => (r as { reason?: string }).reason === 'reader_payment_open')).toHaveLength(1)
      expect(booking(recording)).toMatchObject({ session_id: ID.peakSession, price_paid: '51.00' })
    })

    it('a move on a card is refused before the card is charged, not refunded after', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call }) => {
        await guestOnTheReader(bookingId, call)
        await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'card' } })
      })
      expect(last(recording)).toEqual({ moved: false, reason: 'reader_payment_open', message: OPEN })
      expect(pence(recording, 'paymentIntents.create')).toEqual([4000, 2000])
      expect(refunds(recording)).toEqual([])
    })

    it('Cancel & return credit is refused', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
        await guestOnTheReader(bookingId, call)
        await db.query(`UPDATE bookings SET redemption_source = 'session_pass_credit' WHERE id = $1`, [bookingId])
        await call('cancelCreditBooking', { bookingId })
      })
      expect(last(recording)).toEqual({ cancelled: false, reason: 'reader_payment_open', message: OPEN })
    })
  })

  describe('a checkout on the reader, whose rollback deletes the booking', () => {
    const onTheReader = { ...publicOnCard, payment: { method: 'reader' } }

    it.each<[string, (bookingId: string | undefined, call: ScenarioContext['call']) => Promise<unknown>, unknown]>([
      ['Cancel & Refund', (bookingId, call) => call('refundBooking', { bookingId, refundMethod: 'credit' }), { thrown: OPEN }],
      ['Add Guest', (bookingId, call) => call('addBookingGuest', { bookingId, ...bea }), { added: false, reason: 'reader_payment_open', message: OPEN }],
      ['Move', (bookingId, call) => call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'card' } }), { moved: false, reason: 'reader_payment_open', message: OPEN }],
    ])('%s is refused', async (_name, action, answer) => {
      const recording = await attempt(onTheReader, async (_noIdYet, { call, db }) => action(await bookingOnTheReader(db), call))
      expect(last(recording)).toEqual(answer)
      expect(creditMoves(recording)).toEqual([])
    })

    it('Remove Guest is refused', async () => {
      const recording = await attempt(onTheReader, async (_noIdYet, { call, db }) => {
        const [guest] = await db.query<{ id: string }>(`SELECT id FROM booking_guests WHERE guest_type = 'additional_guest' LIMIT 1`)
        await call('removeBookingGuest', { guestId: guest?.id, confirmedRefundAmount: 20, refundMethod: 'credit' })
      })
      expect(last(recording)).toMatchObject({ removed: false, reason: 'reader_payment_open' })
    })

    it('still refused after 15 minutes, until the reader payment is finished or cancelled', async () => {
      const recording = await attempt(onTheReader, async (_noIdYet, { call, db }) => {
        await db.query(`UPDATE orders SET created_at = now() - interval '2 hours'`)
        await call('refundBooking', { bookingId: await bookingOnTheReader(db), refundMethod: 'credit', amount: 10, ...goodwill })
      })
      expect(last(recording)).toEqual({ thrown: OPEN })
    })

    it('an order still being paid counts before its reader payment is written', async () => {
      const recording = await attempt(noPromoOnCard, async (bookingId, { call, db }) => {
        await db.query(`UPDATE orders SET payment_status = 'pending'`)
        await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 10, ...goodwill })
      })
      expect(last(recording)).toEqual({ thrown: OPEN })
    })

    it('an order left pending over 15 minutes no longer blocks the booking', async () => {
      const recording = await attempt(noPromoOnCard, async (bookingId, { call, db }) => {
        await db.query(`UPDATE orders SET payment_status = 'pending', created_at = now() - interval '16 minutes'`)
        await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 10, ...goodwill })
      })
      expect(creditMoves(recording)).toEqual(['10.00'])
    })
  })

  describe('getBookingDetail says when a reader is open', () => {
    const openMessage = async (steps: Steps) => {
      const recording = await attempt(publicOnCard, async (bookingId, context) => {
        await steps(bookingId, context)
        await context.call('getBookingDetail', { bookingId })
      })
      return (last(recording) as { readerPaymentOpenMessage: string | null }).readerPaymentOpenMessage
    }

    it('nothing open', async () => {
      expect(await openMessage(async () => undefined)).toBeNull()
    })

    it('a guest on the reader', async () => {
      expect(await openMessage((bookingId, { call }) => guestOnTheReader(bookingId, call))).toBe(OPEN)
    })

    it('a move on the reader', async () => {
      expect(await openMessage((bookingId, { call }) => call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'reader' } }))).toBe(OPEN)
    })

    it('a reader that was cancelled', async () => {
      const message = await openMessage(async (bookingId, { call }) => {
        const { pendingReaderPayment } = await guestOnTheReader(bookingId, call)
        await call('cancelReaderPayment', { pendingId: pendingReaderPayment.pendingId })
      })
      expect(message).toBeNull()
    })

    // Brief W19a (W19 review S2): a flow the Worker started on a saved card has no finish or cancel button, so the
    // banner gives the Worker's card words, word for word, when every open flow is one; the reader words otherwise.
    // The guest's flow is re-marked as the Worker writes its own (snapshot method and request id).
    const markedAs = (method: 'card' | 'reader') => async (bookingId: string, { call, db }: ScenarioContext) => {
      const { pendingReaderPayment } = await guestOnTheReader(bookingId, call)
      await db.query(`UPDATE pending_reader_payments SET snapshot = snapshot || jsonb_build_object('method', $2::text, 'request_id', 'w19a-request') WHERE id = $1::uuid`, [
        pendingReaderPayment.pendingId,
        method,
      ])
      return pendingReaderPayment.pendingId
    }

    it("a held saved-card flow, the only one open: the Worker's card words", async () => {
      expect(await openMessage(markedAs('card'))).toBe(CARD_PAYMENT_OPEN_MESSAGE)
    })

    it('a flow the Worker started on the reader: the reader words', async () => {
      expect(await openMessage(markedAs('reader'))).toBe(OPEN)
    })

    it('a card method without the Worker\'s request id counts as old: the reader words', async () => {
      const message = await openMessage(async (bookingId, context) => {
        const pendingId = await markedAs('card')(bookingId, context)
        await context.db.query(`UPDATE pending_reader_payments SET snapshot = snapshot - 'request_id' WHERE id = $1::uuid`, [pendingId])
      })
      expect(message).toBe(OPEN)
    })

    it('a saved-card flow beside an old reader flow: the reader words', async () => {
      const message = await openMessage(async (bookingId, context) => {
        const pendingId = await markedAs('card')(bookingId, context)
        // A second open flow on the booking, copied from the first as an old one (no method, no request id).
        await context.db.query(
          `INSERT INTO pending_reader_payments
           SELECT (jsonb_populate_record(NULL::pending_reader_payments,
                     to_jsonb(p) || jsonb_build_object('id', '00000000-0000-4000-8000-000000000a19', 'snapshot', p.snapshot - 'method' - 'request_id'))).*
           FROM pending_reader_payments p WHERE p.id = $1::uuid`,
          [pendingId]
        )
      })
      expect(message).toBe(OPEN)
    })

    it('a held saved-card flow beside an old flow that has finished: the card words (only open flows count)', async () => {
      const message = await openMessage(async (bookingId, context) => {
        const pendingId = await markedAs('card')(bookingId, context)
        await context.db.query(
          `INSERT INTO pending_reader_payments
           SELECT (jsonb_populate_record(NULL::pending_reader_payments,
                     to_jsonb(p) || jsonb_build_object('id', '00000000-0000-4000-8000-000000000a19', 'status', 'cancelled', 'snapshot', p.snapshot - 'method' - 'request_id'))).*
           FROM pending_reader_payments p WHERE p.id = $1::uuid`,
          [pendingId]
        )
      })
      expect(message).toBe(CARD_PAYMENT_OPEN_MESSAGE)
    })

    it('a saved-card flow that has finished: nothing open', async () => {
      const message = await openMessage(async (bookingId, context) => {
        const pendingId = await markedAs('card')(bookingId, context)
        await context.db.query(`UPDATE pending_reader_payments SET status = 'finalised' WHERE id = $1::uuid`, [pendingId])
      })
      expect(message).toBeNull()
    })
  })

  describe('a reader payment that can\'t be set up writes nothing', () => {
    const noIntent = (stripe: FakeStripe) => stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.connection() })

    it('Move: the booking stays, and its store credit part goes back', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, stripe }) => {
        noIntent(stripe)
        await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'reader', storeCredit: { amount: 5 } } })
      })
      expect(last(recording)).toMatchObject({ moved: false, reason: 'move_failed', message: expect.stringContaining('nothing was charged') })
      expect(booking(recording)).toMatchObject({ session_id: ID.session, price_paid: '40.00' })
      expect(added(recording, 'pending_reader_payments')).toEqual([])
      expect(added(recording, 'store_credit_transactions').map((row) => row['amount'])).toEqual(['-5.00', '5.00'])
    })

    it('Add Guest: no guest, and the place goes back', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, stripe }) => {
        noIntent(stripe)
        await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'reader' } })
      })
      expect(last(recording)).toMatchObject({ added: false, reason: 'guest_add_failed', message: expect.stringContaining('nothing was charged') })
      expect(booking(recording)).toMatchObject({ party_size: 2, price_paid: '40.00' })
      expect(added(recording, 'pending_reader_payments')).toEqual([])
    })
  })

  describe('Settle on the reader', () => {
    const lapsed = async (bookingId: string, db: Db) => {
      await db.query(`UPDATE bookings SET status = 'payment_needed', price_paid = 0, redemption_source = 'membership_credit' WHERE id = $1`, [bookingId])
      await db.query(`UPDATE booking_guests SET pay_by = 'membership_credit' WHERE booking_id = $1 AND guest_type = 'account_holder'`, [bookingId])
    }

    it('writes the booking, seat one and the pending row together, and refunds wait for it', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
        await lapsed(bookingId, db)
        await call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })
        await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 5, ...goodwill })
      })
      expect(last(recording)).toEqual({ thrown: OPEN })
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '20.00' })
      expect(added(recording, 'pending_reader_payments')).toEqual([expect.objectContaining({ flow: 'settle', status: 'pending' })])
      expect(added(recording, 'booking_guests').filter((g) => g['guest_type'] === 'account_holder').map((g) => g['pay_by'])).toEqual(['paid'])
    })

    it('cancelling the reader puts it all back', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
        await lapsed(bookingId, db)
        const started = (await call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })) as Pending
        await call('cancelReaderPayment', { pendingId: started.pendingReaderPayment.pendingId })
      })
      expect(booking(recording)).toMatchObject({ status: 'payment_needed', price_paid: '0.00' })
    })

    it('a reader that can\'t be set up writes nothing, and its store credit part goes back', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db, stripe }) => {
        await lapsed(bookingId, db)
        stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.connection() })
        await call('settleLapsedBooking', { bookingId, payment: { method: 'reader', storeCredit: { amount: 5 } } })
      })
      expect(last(recording)).toMatchObject({ settled: false, reason: 'settle_undo_failed', message: expect.stringContaining('nothing was charged') })
      expect(booking(recording)).toMatchObject({ status: 'payment_needed', price_paid: '0.00' })
      expect(added(recording, 'store_credit_transactions').map((row) => row['amount'])).toEqual(['-5.00', '5.00'])
    })

    it('settled in cash, seat one still becomes paid', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
        await lapsed(bookingId, db)
        await call('settleLapsedBooking', { bookingId, payment: { method: 'cash', confirmedCashAmount: 20 } })
      })
      expect(last(recording)).toMatchObject({ settled: true })
      expect(added(recording, 'booking_guests').filter((g) => g['guest_type'] === 'account_holder').map((g) => g['pay_by'])).toEqual(['paid'])
    })
  })

  describe('a cancelled reader move takes off only what the move added', () => {
    const startMove = async (bookingId: string, call: ScenarioContext['call']) =>
      (await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'reader' } })) as Pending

    it('so a refund that failed while it was opening isn\'t lost', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
        const started = await startMove(bookingId, call)
        // The put-back of a refund that was claimed before the move read the booking.
        await db.query('UPDATE bookings SET price_paid = price_paid + 30 WHERE id = $1', [bookingId])
        await call('cancelReaderPayment', { pendingId: started.pendingReaderPayment.pendingId })
      })
      expect(booking(recording)).toMatchObject({ session_id: ID.session, price_paid: '70.00' })
    })

    it('a row written before this release still goes back to the figure it recorded', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
        const started = await startMove(bookingId, call)
        await db.query(`UPDATE pending_reader_payments SET snapshot = snapshot - 'price_paid_change'`)
        await call('cancelReaderPayment', { pendingId: started.pendingReaderPayment.pendingId })
      })
      expect(booking(recording)).toMatchObject({ session_id: ID.session, price_paid: '40.00' })
    })
  })

  describe('a guest\'s seat after a removal that couldn\'t finish', () => {
    const guestDeleteFails: WriteFailure = { table: 'booking_guests', event: 'DELETE', when: 'true' }

    it('the card money stays off the seat, so pressing Remove again refunds nothing more', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
        const { guest } = (await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })) as { guest: { id: string } }
        await whileFailing(db, guestDeleteFails, () => call('removeBookingGuest', { guestId: guest.id, confirmedRefundAmount: 20, refundMethod: 'card' }))
        await call('removeBookingGuest', { guestId: guest.id, confirmedRefundAmount: 0 })
      })
      expect(refunds(recording)).toEqual([2000])
      expect(last(recording)).toMatchObject({ removed: true, refundedAmount: 0 })
      expect(booking(recording)).toMatchObject({ price_paid: '40.00', party_size: 2 })
    })

    it('store credit taken back goes back on the seat, for the retry', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
        const { guest } = (await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })) as { guest: { id: string } }
        const removal = { guestId: guest.id, confirmedRefundAmount: 20, refundMethod: 'credit' }
        await whileFailing(db, guestDeleteFails, () => call('removeBookingGuest', removal))
        await call('removeBookingGuest', removal)
      })
      expect(creditMoves(recording)).toEqual(['20.00', '-20.00', '20.00'])
      expect(booking(recording)).toMatchObject({ price_paid: '40.00', party_size: 2 })
    })
  })

  describe('Cancel & Refund that fails at the end', () => {
    it('goes back to the status it had, and the place was never released', async () => {
      const recording = await attempt(noPromoOnCard, async (bookingId, { call, db }) => {
        await whileFailing(db, cancelWriteFails, () => call('refundBooking', { bookingId, refundMethod: 'card' }))
      })
      expect(booking(recording)).toMatchObject({ status: 'confirmed', cancelled_at: null, price_paid: '0.00', part_refunded_amount: '100.00' })
      expect(refunds(recording)).toEqual([10000])
    })
  })
})
