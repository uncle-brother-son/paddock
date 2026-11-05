import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { driverOptions } from '@/server/db/postgres-driver'
import { findDuplicateDayBooking } from '@/server/rules/pricing/band-pricing'
import { fixtures, freezeNow, HIGH_ID, LOW_ID, startTestDatabase, unfreezeNow, type TestDatabase } from '@/server/rules/testing/database'
import { getAvailableSessions } from './available-sessions'
import { checkCustomerDayConflict } from './customer-day-conflict'
import { checkSessionTimeConflict } from './session-time-conflict'

let t: TestDatabase
let sauna: string, plunge: string, band: string

beforeAll(async () => {
  t = await startTestDatabase()
  sauna = await fixtures.serviceType(t.db, { name: 'Sauna' })
  plunge = await fixtures.serviceType(t.db, { name: 'Plunge' })
  band = await fixtures.band(t.db, { name: 'Core', price: '20.00' })
})

afterAll(() => t.stop())

const at = (date: string, hour: string) => `${date} ${hour}:00:00+00`
const session = (date: string, hour: string, row: Record<string, unknown> = {}) =>
  fixtures.session(t.db, { service_type_id: sauna, start_time: at(date, hour), end_time: at(date, String(Number(hour) + 1).padStart(2, '0')), ...row })

describe('getAvailableSessions', () => {
  it('returns the row as the staff app does, in start order', async () => {
    const later = await session('2030-01-10', '12', { band_id: band, total_booked: 3 })
    const earlier = await session('2030-01-10', '09', { status: 'blocked', blocked_reason: 'Maintenance' })

    const rows = await getAvailableSessions(t.db, { date: '2030-01-10' })

    expect(rows.map((r) => r.id)).toEqual([earlier, later])
    expect(rows[1]).toEqual({
      id: later,
      service_type_id: sauna,
      service_type_name: 'Sauna',
      booking_type: 'public',
      start_time: '2030-01-10T12:00:00.000Z',
      end_time: '2030-01-10T13:00:00.000Z',
      capacity: 10,
      total_booked: 3,
      available: 7,
      status: 'open',
      blocked_reason: null,
      started: false,
      band_id: band,
      band_code: expect.any(String),
      band_name: 'Core',
      band_price: '20.00',
      band_overridden: false,
    })
  })

  it('a blocked session stays in the list, with its reason', async () => {
    const id = await session('2030-01-11', '09', { status: 'blocked', blocked_reason: 'Closed' })

    expect((await getAvailableSessions(t.db, { date: '2030-01-11' }))[0]).toMatchObject({ id, status: 'blocked', blocked_reason: 'Closed' })
  })

  it('a session that has started says so, against London wall-clock', async () => {
    await session('2020-01-11', '09')

    expect((await getAvailableSessions(t.db, { date: '2020-01-11' }))[0]?.started).toBe(true)
  })

  it('started goes by London wall-clock, not raw UTC', async () => {
    // 12:30 UTC is 13:30 in London in July: the 13:00 session has started, though 13:00 UTC hasn't come.
    const begun = await session('2030-07-01', '13')
    const notYet = await session('2030-07-01', '14')
    await freezeNow(t.pg, '2030-07-01 12:30:00+00')
    try {
      const rows = await getAvailableSessions(t.db, { date: '2030-07-01' })
      expect(rows.map((r) => [r.id, r.started])).toEqual([
        [begun, true],
        [notYet, false],
      ])
    } finally {
      await unfreezeNow(t.pg)
    }
  })

  it('sessions at the same time go by service type name, then id', async () => {
    const zebra = await fixtures.serviceType(t.db, { name: 'Zebra' })
    const apple = await fixtures.serviceType(t.db, { name: 'Apple' })
    const twin = await fixtures.serviceType(t.db, { name: 'Zebra' })
    await session('2030-07-02', '10', { id: HIGH_ID, service_type_id: zebra })
    await session('2030-07-02', '10', { id: LOW_ID, service_type_id: twin })
    const first = await session('2030-07-02', '10', { service_type_id: apple })

    expect((await getAvailableSessions(t.db, { date: '2030-07-02' })).map((r) => r.id)).toEqual([first, LOW_ID, HIGH_ID])
  })

  it('sessions that only touch a booked one are not hidden, on either side', async () => {
    const booked = await session('2030-07-03', '10', { service_type_id: plunge })
    const before = await session('2030-07-03', '09')
    const after = await session('2030-07-03', '11')
    await fixtures.booking(t.db, { session_id: booked, customer_id: await fixtures.customer(t.db) })

    expect((await getAvailableSessions(t.db, { date: '2030-07-03' })).map((r) => r.id)).toEqual([before, booked, after])
  })

  it.each(['pending', 'payment_needed'])('a %s booking on another type hides nothing', async (status) => {
    const day = status === 'pending' ? '2030-07-04' : '2030-07-05'
    const booked = await session(day, '10', { service_type_id: plunge })
    const other = await session(day, '10')
    await fixtures.booking(t.db, { session_id: booked, customer_id: await fixtures.customer(t.db), status })

    expect((await getAvailableSessions(t.db, { date: day })).map((r) => r.id).sort()).toEqual([booked, other].sort())
  })

  it('a confirmed booking on another type hides the overlapping session, and only that one', async () => {
    const booked = await session('2030-01-12', '10', { service_type_id: plunge })
    const clash = await fixtures.session(t.db, { service_type_id: sauna, start_time: at('2030-01-12', '10'), end_time: '2030-01-12 10:30:00+00' })
    const clear = await session('2030-01-12', '14')
    const customer = await fixtures.customer(t.db)
    await fixtures.booking(t.db, { session_id: booked, customer_id: customer })

    const ids = (await getAvailableSessions(t.db, { date: '2030-01-12' })).map((r) => r.id)

    expect(ids).not.toContain(clash)
    expect(ids).toEqual([booked, clear])
  })

  it('a cancelled booking hides nothing', async () => {
    const booked = await session('2030-01-13', '10', { service_type_id: plunge })
    const other = await session('2030-01-13', '10')
    await fixtures.booking(t.db, { session_id: booked, customer_id: await fixtures.customer(t.db), status: 'cancelled' })

    expect((await getAvailableSessions(t.db, { date: '2030-01-13' })).map((r) => r.id).sort()).toEqual([booked, other].sort())
  })

  it('filters by service type', async () => {
    const mine = await session('2030-01-14', '10')
    await session('2030-01-14', '11', { service_type_id: plunge })

    expect((await getAvailableSessions(t.db, { date: '2030-01-14', serviceTypeId: sauna })).map((r) => r.id)).toEqual([mine])
  })

  it('late evening stays on its date: the session time zone is UTC', async () => {
    // Under Europe/London, 23:30 in June would be cast to the next day.
    const id = await fixtures.session(t.db, { service_type_id: sauna, start_time: '2030-06-20 23:30:00+00', end_time: '2030-06-20 23:59:00+00' })

    expect((await getAvailableSessions(t.db, { date: '2030-06-20' })).map((r) => r.id)).toEqual([id])
    expect(await getAvailableSessions(t.db, { date: '2030-06-21' })).toEqual([])
  })
})

describe('the connection time zone', () => {
  it('is passed explicitly as a connection parameter', () => {
    expect(driverOptions.connection).toEqual({ TimeZone: 'UTC' })
  })

  it('is what the database session reports', async () => {
    expect(await t.db.query("SELECT current_setting('TimeZone') AS tz")).toEqual([{ tz: 'UTC' }])
  })
})

describe('checkCustomerDayConflict', () => {
  it.each([
    ['pending', '2030-11-01', '01 Nov 2030'],
    ['confirmed', '2030-11-02', '02 Nov 2030'],
    ['payment_needed', '2030-11-04', '04 Nov 2030'],
  ])('a %s booking on the same day conflicts', async (status, day, text) => {
    const customer = await fixtures.customer(t.db)
    const existing = await session(day, '09')
    const wanted = await session(day, '15')
    await fixtures.booking(t.db, { session_id: existing, customer_id: customer, status })

    expect(await checkCustomerDayConflict(t.db, { customerId: customer, sessionId: wanted })).toEqual({ conflict: true, date: text })
  })

  it('a cancelled booking does not', async () => {
    const customer = await fixtures.customer(t.db)
    const existing = await session('2030-11-05', '09')
    const wanted = await session('2030-11-05', '15')
    await fixtures.booking(t.db, { session_id: existing, customer_id: customer, status: 'cancelled' })

    expect(await checkCustomerDayConflict(t.db, { customerId: customer, sessionId: wanted })).toEqual({ conflict: false })
  })

  it('another day, another customer, or an unknown session does not', async () => {
    const customer = await fixtures.customer(t.db)
    const existing = await session('2030-11-06', '09')
    const nextDay = await session('2030-11-07', '09')
    await fixtures.booking(t.db, { session_id: existing, customer_id: customer })

    expect(await checkCustomerDayConflict(t.db, { customerId: customer, sessionId: nextDay })).toEqual({ conflict: false })
    expect(await checkCustomerDayConflict(t.db, { customerId: await fixtures.customer(t.db), sessionId: existing })).toEqual({ conflict: false })
    expect(await checkCustomerDayConflict(t.db, { customerId: customer, sessionId: '00000000-0000-4000-8000-000000000009' })).toEqual({ conflict: false })
  })

  it('pins the exact date text, which is en-GB: September is "Sept"', async () => {
    const customer = await fixtures.customer(t.db)
    const existing = await session('2030-09-04', '09')
    const wanted = await session('2030-09-04', '15')
    await fixtures.booking(t.db, { session_id: existing, customer_id: customer })

    expect(await checkCustomerDayConflict(t.db, { customerId: customer, sessionId: wanted })).toEqual({ conflict: true, date: '04 Sept 2030' })
  })
})

describe('findDuplicateDayBooking', () => {
  it('gives the lowest id if two active bookings ever share a day', async () => {
    const customer = await fixtures.customer(t.db)
    const morning = await session('2030-11-08', '09')
    const evening = await session('2030-11-08', '18')
    await fixtures.booking(t.db, { id: HIGH_ID, session_id: morning, customer_id: customer })
    await fixtures.booking(t.db, { id: LOW_ID, session_id: evening, customer_id: customer })

    expect(await findDuplicateDayBooking(t.db, customer, '2030-11-08T12:00:00.000Z')).toMatchObject({ id: LOW_ID })
  })
})

describe('checkSessionTimeConflict', () => {
  it('finds a confirmed booking on another type at an overlapping time', async () => {
    const editing = await session('2030-02-01', '09')
    const other = await session('2030-02-01', '10', { service_type_id: plunge })
    await fixtures.booking(t.db, { session_id: other, customer_id: await fixtures.customer(t.db) })

    // Strings go to Postgres exactly as the dialog sends them.
    const found = await checkSessionTimeConflict(t.db, {
      sessionId: editing,
      serviceTypeId: sauna,
      startTime: '2030-02-01T10:30:00.000Z',
      endTime: '2030-02-01T11:30:00.000Z',
    })

    expect(found).toEqual({
      conflict: true,
      conflictingSession: {
        id: other,
        service_type_name: 'Plunge',
        start_time: '2030-02-01T10:00:00.000Z',
        end_time: '2030-02-01T11:00:00.000Z',
      },
    })
  })

  it('of several conflicts it names the earliest, then the lowest id', async () => {
    const third = await fixtures.serviceType(t.db, { name: 'Third' })
    const editing = await session('2030-02-04', '09')
    const later = await session('2030-02-04', '11', { service_type_id: plunge })
    const tiedHigh = await session('2030-02-04', '10', { id: 'eeeeeeee-0000-4000-8000-00000000000c', service_type_id: plunge })
    const tiedLow = await session('2030-02-04', '10', { id: '11111111-0000-4000-8000-00000000000d', service_type_id: third })
    for (const id of [later, tiedHigh, tiedLow]) await fixtures.booking(t.db, { session_id: id, customer_id: await fixtures.customer(t.db) })

    const found = await checkSessionTimeConflict(t.db, {
      sessionId: editing,
      serviceTypeId: sauna,
      startTime: '2030-02-04T09:30:00.000Z',
      endTime: '2030-02-04T12:00:00.000Z',
    })

    expect(found.conflictingSession?.id).toBe(tiedLow)
  })

  it('touching end to start is not a conflict', async () => {
    const editing = await session('2030-02-02', '09')
    const other = await session('2030-02-02', '10', { service_type_id: plunge })
    await fixtures.booking(t.db, { session_id: other, customer_id: await fixtures.customer(t.db) })

    expect(
      await checkSessionTimeConflict(t.db, {
        sessionId: editing,
        serviceTypeId: sauna,
        startTime: '2030-02-02T09:00:00.000Z',
        endTime: '2030-02-02T10:00:00.000Z',
      })
    ).toEqual({ conflict: false, conflictingSession: null })
  })

  it('ignores its own type, itself, and unconfirmed bookings', async () => {
    const editing = await session('2030-02-03', '09')
    const sameType = await session('2030-02-03', '10')
    const unconfirmed = await session('2030-02-03', '10', { service_type_id: plunge })
    await fixtures.booking(t.db, { session_id: sameType, customer_id: await fixtures.customer(t.db) })
    await fixtures.booking(t.db, { session_id: unconfirmed, customer_id: await fixtures.customer(t.db), status: 'pending' })

    expect(
      await checkSessionTimeConflict(t.db, {
        sessionId: editing,
        serviceTypeId: sauna,
        startTime: '2030-02-03T10:00:00.000Z',
        endTime: '2030-02-03T11:00:00.000Z',
      })
    ).toEqual({ conflict: false, conflictingSession: null })
  })
})
