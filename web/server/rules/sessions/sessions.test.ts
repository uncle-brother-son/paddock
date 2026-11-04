import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { driverOptions } from '@/server/db/postgres-driver'
import { fixtures, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
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
