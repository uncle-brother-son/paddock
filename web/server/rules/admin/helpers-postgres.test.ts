import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { flagWrite, type FlagWrite } from './flag'
import { lockAdminRows, SETTINGS_ROW } from './locks'
import { adminRefusal, type AdminActor } from './refusal'
import { adminWrite, WRITES_ONLY_WHAT_WAS_PRESSED, type AdminWrite } from './write'

// Brief W48 item 3, "the lock taken", on real Postgres 17.6, each client on its own connection (PGlite is one
// session and can't show one press waiting for another). Each race holds the first press's transaction open, after
// its write, until Postgres itself reports the second as blocked by it, so none can pass by timing; and each has a
// control showing what goes wrong without the lock.

let pg: RealPostgres
let first: Db
let second: Db
let actor: AdminActor
let serviceType: string
let n = 0

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  const staffId = await insert(first, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: 'w48-race@example.com', can_issue_refunds: true, can_manage_pricing: true })
  actor = { type: 'staff', id: staffId, role: 'admin', canManagePricing: true, canIssueRefunds: true }
  serviceType = await insert(first, 'service_types', { name: 'Sauna', booking_type: 'public' })
})
afterAll(() => pg.stop())

const by = () => ({ actor, requestId: crypto.randomUUID(), pressKey: crypto.randomUUID() })
const newBand = async (): Promise<string> => {
  n += 1
  // A band's code is lower-case letters and underscores only (session_bands_code_check): the count, spelt in letters.
  const letters = String(n).replace(/\d/g, (digit) => 'abcdefghij'[Number(digit)] ?? 'x')
  return insert(first, 'session_bands', { code: `race_${letters}`, name: `Band ${n}`, price: '20.00' })
}
/** A session on its own day: live bookings on different sessions may not overlap, and a customer has one booking a day. */
const newSession = async (band: string): Promise<string> => {
  n += 1
  const day = String(n).padStart(2, '0')
  return insert(first, 'sessions', { service_type_id: serviceType, start_time: `2031-03-${day} 10:00:00+00`, end_time: `2031-03-${day} 11:00:00+00`, type: 'public', capacity: 10, band_id: band })
}
const auditOf = (entityId: string) => first.query<{ details: { before?: { price: string }; after: Record<string, unknown> } }>('SELECT details FROM audit_log WHERE entity_id = $1 ORDER BY at, ctid', [entityId])

/** Waits until Postgres reports some session blocked by `holder`, and answers that session's pid. */
async function sessionBlockedBy(holder: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('The second press never waited on the first.')
}
const backendPid = async (tx: Tx) => (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number

/** A band's price changed by `add`, as one admin write; `locked` false leaves the lock out (the control). `hold` runs after the write, inside the transaction. */
const addToPrice = (band: string, add: number, locked: boolean, hold?: (tx: Tx) => Promise<void>): AdminWrite<{ price: string }, { price: string }, string> => ({
  action: 'pricing.band_price_set',
  needs: 'manage_pricing',
  entity: { type: 'session_band', id: band },
  locks: locked ? [{ table: 'session_bands', ids: [band] }] : [],
  // W54a: the press sends an amount to add, and nothing of the row as a screen read it.
  unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
  async before(tx) {
    const [row] = await tx.query<{ price: string }>('SELECT price::text AS price FROM session_bands WHERE id = $1::uuid', [band])
    if (!row) throw adminRefusal('NOT_FOUND', 'pricing.band_price_set', 'band_not_found', 'That band no longer exists.')
    return row
  },
  async change(tx, before) {
    // What a rule works out from the row it read: here, the new price.
    const [row] = await tx.query<{ price: string }>('UPDATE session_bands SET price = $1, updated_at = now() WHERE id = $2::uuid RETURNING price::text AS price', [Number(before.price) + add, band])
    await hold?.(tx)
    return { after: { price: row?.price ?? '' }, answer: row?.price ?? '' }
  },
})

/** Two presses on one band at once: the first held open after its write until the second is blocked by it. */
async function twoPresses(band: string, locked: boolean): Promise<{ answers: [string, string]; waitedOn: string[] }> {
  const release = deferred()
  let announce: (pid: number) => void = () => {}
  const holding = new Promise<number>((resolve) => {
    announce = resolve
  })
  const one = adminWrite(first, addToPrice(band, 1, locked, async (tx) => {
    announce(await backendPid(tx))
    await release.promise
  }), by())
  const holder = await holding
  const two = adminWrite(second, addToPrice(band, 5, locked), by())
  const waiter = await sessionBlockedBy(holder)
  const waitedOn = await waitingOn(pg, waiter)
  release.resolve()
  return { answers: [await one, await two], waitedOn }
}

describe('the admin write helper takes the lock (real Postgres)', () => {
  it('two presses on one row queue on its lock: the second reads the row after the first has committed, and nothing is lost', async () => {
    const band = await newBand()
    const { answers, waitedOn } = await twoPresses(band, true)
    expect(waitedOn).toEqual(['session_bands'])
    // £20 + £1, then + £5 on what the first left.
    expect(answers).toEqual(['21.00', '26.00'])
    const rows = await auditOf(band)
    expect(rows.map((row) => row.details.before)).toEqual([{ price: '20.00' }, { price: '21.00' }])
    expect(rows.map((row) => row.details.after)).toEqual([{ price: '21.00' }, { price: '26.00' }])
  })

  it('control: without the lock the second press reads the row before the first has committed, and the first press is lost', async () => {
    const band = await newBand()
    const { answers } = await twoPresses(band, false)
    // The second worked from £20: the first's £1 is gone, and its audit row's "before" was never true.
    expect(answers).toEqual(['21.00', '25.00'])
    expect((await auditOf(band)).map((row) => row.details.before)).toEqual([{ price: '20.00' }, { price: '20.00' }])
  })

  it('rows of one table are locked in id order whatever order they are asked for in, so two presses naming the same rows queue and neither deadlocks', async () => {
    const a = await newBand()
    const b = await newBand()
    const [low, high] = [a, b].sort() as [string, string]
    const release = deferred()
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    const one = first.transaction(async (tx) => {
      const held = await lockAdminRows(tx, [{ table: 'session_bands', ids: [high, low] }])
      announce(await backendPid(tx))
      await release.promise
      return held
    })
    const holder = await holding
    const two = second.transaction((tx) => lockAdminRows(tx, [{ table: 'session_bands', ids: [low] }, { table: 'session_bands', ids: [high] }]))
    await sessionBlockedBy(holder)
    release.resolve()
    expect(await one).toEqual({ session_bands: [low, high] })
    expect(await two).toEqual({ session_bands: [low, high] })
  })

  it("an admin row is locked before a session, as LOCK_ORDER has them: a timetable change and a block of its session can't deadlock", async () => {
    const band = await newBand()
    const session = await newSession(band)
    const order: string[] = []
    const watching = (tx: Tx): Tx =>
      new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== 'query') return Reflect.get(target, property, receiver) as unknown
          return (sql: string, params?: readonly never[]) => {
            const table = /^SELECT id FROM (\w+) WHERE id = ANY/.exec(sql)?.[1]
            if (table) order.push(table)
            return target.query(sql, params)
          }
        },
      })
    await first.transaction((tx) => lockAdminRows(watching(tx), [{ table: 'sessions', ids: [session] }, { table: 'session_bands', ids: [band] }, { table: 'service_types', ids: [serviceType] }]))
    expect(order).toEqual(['service_types', 'session_bands', 'sessions'])
  })
})

// W49 + W54 (W48 review S1): the two one-row settings tables, whose id is a boolean. The same shape as the band
// test above, on the membership settings row (W57's; the postage row's is in pricing/admin-postgres.test.ts).
describe('S1: a settings row can be locked through the helper (real Postgres)', () => {
  /** The waiting period changed by `add` months, as one admin write; `locked` false leaves the lock out (the control). */
  const addMonths = (add: number, locked: boolean, hold?: (tx: Tx) => Promise<void>): AdminWrite<{ months: number }, { months: number }, number> => ({
    action: 'membership_settings.set',
    needs: 'manage_pricing',
    entity: { type: 'membership_settings', id: 'membership_settings' },
    locks: locked ? [{ table: 'membership_settings', ids: SETTINGS_ROW }] : [],
    // W54a: the press sends a number of months to add, and nothing of the row as a screen read it.
    unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
    async before(tx) {
      const [row] = await tx.query<{ months: number }>('SELECT addon_credit_wait_months AS months FROM membership_settings WHERE id = true')
      if (!row) throw adminRefusal('CONFLICT', 'membership_settings.set', 'not_set_up', 'Membership settings have not been set up.')
      return row
    },
    async change(tx, before) {
      const [row] = await tx.query<{ months: number }>('UPDATE membership_settings SET addon_credit_wait_months = $1, updated_at = now() WHERE id = true RETURNING addon_credit_wait_months AS months', [before.months + add])
      await hold?.(tx)
      return { after: { months: row?.months ?? -1 }, answer: row?.months ?? -1 }
    },
  })

  async function twoSaves(locked: boolean): Promise<{ answers: [number, number]; waitedOn: string[] }> {
    await first.query('DELETE FROM membership_settings')
    await first.query('INSERT INTO membership_settings (addon_credit_wait_months) VALUES (6)')
    const release = deferred()
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    const one = adminWrite(first, addMonths(1, locked, async (tx) => {
      announce(await backendPid(tx))
      await release.promise
    }), by())
    const holder = await holding
    const two = adminWrite(second, addMonths(5, locked), by())
    const waiter = await sessionBlockedBy(holder)
    const waitedOn = await waitingOn(pg, waiter)
    release.resolve()
    return { answers: [await one, await two], waitedOn }
  }

  it('two saves of the settings row queue on its lock: the second reads what the first left', async () => {
    const { answers, waitedOn } = await twoSaves(true)
    expect(waitedOn).toEqual(['membership_settings'])
    // 6 + 1, then + 5 on what the first left.
    expect(answers).toEqual([7, 12])
    const held = await first.transaction((tx) => lockAdminRows(tx, [{ table: 'postage_settings', ids: SETTINGS_ROW }, { table: 'membership_settings', ids: SETTINGS_ROW }]))
    expect(held.membership_settings).toEqual(['true'])
  })

  it('control: without the lock the second save reads the row before the first has committed, and the first is lost', async () => {
    const { answers } = await twoSaves(false)
    // The second worked from 6: the first's month is gone.
    expect(answers).toEqual([7, 11])
  })
})

/** A booking checked in: the guard refuses a cancelled booking. */
const checkIn = (booking: string): FlagWrite<{ id: string; checked_in: boolean }> => ({
  action: 'booking.checked_in',
  needs: 'staff',
  channels: ['staff'],
  entity: { type: 'booking', id: booking },
  statement: { sql: "UPDATE bookings SET checked_in_at = now(), updated_at = now() WHERE id = $1::uuid AND status <> 'cancelled' RETURNING id, checked_in_at IS NOT NULL AS checked_in", params: [booking] },
  refusal: async () => adminRefusal('CONFLICT', 'booking.checked_in', 'booking_cancelled', 'This booking has been cancelled.'),
})

describe('the flag write helper: the guard is the rule, under a race (real Postgres)', () => {
  const newBooking = async (): Promise<string> => {
    const session = await newSession(await newBand())
    return insert(first, 'bookings', { session_id: session, customer_id: await fixtures.customer(first), party_size: 1, status: 'confirmed', price_paid: '20.00', redemption_source: 'paid' })
  }

  it('a check-in that meets a cancel in progress waits for it, then is refused by its own guard: nothing is written', async () => {
    const booking = await newBooking()
    const release = deferred()
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    const cancel = first.transaction(async (tx) => {
      await tx.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1::uuid", [booking])
      announce(await backendPid(tx))
      await release.promise
    })
    const holder = await holding
    const pressed = flagWrite(second, checkIn(booking), by()).then(
      (row) => ({ answered: row }),
      (err: unknown) => ({ refused: err instanceof ApiError ? String((err.details as { reason?: unknown } | undefined)?.reason) : String(err) })
    )
    const waiter = await sessionBlockedBy(holder)
    expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    release.resolve()
    await cancel
    expect(await pressed).toEqual({ refused: 'booking_cancelled' })
    expect(await first.query('SELECT 1 FROM bookings WHERE id = $1 AND checked_in_at IS NOT NULL', [booking])).toEqual([])
    expect(await auditOf(booking)).toEqual([])
  })

  it('the same check-in when the cancel is rolled back goes through, with its one audit row', async () => {
    const booking = await newBooking()
    const release = deferred()
    let announce: (pid: number) => void = () => {}
    const holding = new Promise<number>((resolve) => {
      announce = resolve
    })
    const cancel = first
      .transaction(async (tx) => {
        await tx.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1::uuid", [booking])
        announce(await backendPid(tx))
        await release.promise
        throw new Error('the cancel is put back')
      })
      .catch(() => 'rolled back')
    const holder = await holding
    const pressed = flagWrite(second, checkIn(booking), by())
    await sessionBlockedBy(holder)
    release.resolve()
    expect(await cancel).toBe('rolled back')
    expect(await pressed).toEqual({ id: booking, checked_in: true })
    expect((await auditOf(booking)).map((row) => row.details.after)).toEqual([{ id: booking, checked_in: true }])
  })
})
