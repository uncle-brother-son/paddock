import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { listEvents, setEventDetails } from '@/server/rules/catalog/events'
import { holdingAfter, outcomeOf, pressBy, sessionBlockedBy } from '@/server/rules/testing/admin-race'
import { fixtures, insert } from '@/server/rules/testing/database'
import { waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { CHECK_IN_ATTENDEES_SQL, checkInEventAttendees, setEventAttendeeWaiver, undoEventAttendeeCheckIn, waiverStatement } from './attendance'
import { cancelEvent } from './cancel-event'
import { cancelEventPlaces, type EventCancelOptions } from './cancel-places'

// Brief W52 item 5 (W35 audit row 15; W48 review L2; "Parity and tests", the races): the event day's flags against
// step E's place cancel, the whole event's cancel and an edit of the event, on real Postgres 17.6, each on its own
// connection (PGlite is one session and can't show one press waiting for another).
//
// Every flag's guard reads the event and the event booking, which are other tables' rows, so each flag holds its
// attendee's event FOR SHARE first. The other side here is the Worker's own rule (cancelEventPlaces, cancelEvent,
// setEventDetails), stopped inside its transaction straight after the statement that takes its locks or makes its
// write. Each race is held until Postgres itself reports the second as blocked by the first, so none can pass by
// timing, and each has a control showing what happens without the event held first.

let pg: RealPostgres
let first: Db
let second: Db
let jo = ''
let tia = ''

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  jo = await insert(first, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: 'w52-race-jo@example.com', can_issue_refunds: true, can_manage_pricing: true })
  tia = await insert(first, 'staff', { role: 'staff', first_name: 'Tia', last_name: 'Team', email: 'w52-race-tia@example.com' })
})
afterAll(() => pg.stop())

interface Booked {
  eventId: string
  customerId: string
  bookingId: string
  sam: string
  alex: string
}

/**
 * An event that is on today by London's wall clock (so check-in is open, and stays open through tomorrow: a run that
 * crosses London's midnight still finds it open), with one confirmed booking of two £40 places on a cash order. Each
 * booking is on an event of its own. The standard waivers are signed, so only the lock is in a check-in's way.
 */
async function bookedToday(): Promise<Booked> {
  const customerId = await fixtures.customer(first)
  const eventId = await fixtures.event(first, { capacity: 10, places_booked: 2 })
  await first.query(
    `UPDATE events
        SET starts_at = ((now() AT TIME ZONE 'Europe/London')::date::timestamp + interval '12 hours') AT TIME ZONE 'UTC',
            ends_at = ((now() AT TIME ZONE 'Europe/London')::date::timestamp + interval '48 hours') AT TIME ZONE 'UTC',
            refund_cutoff_at = ((now() AT TIME ZONE 'Europe/London')::date::timestamp - interval '24 hours') AT TIME ZONE 'UTC'
      WHERE id = $1`,
    [eventId]
  )
  const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: '80.00', payment_status: 'paid', payment_method: 'cash', order_source: 'staff_created' })
  const bookingId = await insert(first, 'event_bookings', { event_id: eventId, customer_id: customerId, places: 2, status: 'confirmed', price_paid: '80.00' })
  const place = (name: string, type: string, second: number) =>
    insert(first, 'event_attendees', { event_booking_id: bookingId, attendee_type: type, name, unit_price: '40.00', price_level: 'public', waiver_accepted: true, waiver_method: 'email_link', waiver_version: 'v1', waiver_accepted_at: '2026-11-01 10:00:00+00', created_at: `2026-11-01 10:00:0${second}+00` })
  const sam = await place('Sam Test', 'account_holder', 0)
  const alex = await place('Alex Guest', 'guest', 1)
  await insert(first, 'order_line_items', { order_id: orderId, item_type: 'event', quantity: 2, unit_price: '40.00', line_total: '80.00', event_booking_id: bookingId })
  return { eventId, customerId, bookingId, sam, alex }
}

const cancelOptions = (): EventCancelOptions => ({ actor: { type: 'staff', id: jo }, requestId: crypto.randomUUID(), canIssueRefunds: true })
/** Step E's place cancel (No refund, so nothing is asked of Stripe), on `db`. */
const cancelPlaces = (db: Db, booked: Booked, attendeeIds: string[]) => outcomeOf(cancelEventPlaces(db, booked.bookingId, { attendeeIds, refund: 'none', confirmed: { refund: 0 } }, cancelOptions()))
/** The statement a place cancel takes its locks with (refunds/locks.ts): the order, its customer, the event, the event booking. */
const afterTheCancelsLocks = (sql: string) => sql.includes('FROM (SELECT id, customer_id FROM orders WHERE id = $1::uuid FOR UPDATE) o')
/** The event's own hold, as each flag takes it. */
const afterTheEventHold = (sql: string) => sql.includes('FOR SHARE OF e')

const place = async (attendeeId: string) =>
  (
    await first.query<{ checked_in: boolean; cancelled: boolean; waiver_accepted: boolean; waiver_method: string | null }>(
      'SELECT checked_in_at IS NOT NULL AS checked_in, cancelled_at IS NOT NULL AS cancelled, waiver_accepted, waiver_method FROM event_attendees WHERE id = $1',
      [attendeeId]
    )
  )[0]
const flagRowsOf = async (attendeeId: string) =>
  (await first.query<{ action: string; actor_id: string }>("SELECT action, actor_id FROM audit_log WHERE entity_id = $1 AND action LIKE 'event_attendee.%' ORDER BY at, id", [attendeeId])).map((row) => [row.action, row.actor_id])
const eventCancelled = async (eventId: string) => (await first.query('SELECT 1 FROM events WHERE id = $1 AND cancelled_at IS NOT NULL', [eventId])).length === 1
const checkedInOutcomes = (outcome: Awaited<ReturnType<typeof outcomeOf<Awaited<ReturnType<typeof checkInEventAttendees>>>>>) =>
  'answered' in outcome ? outcome.answered.results.map((one) => (one.updated ? 'checked in' : one.reason)) : [`refused: ${outcome.refused}`]

/** Whether `work` finishes without Postgres ever reporting a session blocked by `holder`: asked until `work` has finished. */
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

describe('check-in against a place cancel (W35 audit row 15)', () => {
  it("a check-in pressed while a place cancel is in progress waits for it on the event's row, and is then refused on what the cancel committed: the place is cancelled, not checked in, and no row says it was", async () => {
    const booked = await bookedToday()
    const cancel = holdingAfter(first, afterTheCancelsLocks)
    const cancelled = cancelPlaces(cancel.db, booked, [booked.sam])
    const holder = await cancel.holding
    const pressed = outcomeOf(checkInEventAttendees(second, { attendeeIds: [booked.sam] }, pressBy(tia, 'staff')))
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['events'])
    cancel.release()
    expect(await cancelled).toMatchObject({ answered: { places: 1 } })
    expect(checkedInOutcomes(await pressed)).toEqual(['attendee_cancelled'])
    expect(await place(booked.sam)).toMatchObject({ checked_in: false, cancelled: true })
    expect(await flagRowsOf(booked.sam)).toEqual([])
  })

  it('"Check in all" pressed during the same cancel waits too, then checks in the place still booked and refuses the cancelled one, each with its own outcome', async () => {
    const booked = await bookedToday()
    const cancel = holdingAfter(first, afterTheCancelsLocks)
    const cancelled = cancelPlaces(cancel.db, booked, [booked.alex])
    const holder = await cancel.holding
    const pressed = outcomeOf(checkInEventAttendees(second, { attendeeIds: [booked.sam, booked.alex], markWaiversSignedInPerson: true }, pressBy(tia, 'staff')))
    await sessionBlockedBy(pg, holder)
    cancel.release()
    expect(await cancelled).toMatchObject({ answered: { places: 1 } })
    expect(checkedInOutcomes(await pressed)).toEqual(['checked in', 'attendee_cancelled'])
    expect(await place(booked.sam)).toMatchObject({ checked_in: true, cancelled: false })
    expect(await place(booked.alex)).toMatchObject({ checked_in: false, cancelled: true })
    expect(await flagRowsOf(booked.sam)).toEqual([['event_attendee.checked_in', tia]])
    expect(await flagRowsOf(booked.alex)).toEqual([])
  })

  it("control: the check-in's own statement without the event held first does not wait for the cancel: it checks the place in under a cancel staff have already been quoted for, which is then refused", async () => {
    const booked = await bookedToday()
    const cancel = holdingAfter(first, afterTheCancelsLocks)
    const cancelled = cancelPlaces(cancel.db, booked, [booked.sam])
    const holder = await cancel.holding
    // The guarded statement alone: nothing of it waits on the event's row, which the cancel holds.
    const alone = await finishesWithoutWaitingOn(holder, second.query<{ requested_id: string; reason: string | null; id: string | null }>(CHECK_IN_ATTENDEES_SQL, [false, [booked.sam], 'v1']))
    expect(alone).not.toBe('waited')
    expect(alone === 'waited' ? [] : alone.finished.map((row) => [row.reason, row.id])).toEqual([[null, booked.sam]])
    cancel.release()
    // What the hold prevents: the two pressed at once, and the one that started first lost.
    const outcome = await cancelled
    expect('refused' in outcome ? outcome.refused : 'answered').toBe('attendee_checked_in')
    expect(await place(booked.sam)).toMatchObject({ checked_in: true, cancelled: false })
  })

  it("the other way round: a cancel that starts while a check-in is being made waits for it on the event's row; the check-in lands first, and the cancel then reads the place as checked in and is refused whole", async () => {
    const booked = await bookedToday()
    const press = holdingAfter(second, afterTheEventHold)
    const pressed = outcomeOf(checkInEventAttendees(press.db, { attendeeIds: [booked.sam] }, pressBy(tia, 'staff')))
    const holder = await press.holding
    const cancelled = cancelPlaces(first, booked, [booked.sam, booked.alex])
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['events'])
    press.release()
    expect(checkedInOutcomes(await pressed)).toEqual(['checked in'])
    expect(await cancelled).toEqual({ refused: 'attendee_checked_in' })
    expect(await place(booked.sam)).toMatchObject({ checked_in: true, cancelled: false })
    expect(await place(booked.alex)).toMatchObject({ checked_in: false, cancelled: false })
    expect(await flagRowsOf(booked.sam)).toEqual([['event_attendee.checked_in', tia]])
  })

  it('two check-ins on one event do not wait for each other at the event: the hold is shared', async () => {
    const booked = await bookedToday()
    const press = holdingAfter(second, afterTheEventHold)
    const held = outcomeOf(checkInEventAttendees(press.db, { attendeeIds: [booked.sam] }, pressBy(tia, 'staff')))
    const holder = await press.holding
    // While the first press is still open, the other attendee is checked in, and has a waiver changed.
    const other = await finishesWithoutWaitingOn(holder, outcomeOf(checkInEventAttendees(first, { attendeeIds: [booked.alex] }, pressBy(jo))))
    expect(other === 'waited' ? other : checkedInOutcomes(other.finished)).toEqual(['checked in'])
    press.release()
    expect(checkedInOutcomes(await held)).toEqual(['checked in'])
  })

  it('two presses naming the same attendee queue on the attendee\'s own row (W48 review L1) and both answer the one time', async () => {
    const booked = await bookedToday()
    const press = holdingAfter(second, (sql) => sql.includes('FOR NO KEY UPDATE OF ea'))
    const held = outcomeOf(checkInEventAttendees(press.db, { attendeeIds: [booked.sam, booked.alex] }, pressBy(tia, 'staff')))
    const holder = await press.holding
    const other = outcomeOf(checkInEventAttendees(first, { attendeeIds: [booked.alex, booked.sam] }, pressBy(jo)))
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['event_attendees'])
    press.release()
    const [a, b] = [await held, await other]
    expect(checkedInOutcomes(a)).toEqual(['checked in', 'checked in'])
    expect(checkedInOutcomes(b)).toEqual(['checked in', 'checked in'])
    const timesOf = (outcome: typeof a) => ('answered' in outcome ? outcome.answered.results.map((one) => (one.updated ? [one.attendeeId, one.attendee.checked_in_at] : [])).sort() : [])
    expect(timesOf(b)).toEqual(timesOf(a))
  })
})

describe("check-in against the whole event's cancel and an edit of the event (the guard reads the event: W48 review L2)", () => {
  it("a check-in pressed while the event is being cancelled waits for it on the event's row, and is then refused: nobody is checked in on a cancelled event", async () => {
    const booked = await bookedToday()
    const cancel = holdingAfter(first, (sql) => sql.includes('SET active = false'))
    const cancelling = outcomeOf(cancelEvent(cancel.db, booked.eventId, { refund: 'credit', reason: 'Storm' }, { actor: { type: 'staff', id: jo }, requestId: crypto.randomUUID() }))
    const holder = await cancel.holding
    const pressed = outcomeOf(checkInEventAttendees(second, { attendeeIds: [booked.sam] }, pressBy(tia, 'staff')))
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['events'])
    cancel.release()
    expect(await cancelling).toHaveProperty('answered')
    expect(checkedInOutcomes(await pressed)).toEqual(['event_cancelled'])
    expect(await eventCancelled(booked.eventId)).toBe(true)
    expect(await place(booked.sam)).toMatchObject({ checked_in: false })
  })

  it("control: the check-in's own statement without the event held first does not wait, and checks an attendee in on an event whose cancel has already been written", async () => {
    const booked = await bookedToday()
    const cancel = holdingAfter(first, (sql) => sql.includes('SET active = false'))
    const cancelling = outcomeOf(cancelEvent(cancel.db, booked.eventId, { refund: 'credit', reason: 'Storm' }, { actor: { type: 'staff', id: jo }, requestId: crypto.randomUUID() }))
    await cancel.holding
    // Its guard reads the event as it was before the cancel's write, which isn't committed yet.
    const rows = await second.query<{ reason: string | null; id: string | null }>(CHECK_IN_ATTENDEES_SQL, [false, [booked.sam], 'v1'])
    expect(rows.map((row) => [row.reason, row.id])).toEqual([[null, booked.sam]])
    cancel.release()
    expect(await cancelling).toHaveProperty('answered')
    // What the hold prevents: the event is cancelled, and an attendee was checked in on it after the cancel was written.
    expect(await eventCancelled(booked.eventId)).toBe(true)
    expect(await place(booked.sam)).toMatchObject({ checked_in: true })
  })

  it("a check-in pressed while the event's date is being moved waits for the edit, and is then decided on the new date: check-in isn't open", async () => {
    const booked = await bookedToday()
    const stamp = (await listEvents(first, pressBy(jo).actor)).find((event) => event.id === booked.eventId)?.stamp
    const edit = holdingAfter(first, (sql) => sql.startsWith('UPDATE events'))
    const moved = outcomeOf(
      setEventDetails(
        edit.db,
        { eventId: booked.eventId, startsAt: '2099-06-15T18:00:00.000Z', endsAt: '2099-06-15T20:00:00.000Z', capacity: 10, access: 'public', publicReleaseAt: null, pricePublic: 40, pricePreHerd: 30, priceHerd: 20, refundCutoffAt: '2099-06-14T18:00:00.000Z', stamp },
        pressBy(jo)
      )
    )
    const holder = await edit.holding
    const pressed = outcomeOf(checkInEventAttendees(second, { attendeeIds: [booked.sam] }, pressBy(tia, 'staff')))
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['events'])
    edit.release()
    expect(await moved).toMatchObject({ answered: { updated: true } })
    expect(checkedInOutcomes(await pressed)).toEqual(['check_in_not_open'])
    expect(await place(booked.sam)).toMatchObject({ checked_in: false })
  })
})

describe('undo and a waiver against a place cancel', () => {
  it('an undo pressed while a cancel of the checked-in place is in progress waits for it; the cancel is refused (the place is checked in), and the undo then goes through', async () => {
    const booked = await bookedToday()
    await first.query('UPDATE event_attendees SET checked_in_at = now() WHERE id = $1', [booked.sam])
    const cancel = holdingAfter(first, afterTheCancelsLocks)
    const cancelled = cancelPlaces(cancel.db, booked, [booked.sam])
    const holder = await cancel.holding
    const undone = outcomeOf(undoEventAttendeeCheckIn(second, booked.sam, pressBy(tia, 'staff')))
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['events'])
    cancel.release()
    expect(await cancelled).toEqual({ refused: 'attendee_checked_in' })
    expect(await undone).toMatchObject({ answered: { id: booked.sam, checked_in_at: null } })
    expect(await flagRowsOf(booked.sam)).toEqual([['event_attendee.check_in_undone', tia]])
  })

  it("a waiver pressed while its place is being cancelled waits for the cancel on the event's row, and is then refused: nothing is changed on a cancelled place", async () => {
    const booked = await bookedToday()
    const cancel = holdingAfter(first, afterTheCancelsLocks)
    const cancelled = cancelPlaces(cancel.db, booked, [booked.alex])
    const holder = await cancel.holding
    const pressed = outcomeOf(setEventAttendeeWaiver(second, booked.alex, { which: 'standard', accepted: false }, { channel: 'staff', ...pressBy(tia, 'staff') }))
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['events'])
    cancel.release()
    expect(await cancelled).toMatchObject({ answered: { places: 1 } })
    expect(await pressed).toEqual({ refused: 'attendee_cancelled' })
    expect(await place(booked.alex)).toMatchObject({ cancelled: true, waiver_accepted: true })
    expect(await flagRowsOf(booked.alex)).toEqual([])
  })

  it("control: the waiver's own statement without the event held first does not wait for the cancel in progress", async () => {
    const booked = await bookedToday()
    const cancel = holdingAfter(first, afterTheCancelsLocks)
    const cancelled = cancelPlaces(cancel.db, booked, [booked.alex])
    const holder = await cancel.holding
    const statement = waiverStatement(booked.alex, 'standard', false, undefined, null)
    const alone = await finishesWithoutWaitingOn(holder, second.query<{ id: string; waiver_accepted: boolean }>(statement.sql, statement.params))
    expect(alone === 'waited' ? alone : alone.finished.map((row) => [row.id, row.waiver_accepted])).toEqual([[booked.alex, false]])
    cancel.release()
    await cancelled
    // What the hold prevents: a waiver revoked on a place in the moment it was being cancelled, which the cancel never saw.
    expect(await place(booked.alex)).toMatchObject({ cancelled: true, waiver_accepted: false })
  })

  it("the customer channel never locks an event that isn't the customer's: someone else's attendee is refused at once, without waiting for a cancel in progress, and a cancel is never held up by it", async () => {
    const booked = await bookedToday()
    const stranger = await fixtures.customer(first)
    const byCustomer = (customerId: string) => ({ channel: 'customer' as const, customerId, requestId: crypto.randomUUID(), pressKey: crypto.randomUUID() })
    const link = { which: 'standard', accepted: false }
    const sign = { which: 'standard', accepted: true, method: 'email_link' }
    await first.query('UPDATE event_attendees SET waiver_accepted = false, waiver_method = NULL, waiver_version = NULL, waiver_accepted_at = NULL WHERE id = $1', [booked.sam])
    const cancel = holdingAfter(first, afterTheCancelsLocks)
    const cancelled = cancelPlaces(cancel.db, booked, [booked.alex])
    const holder = await cancel.holding
    const outcome = await finishesWithoutWaitingOn(holder, outcomeOf(setEventAttendeeWaiver(second, booked.sam, sign, byCustomer(stranger))))
    // W52a: answered exactly as an attendee that isn't there.
    expect(outcome).toEqual({ finished: { refused: 'attendee_not_found' } })
    // Their own attendee is held, as for staff: the press waits for the cancel.
    const own = outcomeOf(setEventAttendeeWaiver(second, booked.sam, sign, byCustomer(booked.customerId)))
    expect(await finishesWithoutWaitingOn(holder, own)).toBe('waited')
    cancel.release()
    await cancelled
    expect(await own).toMatchObject({ answered: { id: booked.sam, waiver_accepted: true, waiver_method: 'email_link' } })
    expect(await outcomeOf(setEventAttendeeWaiver(second, booked.sam, link, byCustomer(booked.customerId)))).toEqual({ refused: 'customer_cannot_revoke' })
  })
})
