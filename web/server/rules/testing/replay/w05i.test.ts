import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { insert } from '../database'
import type { Recording } from './compare'
import { backendDir, oldSide, replay, startReplay, type ReplayEnvironment, type ReplaySide, type Scenario, type ScenarioContext } from './harness'
import {
  bea,
  cancelWriteFails,
  creditRefund,
  dyingAfter,
  goodwill,
  ID,
  laterPublicSession,
  creditCantBeTold,
  losingTheWorkersAnswer,
  memberCredit,
  mo,
  noPromoOnCard,
  paidSeat,
  peakPrivateOnCard,
  publicOnCard,
  publicPeakOnCard,
  seed,
  sessionsToMoveBetween,
  whileFailing,
  type WriteFailure,
} from './scenarios'

// The W05 release review's proofs, as tests on the old functions. Private: up to two people £100 at
// Core and £140 at Peak, three or four £150 and £190. Public: two seats £40 at Core and £51 at Peak,
// a third seat £20. "Owed" is bookings.refund_owed_amount. The two-connection races are in
// refund-races.test.ts.

const UNSURE = 'This may have gone through. Check Stripe or their balance, then use It already arrived or Refund the rest.'
const REFUND_PATH = '/api/payments/refund-order'
const CHARGE_PATH = '/api/payments/charge-saved-card'
const arrived = (amount: number) => ({ refundMethod: 'credit', amount, owedArrived: true, reason: 'Found on their balance' })
const towel = { addonId: ID.addon, quantity: 1 }

type Query = (sql: string, params?: unknown[]) => Promise<unknown>
type Row = Record<string, unknown>

const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
const calls = (recording: Recording, method: string) => recording.stripeCalls.filter((call) => call.method === method)
const pence = (recording: Recording, method: string) => calls(recording, method).map((call) => (call.params as { amount: number }).amount)
const refunds = (recording: Recording) => pence(recording, 'refunds.create')
const charges = (recording: Recording) => pence(recording, 'paymentIntents.create')
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

/** Runs `gap` once, just before the first statement that matches: another staff member getting in. */
function beforeStatement(matches: RegExp, gap: () => Promise<unknown>): () => void {
  const real = (globalThis as unknown as { paddockData: { query: Query } }).paddockData
  const restore = () => vi.stubGlobal('paddockData', real)
  vi.stubGlobal('paddockData', {
    async query(sql: string, params: unknown[] = []) {
      if (matches.test(sql)) {
        restore()
        await gap()
      }
      return real.query(sql, params)
    },
  })
  return restore
}

/** The first statement that matches fails, as a lost connection would. */
function failOnce(matches: RegExp): void {
  const real = (globalThis as unknown as { paddockData: { query: Query } }).paddockData
  vi.stubGlobal('paddockData', {
    async query(sql: string, params: unknown[] = []) {
      if (matches.test(sql)) {
        vi.stubGlobal('paddockData', real)
        throw new Error('connection lost')
      }
      return real.query(sql, params)
    },
  })
}

type Steps = (bookingId: string, context: ScenarioContext) => Promise<unknown>

describe('W05i on the old functions', () => {
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

  /** An order, then `steps`. Not in `scenarios`: each says what it proves here. */
  const attempt = (order: Record<string, unknown>, steps: Steps, customerId: string = ID.customer) => {
    const scenario: Scenario = {
      name: 'attempt',
      seed: fullSeed,
      async run(context) {
        const placed = (await context.call('createOrder', { customerId, ...order })) as { bookingId: string }
        if (!placed.bookingId) throw new Error(`The order failed: ${JSON.stringify(placed)}`)
        await steps(placed.bookingId, context)
      },
    }
    return replay(environment, scenario, keepingErrors)
  }
  const part = (amount: number, refundMethod: string) => ({ refundMethod, amount, ...goodwill })
  const sessionsBooked = async (db: Db, ...ids: string[]) => {
    const rows = await db.query<{ id: string; total_booked: number }>('SELECT id, total_booked FROM sessions WHERE id = ANY($1::uuid[])', [ids])
    return ids.map((id) => rows.find((row) => row.id === id)?.total_booked)
  }
  const customer = async (db: Db, id: string = ID.customer) =>
    (await db.query<{ store_credit_balance: string }>('SELECT store_credit_balance FROM customers WHERE id = $1', [id]))[0]?.store_credit_balance
  const giftCardBalance = async (db: Db) =>
    (await db.query<{ remaining_balance: string }>('SELECT remaining_balance FROM gift_cards WHERE id = $1', [ID.giftCard]))[0]?.remaining_balance
  const ordersFor = (db: Db, paymentIntentId: string) => db.query<Row>('SELECT id FROM orders WHERE stripe_payment_intent_id = $1', [paymentIntentId])

  describe('finding 1: an unclear answer is its own outcome', () => {
    describe('the review\'s four rows', () => {
      it('part refund £40 to store credit, answer lost: says so, stays owed, and It already arrived clears it', async () => {
        const recording = await attempt(noPromoOnCard, async (bookingId, { call }) => {
          await creditCantBeTold(() => call('refundBooking', { bookingId, ...part(40, 'credit') }))
          await call('refundBooking', { bookingId, ...arrived(40) })
        })
        expect(recording.results[1]).toMatchObject({ unsure: { message: UNSURE } })
        expect(creditMoves(recording)).toEqual(['40.00'])
        expect(booking(recording)).toMatchObject({ price_paid: '60.00', part_refunded_amount: '40.00', refund_owed_amount: '0.00' })
      })

      it('part refund £40 to store credit, pressed again: the second is a new £40, and the booking counts both', async () => {
        const recording = await attempt(noPromoOnCard, async (bookingId, { call }) => {
          await creditCantBeTold(() => call('refundBooking', { bookingId, ...part(40, 'credit') }))
          await call('refundBooking', { bookingId, ...part(40, 'credit') })
          await call('refundBooking', { bookingId, ...arrived(40) })
        })
        expect(creditMoves(recording)).toEqual(['40.00', '40.00'])
        expect(booking(recording)).toMatchObject({ price_paid: '20.00', part_refunded_amount: '80.00', refund_owed_amount: '0.00' })
      })

      it('Cancel & Refund to store credit, answer lost: back to live, all of it owed, and nothing paid twice', async () => {
        const recording = await attempt(noPromoOnCard, async (bookingId, { call }) => {
          await creditCantBeTold(() => call('refundBooking', { bookingId, refundMethod: 'credit' }))
          await call('getBookingRefundFigures', { bookingId })
          await call('refundBooking', { bookingId, ...arrived(100) })
          await call('refundBooking', { bookingId, refundMethod: 'credit' })
        })
        expect(recording.results[1]).toMatchObject({ unsure: { message: UNSURE } })
        expect(recording.results[2]).toMatchObject({ status: 'confirmed', pricePaid: 100, refundOwed: 100, left: 0 })
        expect(creditMoves(recording)).toEqual(['100.00'])
        expect(booking(recording)).toMatchObject({ status: 'cancelled', price_paid: '0.00', refund_owed_amount: '0.00' })
      })

      it('Remove Guest to store credit, answer lost: locked, the guest stays at £0, and the £20 is owed', async () => {
        let guestId = ''
        const recording = await attempt(publicOnCard, async (bookingId, { call }) => {
          const added = (await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })) as { guest: { id: string } }
          guestId = added.guest.id
          await creditCantBeTold(() => call('removeBookingGuest', { guestId, confirmedRefundAmount: 20, refundMethod: 'credit' }))
          await call('removeBookingGuest', { guestId })
          await call('getBookingRefundFigures', { bookingId })
          await call('refundBooking', { bookingId, ...arrived(20) })
          await call('removeBookingGuest', { guestId, confirmedRefundAmount: 0 })
        })
        expect(recording.results[2]).toMatchObject({ removed: false, retryLocked: true, message: expect.stringContaining(UNSURE) })
        expect(recording.results[3]).toMatchObject({ quote: { refundAmount: 0 } })
        expect(recording.results[4]).toMatchObject({ pricePaid: 60, refundOwed: 20, left: 40 })
        expect(last(recording)).toMatchObject({ removed: true, refundedAmount: 0 })
        expect(creditMoves(recording)).toEqual(['20.00'])
        expect(booking(recording)).toMatchObject({ price_paid: '40.00', party_size: 2, refund_owed_amount: '0.00' })
      })

      it('part refund £40 to the card, answer lost: Refund the rest gets the first refund back, and a cancel gives the other £60', async () => {
        const recording = await attempt(noPromoOnCard, async (bookingId, { call, stripe }) => {
          await losingTheWorkersAnswer(REFUND_PATH, () => call('refundBooking', { bookingId, ...part(40, 'card') }))
          expect(stripe.refundedPence).toBe(4000)
          await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
          expect(stripe.refundedPence).toBe(4000)
          await call('refundBooking', { bookingId, refundMethod: 'card' })
          expect(stripe.refundedPence).toBe(10000)
        })
        expect(recording.results[1]).toMatchObject({ unsure: { message: UNSURE } })
        const keys = calls(recording, 'refunds.create').map((call) => call.idempotencyKey)
        expect(keys[0]).toBeTruthy()
        expect(keys[1]).toBe(keys[0])
        expect(keys[2]).not.toBe(keys[0])
        expect(creditMoves(recording)).toEqual([])
        expect(booking(recording)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
      })
    })

    it('Cancel & Refund to the card, answer lost: pressing again finishes it with the first refund', async () => {
      const recording = await attempt(noPromoOnCard, async (bookingId, { call, stripe }) => {
        await losingTheWorkersAnswer(REFUND_PATH, () => call('refundBooking', { bookingId, refundMethod: 'card' }))
        await call('refundBooking', { bookingId, refundMethod: 'card' })
        expect(stripe.refundedPence).toBe(10000)
      })
      expect(recording.results[1]).toMatchObject({ unsure: { message: UNSURE } })
      expect(last(recording)).toMatchObject({ cardRefundedAmount: 100 })
      expect(booking(recording)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
      expect(added(recording, 'order_line_items')[0]).toMatchObject({ card_refunded_amount: '100.00' })
    })

    it('Remove Guest to the card, answer lost: Refund the rest gets the first refund back', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, stripe }) => {
        const added = (await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })) as { guest: { id: string } }
        const removal = { guestId: added.guest.id, confirmedRefundAmount: 20, refundMethod: 'card' }
        await losingTheWorkersAnswer(REFUND_PATH, () => call('removeBookingGuest', removal))
        await call('refundBooking', { bookingId, refundMethod: 'card', amount: 20, refundOwed: true })
        expect(stripe.refundedPence).toBe(2000)
      })
      expect(recording.results[2]).toMatchObject({ removed: false, retryLocked: true })
      expect(booking(recording)).toMatchObject({ price_paid: '40.00', party_size: 3, refund_owed_amount: '0.00' })
    })

    it('a cheaper move to the card, answer lost: moved, owed, and Refund the rest gets the first refund back', async () => {
      const recording = await attempt(peakPrivateOnCard, async (bookingId, { call, stripe }) => {
        const confirmed = { bookingId, newSessionId: ID.laterPrivateSession, confirmed: true, refundMethod: 'card' }
        await losingTheWorkersAnswer(REFUND_PATH, () => call('moveBooking', confirmed))
        await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
        expect(stripe.refundedPence).toBe(4000)
      })
      expect(recording.results[1]).toMatchObject({ moved: true, warning: expect.stringContaining(UNSURE) })
      expect(booking(recording)).toMatchObject({ price_paid: '100.00', refund_owed_amount: '0.00' })
    })

    it('Refund the rest, answer lost: still owed, with the words that say so', async () => {
      const recording = await attempt(peakPrivateOnCard, async (bookingId, { call, stripe }) => {
        stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        await call('moveBooking', { bookingId, newSessionId: ID.laterPrivateSession, confirmed: true, refundMethod: 'card' })
        await creditCantBeTold(() => call('refundBooking', { bookingId, refundMethod: 'credit', amount: 40, refundOwed: true }))
        await call('refundBooking', { bookingId, ...arrived(40) })
      })
      expect(recording.results[2]).toMatchObject({ unsure: { message: UNSURE } })
      expect(creditMoves(recording)).toEqual(['40.00'])
      expect(booking(recording)).toMatchObject({ price_paid: '100.00', refund_owed_amount: '0.00' })
    })

    describe('Remove add-on', () => {
      const orderWithTowel = { booking: { ...(noPromoOnCard as { booking: object }).booking, addons: [{ ...towel, unitPrice: 5, systemUnitPrice: 5, redemptionSource: 'paid' }] }, payment: { method: 'card' } }
      const lineOf = async (db: Db, bookingId: string) => (await db.query<{ id: string }>('SELECT id FROM addon_order_lines WHERE booking_id = $1', [bookingId]))[0]?.id

      it('to the card, answer lost: the add-on stays removed and the money is owed, not refunded again', async () => {
        const recording = await attempt(orderWithTowel, async (bookingId, { call, db }) => {
          const addonLineId = await lineOf(db, bookingId)
          await losingTheWorkersAnswer(REFUND_PATH, () => call('removeBookingAddon', { addonLineId, refund: 'card' }))
          await call('removeBookingAddon', { addonLineId, refund: 'card' })
          await call('refundBooking', { bookingId, ...arrived(5) })
        })
        expect(recording.results[1]).toMatchObject({ removed: true, warning: expect.stringContaining(UNSURE) })
        expect(recording.results[2]).toMatchObject({ removed: false, reason: 'already_removed' })
        expect(refunds(recording)).toEqual([500])
        expect(calls(recording, 'refunds.create')[0]?.idempotencyKey).toBeTruthy()
        expect(booking(recording)).toMatchObject({ price_paid: '100.00', refund_owed_amount: '0.00' })
      })

      it('to store credit, answer lost: the same', async () => {
        const recording = await attempt(orderWithTowel, async (bookingId, { call, db }) => {
          const addonLineId = await lineOf(db, bookingId)
          await creditCantBeTold(() => call('removeBookingAddon', { addonLineId, refund: 'credit' }))
          await call('removeBookingAddon', { addonLineId, refund: 'credit' })
        })
        expect(recording.results[1]).toMatchObject({ removed: true, warning: expect.stringContaining(UNSURE) })
        expect(creditMoves(recording)).toEqual(['5.00'])
        expect(booking(recording)).toMatchObject({ price_paid: '105.00', refund_owed_amount: '5.00' })
      })

      it('a decline is still a clear no: the add-on goes back on the booking', async () => {
        const recording = await attempt(orderWithTowel, async (bookingId, { call, db, stripe }) => {
          const addonLineId = await lineOf(db, bookingId)
          stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
          await call('removeBookingAddon', { addonLineId, refund: 'card' })
        })
        expect(added(recording, 'addon_order_lines')[0]).toMatchObject({ removed_at: null })
        expect(booking(recording)).toMatchObject({ price_paid: '100.00', refund_owed_amount: '0.00' })
      })

      it('a decline is definite, so the next press has a new key and can work', async () => {
        const recording = await attempt(orderWithTowel, async (bookingId, { call, db, stripe }) => {
          const addonLineId = await lineOf(db, bookingId)
          stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
          await call('removeBookingAddon', { addonLineId, refund: 'card' })
          await call('removeBookingAddon', { addonLineId, refund: 'card' })
          expect(stripe.refundedPence).toBe(500)
        })
        expect(last(recording)).toMatchObject({ removed: true, cardRefundedAmount: 5 })
      })

      it('on a cancelled booking, answer lost: nothing owed, as no button could give it, and the words say to check by hand', async () => {
        const recording = await attempt(orderWithTowel, async (bookingId, { call, db }) => {
          await call('refundBooking', { bookingId, refundMethod: 'card' })
          const addonLineId = await lineOf(db, bookingId)
          await losingTheWorkersAnswer(REFUND_PATH, () => call('removeBookingAddon', { addonLineId, refund: 'card' }))
        })
        expect(last(recording)).toMatchObject({ removed: true, warning: expect.stringContaining('may have gone through') })
        expect(last(recording)).toMatchObject({ warning: expect.not.stringContaining('Refund the rest') })
        expect(booking(recording)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
      })
    })

    describe('what counts as unclear', () => {
      const pressing = (stubbed: (real: { path: string }) => unknown) =>
        attempt(noPromoOnCard, async (bookingId, { call }) => {
          const real = (globalThis as unknown as { paddockBackendApi2: { rawRequest: (r: { path: string }) => Promise<unknown> } }).paddockBackendApi2
          vi.stubGlobal('paddockBackendApi2', {
            rawRequest: async (request: { path: string }) => (request.path === REFUND_PATH ? stubbed(request) : real.rawRequest(request)),
          })
          await call('refundBooking', { bookingId, ...part(40, 'card') })
          vi.stubGlobal('paddockBackendApi2', real)
        })

      it('an HTML page', async () => {
        const recording = await pressing(() => ({ data: { message: '<!DOCTYPE html><html>Bad gateway</html>' } }))
        expect(last(recording)).toMatchObject({ unsure: { message: UNSURE } })
        expect(booking(recording)).toMatchObject({ price_paid: '100.00', refund_owed_amount: '40.00' })
      })

      it('an answer that is neither a success nor an error', async () => {
        const recording = await pressing(() => ({ data: {} }))
        expect(last(recording)).toMatchObject({ unsure: { message: UNSURE } })
      })

      it('the Worker losing Stripe\'s answer: its JSON says so, and the money stays owed', async () => {
        const recording = await attempt(noPromoOnCard, async (bookingId, { call, stripe }) => {
          stripe.failNext('refunds.create', { kind: 'lost_response' })
          await call('refundBooking', { bookingId, ...part(40, 'card') })
          await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
          expect(stripe.refundedPence).toBe(4000)
        })
        expect(recording.results[1]).toMatchObject({ unsure: { message: UNSURE } })
        expect(booking(recording)).toMatchObject({ price_paid: '60.00', refund_owed_amount: '0.00' })
      })

      it('Stripe\'s own server error, which can\'t say whether the refund happened', async () => {
        const recording = await attempt(noPromoOnCard, async (bookingId, { call, stripe }) => {
          stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.server() })
          await call('refundBooking', { bookingId, ...part(40, 'card') })
        })
        expect(last(recording)).toMatchObject({ unsure: { message: UNSURE } })
      })

      it('a refusal from Stripe stays a clear no: everything goes back, and the words say nothing was refunded', async () => {
        const recording = await attempt(noPromoOnCard, async (bookingId, { call, stripe }) => {
          stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
          await call('refundBooking', { bookingId, ...part(40, 'card') })
        })
        expect(last(recording)).toMatchObject({ thrown: expect.stringContaining('nothing was refunded') })
        expect(booking(recording)).toMatchObject({ price_paid: '100.00', part_refunded_amount: '0.00', refund_owed_amount: '0.00' })
      })

      it('a store credit refusal from the database stays a clear no', async () => {
        const recording = await attempt(noPromoOnCard, async (bookingId, { call, db }) => {
          await db.query(`UPDATE bookings SET customer_id = customer_id WHERE id = $1`, [bookingId])
          const real = (globalThis as unknown as { paddockData: { query: Query } }).paddockData
          vi.stubGlobal('paddockData', {
            query: (sql: string, params: unknown[] = []) =>
              creditRefund(sql, params) ? Promise.resolve({ data: [{ result: { ok: false, reason: 'customer_not_found' } }] }) : real.query(sql, params),
          })
          await call('refundBooking', { bookingId, ...part(40, 'credit') })
          vi.stubGlobal('paddockData', real)
        })
        expect(last(recording)).toMatchObject({ thrown: expect.stringContaining('nothing was refunded') })
        expect(booking(recording)).toMatchObject({ price_paid: '100.00', part_refunded_amount: '0.00', refund_owed_amount: '0.00' })
      })
    })

    describe('part of the money went, then the answer was lost', () => {
      // £100 on the first order and a guest's £50 on the second: refunds go newest first.
      const twoCards = (steps: Steps) =>
        attempt(noPromoOnCard, async (bookingId, context) => {
          await context.call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })
          await steps(bookingId, context)
        })
      const secondRefundLost = async (steps: () => Promise<unknown>) => {
        const real = (globalThis as unknown as { paddockBackendApi2: { rawRequest: (r: { path: string }) => Promise<unknown> } }).paddockBackendApi2
        let seen = 0
        vi.stubGlobal('paddockBackendApi2', {
          async rawRequest(request: { path: string }) {
            const answer = await real.rawRequest(request)
            if (request.path === REFUND_PATH && ++seen === 2) throw new Error('socket hang up')
            return answer
          },
        })
        await steps()
        vi.stubGlobal('paddockBackendApi2', real)
      }

      it('the rest never spills to store credit, which would pay it twice', async () => {
        const recording = await twoCards(async (bookingId, { call }) => {
          await secondRefundLost(() => call('refundBooking', { bookingId, refundMethod: 'card', amount: 60, ...goodwill }))
        })
        expect(creditMoves(recording)).toEqual([])
        expect(last(recording)).toMatchObject({ cardRefundedAmount: 50, warning: expect.stringContaining(UNSURE) })
        expect(booking(recording)).toMatchObject({ price_paid: '100.00', refund_owed_amount: '10.00', part_refunded_amount: '60.00' })
      })

      it('Refund the rest gets that refund back, though price_paid has changed since', async () => {
        const recording = await twoCards(async (bookingId, { call, stripe }) => {
          await secondRefundLost(() => call('refundBooking', { bookingId, refundMethod: 'card', amount: 60, ...goodwill }))
          await call('refundBooking', { bookingId, refundMethod: 'card', amount: 10, refundOwed: true })
          expect(stripe.refundedPence).toBe(6000)
        })
        expect(last(recording)).toMatchObject({ cardRefundedAmount: 10 })
        expect(creditMoves(recording)).toEqual([])
        const keys = calls(recording, 'refunds.create').map((call) => call.idempotencyKey)
        expect(keys[keys.length - 1]).toBe(keys[keys.length - 2])
        expect(booking(recording)).toMatchObject({ price_paid: '90.00', refund_owed_amount: '0.00' })
      })

      it('Cancel & Refund: back to live, what went recorded, and what is unclear owed', async () => {
        const recording = await twoCards(async (bookingId, { call }) => {
          await secondRefundLost(() => call('refundBooking', { bookingId, refundMethod: 'card' }))
        })
        expect(last(recording)).toMatchObject({ unsure: { message: expect.stringContaining(UNSURE) } })
        expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '100.00', refund_owed_amount: '100.00' })
        expect(added(recording, 'order_line_items').map((line) => line['card_refunded_amount'])).toEqual(['0.00', '50.00'])
      })

      it('Cancel & Refund with the card gone and the store credit answer lost: the same', async () => {
        const recording = await attempt({ ...noPromoOnCard, payment: { method: 'card', storeCredit: { amount: 10 } } }, async (bookingId, { call }) => {
          await creditCantBeTold(() => call('refundBooking', { bookingId, refundMethod: 'card' }))
        })
        expect(last(recording)).toMatchObject({ unsure: { message: expect.stringContaining(UNSURE) } })
        expect(refunds(recording)).toEqual([9000])
        expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '10.00', refund_owed_amount: '10.00' })
      })
    })

    describe('the keys', () => {
      it('a decline is a definite answer, so the next press has a new key and can work', async () => {
        const recording = await attempt(noPromoOnCard, async (bookingId, { call, stripe }) => {
          stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
          await call('refundBooking', { bookingId, ...part(40, 'card') })
          await call('refundBooking', { bookingId, ...part(40, 'card') })
          expect(stripe.refundedPence).toBe(4000)
        })
        const [first, second] = calls(recording, 'refunds.create').map((call) => call.idempotencyKey)
        expect(first).toBeTruthy()
        expect(second).not.toBe(first)
        expect(booking(recording)).toMatchObject({ price_paid: '60.00', refund_owed_amount: '0.00' })
      })

      it('the same amount on the same figures again, after the first was recorded, is a new refund', async () => {
        const recording = await attempt(noPromoOnCard, async (bookingId, { call, stripe }) => {
          // £100 less £50, then a cash guest in the next tier brings price_paid back to £100.
          await call('refundBooking', { bookingId, ...part(50, 'card') })
          await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'cash', confirmedCashAmount: 50 } })
          await call('refundBooking', { bookingId, ...part(50, 'card') })
          expect(stripe.refundedPence).toBe(10000)
        })
        expect(refunds(recording)).toEqual([5000, 5000])
      })

      it('a charge reversed by the same action has a key of its own', async () => {
        const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
          const fails: WriteFailure = { table: 'booking_guests', event: 'INSERT', when: 'true' }
          await whileFailing(db, fails, () => call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } }))
        })
        expect(calls(recording, 'refunds.create')[0]?.idempotencyKey).toBeTruthy()
      })
    })
  })

  describe('finding 2: a reader undo runs once', () => {
    const moved = (context: ScenarioContext, bookingId: string) =>
      context.call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'reader', storeCredit: { amount: 5 } } }) as Promise<{
        pendingReaderPayment: { pendingId: string; paymentIntentId: string }
      }>
    const expectUndoneOnce = async (context: ScenarioContext, bookingId: string) => {
      const [row] = await context.db.query<{ price_paid: string; session_id: string }>('SELECT price_paid, session_id FROM bookings WHERE id = $1', [bookingId])
      expect(row).toMatchObject({ price_paid: '40.00', session_id: ID.session })
      expect(await customer(context.db)).toBe('30.00')
      expect(await sessionsBooked(context.db, ID.session, ID.peakSession)).toEqual([2, 0])
    }

    it('its mark failing leaves nothing done, so the second cancel does the undo, once', async () => {
      await attempt(publicOnCard, async (bookingId, context) => {
        const { pendingReaderPayment } = await moved(context, bookingId)
        failOnce(/UPDATE pending_reader_payments/)
        await context.call('cancelReaderPayment', { pendingId: pendingReaderPayment.pendingId })
        await context.call('cancelReaderPayment', { pendingId: pendingReaderPayment.pendingId })
        await expectUndoneOnce(context, bookingId)
      })
    })

    it('the sweep and staff at once: the one that loses the claim undoes nothing', async () => {
      await attempt(publicOnCard, async (bookingId, context) => {
        const { pendingReaderPayment } = await moved(context, bookingId)
        const { pendingId } = pendingReaderPayment
        const restore = beforeStatement(/UPDATE pending_reader_payments/, () => context.call('cancelReaderPayment', { pendingId }))
        await context.call('cancelReaderPayment', { pendingId })
        restore()
        await expectUndoneOnce(context, bookingId)
      })
    })

    it('a finalise that refunds and undoes, its mark failing, undoes once', async () => {
      await attempt(publicOnCard, async (bookingId, context) => {
        const { pendingReaderPayment } = await moved(context, bookingId)
        const { pendingId, paymentIntentId } = pendingReaderPayment
        context.stripe.completeReaderPayment(paymentIntentId)
        const fails: WriteFailure = { table: 'orders', event: 'INSERT', when: 'true' }
        await whileFailing(context.db, fails, async () => {
          failOnce(/UPDATE pending_reader_payments/)
          await context.call('finaliseReaderPayment', { pendingId })
          // Nothing was refunded or undone by that press, so nothing can be done twice.
          expect(context.stripe.refundedPence).toBe(0)
          await context.call('finaliseReaderPayment', { pendingId })
        })
        expect(context.stripe.refundedPence).toBe(600)
        await expectUndoneOnce(context, bookingId)
      })
    })
  })

  describe('finding 3: Settle has a way back', () => {
    const lapsed = (steps: Steps) =>
      attempt(
        { booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} },
        async (bookingId, context) => {
          await context.db.query(`UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 day' WHERE id = $1`, [bookingId])
          await context.db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.member])
          await steps(bookingId, context)
        },
        ID.member
      )

    it('its last statement fails: the charge is reversed, and pressing again takes £20 in all', async () => {
      const recording = await lapsed(async (bookingId, { call, stripe }) => {
        failOnce(/WITH bk AS[\s\S]*SET status = 'confirmed'/)
        await call('settleLapsedBooking', { bookingId, payment: { method: 'card' } })
        expect(stripe.netPence).toBe(0)
        await call('settleLapsedBooking', { bookingId, payment: { method: 'card' } })
        expect(stripe.netPence).toBe(2000)
      })
      expect(recording.results[1]).toMatchObject({ settled: false })
      expect(last(recording)).toMatchObject({ settled: true, amountCharged: 20 })
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '20.00' })
    })

    it('the store credit and gift card parts go back too', async () => {
      const recording = await lapsed(async (bookingId, { call, db }) => {
        const before = await customer(db, ID.member)
        const giftBefore = await giftCardBalance(db)
        failOnce(/WITH bk AS[\s\S]*SET status = 'confirmed'/)
        const payment = { method: 'card', storeCredit: { amount: 2 }, giftCard: { giftCardId: ID.giftCard, amount: 3 } }
        const answer = await call('settleLapsedBooking', { bookingId, payment })
        expect(answer).toMatchObject({ settled: false })
        expect(await customer(db, ID.member)).toBe(before)
        expect(await giftCardBalance(db)).toBe(giftBefore)
      })
      expect(charges(recording).slice(-1)).toEqual([1500])
    })

    it('no longer awaiting payment: the money goes back, and staff are told it did', async () => {
      const recording = await lapsed(async (bookingId, { call, db, stripe }) => {
        const restore = beforeStatement(/WITH bk AS[\s\S]*SET status = 'confirmed'/, () => db.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [bookingId]))
        await call('settleLapsedBooking', { bookingId, payment: { method: 'card' } })
        restore()
        expect(stripe.netPence).toBe(0)
      })
      expect(last(recording)).toMatchObject({ settled: false, reason: 'booking_not_payment_needed', message: expect.stringContaining('put back') })
    })

    it('finding 15: a reader open on the booking is refused before any money moves', async () => {
      const recording = await lapsed(async (bookingId, { call, db }) => {
        await db.query(
          `INSERT INTO pending_reader_payments (flow, record_id, payment_intent_id, expected_amount, snapshot, status) VALUES ('add_guest', $1, 'pi_open', 5, '{}'::jsonb, 'pending')`,
          [bookingId]
        )
        await call('settleLapsedBooking', { bookingId, payment: { method: 'card' } })
      })
      expect(last(recording)).toMatchObject({ settled: false, reason: 'reader_payment_open' })
      expect(charges(recording)).toEqual([])
    })

    it('finding 15: a reader opened after the check is stopped by the statement, and the charge goes back', async () => {
      const recording = await lapsed(async (bookingId, { call, db, stripe }) => {
        const restore = beforeStatement(/WITH bk AS[\s\S]*SET status = 'confirmed'/, () =>
          db.query(
            `INSERT INTO pending_reader_payments (flow, record_id, payment_intent_id, expected_amount, snapshot, status) VALUES ('add_guest', $1, 'pi_open', 5, '{}'::jsonb, 'pending')`,
            [bookingId]
          )
        )
        await call('settleLapsedBooking', { bookingId, payment: { method: 'card' } })
        restore()
        expect(stripe.netPence).toBe(0)
      })
      expect(last(recording)).toMatchObject({ settled: false })
    })
  })

  describe('finding 4: Add Guest claims the gift card before the card', () => {
    const payment = { method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 5 } }

    it('the gift card statement fails: no charge, no place held, and pressing again charges £15 once', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db, stripe }) => {
        const before = stripe.netPence
        failOnce(/WITH claim AS/)
        await call('addBookingGuest', { bookingId, ...bea, payment })
        expect(stripe.netPence).toBe(before)
        expect(await sessionsBooked(db, ID.session)).toEqual([2])
        await call('addBookingGuest', { bookingId, ...bea, payment })
        expect(stripe.netPence).toBe(before + 1500)
        expect(await sessionsBooked(db, ID.session)).toEqual([3])
      })
      expect(recording.results[1]).toMatchObject({ added: false })
      expect(last(recording)).toMatchObject({ added: true })
    })

    it('Stripe is asked after the gift card, so a card that declines gives the gift card back', async () => {
      await attempt(publicOnCard, async (bookingId, { call, db, stripe }) => {
        const before = await giftCardBalance(db)
        stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        await call('addBookingGuest', { bookingId, ...bea, payment })
        expect(await giftCardBalance(db)).toBe(before)
        expect(await sessionsBooked(db, ID.session)).toEqual([2])
      })
    })
  })

  describe('finding 5: Cancel & return credit guards its statement', () => {
    const creditBooking = { booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} }
    const CANCEL = /SET status = 'cancelled', cancelled_at = now\(\), updated_at = now\(\)/

    it('a paid guest landing in the gap: not cancelled, and the answer says why', async () => {
      const recording = await attempt(
        creditBooking,
        async (bookingId, { call }) => {
          const restore = beforeStatement(CANCEL, () => call('addBookingGuest', { bookingId, ...bea, payment: { method: 'cash', confirmedCashAmount: 20 } }))
          await call('cancelCreditBooking', { bookingId })
          restore()
        },
        ID.member
      )
      expect(last(recording)).toMatchObject({ cancelled: false, reason: 'paid_guests_present' })
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '20.00' })
    })

    it('a reader opened in the gap: not cancelled', async () => {
      const recording = await attempt(
        creditBooking,
        async (bookingId, { call, db }) => {
          const restore = beforeStatement(CANCEL, () =>
            db.query(
              `INSERT INTO pending_reader_payments (flow, record_id, payment_intent_id, expected_amount, snapshot, status) VALUES ('add_guest', $1, 'pi_open', 5, '{}'::jsonb, 'pending')`,
              [bookingId]
            )
          )
          await call('cancelCreditBooking', { bookingId })
          restore()
        },
        ID.member
      )
      expect(last(recording)).toMatchObject({ cancelled: false, reason: 'reader_payment_open' })
    })
  })

  describe('finding 6: a claim leaves a trail', () => {
    const FINISHED = 'booking.refund_finished'
    const CLAIMED = 'booking.refund_claimed'
    const unfinished = (db: Db) =>
      db.query<{ entity_id: string; details: Row }>(
        `SELECT c.entity_id, c.details FROM audit_log c
         WHERE c.action = 'booking.refund_claimed'
           AND NOT EXISTS (SELECT 1 FROM audit_log f WHERE f.action = 'booking.refund_finished' AND f.details->>'claimId' = c.id::text)`
      )

    it.each<[string, Record<string, unknown>, Record<string, unknown>, string]>([
      ['Part refund', noPromoOnCard, part(40, 'card'), 'part_refund'],
      ['Cancel & Refund', noPromoOnCard, { refundMethod: 'card' }, 'cancel'],
    ])('%s: claimed in its own statement, finished at the end', async (_name, order, refund, kind) => {
      const recording = await attempt(order, async (bookingId, { call, db }) => {
        await call('refundBooking', { bookingId, ...refund })
        expect(await unfinished(db)).toEqual([])
      })
      expect(audits(recording, CLAIMED)).toEqual([expect.objectContaining({ actor_id: ID.staff, entity_type: 'booking', details: expect.objectContaining({ kind }) })])
      expect(audits(recording, FINISHED)).toHaveLength(1)
    })

    it('Remove Guest and a cheaper move too', async () => {
      const recording = await attempt(peakPrivateOnCard, async (bookingId, { call, db }) => {
        await call('moveBooking', { bookingId, newSessionId: ID.laterPrivateSession, confirmed: true, refundMethod: 'card' })
        expect(await unfinished(db)).toEqual([])
      })
      expect(audits(recording, CLAIMED).map((row) => (row['details'] as Row)['kind'])).toEqual(['move'])
      const guest = await attempt(publicOnCard, async (bookingId, { call, db }) => {
        const added = (await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })) as { guest: { id: string } }
        await call('removeBookingGuest', { guestId: added.guest.id, confirmedRefundAmount: 20, refundMethod: 'card' })
        expect(await unfinished(db)).toEqual([])
      })
      expect(audits(guest, CLAIMED).map((row) => (row['details'] as Row)['kind'])).toEqual(['remove_guest'])
    })

    it('Refund the rest too, and a claim put back is finished', async () => {
      const recording = await attempt(peakPrivateOnCard, async (bookingId, { call, db, stripe }) => {
        stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        await call('moveBooking', { bookingId, newSessionId: ID.laterPrivateSession, confirmed: true, refundMethod: 'card' })
        await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
        expect(await unfinished(db)).toEqual([])
      })
      const finished = audits(recording, FINISHED).map((row) => (row['details'] as Row)['outcome'])
      expect(finished).toEqual(['owed', 'given'])
    })

    it('the function dies after the claim: the money hasn\'t moved, and the query names the booking', async () => {
      await attempt(noPromoOnCard, async (bookingId, { call, db }) => {
        const real = (globalThis as unknown as { paddockBackendApi2: { rawRequest: unknown } }).paddockBackendApi2
        const realData = (globalThis as unknown as { paddockData: { query: Query } }).paddockData
        let dead = false
        vi.stubGlobal('paddockBackendApi2', {
          rawRequest() {
            dead = true
            return Promise.reject(new Error('the function died'))
          },
        })
        vi.stubGlobal('paddockData', { query: (sql: string, params?: unknown[]) => (dead ? Promise.reject(new Error('the function died')) : realData.query(sql, params)) })
        await call('refundBooking', { bookingId, ...part(40, 'card') })
        vi.stubGlobal('paddockBackendApi2', real)
        vi.stubGlobal('paddockData', realData)
        expect(await unfinished(db)).toEqual([expect.objectContaining({ entity_id: bookingId, details: expect.objectContaining({ amount: 40, kind: 'part_refund' }) })])
      })
    })

    it('if the claim\'s audit row fails, nothing is claimed and no money moves', async () => {
      const recording = await attempt(noPromoOnCard, async (bookingId, { call, db }) => {
        const fails: WriteFailure = { table: 'audit_log', event: 'INSERT', when: `NEW.action = 'booking.refund_claimed'` }
        await whileFailing(db, fails, () => call('refundBooking', { bookingId, ...part(40, 'card') }))
      })
      expect(refunds(recording)).toEqual([])
      expect(booking(recording)).toMatchObject({ price_paid: '100.00', part_refunded_amount: '0.00' })
    })

    it('a move with no refund claims nothing', async () => {
      const recording = await attempt(noPromoOnCard, async (bookingId, { call }) => {
        await call('moveBooking', { bookingId, newSessionId: ID.laterPrivateSession, confirmed: true })
      })
      expect(audits(recording, CLAIMED)).toEqual([])
    })
  })

  describe('finding 7: Q28 after a capped cheaper move', () => {
    it('public: £51 paid, £45 part refund, moved down with £6 back, then back up: £6, not £11', async () => {
      const recording = await attempt(publicPeakOnCard, async (bookingId, { call }) => {
        await call('refundBooking', { bookingId, refundMethod: 'card', amount: 45, ...goodwill })
        await call('moveBooking', { bookingId, newSessionId: ID.laterPublicSession, confirmed: true, refundMethod: 'card' })
        await call('moveBooking', { bookingId, newSessionId: ID.peakSession })
      })
      expect(last(recording)).toMatchObject({ priceImpact: { amountDue: 6 } })
    })

    it('private already agrees: £140, £130 part refund, down and back up is £10', async () => {
      const recording = await attempt(peakPrivateOnCard, async (bookingId, { call }) => {
        await call('refundBooking', { bookingId, refundMethod: 'card', amount: 130, ...goodwill })
        await call('moveBooking', { bookingId, newSessionId: ID.laterPrivateSession, confirmed: true, refundMethod: 'card' })
        await call('moveBooking', { bookingId, newSessionId: ID.peakPrivateSession })
      })
      expect(last(recording)).toMatchObject({ priceImpact: { amountDue: 10 } })
    })

    it('a plain dearer move is still the seat difference', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call }) => {
        await call('moveBooking', { bookingId, newSessionId: ID.peakSession })
      })
      expect(last(recording)).toMatchObject({ priceImpact: { amountDue: 11 } })
    })

    it('after a part refund, a dearer move is still the seat difference: nothing was capped', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call }) => {
        await call('refundBooking', { bookingId, refundMethod: 'card', amount: 10, ...goodwill })
        await call('moveBooking', { bookingId, newSessionId: ID.peakSession })
      })
      expect(last(recording)).toMatchObject({ priceImpact: { amountDue: 11 } })
    })

    it('the cap never turns a dearer move into a refund, even with money on the booking to refund', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call }) => {
        const added = (await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })) as { guest: { id: string } }
        await call('refundBooking', { bookingId, refundMethod: 'card', amount: 60, ...goodwill })
        await call('removeBookingGuest', { guestId: added.guest.id, confirmedRefundAmount: 0 })
        await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'cash', confirmedCashAmount: 20 } })
        await call('moveBooking', { bookingId, newSessionId: ID.peakSession })
      })
      expect(booking(recording)).toMatchObject({ price_paid: '20.00', part_refunded_amount: '60.00' })
      expect(last(recording)).toMatchObject({ priceImpact: { amountDue: 0, refundDue: false } })
    })
  })

  describe('finding 8: a store credit taken back isn\'t store credit spent', () => {
    it('the card money survives a failed cancel to store credit, and a retry on the card reaches it', async () => {
      const recording = await attempt(noPromoOnCard, async (bookingId, { call, db }) => {
        await whileFailing(db, cancelWriteFails, () => call('refundBooking', { bookingId, refundMethod: 'credit' }))
        await call('getBookingRefundFigures', { bookingId })
        await call('refundBooking', { bookingId, refundMethod: 'card' })
      })
      expect(recording.results[2]).toMatchObject({ left: 100, cardLeft: 100, parts: { card: 100, cash: 0 } })
      expect(last(recording)).toMatchObject({ cardRefundedAmount: 100, storeCreditRefundedAmount: 0 })
      expect(refunds(recording)).toEqual([10000])
    })
  })

  describe('finding 9: two moves at once', () => {
    it('the second finds the booking gone from under it, and the counts stay true', async () => {
      const other = '10000000-0000-4000-8000-0000000000f1'
      await attempt(publicOnCard, async (bookingId, { call, db }) => {
        await insert(db, 'sessions', { id: other, service_type_id: ID.serviceType, start_time: '2026-11-21 10:00:00+00', end_time: '2026-11-21 11:00:00+00', type: 'public', capacity: 10, band_id: ID.band })
        const restore = beforeStatement(/WITH bk AS[\s\S]*SET session_id/, () => call('moveBooking', { bookingId, newSessionId: other, confirmed: true }))
        const answer = await call('moveBooking', { bookingId, newSessionId: ID.laterPublicSession, confirmed: true })
        restore()
        expect(answer).toMatchObject({ moved: false, reason: 'booking_changed' })
        const [row] = await db.query<{ session_id: string }>('SELECT session_id FROM bookings WHERE id = $1', [bookingId])
        expect(row?.session_id).toBe(other)
        expect(await sessionsBooked(db, ID.session, ID.laterPublicSession, other)).toEqual([0, 0, 2])
      })
    })
  })

  describe('finding 14: Add Guest guards the party size', () => {
    it('two free private guests at once: the second is refused, so no tier is crossed unpaid', async () => {
      const recording = await attempt(noPromoOnCard, async (bookingId, { call }) => {
        await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })
        const fourth = { bookingId, guestName: 'Cy Guest', guestEmail: 'cy@example.com', guestsOver18Confirmed: true }
        const fifth = { bookingId, guestName: 'Di Guest', guestEmail: 'di@example.com', guestsOver18Confirmed: true }
        const restore = beforeStatement(/\$1::boolean AS add_guest/, () => call('addBookingGuest', fourth))
        await call('addBookingGuest', fifth)
        restore()
      })
      expect(last(recording)).toMatchObject({ added: false, reason: 'booking_changed' })
      expect(booking(recording)).toMatchObject({ party_size: 4, price_paid: '150.00' })
    })
  })

  describe('dies after the charge: one charge, and the booking right', () => {
    const die = (steps: () => Promise<unknown>) => dyingAfter(CHARGE_PATH, steps)
    /** As Stripe saw them. A recording hides the time inside a key, so it can't tell two apart. */
    const chargeKeys = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'paymentIntents.create').map((call) => call.idempotencyKey)
    const redeemed = (recording: Recording) => added(recording, 'store_credit_transactions').filter((row) => row['reason'] === 'redemption').map((row) => row['amount'])

    it('dearer Move on the card', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db, stripe }) => {
        const before = stripe.netPence
        const confirmed = { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'card' } }
        await die(() => call('moveBooking', confirmed))
        await call('moveBooking', confirmed)
        expect(stripe.netPence).toBe(before + 1100)
        expect(await sessionsBooked(db, ID.session, ID.peakSession)).toEqual([0, 2])
        const keys = chargeKeys(stripe).slice(1)
        expect(keys).toHaveLength(2)
        expect(keys[0]).toBeTruthy()
        expect(keys[1]).toBe(keys[0])
      })
      expect(last(recording)).toMatchObject({ moved: true })
      expect(booking(recording)).toMatchObject({ price_paid: '51.00', session_id: ID.peakSession })
    })

    it('dearer Move with store credit and a gift card: each taken once', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db, stripe }) => {
        const before = stripe.netPence
        const credit = await customer(db)
        const gift = await giftCardBalance(db)
        const payment = { method: 'card', storeCredit: { amount: 2 }, giftCard: { giftCardId: ID.giftCard, amount: 3 } }
        const confirmed = { bookingId, newSessionId: ID.peakSession, confirmed: true, payment }
        await die(() => call('moveBooking', confirmed))
        await call('moveBooking', confirmed)
        expect(stripe.netPence).toBe(before + 600)
        expect(await customer(db)).toBe((Number(credit) - 2).toFixed(2))
        expect(await giftCardBalance(db)).toBe((Number(gift) - 3).toFixed(2))
      })
      expect(redeemed(recording)).toEqual(['-2.00'])
      expect(booking(recording)).toMatchObject({ price_paid: '51.00' })
    })

    it('Add Guest on the card: one guest, one place, one order', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db, stripe }) => {
        const before = stripe.netPence
        const guest = { bookingId, ...bea, payment: { method: 'card' } }
        await die(() => call('addBookingGuest', guest))
        await call('addBookingGuest', guest)
        expect(stripe.netPence).toBe(before + 2000)
        expect(await sessionsBooked(db, ID.session)).toEqual([3])
        const intent = [...stripe.chargedByIntent.keys()].at(-1) as string
        expect(await ordersFor(db, intent)).toHaveLength(1)
      })
      expect(last(recording)).toMatchObject({ added: true })
      expect(booking(recording)).toMatchObject({ price_paid: '60.00', party_size: 3 })
      expect(added(recording, 'booking_guests')).toHaveLength(3)
    })

    it('Add Guest with store credit, a gift card and an add-on credit: each taken once', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db, stripe }) => {
        const before = stripe.netPence
        const credit = await customer(db)
        const gift = await giftCardBalance(db)
        const guest = { bookingId, ...bea, payment: { method: 'card', storeCredit: { amount: 5 }, giftCard: { giftCardId: ID.giftCard, amount: 5 } } }
        await die(() => call('addBookingGuest', guest))
        await call('addBookingGuest', guest)
        expect(stripe.netPence).toBe(before + 1000)
        expect(await customer(db)).toBe((Number(credit) - 5).toFixed(2))
        expect(await giftCardBalance(db)).toBe((Number(gift) - 5).toFixed(2))
        expect(await sessionsBooked(db, ID.session)).toEqual([3])
      })
      expect(redeemed(recording)).toEqual(['-5.00'])
      expect(added(recording, 'gift_card_redemptions')).toHaveLength(1)
    })

    it('add-ons alone on the card: the order has no booking line, and still only one of everything', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, stripe }) => {
        const before = stripe.netPence
        const addons = { bookingId, addons: [towel], payment: { method: 'card', storeCredit: { amount: 1 } } }
        await die(() => call('addBookingGuest', addons))
        await call('addBookingGuest', addons)
        expect(stripe.netPence).toBe(before + 400)
      })
      expect(redeemed(recording)).toEqual(['-1.00'])
      expect(added(recording, 'addon_order_lines')).toHaveLength(1)
    })

    it('Settle on the card', async () => {
      const recording = await attempt(
        { booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} },
        async (bookingId, { call, db, stripe }) => {
          await db.query(`UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 day' WHERE id = $1`, [bookingId])
          await db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.member])
          const payment = { method: 'card', storeCredit: { amount: 2 } }
          await die(() => call('settleLapsedBooking', { bookingId, payment }))
          await call('settleLapsedBooking', { bookingId, payment })
          expect(stripe.netPence).toBe(1800)
        },
        ID.member
      )
      expect(redeemed(recording)).toEqual(['-2.00'])
      expect(last(recording)).toMatchObject({ settled: true })
      expect(booking(recording)).toMatchObject({ status: 'confirmed', price_paid: '20.00' })
    })

    it('the answer is lost and the order is there: the same press carries on, as the charge landed', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, stripe }) => {
        const before = stripe.netPence
        const guest = { bookingId, ...bea, payment: { method: 'card', storeCredit: { amount: 5 } } }
        await losingTheWorkersAnswer(CHARGE_PATH, () => call('addBookingGuest', guest))
        expect(stripe.netPence).toBe(before + 1500)
      })
      expect(last(recording)).toMatchObject({ added: true })
      expect(redeemed(recording)).toEqual(['-5.00'])
    })

    it('Stripe\'s answer is lost at the Worker: the parts go back, and pressing again takes it all once', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db, stripe }) => {
        const before = stripe.netPence
        const credit = await customer(db)
        const guest = { bookingId, ...bea, payment: { method: 'card', storeCredit: { amount: 5 } } }
        stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
        await call('addBookingGuest', guest)
        expect(await customer(db)).toBe(credit)
        await call('addBookingGuest', guest)
        expect(stripe.netPence).toBe(before + 1500)
        expect(await customer(db)).toBe((Number(credit) - 5).toFixed(2))
      })
      expect(recording.results[1]).toMatchObject({ added: false, reason: expect.stringContaining('may have gone through') })
      expect(last(recording)).toMatchObject({ added: true })
    })

    it('a decline is definite: the next press is a new try, not the saved decline', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, stripe }) => {
        const guest = { bookingId, ...bea, payment: { method: 'card' } }
        stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        await call('addBookingGuest', guest)
        await call('addBookingGuest', guest)
        const [, first, second] = chargeKeys(stripe)
        expect(first).toBeTruthy()
        expect(second).not.toBe(first)
      })
      expect(last(recording)).toMatchObject({ added: true })
    })

    it('a reversed charge is finished with: the next press charges for real, and never replays a refunded payment', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db, stripe }) => {
        const before = stripe.netPence
        const guest = { bookingId, ...bea, payment: { method: 'card' } }
        const fails: WriteFailure = { table: 'booking_guests', event: 'INSERT', when: 'true' }
        await whileFailing(db, fails, () => call('addBookingGuest', guest))
        expect(stripe.netPence).toBe(before)
        await call('addBookingGuest', guest)
        expect(stripe.netPence).toBe(before + 2000)
        const [, first, second] = chargeKeys(stripe)
        expect(second).not.toBe(first)
      })
      expect(last(recording)).toMatchObject({ added: true })
    })

    it('a reversed Move is finished with too: the next press charges for real', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, stripe }) => {
        const before = stripe.netPence
        const confirmed = { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'card' } }
        failOnce(/WITH bk AS[\s\S]*SET session_id/)
        await call('moveBooking', confirmed)
        expect(stripe.netPence).toBe(before)
        await call('moveBooking', confirmed)
        expect(stripe.netPence).toBe(before + 1100)
      })
      expect(last(recording)).toMatchObject({ moved: true })
    })

    it('a finished guest\'s order is no sign of a death: a second guest at the same price takes their own place', async () => {
      await attempt(publicOnCard, async (bookingId, { call, db, stripe }) => {
        const before = stripe.netPence
        const credit = await customer(db)
        const payment = { method: 'card', storeCredit: { amount: 5 } }
        await call('addBookingGuest', { bookingId, ...bea, payment })
        await call('addBookingGuest', { bookingId, guestName: 'Cy Guest', guestEmail: 'cy@example.com', guestsOver18Confirmed: true, payment })
        expect(await sessionsBooked(db, ID.session)).toEqual([4])
        expect(await customer(db)).toBe((Number(credit) - 10).toFixed(2))
        expect(stripe.netPence).toBe(before + 3000)
      })
    })

    it('nor is a reader\'s order, which is written after the booking last changed', async () => {
      await attempt(publicOnCard, async (bookingId, { call, db, stripe }) => {
        const paid = (await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'reader' } })) as { pendingReaderPayment: { pendingId: string; paymentIntentId: string } }
        stripe.completeReaderPayment(paid.pendingReaderPayment.paymentIntentId)
        await call('finaliseReaderPayment', { pendingId: paid.pendingReaderPayment.pendingId })
        await call('addBookingGuest', { bookingId, guestName: 'Cy Guest', guestEmail: 'cy@example.com', guestsOver18Confirmed: true, payment: { method: 'card' } })
        expect(await sessionsBooked(db, ID.session)).toEqual([4])
      })
    })

    it('an HTML page says nothing about the charge, so it is reported as unclear, and the key stands', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
        const real = (globalThis as unknown as { paddockBackendApi2: { rawRequest: (r: { path: string }) => Promise<unknown> } }).paddockBackendApi2
        vi.stubGlobal('paddockBackendApi2', {
          rawRequest: async (request: { path: string }) => (request.path === CHARGE_PATH ? { data: { message: '<!DOCTYPE html><html>Bad gateway</html>' } } : real.rawRequest(request)),
        })
        const [before] = await db.query<{ updated_at: string }>('SELECT updated_at::text AS updated_at FROM bookings WHERE id = $1', [bookingId])
        await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })
        vi.stubGlobal('paddockBackendApi2', real)
        const [after] = await db.query<{ updated_at: string }>('SELECT updated_at::text AS updated_at FROM bookings WHERE id = $1', [bookingId])
        expect(after?.updated_at).toBe(before?.updated_at)
      })
      expect(last(recording)).toMatchObject({ added: false, reason: expect.stringContaining('may have gone through') })
    })

    it('if the charge can\'t be retired it isn\'t reversed, so the next press still finishes it', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db, stripe }) => {
        const before = stripe.netPence
        const guest = { bookingId, ...bea, payment: { method: 'card' } }
        const fails: WriteFailure = { table: 'booking_guests', event: 'INSERT', when: 'true' }
        await whileFailing(db, fails, async () => {
          failOnce(/^UPDATE bookings SET updated_at = now\(\)/)
          await call('addBookingGuest', guest)
        })
        expect(stripe.netPence).toBe(before + 2000)
        // W05k: the press left its started row with nothing to say it is over, so the next press
        // waits the minute a press can run before finishing it.
        vi.setSystemTime(Date.now() + 61_000)
        await call('addBookingGuest', guest)
        expect(stripe.netPence).toBe(before + 2000)
        expect(await sessionsBooked(db, ID.session)).toEqual([3])
      })
      expect(last(recording)).toMatchObject({ added: true })
    })

    it('add-ons alone, twice the same day at the same price: two real charges, as neither changes the figures', async () => {
      await attempt(publicOnCard, async (bookingId, { call, stripe }) => {
        const before = stripe.netPence
        const addons = { bookingId, addons: [towel], payment: { method: 'card' } }
        await call('addBookingGuest', addons)
        await call('addBookingGuest', addons)
        expect(stripe.netPence).toBe(before + 1000)
        const [, firstKey, secondKey] = chargeKeys(stripe)
        expect(secondKey).not.toBe(firstKey)
      })
    })

    it('add, remove, add again the same day: the same figures, and still a real charge', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, stripe }) => {
        const before = stripe.netPence
        const guest = { bookingId, ...bea, payment: { method: 'card' } }
        const first = (await call('addBookingGuest', guest)) as { guest: { id: string } }
        await call('removeBookingGuest', { guestId: first.guest.id, confirmedRefundAmount: 20, refundMethod: 'card' })
        await call('addBookingGuest', guest)
        expect(stripe.netPence).toBe(before + 2000)
        const [, firstKey, secondKey] = chargeKeys(stripe)
        expect(secondKey).not.toBe(firstKey)
      })
      expect(booking(recording)).toMatchObject({ price_paid: '60.00', party_size: 3 })
    })
  })

  describe('wording', () => {
    it('finding 18: the reader message says what to do when the browser has gone', async () => {
      const recording = await attempt(publicOnCard, async (bookingId, { call, db }) => {
        await db.query(
          `INSERT INTO pending_reader_payments (flow, record_id, payment_intent_id, expected_amount, snapshot, status) VALUES ('add_guest', $1, 'pi_open', 5, '{}'::jsonb, 'pending')`,
          [bookingId]
        )
        await call('refundBooking', { bookingId, ...part(10, 'card') })
      })
      expect(last(recording)).toMatchObject({ thrown: expect.stringContaining('or use Resolve now on the Orders page after 15 minutes') })
    })

    it('finding 19: a declined card refund on a move doesn\'t send staff to the store credit balance', async () => {
      const recording = await attempt(peakPrivateOnCard, async (bookingId, { call, stripe }) => {
        stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        await call('moveBooking', { bookingId, newSessionId: ID.laterPrivateSession, confirmed: true, refundMethod: 'card' })
      })
      expect(last(recording)).toMatchObject({ moved: true, warning: expect.stringContaining('card refund') })
      expect(last(recording)).toMatchObject({ warning: expect.not.stringContaining('store credit balance') })
    })
  })

  describe('the screens', () => {
    const appDir = path.resolve(backendDir, '../..')
    const dialog = (name: string) => readFileSync(path.join(appDir, 'frontend/components', `${name}.tsx`), 'utf8')

    it.each(['PartRefundDialog', 'RefundTheRestDialog', 'CancelAndRefundDialog'])('finding 11: %s can\'t close while a refund is on its way', (name) => {
      expect(dialog(name)).toMatch(/onOpenChange=\{\(next\) => \(submitting \? undefined :/)
    })

    it('finding 10: Cancel & Refund says when some of it is money owed', () => {
      expect(dialog('CancelAndRefundDialog')).toContain('of this is money a failed refund left owed. Check their balance first.')
    })

    it.each(['PartRefundDialog', 'RefundTheRestDialog', 'CancelAndRefundDialog'])('%s stops at an unclear answer', (name) => {
      expect(dialog(name)).toContain('response?.unsure')
    })
  })
})
