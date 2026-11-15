import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlaceOrderInput } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { refusalDetails } from '@/server/rules/orders/order-refusal'
import { placeOrder } from '@/server/rules/orders/place-order'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { cancelEvent, eventCancelOverview } from './cancel-event'
import { cancelEventPlaces } from './cancel-places'

// Brief W31 item 8 (E-plan 4.13 item 7; bug E7) on real Postgres 17.6, each Worker client on its own connection: the
// whole-event cancel racing New Order on the same event (the Worker's own placeOrder), both ways round, and racing a
// place cancel. Each race holds one side's transaction open, after its writes, until Postgres reports the other as
// waiting on the event's row, so none can pass by timing.

let pg: RealPostgres
let first: Db
let second: Db
let third: Db
let staffId: string

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w31-race@example.com', can_issue_refunds: true })
})
afterAll(() => pg.stop())

const by = () => ({ actor: { type: 'staff' as const, id: staffId }, requestId: crypto.randomUUID() })
const storm = { refund: 'card', reason: 'Storm' }

/** The customer alone at the event (public, £40), in cash: confirmed at once. */
function eventOrder(customerId: string, eventId: string): PlaceOrderInput {
  return {
    customerId,
    event: { eventId, accountHolderAttending: true, attendees: [{ name: 'Sam Test', email: 'sam@example.com', dateOfBirth: '1990-01-01', isAccountHolder: true }] },
    payment: { method: 'cash' },
    confirmed: { toCollect: 40 },
  }
}

type Outcome<T> = { answered: T } | { refused: string }

async function outcome<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { answered: await work }
  } catch (err) {
    const order = refusalDetails(err)
    if (order) return { refused: order.reason }
    if (err instanceof ApiError) return { refused: String((err.details as { reason?: unknown } | undefined)?.reason ?? err.code) }
    throw err
  }
}

/**
 * `db`, with its first transaction held open after its work is done (every write made, nothing committed) until
 * `finish`. `pid` resolves once the work is done, with that transaction's backend.
 */
function heldOpen(db: Db): { db: Db; pid: Promise<number>; finish(): void } {
  const release = deferred()
  let announce: (pid: number) => void = () => {}
  const pid = new Promise<number>((resolve) => {
    announce = resolve
  })
  let count = 0
  const held = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
      return async <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
        count += 1
        if (count > 1) return target.transaction(work)
        return target.transaction(async (tx) => {
          const result = await work(tx)
          announce(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid))
          await release.promise
          return result
        })
      }
    },
  })
  return { db: held, pid, finish: () => release.resolve() }
}

/** Waits until Postgres itself reports a session blocked by `holder`, and answers that session. */
async function blockedBy(holder: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

const eventRow = async (eventId: string) =>
  (await first.query<{ active: boolean; cancelled: boolean; cancel_reason: string | null; cancelled_by: string | null; places_booked: number }>('SELECT active, cancelled_at IS NOT NULL AS cancelled, cancel_reason, cancelled_by, places_booked FROM events WHERE id = $1', [eventId]))[0]
const bookingsOn = async (eventId: string) => first.query<{ id: string; status: string; places: number }>('SELECT id, status, places FROM event_bookings WHERE event_id = $1 ORDER BY created_at, id', [eventId])

describe('the whole-event cancel racing New Order on the same event (bug E7)', () => {
  it("the cancel first: New Order waits on the event's row, then is refused (event_cancelled); no booking, no place taken, no order", async () => {
    const eventId = await fixtures.event(first)
    const customer = await fixtures.customer(first)
    const cancelling = heldOpen(first)
    const cancel = outcome(cancelEvent(cancelling.db, eventId, storm, by()))
    const holder = await cancelling.pid
    // New Order starts while the cancel has marked the event and not committed.
    const order = outcome(placeOrder(second, eventOrder(customer, eventId), by()))
    const waiter = await blockedBy(holder)
    expect(await waitingOn(pg, waiter)).toEqual(['events'])
    cancelling.finish()
    const [cancelled, placed] = await Promise.all([cancel, order])
    expect(cancelled).toMatchObject({ answered: { bookings: [], totalPlaces: 0, totalValue: 0, cancelReason: 'Storm' } })
    expect(placed).toEqual({ refused: 'event_cancelled' })
    expect(await eventRow(eventId)).toEqual({ active: false, cancelled: true, cancel_reason: 'Storm', cancelled_by: staffId, places_booked: 0 })
    expect(await bookingsOn(eventId)).toEqual([])
    expect((await first.query<{ n: number }>('SELECT count(*)::int AS n FROM orders WHERE customer_id = $1', [customer]))[0]?.n).toBe(0)
  })

  it("New Order first: the cancel waits on the event's row, then cancels the event and lists the new booking as still to cancel (£40): no order is left behind unseen", async () => {
    const eventId = await fixtures.event(first)
    const customer = await fixtures.customer(first)
    const ordering = heldOpen(second)
    const order = outcome(placeOrder(ordering.db, eventOrder(customer, eventId), by()))
    const holder = await ordering.pid
    const cancel = outcome(cancelEvent(first, eventId, storm, by()))
    const waiter = await blockedBy(holder)
    expect(await waitingOn(pg, waiter)).toEqual(['events'])
    ordering.finish()
    const [placed, cancelled] = await Promise.all([order, cancel])
    expect(placed).toHaveProperty('answered')
    const booked = await bookingsOn(eventId)
    expect(booked).toHaveLength(1)
    expect(booked[0]).toMatchObject({ status: 'confirmed', places: 1 })
    expect(cancelled).toMatchObject({ answered: { bookings: [{ eventBookingId: booked[0]?.id, places: 1, value: 40, problem: null }], totalPlaces: 1, totalValue: 40 } })
    expect(await eventRow(eventId)).toMatchObject({ active: false, cancelled: true, places_booked: 1 })
    // The screen's next step for that booking: the whole-event press, to the card choice. Paid in cash, so it all
    // goes to store credit (Q42 for a whole event).
    const press = await cancelEventPlaces(first, booked[0]?.id as string, { refund: 'card', wholeEvent: true, confirmed: { refund: 40 } }, { ...by(), canIssueRefunds: true, stripe: () => new FakeStripe({ idTag: 'w31a' }) })
    expect(press).toMatchObject({ places: 1, refundedAmount: 40, cardRefundedAmount: 0, storeCreditRefundedAmount: 40 })
    expect(await eventRow(eventId)).toMatchObject({ places_booked: 0 })
    expect((await eventCancelOverview(first, eventId))?.bookings).toEqual([])
  })

  it("an order whose payment is still in progress got in first: the cancel waits, then is refused (bookings_pending) and the event is left on sale, as it was", async () => {
    const eventId = await fixtures.event(first)
    const customer = await fixtures.customer(first, { first_name: 'Pat', last_name: 'Pending' })
    // What New Order's T1 writes for a card or reader order: the places claimed and the booking pending, in one transaction.
    const release = deferred()
    let announce: (pid: number) => void = () => {}
    const ready = new Promise<number>((resolve) => {
      announce = resolve
    })
    const t1 = second.transaction(async (tx) => {
      await tx.query('SELECT id FROM events WHERE id = $1 FOR NO KEY UPDATE', [eventId])
      await tx.query('SELECT public.claim_event_places($1::uuid, 1)', [eventId])
      await tx.query("INSERT INTO event_bookings (event_id, customer_id, places, status, price_paid) VALUES ($1, $2, 1, 'pending', 40)", [eventId, customer])
      announce(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid))
      await release.promise
    })
    const holder = await ready
    const cancel = outcome(cancelEvent(first, eventId, storm, by()))
    const waiter = await blockedBy(holder)
    expect(await waitingOn(pg, waiter)).toEqual(['events'])
    release.resolve()
    await t1
    expect(await cancel).toEqual({ refused: 'bookings_pending' })
    expect(await eventRow(eventId)).toEqual({ active: true, cancelled: false, cancel_reason: null, cancelled_by: null, places_booked: 1 })
    expect((await eventCancelOverview(first, eventId))?.pendingCustomers).toEqual(['Pat Pending'])
    expect((await first.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'event.cancel' AND entity_id = $1", [eventId]))[0]?.n).toBe(0)
  })
})

describe('a place cancel racing the whole-event cancel', () => {
  /** One booking of two £40 places, paid in cash (£80), on an event of its own. */
  async function cashBooking(): Promise<{ eventId: string; eventBookingId: string; places: string[] }> {
    const customerId = await fixtures.customer(first)
    const eventId = await fixtures.event(first, { places_booked: 2 })
    const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: '80.00', payment_status: 'paid', payment_method: 'cash', order_source: 'staff_created' })
    const eventBookingId = await insert(first, 'event_bookings', { event_id: eventId, customer_id: customerId, places: 2, status: 'confirmed', price_paid: '80.00' })
    const places = [
      await insert(first, 'event_attendees', { event_booking_id: eventBookingId, attendee_type: 'account_holder', name: 'Sam Test', unit_price: '40.00', price_level: 'public', created_at: '2026-11-01 10:00:00+00' }),
      await insert(first, 'event_attendees', { event_booking_id: eventBookingId, attendee_type: 'guest', name: 'Alex Guest', unit_price: '40.00', price_level: 'public', created_at: '2026-11-01 10:00:01+00' }),
    ]
    await insert(first, 'order_line_items', { order_id: orderId, item_type: 'event', quantity: 2, unit_price: '40.00', line_total: '80.00', event_booking_id: eventBookingId })
    return { eventId, eventBookingId, places }
  }

  it("both wait on the event's row and neither loses the other's change: the event is cancelled, the one place is cancelled and released once, and the booking's other place is still to cancel (£40)", async () => {
    const booked = await cashBooking()
    const release = deferred()
    let announce: (pid: number) => void = () => {}
    const ready = new Promise<number>((resolve) => {
      announce = resolve
    })
    const gate = third.transaction(async (tx) => {
      await tx.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [booked.eventId])
      announce(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid))
      await release.promise
    })
    const holder = await ready
    const place = outcome(cancelEventPlaces(first, booked.eventBookingId, { attendeeIds: [booked.places[0] as string], refund: 'none', confirmed: { refund: 0 } }, { ...by(), canIssueRefunds: true, stripe: () => new FakeStripe({ idTag: 'w31b' }) }))
    const whole = outcome(cancelEvent(second, booked.eventId, storm, by()))
    // Both queue behind the holder: the second may wait on the first's place in the row's queue, not on the holder itself.
    const giveUpAt = Date.now() + 4_000
    for (;;) {
      const rows = await pg.admin.unsafe<{ pid: number }[]>(
        `WITH RECURSIVE queued(pid) AS (
           SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
           UNION
           SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid))
         ) SELECT pid FROM queued`,
        [holder]
      )
      if (rows.length >= 2) break
      if (Date.now() > giveUpAt) throw new Error('Fewer than two waited on the event.')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    release.resolve()
    await gate
    const [placeCancelled, eventCancelled] = await Promise.all([place, whole])
    expect(placeCancelled).toMatchObject({ answered: { places: 1, refundedAmount: 0 } })
    expect(eventCancelled).toHaveProperty('answered')
    expect(await eventRow(booked.eventId)).toMatchObject({ active: false, cancelled: true, places_booked: 1 })
    expect(await bookingsOn(booked.eventId)).toEqual([{ id: booked.eventBookingId, status: 'confirmed', places: 1 }])
    // Whichever went first, what is still to cancel now is the one place left.
    expect((await eventCancelOverview(first, booked.eventId))?.bookings).toEqual([{ eventBookingId: booked.eventBookingId, customerName: expect.any(String) as string, places: 1, value: 40, problem: null }])
  })
})
