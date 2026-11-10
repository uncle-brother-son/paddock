import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { oldSide, replay, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { orderInput, postOrder, withQuotedCardFigure, type OrderAnswer } from '@/server/rules/testing/replay/order-side'
import { ID, laterPublicSession, paidSeat, sam, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import type { PendingSnapshot } from './pending-order'
import { changedSince, undoOrder } from './undo-order'

// W12 item 1 (W10 review L1): the one undo refuses `changed_since` when old code has changed the held
// booking since T1 wrote it, so a reconcile run after 15 minutes can't give the places and the pass
// session back a second time. R1 is the review's proof (briefs/W10-review-logs), now the test.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = 'test-staff-api-key'
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

const asReconcile = { actor: { type: 'system' as const, id: null }, requestId: 'w12-reconcile' }
const soap = { productVariantId: ID.variant, quantity: 1, unitPrice: 12 }
const alex = { name: 'Alex Guest', email: 'alex@example.com' }

async function counts() {
  const session = (await db.query<{ n: number }>('SELECT total_booked AS n FROM sessions WHERE id = $1', [ID.session]))[0]?.n
  const pass = (await db.query<{ n: number }>('SELECT sessions_remaining AS n FROM customer_session_passes WHERE id = $1', [ID.ownedPass]))[0]?.n
  const stock = (await db.query<{ n: number }>('SELECT stock_quantity AS n FROM product_variants WHERE id = $1', [ID.variant]))[0]?.n
  return { session, pass, stock }
}

const errorOf = (answer: OrderAnswer) => (answer.body.ok ? null : { code: answer.body.error.code })

interface Held {
  orderId: string
  bookingId: string
  stripe: FakeStripe
}

/**
 * A card order Stripe can't be reached for, twice: held PAYMENT_UNCONFIRMED with its claims (W10), then
 * `after` runs on it (old code, 16 minutes on, when the old booking checks no longer see it).
 */
async function heldThen(booking: Record<string, unknown>, after: (held: Held) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w12 changed_since',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await laterPublicSession(seedDb)
      },
      async run({ stripe }) {
        replayStripe.current = stripe
        stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
        stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
        const answer = await postOrder(await withQuotedCardFigure(orderInput({ customerId: ID.customer, booking, products: [soap], payment: { method: 'card' } })))
        expect(errorOf(answer)).toEqual({ code: 'PAYMENT_UNCONFIRMED' })
        const orderId = (await db.query<{ id: string }>("SELECT id FROM orders WHERE payment_status = 'pending'"))[0]?.id as string
        const bookingId = (await db.query<{ id: string }>('SELECT id FROM bookings WHERE customer_id = $1', [ID.customer]))[0]?.id as string
        vi.setSystemTime(Date.now() + 16 * 60_000)
        await after({ orderId, bookingId, stripe })
      },
    },
    (_db, stripe) => ({ name: 'test', call: async () => stripe })
  )
}

const passSeat = { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }

describe('the one undo refuses changed_since (W10 review L1)', () => {
  it('R1: a pass seat and a soap held on the card; staff cancel the booking in the old app after 15 minutes; the undo refuses and changes nothing (counts 0 / 3 / 4)', async () => {
    let before: Awaited<ReturnType<typeof counts>> | null = null
    await heldThen(passSeat, async ({ orderId, bookingId, stripe }) => {
      expect(await counts()).toEqual({ session: 1, pass: 2, stock: 4 })
      const cancelled = await oldSide(db, stripe).call('cancelCreditBooking', { bookingId })
      expect(cancelled).toMatchObject({ cancelled: true })
      before = await counts()
      expect(before).toEqual({ session: 0, pass: 3, stock: 4 })
      const undo = await undoOrder(db, orderId, { ...asReconcile, why: 'nothing found in Stripe' })
      expect(undo).toEqual({ undone: false, reason: 'changed_since', changed: ['the booking is cancelled'] })
      // Exactly as old Cancel left it: the place and the pass session given back once, the soap still held.
      expect(await counts()).toEqual({ session: 0, pass: 3, stock: 4 })
      expect((await db.query('SELECT payment_status FROM orders WHERE id = $1', [orderId]))[0]).toEqual({ payment_status: 'pending' })
      expect(await db.query("SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'order.undo'", [orderId])).toEqual([])
    })
  })

  it('a booking the old app moved to another session: refused, nothing given back on either session', async () => {
    await heldThen(paidSeat([sam]), async ({ orderId, bookingId, stripe }) => {
      const moved = await oldSide(db, stripe).call('moveBooking', { bookingId, newSessionId: ID.laterPublicSession, confirmed: true })
      expect(moved).toMatchObject({ moved: true })
      const sessions = async () => db.query<{ id: string; total_booked: number }>('SELECT id, total_booked FROM sessions WHERE id = ANY($1::uuid[]) ORDER BY id', [[ID.session, ID.laterPublicSession]])
      const atMove = await sessions()
      const undo = await undoOrder(db, orderId, { ...asReconcile, why: 'nothing found in Stripe' })
      expect(undo).toEqual({ undone: false, reason: 'changed_since', changed: ['the booking was moved to another session'] })
      expect(await sessions()).toEqual(atMove)
      expect((await counts()).stock).toBe(4)
    })
  })

  it('a guest the old app added to the held booking: refused (party size 2, not 1)', async () => {
    await heldThen(paidSeat([sam]), async ({ orderId, bookingId, stripe }) => {
      const old = oldSide(db, stripe)
      const guest = { bookingId, guestName: alex.name, guestEmail: alex.email, guestsOver18Confirmed: true }
      await old.call('addBookingGuest', guest)
      const added = await old.call('addBookingGuest', { ...guest, payment: { method: 'cash', confirmedCashAmount: 20 } })
      expect(added).toMatchObject({ added: true })
      const undo = await undoOrder(db, orderId, { ...asReconcile, why: 'nothing found in Stripe' })
      expect(undo).toEqual({ undone: false, reason: 'changed_since', changed: ['the party size is 2, not 1'] })
      expect((await counts()).session).toBe(2)
    })
  })

  it('nothing changed after 16 minutes: undone, everything given back once', async () => {
    await heldThen(passSeat, async ({ orderId }) => {
      expect(await undoOrder(db, orderId, { ...asReconcile, why: 'nothing found in Stripe' })).toEqual({ undone: true })
      expect(await counts()).toEqual({ session: 0, pass: 3, stock: 5 })
    })
  })
})

describe('changedSince, rule by rule', () => {
  const held = { session_id: 's1', party_size: 2 }
  const record = { held_booking: held } as unknown as PendingSnapshot
  const booking = (fields: Partial<{ session_id: string; party_size: number; status: string }>) => ({
    id: 'b1',
    session_id: 's1',
    party_size: 2,
    status: 'confirmed',
    booking_type: 'public',
    redemption_source: 'paid',
    pass_to_give_back: null,
    ...fields,
  })
  const event = (status: string) => ({ booking_id: 'e1', event_id: 'ev', places: 1, status })

  it('as T1 wrote it: nothing', () => {
    expect(changedSince(record, { booking: booking({}), event: event('pending') })).toEqual([])
    expect(changedSince(record, { booking: booking({}), event: null })).toEqual([])
    expect(changedSince({} as PendingSnapshot, { booking: null, event: null })).toEqual([])
  })
  it('each change on its own', () => {
    expect(changedSince(record, { booking: null, event: null })).toEqual(['the booking is gone'])
    expect(changedSince(record, { booking: booking({ status: 'cancelled' }), event: null })).toEqual(['the booking is cancelled'])
    expect(changedSince(record, { booking: booking({ session_id: 's2' }), event: null })).toEqual(['the booking was moved to another session'])
    expect(changedSince(record, { booking: booking({ party_size: 1 }), event: null })).toEqual(['the party size is 1, not 2'])
    expect(changedSince(record, { booking: null, event: event('cancelled') })).toEqual(['the booking is gone', 'the event booking is cancelled'])
    expect(changedSince(null, { booking: null, event: event('confirmed') })).toEqual(['the event booking is confirmed'])
  })
  it('a record from before W12 (no held_booking): the status only', () => {
    expect(changedSince({} as PendingSnapshot, { booking: booking({ session_id: 's2', party_size: 9 }), event: null })).toEqual([])
    expect(changedSince({} as PendingSnapshot, { booking: booking({ status: 'cancelled' }), event: null })).toEqual(['the booking is cancelled'])
  })
})
