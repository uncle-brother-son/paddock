import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as daysRoute } from '@/app/api/v1/shop/booking-days/route'
import { GET as quoteRoute } from '@/app/api/v1/shop/booking-quote/route'
import { GET as sessionsRoute } from '@/app/api/v1/shop/sessions/route'
import {
  shopBookingDaysRouteOutputSchema,
  shopBookingQuoteRouteOutputSchema,
  shopSessionsRouteOutputSchema,
  type BasketBooking,
  type BasketQuoteInput,
} from '@/contracts'
import type { Db } from '@/server/db'
import { bookingProblem, priceBooking } from '@/server/rules/orders/basket-booking'
import { MAX_GUESTS_PER_PRIVATE_BOOKING, MAX_GUESTS_PER_PUBLIC_BOOKING } from '@/server/rules/orders/guest-validation'
import { loadBasketFacts } from '@/server/rules/orders/load-basket'
import { quoteBookingSeats } from '@/server/rules/pricing/quote-booking-seats'
import { fixtures, freezeNow, insert, startTestDatabase, unfreezeNow, type TestDatabase } from '@/server/rules/testing/database'
import { listShopAddons, readShopAddons, shopBookingDays, shopBookingQuote, shopSessions } from './booking'
import { SHOP_WORDS } from './failure-messages'
import { mostPeopleOnline, ONLINE_CUT_OFF_MINUTES, onlineBookingRefusal, type OnlineSession } from './online-booking'

// Brief W77a: the booking panel's reads and their public routes, on the live schema.
vi.setConfig({ testTimeout: 60_000 })

const holder = vi.hoisted(() => ({ db: null as unknown, closed: 0 }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {
    holder.closed += 1
  },
}))

let database: TestDatabase
let db: Db
let offPeak: string, peak: string
let sauna: string, hour: string, twoHours: string

/** 7 December 2026, 10:00 in London, unless a test says otherwise. */
const NOW = '2026-12-07 10:00:00+00'
const DAY = '2026-12-10'

const at = (instant: string) => freezeNow(database.pg, instant)
const asOwner = (sql: string) => database.pg.exec(`RESET ROLE; ${sql}; SET ROLE paddock_worker;`)
const tier = (type: string, band: string, from: number, to: number, price: string | null) =>
  insert(db, 'service_type_price_tiers', { service_type_id: type, band_id: band, min_people: from, max_people: to, price })

beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  holder.db = db
})
afterAll(() => database.stop())
beforeEach(async () => {
  await unfreezeNow(database.pg)
  await asOwner('TRUNCATE bookings, sessions, service_type_price_tiers, service_types, session_bands, sessions_made_up_to, customers, addons CASCADE')
  offPeak = await fixtures.band(db, { name: 'Off-Peak', price: '25.00' })
  peak = await fixtures.band(db, { name: 'Peak', price: '30.00' })
  sauna = await fixtures.serviceType(db, { name: 'Sauna & Plunge', active: true })
  hour = await fixtures.serviceType(db, { name: 'Private 60', booking_type: 'private', active: true })
  twoHours = await fixtures.serviceType(db, { name: 'Private 120', booking_type: 'private', active: true })
  await tier(hour, offPeak, 1, 6, '105.00')
  await tier(hour, offPeak, 7, 7, '120.00')
  await tier(hour, offPeak, 8, 8, '140.00')
  await tier(hour, offPeak, 9, 9, null)
  await tier(hour, offPeak, 10, 12, '170.00')
  await tier(hour, peak, 1, 6, '130.00')
  await tier(twoHours, offPeak, 1, 6, '210.00')
  await db.query("INSERT INTO sessions_made_up_to (made_up_to) VALUES ('2027-03-15')")
  await at(NOW)
  holder.closed = 0
})

const end = (date: string, time: string, minutes: number) => new Date(new Date(`${date}T${time}:00Z`).getTime() + minutes * 60_000).toISOString()
type Row = Record<string, unknown>
const session = (type: string, date: string, time: string, minutes: number, row: Row) =>
  fixtures.session(db, { service_type_id: type, start_time: `${date} ${time}:00+00`, end_time: end(date, time, minutes), capacity: 6, band_id: offPeak, ...row })
const publicSession = (date: string, time: string, row: Row = {}) => session(sauna, date, time, 60, row)
const privateSession = (date: string, time: string, row: Row = {}) => session(hour, date, time, 60, { type: 'private', ...row })
const longSession = (date: string, time: string, row: Row = {}) => session(twoHours, date, time, 120, { type: 'private', ...row })

/** A booking on a session, with the session's own times, as write-booking.ts leaves one. */
async function book(sessionId: string, status = 'confirmed', people = 1, row: Row = {}): Promise<string> {
  const customer = await fixtures.customer(db)
  const [times] = await db.query<{ start_time: string; end_time: string }>('SELECT start_time::text, end_time::text FROM sessions WHERE id = $1::uuid', [sessionId])
  return fixtures.booking(db, { session_id: sessionId, customer_id: customer, status, party_size: people, start_time: times?.start_time, end_time: times?.end_time, ...row })
}

/** Every session's id the day's read shows. */
async function shownOn(date: string): Promise<string[]> {
  const day = await shopSessions(db, date)
  return [...day.public, ...day.private.flatMap(({ sessions }) => sessions)].map(({ id }) => id)
}

/** What each read says of one session: in the month's days, in the day's sessions as bookable, and the quote's refusal of one person. */
async function everyRead(id: string, date: string) {
  const days = await shopBookingDays(db, date.slice(0, 7))
  const day = await shopSessions(db, date)
  const shown = [...day.public, ...day.private.flatMap(({ sessions }) => sessions)].find((one) => one.id === id)
  return { onItsDay: [...days.publicDays, ...days.privateDays].includes(date), first: days.firstDay, state: shown?.state ?? null, reason: (await shopBookingQuote(db, id, 1)).reason }
}
const BOOKABLE = (date: string) => ({ onItsDay: true, first: date, state: 'bookable', reason: null })
const CLOSED = { onItsDay: false, first: null, state: null, reason: 'closed' }

describe('the cut-off: 30 minutes before the start, by every read (WQ66)', () => {
  it('is 30 minutes', () => {
    expect(ONLINE_CUT_OFF_MINUTES).toBe(30)
  })

  // `now` is the real moment (UTC); the session's time is London's.
  it.each([
    ['winter', '2026-12-07', '14:00', '2026-12-07T14:00:00Z'],
    ['summer', '2026-07-15', '14:00', '2026-07-15T13:00:00Z'],
    ['the day the clocks go forward', '2026-03-29', '09:00', '2026-03-29T08:00:00Z'],
    ['the day the clocks go forward, half an hour over the change', '2026-03-29', '02:15', '2026-03-29T01:15:00Z'],
    ['the day before they go forward', '2026-03-28', '23:30', '2026-03-28T23:30:00Z'],
    ['the day the clocks go back', '2026-10-25', '09:00', '2026-10-25T09:00:00Z'],
    ['the day the clocks go back, half an hour over the change', '2026-10-25', '02:15', '2026-10-25T02:15:00Z'],
    ['just after midnight', '2026-10-24', '00:10', '2026-10-23T23:10:00Z'],
  ])('%s: bookable at 31 minutes, closed at 30 and 29', async (_label, date, time, starts) => {
    const before = (minutes: number, seconds = 0) => new Date(new Date(starts).getTime() - minutes * 60_000 + seconds * 1_000).toISOString()
    for (const make of [publicSession, privateSession]) {
      await asOwner('TRUNCATE sessions CASCADE')
      const id = await make(date, time)
      await at(before(31))
      expect(await everyRead(id, date), '31').toEqual(BOOKABLE(date))
      await at(before(30, -1))
      expect(await everyRead(id, date), '30 and a second').toEqual(BOOKABLE(date))
      for (const minutes of [30, 29, 0, -10]) {
        await at(before(minutes))
        expect(await everyRead(id, date), String(minutes)).toEqual(CLOSED)
      }
    }
  })

  it('goes by real minutes over a clock change, not by the digits', async () => {
    // London reads 00:50 and the session's digits are 02:15, 85 minutes on: it starts in 25.
    const forward = await publicSession('2026-03-29', '02:15')
    await at('2026-03-29T00:50:00Z')
    expect(await everyRead(forward, '2026-03-29')).toEqual(CLOSED)
    // London reads 01:50 (the first time round) and the digits are 02:15, 25 minutes on: it starts in 85.
    await asOwner('TRUNCATE sessions CASCADE')
    const back = await publicSession('2026-10-25', '02:15')
    await at('2026-10-25T00:50:00Z')
    expect(await everyRead(back, '2026-10-25')).toEqual(BOOKABLE('2026-10-25'))
    // London reads 01:45 the first time round, and the digits are 01:30: the second time round, in 45 minutes.
    await asOwner('TRUNCATE sessions CASCADE')
    const second = await publicSession('2026-10-25', '01:30')
    await at('2026-10-25T00:45:00Z')
    expect(await everyRead(second, '2026-10-25')).toEqual(BOOKABLE('2026-10-25'))
  })

  it('a full session under the cut-off is closed, and left out like any other', async () => {
    const id = await publicSession('2026-12-07', '10:20', { total_booked: 6 })
    expect(await everyRead(id, '2026-12-07')).toEqual(CLOSED)
  })

  it('does not depend on the connection\'s time zone', async () => {
    const open = await publicSession('2026-12-07', '10:31')
    const shut = await publicSession('2026-12-07', '10:30')
    const late = await publicSession('2026-12-08', '23:30')
    const reads = async () => ({ days: await shopBookingDays(db, '2026-12'), day: await shopSessions(db, '2026-12-07'), next: await shopSessions(db, '2026-12-08'), open: await shopBookingQuote(db, open, 1), shut: await shopBookingQuote(db, shut, 1) })
    const before = await reads()
    expect(before.days).toMatchObject({ publicDays: ['2026-12-07', '2026-12-08'], firstDay: '2026-12-07' })
    expect(before.next.public.map(({ id }) => id)).toEqual([late])
    await database.pg.exec("SET TIME ZONE 'America/New_York'")
    try {
      expect(await reads()).toEqual(before)
    } finally {
      await database.pg.exec("SET TIME ZONE 'UTC'")
    }
  })
})

describe('what can be booked', () => {
  it('blocked: never shown, and its reason never told', async () => {
    const id = await publicSession(DAY, '10:00', { status: 'blocked', blocked_reason: 'SECRET' })
    expect(await everyRead(id, DAY)).toEqual({ onItsDay: false, first: null, state: null, reason: 'unavailable' })
  })

  it('full: shown as full, and not a day of its own; one space left is still bookable', async () => {
    const full = await publicSession(DAY, '10:00', { total_booked: 6 })
    expect(await everyRead(full, DAY)).toEqual({ onItsDay: false, first: null, state: 'full', reason: 'full' })
    const last = await publicSession(DAY, '12:00', { total_booked: 5 })
    expect(await everyRead(last, DAY)).toEqual(BOOKABLE(DAY))
    expect((await shopSessions(db, DAY)).public.map(({ id, state, spotsLeft, mostPeople }) => [id, state, spotsLeft, mostPeople])).toEqual([[full, 'full', 0, 0], [last, 'bookable', 1, 1]])
  })

  it('a private session is free or full: one booking takes it, whatever its size', async () => {
    const taken = await privateSession(DAY, '10:00', { total_booked: 2 })
    const free = await privateSession(DAY, '12:00')
    expect((await shopSessions(db, DAY)).private.flatMap(({ sessions }) => sessions).map(({ id, state, mostPeople }) => [id, state, mostPeople])).toEqual([[taken, 'full', 0], [free, 'bookable', 10]])
    expect((await shopBookingQuote(db, taken, 2)).reason).toBe('full')
  })

  it('more booked than its spaces (the table lets staff) is 0 spaces, never fewer', async () => {
    await publicSession(DAY, '10:00', { total_booked: 8 })
    expect((await shopSessions(db, DAY)).public[0]).toMatchObject({ state: 'full', spotsLeft: 0, mostPeople: 0 })
  })

  it.each(['confirmed', 'pending', 'payment_needed'])("a %s booking on another session at that time takes it, one touching it or cancelled doesn't", async (status) => {
    const open = await publicSession(DAY, '10:00')
    const touching = await publicSession(DAY, '12:00')
    const clash = await privateSession(DAY, '11:00')
    const overlapping = await longSession(DAY, '09:30')
    await book(clash, 'cancelled')
    expect((await shownOn(DAY)).sort()).toEqual([open, touching, clash, overlapping].sort())
    await book(clash, status)
    // 11:00-12:00 is taken: the two-hour session (09:30-11:30) is gone; the ones before and after only touch it.
    expect((await shownOn(DAY)).sort()).toEqual([open, touching, clash].sort())
    expect((await shopBookingQuote(db, overlapping, 1)).reason).toBe('unavailable')
  })

  it('a booking takes a session of the same type too, when their times overlap, as the table would refuse it', async () => {
    const first = await publicSession(DAY, '10:00')
    const half = await publicSession(DAY, '10:30')
    await book(first)
    expect(await shownOn(DAY)).toEqual([first])
    expect((await shopBookingQuote(db, half, 1)).reason).toBe('unavailable')
    const [times] = await db.query<{ start_time: string; end_time: string }>('SELECT start_time::text, end_time::text FROM sessions WHERE id = $1::uuid', [half])
    await expect(fixtures.booking(db, { session_id: half, customer_id: await fixtures.customer(db), start_time: times?.start_time, end_time: times?.end_time })).rejects.toThrow(/bookings_no_cross_session_overlap/)
  })

  it("its service off sale, no band, or no price for it: never shown", async () => {
    const off = await fixtures.serviceType(db, { name: 'Off', active: false })
    const unknown = await fixtures.serviceType(db, { name: 'Unknown', active: null })
    const ids = [
      await session(off, DAY, '08:00', 60, {}),
      await session(unknown, DAY, '09:00', 60, {}),
      await publicSession(DAY, '10:00', { band_id: null }),
      // The row's own type is what quote_booking asks for.
      await publicSession(DAY, '11:00', { type: 'private' }),
      await privateSession(DAY, '12:00', { band_id: null }),
      await longSession(DAY, '13:00', { band_id: peak }),
    ]
    expect(await shownOn(DAY)).toEqual([])
    expect(await shopBookingDays(db, '2026-12')).toMatchObject({ publicDays: [], privateDays: [], firstDay: null })
    for (const id of ids) expect((await shopBookingQuote(db, id, 1)).reason, id).toBe('unavailable')
    // A price pending in every group is no price; and a group nobody online can be in is none either.
    await tier(twoHours, peak, 1, 6, null)
    await tier(twoHours, peak, 11, 12, '300.00')
    expect(await shownOn(DAY)).toEqual([])
  })

  it('past the date sessions are made up to: never shown; with no date, nothing is', async () => {
    const last = await publicSession('2027-03-15', '10:00')
    const past = await publicSession('2027-03-16', '10:00')
    expect(await everyRead(last, '2027-03-15')).toEqual(BOOKABLE('2027-03-15'))
    expect(await everyRead(past, '2027-03-16')).toMatchObject({ onItsDay: false, first: '2027-03-15', state: null, reason: 'unavailable' })
    expect((await shopBookingDays(db, '2027-03')).lastDay).toBe('2027-03-15')
    await asOwner('TRUNCATE sessions_made_up_to')
    expect(await everyRead(last, '2027-03-15')).toEqual({ onItsDay: false, first: null, state: null, reason: 'unavailable' })
    expect((await shopBookingDays(db, '2027-03')).lastDay).toBeNull()
  })
})

describe('days (WQ65)', () => {
  it("a month's days with one to book, public and private apart, in order, and never another month's", async () => {
    await publicSession('2026-11-30', '23:30')
    await publicSession('2026-12-31', '23:30')
    await publicSession('2026-12-10', '10:00')
    await publicSession('2026-12-10', '12:00')
    await privateSession('2026-12-10', '14:00')
    await privateSession('2026-12-08', '00:00')
    await longSession('2026-12-09', '10:00', { total_booked: 1 })
    await publicSession('2027-01-01', '00:00')
    expect(await shopBookingDays(db, '2026-12')).toEqual({
      month: '2026-12',
      publicDays: ['2026-12-10', '2026-12-31'],
      privateDays: ['2026-12-08', '2026-12-10'],
      firstDay: '2026-12-08',
      lastDay: '2027-03-15',
    })
    // The first day is from now, whatever month is asked for.
    expect(await shopBookingDays(db, '2027-01')).toMatchObject({ publicDays: ['2027-01-01'], privateDays: [], firstDay: '2026-12-08' })
    expect(await shopBookingDays(db, '2026-11')).toMatchObject({ publicDays: [], firstDay: '2026-12-08' })
  })

  it('a leap February has its last day, and a plain one has no more', async () => {
    await db.query("UPDATE sessions_made_up_to SET made_up_to = '2030-01-01'")
    await publicSession('2028-02-29', '10:00')
    await publicSession('2027-02-28', '10:00')
    await publicSession('2027-03-01', '10:00')
    expect((await shopBookingDays(db, '2028-02')).publicDays).toEqual(['2028-02-29'])
    expect((await shopBookingDays(db, '2027-02')).publicDays).toEqual(['2027-02-28'])
  })

  it('the first day is today while it has one left, then the next day that has', async () => {
    await publicSession('2026-12-07', '09:00')
    await publicSession('2026-12-07', '10:45')
    await publicSession('2026-12-08', '09:00', { total_booked: 6 })
    await privateSession('2026-12-09', '09:00')
    expect((await shopBookingDays(db, '2026-12')).firstDay).toBe('2026-12-07')
    await at('2026-12-07 10:15:00+00')
    expect((await shopBookingDays(db, '2026-12')).firstDay).toBe('2026-12-09')
  })

  it("today is London's: at 23:30 UTC in summer it is already tomorrow", async () => {
    await publicSession('2026-07-01', '23:50')
    await publicSession('2026-07-02', '09:00')
    await at('2026-07-01T23:30:00Z')
    expect(await shopBookingDays(db, '2026-07')).toMatchObject({ publicDays: ['2026-07-02'], firstDay: '2026-07-02' })
  })

  it('a day is in the list exactly when its own read has one to book', async () => {
    const full = { total_booked: 6 }
    await publicSession('2026-12-07', '10:20')
    await publicSession('2026-12-08', '10:00', full)
    await publicSession('2026-12-09', '10:00', { status: 'blocked' })
    const clash = await publicSession('2026-12-11', '10:00')
    await longSession('2026-12-11', '09:30')
    await book(clash)
    await privateSession('2026-12-12', '10:00', { total_booked: 1 })
    await publicSession('2026-12-13', '10:00', { total_booked: 5 })
    await privateSession('2026-12-14', '10:00', { band_id: null })
    await privateSession('2026-12-15', '10:00', { band_id: peak })
    const days = await shopBookingDays(db, '2026-12')
    for (let date = 1; date <= 31; date += 1) {
      const day = `2026-12-${String(date).padStart(2, '0')}`
      const read = await shopSessions(db, day)
      expect(days.publicDays.includes(day), day).toBe(read.public.some(({ state }) => state === 'bookable'))
      expect(days.privateDays.includes(day), day).toBe(read.private.some(({ sessions }) => sessions.some(({ state }) => state === 'bookable')))
    }
    expect([days.publicDays, days.privateDays]).toEqual([['2026-12-11', '2026-12-13'], ['2026-12-15']])
  })
})

describe("a day's sessions", () => {
  it('everything the panel is told and nothing else', async () => {
    const peakOne = await publicSession(DAY, '18:00', { band_id: peak, total_booked: 2 })
    const first = await publicSession(DAY, '10:00')
    const short = await privateSession(DAY, '12:00')
    const shortPeak = await privateSession(DAY, '19:30', { band_id: peak })
    const long = await longSession(DAY, '14:00')
    const base = { band: 'Off-Peak', state: 'bookable' }
    expect(await shopSessions(db, DAY)).toEqual({
      date: DAY,
      mostPeople: { public: 6, private: 10 },
      public: [
        { ...base, id: first, startsAt: '2026-12-10T10:00:00+00:00', minutes: 60, service: 'Sauna & Plunge', spotsLeft: 6, mostPeople: 6, price: '25.00' },
        { ...base, id: peakOne, startsAt: '2026-12-10T18:00:00+00:00', minutes: 60, service: 'Sauna & Plunge', band: 'Peak', spotsLeft: 4, mostPeople: 4, price: '30.00' },
      ],
      private: [
        {
          minutes: 60,
          sessions: [
            // 9 people has no price yet, and a group of more than 10 can't be booked.
            { ...base, id: short, startsAt: '2026-12-10T12:00:00+00:00', minutes: 60, service: 'Private 60', mostPeople: 10, prices: [{ from: 1, to: 6, price: '105.00' }, { from: 7, to: 7, price: '120.00' }, { from: 8, to: 8, price: '140.00' }, { from: 10, to: 10, price: '170.00' }] },
            { ...base, id: shortPeak, startsAt: '2026-12-10T19:30:00+00:00', minutes: 60, service: 'Private 60', band: 'Peak', mostPeople: 6, prices: [{ from: 1, to: 6, price: '130.00' }] },
          ],
        },
        { minutes: 120, sessions: [{ ...base, id: long, startsAt: '2026-12-10T14:00:00+00:00', minutes: 120, service: 'Private 120', mostPeople: 6, prices: [{ from: 1, to: 6, price: '210.00' }] }] },
      ],
    })
  })

  it('a day with none, and a past one, are empty', async () => {
    await publicSession('2026-12-01', '10:00')
    for (const date of ['2026-12-25', '2026-12-01']) expect(await shopSessions(db, date)).toEqual({ date, mostPeople: { public: 6, private: 10 }, public: [], private: [] })
  })

  it("its own London day only, and the time with the UK's offset", async () => {
    await publicSession('2026-07-01', '00:00')
    const late = await publicSession('2026-07-01', '23:30')
    await publicSession('2026-07-02', '00:00')
    await at('2026-06-01T10:00:00Z')
    expect((await shopSessions(db, '2026-07-01')).public.map(({ startsAt }) => startsAt)).toEqual(['2026-07-01T00:00:00+01:00', '2026-07-01T23:30:00+01:00'])
    expect((await shopSessions(db, '2026-07-01')).public[1]?.id).toBe(late)
  })

  it('a public session never offers more people than 6, however many spaces it has', async () => {
    await publicSession(DAY, '10:00', { capacity: 12 })
    expect((await shopSessions(db, DAY)).public[0]).toMatchObject({ spotsLeft: 12, mostPeople: 6 })
  })

  it('two bands at the same price, then one changed: each shows its own', async () => {
    await publicSession(DAY, '10:00')
    await publicSession(DAY, '12:00', { band_id: peak })
    await publicSession(DAY, '14:00')
    await db.query('UPDATE session_bands SET price = 25 WHERE id = $1::uuid', [peak])
    const prices = async () => (await shopSessions(db, DAY)).public.map(({ price }) => price)
    expect(await prices()).toEqual(['25.00', '25.00', '25.00'])
    await db.query('UPDATE session_bands SET price = 27.5 WHERE id = $1::uuid', [offPeak])
    expect(await prices()).toEqual(['27.50', '25.00', '27.50'])
  })
})

describe("a group's price", () => {
  it('public: the booker, then the guests, and the total', async () => {
    const id = await publicSession(DAY, '10:00', { total_booked: 1 })
    expect(await shopBookingQuote(db, id, 1)).toEqual({ session: id, people: 1, reason: null, mostPeople: 5, total: '25.00', lines: [{ who: 'you', people: 1, each: '25.00', total: '25.00' }] })
    expect(await shopBookingQuote(db, id, 5)).toEqual({
      session: id,
      people: 5,
      reason: null,
      mostPeople: 5,
      total: '125.00',
      lines: [
        { who: 'you', people: 1, each: '25.00', total: '25.00' },
        { who: 'guests', people: 4, each: '25.00', total: '100.00' },
      ],
    })
    expect(await shopBookingQuote(db, id, 6)).toEqual({ session: id, people: 6, reason: 'too_many', mostPeople: 5, total: null, lines: [] })
  })

  it('pence add up exactly', async () => {
    await db.query('UPDATE session_bands SET price = 19.99 WHERE id = $1::uuid', [offPeak])
    expect(await shopBookingQuote(db, await publicSession(DAY, '10:00'), 6)).toMatchObject({ total: '119.94', lines: [{ total: '19.99' }, { total: '99.95' }] })
  })

  it('private: the group, with no price each; a group with no price, and one too many', async () => {
    const id = await privateSession(DAY, '10:00')
    const asked = async (people: number) => {
      const { reason, total, lines, mostPeople } = await shopBookingQuote(db, id, people)
      return [reason, total, lines, mostPeople]
    }
    expect(await asked(1)).toEqual([null, '105.00', [{ who: 'group', people: 1, each: null, total: '105.00' }], 10])
    expect(await asked(7)).toEqual([null, '120.00', [{ who: 'group', people: 7, each: null, total: '120.00' }], 10])
    expect(await asked(9)).toEqual(['unavailable', null, [], 10])
    expect(await asked(10)).toEqual([null, '170.00', [{ who: 'group', people: 10, each: null, total: '170.00' }], 10])
    expect(await asked(11)).toEqual(['too_many', null, [], 10])
    const peakId = await privateSession(DAY, '18:00', { band_id: peak })
    expect(await shopBookingQuote(db, peakId, 7)).toMatchObject({ reason: 'too_many', mostPeople: 6 })
  })

  it('the rule on its own: every state refuses, and only then the number', () => {
    const one = (over: Partial<OnlineSession>): OnlineSession => ({ type: 'public', state: 'bookable', spotsLeft: 3, prices: [], ...over })
    expect((['unavailable', 'closed', 'full'] as const).map((state) => [onlineBookingRefusal(one({ state }), 99), mostPeopleOnline(one({ state }))])).toEqual([['unavailable', 0], ['closed', 0], ['full', 0]])
    expect([3, 4].map((people) => onlineBookingRefusal(one({}), people))).toEqual([null, 'too_many'])
    expect([mostPeopleOnline(one({ spotsLeft: 20 })), mostPeopleOnline(one({ type: 'private' }))]).toEqual([6, 0])
    expect(mostPeopleOnline(one({ type: 'private', prices: [{ from: 1, to: 14, price: '1.00' }] }))).toBe(10)
  })
})

describe("the checkout's own rules say the same", () => {
  const basket = (sessionId: string, people: number): BasketBooking => ({
    sessionId,
    redemptionSource: 'paid',
    guestsOver18Confirmed: true,
    guests: Array.from({ length: people }, (_, i) => ({ name: `Guest ${i + 1}`, dateOfBirth: i === 0 ? '1990-01-01' : null })),
  })
  /** What the checkout charges, and why it refuses, for somebody with no account. */
  async function checkout(sessionId: string, people: number) {
    const booking = basket(sessionId, people)
    const facts = await loadBasketFacts(db, { booking } as BasketQuoteInput)
    return { problem: bookingProblem(booking, facts)?.reason ?? null, price: priceBooking(booking, facts).price.toFixed(2) }
  }

  it('the limits are the checkout\'s', async () => {
    expect((await shopSessions(db, DAY)).mostPeople).toEqual({ public: MAX_GUESTS_PER_PUBLIC_BOOKING, private: MAX_GUESTS_PER_PRIVATE_BOOKING })
  })

  it('every group from 1 to 11, public and private, in each band: the same price, and refused together', async () => {
    const ids = [
      await publicSession(DAY, '08:00'),
      await publicSession(DAY, '09:00', { band_id: peak, total_booked: 3 }),
      await privateSession(DAY, '10:00'),
      await privateSession(DAY, '11:00', { band_id: peak }),
      await longSession(DAY, '12:00'),
      await publicSession(DAY, '14:00', { total_booked: 6 }),
      await privateSession(DAY, '15:00', { total_booked: 1 }),
    ]
    for (const id of ids) {
      for (let people = 1; people <= 11; people += 1) {
        const ours = await shopBookingQuote(db, id, people)
        const theirs = await checkout(id, people)
        expect(ours.reason === null, `${id} for ${people}: ours ${ours.reason}, the checkout's ${theirs.problem}`).toBe(theirs.problem === null)
        if (ours.reason === null) expect(ours.total, `${id} for ${people}`).toBe(theirs.price)
      }
    }
  })

  it('nothing the panel offers is refused by it: blocked, started, taken, unpriced', async () => {
    const taken = await longSession(DAY, '09:30')
    await book(await publicSession(DAY, '10:00'), 'payment_needed')
    const refused = [taken, await publicSession(DAY, '12:00', { status: 'blocked' }), await publicSession('2026-12-07', '09:00'), await publicSession(DAY, '14:00', { band_id: null }), await privateSession(DAY, '15:00', { band_id: null })]
    for (const id of refused) {
      expect((await checkout(id, 1)).problem, id).not.toBeNull()
      expect((await shopBookingQuote(db, id, 1)).reason, id).not.toBeNull()
    }
  })

  it("a public price is the seats quote's, for a customer with no membership", async () => {
    const id = await publicSession(DAY, '10:00', { band_id: peak })
    const quote = await quoteBookingSeats(db, { sessionId: id, customerId: await fixtures.customer(db), partySize: 4 })
    const ours = await shopBookingQuote(db, id, 4)
    expect(ours.total).toBe(quote.paidTotal.toFixed(2))
    expect((await shopSessions(db, DAY)).public[0]?.price).toBe(quote.seats[0]?.unit_price)
  })

  it('a price changed in quote_booking itself is the price shown: the band is not read for it', async () => {
    const id = await publicSession(DAY, '10:00')
    const [was] = await db.query<{ source: string }>("SELECT pg_get_functiondef('public.quote_booking'::regproc) AS source")
    const source = was?.source ?? ''
    const changed = source.replace('CASE WHEN g = 1 THEN ROUND(v_price * (1 - v_discount / 100), 2) ELSE v_price END', 'CASE WHEN g = 1 THEN v_price + 1 ELSE v_price + 2 END')
    expect(changed).not.toBe(source)
    await asOwner(changed)
    expect((await shopSessions(db, DAY)).public[0]?.price).toBe('26.00')
    expect(await shopBookingQuote(db, id, 3)).toMatchObject({ total: '80.00', lines: [{ who: 'you', each: '26.00' }, { who: 'guests', people: 2, each: '27.00', total: '54.00' }] })
    await asOwner(source)
    expect((await shopSessions(db, DAY)).public[0]?.price).toBe('25.00')
  })
})

describe('add-ons on sale', () => {
  const addon = (sanityId: string | null, row: Row = {}) => insert(db, 'addons', { sanity_addon_id: sanityId, name: 'Towel', category: 'amenities', base_price: '4.00', active: true, ...row })

  it('by category then name, at what a visitor pays, and nothing else', async () => {
    await addon('smoothie', { name: 'Smoothie', category: 'food_drink', base_price: '6.50', member_price: '5.00', stripe_product_id: 'prod_x', stripe_price_id_base: 'price_x', sku: 'S1' })
    await addon('towel', { base_price: '4.00', sale_price: '3.00', member_price: '2.00' })
    await addon('robe', { name: 'Robe' })
    await addon('massage', { name: 'Massage', category: 'services', base_price: '40.00' })
    await addon('off', { active: false })
    await addon(null)
    // A member price and nothing else is no visitor's price.
    await addon('members', { base_price: null, member_price: '2.00' })
    await addon('unpriced', { base_price: null })
    expect(await listShopAddons(db)).toEqual([
      { sanityId: 'robe', name: 'Robe', category: 'amenities', price: '4.00' },
      { sanityId: 'towel', name: 'Towel', category: 'amenities', price: '3.00' },
      { sanityId: 'smoothie', name: 'Smoothie', category: 'food_drink', price: '6.50' },
      { sanityId: 'massage', name: 'Massage', category: 'services', price: '40.00' },
    ])
  })

  it('on a connection of its own, closed, a failed read included', async () => {
    await addon('towel')
    expect((await readShopAddons()).map(({ sanityId }) => sanityId)).toEqual(['towel'])
    expect(holder.closed).toBe(1)
    const spy = vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('down'))
    await expect(readShopAddons()).rejects.toThrow('down')
    expect(holder.closed).toBe(2)
    spy.mockRestore()
  })
})

// --- The routes

const ROUTES = {
  'booking-days': daysRoute,
  sessions: sessionsRoute,
  'booking-quote': quoteRoute,
} as const

async function ask(route: keyof typeof ROUTES, query: string) {
  const response = await ROUTES[route](new Request(`https://worker.test/api/v1/shop/${route}${query}`))
  const body = (await response.json()) as { ok: boolean; data?: unknown; error?: { code: string; message: string; field?: string } }
  return { status: response.status, cacheControl: response.headers.get('Cache-Control'), body }
}

/** Every field name anywhere in an answer. */
const fieldsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(fieldsOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, inner]) => [name, ...fieldsOf(inner)]) : []
const FORBIDDEN_FIELD = /book(ed|ing)|guest|customer|stripe|capacity|block|status|email|attend|party/i

describe('the public routes', () => {
  it('each answers with no sign-in, never cached', async () => {
    const id = await publicSession(DAY, '10:00')
    const answers = [await ask('booking-days', '?month=2026-12'), await ask('sessions', `?date=${DAY}`), await ask('booking-quote', `?session=${id}&people=2`)]
    for (const { status, cacheControl } of answers) expect([status, cacheControl]).toEqual([200, 'no-store'])
    expect(answers.map(({ body }) => body.data)).toEqual([await shopBookingDays(db, '2026-12'), await shopSessions(db, DAY), await shopBookingQuote(db, id, 2)])
    await db.query('UPDATE sessions SET total_booked = 6 WHERE id = $1::uuid', [id])
    expect((await ask('booking-quote', `?session=${id}&people=2`)).body.data).toMatchObject({ reason: 'full', total: null })
  })

  it('hold no customer, booking, guest or Stripe detail', async () => {
    await db.query("UPDATE service_types SET stripe_product_id = 'prod_secret_' || id::text, stripe_price_id = 'price_secret_' || id::text")
    await db.query("UPDATE service_type_price_tiers SET stripe_price_id = 'price_secret_' || id::text")
    const customer = await fixtures.customer(db, { first_name: 'SECRET', email: 'secret@example.test', stripe_customer_id: 'cus_secret' })
    const open = await publicSession(DAY, '10:00', { capacity: 8731, total_booked: 8729 })
    const taken = await privateSession(DAY, '12:00', { total_booked: 6 })
    const blocked = await publicSession(DAY, '14:00', { status: 'blocked', blocked_reason: 'SECRET-REASON' })
    const booking = await fixtures.booking(db, { session_id: open, customer_id: customer, party_size: 2, price_paid: '61.23', special_requests: 'SECRET-REQUEST', start_time: `${DAY} 10:00:00+00`, end_time: `${DAY} 11:00:00+00` })
    await insert(db, 'booking_guests', { booking_id: booking, guest_type: 'additional_guest', guest_name: 'SECRET-GUEST', guest_email: 'guest@example.test' })
    const answers = [
      (await ask('booking-days', '?month=2026-12')).body,
      (await ask('sessions', `?date=${DAY}`)).body,
      (await ask('booking-quote', `?session=${open}&people=2`)).body,
      (await ask('booking-quote', `?session=${taken}&people=2`)).body,
      (await ask('booking-quote', `?session=${blocked}&people=2`)).body,
    ]
    for (const answer of answers) {
      expect(answer.ok).toBe(true)
      expect(fieldsOf(answer).filter((name) => FORBIDDEN_FIELD.test(name))).toEqual([])
      expect(JSON.stringify(answer)).not.toMatch(/SECRET|secret|87\d\d|61\.23|example\.test|"(cus|pi|prod|price)_/)
      for (const id of [customer, booking]) expect(JSON.stringify(answer)).not.toContain(id)
    }
    // The check sees one, and each contract refuses one, at every level.
    const bad = ['total_booked', 'booking_id', 'guests', 'customerEmail', 'stripe_price_id', 'capacity', 'blocked_reason', 'status', 'party_size']
    expect(fieldsOf(Object.fromEntries(bad.map((name) => [name, 1]))).filter((name) => FORBIDDEN_FIELD.test(name))).toEqual(bad)
    const [days, day, quote] = answers.map(({ data }) => data) as [object, { public: object[]; private: Array<{ sessions: Array<{ prices: object[] }> }> }, { lines: object[] }]
    expect([shopBookingDaysRouteOutputSchema.safeParse(days).success, shopSessionsRouteOutputSchema.safeParse(day).success, shopBookingQuoteRouteOutputSchema.safeParse(quote).success]).toEqual([true, true, true])
    const [publicOne] = day.public
    const [length] = day.private
    const [privateOne] = length?.sessions ?? []
    for (const name of bad) {
      const extra = { [name]: 1 }
      expect(shopBookingDaysRouteOutputSchema.safeParse({ ...days, ...extra }).success, name).toBe(false)
      for (const one of [
        { ...day, ...extra },
        { ...day, public: [{ ...publicOne, ...extra }] },
        { ...day, private: [{ ...length, ...extra }] },
        { ...day, private: [{ ...length, sessions: [{ ...privateOne, ...extra }] }] },
        { ...day, private: [{ ...length, sessions: [{ ...privateOne, prices: [{ ...privateOne?.prices[0], ...extra }] }] }] },
      ]) {
        expect(shopSessionsRouteOutputSchema.safeParse(one).success, name).toBe(false)
      }
      for (const one of [{ ...quote, ...extra }, { ...quote, lines: [{ ...quote.lines[0], ...extra }] }]) expect(shopBookingQuoteRouteOutputSchema.safeParse(one).success, name).toBe(false)
    }
  })

  const ID = '7c1d5a52-1111-4111-8111-111111111111'
  it.each([
    ['booking-days', 'no month', '', 'month'],
    ['booking-days', 'an empty one', '?month=', 'month'],
    ['booking-days', 'month 13', '?month=2026-13', 'month'],
    ['booking-days', 'month 0', '?month=2026-00', 'month'],
    ['booking-days', 'a date', '?month=2026-12-01', 'month'],
    ['booking-days', 'the year 0000', '?month=0000-01', 'month'],
    ['booking-days', 'SQL', "?month=2026-12'--", 'month'],
    ['booking-days', 'two', '?month=2026-12&month=2026-11', 'month'],
    ['sessions', 'no date', '', 'date'],
    ['sessions', 'a month', '?date=2026-12', 'date'],
    ['sessions', '30 February', '?date=2027-02-30', 'date'],
    ['sessions', 'month 13', '?date=2026-13-01', 'date'],
    ['sessions', 'the year 0000', '?date=0000-01-01', 'date'],
    ['sessions', 'a date and a time', '?date=2026-12-10T10:00', 'date'],
    ['sessions', 'two', '?date=2026-12-10&date=2026-12-11', 'date'],
    ['booking-quote', 'nothing', '', 'session'],
    ['booking-quote', 'a session that is not an id', '?session=abc&people=1', 'session'],
    ['booking-quote', 'SQL', `?session=${ID}'--&people=1`, 'session'],
    ['booking-quote', 'no people', `?session=${ID}`, 'people'],
    ['booking-quote', 'nobody', `?session=${ID}&people=0`, 'people'],
    ['booking-quote', 'fewer than nobody', `?session=${ID}&people=-1`, 'people'],
    ['booking-quote', 'half a person', `?session=${ID}&people=1.5`, 'people'],
    ['booking-quote', 'a thousand', `?session=${ID}&people=1000`, 'people'],
    ['booking-quote', 'words', `?session=${ID}&people=two`, 'people'],
  ] as const)('%s refuses %s: 400, and nothing is read', async (route, _label, query, field) => {
    const spy = vi.spyOn(db, 'query')
    const { status, cacheControl, body } = await ask(route, query)
    expect([status, cacheControl, body.ok, body.error?.code, body.error?.field]).toEqual([400, 'no-store', false, 'VALIDATION', field])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('an unknown session is refused: 404', async () => {
    const { status, cacheControl, body } = await ask('booking-quote', `?session=${ID}&people=1`)
    expect([status, cacheControl, body.error?.code, body.error?.message]).toEqual([404, 'no-store', 'NOT_FOUND', SHOP_WORDS.sessionNotFound])
  })
})
