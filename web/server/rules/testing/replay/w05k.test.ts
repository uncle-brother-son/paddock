import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import type { Recording } from './compare'
import { backendDir, oldSide, replay, startReplay, type ReplayEnvironment, type ReplaySide, type Scenario, type ScenarioContext } from './harness'
import {
  A_PRESS_LATER,
  TWO_DAYS,
  afterTheCharge,
  afterTheRefund,
  bea,
  beforeTheStartedRow,
  cancelWriteFails,
  chargeLandingLate,
  later,
  dyingAfter,
  goodwill,
  ID,
  laterPublicSession,
  losingTheAnswer,
  losingTheWorkersAnswer,
  memberCredit,
  mo,
  noPromoOnCard,
  paidSeat,
  publicOnCard,
  sam,
  seed,
  sessionsToMoveBetween,
  whileFailing,
  type WriteFailure,
} from './scenarios'

// W05k on the old functions: the second release review's findings, each from its proof (P1 to P6).
// Overlapping presses on one booking: a press "inside" another runs to the end at the moment the
// first one's step comes back, which is how two presses that overlap look to the database.

const CHARGE_PATH = '/api/payments/charge-saved-card'
const REFUND_PATH = '/api/payments/refund-order'
const IN_PROGRESS = 'A payment for this booking is still being taken. Wait a minute, then reload.'

type Row = Record<string, unknown>
type Query = (sql: string, params?: unknown[]) => Promise<unknown>
type RawRequest = (request: { path: string }) => Promise<unknown>

const data = () => (globalThis as unknown as { paddockData: { query: Query } }).paddockData
const api = () => (globalThis as unknown as { paddockBackendApi2: { rawRequest: RawRequest } }).paddockBackendApi2
const added = (recording: Recording, table: string) => recording.tables[table]?.added ?? []
const last = (recording: Recording) => recording.results[recording.results.length - 1]
const audit = (recording: Recording, action: string) => added(recording, 'audit_log').filter((row) => row['action'] === action)

const keepingErrors = (db: Db, stripe: FakeStripe): ReplaySide => {
  const side = oldSide(db, stripe)
  return { ...side, call: (action, params) => side.call(action, params).catch((err: Error) => ({ thrown: err.message })) }
}

/** The function stops dead once a statement matching `match` has run: nothing after it reaches the
 *  database or the Worker. `steps` is expected to fail. */
async function dyingAfterStatement(match: (sql: string) => boolean, steps: () => Promise<unknown>): Promise<void> {
  const realData = data()
  const realApi = api()
  let dead = false
  const died = () => Promise.reject(new Error('the function died'))
  vi.stubGlobal('paddockData', {
    async query(sql: string, params: unknown[] = []) {
      if (dead) return died()
      const answer = await realData.query(sql, params)
      if (match(sql)) dead = true
      return answer
    },
  })
  vi.stubGlobal('paddockBackendApi2', { rawRequest: (request: { path: string }) => (dead ? died() : realApi.rawRequest(request)) })
  try {
    await steps().catch(() => undefined)
    if (!dead) throw new Error('The function never reached that statement.')
  } finally {
    vi.stubGlobal('paddockData', realData)
    vi.stubGlobal('paddockBackendApi2', realApi)
  }
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

describe('W05k on the old functions', () => {
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

  const attempt = (order: Row, steps: (placed: Row, context: ScenarioContext) => Promise<unknown>, customerId: string = ID.customer) => {
    const scenario: Scenario = {
      name: 'attempt',
      seed: fullSeed,
      async run(context) {
        const placed = (await context.call('createOrder', { customerId, ...order })) as Row
        if (placed['success'] !== true) throw new Error(`The order failed: ${JSON.stringify(placed)}`)
        await steps(placed, context)
      },
    }
    return replay(environment, scenario, keepingErrors)
  }

  const balance = async (db: Db, id: string = ID.customer) =>
    Number((await db.query<{ b: string }>('SELECT store_credit_balance AS b FROM customers WHERE id = $1', [id]))[0]?.b)
  const booked = async (db: Db, ...ids: string[]) => {
    const rows = await db.query<{ id: string; total_booked: number }>('SELECT id, total_booked FROM sessions WHERE id = ANY($1::uuid[])', [ids])
    return ids.map((id) => rows.find((row) => row.id === id)?.total_booked)
  }
  const bookingRow = async (db: Db, id: unknown) =>
    (
      await db.query<Row>(
        `SELECT status, session_id, party_size, to_char(price_paid, 'FM990.00') AS price_paid, to_char(refund_owed_amount, 'FM990.00') AS owed
         FROM bookings WHERE id = $1`,
        [id as string]
      )
    )[0]
  const guests = async (db: Db, id: unknown) => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM booking_guests WHERE booking_id = $1', [id as string]))[0]?.n
  const moves = async (db: Db, reason: string, customerId: string = ID.customer) =>
    (await db.query<{ amount: string }>('SELECT to_char(amount, \'FM990.00\') AS amount FROM store_credit_transactions WHERE customer_id = $1 AND reason = $2 ORDER BY created_at', [customerId, reason])).map(
      (row) => row.amount
    )

  // --- Finding 1: two presses on one booking share one charge ---------------------------------------

  /** Settle: a £20 seat, £2 of it store credit and £18 on the card. */
  const settleOn = async (steps: (bookingId: string, context: ScenarioContext, press: () => Promise<unknown>) => Promise<unknown>) =>
    attempt(
      { booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} },
      async (placed, context) => {
        const bookingId = placed['bookingId'] as string
        await context.db.query(`UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 day' WHERE id = $1`, [bookingId])
        await context.db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.member])
        const press = () => context.call('settleLapsedBooking', { bookingId, payment: { method: 'card', storeCredit: { amount: 2 } } })
        await steps(bookingId, context, press)
        // Whatever the order of the presses: settled once, £18 on the card and £2 of store credit, once.
        expect(await bookingRow(context.db, bookingId)).toMatchObject({ status: 'confirmed', price_paid: '20.00' })
        expect(context.stripe.netPence).toBe(1800)
        expect(context.stripe.refundedPence).toBe(0)
        expect(await balance(context.db, ID.member)).toBe(8)
      },
      ID.member
    )

  /** Add Guest: a £20 guest on a £40 booking, £5 of it store credit and £15 on the card. */
  const addGuestOn = async (steps: (bookingId: string, context: ScenarioContext, press: () => Promise<unknown>) => Promise<unknown>) =>
    attempt(publicOnCard, async (placed, context) => {
      const bookingId = placed['bookingId'] as string
      await context.db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.customer])
      const press = () => context.call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card', storeCredit: { amount: 5 } } })
      await steps(bookingId, context, press)
      // One guest, one place, £15 on the card and £5 of store credit, once.
      expect(await guests(context.db, bookingId)).toBe(3)
      expect(await bookingRow(context.db, bookingId)).toMatchObject({ party_size: 3, price_paid: '60.00' })
      expect(await booked(context.db, ID.session)).toEqual([3])
      expect(context.stripe.netPence).toBe(5500)
      expect(context.stripe.refundedPence).toBe(0)
      expect(await balance(context.db)).toBe(5)
    })

  /** Move: £40 to the £51 session, £2 of the £11 in store credit and £9 on the card. */
  const moveOn = async (steps: (bookingId: string, context: ScenarioContext, press: () => Promise<unknown>) => Promise<unknown>) =>
    attempt(publicOnCard, async (placed, context) => {
      const bookingId = placed['bookingId'] as string
      await context.db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.customer])
      const press = () =>
        context.call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'card', storeCredit: { amount: 2 } } })
      await steps(bookingId, context, press)
      expect(await bookingRow(context.db, bookingId)).toMatchObject({ session_id: ID.peakSession, price_paid: '51.00' })
      expect(await booked(context.db, ID.session, ID.peakSession)).toEqual([0, 2])
      expect(context.stripe.netPence).toBe(4900)
      expect(context.stripe.refundedPence).toBe(0)
      expect(await balance(context.db)).toBe(8)
    })

  const flows = [
    ['Settle', settleOn, 'settled'],
    ['Add Guest', addGuestOn, 'added'],
    ['Move', moveOn, 'moved'],
  ] as const

  describe.each(flows)('%s: two presses at once', (_name, on, done) => {
    it('P1/P2 as written: the second press, while the first is still charging, is told to wait and takes nothing', async () => {
      const recording = await on(async (_bookingId, _context, press) => {
        let second: unknown = null
        afterTheCharge(async () => {
          second = await press()
        })
        const first = await press()
        expect(second).toMatchObject({ [done]: false, reason: 'card_charge_in_progress', message: IN_PROGRESS })
        expect(first).toMatchObject({ [done]: true })
      })
      expect(audit(recording, 'booking.card_charge_started')).toHaveLength(1)
    })

    it('a minute later the first press counts as dead, so the second finishes it, and the first, still alive, keeps what it took', async () => {
      await on(async (bookingId, context, press) => {
        let second: unknown = null
        afterTheCharge(async () => {
          later(A_PRESS_LATER)
          second = await press()
        })
        const first = await press()
        expect(second).toMatchObject({ [done]: true })
        expect(first).toMatchObject({ [done]: false, message: expect.stringContaining('only taken once') })
        // The second press counted the first press's parts as its own, and says so.
        const rows = await context.db.query<{ id: string; action: string; details: Row }>(
          `SELECT id, action, details FROM audit_log WHERE entity_id = $1 AND action LIKE 'booking.card_charge_%' ORDER BY at, id`,
          [bookingId]
        )
        const started = rows.filter((row) => row.action === 'booking.card_charge_started')
        const finished = rows.filter((row) => row.action === 'booking.card_charge_finished')
        expect(started).toHaveLength(2)
        expect(finished).toHaveLength(1)
        expect(finished[0]?.details).toMatchObject({ partsFrom: started[0]?.id, resumed: true })
      })
    })

    it('the other way round: the second press finishes before the first writes its started row, and the first gives back only its own parts', async () => {
      const recording = await on(async (_bookingId, _context, press) => {
        let second: unknown = null
        beforeTheStartedRow(async () => {
          second = await press()
        })
        const first = await press()
        expect(second).toMatchObject({ [done]: true })
        expect(first).toMatchObject({ [done]: false })
      })
      // One payment, and the first press, whose charge Stripe answered with it, never refunded it.
      expect(recording.stripeCalls.filter((call) => call.method === 'refunds.create')).toEqual([])
    })

    it('Stripe answers the second press "another request with this key is in progress": it gives back its parts and is told to wait', async () => {
      const recording = await on(async (_bookingId, context, press) => {
        let second: unknown = null
        beforeTheStartedRow(async () => {
          context.stripe.failNext('paymentIntents.create', { kind: 'key_in_use' })
          second = await press()
        })
        const first = await press()
        expect(JSON.stringify(second)).toContain(IN_PROGRESS)
        expect(first).toMatchObject({ [done]: true })
      })
      expect(audit(recording, 'booking.card_charge_parts_returned')).toHaveLength(1)
    })
  })

  describe('the finished row arbitrates', () => {
    it('Add Guest: a press whose statement fails while another with the same charge is between its charge and its statement: the money goes back once, and the other press adds nothing for a refunded charge', async () => {
      const fails: WriteFailure = { table: 'booking_guests', event: 'INSERT', when: 'true' }
      await attempt(publicOnCard, async (placed, context) => {
        const bookingId = placed['bookingId'] as string
        await context.db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.customer])
        const press = () => context.call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card', storeCredit: { amount: 5 } } })
        let inner: unknown = null
        beforeTheStartedRow(async () => {
          inner = await whileFailing(context.db, fails, press)
        })
        const outer = await press()
        expect(inner).toMatchObject({ added: false })
        expect(outer).toMatchObject({ added: false, reason: 'booking_changed' })
        expect(await guests(context.db, bookingId)).toBe(2)
        expect(await bookingRow(context.db, bookingId)).toMatchObject({ party_size: 2, price_paid: '40.00' })
        expect(await booked(context.db, ID.session)).toEqual([2])
        expect(context.stripe.netPence).toBe(4000)
        expect(await balance(context.db)).toBe(10)
      })
    })

    it('Add Guest: the statement wrote and only its answer was lost: nothing is refunded or given back', async () => {
      const recording = await attempt(publicOnCard, async (placed, context) => {
        const bookingId = placed['bookingId'] as string
        await context.db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.customer])
        await losingTheAnswer(
          (sql) => sql.includes('INSERT INTO booking_guests'),
          () => context.call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card', storeCredit: { amount: 5 } } })
        )
        expect(await guests(context.db, bookingId)).toBe(3)
        expect(await booked(context.db, ID.session)).toEqual([3])
        expect(context.stripe.netPence).toBe(5500)
        expect(await balance(context.db)).toBe(5)
      })
      expect(last(recording)).toMatchObject({ added: false, message: expect.stringContaining('only taken once') })
    })

    it('Move: the statement wrote and only its answer was lost: nothing is undone, refunded or given back', async () => {
      const recording = await moveOn(async (_bookingId, _context, press) => {
        await losingTheAnswer((sql) => sql.includes('SET session_id = $1'), press)
      })
      expect(last(recording)).toMatchObject({ moved: false, reason: 'already_moved', message: expect.stringContaining('only taken once') })
    })

    it('Add Guest: a press that read the booking before another finished is not told to wait; it finds that charge finished and takes nothing twice', async () => {
      await addGuestOn(async (_bookingId, _context, press) => {
        const real = data()
        let inner: unknown = null
        vi.stubGlobal('paddockData', {
          async query(sql: string, params: unknown[] = []) {
            if (sql.includes("f.action = 'booking.card_charge_finished'")) {
              vi.stubGlobal('paddockData', real)
              inner = await press()
            }
            return real.query(sql, params)
          },
        })
        const outer = await press()
        expect(inner).toMatchObject({ added: true })
        expect(outer).toMatchObject({ added: false, reason: 'already_added' })
      })
    })

    it('the started and finished rows name who pressed (review item 14)', async () => {
      await addGuestOn(async (bookingId, context, press) => {
        await press()
        const rows = await context.db.query<{ action: string; actor_id: string | null }>(
          `SELECT action, actor_id FROM audit_log WHERE entity_id = $1 AND action LIKE 'booking.card_charge_%' ORDER BY at`,
          [bookingId]
        )
        expect(rows).toEqual([
          { action: 'booking.card_charge_started', actor_id: ID.staff },
          { action: 'booking.card_charge_finished', actor_id: ID.staff },
        ])
      })
    })

    it('a press after a death, within the minute, is told to wait; after it, it finishes the charge (dyingAfter waits that minute)', async () => {
      await addGuestOn(async (_bookingId, _context, press) => {
        await dyingAfter(CHARGE_PATH, press, { secondsLater: 5 })
        expect(await press()).toMatchObject({ added: false, reason: 'card_charge_in_progress' })
        later(A_PRESS_LATER)
        expect(await press()).toMatchObject({ added: true })
      })
    })
  })

  // --- Finding 4 (P4): a charge whose order lands after the press gave up ---------------------------

  it('P4: the answer is lost, the parts go back, the Worker then charges and writes its order: the next press takes the parts again', async () => {
    const recording = await addGuestOn(async (_bookingId, context, press) => {
      expect(await chargeLandingLate(press)).toMatchObject({ added: false })
      // The parts went back, and the Worker has since charged and written its order.
      expect(await balance(context.db)).toBe(10)
      expect(context.stripe.netPence).toBe(5500)
      expect(await press()).toMatchObject({ added: true })
    })
    expect(audit(recording, 'booking.card_charge_parts_returned')).toHaveLength(1)
  })

  // --- Finding 2 (P3): two cancels of the same event place ------------------------------------------

  describe('P3: two cancels of the same event place to the card at once', () => {
    const placesOf = async (db: Db, eventBookingId: unknown) =>
      (
        await db.query<{ id: string; cancelled: boolean; card: string }>(
          `SELECT id, cancelled_at IS NOT NULL AS cancelled, to_char(card_refunded_amount, 'FM990.00') AS card FROM event_attendees WHERE event_booking_id = $1 ORDER BY created_at, id`,
          [eventBookingId as string]
        )
      ).map((row) => ({ id: row.id, cancelled: row.cancelled, card: row.card }))
    const lineCard = async (db: Db, eventBookingId: unknown) =>
      (await db.query<{ c: string }>(`SELECT to_char(card_refunded_amount, 'FM990.00') AS c FROM order_line_items WHERE event_booking_id = $1 AND item_type = 'event'`, [eventBookingId as string]))[0]?.c

    it('the press that loses records nothing and says someone else cancelled them; the other place is then refunded for real', async () => {
      await attempt({ event: eventPlaces, payment: { method: 'card' } }, async (placed, context) => {
        const eventBookingId = placed['eventBookingId']
        const [one, two] = await placesOf(context.db, eventBookingId)
        const cancel = (id: string) => context.call('cancelEventPlaces', { eventBookingId, attendeeIds: [id], refund: 'card' }) as Promise<Row>
        let inner: Row | null = null
        afterTheRefund(async () => {
          inner = await cancel(one!.id)
        })
        const outer = await cancel(one!.id)
        expect(inner).toMatchObject({ ok: true, cardRefundedAmount: 40 })
        expect(outer).toMatchObject({ ok: false, reason: 'changed_by_someone_else', message: expect.stringContaining('Someone else cancelled') })
        expect(JSON.stringify(outer)).not.toContain('recorded on the order')
        expect(await lineCard(context.db, eventBookingId)).toBe('40.00')
        expect(context.stripe.refundedPence).toBe(4000)
        expect(await cancel(two!.id)).toMatchObject({ ok: true, cardRefundedAmount: 40 })
        expect(await lineCard(context.db, eventBookingId)).toBe('80.00')
        expect(context.stripe.refundedPence).toBe(8000)
        expect(await placesOf(context.db, eventBookingId)).toEqual([
          { id: one!.id, cancelled: true, card: '40.00' },
          { id: two!.id, cancelled: true, card: '40.00' },
        ])
      })
    })

    it('a press whose statement fails for its own reason, with the other press between its refund and its statement: the line still counts £40 once', async () => {
      const fails: WriteFailure = { table: 'event_attendees', event: 'UPDATE', when: 'true' }
      await attempt({ event: eventPlaces, payment: { method: 'card' } }, async (placed, context) => {
        const eventBookingId = placed['eventBookingId']
        const [one] = await placesOf(context.db, eventBookingId)
        const cancel = () => context.call('cancelEventPlaces', { eventBookingId, attendeeIds: [one!.id], refund: 'card' }) as Promise<Row>
        let inner: Row | null = null
        afterTheRefund(async () => {
          inner = await whileFailing(context.db, fails, cancel)
        })
        const outer = await cancel()
        expect(inner).toMatchObject({ ok: false })
        expect(outer).toMatchObject({ ok: true })
        expect(await lineCard(context.db, eventBookingId)).toBe('40.00')
        expect(context.stripe.refundedPence).toBe(4000)
      })
    })
  })

  // --- Finding 3 (P5): a held card refund settled more than 24 hours later --------------------------

  describe('P5: a refund with no clear answer, pressed again two days later', () => {
    const placesOf = async (db: Db, eventBookingId: unknown) =>
      (await db.query<{ id: string }>('SELECT id FROM event_attendees WHERE event_booking_id = $1 ORDER BY created_at, id', [eventBookingId as string])).map((row) => row.id)
    const refundCalls = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create').length

    it('event: the refund went, so it is found by its key, never sent again; £80 back on £80', async () => {
      const recording = await attempt({ event: eventPlaces, payment: { method: 'card' } }, async (placed, context) => {
        const eventBookingId = placed['eventBookingId']
        const [one, two] = await placesOf(context.db, eventBookingId)
        const cancel = (id: string, refund = 'card') => context.call('cancelEventPlaces', { eventBookingId, attendeeIds: [id], refund }) as Promise<Row>
        await losingTheWorkersAnswer(REFUND_PATH, () => cancel(one!))
        later(TWO_DAYS)
        context.stripe.forgetIdempotencyKeys()
        expect(await cancel(two!)).toMatchObject({ ok: true })
        expect(refundCalls(context.stripe)).toBe(1)
        expect(context.stripe.refundedPence).toBe(4000)
        expect(await cancel(one!)).toMatchObject({ ok: true })
        expect(context.stripe.refundedPence).toBe(8000)
      })
      expect(added(recording, 'store_credit_transactions')).toEqual([])
      expect(recording.stripeCalls.filter((call) => call.method === 'refunds.list')).toHaveLength(1)
    })

    it('event: the refund never reached Stripe, so the look finds nothing, counts it as a no, and the press refunds for real', async () => {
      await attempt({ event: eventPlaces, payment: { method: 'card' } }, async (placed, context) => {
        const eventBookingId = placed['eventBookingId']
        const [one, two] = await placesOf(context.db, eventBookingId)
        const cancel = (id: string) => context.call('cancelEventPlaces', { eventBookingId, attendeeIds: [id], refund: 'card' }) as Promise<Row>
        context.stripe.failNext('refunds.create', { kind: 'unreachable' })
        expect(await cancel(one!)).toMatchObject({ ok: false, reason: 'refund_unsure' })
        later(TWO_DAYS)
        context.stripe.forgetIdempotencyKeys()
        expect(await cancel(two!)).toMatchObject({ ok: true, cardRefundedAmount: 40 })
        expect(await cancel(one!)).toMatchObject({ ok: true, cardRefundedAmount: 40 })
        expect(context.stripe.refundedPence).toBe(8000)
      })
    })

    it('event: the look itself fails, so the press stops with nothing done', async () => {
      await attempt({ event: eventPlaces, payment: { method: 'card' } }, async (placed, context) => {
        const eventBookingId = placed['eventBookingId']
        const [one, two] = await placesOf(context.db, eventBookingId)
        const cancel = (id: string) => context.call('cancelEventPlaces', { eventBookingId, attendeeIds: [id], refund: 'card' }) as Promise<Row>
        await losingTheWorkersAnswer(REFUND_PATH, () => cancel(one!))
        later(TWO_DAYS)
        context.stripe.forgetIdempotencyKeys()
        context.stripe.failNext('refunds.list', { kind: 'unreachable' })
        expect(await cancel(two!)).toMatchObject({ ok: false, reason: 'refund_unsure', message: expect.stringContaining('more than a day ago') })
        expect(refundCalls(context.stripe)).toBe(1)
        expect(context.stripe.refundedPence).toBe(4000)
      })
    })

    it('within 23 hours it is still sent again with the same key, as before', async () => {
      await attempt({ event: eventPlaces, payment: { method: 'card' } }, async (placed, context) => {
        const eventBookingId = placed['eventBookingId']
        const [one, two] = await placesOf(context.db, eventBookingId)
        const cancel = (id: string) => context.call('cancelEventPlaces', { eventBookingId, attendeeIds: [id], refund: 'card' }) as Promise<Row>
        await losingTheWorkersAnswer(REFUND_PATH, () => cancel(one!))
        later(22 * 60 * 60 * 1000)
        await cancel(two!)
        expect(context.stripe.calls.filter((call) => call.method === 'refunds.list')).toEqual([])
        expect(refundCalls(context.stripe)).toBe(2)
        expect(context.stripe.refundedPence).toBe(4000)
      })
    })

    it('refundOrder: the same, found by its key', async () => {
      const soap = { productVariantId: ID.variant, quantity: 2, unitPrice: 12, systemUnitPrice: 12 }
      await attempt({ products: [soap], payment: { method: 'card' } }, async (placed, context) => {
        const lineId = (await context.db.query<{ id: string }>(`SELECT id FROM order_line_items WHERE order_id = $1 AND item_type = 'product'`, [placed['orderId'] as string]))[0]!.id
        const refund = (refundMethod: string) =>
          context.call('refundOrder', { orderId: placed['orderId'], lineItemIds: [lineId], refundMethod, restock: { [lineId]: false } }) as Promise<Row>
        await losingTheWorkersAnswer(REFUND_PATH, () => refund('card'))
        later(TWO_DAYS)
        context.stripe.forgetIdempotencyKeys()
        await refund('credit')
        expect(refundCalls(context.stripe)).toBe(1)
        expect(context.stripe.refundedPence).toBe(2400)
        expect(await moves(context.db, 'refund')).toEqual([])
      })
    })

    it('every refund carries its key on Stripe, so it can be found', async () => {
      await attempt(noPromoOnCard, async (placed, context) => {
        await context.call('refundBooking', { bookingId: placed['bookingId'], refundMethod: 'card', amount: 10, ...goodwill })
        const [refund] = context.stripe.calls.filter((call) => call.method === 'refunds.create')
        expect(refund?.params).toMatchObject({ metadata: { refund_key: refund?.idempotencyKey } })
      })
    })

    describe('Refund the rest on a booking, after an unclear part refund', () => {
      it('the first refund went: it is found by its key, so the rest is given with no second refund', async () => {
        await attempt(noPromoOnCard, async (placed, context) => {
          const bookingId = placed['bookingId']
          await losingTheWorkersAnswer(REFUND_PATH, () => context.call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, ...goodwill }))
          expect(await bookingRow(context.db, bookingId)).toMatchObject({ price_paid: '100.00', owed: '40.00' })
          later(TWO_DAYS)
          context.stripe.forgetIdempotencyKeys()
          await context.call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
          expect(refundCalls(context.stripe)).toBe(1)
          expect(context.stripe.refundedPence).toBe(4000)
          expect(await bookingRow(context.db, bookingId)).toMatchObject({ price_paid: '60.00', owed: '0.00' })
        })
      })

      it('the first refund never reached Stripe: the look finds nothing, and the rest is refunded once', async () => {
        await attempt(noPromoOnCard, async (placed, context) => {
          const bookingId = placed['bookingId']
          context.stripe.failNext('refunds.create', { kind: 'unreachable' })
          await context.call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, ...goodwill })
          later(TWO_DAYS)
          context.stripe.forgetIdempotencyKeys()
          await context.call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
          expect(context.stripe.refundedPence).toBe(4000)
          expect(await bookingRow(context.db, bookingId)).toMatchObject({ price_paid: '60.00', owed: '0.00' })
        })
      })

      it('another refund on the same payment, with its own key, is not taken for it', async () => {
        await attempt(noPromoOnCard, async (placed, context) => {
          const bookingId = placed['bookingId']
          await context.call('refundBooking', { bookingId, refundMethod: 'card', amount: 10, ...goodwill })
          context.stripe.failNext('refunds.create', { kind: 'unreachable' })
          await context.call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, ...goodwill })
          later(TWO_DAYS)
          context.stripe.forgetIdempotencyKeys()
          await context.call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
          expect(context.stripe.refundedPence).toBe(5000)
          expect(await bookingRow(context.db, bookingId)).toMatchObject({ price_paid: '50.00', owed: '0.00' })
        })
      })

      it('Stripe still holds the first key with a saved error: not found counts as a no, so a new key gets past it', async () => {
        await attempt(noPromoOnCard, async (placed, context) => {
          const bookingId = placed['bookingId']
          context.stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.server() })
          await context.call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, ...goodwill })
          expect(await bookingRow(context.db, bookingId)).toMatchObject({ owed: '40.00' })
          later(TWO_DAYS)
          await context.call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })
          expect(context.stripe.refundedPence).toBe(4000)
          expect(await bookingRow(context.db, bookingId)).toMatchObject({ price_paid: '60.00', owed: '0.00' })
        })
      })
    })
  })

  // --- Finding 5 (P6): a reader payment whose refund fails or is unclear ----------------------------

  describe('P6: a reader move whose recording fails', () => {
    const readerMove = async (context: ScenarioContext, bookingId: unknown) => {
      const moved = (await context.call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'reader' } })) as {
        pendingReaderPayment: { pendingId: string; paymentIntentId: string }
      }
      context.stripe.completeReaderPayment(moved.pendingReaderPayment.paymentIntentId)
      return moved.pendingReaderPayment
    }
    const ordersFail: WriteFailure = { table: 'orders', event: 'INSERT', when: 'true' }

    it('and the refund is unclear: the move is still undone, so Cancel & Refund gives back what is left, £51 in all on £51', async () => {
      await attempt(publicOnCard, async (placed, context) => {
        const bookingId = placed['bookingId']
        const { pendingId, paymentIntentId } = await readerMove(context, bookingId)
        const finalised = await whileFailing(context.db, ordersFail, () => losingTheWorkersAnswer(REFUND_PATH, () => context.call('finaliseReaderPayment', { pendingId })))
        expect(finalised).toMatchObject({
          finalised: false,
          reason: 'refund_unsure',
          message: expect.stringContaining(`The booking move was undone. The automatic refund of £11.00 gave no clear answer: check payment ${paymentIntentId} in Stripe and refund it there only if it isn't refunded.`),
        })
        expect(await bookingRow(context.db, bookingId)).toMatchObject({ session_id: ID.session, price_paid: '40.00' })
        expect(await booked(context.db, ID.session, ID.peakSession)).toEqual([2, 0])
        await context.call('refundBooking', { bookingId, refundMethod: 'card' })
        expect(context.stripe.refundedPence).toBe(5100)
        expect(await moves(context.db, 'refund')).toEqual([])
      })
    })

    it('and the refund is refused: the move is undone too, and staff are told to refund it in Stripe only if it is not', async () => {
      await attempt(publicOnCard, async (placed, context) => {
        const bookingId = placed['bookingId']
        const { pendingId, paymentIntentId } = await readerMove(context, bookingId)
        context.stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.invalid('charge_disputed', 'This charge is disputed.') })
        const finalised = await whileFailing(context.db, ordersFail, () => context.call('finaliseReaderPayment', { pendingId }))
        expect(finalised).toMatchObject({
          finalised: false,
          reason: 'refund_failed',
          message: expect.stringContaining(`The booking move was undone. The automatic refund of £11.00 failed: check payment ${paymentIntentId} in Stripe and refund it there only if it isn't refunded.`),
        })
        expect(await bookingRow(context.db, bookingId)).toMatchObject({ session_id: ID.session, price_paid: '40.00' })
      })
    })
  })

  // --- Review item 9: store credit taken back or put back, with its answer lost ----------------------

  describe('store credit taken back or put back, with its answer lost, is found by its note', () => {
    const negative = (sql: string, params: unknown[]) => sql.includes('store_credit_apply') && Number(params[1]) < 0
    const reversal = (sql: string, params: unknown[]) => sql.includes('store_credit_apply') && params[2] === 'redemption_reversal'

    it('Cancel & Refund to store credit whose last statement fails: the take-back is found, so nobody is told to remove it by hand', async () => {
      const recording = await attempt(noPromoOnCard, async (placed, context) => {
        await whileFailing(context.db, cancelWriteFails, () =>
          losingTheAnswer(negative, () => context.call('refundBooking', { bookingId: placed['bookingId'], refundMethod: 'credit' }))
        )
        expect(await moves(context.db, 'refund')).toEqual(['100.00', '-100.00'])
      })
      // refundBooking throws its message and warning together.
      expect(JSON.stringify(last(recording))).toContain('was taken back')
    })

    it('an event cancel to store credit whose statement fails: the same', async () => {
      const fails: WriteFailure = { table: 'event_bookings', event: 'UPDATE', when: 'true' }
      const recording = await attempt({ event: eventPlaces, payment: { method: 'card' } }, async (placed, context) => {
        const [one] = (await context.db.query<{ id: string }>('SELECT id FROM event_attendees WHERE event_booking_id = $1 ORDER BY created_at, id', [placed['eventBookingId'] as string]))
        await whileFailing(context.db, fails, () =>
          losingTheAnswer(negative, () => context.call('cancelEventPlaces', { eventBookingId: placed['eventBookingId'], attendeeIds: [one!.id], refund: 'credit' }))
        )
      })
      expect(last(recording)).toMatchObject({ ok: false, warning: expect.stringContaining('was taken back') })
    })

    it('Add Guest whose statement fails: the put-back of the store credit is found, so it counts as given back', async () => {
      const fails: WriteFailure = { table: 'booking_guests', event: 'INSERT', when: 'true' }
      const recording = await attempt(publicOnCard, async (placed, context) => {
        await context.db.query(`UPDATE customers SET store_credit_balance = 10 WHERE id = $1`, [ID.customer])
        await whileFailing(context.db, fails, () =>
          losingTheAnswer(reversal, () => context.call('addBookingGuest', { bookingId: placed['bookingId'], ...bea, payment: { method: 'card', storeCredit: { amount: 5 } } }))
        )
        expect(await balance(context.db)).toBe(10)
      })
      expect(last(recording)).toMatchObject({ added: false, reason: 'guest_add_failed' })
    })
  })

  // --- Review item 11: Remove Guest, unclear partway, then the delete fails --------------------------

  it('Remove Guest: the card gives no clear answer partway and the delete fails: the unclear part is owed, and staff are told to check', async () => {
    const recording = await attempt(publicOnCard, async (placed, context) => {
      const bookingId = placed['bookingId'] as string
      const guest = (await context.call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })) as { guest: { id: string } }
      // £20 for the guest: £10 from the newest order, then the next order's refund has no answer.
      await context.call('refundBooking', { bookingId, refundMethod: 'card', amount: 10, ...goodwill })
      context.stripe.failNext('refunds.create', { kind: 'none' })
      context.stripe.failNext('refunds.create', { kind: 'unreachable' })
      const fails: WriteFailure = { table: 'booking_guests', event: 'DELETE', when: 'true' }
      await whileFailing(context.db, fails, () => context.call('removeBookingGuest', { guestId: guest.guest.id, confirmedRefundAmount: 20, refundMethod: 'card' }))
      // £60 paid, £10 part refunded, £10 back to the card and £10 that may have gone: £40 left, £10 of it owed.
      expect(await bookingRow(context.db, bookingId)).toMatchObject({ price_paid: '40.00', owed: '10.00' })
    })
    expect(last(recording)).toMatchObject({ removed: false, retryLocked: true, message: expect.stringContaining('This may have gone through') })
    expect(JSON.stringify(last(recording))).not.toContain("wasn't added to store credit")
  })

  // --- Review item 10: the query for a charge left with nothing added --------------------------------

  it('the README query lists a charge whose press died after finishing with its key but before the refund', async () => {
    const readme = readFileSync(path.join(__dirname, '../../README.md'), 'utf8')
    const section = readme.slice(readme.indexOf('## Card charges with nothing to show for them'))
    const sql = /```sql\n([\s\S]*?)```/.exec(section)?.[1]
    expect(sql).toBeTruthy()
    await attempt(publicOnCard, async (placed, context) => {
      const bookingId = placed['bookingId'] as string
      const fails: WriteFailure = { table: 'booking_guests', event: 'INSERT', when: 'true' }
      // The statement fails, the key is retired, and the function dies before the refund.
      await whileFailing(context.db, fails, () =>
        dyingAfterStatement(
          (sql) => sql.startsWith('UPDATE bookings SET updated_at = now()'),
          () => context.call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })
        )
      )
      expect(context.stripe.netPence).toBe(6000)
      later(10 * 60 * 1000)
      const rows = await context.db.query<Row>(sql!)
      expect(rows).toEqual([expect.objectContaining({ booking_id: bookingId, amount: '20' })])
    })
  })

  // --- Finding 6 and the screens ----------------------------------------------------------------------

  describe('the screens', () => {
    const frontend = (file: string) => readFileSync(path.join(backendDir, '../../frontend', file), 'utf8')

    it.each(['components/AddGuestDialog.tsx', 'components/MoveBookingDialog.tsx', 'components/SettleLapsedPaymentDialog.tsx'])(
      '%s can not be closed while its call is running',
      (file) => {
        expect(frontend(file)).toMatch(/onOpenChange=\{\(next\) => \(readerWaiting \|\| submitting \? undefined/)
      }
    )

    it('the store credit history hides the [ref …] at the end of a note', async () => {
      const { storeCreditNoteForDisplay } = (await import(/* @vite-ignore */ path.join(backendDir, '../../frontend/utils/storeCreditNote.ts'))) as {
        storeCreditNoteForDisplay(note: string | null): string | null
      }
      expect(storeCreditNoteForDisplay('Booking refund. [ref 0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d]')).toBe('Booking refund.')
      expect(storeCreditNoteForDisplay('A note [ref] someone typed')).toBe('A note [ref] someone typed')
      expect(storeCreditNoteForDisplay(null)).toBeNull()
      expect(frontend('components/StoreCreditSection.tsx')).toContain('storeCreditNoteForDisplay(')
    })
  })

})
