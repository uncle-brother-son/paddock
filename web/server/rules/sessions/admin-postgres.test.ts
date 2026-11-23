import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { isDeadlock, type Db } from '@/server/db'
import { lockForOrder } from '@/server/rules/orders/locks'
import { setBandRules } from '@/server/rules/pricing/admin'
import { getPricingConfig } from '@/server/rules/pricing/pricing-config'
import { holdingAfter, outcomeOf, pressBy, sessionBlockedBy } from '@/server/rules/testing/admin-race'
import { fixtures, insert } from '@/server/rules/testing/database'
import { generatorFromFile032Sql } from '@/server/rules/testing/migration-032'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { blockDay, blockSession, createOneOffSession, oneOffSessionQuote, resetSessionBand, setSessionBand, setSessionStartTime, unblockDay } from './admin'

// Brief W51 items 5, 6, 8 and 9 ("Parity and tests": the two races; G-plan 4.9 item 7): the session races on real
// Postgres 17.6, each press on its own connection. The first press is the rule itself, held open inside its
// transaction until Postgres reports the second as blocked by it, so none can pass by timing.
//  - W51-1: a one-off session, a start-time change and a band reset each made while a band-window save is held get
//    the NEW band (they wait on the band guard); without the guard the session keeps the old one.
//  - W48 review L1: Block Day, Unblock Day and a day's band change against a band-window save on the same day, each
//    way round: one waits for the other, and neither is stopped with a deadlock.
//  - GB5 and GB6 (the session's place in LOCK_ORDER): a block and a start-time change against a new booking on the
//    same session. The booking is placed as an order places it (the order's own lock, then the booking); the press
//    waits on the session and is then refused. Without the lock the block lands with the booking on it.
//  - W51a (W51 review L4): a band set by hand while that band is being switched off waits on the band's row.
//  - W51a (closed dates): Block Day, Unblock Day and a one-off session against the nightly job, and each other, on
//    the date's lock. Whichever gets there first, the day never ends closed with an open session on it. Without
//    the lock it does. (A Move in flight against a block, and the refund undo: move-in-flight-postgres.test.ts.)

let pg: RealPostgres
let first: Db
let second: Db
let reader: Db
let jo = ''
let sam = ''
let core = ''
let peak = ''
let sauna = ''

const SATURDAY = 6
// 1 March 2031 is a Saturday; 8 March the next.
const SAT = '2031-03-01'
const NEXT_SAT = '2031-03-08'
/** Two sessions on the Saturday. The one with the higher id starts earlier, so a scan by start time meets it first: the opposite of id order. */
const LOW = '10000000-0000-4000-8000-00000000a001'
const HIGH = '10000000-0000-4000-8000-00000000b001'
const SESSION_LOCK = 'SELECT id FROM sessions WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE'

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  reader = pg.connect()
  jo = await insert(first, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: 'w51-race@example.com', can_issue_refunds: true, can_manage_pricing: true })
  sam = await fixtures.customer(first, { first_name: 'Sam', last_name: 'Test', email: 'w51-sam@example.com' })
  core = await insert(first, 'session_bands', { code: 'core', name: 'Core', price: '20.00' })
  peak = await insert(first, 'session_bands', { code: 'peak', name: 'Peak', price: '25.50' })
  sauna = await insert(first, 'service_types', { name: 'Sauna', booking_type: 'public', duration: 60, capacity: 10 })
}, 120_000)
afterAll(() => pg.stop())

/** Core until 17:00 and Peak after, every day; the two Saturday sessions (13:00 and 14:00), both Core and open. */
beforeEach(async () => {
  await first.query('DELETE FROM audit_log')
  await first.query('DELETE FROM bookings')
  await first.query('DELETE FROM sessions')
  await first.query('DELETE FROM closed_dates')
  await first.query('UPDATE session_bands SET active = true')
  await first.query('DELETE FROM band_rules')
  for (let day = 0; day <= 6; day++) {
    await insert(first, 'band_rules', { band_id: core, day_of_week: day, from_time: '00:00', to_time: '17:00' })
    await insert(first, 'band_rules', { band_id: peak, day_of_week: day, from_time: '17:00', to_time: '24:00' })
  }
  await insert(first, 'sessions', { id: HIGH, service_type_id: sauna, start_time: `${SAT} 13:00:00+00`, end_time: `${SAT} 14:00:00+00`, type: 'public', capacity: 10, band_id: core })
  await insert(first, 'sessions', { id: LOW, service_type_id: sauna, start_time: `${SAT} 14:00:00+00`, end_time: `${SAT} 15:00:00+00`, type: 'public', capacity: 10, band_id: core })
})

/** Saturday re-cut at noon: 12:00 onwards is Peak, so the 13:00 and 14:00 sessions move from Core to Peak. */
const atNoon = () => [{ bandId: core, fromTime: '00:00', toTime: '12:00' }, { bandId: peak, fromTime: '12:00', toTime: '24:00' }]
const dayStamp = async () => (await getPricingConfig(reader, true)).bandRulesStamps[SATURDAY]
const bandOf = async (session: string) => {
  const band = (await first.query<{ band_id: string | null }>('SELECT band_id FROM sessions WHERE id = $1', [session]))[0]?.band_id
  return band === core ? 'core' : band === peak ? 'peak' : band
}
const stateOf = async (session: string) => (await first.query<{ status: string; band_overridden: boolean; start: string }>("SELECT status, band_overridden, to_char(start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS start FROM sessions WHERE id = $1", [session]))[0]
/** A band-window save, held open after everything it writes (the day's windows replaced, the sessions re-banded), still uncommitted. */
const heldSave = async () => {
  const held = holdingAfter(first, (sql) => sql.startsWith('SELECT reassign_session_bands'))
  const save = outcomeOf(setBandRules(held.db, SATURDAY, atNoon(), await dayStamp(), pressBy(jo)))
  return { save, holder: await held.holding, release: held.release }
}

/** The stamp the one-off dialog would hold for a Sauna at this time, as the Worker answers it now (W68, Q58). */
const shownFor = async (startTime: string) => (await oneOffSessionQuote(reader, sauna, startTime, { actor: pressBy(jo).actor })).stamp

describe('W51-1: a session written while a band-window save is in progress', () => {
  it("a one-off session pressed during the save waits on the band guard; the band it was shown (Core) is no longer the one it would get, so it is refused (W68, Q58) and nothing is made; shown again, it is made in the NEW band", async () => {
    const shown = await shownFor(`${NEXT_SAT}T13:00:00.000Z`)
    const { save, holder, release } = await heldSave()
    // Next Saturday at 13:00: Core by the old windows, Peak by the ones the save is leaving.
    const refused = outcomeOf(createOneOffSession(second, sauna, `${NEXT_SAT}T13:00:00.000Z`, shown, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['session_bands'])
    // Nothing of it is written while it waits.
    expect(await first.query('SELECT id FROM sessions')).toHaveLength(2)
    release()
    expect(await save).toMatchObject({ answered: { saved: true, rebandedSessions: 2 } })
    expect(await refused).toEqual({ refused: 'changed_since' })
    expect(await first.query('SELECT id FROM sessions')).toHaveLength(2)
    const made = (await outcomeOf(createOneOffSession(second, sauna, `${NEXT_SAT}T13:00:00.000Z`, await shownFor(`${NEXT_SAT}T13:00:00.000Z`), pressBy(jo)))) as { answered: { created: boolean; session: { id: string } } }
    expect(made.answered.created).toBe(true)
    expect(await bandOf(made.answered.session.id)).toBe('peak')
  })

  it("a one-off session pressed during a save that leaves its time's band as it was waits, and is made in the band it was shown", async () => {
    const shown = await shownFor(`${NEXT_SAT}T10:00:00.000Z`)
    const { save, holder, release } = await heldSave()
    const created = outcomeOf(createOneOffSession(second, sauna, `${NEXT_SAT}T10:00:00.000Z`, shown, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['session_bands'])
    release()
    expect(await save).toMatchObject({ answered: { saved: true } })
    const made = (await created) as { answered: { session: { id: string } } }
    expect(await bandOf(made.answered.session.id)).toBe('core')
  })

  it('control: the same insert without the guard does not wait, reads the old windows, and keeps the OLD band after the save commits', async () => {
    const { save, holder, release } = await heldSave()
    // The old createOneOffSession's own statement, with nothing two writers queue on.
    const [made] = await second.query<{ id: string }>(
      "INSERT INTO sessions (service_type_id, start_time, end_time, type, capacity, status) VALUES ($1, $2::timestamptz, $2::timestamptz + interval '60 minutes', 'public', 10, 'open') RETURNING id",
      [sauna, `${NEXT_SAT}T13:00:00.000Z`]
    )
    // It was never blocked: it is already committed while the save is still open.
    expect((await pg.admin.unsafe('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])).length).toBe(0)
    release()
    expect(await save).toMatchObject({ answered: { saved: true, rebandedSessions: 2 } })
    // The save's windows say Peak from noon, and this 13:00 session is Core: W51-1 as it was. Sold at GBP 20, not 25.50.
    expect(await bandOf(made?.id as string)).toBe('core')
    expect((await first.query<{ wrong: number }>("SELECT count(*)::int AS wrong FROM sessions WHERE type = 'public' AND NOT band_overridden AND band_id IS DISTINCT FROM band_for_session_start(start_time)"))[0]?.wrong).toBe(1)
  })

  it('a start-time change made during the save waits on the band guard, and the band it gets is by the new windows', async () => {
    // A session at 10:00 next Saturday (Core either way), moved to 13:00: Core by the old windows, Peak by the new.
    const session = await insert(first, 'sessions', { service_type_id: sauna, start_time: `${NEXT_SAT} 10:00:00+00`, end_time: `${NEXT_SAT} 11:00:00+00`, type: 'public', capacity: 10, band_id: core })
    const { save, holder, release } = await heldSave()
    const moved = outcomeOf(setSessionStartTime(second, session, `${NEXT_SAT}T13:00:00.000Z`, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['session_bands'])
    release()
    expect(await save).toMatchObject({ answered: { saved: true } })
    expect(await moved).toMatchObject({ answered: { updated: true, band: { code: 'peak', overridden: false } } })
    expect(await bandOf(session)).toBe('peak')
  })

  it('a band reset made during the save waits on the band guard, and resets to the band the new windows give', async () => {
    // Set by hand to Peak, at 13:00 next Saturday: a reset gives Core by the old windows, Peak by the new.
    const session = await insert(first, 'sessions', { service_type_id: sauna, start_time: `${NEXT_SAT} 13:00:00+00`, end_time: `${NEXT_SAT} 14:00:00+00`, type: 'public', capacity: 10, band_id: core, band_overridden: true })
    const { save, holder, release } = await heldSave()
    const reset = outcomeOf(resetSessionBand(second, session, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['session_bands'])
    release()
    expect(await save).toMatchObject({ answered: { saved: true } })
    expect(await reset).toEqual({ answered: { reset: true, band: { code: 'peak', name: 'Peak' } } })
    expect(await bandOf(session)).toBe('peak')
  })

  it('a save that starts while a one-off session is being made waits for it, then re-bands what it made', async () => {
    const held = holdingAfter(first, (sql) => sql.startsWith('INSERT INTO sessions'))
    const created = outcomeOf(createOneOffSession(held.db, sauna, `${NEXT_SAT}T13:00:00.000Z`, await shownFor(`${NEXT_SAT}T13:00:00.000Z`), pressBy(jo)))
    const holder = await held.holding
    const save = outcomeOf(setBandRules(second, SATURDAY, atNoon(), await dayStamp(), pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['session_bands'])
    held.release()
    const made = (await created) as { answered: { session: { id: string } } }
    // The new session was Core when it was made; the save, which waited, sees it and moves it with the other two.
    expect(await save).toMatchObject({ answered: { saved: true, rebandedSessions: 3 } })
    expect(await bandOf(made.answered.session.id)).toBe('peak')
  })
})

describe('W48 review L1: the day presses against a band-window save on the same day never deadlock', () => {
  const statuses = async () => (await first.query<{ status: string }>('SELECT status FROM sessions ORDER BY id')).map((row) => row.status)
  const notDeadlocked = <T>(press: Promise<T>) => press.catch((err: unknown) => (isDeadlock(err) ? ('deadlock' as const) : Promise.reject(err)))

  it('Block Day pressed while a save holds the day\'s sessions waits for it, and both go through', async () => {
    const { save, holder, release } = await heldSave()
    const blocked = notDeadlocked(outcomeOf(blockDay(second, SAT, 'Staff day', { toBlock: 2, alreadyBlocked: 0 }, pressBy(jo))))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['sessions'])
    release()
    expect(await save).toMatchObject({ answered: { saved: true, rebandedSessions: 2 } })
    expect(await blocked).toMatchObject({ answered: { blocked: true, blockedCount: 2 } })
    expect(await statuses()).toEqual(['blocked', 'blocked'])
    expect([await bandOf(LOW), await bandOf(HIGH)]).toEqual(['peak', 'peak'])
  })

  it('a save pressed while Block Day holds the day\'s sessions waits for it, and both go through', async () => {
    // Block Day, held open straight after it has locked both sessions (in id order).
    const held = holdingAfter(first, (sql) => sql === SESSION_LOCK)
    const blocked = notDeadlocked(outcomeOf(blockDay(held.db, SAT, 'Staff day', { toBlock: 2, alreadyBlocked: 0 }, pressBy(jo))))
    const holder = await held.holding
    const save = notDeadlocked(outcomeOf(setBandRules(second, SATURDAY, atNoon(), await dayStamp(), pressBy(jo))))
    // The save holds the band guard and waits for the sessions it would re-band: it holds none of them yet.
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['sessions'])
    held.release()
    expect(await blocked).toMatchObject({ answered: { blocked: true, blockedCount: 2 } })
    expect(await save).toMatchObject({ answered: { saved: true, rebandedSessions: 2 } })
    expect(await statuses()).toEqual(['blocked', 'blocked'])
  })

  it('Unblock Day and a day\'s band change take the same locks in the same order: each waits for a held save, and none deadlocks', async () => {
    await blockDay(first, SAT, 'Staff day', { toBlock: 2, alreadyBlocked: 0 }, pressBy(jo))
    const one = await heldSave()
    const unblocked = notDeadlocked(outcomeOf(unblockDay(second, SAT, { blockedSessions: 2, blockedBefore: 0, closedDates: 1 }, pressBy(jo))))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, one.holder))).toEqual(['sessions'])
    one.release()
    expect(await one.save).toMatchObject({ answered: { saved: true } })
    expect(await unblocked).toMatchObject({ answered: { confirmed: true, unblocked: 2 } })

    // The day's band set by hand to Core, against a save that would re-band the same sessions back to Core at 17:00.
    const held = holdingAfter(first, (sql) => sql.startsWith('SELECT reassign_session_bands'))
    const back = [{ bandId: core, fromTime: '00:00', toTime: '17:00' }, { bandId: peak, fromTime: '17:00', toTime: '24:00' }]
    const save = notDeadlocked(outcomeOf(setBandRules(held.db, SATURDAY, back, await dayStamp(), pressBy(jo))))
    const holder = await held.holding
    const byHand = notDeadlocked(outcomeOf(setSessionBand(second, { date: SAT }, peak, { sessionsAffected: 2, bookingsAffected: 0 }, pressBy(jo))))
    // W51a (W51 review L4): the press holds its band's row first (FOR SHARE), which the save holds with every other
    // band's: so it waits there, before any session, the order the save takes them in.
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['session_bands'])
    held.release()
    expect(await save).toMatchObject({ answered: { saved: true, rebandedSessions: 2 } })
    expect(await byHand).toMatchObject({ answered: { confirmed: true, sessionsAffected: 2 } })
    // Set by hand last: both Peak, and the day's windows no longer move them.
    expect([await bandOf(LOW), await bandOf(HIGH)]).toEqual(['peak', 'peak'])
    expect((await stateOf(LOW))?.band_overridden).toBe(true)
  })
})

describe('GB5 and GB6: a new booking against a block or a start-time change on the same session', () => {
  /**
   * A booking placed as an order places it: the order's own locks first (the customer, then the session: LOCK_ORDER),
   * then the booking and its places. Held open, uncommitted, until `release()`.
   */
  const heldBooking = (status = 'confirmed') => {
    const gate = deferred()
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    const placed = first.transaction(async (tx) => {
      const held = await lockForOrder(tx, { customerId: sam, promoCode: null, sessionId: LOW, creditMembershipId: null, sessionPassId: null, addonMembershipIds: [], productVariantIds: [], eventId: null, giftCardId: null })
      expect(held?.sessionId).toBe(LOW)
      await tx.query(
        "INSERT INTO bookings (session_id, customer_id, party_size, price_paid, status, redemption_source, start_time, end_time) VALUES ($1, $2, 1, 20, $3, 'paid', $4::timestamptz, $5::timestamptz)",
        [LOW, sam, status, `${SAT} 14:00:00+00`, `${SAT} 15:00:00+00`]
      )
      await tx.query('UPDATE sessions SET total_booked = total_booked + 1 WHERE id = $1', [LOW])
      announce((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
      await gate.promise
    })
    return { holding, placed, release: gate.resolve }
  }

  it.each(['confirmed', 'payment_needed'])('a block pressed while a %s booking is being placed waits on the session, then is refused with the booking listed: the session stays open', async (status) => {
    const booking = heldBooking(status)
    const holder = await booking.holding
    const blocked = blockSession(second, LOW, 'Staff training', pressBy(jo)).then(
      () => 'blocked',
      (err: unknown) => (err as { details?: { reason?: string; conflictingBookings?: unknown[] } }).details
    )
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['sessions'])
    booking.release()
    await booking.placed
    const refused = (await blocked) as { reason?: string; conflictingBookings?: Array<{ status: string }> }
    expect(refused.reason).toBe('bookings_in_the_way')
    expect(refused.conflictingBookings?.map((row) => row.status)).toEqual([status])
    expect((await stateOf(LOW))?.status).toBe('open')
  })

  it('Block Day pressed while a booking is being placed on one of the day\'s sessions waits, then is refused: no session of the day is blocked', async () => {
    const booking = heldBooking()
    const holder = await booking.holding
    const blocked = outcomeOf(blockDay(second, SAT, 'Staff day', { toBlock: 2, alreadyBlocked: 0 }, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['sessions'])
    booking.release()
    await booking.placed
    expect(await blocked).toEqual({ refused: 'bookings_in_the_way' })
    expect([(await stateOf(LOW))?.status, (await stateOf(HIGH))?.status]).toEqual(['open', 'open'])
  })

  it("control: the old block's two statements with no lock (read the bookings, then block) land the block on a session with a booking", async () => {
    const booking = heldBooking()
    await booking.holding
    // The old check: no confirmed booking is visible (the order hasn't committed), so it goes ahead.
    const seen = await second.query("SELECT b.id FROM bookings b WHERE b.session_id = $1 AND b.status = 'confirmed'", [LOW])
    expect(seen).toEqual([])
    booking.release()
    await booking.placed
    // Then its block, a statement of its own: nothing stops it.
    await second.query("UPDATE sessions SET status = 'blocked', blocked_reason = 'Staff training', blocked_by = $1, updated_at = now() WHERE id = $2", [jo, LOW])
    const [left] = await first.query<{ status: string; bookings: number }>("SELECT s.status, (SELECT count(*)::int FROM bookings b WHERE b.session_id = s.id AND b.status <> 'cancelled') AS bookings FROM sessions s WHERE s.id = $1", [LOW])
    // GB5 as it was: a blocked session with a live booking on it.
    expect(left).toEqual({ status: 'blocked', bookings: 1 })
  })

  it('a block that got there first makes the order wait on the session', async () => {
    const held = holdingAfter(first, (sql) => sql.startsWith('UPDATE sessions'))
    const blocked = outcomeOf(blockSession(held.db, LOW, 'Staff training', pressBy(jo)))
    const holder = await held.holding
    const order = second.transaction(async (tx) => {
      await lockForOrder(tx, { customerId: sam, promoCode: null, sessionId: LOW, creditMembershipId: null, sessionPassId: null, addonMembershipIds: [], productVariantIds: [], eventId: null, giftCardId: null })
      // What the order's facts then read, after the wait: the session as the block left it.
      return (await tx.query<{ status: string }>('SELECT status FROM sessions WHERE id = $1', [LOW]))[0]?.status
    })
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['sessions'])
    held.release()
    expect(await blocked).toMatchObject({ answered: { blocked: true } })
    expect(await order).toBe('blocked')
  })

  it('GB6: a start-time change pressed while a Payment needed booking is being placed waits on the session, then is refused: the session keeps its time and its band', async () => {
    const booking = heldBooking('payment_needed')
    const holder = await booking.holding
    const moved = outcomeOf(setSessionStartTime(second, LOW, `${SAT}T18:00:00.000Z`, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['sessions'])
    booking.release()
    await booking.placed
    expect(await moved).toEqual({ refused: 'session_has_bookings' })
    expect((await stateOf(LOW))?.start).toBe(`${SAT} 14:00`)
    expect(await bandOf(LOW)).toBe('core')
  })
})

describe('W51a (W51 review L4): the band a press sets by hand is read and held inside its transaction', () => {
  /** A band being switched off (an update of `active`), held open, uncommitted. */
  const heldSwitchOff = async () => {
    const gate = deferred()
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    const done = first.transaction(async (tx) => {
      await tx.query('UPDATE session_bands SET active = false WHERE id = $1', [peak])
      announce((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
      await gate.promise
    })
    return { holder: await holding, release: gate.resolve, done }
  }

  it('a band set by hand while that band is being switched off waits on the band, holding no session yet, and is refused once the switch-off commits: the session keeps its band', async () => {
    const off = await heldSwitchOff()
    const press = outcomeOf(setSessionBand(second, { sessionId: LOW }, peak, { sessionsAffected: 1, bookingsAffected: 0 }, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, off.holder))).toEqual(['session_bands'])
    // It waits before it has any session (the band's row comes first in the lock order): the session's lock is free.
    expect(await reader.query('SELECT id FROM sessions WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [LOW])).toHaveLength(1)
    off.release()
    await off.done
    expect(await press).toEqual({ refused: 'band_not_found' })
    expect(await bandOf(LOW)).toBe('core')
    expect((await stateOf(LOW))?.band_overridden).toBe(false)
  })

  it("control: W51's order (the band read before the transaction, unlocked; then the write) goes through during the switch-off, and the session ends on a band that is off", async () => {
    const off = await heldSwitchOff()
    // W51's check, a statement of its own: the switch-off isn't committed, so the band still reads as on.
    expect(await second.query('SELECT id, code, name FROM session_bands WHERE id = $1::uuid AND active = true', [peak])).toHaveLength(1)
    // Then the press's write. It doesn't wait either: its foreign key takes FOR KEY SHARE on the band, which an update of `active` lets through.
    await second.query('UPDATE sessions s SET band_id = $1::uuid, band_overridden = true, updated_at = now() WHERE s.id = ANY($2::uuid[])', [peak, [LOW]])
    off.release()
    await off.done
    expect((await first.query<{ n: number }>('SELECT count(*)::int AS n FROM sessions s JOIN session_bands b ON b.id = s.band_id WHERE NOT b.active'))[0]?.n).toBe(1)
  })

  it("why FOR SHARE and not the review's FOR KEY SHARE: read FOR KEY SHARE during the switch-off, the band answers at once as still on", async () => {
    const off = await heldSwitchOff()
    // Not blocked, and it reads the row as it was: a press that held only this would go on to write the band.
    expect(await second.query('SELECT id FROM session_bands WHERE id = $1::uuid AND active = true FOR KEY SHARE', [peak])).toHaveLength(1)
    expect((await pg.admin.unsafe('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [off.holder])).length).toBe(0)
    off.release()
    await off.done
  })
})

describe("W51a (closed dates): Block Day, Unblock Day and a one-off session against the nightly job, and each other, on the date's lock", () => {
  const day = async (days: number) => (await pg.admin.unsafe<{ d: string }[]>("SELECT ((now() AT TIME ZONE 'Europe/London')::date + $1::int)::text AS d", [days]))[0]?.d as string
  const runJob = async (db: Db = second) => Number((await db.query<{ n: number }>('SELECT public.generate_upcoming_sessions() AS n'))[0]?.n)
  const sessionDays = async () => (await first.query<{ d: string }>("SELECT (start_time AT TIME ZONE 'UTC')::date::text AS d FROM sessions ORDER BY start_time")).map((row) => row.d)
  const statusesOn = async (date: string) => (await first.query<{ status: string }>("SELECT status FROM sessions WHERE (start_time AT TIME ZONE 'UTC')::date = $1::date ORDER BY start_time", [date])).map((row) => row.status)
  const closed = async () => (await first.query<{ d: string }>('SELECT closed_on::text AS d FROM closed_dates ORDER BY closed_on')).map((row) => row.d)
  /** Migration 032's standing check 8: an open session on a closed date still to come. */
  const openOnClosedDates = async () =>
    (
      await first.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM sessions s JOIN closed_dates c ON c.closed_on = (s.start_time AT TIME ZONE 'UTC')::date WHERE s.status = 'open' AND c.closed_on >= (now() AT TIME ZONE 'Europe/London')::date"
      )
    )[0]?.n
  const nothingToBlock = { toBlock: 0, alreadyBlocked: 0 }

  /**
   * The job as the migration FILE has it (so a fault planted in the file is caught here); a weekly slot at 10:00 every
   * day, so each day the job makes is one session; and the job's date at today + 95, so a run makes days 96, 97 and 98.
   */
  beforeEach(async () => {
    await pg.admin.unsafe(generatorFromFile032Sql())
    // Only the sessions these tests make: the file's two Saturday sessions go.
    await first.query('DELETE FROM sessions')
    await first.query('DELETE FROM service_type_schedule_slots')
    for (let dow = 0; dow <= 6; dow++) await insert(first, 'service_type_schedule_slots', { service_type_id: sauna, day_of_week: dow, start_time: '10:00' })
    await pg.admin.unsafe("DELETE FROM public.sessions_made_up_to; INSERT INTO public.sessions_made_up_to (made_up_to) VALUES ((now() AT TIME ZONE 'Europe/London')::date + 95);")
  })

  it('a date closed beyond "made up to" by Block Day, then the job run past it: no session that day, the next day\'s made; Unblock Day reopens it and the next run makes it', async () => {
    const christmas = await day(97)
    expect(await blockDay(first, christmas, 'Closed for Christmas', nothingToBlock, pressBy(jo))).toMatchObject({ blocked: true, blockedCount: 0, closedDate: true })
    expect(await runJob()).toBe(2)
    expect(await sessionDays()).toEqual([await day(96), await day(98)])
    expect(await runJob()).toBe(0)
    // Reopened: the job has already passed the date, and goes back for it on its next run.
    expect(await unblockDay(first, christmas, { blockedSessions: 0, blockedBefore: 0, closedDates: 1 }, pressBy(jo))).toMatchObject({ confirmed: true, closedDateRemoved: true })
    expect(await runJob()).toBe(1)
    expect(await sessionDays()).toEqual([await day(96), christmas, await day(98)])
    expect(await statusesOn(christmas)).toEqual(['open'])
    expect(await runJob()).toBe(0)
  })

  it("Block Day first: held open with the date recorded as closed, the job waits on the date's lock, then makes the other days and none on the closed date", async () => {
    const christmas = await day(97)
    const held = holdingAfter(first, (sql) => sql.startsWith('INSERT INTO closed_dates'))
    const blocked = outcomeOf(blockDay(held.db, christmas, 'Closed for Christmas', nothingToBlock, pressBy(jo)))
    const holder = await held.holding
    let finished = false
    const job = runJob().finally(() => {
      finished = true
    })
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['advisory'])
    expect(finished).toBe(false)
    expect(await sessionDays()).toEqual([])
    held.release()
    expect(await blocked).toMatchObject({ answered: { blocked: true, blockedCount: 0, closedDate: true } })
    expect(await job).toBe(2)
    expect(await sessionDays()).toEqual([await day(96), await day(98)])
    expect(await closed()).toEqual([christmas])
    expect(await openOnClosedDates()).toBe(0)
  })

  it("the job first: held open with the day's session made, Block Day waits on the date's lock; its figures are no longer right (a slot it didn't show), so it closes nothing; pressed again with the new figures it blocks that session and closes the date", async () => {
    const christmas = await day(97)
    const gate = deferred()
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    // The job, on its own connection, stopped after everything it writes, uncommitted.
    const job = first.transaction(async (tx) => {
      await tx.query('SELECT public.generate_upcoming_sessions()')
      announce((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
      await gate.promise
    })
    const holder = await holding
    // The dialog was opened before the job ran: it showed no slot on the day.
    const blocked = outcomeOf(blockDay(second, christmas, 'Closed for Christmas', nothingToBlock, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['advisory'])
    gate.resolve()
    await job
    expect(await blocked).toEqual({ refused: 'changed_since' })
    expect(await closed()).toEqual([])
    expect(await statusesOn(christmas)).toEqual(['open'])
    // With the figures as they now are: the session the job made is blocked, and the date closed. Never one without the other.
    expect(await blockDay(second, christmas, 'Closed for Christmas', { toBlock: 1, alreadyBlocked: 0 }, pressBy(jo))).toMatchObject({ blockedCount: 1, closedDate: true })
    expect(await statusesOn(christmas)).toEqual(['blocked'])
    expect(await closed()).toEqual([christmas])
    expect(await openOnClosedDates()).toBe(0)
  })

  it("control: without the date's lock (Block Day's own statements with no lock, and the job with its lock line taken out) the job doesn't wait, makes the day, and the date is then closed with an open session on it", async () => {
    const christmas = await day(97)
    const lockLine = generatorFromFile032Sql()
      .split('\n')
      .filter((line) => line.includes('pg_advisory_xact_lock'))
    expect(lockLine).toHaveLength(1)
    await pg.admin.unsafe(generatorFromFile032Sql().replace(`${lockLine[0] as string}\n`, ''))
    const gate = deferred()
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    // Block Day with no lock for the date: it reads the day's sessions (none), then records the closed date.
    const press = first.transaction(async (tx) => {
      expect(await tx.query("SELECT s.id FROM sessions s WHERE (s.start_time AT TIME ZONE 'UTC')::date = $1::date", [christmas])).toEqual([])
      await tx.query('INSERT INTO closed_dates (closed_on, reason, closed_by) VALUES ($1::date, $2, $3::uuid) ON CONFLICT (closed_on) DO NOTHING RETURNING closed_on', [christmas, 'Closed for Christmas', jo])
      announce((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
      await gate.promise
    })
    const holder = await holding
    // The job is never blocked: it can't see the closed date (not committed), and makes all three days.
    expect(await runJob()).toBe(3)
    expect((await pg.admin.unsafe('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])).length).toBe(0)
    gate.resolve()
    await press
    // Closed, with an open, bookable session on it: what the lock is for.
    expect(await closed()).toEqual([christmas])
    expect(await statusesOn(christmas)).toEqual(['open'])
    expect(await openOnClosedDates()).toBe(1)
  })

  it("a one-off session pressed while Block Day holds the date waits on the date's lock and is then refused: none is made on the closed date; the other way round, Block Day waits and finds the session", async () => {
    const christmas = await day(200)
    const shown = await shownFor(`${christmas}T13:00:00.000Z`)
    const held = holdingAfter(first, (sql) => sql.startsWith('INSERT INTO closed_dates'))
    const blocked = outcomeOf(blockDay(held.db, christmas, 'Closed for Christmas', nothingToBlock, pressBy(jo)))
    const holder = await held.holding
    const created = outcomeOf(createOneOffSession(second, sauna, `${christmas}T13:00:00.000Z`, shown, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['advisory'])
    held.release()
    expect(await blocked).toMatchObject({ answered: { closedDate: true } })
    expect(await created).toEqual({ refused: 'date_closed' })
    expect(await statusesOn(christmas)).toEqual([])

    // The other way: the one-off first, held open with its session written; Block Day on that date waits for it.
    const boxingDay = await day(201)
    const making = holdingAfter(first, (sql) => sql.startsWith('INSERT INTO sessions'))
    const made = outcomeOf(createOneOffSession(making.db, sauna, `${boxingDay}T13:00:00.000Z`, await shownFor(`${boxingDay}T13:00:00.000Z`), pressBy(jo)))
    const maker = await making.holding
    const closing = outcomeOf(blockDay(second, boxingDay, 'Closed', nothingToBlock, pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, maker))).toEqual(['advisory'])
    making.release()
    expect(await made).toMatchObject({ answered: { created: true } })
    // It sees the session the one-off made (its figures showed none), so it closes nothing until pressed with the new ones.
    expect(await closing).toEqual({ refused: 'changed_since' })
    expect(await closed()).toEqual([christmas])
    expect(await openOnClosedDates()).toBe(0)
  })
})
