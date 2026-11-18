import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, Refused, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { cancelCredit, lapseBooking, type CancelOptions } from './cancel'
import { lapseSweep } from './lapse-sweep'
import { removeGuest, type RemoveGuestOptions } from './remove-guest'
import { settleBooking } from './settle'

// Brief W43 item 2 on real Postgres 17.6, each Worker client on its own connection: the lapse sweep against Settle,
// Remove Guest, a staff cancel, the database's own sweep and a second run of itself, all on one booking; and the cap.
// Each race holds the booking's lock open until Postgres reports both sides waiting on it, so neither can pass by
// timing. Whichever is given the lock first, the booking ends in one consistent state: its places released once, money
// given once, and the loser told what it found. Stripe is the fake, and the sweep never calls it.

let pg: RealPostgres
let first: Db
let second: Db
let third: Db

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
  // The database's own sweep is run by the table owner (the hourly job). Here a Worker connection calls it, so the race
  // has it on a connection of its own (the admin connection is the one that watches the locks). Test only.
  await pg.admin.unsafe('GRANT EXECUTE ON FUNCTION public.lapse_sweep_expired_bookings() TO paddock_worker')
})
afterAll(() => pg.stop())

let publicType: string
let band: string
let staffId: string
beforeAll(async () => {
  publicType = await fixtures.serviceType(first)
  band = await fixtures.band(first, { price: '20.00' })
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w43-race@example.com', can_issue_refunds: true })
})

let day = 0
/** A session years ahead: 24 hours or more before it, so Q48 gives money back. */
function nextSlot(): { start_time: string; end_time: string } {
  day += 1
  const start = new Date(Date.UTC(2032, 5, day, 10))
  return { start_time: start.toISOString(), end_time: new Date(start.getTime() + 3_600_000).toISOString() }
}

interface Lapsed {
  bookingId: string
  sessionId: string
  customerId: string
  guestId: string | null
}

/**
 * A member's credit seat awaiting payment, its deadline `minutesAgo` minutes ago, in a session with two other places
 * taken (so a place released twice would show). `paidGuest`: Alex beside it, £20 paid in cash on its own order.
 */
async function lapsedBooking({ paidGuest = false, minutesAgo = 1 }: { paidGuest?: boolean; minutesAgo?: number } = {}): Promise<Lapsed> {
  const customerId = await fixtures.customer(first)
  const slot = nextSlot()
  const party = paidGuest ? 2 : 1
  const sessionId = await fixtures.session(first, { service_type_id: publicType, band_id: band, capacity: 10, total_booked: party + 2, ...slot })
  const bookingId = await fixtures.booking(first, {
    session_id: sessionId,
    customer_id: customerId,
    price_paid: paidGuest ? '20' : '0',
    party_size: party,
    band_id: band,
    status: 'payment_needed',
    redemption_source: 'membership_credit',
    payment_due_by: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    ...slot,
  })
  await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'account_holder', guest_name: 'Mo Member', unit_price: '20.00', pay_by: 'membership_credit' })
  let guestId: string | null = null
  if (paidGuest) {
    guestId = await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'additional_guest', guest_name: 'Alex Guest', unit_price: '20.00', pay_by: 'paid' })
    const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: '20.00', payment_status: 'paid', payment_method: 'cash', order_source: 'staff_created' })
    await insert(first, 'order_line_items', { order_id: orderId, booking_id: bookingId, item_type: 'booking', quantity: 1, unit_price: '20.00', line_total: '20.00' })
  }
  return { bookingId, sessionId, customerId, guestId }
}

const stripe = new FakeStripe({ idTag: 'w43race' })
const staff = (): CancelOptions & RemoveGuestOptions => ({ actor: { type: 'staff', id: staffId }, requestId: 'w43-race', stripe: () => stripe, canIssueRefunds: true })
const sweepOn = (db: Db) => lapseSweep(db, { requestId: 'w43-race-sweep', orderSwitch: 'lapse_sweep' })

/** The booking's lock held open on `third` until finished. */
async function holdingTheBooking(bookingId: string) {
  const release = deferred()
  let announce: (pid: number) => void = () => {}
  const ready = new Promise<number>((resolve) => {
    announce = resolve
  })
  const done = third
    .transaction(async (tx: Tx) => {
      await tx.query('SELECT id FROM bookings WHERE id = $1 FOR NO KEY UPDATE', [bookingId])
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

type Answered = { answered: Record<string, unknown> } | { refused: string }
const outcome = (promise: Promise<unknown>): Promise<Answered> =>
  promise.then(
    (value) => ({ answered: value as Record<string, unknown> }),
    (err: unknown) => ({ refused: err instanceof ApiError ? ((err.details as { reason?: string } | undefined)?.reason ?? err.code) : String(err) })
  )

/** Both sides started while the booking's lock is held; released only once Postgres reports both waiting on the booking. */
async function race(bookingId: string, a: () => Promise<unknown>, b: () => Promise<unknown>): Promise<[Answered, Answered]> {
  const gate = await holdingTheBooking(bookingId)
  const one = outcome(a())
  const two = outcome(b())
  try {
    const waiters = await allBlockedBy(gate.pid, 2)
    for (const waiter of waiters) expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
  } finally {
    // Always released, so a failed check never leaves the lock held for the tests after it.
    await gate.finish()
  }
  return Promise.all([one, two])
}

const state = async ({ bookingId, sessionId, customerId }: Lapsed) =>
  (
    await first.query<{ status: string; price_paid: string; party_size: number; cancel_reason: string | null; total_booked: number; balance: string; guests: number; store_credit_rows: number; lapsed_rows: number }>(
      `SELECT b.status, b.price_paid::text AS price_paid, b.party_size, b.cancel_reason, s.total_booked, c.store_credit_balance::text AS balance,
              (SELECT count(*)::int FROM booking_guests g WHERE g.booking_id = b.id) AS guests,
              (SELECT count(*)::int FROM store_credit_transactions t WHERE t.customer_id = c.id) AS store_credit_rows,
              (SELECT count(*)::int FROM audit_log a WHERE a.entity_type = 'booking' AND a.entity_id = b.id::text AND a.action = 'booking.lapsed') AS lapsed_rows
       FROM bookings b JOIN sessions s ON s.id = $2 JOIN customers c ON c.id = $3 WHERE b.id = $1`,
      [bookingId, sessionId, customerId]
    )
  )[0]
const lapsedOf = (answer: Answered) => ('answered' in answer ? answer.answered['lapsed'] : undefined)
const reasonsLeft = (answer: Answered) => ('answered' in answer ? ((answer.answered['items'] ?? []) as Array<{ outcome: string; reason?: string }>).filter((item) => item.outcome === 'left').map((item) => item.reason) : [])

describe('the lapse sweep against Settle on the same booking (F-plan 4.12 item 7)', () => {
  it('both wait on the booking; either it is settled (confirmed, £20 taken, its places kept, the sweep finding nothing to lapse) or it is lapsed (Settle refused, nothing taken): never both', async () => {
    for (let round = 0; round < 4; round += 1) {
      const lapsed = await lapsedBooking()
      const settle = { payment: { method: 'cash', confirmedCashAmount: 20 }, figures: { amountDue: 20, toCollect: 20 } } as const
      // Each side started first in turn.
      const sides = [() => settleBooking(first, lapsed.bookingId, settle, staff()), () => sweepOn(second)]
      const [a, b] = await race(lapsed.bookingId, ...((round % 2 === 0 ? sides : [...sides].reverse()) as [() => Promise<unknown>, () => Promise<unknown>]))
      const [settled, swept] = round % 2 === 0 ? [a, b] : [b, a]
      const after = await state(lapsed)
      if ('answered' in settled) {
        expect(settled.answered).toMatchObject({ settled: true })
        expect(lapsedOf(swept)).toBe(0)
        expect(reasonsLeft(swept)).toEqual(['not_lapsed'])
        expect(after).toMatchObject({ status: 'confirmed', price_paid: '20.00', cancel_reason: null, total_booked: 3, lapsed_rows: 0 })
      } else {
        expect(settled.refused).toBe('booking_not_payment_needed')
        expect(lapsedOf(swept)).toBe(1)
        expect(after).toMatchObject({ status: 'cancelled', price_paid: '0.00', cancel_reason: 'membership_lapsed', total_booked: 2, lapsed_rows: 1 })
      }
      // Nothing was taken for a cancelled booking (its price paid is still £0), and nothing given on a settled one.
      // (A cash Settle writes no order, Q36: the booking's price paid and its `booking.settle` row are its record.)
      const settles = (await first.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'booking' AND entity_id = $1 AND action = 'booking.settle'", [lapsed.bookingId]))[0]?.n
      expect(settles).toBe(after?.status === 'confirmed' ? 1 : 0)
      expect(after).toMatchObject({ balance: '0.00', store_credit_rows: 0 })
    }
  })
})

describe('the lapse sweep against Remove Guest on the same booking', () => {
  it("both wait on the booking; the guest's £20 goes to store credit once, by whichever is first (Remove Guest, then the same run of the sweep lapses the one seat left; or the sweep, and Remove Guest finds the booking cancelled), and each place is released once", async () => {
    for (let round = 0; round < 4; round += 1) {
      const lapsed = await lapsedBooking({ paidGuest: true })
      const sides = [() => removeGuest(first, lapsed.guestId as string, { confirmedRefundAmount: 20, refundMethod: 'credit' }, staff()), () => sweepOn(second)]
      const [a, b] = await race(lapsed.bookingId, ...((round % 2 === 0 ? sides : [...sides].reverse()) as [() => Promise<unknown>, () => Promise<unknown>]))
      const [removed, swept] = round % 2 === 0 ? [a, b] : [b, a]
      const after = await state(lapsed)
      // Either way: cancelled, both places released (4 - 2), £20 of store credit in one row, one lapse.
      expect(after).toMatchObject({ status: 'cancelled', cancel_reason: 'membership_lapsed', total_booked: 2, balance: '20.00', store_credit_rows: 1, lapsed_rows: 1 })
      // W43a (review L1): the sweep lapses it in this run whichever was first. A guest removed after the sweep's read
      // changes neither the cancel it is, nor whether money comes back, nor its add-on lines, so it is never left as
      // `booking_changed`: under the lock the sweep gives what the booking then holds.
      expect(lapsedOf(swept)).toBe(1)
      expect(reasonsLeft(swept)).toEqual([])
      if ('answered' in removed) {
        // Remove Guest first: it gave the £20 and lowered the booking to one seat; the sweep lapses a booking with nothing paid.
        expect(removed.answered).toMatchObject({ removed: true, storeCreditRefundedAmount: 20 })
        expect(after).toMatchObject({ price_paid: '0.00', party_size: 1, guests: 1 })
        expect('answered' in swept ? swept.answered['storeCreditRefunded'] : null).toBe(0)
      } else {
        // The sweep first: it gave the £20 with the cancel, and Remove Guest is refused on a cancelled booking.
        expect(after).toMatchObject({ price_paid: '20.00', party_size: 2, guests: 2 })
        expect('answered' in swept ? swept.answered['storeCreditRefunded'] : null).toBe(20)
      }
    }
  })

  it("L1 (W43a), Remove Guest lands between the sweep's read and its lock: the sweep lapses the booking at once from what it finds under the lock (one seat, nothing paid), with £0 more to give. It is not left as `booking_changed`: the cancel it would be, whether money comes back, and its add-on lines are all unchanged. £20 in all, given once", async () => {
    const lapsed = await lapsedBooking({ paidGuest: true })
    // The sweep's reads with no lock see two seats and £20. Straight after its last one (the booking's add-on lines),
    // and before R1 asks for the booking's lock, Remove Guest runs from start to finish on a connection of its own.
    const realQuery = second.query.bind(second)
    let removed: unknown = null
    let changed = false
    const changing = Object.assign(Object.create(second) as Db, {
      query: async (sql: string, params?: never[]) => {
        const rows = await realQuery(sql, params)
        if (!changed && /FROM addon_order_lines WHERE booking_id = \$1::uuid AND removed_at IS NULL ORDER BY created_at, id/.test(sql)) {
          changed = true
          removed = await removeGuest(first, lapsed.guestId as string, { confirmedRefundAmount: 20, refundMethod: 'credit' }, staff())
        }
        return rows
      },
    })
    const answer = await lapseBooking(changing, lapsed.bookingId, 'w43-race-sweep')
    expect(changed).toBe(true)
    expect(removed).toMatchObject({ removed: true, storeCreditRefundedAmount: 20 })
    // Lapsed by this run, as the cancel the read saw (Cancel & return credit, money back), with nothing left to give.
    expect(answer).toEqual({ outcome: 'lapsed', kind: 'cancel_credit', back: true, kept: null, storeCreditRefunded: 0, addonCreditsReturned: 0 })
    // Remove Guest released the guest's place (4 -> 3) and the lapse the member's (3 -> 2); one store credit row, of £20.
    expect(await state(lapsed)).toMatchObject({ status: 'cancelled', cancel_reason: 'membership_lapsed', price_paid: '0.00', party_size: 1, guests: 1, total_booked: 2, balance: '20.00', store_credit_rows: 1, lapsed_rows: 1 })
    const row = (await first.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE entity_type = 'booking' AND entity_id = $1 AND action = 'booking.lapsed'", [lapsed.bookingId]))[0]?.details
    expect(row).toMatchObject({ back: true, kept: null, pricePaid: 0, refundOwed: 0, addonsKept: 0, storeCreditRefunded: 0, placesReleased: 1 })
    // The next run finds nothing to do.
    expect(await sweepOn(second)).toMatchObject({ lapsed: 0, left: 0, failed: 0, storeCreditRefunded: 0 })
    expect(await state(lapsed)).toMatchObject({ total_booked: 2, balance: '20.00', store_credit_rows: 1, lapsed_rows: 1 })
  })
})

describe('the lapse sweep against a staff cancel on the same booking', () => {
  it("both wait on the booking; one cancels it and its place is released once; the other finds it cancelled (the sweep: `not_lapsed`; staff: the booking can't be cancelled)", async () => {
    for (let round = 0; round < 4; round += 1) {
      const lapsed = await lapsedBooking()
      const sides = [() => cancelCredit(first, lapsed.bookingId, { confirmed: { refund: 0, addonsRefund: 0 } }, staff()), () => sweepOn(second)]
      const [a, b] = await race(lapsed.bookingId, ...((round % 2 === 0 ? sides : [...sides].reverse()) as [() => Promise<unknown>, () => Promise<unknown>]))
      const [cancelled, swept] = round % 2 === 0 ? [a, b] : [b, a]
      const after = await state(lapsed)
      expect(after).toMatchObject({ status: 'cancelled', total_booked: 2, balance: '0.00', store_credit_rows: 0 })
      const cancels = (await first.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'booking' AND entity_id = $1 AND action = 'booking.cancel_credit'", [lapsed.bookingId]))[0]?.n
      expect(cancels).toBe(1)
      if ('answered' in cancelled) {
        expect(cancelled.answered).toMatchObject({ cancelled: true })
        expect(lapsedOf(swept)).toBe(0)
        expect(reasonsLeft(swept)).toEqual(['not_lapsed'])
        expect(after).toMatchObject({ cancel_reason: null, lapsed_rows: 0 })
      } else {
        expect(cancelled.refused).toBe('not_cancellable')
        expect(lapsedOf(swept)).toBe(1)
        expect(after).toMatchObject({ cancel_reason: 'membership_lapsed', lapsed_rows: 1 })
      }
    }
  })
})

describe("the database's own sweep and the Worker's on the same booking (F-plan 4.8: harmless while both run)", () => {
  const databaseSweep = async (db: Db) => ({ cancelled: Number((await db.query<{ n: number }>('SELECT public.lapse_sweep_expired_bookings() AS n'))[0]?.n) })

  it('both wait on the booking; one cancels it, the other finds it cancelled; its place is released once, whichever was first', async () => {
    for (let round = 0; round < 4; round += 1) {
      const lapsed = await lapsedBooking()
      const sides = [() => databaseSweep(first), () => sweepOn(second)]
      const [a, b] = await race(lapsed.bookingId, ...((round % 2 === 0 ? sides : [...sides].reverse()) as [() => Promise<unknown>, () => Promise<unknown>]))
      const [database, worker] = round % 2 === 0 ? [a, b] : [b, a]
      const after = await state(lapsed)
      // Three places taken before; exactly one given back.
      expect(after).toMatchObject({ status: 'cancelled', cancel_reason: 'membership_lapsed', total_booked: 2, price_paid: '0.00', balance: '0.00' })
      const byDatabase = 'answered' in database ? Number(database.answered['cancelled']) : -1
      expect(byDatabase + Number(lapsedOf(worker))).toBe(1)
      expect(after?.lapsed_rows).toBe(Number(lapsedOf(worker)))
      if (byDatabase === 1) expect(reasonsLeft(worker)).toEqual(['not_lapsed'])
    }
  })

  it("a booking with a paid guest: the database's sweep passes it by (bug FB18) while the Worker's lapses it, in either order, and £20 is given once", async () => {
    const lapsed = await lapsedBooking({ paidGuest: true })
    const gate = await holdingTheBooking(lapsed.bookingId)
    const worker = outcome(sweepOn(second))
    let database: Answered
    try {
      await allBlockedBy(gate.pid, 1)
      // The database's sweep reads only bookings with nothing paid: it never waits on this one's lock, and cancels none.
      database = await outcome(databaseSweep(first))
    } finally {
      await gate.finish()
    }
    expect(database).toEqual({ answered: { cancelled: 0 } })
    expect(lapsedOf(await worker)).toBe(1)
    expect(await state(lapsed)).toMatchObject({ status: 'cancelled', cancel_reason: 'membership_lapsed', total_booked: 2, balance: '20.00', store_credit_rows: 1, lapsed_rows: 1 })
    expect(await databaseSweep(first)).toEqual({ cancelled: 0 })
    expect(await state(lapsed)).toMatchObject({ total_booked: 2, balance: '20.00' })
  })
})

describe('two runs of the sweep at once on one booking (a run still going when the next starts)', () => {
  it("both wait on the booking; one lapses it and gives the guest's £20 once; the other leaves it as `not_lapsed`", async () => {
    const lapsed = await lapsedBooking({ paidGuest: true })
    const [a, b] = await race(lapsed.bookingId, () => lapseBooking(first, lapsed.bookingId, 'w43-race-a'), () => lapseBooking(second, lapsed.bookingId, 'w43-race-b'))
    const answers: Array<Record<string, unknown>> = [a, b].map((answer) => ('answered' in answer ? answer.answered : { ...answer }))
    expect(answers.filter((answer) => answer['outcome'] === 'lapsed')).toHaveLength(1)
    expect(answers.filter((answer) => answer['outcome'] === 'left')).toEqual([{ outcome: 'left', reason: 'not_lapsed' }])
    expect(await state(lapsed)).toMatchObject({ status: 'cancelled', total_booked: 2, balance: '20.00', store_credit_rows: 1, lapsed_rows: 1 })
  })
})

describe('the cap (brief W43 item 2: capped per run, and carries on next run)', () => {
  it('three bookings due and a cap of two: the two with the oldest deadlines lapse and `more` says one is left; the next run lapses it', async () => {
    // Anything left due by the races above is lapsed first, so this test's three are the only ones due.
    await sweepOn(first)
    const newest = await lapsedBooking({ minutesAgo: 1 })
    const oldest = await lapsedBooking({ minutesAgo: 30 })
    const middle = await lapsedBooking({ minutesAgo: 10, paidGuest: true })
    const run = await lapseSweep(first, { requestId: 'w43-cap', orderSwitch: 'lapse_sweep', maxItems: 2 })
    expect(run).toMatchObject({ ran: true, lapsed: 2, left: 0, failed: 0, storeCreditRefunded: 20, more: true })
    expect(run.items.map((item) => item.bookingId)).toEqual([oldest.bookingId, middle.bookingId])
    expect((await state(newest))?.status).toBe('payment_needed')
    const next = await lapseSweep(first, { requestId: 'w43-cap', orderSwitch: 'lapse_sweep', maxItems: 2 })
    expect(next).toMatchObject({ lapsed: 1, more: false })
    expect(next.items.map((item) => item.bookingId)).toEqual([newest.bookingId])
    expect(await lapseSweep(first, { requestId: 'w43-cap', orderSwitch: 'lapse_sweep', maxItems: 2 })).toMatchObject({ ran: true, lapsed: 0, more: false, items: [] })
  })

  it('exactly as many due as the cap: all lapse and `more` is false', async () => {
    await lapsedBooking()
    await lapsedBooking()
    expect(await lapseSweep(first, { requestId: 'w43-cap', orderSwitch: 'lapse_sweep', maxItems: 2 })).toMatchObject({ lapsed: 2, more: false })
  })
})
