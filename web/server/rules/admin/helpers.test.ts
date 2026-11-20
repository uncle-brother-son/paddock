import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ADMIN_ACTIONS, adminRefusalDetailsSchema, emptyInputSchema } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { STAFF_KEY, staffRequest, testRouteFactory } from '@/server/http/test-helpers'
import { LOCK_ORDER } from '@/server/rules/orders/locks'
import { PRICING_ADMIN_WORDS } from '@/server/rules/pricing/admin-failure-messages'
import { STAFF_ADMIN_WORDS } from '@/server/rules/staff/failure-messages'
import { fixtures, insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { FLAG_CHANNEL_NOT_ACCEPTED_MESSAGE, flagWrite, type FlagWrite } from './flag'
import { ADMIN_LOCK_TABLES, EVERY_ROW, inLockOrder, isUuid, lockAdminRows, SETTINGS_ROW } from './locks'
import { adminRead, namedColumns, ownStaffRow } from './read'
import { adminActor, adminRefusal, requireAdminPermission, type AdminActor } from './refusal'
import { CHANGED_SINCE_REASON, CHANGED_SINCE_WORDS, NO_ROW_STAMP, rowsStamp, rowStampSql, sameStamp } from './stamp'
import { adminWrite, WRITES_ONLY_WHAT_WAS_PRESSED, type AdminWrite } from './write'

// Brief W48 item 3 (G-plan 4.2): the three shared helpers every step G route will be built on, tested on the live
// schema (PGlite) with one example of each kind, through a route made the way the real ones are, so the press key is
// the route's own. The lock itself, with two connections, is in helpers-postgres.test.ts.
//
// The examples are not routes of the app (nothing is switched in W48): a band's price (level B, Manage pricing), a
// booking checked in (level C, any active staff), the staff list (a read, admins only).

let database: TestDatabase
let db: Db
let bandId: string
let bookingId: string
const JO = 'jo@example.com'

beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
})
afterAll(() => database.stop())

beforeEach(async () => {
  await database.pg.exec('RESET ROLE; TRUNCATE audit_log, api_idempotency, bookings, sessions, service_types, session_bands, customers, staff CASCADE; SET ROLE paddock_worker;')
  await insert(db, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: JO, can_issue_refunds: true, can_manage_pricing: true })
  bandId = await insert(db, 'session_bands', { code: 'core', name: 'Core', price: '20.00' })
  const serviceType = await insert(db, 'service_types', { name: 'Sauna', booking_type: 'public' })
  const session = await insert(db, 'sessions', { service_type_id: serviceType, start_time: '2030-01-10 10:00:00+00', end_time: '2030-01-10 11:00:00+00', type: 'public', capacity: 10, band_id: bandId })
  const customer = await fixtures.customer(db)
  bookingId = await insert(db, 'bookings', { session_id: session, customer_id: customer, party_size: 1, status: 'confirmed', price_paid: '20.00', redemption_source: 'paid' })
})

/** One change to Jo's staff row. Test data only: each `set` is a literal in this file, and the email goes in as a parameter. */
// eslint-disable-next-line no-restricted-syntax -- test data only: every `set` is a literal written in this file
const staffIs = (set: string) => db.query(`UPDATE staff SET ${set} WHERE email = $1`, [JO])
const auditRows = () => db.query<{ action: string; actor_id: string | null; entity_type: string; entity_id: string; request_id: string; details: Record<string, unknown> }>('SELECT action, actor_id, entity_type, entity_id, request_id, details FROM audit_log ORDER BY at')
const price = async () => (await db.query<{ price: string }>('SELECT price::text AS price FROM session_bands WHERE id = $1', [bandId]))[0]?.price
const checkedIn = async () => (await db.query<{ checked_in_at: Date | null }>('SELECT checked_in_at FROM bookings WHERE id = $1', [bookingId]))[0]?.checked_in_at !== null

/** The example level B write: one band's price. The old setBandPrice's check and words; the band locked first. */
const bandPrice = (band: string, to: unknown): AdminWrite<{ price: string }, { price: string }, { updated: true; band: { id: string; price: string } }> => ({
  action: 'pricing.band_price_set',
  needs: 'manage_pricing',
  entity: { type: 'session_band', id: band },
  locks: [{ table: 'session_bands', ids: [band] }],
  // W54a: one value set, the price pressed.
  unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
  async before(tx, held) {
    if (!held.session_bands?.includes(band)) throw adminRefusal('NOT_FOUND', 'pricing.band_price_set', 'band_not_found', 'That band no longer exists.')
    const [row] = await tx.query<{ price: string }>('SELECT price::text AS price FROM session_bands WHERE id = $1::uuid', [band])
    return { price: row?.price ?? '' }
  },
  async change(tx) {
    if (typeof to !== 'number' || !Number.isFinite(to) || to < 0) throw adminRefusal('VALIDATION', 'pricing.band_price_set', 'invalid_price', PRICING_ADMIN_WORDS.setBandPrice.priceMustValidNonNegativeAmount)
    const [row] = await tx.query<{ id: string; price: string }>('UPDATE session_bands SET price = $1, updated_at = now() WHERE id = $2::uuid RETURNING id, price::text AS price', [to, band])
    if (!row) throw new Error('The band was locked but not updated.')
    return { after: { price: row.price }, answer: { updated: true, band: row } }
  },
})

/** W54a: a band's stamp as a read would answer it beside the band (admin/stamp.ts). */
const BAND_STAMP_SQL = `SELECT ${rowStampSql('b')} AS stamp FROM session_bands b WHERE b.id = $1::uuid`
const bandStamp = async (band = bandId) => (await db.query<{ stamp: string }>(BAND_STAMP_SQL, [band]))[0]?.stamp
type BandDetails = { name: string; price: string }
/**
 * W54a's example of a write that sends a whole row back: a band's name and price saved together, as a screen
 * showing both would send them, with the stamp its read gave. `ran` counts the times the change itself ran.
 */
const bandDetails = (band: string, to: { name: string; price: number }, seen: unknown, ran = { change: 0 }): AdminWrite<BandDetails, BandDetails, BandDetails & { stamp: string }> => ({
  action: 'pricing.band_price_set',
  needs: 'manage_pricing',
  entity: { type: 'session_band', id: band },
  locks: [{ table: 'session_bands', ids: [band] }],
  unchangedSince: { seen, now: async (tx) => (await tx.query<{ stamp: string }>(BAND_STAMP_SQL, [band]))[0]?.stamp ?? NO_ROW_STAMP },
  async before(tx, held) {
    if (!held.session_bands?.includes(band)) throw adminRefusal('NOT_FOUND', 'pricing.band_price_set', 'band_not_found', 'That band no longer exists.')
    const [row] = await tx.query<BandDetails>('SELECT name, price::text AS price FROM session_bands WHERE id = $1::uuid', [band])
    return row as BandDetails
  },
  async change(tx) {
    ran.change += 1
    // eslint-disable-next-line no-restricted-syntax -- test data only: the stamp is a literal from admin/stamp.ts; the values go in as parameters
    const [row] = await tx.query<BandDetails & { stamp: string }>(`UPDATE session_bands SET name = $1, price = $2, updated_at = now() WHERE id = $3::uuid RETURNING name, price::text AS price, ${rowStampSql('session_bands')} AS stamp`, [to.name, to.price, band])
    if (!row) throw new Error('The band was locked but not updated.')
    return { after: { name: row.name, price: row.price }, answer: row }
  },
})

/** The example level C write: a booking checked in or out. The guard is the rule: not on a cancelled booking. */
const checkIn = (booking: string, to: boolean): FlagWrite<{ id: string; checked_in: boolean }> => ({
  action: 'booking.checked_in',
  needs: 'staff',
  channels: ['staff'],
  entity: { type: 'booking', id: booking },
  statement: {
    sql: "UPDATE bookings SET checked_in_at = CASE WHEN $1::boolean THEN now() ELSE NULL END, updated_at = now() WHERE id = $2::uuid AND status <> 'cancelled' RETURNING id, checked_in_at IS NOT NULL AS checked_in",
    params: [to, booking],
  },
  async refusal(tx: Tx) {
    const [row] = await tx.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1::uuid', [booking])
    return row ? adminRefusal('CONFLICT', 'booking.checked_in', 'booking_cancelled', 'This booking has been cancelled.') : adminRefusal('NOT_FOUND', 'booking.checked_in', 'booking_not_found', 'That booking no longer exists.')
  },
})

/** Each example as a route, made as the app's are: staff auth, the input checked, idempotent, the answer in the envelope. */
function routes() {
  const { defineRoute } = testRouteFactory(db)
  const answer = z.object({ updated: z.literal(true), band: z.object({ id: z.string(), price: z.string() }) })
  return {
    bandPrice: defineRoute({ auth: 'staff', input: z.object({ bandId: z.string(), price: z.unknown() }), output: answer, idempotent: true }, ({ db: routeDb, input, staff, requestId, idempotencyKey }) =>
      adminWrite(routeDb, bandPrice(input.bandId, input.price), { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
    ),
    checkIn: defineRoute({ auth: 'staff', input: z.object({ bookingId: z.string(), checkedIn: z.boolean() }), output: z.object({ id: z.string(), checked_in: z.boolean() }), idempotent: true }, ({ db: routeDb, input, staff, requestId, idempotencyKey }) =>
      flagWrite(routeDb, checkIn(input.bookingId, input.checkedIn), { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
    ),
    staffList: defineRoute({ auth: 'staff', input: emptyInputSchema, output: z.array(z.object({ id: z.string(), email: z.string(), role: z.string(), created_at: z.string() })) }, ({ db: routeDb, staff }) =>
      adminRead(routeDb, { name: 'staff.list', needs: 'admin', sql: `SELECT ${namedColumns('s', ['id', 'email', 'role', 'created_at'])} FROM staff s ORDER BY s.email`, times: ['created_at'] }, { actor: adminActor(staff) })
    ),
  }
}

type Envelope = { ok: boolean; data?: unknown; error?: { code: string; message: string; details?: Record<string, unknown> } }
const key = () => crypto.randomUUID()
async function press(route: (request: Request) => Promise<Response>, body: unknown, pressKey: string | null = key(), method = 'POST'): Promise<{ status: number; body: Envelope }> {
  const headers: Record<string, string> = pressKey === null ? {} : { 'idempotency-key': pressKey }
  const response = await route(staffRequest('/admin-example', method === 'GET' ? { method, headers } : { method, body, headers: { ...headers, 'content-type': 'application/json' } }))
  return { status: response.status, body: (await response.json()) as Envelope }
}

const jo = async (): Promise<AdminActor> => {
  const [row] = await db.query<{ id: string; role: 'admin' | 'manager' | 'staff'; can_manage_pricing: boolean; can_issue_refunds: boolean }>('SELECT id, role, can_manage_pricing, can_issue_refunds FROM staff WHERE email = $1', [JO])
  if (!row) throw new Error('No staff row.')
  return { type: 'staff', id: row.id, role: row.role, canManagePricing: row.can_manage_pricing, canIssueRefunds: row.can_issue_refunds }
}

describe('the admin write helper (level B: one transaction, the lock, the permission, the audit row, the press key)', () => {
  it('the change and its audit row are written together: who, the row before and after, and the key', async () => {
    const pressKey = key()
    const answer = await press(routes().bandPrice, { bandId, price: 22.5 }, pressKey)
    expect(answer).toMatchObject({ status: 200, body: { ok: true, data: { updated: true, band: { id: bandId, price: '22.50' } } } })
    expect(await price()).toBe('22.50')
    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'pricing.band_price_set', actor_id: (await jo()).id, entity_type: 'session_band', entity_id: bandId })
    expect(rows[0]?.details).toEqual({ before: { price: '20.00' }, after: { price: '22.50' }, key: pressKey })
    expect(rows[0]?.request_id).toMatch(/\S/)
  })

  it('the permission is the signed-in staff member\'s own, refused in the old words before anything is read; nothing is written', async () => {
    await staffIs('can_manage_pricing = false')
    const answer = await press(routes().bandPrice, { bandId, price: 22.5 })
    expect(answer).toMatchObject({
      status: 403,
      body: { ok: false, error: { code: 'FORBIDDEN', message: 'You do not have permission to manage pricing (staff.can_manage_pricing is off for your account).', details: { reason: 'no_pricing_permission', action: 'pricing.band_price_set' } } },
    })
    expect(adminRefusalDetailsSchema.safeParse(answer.body.error?.details).success).toBe(true)
    expect(await price()).toBe('20.00')
    expect(await auditRows()).toEqual([])
    // A switch the screen sends changes nothing: the actor comes from the staff row.
    await expect(adminWrite(db, bandPrice(bandId, 22.5), { actor: { ...(await jo()), canManagePricing: false }, requestId: 'r', pressKey: key() })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // The admin role is asked for in its own old words; an active staff member needs nothing more.
    const manager: AdminActor = { ...(await jo()), role: 'manager' }
    expect(() => requireAdminPermission(manager, 'admin', 'staff.role_set')).toThrow('Admins only — this action requires the admin role.')
    expect(() => requireAdminPermission({ ...manager, canManagePricing: false }, 'staff', 'session.blocked')).not.toThrow()
    expect(STAFF_ADMIN_WORDS.staffAccess.adminsOnlyActionRequiresAdminRole).toBe('Admins only — this action requires the admin role.')
  })

  it('an inactive staff member and a sign-in with no staff row are refused by the route before the rule runs', async () => {
    await staffIs('active = false')
    expect(await press(routes().bandPrice, { bandId, price: 22.5 })).toMatchObject({ status: 403, body: { error: { message: 'This staff account is inactive. Ask an admin to reactivate it.' } } })
    await staffIs("active = true, email = 'someone.else@example.com'")
    expect(await press(routes().bandPrice, { bandId, price: 22.5 })).toMatchObject({ status: 401, body: { error: { code: 'UNAUTHORISED' } } })
    expect(await db.query('SELECT 1 FROM audit_log')).toEqual([])
    expect(await price()).toBe('20.00')
  })

  it('a refused write leaves nothing: the old check\'s words, no change, no audit row', async () => {
    for (const bad of [-1, 'ten', null]) {
      const answer = await press(routes().bandPrice, { bandId, price: bad })
      expect(answer).toMatchObject({ status: 400, body: { ok: false, error: { code: 'VALIDATION', message: 'Price must be a valid non-negative amount.', details: { reason: 'invalid_price' } } } })
    }
    expect(await press(routes().bandPrice, { bandId: '10000000-0000-4000-8000-00000000dead', price: 5 })).toMatchObject({ status: 404, body: { error: { details: { reason: 'band_not_found' } } } })
    expect(await price()).toBe('20.00')
    expect(await auditRows()).toEqual([])
  })

  it('a change that fails after its write is rolled back with its audit row: neither is kept', async () => {
    const failing: AdminWrite<{ price: string }, { price: string }, never> = {
      ...bandPrice(bandId, 30),
      async change(tx) {
        await tx.query('UPDATE session_bands SET price = 30 WHERE id = $1::uuid', [bandId])
        throw adminRefusal('CONFLICT', 'pricing.band_price_set', 'changed', 'It changed.')
      },
    }
    await expect(adminWrite(db, failing, { actor: await jo(), requestId: 'r', pressKey: key() })).rejects.toBeInstanceOf(ApiError)
    expect(await price()).toBe('20.00')
    expect(await auditRows()).toEqual([])
  })

  it('the same press made again is answered from the stored answer: one change, one audit row', async () => {
    const pressKey = key()
    const first = await press(routes().bandPrice, { bandId, price: 22.5 }, pressKey)
    // Someone else changes the price in between: a second run of the write would overwrite it, and its answer's row would differ.
    await db.query("UPDATE session_bands SET price = '25.00' WHERE id = $1", [bandId])
    const again = await press(routes().bandPrice, { bandId, price: 22.5 }, pressKey)
    expect(again).toEqual(first)
    expect(await price()).toBe('25.00')
    expect(await auditRows()).toHaveLength(1)
    // The same key with something else asked is refused, not run.
    expect(await press(routes().bandPrice, { bandId, price: 99 }, pressKey)).toMatchObject({ status: 422, body: { error: { code: 'IDEMPOTENCY_MISMATCH' } } })
    expect(await auditRows()).toHaveLength(1)
    // A new press under a new key is a new change, with its own row.
    await press(routes().bandPrice, { bandId, price: 26 })
    expect(await price()).toBe('26.00')
    expect((await auditRows()).map((row) => row.details['after'])).toEqual([{ price: '22.50' }, { price: '26.00' }])
  })

  it('a route with no key is refused before the rule runs, and the helper itself refuses to run without one', async () => {
    expect(await press(routes().bandPrice, { bandId, price: 22.5 }, null)).toMatchObject({ status: 400, body: { error: { code: 'VALIDATION' } } })
    await expect(adminWrite(db, bandPrice(bandId, 22.5), { actor: await jo(), requestId: 'r', pressKey: null })).rejects.toThrow('was run without a press key')
    await expect(adminWrite(db, bandPrice(bandId, 22.5), { actor: await jo(), requestId: 'r', pressKey: '' })).rejects.toThrow('was run without a press key')
    expect(await price()).toBe('20.00')
    expect(await auditRows()).toEqual([])
  })

  it('the rows are locked before the row is read, in the same transaction as the change', async () => {
    const seen: string[] = []
    const watching = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
        return <T>(work: (tx: Tx) => Promise<T>) =>
          target.transaction((tx) =>
            work(
              new Proxy(tx, {
                get(inner, name, innerReceiver) {
                  if (name !== 'query') return Reflect.get(inner, name, innerReceiver) as unknown
                  return (sql: string, params?: readonly never[]) => {
                    seen.push(sql.replace(/\s+/g, ' ').trim())
                    return inner.query(sql, params)
                  }
                },
              })
            )
          )
      },
    })
    await adminWrite(watching, bandPrice(bandId, 21), { actor: await jo(), requestId: 'r', pressKey: key() })
    expect(seen).toHaveLength(4)
    expect(seen[0]).toBe('SELECT id FROM session_bands WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE')
    expect(seen[1]).toMatch(/^SELECT price::text AS price FROM session_bands/)
    expect(seen[2]).toMatch(/^UPDATE session_bands SET price/)
    expect(seen[3]).toMatch(/^INSERT INTO audit_log/)
  })
})

// W54a (W49 + W54 review S1; the lead's call, 20 Nov: one step G rule). An edit that writes a whole row is refused
// when the row has changed since the screen read it. The rule lives in the helper, so every later slice's write gets
// it: the write says what the press sent and how to read the row's stamp now, and the helper compares them under the
// lock. The real rules' own tests are in pricing/ and promo/ admin.test.ts; the lock, on real Postgres, in their
// admin-postgres.test.ts.
describe('the admin write helper: a whole-row edit from a page loaded before someone else\'s change is refused (W54a)', () => {
  const by = async () => ({ actor: await jo(), requestId: 'r', pressKey: key() })
  const band = async () => (await db.query<{ name: string; price: string }>('SELECT name, price::text AS price FROM session_bands WHERE id = $1', [bandId]))[0]

  it('the words and the reason are these, and fit the refusal details every step G route answers', () => {
    expect(CHANGED_SINCE_WORDS).toBe('This was changed by someone else since the page loaded. The page has been reloaded: check it and save again.')
    expect(CHANGED_SINCE_REASON).toBe('changed_since')
  })

  it('a press with the stamp the row has now is saved and recorded; one with the stamp from before someone else\'s change is refused: the change never runs, nothing is written, no audit row', async () => {
    const pageA = await bandStamp()
    const pageB = await bandStamp()
    // B renames the band.
    const b = await adminWrite(db, bandDetails(bandId, { name: 'Core (weekday)', price: 20 }, pageB), await by())
    expect(b).toMatchObject({ name: 'Core (weekday)', price: '20.00' })
    expect(await auditRows()).toHaveLength(1)

    // A, whose page still shows "Core", changes the price: A's save would put the old name back.
    const ran = { change: 0 }
    const refused = await adminWrite(db, bandDetails(bandId, { name: 'Core', price: 22 }, pageA, ran), await by()).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(ApiError)
    expect(refused).toMatchObject({ code: 'CONFLICT', status: 409, message: CHANGED_SINCE_WORDS, details: { reason: 'changed_since', message: CHANGED_SINCE_WORDS, action: 'pricing.band_price_set' } })
    expect(adminRefusalDetailsSchema.safeParse((refused as ApiError).details).success).toBe(true)
    expect(ran.change).toBe(0)
    expect(await band()).toEqual({ name: 'Core (weekday)', price: '20.00' })
    expect(await auditRows()).toHaveLength(1)

    // With the stamp B's answer carried (what a reload gives A), A's price is saved beside B's name.
    expect(b.stamp).toBe(await bandStamp())
    await adminWrite(db, bandDetails(bandId, { name: 'Core (weekday)', price: 22 }, b.stamp, ran), await by())
    expect(ran.change).toBe(1)
    expect(await band()).toEqual({ name: 'Core (weekday)', price: '22.00' })
    expect((await auditRows()).map((row) => row.details['after'])).toEqual([{ name: 'Core (weekday)', price: '20.00' }, { name: 'Core (weekday)', price: '22.00' }])
  })

  it('a press that sent no stamp, or anything that is not the text the read gave, is refused the same way', async () => {
    const stamp = await bandStamp()
    const ran = { change: 0 }
    for (const seen of [undefined, null, '', 0, true, [stamp], { stamp }, `${stamp} `, String(stamp).toUpperCase(), NO_ROW_STAMP]) {
      await expect(adminWrite(db, bandDetails(bandId, { name: 'Other', price: 1 }, seen, ran), await by()), JSON.stringify(seen)).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'changed_since' } })
    }
    expect(ran.change).toBe(0)
    expect(await band()).toEqual({ name: 'Core', price: '20.00' })
    expect(await auditRows()).toEqual([])
  })

  it("the row's own refusal comes first (a row that is not there), and the permission before anything is read", async () => {
    const stamp = await bandStamp()
    await expect(adminWrite(db, bandDetails('10000000-0000-4000-8000-00000000dead', { name: 'x', price: 1 }, stamp), await by())).rejects.toMatchObject({ details: { reason: 'band_not_found' } })
    await expect(adminWrite(db, bandDetails(bandId, { name: 'x', price: 1 }, 'stale'), { ...(await by()), actor: { ...(await jo()), canManagePricing: false } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('the stamp is read under the lock: after the rows are locked and the row read, before the change, in the same transaction', async () => {
    const seen: string[] = []
    const watching = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
        return <T>(work: (tx: Tx) => Promise<T>) =>
          target.transaction((tx) =>
            work(
              new Proxy(tx, {
                get(inner, name, innerReceiver) {
                  if (name !== 'query') return Reflect.get(inner, name, innerReceiver) as unknown
                  return (sql: string, params?: readonly never[]) => {
                    seen.push(sql.replace(/\s+/g, ' ').trim())
                    return inner.query(sql, params)
                  }
                },
              })
            )
          )
      },
    })
    await adminWrite(watching, bandDetails(bandId, { name: 'Core', price: 21 }, await bandStamp()), await by())
    expect(seen).toHaveLength(5)
    expect(seen[0]).toBe('SELECT id FROM session_bands WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE')
    expect(seen[1]).toMatch(/^SELECT name, price::text AS price FROM session_bands/)
    expect(seen[2]).toMatch(/AS stamp FROM session_bands b WHERE b\.id = \$1::uuid$/)
    expect(seen[3]).toMatch(/^UPDATE session_bands SET name/)
    expect(seen[4]).toMatch(/^INSERT INTO audit_log/)
    // A stale press stops after the stamp: no write statement is sent at all.
    seen.length = 0
    await adminWrite(watching, bandDetails(bandId, { name: 'Core', price: 30 }, 'stale'), await by()).catch(() => undefined)
    expect(seen).toHaveLength(3)
    expect(seen.some((sql) => /^(UPDATE|INSERT|DELETE)/.test(sql))).toBe(false)
  })

  it('refused through a route as a 409 the staff app reads the reason from, and stored against its key like any other answer', async () => {
    const { defineRoute } = testRouteFactory(db)
    const route = defineRoute({ auth: 'staff', input: z.object({ bandId: z.string(), name: z.string(), price: z.number(), stamp: z.unknown().optional() }), output: z.object({ name: z.string(), price: z.string(), stamp: z.string() }), idempotent: true }, ({ db: routeDb, input, staff, requestId, idempotencyKey }) =>
      adminWrite(routeDb, bandDetails(input.bandId, { name: input.name, price: input.price }, input.stamp), { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
    )
    const stale = await bandStamp()
    await db.query("UPDATE session_bands SET name = 'Core (weekday)' WHERE id = $1", [bandId])
    const pressKey = key()
    const refused = await press(route, { bandId, name: 'Core', price: 22, stamp: stale }, pressKey)
    expect(refused).toMatchObject({ status: 409, body: { ok: false, error: { code: 'CONFLICT', message: CHANGED_SINCE_WORDS, details: { reason: 'changed_since', message: CHANGED_SINCE_WORDS, action: 'pricing.band_price_set' } } } })
    expect(await press(route, { bandId, name: 'Core', price: 22, stamp: stale }, pressKey)).toEqual(refused)
    expect(await press(route, { bandId, name: 'Core', price: 22 })).toMatchObject({ status: 409, body: { error: { details: { reason: 'changed_since' } } } })
    const saved = await press(route, { bandId, name: 'Core (weekday)', price: 22, stamp: await bandStamp() })
    expect(saved).toMatchObject({ status: 200, body: { data: { name: 'Core (weekday)', price: '22.00' } } })
    expect(await auditRows()).toHaveLength(1)
  })
})

describe('the stamp (W54a, admin/stamp.ts)', () => {
  it("a row's stamp is its updated_at to the microsecond in UTC, then a fingerprint of the whole row; the same on every read until the row changes", async () => {
    const first = await bandStamp()
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z#[0-9a-f]{32}$/)
    expect(await bandStamp()).toBe(first)
    // The moment is the row's own, to the microsecond and in UTC, whatever the connection's time zone. (A promo code:
    // its table has no trigger that would move the moment written here.)
    await database.pg.exec('RESET ROLE; TRUNCATE promo_codes CASCADE; SET ROLE paddock_worker;')
    const promo = await insert(db, 'promo_codes', { code: 'WELCOME', discount_type: 'percentage', discount_value: '100', applies_to: ['booking'], updated_at: '2026-11-20 10:30:00.123456+00' })
    const PROMO_STAMP_SQL = `SELECT ${rowStampSql('pc')} AS stamp FROM promo_codes pc WHERE pc.id = $1`
    const here = (await db.query<{ stamp: string }>(PROMO_STAMP_SQL, [promo]))[0]?.stamp
    expect(here?.split('#')[0]).toBe('2026-11-20T10:30:00.123456Z')
    await db.transaction(async (tx) => {
      await tx.query("SET LOCAL TIME ZONE 'Pacific/Auckland'")
      expect((await tx.query<{ stamp: string }>(PROMO_STAMP_SQL, [promo]))[0]?.stamp.split('#')[0]).toBe('2026-11-20T10:30:00.123456Z')
    })
  })

  it('any change to the row changes it, even one that leaves updated_at where it was; a row put back exactly as it was has its old stamp again', async () => {
    // A table with no updated_at trigger (promo_codes), changed by hand as a correction in SQL might be.
    await database.pg.exec('RESET ROLE; TRUNCATE promo_codes CASCADE; SET ROLE paddock_worker;')
    const promo = await insert(db, 'promo_codes', { code: 'WELCOME', discount_type: 'percentage', discount_value: '100', applies_to: ['booking'], updated_at: '2026-10-01 09:00:00+00' })
    // eslint-disable-next-line no-restricted-syntax -- test data only: the stamp is a literal from admin/stamp.ts
    const stampNow = async () => (await db.query<{ stamp: string }>(`SELECT ${rowStampSql('pc')} AS stamp FROM promo_codes pc WHERE pc.id = $1`, [promo]))[0]?.stamp as string
    const before = await stampNow()
    const changes = ["discount_value = 10", "active = false", "expires_on = '2027-01-01'", "max_total_uses = 5", "applies_to = ARRAY['booking','event']", "description = 'x'", "min_spend = 20", 'one_use_per_customer = true', 'applies_on_member_prices = true']
    const seen = new Set([before])
    for (const change of changes) {
      await database.pg.exec(`RESET ROLE; UPDATE promo_codes SET ${change}; SET ROLE paddock_worker;`)
      const now = await stampNow()
      expect(now.split('#')[0], change).toBe(before.split('#')[0])
      expect(seen.has(now), change).toBe(false)
      seen.add(now)
    }
    await database.pg.exec("RESET ROLE; UPDATE promo_codes SET discount_value = 100, active = true, expires_on = NULL, max_total_uses = NULL, applies_to = ARRAY['booking'], description = NULL, min_spend = NULL, one_use_per_customer = false, applies_on_member_prices = false; SET ROLE paddock_worker;")
    expect(await stampNow()).toBe(before)
    // The moment alone changes it too.
    await database.pg.exec("RESET ROLE; UPDATE promo_codes SET updated_at = '2026-10-01 09:00:00.000001+00'; SET ROLE paddock_worker;")
    expect(await stampNow()).not.toBe(before)
  })

  it("a set of rows' stamp is each row's id and stamp in id order, whatever order they were read in; no rows has its own stamp, which no press can send by leaving the stamp out", () => {
    const a = { id: '10000000-0000-4000-8000-00000000000a', stamp: 's1' }
    const b = { id: '20000000-0000-4000-8000-00000000000b', stamp: 's2' }
    expect(rowsStamp([a, b])).toBe(`${a.id}@s1,${b.id}@s2`)
    expect(rowsStamp([b, a])).toBe(rowsStamp([a, b]))
    expect(rowsStamp([a])).not.toBe(rowsStamp([a, b]))
    expect(rowsStamp([{ ...a, stamp: 's3' }, b])).not.toBe(rowsStamp([a, b]))
    expect(rowsStamp([])).toBe(NO_ROW_STAMP)
    expect(NO_ROW_STAMP).toBe('none')
    // What was read is not reordered.
    const read = [b, a]
    rowsStamp(read)
    expect(read).toEqual([b, a])
  })

  it('two stamps are the same only as the same text', () => {
    expect(sameStamp('s1', 's1')).toBe(true)
    for (const seen of [undefined, null, '', 's2', 'S1', ' s1', 1, ['s1'], { toString: () => 's1' }]) expect(sameStamp(seen, 's1'), String(seen)).toBe(false)
    // An empty stamp is never the same as anything, even an empty one.
    expect(sameStamp('', '')).toBe(false)
  })
})

describe('the admin locks (G-plan 4.2 item 2)', () => {
  it("step G's own rows come first in LOCK_ORDER; a row a money transaction also locks keeps its place", () => {
    expect(LOCK_ORDER[0]).toBe('admin_row')
    expect(LOCK_ORDER.indexOf('session')).toBe(5)
    expect(LOCK_ORDER.indexOf('session')).toBeGreaterThan(LOCK_ORDER.indexOf('booking'))
    expect(LOCK_ORDER.indexOf('session')).toBeGreaterThan(LOCK_ORDER.indexOf('customer'))
    for (const name of Object.values(ADMIN_LOCK_TABLES)) expect(LOCK_ORDER).toContain(name)
    expect(ADMIN_LOCK_TABLES).toMatchObject({ staff: 'admin_row', membership_plans: 'admin_row', service_types: 'admin_row', band_rules: 'admin_row', sessions: 'session', events: 'event', promo_codes: 'promo_code', product_variants: 'product_variants', customer_memberships: 'membership' })
  })

  it('locks are taken in LOCK_ORDER whatever order they are asked for in, each table once, its ids in id order', () => {
    const b = '20000000-0000-4000-8000-00000000000b'
    const a = '10000000-0000-4000-8000-00000000000a'
    expect(inLockOrder([{ table: 'customer_memberships', ids: [b] }, { table: 'sessions', ids: [b, a] }, { table: 'membership_plans', ids: [a] }, { table: 'sessions', ids: [a] }, { table: 'service_types', ids: [b] }])).toEqual([
      { table: 'service_types', ids: [b] },
      { table: 'membership_plans', ids: [a] },
      { table: 'sessions', ids: [a, b] },
      { table: 'customer_memberships', ids: [b] },
    ])
    // A plan before its memberships; a service type before the sessions a timetable change reaches; a promo code before a session.
    const order = inLockOrder([{ table: 'events', ids: [a] }, { table: 'product_variants', ids: [a] }, { table: 'promo_codes', ids: [a] }, { table: 'sessions', ids: [a] }, { table: 'staff', ids: [a] }]).map((lock) => lock.table)
    expect(order).toEqual(['staff', 'promo_codes', 'sessions', 'product_variants', 'events'])
  })

  it('answers the rows that exist, by table; an id with no row is not among them', async () => {
    const missing = '10000000-0000-4000-8000-00000000dead'
    const held = await db.transaction((tx) => lockAdminRows(tx, [{ table: 'session_bands', ids: [missing, bandId] }, { table: 'staff', ids: [] }]))
    expect(held).toEqual({ staff: [], session_bands: [bandId] })
  })

  // W49 + W54 (W48 review S1).
  it('S1: the two one-row settings tables can be locked: their row is held, by `id = true`, and they are admin rows', async () => {
    expect(ADMIN_LOCK_TABLES).toMatchObject({ postage_settings: 'admin_row', membership_settings: 'admin_row' })
    await database.pg.exec("RESET ROLE; DELETE FROM postage_settings; DELETE FROM membership_settings; INSERT INTO postage_settings DEFAULT VALUES; INSERT INTO membership_settings DEFAULT VALUES; SET ROLE paddock_worker;")
    const seen: string[] = []
    const held = await db.transaction((tx) =>
      lockAdminRows(
        new Proxy(tx, {
          get(inner, property, receiver) {
            if (property !== 'query') return Reflect.get(inner, property, receiver) as unknown
            return (sql: string, params?: readonly never[]) => {
              seen.push(sql)
              return inner.query(sql, params)
            }
          },
        }),
        [{ table: 'membership_settings', ids: SETTINGS_ROW }, { table: 'postage_settings', ids: SETTINGS_ROW }]
      )
    )
    expect(held).toEqual({ postage_settings: ['true'], membership_settings: ['true'] })
    // No cast and no parameter: the statement names the one row there can be.
    expect(seen).toEqual(['SELECT id FROM postage_settings WHERE id = true FOR NO KEY UPDATE', 'SELECT id FROM membership_settings WHERE id = true FOR NO KEY UPDATE'])
    // A table with no row holds nothing, and so does a settings table asked for anything but its row.
    await database.pg.exec('RESET ROLE; DELETE FROM postage_settings; SET ROLE paddock_worker;')
    expect(await db.transaction((tx) => lockAdminRows(tx, [{ table: 'postage_settings', ids: SETTINGS_ROW }, { table: 'membership_settings', ids: ['false'] }]))).toEqual({ postage_settings: [], membership_settings: [] })
  })

  it("a table's guard: every row, in id order; a guard beside named rows of the same table is the guard", async () => {
    const second = await insert(db, 'session_bands', { code: 'peak', name: 'Peak', price: '25.00' })
    const held = await db.transaction((tx) => lockAdminRows(tx, [{ table: 'session_bands', ids: [bandId] }, { table: 'session_bands', ids: EVERY_ROW }]))
    expect(held).toEqual({ session_bands: [bandId, second].sort() })
    expect(inLockOrder([{ table: 'sessions', ids: [bandId] }, { table: 'staff', ids: EVERY_ROW }, { table: 'staff', ids: [bandId] }])).toEqual([{ table: 'staff', ids: EVERY_ROW }, { table: 'sessions', ids: [bandId] }])
  })

  it('an id that is not a uuid names no row: it is left out of the lock, never a failed cast', async () => {
    const held = await db.transaction((tx) => lockAdminRows(tx, [{ table: 'session_bands', ids: ['not-an-id', bandId, ''] }, { table: 'staff', ids: ['42'] }]))
    expect(held).toEqual({ staff: [], session_bands: [bandId] })
    expect(isUuid(bandId)).toBe(true)
    for (const not of ['', 'not-an-id', `${bandId}x`, null, 7]) expect(isUuid(not), String(not)).toBe(false)
  })
})

describe('the flag write helper (level C: one guarded statement, an audit row, a key per call)', () => {
  it('sets the flag and writes one audit row with who and the flag as set', async () => {
    const pressKey = key()
    expect(await press(routes().checkIn, { bookingId, checkedIn: true }, pressKey)).toMatchObject({ status: 200, body: { ok: true, data: { id: bookingId, checked_in: true } } })
    expect(await checkedIn()).toBe(true)
    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'booking.checked_in', actor_id: (await jo()).id, entity_type: 'booking', entity_id: bookingId, details: { after: { id: bookingId, checked_in: true }, key: pressKey } })
  })

  it('the guard is the rule: a refusal is read in the same transaction and nothing is written', async () => {
    await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId])
    expect(await press(routes().checkIn, { bookingId, checkedIn: true })).toMatchObject({ status: 409, body: { ok: false, error: { code: 'CONFLICT', details: { reason: 'booking_cancelled', action: 'booking.checked_in' } } } })
    expect(await press(routes().checkIn, { bookingId: '10000000-0000-4000-8000-00000000dead', checkedIn: true })).toMatchObject({ status: 404, body: { error: { details: { reason: 'booking_not_found' } } } })
    expect(await checkedIn()).toBe(false)
    expect(await auditRows()).toEqual([])
  })

  it('a permission is refused in the old words before the statement runs', async () => {
    const needsPricing: FlagWrite<{ id: string; checked_in: boolean }> = { ...checkIn(bookingId, true), needs: 'manage_pricing' }
    await expect(flagWrite(db, needsPricing, { actor: { ...(await jo()), canManagePricing: false }, requestId: 'r', pressKey: key() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission to manage pricing (staff.can_manage_pricing is off for your account).',
    })
    expect(await checkedIn()).toBe(false)
    expect(await auditRows()).toEqual([])
    // Every flag today needs only an active staff member: someone with no switch at all may set one.
    await staffIs("role = 'staff', can_manage_pricing = false, can_issue_refunds = false")
    expect(await press(routes().checkIn, { bookingId, checkedIn: true })).toMatchObject({ status: 200 })
    await staffIs('active = false')
    expect(await press(routes().checkIn, { bookingId, checkedIn: false })).toMatchObject({ status: 403 })
    expect(await checkedIn()).toBe(true)
  })

  it('the same call made again is answered from the stored answer: the flag is not set a second time, and one audit row', async () => {
    const pressKey = key()
    const first = await press(routes().checkIn, { bookingId, checkedIn: true }, pressKey)
    // Checked out again by someone else in between: a second run would check the booking back in.
    await db.query('UPDATE bookings SET checked_in_at = NULL WHERE id = $1', [bookingId])
    expect(await press(routes().checkIn, { bookingId, checkedIn: true }, pressKey)).toEqual(first)
    expect(await checkedIn()).toBe(false)
    expect(await auditRows()).toHaveLength(1)
    // Each call of a switch has its own key: in, then out, are two calls and two rows.
    await press(routes().checkIn, { bookingId, checkedIn: true })
    await press(routes().checkIn, { bookingId, checkedIn: false })
    expect((await auditRows()).map((row) => (row.details['after'] as { checked_in: boolean }).checked_in)).toEqual([true, true, false])
  })

  it('refuses to run without a key, and refuses a statement that changes more than one row', async () => {
    await expect(flagWrite(db, checkIn(bookingId, true), { actor: await jo(), requestId: 'r', pressKey: null })).rejects.toThrow('was run without a key')
    expect(await press(routes().checkIn, { bookingId, checkedIn: true }, null)).toMatchObject({ status: 400 })
    const session = (await db.query<{ session_id: string; customer_id: string }>('SELECT session_id, customer_id FROM bookings WHERE id = $1', [bookingId]))[0]
    const other = await fixtures.customer(db)
    await insert(db, 'bookings', { session_id: session?.session_id, customer_id: other, party_size: 1, status: 'confirmed', price_paid: '20.00', redemption_source: 'paid' })
    const every: FlagWrite<{ id: string }> = { ...checkIn(bookingId, true), statement: { sql: 'UPDATE bookings SET checked_in_at = now() RETURNING id', params: [] } } as unknown as FlagWrite<{ id: string }>
    await expect(flagWrite(db, every, { actor: await jo(), requestId: 'r', pressKey: key() })).rejects.toThrow('changed 2 rows')
    expect(await db.query('SELECT 1 FROM bookings WHERE checked_in_at IS NOT NULL')).toEqual([])
    expect(await auditRows()).toEqual([])
  })

  // Brief W50a item 4b (W50 review L6b): the permission is only checked for staff, so a flag must say who else may set it.
  it('W50a: a flag is refused from a channel it does not accept, at the start: before the key, the permission and any statement', async () => {
    const customer = { type: 'customer' as const, id: (await db.query<{ customer_id: string }>('SELECT customer_id FROM bookings WHERE id = $1', [bookingId]))[0]?.customer_id ?? '' }
    const refusedChannel = { code: 'FORBIDDEN', message: FLAG_CHANNEL_NOT_ACCEPTED_MESSAGE, details: { reason: 'channel_not_accepted', action: 'booking.checked_in' } }
    // A client that fails the test if the flag asks anything of the database.
    const watched = new Proxy(db, {
      get(inner, property, receiver) {
        if (property === 'transaction' || property === 'query') return () => Promise.reject(new Error(`The flag reached the database (${String(property)}), which a refused channel never should.`))
        return Reflect.get(inner, property, receiver) as unknown
      },
    })
    // Staff only (every flag but a guest's waiver): a customer is refused, with a key and without one, and even on a
    // flag that needs a switch the customer could never be asked for.
    await expect(flagWrite(watched, checkIn(bookingId, true), { actor: customer, requestId: 'r', pressKey: key() })).rejects.toMatchObject(refusedChannel)
    await expect(flagWrite(watched, checkIn(bookingId, true), { actor: customer, requestId: 'r', pressKey: null })).rejects.toMatchObject(refusedChannel)
    await expect(flagWrite(watched, { ...checkIn(bookingId, true), needs: 'manage_pricing' }, { actor: customer, requestId: 'r', pressKey: key() })).rejects.toMatchObject(refusedChannel)
    // A flag that accepts no channel at all runs for nobody.
    await expect(flagWrite(watched, { ...checkIn(bookingId, true), channels: [] }, { actor: await jo(), requestId: 'r', pressKey: key() })).rejects.toMatchObject(refusedChannel)
    // A customer-only flag refuses staff the same way.
    await expect(flagWrite(watched, { ...checkIn(bookingId, true), channels: ['customer'] }, { actor: await jo(), requestId: 'r', pressKey: key() })).rejects.toMatchObject(refusedChannel)
    expect(await checkedIn()).toBe(false)
    expect(await auditRows()).toEqual([])

    // A flag that says it accepts a customer runs for one, and the audit row says the customer did it.
    await flagWrite(db, { ...checkIn(bookingId, true), channels: ['staff', 'customer'] }, { actor: customer, requestId: 'r', pressKey: key() })
    expect(await checkedIn()).toBe(true)
    expect(await db.query('SELECT actor_type, actor_id, action FROM audit_log')).toEqual([{ actor_type: 'customer', actor_id: customer.id, action: 'booking.checked_in' }])
  })
})

describe('the read helper (an active staff member; admin for the staff list; named columns; L10)', () => {
  const get = () => press(routes().staffList, undefined, null, 'GET')

  it('answers an admin the named columns, each moment as ISO text', async () => {
    const answer = await get()
    expect(answer.status).toBe(200)
    const rows = answer.body.data as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0] ?? {})).toEqual(['id', 'email', 'role', 'created_at'])
    expect(rows[0]?.['created_at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('a moment the driver gives as a date is answered as ISO text; a column not named as a moment is left as it is', async () => {
    // The test database's driver already gives text, so this is asked of the helper itself, with a driver that gives dates.
    const at = new Date('2030-01-10T10:00:00.000Z')
    const driver = { query: async () => [{ id: 'a', starts_at: at, ends_at: null, made: at }] } as unknown as Db
    const rows = await adminRead<{ id: string; starts_at: unknown; ends_at: unknown; made: unknown }>(driver, { name: 'events.list', needs: 'staff', sql: 'SELECT e.id, e.starts_at, e.ends_at, e.created_at AS made FROM events e', times: ['starts_at', 'ends_at'] }, { actor: await jo() })
    expect(rows).toEqual([{ id: 'a', starts_at: '2030-01-10T10:00:00.000Z', ends_at: null, made: at }])
  })

  it('the staff list is refused to anyone but an admin, in the old words', async () => {
    await staffIs("role = 'manager'")
    expect(await get()).toMatchObject({ status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Admins only — this action requires the admin role.', details: { reason: 'admins_only', action: 'staff.list' } } } })
  })

  it('GB14: an inactive staff member and a sign-in with no staff row read nothing (none of the 30 old reads checked)', async () => {
    await staffIs('active = false')
    expect(await get()).toMatchObject({ status: 403, body: { error: { message: 'This staff account is inactive. Ask an admin to reactivate it.' } } })
    await staffIs("active = true, email = 'someone.else@example.com'")
    expect(await get()).toMatchObject({ status: 401 })
    // And with no key at all.
    const { staffList } = routes()
    const noKey = await staffList(new Request('https://worker.test/admin-example', { headers: { 'x-staff-email': JO } }))
    expect(noKey.status).toBe(401)
    expect(STAFF_KEY).toMatch(/\S/)
  })

  it('any other read needs only an active staff member', async () => {
    await staffIs("role = 'staff', can_manage_pricing = false, can_issue_refunds = false")
    const rows = await adminRead<{ id: string; price: string }>(db, { name: 'pricing.bands', needs: 'staff', sql: `SELECT ${namedColumns('b', ['id', 'price'], ['price'])} FROM session_bands b`, params: [] }, { actor: await jo() })
    expect(rows).toEqual([{ id: bandId, price: '20.00' }])
  })

  it('named columns, never `*`: a statement that reads every column is refused before it runs', async () => {
    const actor = await jo()
    for (const sql of ['SELECT * FROM staff', 'SELECT s.* FROM staff s', 'select b.*, s.start_time from bookings b join sessions s on s.id = b.session_id', 'SELECT s.id,\n       s.*\nFROM staff s', 'UPDATE staff SET active = true RETURNING *']) {
      await expect(adminRead(db, { name: 'staff.list', needs: 'staff', sql }, { actor }), sql).rejects.toThrow('selects every column')
    }
    // count(*) and arithmetic are not "every column".
    expect(await adminRead(db, { name: 'staff.count', needs: 'staff', sql: 'SELECT count(*)::int AS n, 2 * 3 AS six FROM staff s' }, { actor })).toEqual([{ n: 1, six: 6 }])
    expect(namedColumns('s', ['id', 'price', 'starts_on'], ['price', 'starts_on'])).toBe('s.id, s.price::text AS price, s.starts_on::text AS starts_on')
  })

  it("L10: a staff member's own row is answered whether they are active or not, and nobody else's; null for an email with no row", async () => {
    expect(await ownStaffRow(db, JO)).toMatchObject({ email: JO, role: 'admin', can_issue_refunds: true, can_manage_pricing: true, active: true })
    await staffIs('active = false')
    const inactive = await ownStaffRow(db, JO)
    expect(inactive).toMatchObject({ email: JO, active: false })
    expect(Object.keys(inactive ?? {})).toEqual(['id', 'email', 'role', 'can_issue_refunds', 'can_manage_pricing', 'active'])
    expect(await ownStaffRow(db, 'nobody@example.com')).toBeNull()
    // W49 (GB16): the sign-in finds its row in lower case, as the staff check does (one lookup for both).
    expect(await ownStaffRow(db, 'JO@Example.com')).toMatchObject({ email: JO, active: false })
    // Every other route still refuses an inactive member.
    expect(await press(routes().staffList, undefined, null, 'GET')).toMatchObject({ status: 403 })
  })
})

describe("step G's audit actions (G-plan 4.6)", () => {
  // W50 (the brief's names): 40. Undoing a check-in is its own action (`booking.check_in_undone`), and the prepared
  // tick is the booking's (`booking.addon_prepared_set`, in place of W48's `addon_line.prepared_set`, which no route
  // had written).
  it('names the 40 actions a step G write records, each once, as noun.verb', () => {
    expect(ADMIN_ACTIONS).toHaveLength(40)
    expect(new Set(ADMIN_ACTIONS).size).toBe(40)
    for (const action of ADMIN_ACTIONS) expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/)
    expect(ADMIN_ACTIONS).toEqual(expect.arrayContaining(['staff.created', 'catalog.price_set', 'stock.adjusted', 'plan.price_change', 'membership.price_moved', 'session.blocked', 'timetable.slot_added', 'booking.checked_in', 'booking.check_in_undone', 'booking.guest_waiver_set', 'booking.addon_prepared_set', 'order_line.fulfilled_set']))
    expect(ADMIN_ACTIONS as readonly string[]).not.toContain('addon_line.prepared_set')
  })
})
