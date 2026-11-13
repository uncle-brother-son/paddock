import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, Refused, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { moveBooking, type MoveOptions } from './move'

// Brief W24 on real Postgres 17.6, each Worker client on its own connection: two presses of one dearer move on the card
// (one move, one charge), two bookings racing for a session's last places (one gets them), and two bookings swapping
// sessions at once (both move: the sessions are locked in id order, so neither waits on the other for ever). Each race
// holds a lock open until Postgres reports both presses waiting on it, so neither can pass by timing.

let pg: RealPostgres
let first: Db
let second: Db
let third: Db

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
})
afterAll(() => pg.stop())

let publicType: string
let core: string
let peak: string
let staffId: string
beforeAll(async () => {
  publicType = await fixtures.serviceType(first)
  core = await fixtures.band(first, { price: '20.00' })
  peak = await fixtures.band(first, { price: '25.50' })
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w24-race@example.com', can_issue_refunds: true })
})

let day = 0
function nextDay(): number {
  day += 1
  return day
}
const slot = (onDay: number, hour: number) => {
  const start = new Date(Date.UTC(2033, 4, onDay, hour))
  return { start_time: start.toISOString(), end_time: new Date(start.getTime() + 3_600_000).toISOString() }
}

/** A public booking for two (£40) on the card, on a Core session; its order and the fake's PaymentIntent. */
async function twoSeatsOnTheCard(stripe: FakeStripe, sessionId: string, sessionSlot: { start_time: string; end_time: string }): Promise<string> {
  const stripeCustomer = `cus_w24_${crypto.randomUUID().slice(0, 6)}`
  stripe.addCustomer(stripeCustomer)
  const customerId = await fixtures.customer(first, { stripe_customer_id: stripeCustomer, saved_payment_method_id: 'pm_w24' })
  const bookingId = await fixtures.booking(first, { session_id: sessionId, customer_id: customerId, price_paid: '40', party_size: 2, band_id: core, redemption_source: 'paid', ...sessionSlot })
  await first.query('UPDATE sessions SET total_booked = total_booked + 2 WHERE id = $1', [sessionId])
  await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'account_holder', guest_name: 'Sam Test', unit_price: '20.00', pay_by: 'paid' })
  await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'additional_guest', guest_name: 'Alex Guest', unit_price: '20.00', pay_by: 'paid' })
  const intent = await stripe.paymentIntents.create({ amount: 4000, currency: 'gbp', customer: stripeCustomer, payment_method: 'pm_w24', off_session: true, confirm: true })
  const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: '40.00', payment_status: 'paid', stripe_payment_intent_id: intent.id, payment_method: 'card', order_source: 'staff_created' })
  await insert(first, 'order_line_items', { order_id: orderId, booking_id: bookingId, item_type: 'booking', quantity: 1, unit_price: '40.00', line_total: '40.00' })
  return bookingId
}

const options = (stripe: FakeStripe): MoveOptions => ({ actor: { type: 'staff', id: staffId }, requestId: crypto.randomUUID(), stripe: () => stripe, canIssueRefunds: true })

/** A row's lock held open on `third` until finished. */
async function holding(table: 'bookings' | 'sessions', id: string) {
  const release = deferred()
  let announce: (pid: number) => void = () => {}
  const ready = new Promise<number>((resolve) => {
    announce = resolve
  })
  const done = third
    .transaction(async (tx: Tx) => {
      await tx.query(table === 'bookings' ? 'SELECT id FROM bookings WHERE id = $1 FOR NO KEY UPDATE' : 'SELECT id FROM sessions WHERE id = $1 FOR NO KEY UPDATE', [id])
      announce((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
      await release.promise
    })
    .catch((err: unknown) => {
      if (!(err instanceof Refused)) throw err
    })
  const pid = await ready
  return {
    pid,
    async finish() {
      release.resolve()
      await done
    },
  }
}

async function allBlockedBy(holderPid: number, count: number): Promise<number[]> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>(
      `WITH RECURSIVE queued(pid) AS (
         SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid))
       ) SELECT pid FROM queued`,
      [holderPid]
    )
    if (rows.length >= count) return rows.map((row) => row.pid)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Fewer than ${count} waited on the holder.`)
}

const outcome = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ answered: value as Record<string, unknown> }),
    (err: unknown) => ({ refused: err instanceof ApiError ? ((err.details as { reason?: string } | undefined)?.reason ?? err.code) : String(err) })
  )
const places = async (sessionId: string) => (await first.query<{ n: number }>('SELECT total_booked AS n FROM sessions WHERE id = $1', [sessionId]))[0]?.n
const sessionOf = async (bookingId: string) => (await first.query<{ session_id: string }>('SELECT session_id FROM bookings WHERE id = $1', [bookingId]))[0]?.session_id
const charges = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'paymentIntents.create')

describe('Move races (brief W24 Tests; D-plan 4.11 item 5)', () => {
  it('two presses of one dearer move on the card: both wait on the booking; one moves with one £11 charge, the other is refused', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const onDay = nextDay()
    const coreSlot = slot(onDay, 10)
    const coreSession = await fixtures.session(first, { service_type_id: publicType, band_id: core, capacity: 10, ...coreSlot })
    const peakSession = await fixtures.session(first, { service_type_id: publicType, band_id: peak, capacity: 10, ...slot(onDay, 18) })
    const bookingId = await twoSeatsOnTheCard(stripe, coreSession, coreSlot)
    const press = (db: Db) => outcome(moveBooking(db, bookingId, { newSessionId: peakSession, confirmed: true, figures: { amountDue: 11, toCollect: 11 }, payment: { method: 'card' } }, options(stripe)))
    const gate = await holding('bookings', bookingId)
    const a = press(first)
    const b = press(second)
    const waiters = await allBlockedBy(gate.pid, 2)
    for (const waiter of waiters) expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    await gate.finish()
    const answers = await Promise.all([a, b])
    expect(answers.filter((answer) => 'answered' in answer)).toHaveLength(1)
    const refused = answers.filter((answer): answer is { refused: string } => 'refused' in answer).map((answer) => answer.refused)
    // The second press runs C1 once the first's has committed: its card flow still open (card_payment_open), or the
    // booking already on the new session (same_session). Either way nothing moves or is charged twice.
    expect(refused).toHaveLength(1)
    expect(['card_payment_open', 'same_session']).toContain(refused[0])
    expect(charges(stripe).map((call) => (call.params as { amount: number }).amount)).toEqual([4000, 1100])
    expect(await sessionOf(bookingId)).toBe(peakSession)
    expect([await places(coreSession), await places(peakSession)]).toEqual([0, 2])
  })

  it('two bookings racing for the last two places of a session: both wait on it; one moves, the other is refused for capacity', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const onDay = nextDay()
    const slotA = slot(onDay, 8)
    const slotB = slot(onDay + 100, 8)
    const sessionA = await fixtures.session(first, { service_type_id: publicType, band_id: core, capacity: 10, ...slotA })
    const sessionB = await fixtures.session(first, { service_type_id: publicType, band_id: core, capacity: 10, ...slotB })
    const target = await fixtures.session(first, { service_type_id: publicType, band_id: core, capacity: 10, total_booked: 8, ...slot(onDay + 200, 10) })
    const one = await twoSeatsOnTheCard(stripe, sessionA, slotA)
    const two = await twoSeatsOnTheCard(stripe, sessionB, slotB)
    const press = (db: Db, bookingId: string) => outcome(moveBooking(db, bookingId, { newSessionId: target, confirmed: true, figures: { amountDue: 0 } }, options(stripe)))
    const gate = await holding('sessions', target)
    const a = press(first, one)
    const b = press(second, two)
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const answers = await Promise.all([a, b])
    expect(answers.filter((answer) => 'answered' in answer)).toHaveLength(1)
    expect(answers.filter((answer) => 'refused' in answer)).toEqual([{ refused: 'insufficient_capacity' }])
    expect(await places(target)).toBe(10)
    // The one that moved gave its two places back; the refused one still holds its own.
    expect([await places(sessionA), await places(sessionB)].sort()).toEqual([0, 2])
  })

  it('two bookings swapping sessions at once: both move (the two sessions locked in id order, so no deadlock)', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const onDay = nextDay()
    const slotA = slot(onDay + 300, 10)
    const slotB = slot(onDay + 400, 10)
    const sessionA = await fixtures.session(first, { service_type_id: publicType, band_id: core, capacity: 10, ...slotA })
    const sessionB = await fixtures.session(first, { service_type_id: publicType, band_id: core, capacity: 10, ...slotB })
    const one = await twoSeatsOnTheCard(stripe, sessionA, slotA)
    const two = await twoSeatsOnTheCard(stripe, sessionB, slotB)
    const [a, b] = await Promise.all([
      outcome(moveBooking(first, one, { newSessionId: sessionB, confirmed: true, figures: { amountDue: 0 } }, options(stripe))),
      outcome(moveBooking(second, two, { newSessionId: sessionA, confirmed: true, figures: { amountDue: 0 } }, options(stripe))),
    ])
    expect([a, b].every((answer) => 'answered' in answer)).toBe(true)
    expect([await sessionOf(one), await sessionOf(two)]).toEqual([sessionB, sessionA])
    expect([await places(sessionA), await places(sessionB)]).toEqual([2, 2])
  })
})
