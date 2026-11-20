import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { holdingAfter, outcomeOf, pressBy, sessionBlockedBy } from '@/server/rules/testing/admin-race'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { CHECK_IN_SQL, PREPARE_ADDON_LINE_SQL, setAddonLinePrepared, setBookingCheckedIn, setGuestWaiver, signWaiverSql } from './admin'
import { writeFlowRecord } from './flow'
import { lockForBooking } from './locks'

// Brief W50 item 6 (W48 review L2; "Parity and tests", the races): a flag against a cancel, on real Postgres 17.6,
// each on its own connection (PGlite is one session and can't show one press waiting for another).
//
// A guest's waiver and an add-on line are guarded by their BOOKING's status, another table's row. The cancel's side
// here is the lock every booking change takes first (lockForBooking: the booking, its customer, its session) and
// then the status. Each race is held until Postgres itself reports the second as blocked by the first, so none can
// pass by timing, and each has a control showing what happens without the booking held first. The check-in's guard
// is on the row it updates (W48's helper test raced the helper; here it is the route's own rule).
//
// W50a (W50 review L2 and L6a), at the end of the file: Check In against a payment flow that is opening (an open
// payment is another table's row, so Check In now holds its booking first too), with its control; and the customer
// channel's waiver hold, which never locks a booking that isn't the customer's.

let pg: RealPostgres
let first: Db
let second: Db
let jo = ''
let tia = ''
let sauna = ''
let band = ''
let towel = ''
let n = 0

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  jo = await insert(first, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: 'w50-race-jo@example.com', can_issue_refunds: true, can_manage_pricing: true })
  tia = await insert(first, 'staff', { role: 'staff', first_name: 'Tia', last_name: 'Team', email: 'w50-race-tia@example.com' })
  sauna = await fixtures.serviceType(first, { name: 'Sauna' })
  band = await fixtures.band(first)
  towel = await insert(first, 'addons', { name: 'Towel', base_price: '5.00', sku: 'TOWEL' })
})
afterAll(() => pg.stop())

/** A booking of its own customer on its own day (a customer has one booking a day; live bookings may not overlap), with two guests and a towel. */
async function newBooking(status = 'confirmed'): Promise<{ id: string; sam: string; alex: string; line: string }> {
  n += 1
  const day = new Date(Date.UTC(2031, 2, n)).toISOString().slice(0, 10)
  const session = await fixtures.session(first, { service_type_id: sauna, band_id: band, start_time: `${day} 10:00:00+00`, end_time: `${day} 11:00:00+00` })
  // The booking carries its session's times, as every real booking does (live bookings on different sessions may not overlap).
  const id = await fixtures.booking(first, { session_id: session, customer_id: await fixtures.customer(first), party_size: 2, status, price_paid: '40.00', redemption_source: 'paid', start_time: `${day} 10:00:00+00`, end_time: `${day} 11:00:00+00` })
  const guest = (name: string, type: string, second: number) => insert(first, 'booking_guests', { booking_id: id, guest_type: type, guest_name: name, unit_price: '20.00', pay_by: 'paid', created_at: `2031-01-01 09:00:0${second}+00` })
  const sam = await guest('Sam Test', 'account_holder', 0)
  const alex = await guest('Alex Guest', 'additional_guest', 1)
  const line = await insert(first, 'addon_order_lines', { booking_id: id, addon_id: towel, quantity: 1, price_at_purchase: '5.00', sku_at_purchase: 'TOWEL', redemption_source: 'paid' })
  return { id, sam, alex, line }
}

const backendPid = async (tx: Tx) => (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number
/** A cancel as far as the booking goes: the booking's own locks (as every cancel, move, settle and refund takes them first), then its status. */
async function cancelIn(tx: Tx, bookingId: string): Promise<void> {
  const held = await lockForBooking(tx, { bookingId, ownSession: true })
  if (!held) throw new Error('The booking to cancel is not there.')
  await tx.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1::uuid", [bookingId])
}

/** A change started on the first connection and held open, after its writes, until `release()`; `ends` says how it then ends. */
function heldChange(change: (tx: Tx) => Promise<void>, ends: 'commit' | 'rollback' = 'commit') {
  const gate = deferred()
  let announce: (pid: number) => void = () => {}
  const holding = new Promise<number>((resolve) => {
    announce = resolve
  })
  const done = first
    .transaction(async (tx) => {
      await change(tx)
      announce(await backendPid(tx))
      await gate.promise
      if (ends === 'rollback') throw new Error('the change is put back')
    })
    .then(
      () => 'committed',
      () => 'rolled back'
    )
  return { holding, release: gate.resolve, done }
}
/** A cancel started on the first connection and held open, after its write, until `release()`; `ends` says how it then ends. */
const heldCancel = (bookingId: string, ends: 'commit' | 'rollback' = 'commit') => heldChange((tx) => cancelIn(tx, bookingId), ends)

/**
 * W50a: a payment flow's opening as far as the booking goes (a Move's, Settle's or Add Guest's C1): the booking's own
 * locks, as every booking change takes them first, then the flow's record, pending, written by the Worker's own
 * writeFlowRecord. Nothing is asked of Stripe (C1 never does).
 */
async function openFlowIn(tx: Tx, bookingId: string): Promise<void> {
  const held = await lockForBooking(tx, { bookingId, ownSession: true })
  if (!held) throw new Error('The booking to take payment on is not there.')
  await writeFlowRecord(tx, {
    flow: 'settle',
    recordId: bookingId,
    expectedAmount: 20,
    snapshot: { customer_id: held.customerId, description: 'W50a race', method: 'reader', channel: 'staff', request_id: 'req_w50a_race', livemode: false, stripe_customer_id: null },
  })
}
/** A flow's opening started on the first connection and held open, after its record is written, until `release()`. */
const heldOpening = (bookingId: string, ends: 'commit' | 'rollback' = 'commit') => heldChange((tx) => openFlowIn(tx, bookingId), ends)
const openFlowsOf = async (bookingId: string) => (await first.query("SELECT 1 FROM pending_reader_payments WHERE record_id = $1 AND status = 'pending'", [bookingId])).length

/**
 * Whether `work` finishes without Postgres ever reporting a session blocked by `holder`. Asked again and again until
 * `work` has finished, so "it never waited" is what Postgres says, not a guess from timing.
 */
async function finishesWithoutWaitingOn<T>(holder: number, work: Promise<T>): Promise<{ finished: T } | 'waited'> {
  let settled: { ok: true; value: T } | { ok: false; error: unknown } | null = null
  void work.then(
    (value) => {
      settled = { ok: true, value }
    },
    (error: unknown) => {
      settled = { ok: false, error }
    }
  )
  for (;;) {
    const now = settled as { ok: true; value: T } | { ok: false; error: unknown } | null
    if (now) {
      if (!now.ok) throw now.error
      return { finished: now.value }
    }
    const blocked = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (blocked[0]) return 'waited'
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const statusOf = async (bookingId: string) => (await first.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [bookingId]))[0]?.status
const waiverOf = async (guestId: string) => (await first.query<{ waiver_accepted: boolean | null; waiver_method: string | null }>('SELECT waiver_accepted, waiver_method FROM booking_guests WHERE id = $1', [guestId]))[0]
const preparedOf = async (lineId: string) => (await first.query<{ prepared: boolean; prepared_by: string | null }>('SELECT prepared, prepared_by FROM addon_order_lines WHERE id = $1', [lineId]))[0]
const checkedIn = async (bookingId: string) => (await first.query('SELECT 1 FROM bookings WHERE id = $1 AND checked_in_at IS NOT NULL', [bookingId])).length === 1
const flagRowsOf = async (entityId: string) => (await first.query<{ action: string; actor_id: string }>("SELECT action, actor_id FROM audit_log WHERE entity_id = $1 AND action LIKE 'booking.%' ORDER BY at", [entityId])).map((row) => [row.action, row.actor_id])

const sign = { accepted: true, waiverMethod: 'in_person' }
const staffPress = (staffId: string) => ({ channel: 'staff' as const, ...pressBy(staffId, 'staff') })

describe("a guest's waiver against a cancel (W48 review L2)", () => {
  it('a waiver pressed while the booking is being cancelled waits for the cancel on the booking\'s row, and is then refused on the committed status: nothing is signed', async () => {
    const booking = await newBooking()
    const cancel = heldCancel(booking.id)
    const holder = await cancel.holding
    const pressed = outcomeOf(setGuestWaiver(second, booking.sam, sign, staffPress(tia)))
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    cancel.release()
    expect(await cancel.done).toBe('committed')
    expect(await pressed).toEqual({ refused: 'booking_cancelled' })
    expect(await waiverOf(booking.sam)).toEqual({ waiver_accepted: false, waiver_method: null })
    expect(await flagRowsOf(booking.sam)).toEqual([])
  })

  it('the same waiver when the cancel is put back goes through, with its one audit row', async () => {
    const booking = await newBooking()
    const cancel = heldCancel(booking.id, 'rollback')
    const holder = await cancel.holding
    const pressed = outcomeOf(setGuestWaiver(second, booking.sam, sign, staffPress(tia)))
    await sessionBlockedBy(pg, holder)
    cancel.release()
    expect(await cancel.done).toBe('rolled back')
    expect(await pressed).toMatchObject({ answered: { id: booking.sam, waiver_accepted: true, waiver_method: 'in_person' } })
    expect(await statusOf(booking.id)).toBe('confirmed')
    expect(await flagRowsOf(booking.sam)).toEqual([['booking.guest_waiver_set', tia]])
  })

  it('control: the same statement without the booking held first does not wait, and signs a waiver on a booking whose cancel has already been written', async () => {
    const booking = await newBooking()
    const cancel = heldCancel(booking.id)
    await cancel.holding
    // The flag's own guarded statement, alone: its guard reads the booking as it was before the cancel's write.
    const signed = await second.query<{ waiver_accepted: boolean }>(signWaiverSql(false), [booking.alex, 'in_person', 'v1'])
    expect(signed.map((row) => row.waiver_accepted)).toEqual([true])
    cancel.release()
    expect(await cancel.done).toBe('committed')
    // What the lock prevents: the booking is cancelled, and a waiver was signed on it after the cancel wrote its status.
    expect(await statusOf(booking.id)).toBe('cancelled')
    expect(await waiverOf(booking.alex)).toEqual({ waiver_accepted: true, waiver_method: 'in_person' })
  })

  it('the other way round: a cancel that starts while a waiver is being signed waits for it on the booking\'s row; the waiver is signed first, then the booking is cancelled', async () => {
    const booking = await newBooking()
    const press = holdingAfter(second, (sql) => sql.includes('FOR SHARE OF b'))
    const pressed = outcomeOf(setGuestWaiver(press.db, booking.sam, sign, staffPress(tia)))
    const holder = await press.holding
    const cancelled = first.transaction((tx) => cancelIn(tx, booking.id)).then(() => 'committed')
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    press.release()
    expect(await pressed).toMatchObject({ answered: { waiver_accepted: true } })
    expect(await cancelled).toBe('committed')
    expect(await statusOf(booking.id)).toBe('cancelled')
    expect(await waiverOf(booking.sam)).toEqual({ waiver_accepted: true, waiver_method: 'in_person' })
  })

  it('two flags on one booking do not wait for each other: the hold is shared', async () => {
    const booking = await newBooking()
    const press = holdingAfter(second, (sql) => sql.includes('FOR SHARE OF b'))
    const held = outcomeOf(setGuestWaiver(press.db, booking.sam, sign, staffPress(tia)))
    await press.holding
    // While the first press is still open, a second guest's waiver and the add-on's tick both go through.
    expect(await outcomeOf(setGuestWaiver(first, booking.alex, sign, staffPress(jo)))).toMatchObject({ answered: { waiver_accepted: true } })
    expect(await outcomeOf(setAddonLinePrepared(first, booking.line, true, pressBy(jo, 'staff')))).toMatchObject({ answered: { prepared: true } })
    press.release()
    expect(await held).toMatchObject({ answered: { waiver_accepted: true } })
  })
})

describe('an add-on marked prepared against a cancel (W48 review L2)', () => {
  it('a tick pressed while the booking is being cancelled waits for the cancel on the booking\'s row, and is then refused on the committed status: nothing is marked', async () => {
    const booking = await newBooking()
    const cancel = heldCancel(booking.id)
    const holder = await cancel.holding
    const pressed = outcomeOf(setAddonLinePrepared(second, booking.line, true, pressBy(tia, 'staff')))
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    cancel.release()
    expect(await cancel.done).toBe('committed')
    expect(await pressed).toEqual({ refused: 'booking_cancelled' })
    expect(await preparedOf(booking.line)).toEqual({ prepared: false, prepared_by: null })
    expect(await flagRowsOf(booking.line)).toEqual([])
  })

  it('the same tick when the cancel is put back goes through, with its one audit row', async () => {
    const booking = await newBooking()
    const cancel = heldCancel(booking.id, 'rollback')
    const holder = await cancel.holding
    const pressed = outcomeOf(setAddonLinePrepared(second, booking.line, true, pressBy(tia, 'staff')))
    await sessionBlockedBy(pg, holder)
    cancel.release()
    expect(await cancel.done).toBe('rolled back')
    expect(await pressed).toMatchObject({ answered: { id: booking.line, prepared: true, prepared_by: tia } })
    expect(await flagRowsOf(booking.line)).toEqual([['booking.addon_prepared_set', tia]])
  })

  it('control: the same statement without the booking held first does not wait, and marks an add-on prepared on a booking whose cancel has already been written', async () => {
    const booking = await newBooking()
    const cancel = heldCancel(booking.id)
    await cancel.holding
    const marked = await second.query<{ prepared: boolean }>(PREPARE_ADDON_LINE_SQL, [booking.line, tia])
    expect(marked.map((row) => row.prepared)).toEqual([true])
    cancel.release()
    expect(await cancel.done).toBe('committed')
    expect(await statusOf(booking.id)).toBe('cancelled')
    expect(await preparedOf(booking.line)).toEqual({ prepared: true, prepared_by: tia })
  })

  it('the other way round: a cancel that starts while a tick is being made waits for it on the booking\'s row', async () => {
    const booking = await newBooking()
    const press = holdingAfter(second, (sql) => sql.includes('FOR SHARE OF b'))
    const pressed = outcomeOf(setAddonLinePrepared(press.db, booking.line, true, pressBy(tia, 'staff')))
    const holder = await press.holding
    const cancelled = first.transaction((tx) => cancelIn(tx, booking.id)).then(() => 'committed')
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    press.release()
    expect(await pressed).toMatchObject({ answered: { prepared: true } })
    expect(await cancelled).toBe('committed')
    expect(await statusOf(booking.id)).toBe('cancelled')
  })
})

describe("Check In against a cancel, and against a payment that has just failed (the route's own rule)", () => {
  it('a check-in that meets a cancel in progress waits for it on the booking\'s row, then is refused by its own guard: nothing is written', async () => {
    const booking = await newBooking()
    const cancel = heldCancel(booking.id)
    const holder = await cancel.holding
    const pressed = outcomeOf(setBookingCheckedIn(second, booking.id, true, pressBy(tia, 'staff')))
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    cancel.release()
    expect(await cancel.done).toBe('committed')
    expect(await pressed).toEqual({ refused: 'booking_cancelled' })
    expect(await checkedIn(booking.id)).toBe(false)
    expect(await flagRowsOf(booking.id)).toEqual([])
  })

  it('the same check-in when the cancel is put back goes through, with its one audit row', async () => {
    const booking = await newBooking()
    const cancel = heldCancel(booking.id, 'rollback')
    const holder = await cancel.holding
    const pressed = outcomeOf(setBookingCheckedIn(second, booking.id, true, pressBy(tia, 'staff')))
    await sessionBlockedBy(pg, holder)
    cancel.release()
    expect(await cancel.done).toBe('rolled back')
    expect(await pressed).toMatchObject({ answered: { id: booking.id } })
    expect(await checkedIn(booking.id)).toBe(true)
    expect(await flagRowsOf(booking.id)).toEqual([['booking.checked_in', tia]])
  })

  it('Q49 under a race: a check-in that meets the booking being moved to Payment needed waits, then is refused "needs payment first"', async () => {
    const booking = await newBooking()
    const gate = deferred()
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    // The failed renewal's flag (flag_credit_bookings_payment_needed is one UPDATE of the booking), held open.
    const lapsing = first.transaction(async (tx) => {
      await tx.query("UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '72 hours', updated_at = now() WHERE id = $1::uuid", [booking.id])
      announce(await backendPid(tx))
      await gate.promise
    })
    const holder = await holding
    const pressed = outcomeOf(setBookingCheckedIn(second, booking.id, true, pressBy(tia, 'staff')))
    await sessionBlockedBy(pg, holder)
    gate.resolve()
    await lapsing
    expect(await pressed).toEqual({ refused: 'payment_needed' })
    expect(await checkedIn(booking.id)).toBe(false)
  })
})

// Brief W50a item 3 (W50 review L2; Wayne, 20 Nov): Check In is refused while a payment is still being taken on the
// booking. An open payment is another table's row (pending_reader_payments), so the check-in's own guard can't be
// trusted with it alone: the booking is held first, with the lock its UPDATE takes.
describe('W50a: Check In against a payment flow that is opening', () => {
  it("a check-in pressed while a flow is opening waits for it on the booking's row, and is then refused \"payment open\" on the committed record: nothing is written", async () => {
    const booking = await newBooking()
    const opening = heldOpening(booking.id)
    const holder = await opening.holding
    const pressed = outcomeOf(setBookingCheckedIn(second, booking.id, true, pressBy(tia, 'staff')))
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    opening.release()
    expect(await opening.done).toBe('committed')
    expect(await pressed).toEqual({ refused: 'payment_open' })
    expect(await openFlowsOf(booking.id)).toBe(1)
    expect(await checkedIn(booking.id)).toBe(false)
    expect(await flagRowsOf(booking.id)).toEqual([])
  })

  it('the same check-in when the opening is put back (nothing was opened) goes through, with its one audit row', async () => {
    const booking = await newBooking()
    const opening = heldOpening(booking.id, 'rollback')
    const holder = await opening.holding
    const pressed = outcomeOf(setBookingCheckedIn(second, booking.id, true, pressBy(tia, 'staff')))
    await sessionBlockedBy(pg, holder)
    opening.release()
    expect(await opening.done).toBe('rolled back')
    expect(await pressed).toMatchObject({ answered: { id: booking.id } })
    expect(await openFlowsOf(booking.id)).toBe(0)
    expect(await checkedIn(booking.id)).toBe(true)
    expect(await flagRowsOf(booking.id)).toEqual([['booking.checked_in', tia]])
  })

  it("control: the check-in's own statement without the booking held first also waits on the row, but is judged on what it saw before the wait: it checks in a booking whose payment has just opened", async () => {
    const booking = await newBooking()
    const opening = heldOpening(booking.id)
    const holder = await opening.holding
    // The guarded statement alone. It waits for the flow's lock on the row it updates; its guard read the open
    // payments when it started, before the flow's record was committed, and is not asked again.
    const updated = second.query<{ id: string; checked_in_at: unknown }>(CHECK_IN_SQL, [booking.id])
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    opening.release()
    expect(await opening.done).toBe('committed')
    expect((await updated).map((row) => row.id)).toEqual([booking.id])
    // What the hold prevents: a payment is open on the booking, and it was checked in after the payment opened.
    expect(await openFlowsOf(booking.id)).toBe(1)
    expect(await checkedIn(booking.id)).toBe(true)
  })

  it("the other way round: a flow that starts opening while a check-in is being made waits for it on the booking's row; the check-in lands first, then the payment opens", async () => {
    const booking = await newBooking()
    const press = holdingAfter(second, (sql) => sql.includes('FOR NO KEY UPDATE OF b'))
    const pressed = outcomeOf(setBookingCheckedIn(press.db, booking.id, true, pressBy(tia, 'staff')))
    const holder = await press.holding
    const opened = first.transaction((tx) => openFlowIn(tx, booking.id)).then(() => 'committed')
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    press.release()
    expect(await pressed).toMatchObject({ answered: { id: booking.id } })
    expect(await opened).toBe('committed')
    expect(await checkedIn(booking.id)).toBe(true)
    expect(await openFlowsOf(booking.id)).toBe(1)
  })

  it('two check-ins of one booking at once take turns on the hold and both answer the one time: neither ends up waiting for the other', async () => {
    const booking = await newBooking()
    const press = holdingAfter(second, (sql) => sql.includes('FOR NO KEY UPDATE OF b'))
    const held = outcomeOf(setBookingCheckedIn(press.db, booking.id, true, pressBy(tia, 'staff')))
    const holder = await press.holding
    const other = outcomeOf(setBookingCheckedIn(first, booking.id, true, pressBy(jo, 'staff')))
    // The second press waits at its own hold (a shared hold would let it through, and each would then wait for the other's).
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    press.release()
    const [a, b] = [await held, await other]
    expect(a).toMatchObject({ answered: { id: booking.id } })
    expect(b).toEqual(a)
    expect((await flagRowsOf(booking.id)).sort()).toEqual([['booking.checked_in', jo], ['booking.checked_in', tia]].sort())
  })

  it('an undo, a waiver and a prepared tick pressed while a flow is opening still wait for it and then go through: only Check In is refused', async () => {
    const booking = await newBooking()
    await first.query("UPDATE bookings SET checked_in_at = '2031-01-01 09:00:00+00' WHERE id = $1", [booking.id])
    const opening = heldOpening(booking.id)
    const holder = await opening.holding
    const undone = outcomeOf(setBookingCheckedIn(second, booking.id, false, pressBy(tia, 'staff')))
    await sessionBlockedBy(pg, holder)
    opening.release()
    expect(await opening.done).toBe('committed')
    expect(await undone).toEqual({ answered: { id: booking.id, checked_in_at: null } })
    expect(await outcomeOf(setGuestWaiver(second, booking.sam, sign, staffPress(tia)))).toMatchObject({ answered: { waiver_accepted: true } })
    expect(await outcomeOf(setAddonLinePrepared(second, booking.line, true, pressBy(tia, 'staff')))).toMatchObject({ answered: { prepared: true } })
    expect(await outcomeOf(setBookingCheckedIn(second, booking.id, true, pressBy(tia, 'staff')))).toEqual({ refused: 'payment_open' })
  })
})

// Brief W50a item 4a (W50 review L6a): on the customer channel the waiver's hold names the customer, so a customer
// pressing on someone else's guest never takes (or waits for) a lock on that booking.
describe("W50a: the customer channel never locks a booking that isn't the customer's", () => {
  const link = { accepted: true, waiverMethod: 'email_link' }
  const byCustomer = (customerId: string) => ({ channel: 'customer' as const, customerId, requestId: crypto.randomUUID(), pressKey: crypto.randomUUID() })
  const ownerOf = async (bookingId: string) => (await first.query<{ customer_id: string }>('SELECT customer_id FROM bookings WHERE id = $1', [bookingId]))[0]?.customer_id ?? ''

  it("someone else's guest, while that booking is being cancelled: refused at once, without waiting for the cancel; and nothing is signed", async () => {
    const booking = await newBooking()
    const stranger = await fixtures.customer(first)
    const cancel = heldCancel(booking.id)
    const holder = await cancel.holding
    // The cancel still holds the booking's row. A press that locked it (or tried to) would be reported waiting.
    const outcome = await finishesWithoutWaitingOn(holder, outcomeOf(setGuestWaiver(second, booking.sam, link, byCustomer(stranger))))
    cancel.release()
    expect(await cancel.done).toBe('committed')
    expect(outcome).toEqual({ finished: { refused: 'not_their_booking' } })
    expect(await waiverOf(booking.sam)).toEqual({ waiver_accepted: false, waiver_method: null })
    expect(await flagRowsOf(booking.sam)).toEqual([])
  })

  it("someone else's guest, pressed and still open: a cancel of that booking goes straight through, held up by nothing", async () => {
    const booking = await newBooking()
    const stranger = await fixtures.customer(first)
    const press = holdingAfter(second, (sql) => sql.includes('FOR SHARE OF b'))
    const pressed = outcomeOf(setGuestWaiver(press.db, booking.sam, link, byCustomer(stranger)))
    const holder = await press.holding
    const cancelled = await finishesWithoutWaitingOn(holder, first.transaction((tx) => cancelIn(tx, booking.id)).then(() => 'committed'))
    press.release()
    expect(cancelled).toEqual({ finished: 'committed' })
    expect(await pressed).toEqual({ refused: 'not_their_booking' })
    expect(await statusOf(booking.id)).toBe('cancelled')
  })

  it('control: their own guest is still held, as for staff: the press waits for a cancel in progress and is refused on the committed status', async () => {
    const booking = await newBooking()
    const owner = await ownerOf(booking.id)
    const cancel = heldCancel(booking.id)
    const holder = await cancel.holding
    const pressed = outcomeOf(setGuestWaiver(second, booking.sam, link, byCustomer(owner)))
    expect(await finishesWithoutWaitingOn(holder, pressed)).toBe('waited')
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['bookings'])
    cancel.release()
    expect(await cancel.done).toBe('committed')
    expect(await pressed).toEqual({ refused: 'booking_cancelled' })
    expect(await waiverOf(booking.sam)).toEqual({ waiver_accepted: false, waiver_method: null })
  })
})
