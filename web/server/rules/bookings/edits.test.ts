import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as requestsRoute } from '@/app/api/v1/staff/bookings/[bookingId]/special-requests/route'
import { POST as statusRoute } from '@/app/api/v1/staff/bookings/[bookingId]/status/route'
import type { Db } from '@/server/db'
import { INTERNAL_MESSAGE } from '@/server/http/errors'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ReplaySide, type ScenarioContext } from '@/server/rules/testing/replay/harness'
import { ID, lapsedSeat, publicOnCard, seed, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { insert } from '@/server/rules/testing/database'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import { SPECIAL_REQUESTS_MAX, STAFF_STATUSES } from './edits'
import {
  CANCEL_CREDIT_WORDS,
  CARD_PAYMENT_OPEN_MESSAGE,
  invalidStatusMessage,
  READER_PAYMENT_OPEN_MESSAGE,
  STATUS_PAYMENT_NEEDED_MESSAGE,
  STATUS_TIME_CONFLICT_MESSAGE,
  STATUS_WORDS,
} from './failure-messages'
import { BOOKING_STATUSES } from './load-booking'

// Brief W18: the special requests and status routes (D-plan 1.9, 4.4; N3), on the replay's live schema (its triggers
// and constraints included), and the staff app's two thin wrappers through them.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

const KEY = 'test-staff-api-key'
const INACTIVE = 'gone@example.com'

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

/** The seed, and a paid public booking for Sam (two seats, £40 on the card), as the N3 recordings start. */
async function onABooking(work: (bookingId: string, side: ReplaySide) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w18 edits',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await insert(seedDb, 'staff', { first_name: 'Gone', last_name: 'Away', email: INACTIVE, role: 'staff', can_issue_refunds: true, can_manage_pricing: true, active: false })
      },
      async run({ side }) {
        const { bookingId } = (await side.call('createOrder', { customerId: ID.customer, ...publicOnCard })) as { bookingId: string }
        await work(bookingId, side)
      },
    },
    oldSide
  )
}

type Answer = { status: number; body: { ok: boolean; data?: unknown; error?: { code: string; message: string; field?: string; details?: { reason?: string; message?: string; action?: string } } } }

async function post(kind: 'status' | 'special-requests', bookingId: string, body: unknown, { email = REPLAY_USER.email, key = crypto.randomUUID() } = {}): Promise<Answer> {
  const route = kind === 'status' ? statusRoute : requestsRoute
  const response = await route(
    new Request(`https://worker.test/api/v1/staff/bookings/${bookingId}/${kind}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': email, 'idempotency-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ bookingId }) }
  )
  return { status: response.status, body: (await response.json()) as Answer['body'] }
}

const bookingRow = async (bookingId: string) =>
  (await db.query<{ status: string; special_requests: string | null; cancelled_at: unknown; price_paid: string }>('SELECT status, special_requests, cancelled_at, price_paid::text AS price_paid FROM bookings WHERE id = $1', [bookingId]))[0]
type AuditRow = { id: string; action: string; actor_id: string; details: Record<string, unknown> }
const auditRows = async (bookingId: string) =>
  db.query<AuditRow>(
    `SELECT id::text AS id, action, actor_id, details FROM audit_log WHERE entity_type = 'booking' AND entity_id = $1 AND action IN ('booking.status', 'booking.special_requests')`,
    [bookingId]
  )
/** The replay holds the clock still (Postgres's too), so rows written by one call are told apart by id, not time. */
const auditRowsSince = async (bookingId: string, before: AuditRow[]) => {
  const seen = new Set(before.map((row) => row.id))
  return (await auditRows(bookingId)).filter((row) => !seen.has(row.id)).map(({ action, actor_id, details }) => ({ action, actor_id, details }))
}
const fromTo = (details: Record<string, unknown>) => `${String(details['from'])}->${String(details['to'])}`
const setStatusDirectly = (bookingId: string, status: string) =>
  db.query(`UPDATE bookings SET status = $1, cancelled_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $3`, [status, status === 'cancelled', bookingId])
const staffId = async (email: string) => (await db.query<{ id: string }>('SELECT id FROM staff WHERE email = $1', [email]))[0]?.id

const allowed = (status: string) => (STAFF_STATUSES as readonly string[]).includes(status)

describe('the status route (N3)', () => {
  it('every pair, from each of the six statuses to each of the six: only the four the select offers, never from payment needed or cancelled', async () => {
    const seen: string[] = []
    const expected: string[] = []
    await onABooking(async (bookingId) => {
      for (const from of BOOKING_STATUSES) {
        for (const to of BOOKING_STATUSES) {
          await setStatusDirectly(bookingId, from)
          const before = await auditRows(bookingId)
          const answer = await post('status', bookingId, { status: to })
          const after = await bookingRow(bookingId)
          const audits = await auditRowsSince(bookingId, before)
          const outcome = answer.body.ok
            ? `ok ${JSON.stringify(answer.body.data)} row=${after?.status} cancelled_at=${String(after?.cancelled_at)} audit=${audits.map((a) => `${a.action} ${fromTo(a.details)}`).join(', ')}`
            : `${answer.status} ${answer.body.error?.code} ${answer.body.error?.details?.reason}: ${answer.body.error?.message} row=${after?.status} audit=${audits.length}`
          seen.push(`${from} -> ${to}: ${outcome}`)

          let wanted: string
          if (!allowed(to)) wanted = `400 VALIDATION invalid_status: ${invalidStatusMessage(to, STAFF_STATUSES)} row=${from} audit=0`
          else if (from === 'cancelled') wanted = `409 CONFLICT booking_cancelled: ${STATUS_WORDS.cancelled} row=${from} audit=0`
          else if (from === 'payment_needed') wanted = `409 CONFLICT booking_payment_needed: ${STATUS_PAYMENT_NEEDED_MESSAGE} row=${from} audit=0`
          else wanted = `ok ${JSON.stringify({ id: bookingId, status: to, cancelled_at: null })} row=${to} cancelled_at=null audit=booking.status ${from}->${to}`
          expected.push(`${from} -> ${to}: ${wanted}`)
        }
      }
    })
    expect(seen).toEqual(expected)
    // 16 of the 36 go through.
    expect(seen.filter((line) => line.includes(': ok ')).length).toBe(16)
  })

  it('the refusal carries what the wrappers need: the reason, the words and the action', async () => {
    await onABooking(async (bookingId) => {
      const answer = await post('status', bookingId, { status: 'cancelled' })
      expect(answer.body.error).toEqual({
        code: 'VALIDATION',
        field: 'status',
        message: invalidStatusMessage('cancelled', STAFF_STATUSES),
        details: { reason: 'invalid_status', message: invalidStatusMessage('cancelled', STAFF_STATUSES), action: 'status' },
      })
    })
  })

  it('a booking that does not exist: not found, with the words', async () => {
    await onABooking(async () => {
      const answer = await post('status', '99999999-9999-4999-8999-999999999999', { status: 'completed' })
      expect(answer.status).toBe(404)
      expect(answer.body.error?.details).toEqual({ reason: 'booking_not_found', message: CANCEL_CREDIT_WORDS.bookingNotFound, action: 'status' })
    })
  })

  it('the audit row names who, and is in the same transaction: a failure after it writes nothing', async () => {
    await onABooking(async (bookingId) => {
      const failed = await whileFailing(db, { table: 'bookings', event: 'UPDATE', when: 'true' }, () => post('status', bookingId, { status: 'completed' }))
      expect(failed.status).toBe(500)
      expect(failed.body.error).toMatchObject({ code: 'INTERNAL', message: INTERNAL_MESSAGE })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed' })
      expect(await auditRows(bookingId)).toEqual([])

      expect((await post('status', bookingId, { status: 'completed' })).body.ok).toBe(true)
      expect(await auditRowsSince(bookingId, [])).toEqual([{ action: 'booking.status', actor_id: await staffId(REPLAY_USER.email), details: { from: 'confirmed', to: 'completed' } }])
    })
  })

  it('an inactive staff account is refused before anything is read or written', async () => {
    await onABooking(async (bookingId) => {
      const answer = await post('status', bookingId, { status: 'completed' }, { email: INACTIVE })
      expect(answer.status).toBe(403)
      expect(answer.body.error?.message).toBe('This staff account is inactive. Ask an admin to reactivate it.')
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed' })
      expect(await auditRows(bookingId)).toEqual([])
    })
  })

  it('the same key twice: one change, one audit row, the same answer', async () => {
    await onABooking(async (bookingId) => {
      const key = crypto.randomUUID()
      const first = await post('status', bookingId, { status: 'no-show' }, { key })
      const second = await post('status', bookingId, { status: 'no-show' }, { key })
      expect(second.body).toEqual(first.body)
      expect(await auditRows(bookingId)).toHaveLength(1)
    })
  })

  it('moves no money, so the switch never stops it (every kind off, as in the replay)', async () => {
    expect(process.env.ORDER_SWITCH ?? '').toBe('')
    await onABooking(async (bookingId) => {
      expect((await post('status', bookingId, { status: 'completed' })).body.ok).toBe(true)
      expect((await post('special-requests', bookingId, { specialRequests: 'Quiet corner' })).body.ok).toBe(true)
    })
  })

  it('a no-show made active again on a day the customer has another booking: the trigger\'s words, nothing written', async () => {
    await onABooking(async (bookingId) => {
      await post('status', bookingId, { status: 'no-show' })
      // Another booking for Sam that day, as a rebooking after the no-show would be.
      await db.query(
        `INSERT INTO bookings (session_id, customer_id, party_size, status, price_paid, start_time, end_time)
         SELECT session_id, customer_id, 1, 'confirmed', 0, start_time, end_time FROM bookings WHERE id = $1`,
        [bookingId]
      )
      const answer = await post('status', bookingId, { status: 'confirmed' })
      expect(answer.status).toBe(409)
      expect(answer.body.error?.code).toBe('DAY_ALREADY_BOOKED')
      expect(answer.body.error?.details?.reason).toBe('duplicate_day_booking')
      expect(answer.body.error?.message).toMatch(/^This customer already has a booking on \d{2} \w{3} \d{4}\. Only one booking per customer per day is allowed\.$/)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'no-show' })
      expect((await auditRows(bookingId)).map((row) => row.details)).toEqual([{ from: 'confirmed', to: 'no-show' }])
    })
  })

  it('a no-show made active again when another booking now overlaps its time: refused with words, nothing written', async () => {
    await onABooking(async (bookingId) => {
      await post('status', bookingId, { status: 'no-show' })
      // Mo, in another session at the same time (the venue takes one session type at a time).
      await db.query(
        `INSERT INTO bookings (session_id, customer_id, party_size, status, price_paid, start_time, end_time)
         SELECT $1, $2, 1, 'confirmed', 0, start_time, end_time FROM bookings WHERE id = $3`,
        [ID.peakSession, ID.member, bookingId]
      )
      const answer = await post('status', bookingId, { status: 'pending' })
      expect(answer.status).toBe(409)
      expect(answer.body.error?.details).toEqual({ reason: 'time_conflict', message: STATUS_TIME_CONFLICT_MESSAGE, action: 'status' })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'no-show' })
      expect(await auditRows(bookingId)).toHaveLength(1)
    })
  })
})

describe('the status route while a payment is still being taken (W18 review S1)', () => {
  interface Pending {
    pendingReaderPayment: { pendingId: string; paymentIntentId: string }
  }
  /** Each of the four targets refused with `reason` and `message`, the booking row as it was, and no audit row. */
  const refusesAll = async (bookingId: string, reason: string, message: string) => {
    const row = await bookingRow(bookingId)
    const before = await auditRows(bookingId)
    for (const to of STAFF_STATUSES) {
      const answer = await post('status', bookingId, { status: to })
      expect(answer.status, `${to}: ${JSON.stringify(answer.body)}`).toBe(409)
      expect(answer.body.error).toEqual({ code: 'CONFLICT', message, details: { reason, message, action: 'status' } })
    }
    expect(await bookingRow(bookingId)).toEqual(row)
    expect(await auditRowsSince(bookingId, before)).toEqual([])
  }
  const goesThrough = async (bookingId: string, to: string) => {
    const answer = await post('status', bookingId, { status: to })
    expect(answer.body, JSON.stringify(answer.body)).toMatchObject({ ok: true, data: { id: bookingId, status: to, cancelled_at: null } })
    expect(await bookingRow(bookingId)).toMatchObject({ status: to })
  }
  const onTheOldSide = (name: string, run: (context: ScenarioContext) => Promise<void>) => replay(environment, { name, seed, run }, oldSide)

  it('a held reader Settle (the booking already confirmed with £20 in price_paid): refused with the reader words; once finalised it goes through', async () => {
    await onTheOldSide('w18a settle finalised', async ({ call, stripe, db: runDb }) => {
      const bookingId = await lapsedSeat(call, runDb)
      const started = (await call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })) as Pending
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed', price_paid: '20.00' })
      await refusesAll(bookingId, 'reader_payment_open', READER_PAYMENT_OPEN_MESSAGE)

      stripe.completeReaderPayment(started.pendingReaderPayment.paymentIntentId)
      await call('finaliseReaderPayment', { pendingId: started.pendingReaderPayment.pendingId })
      await goesThrough(bookingId, 'no-show')
    })
  })

  it('the review\'s £ example: the held Settle refused, so its undo puts the booking back awaiting payment with £0 paid', async () => {
    await onTheOldSide('w18a settle cancelled', async ({ call, db: runDb }) => {
      const bookingId = await lapsedSeat(call, runDb)
      const started = (await call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })) as Pending
      expect((await post('status', bookingId, { status: 'pending' })).body.error?.details?.reason).toBe('reader_payment_open')
      await call('cancelReaderPayment', { pendingId: started.pendingReaderPayment.pendingId })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'payment_needed', price_paid: '0.00' })
      // Back where it was, so N3 holds it.
      expect((await post('status', bookingId, { status: 'pending' })).body.error?.details?.reason).toBe('booking_payment_needed')
    })
  })

  it('a held saved-card flow (the Worker\'s, `method: card`): the card words; a card and a reader flow together: the reader words', async () => {
    await onTheOldSide('w18a card flow', async ({ call, db: runDb }) => {
      const bookingId = await lapsedSeat(call, runDb)
      const started = (await call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })) as Pending
      const pendingId = started.pendingReaderPayment.pendingId
      const asACardFlow = `UPDATE pending_reader_payments SET snapshot = snapshot || '{"method": "card", "request_id": "w18a-card"}'::jsonb WHERE id = $1`
      await db.query(asACardFlow, [pendingId])
      await refusesAll(bookingId, 'card_payment_open', CARD_PAYMENT_OPEN_MESSAGE)

      // A second, reader flow on the same booking: not every open flow is a card one.
      await db.query(
        `INSERT INTO pending_reader_payments (flow, record_id, payment_intent_id, expected_amount, snapshot, status)
         SELECT 'move', record_id, 'pi_w18a_second', expected_amount, '{}'::jsonb, 'pending' FROM pending_reader_payments WHERE id = $1`,
        [pendingId]
      )
      await refusesAll(bookingId, 'reader_payment_open', READER_PAYMENT_OPEN_MESSAGE)
      await db.query(`UPDATE pending_reader_payments SET status = 'cancelled' WHERE record_id = $1`, [bookingId])
      await goesThrough(bookingId, 'completed')
    })
  })

  it('a held reader Move: refused; once cancelled (the booking still confirmed) it goes through', async () => {
    await onTheOldSide('w18a move cancelled', async ({ call }) => {
      const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...publicOnCard })) as { bookingId: string }
      const started = (await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'reader' } })) as Pending
      await refusesAll(bookingId, 'reader_payment_open', READER_PAYMENT_OPEN_MESSAGE)
      await call('cancelReaderPayment', { pendingId: started.pendingReaderPayment.pendingId })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed' })
      await goesThrough(bookingId, 'pending')
    })
  })

  it('a New Order on the reader still being paid for the booking: refused with the reader words; once finalised it goes through', async () => {
    await onTheOldSide('w18a reader order', async ({ call, stripe }) => {
      const placed = (await call('createOrder', { customerId: ID.customer, ...publicOnCard, payment: { method: 'reader' } })) as Pending & { orderId: string }
      const [line] = await db.query<{ booking_id: string }>(`SELECT booking_id FROM order_line_items WHERE order_id = $1 AND item_type = 'booking'`, [placed.orderId])
      const bookingId = line?.booking_id ?? ''
      expect(await db.query(`SELECT 1 FROM pending_reader_payments WHERE record_id = $1`, [bookingId])).toEqual([])
      await refusesAll(bookingId, 'reader_payment_open', READER_PAYMENT_OPEN_MESSAGE)

      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      await call('finaliseReaderOrder', { orderId: placed.orderId })
      await goesThrough(bookingId, 'completed')
    })
  })

  it('special requests still save while a payment is being taken (they touch no money)', async () => {
    await onTheOldSide('w18a requests while held', async ({ call, db: runDb }) => {
      const bookingId = await lapsedSeat(call, runDb)
      await call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })
      expect((await post('special-requests', bookingId, { specialRequests: 'Late arrival' })).body.ok).toBe(true)
      expect(await bookingRow(bookingId)).toMatchObject({ special_requests: 'Late arrival', status: 'confirmed' })
    })
  })
})

describe('the special requests route', () => {
  /** Saves, checks the answer is the row, and returns the text saved and the call's one audit row. */
  const saving = async (bookingId: string, specialRequests: unknown) => {
    const before = await auditRows(bookingId)
    const answer = await post('special-requests', bookingId, specialRequests === undefined ? {} : { specialRequests })
    expect(answer.body.ok, JSON.stringify(answer.body)).toBe(true)
    const row = await bookingRow(bookingId)
    expect(answer.body.data).toEqual({ updated: true, booking: { id: bookingId, special_requests: row?.special_requests } })
    const audits = await auditRowsSince(bookingId, before)
    expect(audits).toHaveLength(1)
    return { text: row?.special_requests ?? null, audit: audits[0] }
  }
  const saved = async (bookingId: string, specialRequests: unknown) => (await saving(bookingId, specialRequests)).text

  it('trimmed, cut to 500 characters (after trimming), and null when empty, whitespace, null or missing', async () => {
    await onABooking(async (bookingId) => {
      const first = await saving(bookingId, '  Nut allergy \n')
      expect(first.text).toBe('Nut allergy')
      expect(first.audit).toEqual({ action: 'booking.special_requests', actor_id: await staffId(REPLAY_USER.email), details: { changed: true, previousLength: null, length: 11 } })
      expect(await saved(bookingId, 'x'.repeat(600))).toBe('x'.repeat(SPECIAL_REQUESTS_MAX))
      expect(await saved(bookingId, `   ${'y'.repeat(499)}z${'w'.repeat(10)}`)).toBe(`${'y'.repeat(499)}z`)
      expect(await saved(bookingId, 'a'.repeat(500))).toBe('a'.repeat(500))
      const cleared = await saving(bookingId, '')
      expect(cleared.text).toBeNull()
      expect(cleared.audit?.details).toEqual({ changed: true, previousLength: 500, length: null })
      expect((await saving(bookingId, null)).audit?.details).toEqual({ changed: false, previousLength: null, length: null })
      expect(await saved(bookingId, 'Step-free access')).toBe('Step-free access')
      expect(await saved(bookingId, '   \n\t ')).toBeNull()
      expect(await saved(bookingId, 'Again')).toBe('Again')
      expect(await saved(bookingId, null)).toBeNull()
      expect(await saved(bookingId, 'Once more')).toBe('Once more')
      expect(await saved(bookingId, undefined)).toBeNull()
      // One audit row each, with lengths and never the text.
      const audits = await auditRows(bookingId)
      expect(audits).toHaveLength(12)
      expect(JSON.stringify(audits)).not.toContain('Nut allergy')
    })
  })

  it('a cancelled booking is refused with the screen\'s words; payment needed, completed and no-show are not', async () => {
    await onABooking(async (bookingId) => {
      for (const status of ['payment_needed', 'completed', 'no-show', 'pending']) {
        await setStatusDirectly(bookingId, status)
        expect(await saved(bookingId, `While ${status}`)).toBe(`While ${status}`)
      }
      await setStatusDirectly(bookingId, 'cancelled')
      const answer = await post('special-requests', bookingId, { specialRequests: 'Too late' })
      expect(answer.status).toBe(409)
      expect(answer.body.error?.details).toEqual({ reason: 'booking_cancelled', message: 'Cancelled bookings cannot be edited.', action: 'special_requests' })
      expect(await bookingRow(bookingId)).toMatchObject({ special_requests: 'While pending' })
      expect(await auditRows(bookingId)).toHaveLength(4)
    })
  })

  it('a booking that does not exist: not found, with the screen\'s words', async () => {
    await onABooking(async () => {
      const answer = await post('special-requests', '99999999-9999-4999-8999-999999999999', { specialRequests: 'x' })
      expect(answer.status).toBe(404)
      expect(answer.body.error?.details).toEqual({ reason: 'booking_not_found', message: 'Failed to save special requests.', action: 'special_requests' })
    })
  })

  it('the audit row is in the same transaction: a failure after it writes nothing', async () => {
    await onABooking(async (bookingId) => {
      const failed = await whileFailing(db, { table: 'bookings', event: 'UPDATE', when: 'true' }, () => post('special-requests', bookingId, { specialRequests: 'Lost' }))
      expect(failed.body.error).toMatchObject({ code: 'INTERNAL', message: INTERNAL_MESSAGE })
      expect(await bookingRow(bookingId)).toMatchObject({ special_requests: null })
      expect(await auditRows(bookingId)).toEqual([])
    })
  })

  it('an inactive staff account is refused before anything is written', async () => {
    await onABooking(async (bookingId) => {
      const answer = await post('special-requests', bookingId, { specialRequests: 'x' }, { email: INACTIVE })
      expect(answer.status).toBe(403)
      expect(await bookingRow(bookingId)).toMatchObject({ special_requests: null })
      expect(await auditRows(bookingId)).toEqual([])
    })
  })
})

describe("the staff app's thin wrappers, through the real routes", () => {
  type Wrapper = (req: { params: unknown; user: typeof REPLAY_USER }) => Promise<unknown>
  const wrapper = async (name: string) => ((await import(/* @vite-ignore */ path.join(staffAppDir(), 'backend/paddock', `${name}.ts`))) as { default: Wrapper }).default

  /** After the booking is placed, nothing may touch the database but the Worker's route. */
  const onlyTheWorker = () =>
    vi.stubGlobal('paddockData', {
      query: async (sql: string) => {
        throw new Error(`A wrapper went to the database itself: ${sql}`)
      },
    })

  it('setBookingSpecialRequests: the old shape when saved, and `updated: false` with the reason and the Worker\'s words when refused', async () => {
    const save = await wrapper('setBookingSpecialRequests')
    await onABooking(async (bookingId) => {
      onlyTheWorker()
      expect(await save({ params: { bookingId, specialRequests: '  Wheelchair user ' }, user: REPLAY_USER })).toEqual({ updated: true, booking: { id: bookingId, special_requests: 'Wheelchair user' } })
      expect(await save({ params: { bookingId: '', specialRequests: 'x' }, user: REPLAY_USER })).toEqual({ updated: false })
      await setStatusDirectly(bookingId, 'cancelled')
      expect(await save({ params: { bookingId, specialRequests: 'x' }, user: REPLAY_USER })).toEqual({
        updated: false,
        reason: 'booking_cancelled',
        message: 'Cancelled bookings cannot be edited.',
      })
      // An inactive account is not a refusal of the booking: thrown, with the Worker's words, as before.
      await expect(save({ params: { bookingId, specialRequests: 'x' }, user: { email: INACTIVE } })).rejects.toThrow('This staff account is inactive.')
    })
  })

  it('setBookingStatus: the row when changed, and a refusal thrown with the Worker\'s words alone', async () => {
    const setStatus = await wrapper('setBookingStatus')
    await onABooking(async (bookingId) => {
      onlyTheWorker()
      expect(await setStatus({ params: { bookingId, status: 'completed' }, user: REPLAY_USER })).toEqual({ id: bookingId, status: 'completed', cancelled_at: null })
      await expect(setStatus({ params: { bookingId, status: 'cancelled' }, user: REPLAY_USER })).rejects.toThrow(
        new Error(invalidStatusMessage('cancelled', STAFF_STATUSES))
      )
      await setStatusDirectly(bookingId, 'cancelled')
      await expect(setStatus({ params: { bookingId, status: 'confirmed' }, user: REPLAY_USER })).rejects.toThrow(new Error(STATUS_WORDS.cancelled))
      await expect(setStatus({ params: { bookingId, status: 'confirmed' }, user: { email: INACTIVE } })).rejects.toThrow(/inactive.*\(FORBIDDEN, request /)
    })
  })

  it('setBookingStatus on a booking awaiting payment: refused with the N3 words', async () => {
    const setStatus = await wrapper('setBookingStatus')
    await replay(
      environment,
      {
        name: 'w18 payment needed',
        seed,
        async run({ call, db: runDb }) {
          const bookingId = await lapsedSeat(call, runDb)
          onlyTheWorker()
          await expect(setStatus({ params: { bookingId, status: 'confirmed' }, user: REPLAY_USER })).rejects.toThrow(new Error(STATUS_PAYMENT_NEEDED_MESSAGE))
        },
      },
      oldSide
    )
  })

  it('setBookingStatus while a reader payment is open: thrown with the W17 words, which the status toasts show', async () => {
    const setStatus = await wrapper('setBookingStatus')
    await replay(
      environment,
      {
        name: 'w18a wrapper held',
        seed,
        async run({ call, db: runDb }) {
          const bookingId = await lapsedSeat(call, runDb)
          await call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })
          onlyTheWorker()
          await expect(setStatus({ params: { bookingId, status: 'no-show' }, user: REPLAY_USER })).rejects.toThrow(new Error(READER_PAYMENT_OPEN_MESSAGE))
        },
      },
      oldSide
    )
  })

  it('no answer from the Worker: thrown with callWorker\'s words, never shown as a refusal', async () => {
    const setStatus = await wrapper('setBookingStatus')
    const save = await wrapper('setBookingSpecialRequests')
    vi.stubGlobal('paddockWorkerV1', {
      rawRequest: async () => {
        throw new Error('socket hang up')
      },
    })
    await expect(setStatus({ params: { bookingId: ID.customer, status: 'completed' }, user: REPLAY_USER })).rejects.toThrow('Could not reach the Worker: socket hang up')
    await expect(save({ params: { bookingId: ID.customer, specialRequests: 'x' }, user: REPLAY_USER })).rejects.toThrow('Could not reach the Worker: socket hang up')
  })
})
