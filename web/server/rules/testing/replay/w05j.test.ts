import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import type { Recording } from './compare'
import { backendDir, oldSide, replay, startReplay, type ReplayEnvironment, type ReplaySide, type Scenario, type ScenarioContext } from './harness'
import {
  bea,
  creditCantBeTold,
  creditRefund,
  dyingAfter,
  goodwill,
  ID,
  laterPublicSession,
  losingTheAnswer,
  losingTheWorkersAnswer,
  noPromoOnCard,
  publicOnCard,
  refundCreditFails,
  sam,
  seed,
  sessionsToMoveBetween,
  whileFailing,
  type WriteFailure,
} from './scenarios'

// W05j on the old functions: keys and an unclear outcome on the refund paths W05i left
// (event cancellations, refundOrder, the reader rollbacks, createOrder's subscription undo), store
// credit read back after a database error, and an unfinished charge matched on its key.
// Events: two places at £40, £80 on the saved card. Products: soap £12, two of them, £24 on the card.

const REFUND_PATH = '/api/payments/refund-order'
const CHARGE_PATH = '/api/payments/charge-saved-card'
const HELD = "Check Stripe, but don't refund it there by hand: pressing again first finds out whether it went, and can't pay it twice."

type Row = Record<string, unknown>

const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
const calls = (recording: Recording, method: string) => recording.stripeCalls.filter((call) => call.method === method)
const refundKeys = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey)
const creditMoves = (recording: Recording) =>
  added(recording, 'store_credit_transactions')
    .filter((row) => row['reason'] === 'refund')
    .map((row) => row['amount'])
const last = (recording: Recording) => recording.results[recording.results.length - 1]

const keepingErrors = (db: Db, stripe: FakeStripe): ReplaySide => {
  const side = oldSide(db, stripe)
  return { ...side, call: (action, params) => side.call(action, params).catch((err: Error) => ({ thrown: err.message })) }
}

const eventPlaces = {
  eventId: ID.event,
  accountHolderAttending: true,
  guestsOver18Confirmed: true,
  attendees: [
    { ...sam, isAccountHolder: true },
    { name: 'Alex Guest', email: 'alex@example.com', isAccountHolder: false },
  ],
}
const soap = { productVariantId: ID.variant, quantity: 2, unitPrice: 12, systemUnitPrice: 12 }
const refusal = () => fakeStripeErrors.invalid('charge_disputed', 'This charge is disputed.')
const heldFails: WriteFailure = { table: 'audit_log', event: 'INSERT', when: `NEW.action = 'card_refund_held'` }

describe('W05j on the old functions', () => {
  let environment: ReplayEnvironment

  beforeAll(async () => {
    environment = await startReplay()
  })
  afterAll(() => environment.stop())

  const fullSeed = async (db: Db, stripe: FakeStripe) => {
    await seed(db, stripe)
    await sessionsToMoveBetween(db)
    await laterPublicSession(db)
  }

  /** An order, then `steps` with what it made. */
  const attempt = (order: Record<string, unknown>, steps: (placed: Row, context: ScenarioContext) => Promise<unknown>) => {
    const scenario: Scenario = {
      name: 'attempt',
      seed: fullSeed,
      async run(context) {
        const placed = (await context.call('createOrder', { customerId: ID.customer, ...order })) as Row
        if (placed['success'] !== true) throw new Error(`The order failed: ${JSON.stringify(placed)}`)
        await steps(placed, context)
      },
    }
    return replay(environment, scenario, keepingErrors)
  }

  const balance = async (db: Db) =>
    Number((await db.query<{ store_credit_balance: string }>('SELECT store_credit_balance FROM customers WHERE id = $1', [ID.customer]))[0]?.store_credit_balance)

  describe('event cancellations', () => {
    const onCard = { event: eventPlaces, payment: { method: 'card' } }
    const placesOf = async (db: Db, eventBookingId: unknown) => {
      const rows = await db.query<{ id: string; cancelled_at: string | null; card_refunded_amount: string }>(
        'SELECT id, cancelled_at, to_char(card_refunded_amount, \'FM990.00\') AS card_refunded_amount FROM event_attendees WHERE event_booking_id = $1 ORDER BY created_at, id',
        [eventBookingId as string]
      )
      return rows
    }
    const eventLine = async (db: Db, eventBookingId: unknown) =>
      (await db.query<{ card_refunded_amount: string }>(`SELECT to_char(card_refunded_amount, 'FM990.00') AS card_refunded_amount FROM order_line_items WHERE event_booking_id = $1 AND item_type = 'event'`, [eventBookingId as string]))[0]
        ?.card_refunded_amount
    const cancel = (context: ScenarioContext, eventBookingId: unknown, attendeeIds: string[] | undefined, refund: string) =>
      context.call('cancelEventPlaces', { eventBookingId, ...(attendeeIds ? { attendeeIds } : {}), refund }) as Promise<Row>

    it('card refund, answer lost: nothing cancelled, says so, and pressing again refunds £40 once', async () => {
      const recording = await attempt(onCard, async (placed, context) => {
        const [first] = await placesOf(context.db, placed['eventBookingId'])
        await losingTheWorkersAnswer(REFUND_PATH, () => cancel(context, placed['eventBookingId'], [first!.id], 'card'))
        expect(context.stripe.refundedPence).toBe(4000)
        expect((await placesOf(context.db, placed['eventBookingId']))[0]?.cancelled_at).toBeNull()
        await cancel(context, placed['eventBookingId'], [first!.id], 'card')
        expect(context.stripe.refundedPence).toBe(4000)
        const [a, b] = await placesOf(context.db, placed['eventBookingId'])
        expect(a).toMatchObject({ cancelled_at: expect.anything(), card_refunded_amount: '40.00' })
        expect(b?.cancelled_at).toBeNull()
        expect(await eventLine(context.db, placed['eventBookingId'])).toBe('40.00')
        const keys = refundKeys(context.stripe)
        expect(keys).toHaveLength(2)
        expect(keys[0]).toMatch(/^event-refund:/)
        expect(keys[1]).toBe(keys[0])
      })
      expect(recording.results[1]).toMatchObject({ ok: false, reason: 'refund_unsure', message: expect.stringContaining(HELD) })
      expect(last(recording)).toMatchObject({ ok: true, places: 1, cardRefundedAmount: 0, refundedAmount: 40 })
    })

    it('pressed again choosing store credit: the earlier refund is settled first, so no store credit goes', async () => {
      const recording = await attempt(onCard, async (placed, context) => {
        const [first] = await placesOf(context.db, placed['eventBookingId'])
        await losingTheWorkersAnswer(REFUND_PATH, () => cancel(context, placed['eventBookingId'], [first!.id], 'card'))
        await cancel(context, placed['eventBookingId'], [first!.id], 'credit')
        expect(context.stripe.refundedPence).toBe(4000)
      })
      expect(creditMoves(recording)).toEqual([])
      expect(last(recording)).toMatchObject({ ok: true, refundedAmount: 40, storeCreditRefundedAmount: 0 })
    })

    it('then the other place: it uses the settled £40, and the first place later is a new £40, so £80 in all', async () => {
      await attempt(onCard, async (placed, context) => {
        const [first, second] = await placesOf(context.db, placed['eventBookingId'])
        await losingTheWorkersAnswer(REFUND_PATH, () => cancel(context, placed['eventBookingId'], [first!.id], 'card'))
        const other = await cancel(context, placed['eventBookingId'], [second!.id], 'card')
        expect(other).toMatchObject({ ok: true, refundedAmount: 40 })
        expect(context.stripe.refundedPence).toBe(4000)
        const firstAgain = await cancel(context, placed['eventBookingId'], [first!.id], 'card')
        expect(firstAgain).toMatchObject({ ok: true, cardRefundedAmount: 40 })
        expect(context.stripe.refundedPence).toBe(8000)
        const keys = refundKeys(context.stripe)
        // The lost one, its resend, and the first place's own: a settled refund isn't sent again.
        expect(keys).toHaveLength(3)
        expect(new Set(keys).size).toBe(2)
        expect(await eventLine(context.db, placed['eventBookingId'])).toBe('80.00')
      })
    })

    it('the function dies after the refund: pressing again gets the same refund back', async () => {
      await attempt(onCard, async (placed, context) => {
        const [first] = await placesOf(context.db, placed['eventBookingId'])
        await dyingAfter(REFUND_PATH, () => cancel(context, placed['eventBookingId'], [first!.id], 'card'))
        await cancel(context, placed['eventBookingId'], [first!.id], 'card')
        expect(context.stripe.refundedPence).toBe(4000)
        const keys = refundKeys(context.stripe)
        expect(keys[0]).toBeTruthy()
        expect(keys[1]).toBe(keys[0])
      })
    })

    it('a definite no: the next press has a new key, so it can work', async () => {
      const recording = await attempt(onCard, async (placed, context) => {
        const [first] = await placesOf(context.db, placed['eventBookingId'])
        context.stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
        await cancel(context, placed['eventBookingId'], [first!.id], 'card')
        await cancel(context, placed['eventBookingId'], [first!.id], 'card')
        expect(context.stripe.refundedPence).toBe(4000)
        const [one, two] = refundKeys(context.stripe)
        expect(one).toBeTruthy()
        expect(two).not.toBe(one)
      })
      expect(recording.results[1]).toMatchObject({ ok: false, reason: 'refund_failed' })
      expect(last(recording)).toMatchObject({ ok: true })
    })

    it('still no clear answer on the next press: it stops again, and the third finishes with one refund', async () => {
      const recording = await attempt(onCard, async (placed, context) => {
        const [first] = await placesOf(context.db, placed['eventBookingId'])
        await losingTheWorkersAnswer(REFUND_PATH, () => cancel(context, placed['eventBookingId'], [first!.id], 'card'))
        context.stripe.failNext('refunds.create', { kind: 'lost_response' })
        await cancel(context, placed['eventBookingId'], [first!.id], 'credit')
        await cancel(context, placed['eventBookingId'], [first!.id], 'card')
        expect(context.stripe.refundedPence).toBe(4000)
      })
      expect(recording.results[2]).toMatchObject({ ok: false, reason: 'refund_unsure' })
      expect(last(recording)).toMatchObject({ ok: true, refundedAmount: 40 })
      expect(creditMoves(recording)).toEqual([])
    })

    it('if the hold can\'t be written, it says so, and the same press again gets the first refund back', async () => {
      const recording = await attempt(onCard, async (placed, context) => {
        const [first] = await placesOf(context.db, placed['eventBookingId'])
        await whileFailing(context.db, heldFails, () =>
          losingTheWorkersAnswer(REFUND_PATH, () => cancel(context, placed['eventBookingId'], [first!.id], 'card'))
        )
        await cancel(context, placed['eventBookingId'], [first!.id], 'card')
        expect(context.stripe.refundedPence).toBe(4000)
      })
      expect(recording.results[1]).toMatchObject({ reason: 'refund_unsure', warning: expect.stringContaining('only with Card on the same places') })
      expect(last(recording)).toMatchObject({ ok: true })
    })

    it('a death on one place, then the other place at the same figures: a refund of its own, and the first place later gets its first refund back', async () => {
      await attempt(onCard, async (placed, context) => {
        const [first, second] = await placesOf(context.db, placed['eventBookingId'])
        await dyingAfter(REFUND_PATH, () => cancel(context, placed['eventBookingId'], [first!.id], 'card'))
        await cancel(context, placed['eventBookingId'], [second!.id], 'card')
        expect(context.stripe.refundedPence).toBe(8000)
        const [a, b] = refundKeys(context.stripe)
        expect(b).not.toBe(a)
      })
    })

    it('two places refunded one at a time: two real refunds, as each is a different refund', async () => {
      await attempt(onCard, async (placed, context) => {
        const [first, second] = await placesOf(context.db, placed['eventBookingId'])
        await cancel(context, placed['eventBookingId'], [first!.id], 'card')
        await cancel(context, placed['eventBookingId'], [second!.id], 'card')
        expect(context.stripe.refundedPence).toBe(8000)
      })
    })

    it('cancel the whole event: the lost answer fails that booking with the words, and running it again refunds once', async () => {
      const recording = await attempt(onCard, async (_placed, context) => {
        await losingTheWorkersAnswer(REFUND_PATH, () => context.call('cancelEvent', { eventId: ID.event, refund: 'card', reason: 'Storm' }))
        await context.call('cancelEvent', { eventId: ID.event, refund: 'card', reason: 'Storm' })
        expect(context.stripe.refundedPence).toBe(8000)
      })
      expect(recording.results[1]).toMatchObject({ ok: true, results: [{ ok: false, message: expect.stringContaining(HELD) }] })
      expect(last(recording)).toMatchObject({ ok: true, results: [{ ok: true, places: 2 }] })
    })

    describe('store credit', () => {
      it('answer lost: it is found by its note, so the places are cancelled and a second press gives nothing', async () => {
        const recording = await attempt(onCard, async (placed, context) => {
          const [first] = await placesOf(context.db, placed['eventBookingId'])
          await losingTheAnswer(creditRefund, () => cancel(context, placed['eventBookingId'], [first!.id], 'credit'))
          await cancel(context, placed['eventBookingId'], [first!.id], 'credit')
        })
        expect(recording.results[1]).toMatchObject({ ok: true, storeCreditRefundedAmount: 40 })
        expect(recording.results[1]).not.toHaveProperty('warning')
        expect(creditMoves(recording)).toEqual(['40.00'])
      })

      it('answer lost and it can\'t be looked for: counted as given, with a warning to check', async () => {
        const recording = await attempt(onCard, async (placed, context) => {
          const [first] = await placesOf(context.db, placed['eventBookingId'])
          await creditCantBeTold(() => cancel(context, placed['eventBookingId'], [first!.id], 'credit'))
          await cancel(context, placed['eventBookingId'], [first!.id], 'credit')
        })
        expect(recording.results[1]).toMatchObject({ ok: true, warning: expect.stringContaining('gave no clear answer') })
        expect(creditMoves(recording)).toEqual(['40.00'])
      })

      it('the credit never landed: a clear no, nothing cancelled, and the next press gives it once', async () => {
        const recording = await attempt(onCard, async (placed, context) => {
          const [first] = await placesOf(context.db, placed['eventBookingId'])
          await whileFailing(context.db, refundCreditFails, () => cancel(context, placed['eventBookingId'], [first!.id], 'credit'))
          await cancel(context, placed['eventBookingId'], [first!.id], 'credit')
        })
        expect(recording.results[1]).toMatchObject({ ok: false, reason: 'store_credit_failed' })
        expect(creditMoves(recording)).toEqual(['40.00'])
      })

      it('recording fails after store credit that can\'t be looked for: it isn\'t taken back blind, and staff are told to check', async () => {
        const bookingFails: WriteFailure = { table: 'event_bookings', event: 'UPDATE', when: 'true' }
        const recording = await attempt(onCard, async (placed, context) => {
          const [first] = await placesOf(context.db, placed['eventBookingId'])
          await whileFailing(context.db, bookingFails, () => creditCantBeTold(() => cancel(context, placed['eventBookingId'], [first!.id], 'credit')))
        })
        expect(last(recording)).toMatchObject({ ok: false, warning: expect.stringContaining("still can't be checked") })
        expect(creditMoves(recording)).toEqual(['40.00'])
      })

      it('recording fails after store credit found by its note: it is taken back, as before', async () => {
        const bookingFails: WriteFailure = { table: 'event_bookings', event: 'UPDATE', when: 'true' }
        const recording = await attempt(onCard, async (placed, context) => {
          const [first] = await placesOf(context.db, placed['eventBookingId'])
          await whileFailing(context.db, bookingFails, () => losingTheAnswer(creditRefund, () => cancel(context, placed['eventBookingId'], [first!.id], 'credit')))
        })
        expect(last(recording)).toMatchObject({ ok: false, warning: expect.stringContaining('was taken back') })
        expect(creditMoves(recording)).toEqual(['40.00', '-40.00'])
      })

      it('its note carries a reference, so it can be found', async () => {
        await attempt(onCard, async (placed, context) => {
          const [first] = await placesOf(context.db, placed['eventBookingId'])
          await cancel(context, placed['eventBookingId'], [first!.id], 'credit')
          const notes = await context.db.query<{ note: string }>(`SELECT note FROM store_credit_transactions WHERE reason = 'refund'`)
          expect(notes[0]?.note).toMatch(/^Event refund: Full Moon Sauna\. \[ref [0-9a-f-]{36}\]$/)
        })
      })
    })
  })

  describe('refundOrder', () => {
    const onCard = { products: [soap], payment: { method: 'card' } }
    const soapLine = async (db: Db, orderId: unknown) =>
      (await db.query<{ id: string }>(`SELECT id FROM order_line_items WHERE order_id = $1 AND item_type = 'product'`, [orderId as string]))[0]!.id
    const refund = async (context: ScenarioContext, orderId: unknown, refundMethod: string) => {
      const lineId = await soapLine(context.db, orderId)
      return context.call('refundOrder', { orderId, lineItemIds: [lineId], refundMethod, restock: { [lineId]: false } }) as Promise<Row>
    }
    const lineOf = async (db: Db, orderId: unknown) =>
      (await db.query<Row>(`SELECT refunded_at, refund_method, to_char(card_refunded_amount, 'FM990.00') AS card_refunded_amount FROM order_line_items WHERE order_id = $1 AND item_type = 'product'`, [orderId as string]))[0]

    it('card, answer lost: nothing done, says so, and pressing again refunds £24 once', async () => {
      const recording = await attempt(onCard, async (placed, context) => {
        await losingTheWorkersAnswer(REFUND_PATH, () => refund(context, placed['orderId'], 'card'))
        expect(await lineOf(context.db, placed['orderId'])).toMatchObject({ refunded_at: null, card_refunded_amount: '0.00' })
        await refund(context, placed['orderId'], 'card')
        expect(context.stripe.refundedPence).toBe(2400)
        expect(await lineOf(context.db, placed['orderId'])).toMatchObject({ refunded_at: expect.anything(), refund_method: 'card', card_refunded_amount: '24.00' })
        const keys = refundKeys(context.stripe)
        expect(keys[0]).toMatch(/^order-refund:/)
        expect(keys[1]).toBe(keys[0])
      })
      expect(recording.results[1]).toMatchObject({ success: false, reason: 'refund_unsure', message: expect.stringContaining(HELD) })
      expect(last(recording)).toMatchObject({ success: true })
    })

    it('pressed again choosing store credit: the earlier refund counts, so no store credit goes', async () => {
      const recording = await attempt(onCard, async (placed, context) => {
        await losingTheWorkersAnswer(REFUND_PATH, () => refund(context, placed['orderId'], 'card'))
        await refund(context, placed['orderId'], 'credit')
        expect(context.stripe.refundedPence).toBe(2400)
        expect(await lineOf(context.db, placed['orderId'])).toMatchObject({ refunded_at: expect.anything(), refund_method: 'card' })
      })
      expect(creditMoves(recording)).toEqual([])
    })

    it('the function dies after the refund: pressing again gets the same refund back', async () => {
      await attempt(onCard, async (placed, context) => {
        await dyingAfter(REFUND_PATH, () => refund(context, placed['orderId'], 'card'))
        await refund(context, placed['orderId'], 'card')
        expect(context.stripe.refundedPence).toBe(2400)
        const [one, two] = refundKeys(context.stripe)
        expect(one).toBeTruthy()
        expect(two).toBe(one)
      })
    })

    it('a definite no: the next press has a new key, so it can work', async () => {
      const recording = await attempt(onCard, async (placed, context) => {
        context.stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
        await refund(context, placed['orderId'], 'card')
        await refund(context, placed['orderId'], 'card')
        expect(context.stripe.refundedPence).toBe(2400)
        const [one, two] = refundKeys(context.stripe)
        expect(one).toBeTruthy()
        expect(two).not.toBe(one)
      })
      expect(recording.results[1]).toMatchObject({ success: false, reason: 'refund_failed' })
      expect(last(recording)).toMatchObject({ success: true })
    })

    describe('two lines', () => {
      const mug = { productVariantId: ID.mugVariant, quantity: 1, unitPrice: 15, systemUnitPrice: 15, fulfillmentMethod: 'pickup' }
      const twoLines = { products: [soap, mug], payment: { method: 'card' } }
      const linesOf = async (db: Db, orderId: unknown) =>
        (await db.query<{ id: string }>(`SELECT id FROM order_line_items WHERE order_id = $1 AND item_type = 'product' ORDER BY created_at, id`, [orderId as string])).map((r) => r.id)
      const refundLines = (context: ScenarioContext, orderId: unknown, ids: string[]) =>
        context.call('refundOrder', { orderId, lineItemIds: ids, refundMethod: 'card', restock: Object.fromEntries(ids.map((id) => [id, false])) }) as Promise<Row>

      it('a death, then the same lines chosen in the other order: the same refund, not a second', async () => {
        const recording = await attempt(twoLines, async (placed, context) => {
          const ids = await linesOf(context.db, placed['orderId'])
          await dyingAfter(REFUND_PATH, () => refundLines(context, placed['orderId'], ids))
          await refundLines(context, placed['orderId'], [...ids].reverse())
          expect(context.stripe.refundedPence).toBe(3900)
          const [one, two] = refundKeys(context.stripe)
          expect(two).toBe(one)
        })
        expect(last(recording)).toMatchObject({ success: true, cardRefundedAmount: 39 })
      })

      it('a death on one line, then another line at the same figures: a refund of its own', async () => {
        await attempt({ products: [soap, { ...soap, quantity: 2 }], payment: { method: 'card' } }, async (placed, context) => {
          const [first, second] = await linesOf(context.db, placed['orderId'])
          await dyingAfter(REFUND_PATH, () => refundLines(context, placed['orderId'], [first!]))
          await refundLines(context, placed['orderId'], [second!])
          const [a, b] = refundKeys(context.stripe)
          expect(b).not.toBe(a)
          expect(context.stripe.refundedPence).toBe(4800)
        })
      })
    })

    it('store credit that can\'t be looked for, then a later write fails: still reported as given, never as nothing refunded', async () => {
      const stampFails: WriteFailure = { table: 'order_line_items', event: 'UPDATE', when: 'NEW.refunded_at IS NOT NULL' }
      const recording = await attempt(onCard, async (placed, context) => {
        await whileFailing(context.db, stampFails, () => creditCantBeTold(() => refund(context, placed['orderId'], 'credit')))
      })
      expect(last(recording)).toMatchObject({ success: true, warning: expect.stringContaining('gave no clear answer') })
    })

    it('store credit, answer lost: found by its note, a clear yes, and given once', async () => {
      const recording = await attempt(onCard, async (placed, context) => {
        await losingTheAnswer(creditRefund, () => refund(context, placed['orderId'], 'credit'))
        await refund(context, placed['orderId'], 'credit')
      })
      expect(recording.results[1]).toMatchObject({ success: true, storeCreditRefundedAmount: 24 })
      expect(recording.results[1]).not.toHaveProperty('warning')
      expect(last(recording)).toMatchObject({ success: false, reason: 'already_refunded' })
      expect(creditMoves(recording)).toEqual(['24.00'])
    })

    it('store credit that can\'t be looked for: counted as given, the line stamped, with a warning to check', async () => {
      const recording = await attempt(onCard, async (placed, context) => {
        await creditCantBeTold(() => refund(context, placed['orderId'], 'credit'))
        expect(await lineOf(context.db, placed['orderId'])).toMatchObject({ refunded_at: expect.anything(), refund_method: 'credit' })
      })
      expect(recording.results[1]).toMatchObject({ success: true, warning: expect.stringContaining('gave no clear answer') })
      expect(creditMoves(recording)).toEqual(['24.00'])
    })

    it('store credit that never landed: a clear no, nothing stamped', async () => {
      const recording = await attempt(onCard, async (placed, context) => {
        await whileFailing(context.db, refundCreditFails, () => refund(context, placed['orderId'], 'credit'))
        expect(await lineOf(context.db, placed['orderId'])).toMatchObject({ refunded_at: null })
      })
      expect(recording.results[1]).toMatchObject({ success: false, reason: 'store_credit_failed' })
      expect(creditMoves(recording)).toEqual([])
    })
  })

  describe('reader order rollback', () => {
    const markPaidFails: WriteFailure = { table: 'orders', event: 'UPDATE', when: `NEW.payment_status = 'paid'` }
    const tappedThenFails = async (context: ScenarioContext) => {
      const placed = (await context.call('createOrder', { customerId: ID.customer, products: [soap], payment: { method: 'reader' } })) as {
        orderId: string
        pendingReaderPayment: { paymentIntentId: string }
      }
      context.stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      return placed
    }
    const run = (steps: (context: ScenarioContext) => Promise<void>) =>
      replay(environment, { name: 'attempt', seed: fullSeed, run: steps }, keepingErrors)
    const orderExists = async (db: Db, orderId: string) => (await db.query('SELECT id FROM orders WHERE id = $1', [orderId])).length > 0

    it('the refund\'s answer is lost: says it may have gone, nothing given back yet, and Resolve gets the same refund back', async () => {
      const recording = await run(async (context) => {
        const placed = await tappedThenFails(context)
        await whileFailing(context.db, markPaidFails, () =>
          losingTheWorkersAnswer(REFUND_PATH, () => context.call('finaliseReaderOrder', { orderId: placed.orderId }))
        )
        expect(await orderExists(context.db, placed.orderId)).toBe(true)
        await context.call('cancelReaderOrder', { orderId: placed.orderId })
        expect(await orderExists(context.db, placed.orderId)).toBe(false)
        expect(context.stripe.refundedPence).toBe(2400)
        const [one, two] = refundKeys(context.stripe)
        expect(one).toMatch(/^reader-order-refund:/)
        expect(two).toBe(one)
      })
      expect(recording.results[1]).toMatchObject({ finalised: false, reason: 'refund_unsure', message: expect.stringContaining('may have gone through') })
      expect(last(recording)).toMatchObject({ cancelled: true })
    })

    it('a definite no: the next run has a new key, so it can work', async () => {
      const recording = await run(async (context) => {
        const placed = await tappedThenFails(context)
        context.stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
        await whileFailing(context.db, markPaidFails, () => context.call('finaliseReaderOrder', { orderId: placed.orderId }))
        await context.call('cancelReaderOrder', { orderId: placed.orderId })
        expect(context.stripe.refundedPence).toBe(2400)
        const [one, two] = refundKeys(context.stripe)
        expect(one).toBeTruthy()
        expect(two).not.toBe(one)
      })
      expect(recording.results[1]).toMatchObject({ reason: 'refund_failed' })
      expect(last(recording)).toMatchObject({ cancelled: true })
    })
  })

  describe('finaliseReaderPayment', () => {
    it('recording fails and the refund\'s answer is lost: its own outcome, with a key', async () => {
      const recording = await attempt(publicOnCard, async (placed, context) => {
        const moved = (await context.call('moveBooking', {
          bookingId: placed['bookingId'],
          newSessionId: ID.peakSession,
          confirmed: true,
          payment: { method: 'reader' },
        })) as { pendingReaderPayment: { pendingId: string; paymentIntentId: string } }
        const { pendingId, paymentIntentId } = moved.pendingReaderPayment
        context.stripe.completeReaderPayment(paymentIntentId)
        const fails: WriteFailure = { table: 'orders', event: 'INSERT', when: 'true' }
        await whileFailing(context.db, fails, () => losingTheWorkersAnswer(REFUND_PATH, () => context.call('finaliseReaderPayment', { pendingId })))
        expect(context.stripe.refundedPence).toBe(1100)
        expect(refundKeys(context.stripe)[0]).toMatch(/^reader-undo:/)
      })
      // W05k: the move is undone whatever the refund said, and the words no longer say to redo it.
      expect(last(recording)).toMatchObject({
        finalised: false,
        reason: 'refund_unsure',
        message: expect.stringContaining('The booking move was undone. The automatic refund of £11.00 gave no clear answer'),
      })
    })
  })

  describe('createOrder: the subscription undo', () => {
    it('a later step fails and the refund\'s answer is lost: says it may have gone, with a key', async () => {
      const recording = await replay(
        environment,
        {
          name: 'attempt',
          seed: fullSeed,
          async run(context) {
            const fails: WriteFailure = { table: 'customer_memberships', event: 'INSERT', when: 'true' }
            await whileFailing(context.db, fails, () =>
              losingTheWorkersAnswer(REFUND_PATH, () =>
                context.call('createOrder', {
                  customerId: ID.customer,
                  membershipPlanId: ID.plan,
                  membershipBillingFrequency: 'monthly',
                  membershipIdempotencyKey: 'w05j-membership',
                  payment: { method: 'card' },
                })
              )
            )
          },
        },
        keepingErrors
      )
      expect(last(recording)).toMatchObject({ success: false, message: expect.stringContaining('may have gone through') })
      expect(calls(recording, 'refunds.create')[0]?.idempotencyKey).toMatch(/^subscription-undo:/)
    })
  })

  describe('store credit read back on the booking refunds', () => {
    const part = (amount: number) => ({ refundMethod: 'credit', amount, ...goodwill })
    const bookingRow = (recording: Recording) => added(recording, 'bookings')[0]

    it('Part refund £40, answer lost: found, so a clear yes, nothing owed', async () => {
      const recording = await attempt(noPromoOnCard, async (placed, { call }) => {
        await losingTheAnswer(creditRefund, () => call('refundBooking', { bookingId: placed['bookingId'], ...part(40) }))
      })
      expect(last(recording)).not.toHaveProperty('unsure')
      expect(creditMoves(recording)).toEqual(['40.00'])
      expect(bookingRow(recording)).toMatchObject({ price_paid: '60.00', part_refunded_amount: '40.00', refund_owed_amount: '0.00' })
    })

    it('Part refund £40, answer lost and the look fails too: unsure, and owed, as before', async () => {
      const recording = await attempt(noPromoOnCard, async (placed, { call }) => {
        await creditCantBeTold(() => call('refundBooking', { bookingId: placed['bookingId'], ...part(40) }))
      })
      expect(last(recording)).toMatchObject({ unsure: expect.anything() })
      expect(bookingRow(recording)).toMatchObject({ refund_owed_amount: '40.00' })
    })

    it('Part refund £40, never landed: a clear no, nothing refunded', async () => {
      const recording = await attempt(noPromoOnCard, async (placed, { call, db }) => {
        await whileFailing(db, refundCreditFails, () => call('refundBooking', { bookingId: placed['bookingId'], ...part(40) }))
      })
      expect(last(recording)).not.toHaveProperty('unsure')
      expect(creditMoves(recording)).toEqual([])
      expect(bookingRow(recording)).toMatchObject({ price_paid: '100.00', refund_owed_amount: '0.00' })
    })

    it('Cancel & Refund, answer lost: cancelled, with the credit given once', async () => {
      const recording = await attempt(noPromoOnCard, async (placed, { call }) => {
        await losingTheAnswer(creditRefund, () => call('refundBooking', { bookingId: placed['bookingId'], refundMethod: 'credit' }))
        await call('refundBooking', { bookingId: placed['bookingId'], refundMethod: 'credit' })
      })
      expect(recording.results[1]).toMatchObject({ storeCreditRefundedAmount: 100 })
      expect(last(recording)).toMatchObject({ thrown: 'This booking is already cancelled.' })
      expect(creditMoves(recording)).toEqual(['100.00'])
      expect(bookingRow(recording)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
    })

    it('Remove Guest, answer lost: removed, with the credit given once', async () => {
      const recording = await attempt(publicOnCard, async (placed, { call }) => {
        const guest = (await call('addBookingGuest', { bookingId: placed['bookingId'], ...bea, payment: { method: 'card' } })) as { guest: { id: string } }
        await losingTheAnswer(creditRefund, () => call('removeBookingGuest', { guestId: guest.guest.id, confirmedRefundAmount: 20, refundMethod: 'credit' }))
      })
      expect(last(recording)).toMatchObject({ removed: true })
      expect(creditMoves(recording)).toEqual(['20.00'])
      expect(bookingRow(recording)).toMatchObject({ party_size: 2, refund_owed_amount: '0.00' })
    })

    it('Remove add-on, answer lost: found, nothing owed', async () => {
      const towel = { addonId: ID.addon, quantity: 1, unitPrice: 5, systemUnitPrice: 5, redemptionSource: 'paid' }
      const order = { booking: { ...(noPromoOnCard as { booking: object }).booking, addons: [towel] }, payment: { method: 'card' } }
      const recording = await attempt(order, async (placed, { call, db }) => {
        const addonLineId = (await db.query<{ id: string }>('SELECT id FROM addon_order_lines WHERE booking_id = $1', [placed['bookingId'] as string]))[0]?.id
        await losingTheAnswer(creditRefund, () => call('removeBookingAddon', { addonLineId, refund: 'credit' }))
      })
      expect(last(recording)).toMatchObject({ removed: true })
      expect(last(recording)).not.toHaveProperty('warning')
      expect(creditMoves(recording)).toEqual(['5.00'])
      expect(bookingRow(recording)).toMatchObject({ refund_owed_amount: '0.00' })
    })
  })

  describe('the reader screens', () => {
    // Read from the source, as W05i's dialog tests are: they prove the branch is there, not how it looks.
    const frontend = (file: string) => readFileSync(path.join(backendDir, '../../frontend/components', file), 'utf8')
    it.each(['AddGuestDialog.tsx', 'SettleLapsedPaymentDialog.tsx', 'MoveBookingDialog.tsx'])(
      '%s treats a refund with no clear answer like a failed one: check Stripe, do not retry',
      (file) => {
        expect(frontend(file)).toMatch(/finalise\?\.reason === 'refund_failed' \|\| finalise\?\.reason === 'refund_unsure'/)
      }
    )
    // W14a: New Order decides it in one helper for finalise and for a cancel that finalised instead
    // (readerAlertIsCritical, tested by what it does in server/staff-app-checkout.test.ts).
    it('CheckoutDialog does the same, on finalise and when a cancel finalised instead', () => {
      expect(frontend('CheckoutDialog.tsx')).toContain('const critical = readerAlertIsCritical(finalise)')
      expect(frontend('CheckoutDialog.tsx')).toContain('critical: readerAlertIsCritical(cancelResult.finaliseResult)')
      expect(readFileSync(path.join(backendDir, '../../frontend/utils/orderAnswers.ts'), 'utf8')).toMatch(/'refund_failed',\n  'refund_unsure',/)
    })
  })

  describe('an unfinished charge is matched on its flow and key', () => {
    const privateOnCard = { booking: { ...(noPromoOnCard as { booking: object }).booking }, payment: { method: 'card' } }

    it('a Move that died after its £40 charge is no reason for an Add Guest of £40 to skip its store credit', async () => {
      const recording = await attempt(privateOnCard, async (placed, { call, db, stripe }) => {
        const bookingId = placed['bookingId']
        await dyingAfter(CHARGE_PATH, () => call('moveBooking', { bookingId, newSessionId: ID.peakPrivateSession, confirmed: true, payment: { method: 'card' } }))
        const before = await balance(db)
        const charged = stripe.netPence
        await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card', storeCredit: { amount: 10 } } })
        expect(await balance(db)).toBe(before - 10)
        expect(stripe.netPence).toBe(charged + 4000)
      })
      expect(last(recording)).toMatchObject({ added: true })
      const redeemed = added(recording, 'store_credit_transactions').filter((row) => row['reason'] === 'redemption')
      expect(redeemed.map((row) => row['amount'])).toEqual(['-10.00'])
    })

    it('the same press after a death still resumes: the parts are taken once', async () => {
      const recording = await attempt(publicOnCard, async (placed, { call, db, stripe }) => {
        const guest = { bookingId: placed['bookingId'], ...bea, payment: { method: 'card', storeCredit: { amount: 5 } } }
        const before = await balance(db)
        await dyingAfter(CHARGE_PATH, () => call('addBookingGuest', guest))
        await call('addBookingGuest', guest)
        expect(await balance(db)).toBe(before - 5)
        expect(stripe.chargedByIntent.size).toBe(2)
      })
      expect(last(recording)).toMatchObject({ added: true })
      const started = added(recording, 'audit_log').filter((row) => row['action'] === 'booking.card_charge_started')
      expect(started).toHaveLength(2)
    })
  })
})
