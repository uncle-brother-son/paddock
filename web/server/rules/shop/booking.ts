// Brief W77a (Wayne's WQ64-WQ66): what the website's booking panel reads, for a visitor who isn't signed in. Reads only.
//
// Whether a session can be booked is online-booking.ts's answer; which sessions a day has is available-sessions.ts's; a
// public price is quote_booking's, through band-pricing.ts, asked as somebody with no account; a private price is the
// size group the checkout charges (service_type_price_tiers, as orders/load-basket.ts reads it). Every row is built field
// by field: never a booking, who made it, a reason a session is blocked or a Stripe id.
import 'server-only'
import type { ShopBookingDaysRouteOutput, ShopBookingQuoteRouteOutput, ShopSessionsRouteOutput } from '@/contracts'
import type { Queryable } from '@/server/db'
import { closeRequestDb, openRequestDb } from '@/server/db/connection'
import { ApiError } from '@/server/http/errors'
import { namedRead } from '@/server/rules/admin/read'
import { listAddons } from '@/server/rules/catalog/items'
import { addonPriceFor, type CatalogPrices } from '@/server/rules/orders/catalog-price'
import { quoteSeats } from '@/server/rules/pricing/band-pricing'
import { sessionsMadeUpTo } from '@/server/rules/sessions/admin'
import { AVAILABLE_SESSIONS_SQL } from '@/server/rules/sessions/available-sessions'
import { LONDON_NOW_SQL, onOrAfterLondonDaySql, withinLondonDaysSql } from '@/server/rules/time/london-day-sql'
import { pence } from './display-prices'
import { londonIso } from './events'
import { SHOP_WORDS } from './failure-messages'
import { groupPriceFor, MOST_PEOPLE, mostPeopleOnline, onlineBookingRefusal, onlineSessionStateSql, sessionDaySql, type GroupPrice, type OnlineSession, type OnlineSessionState } from './online-booking'

/** Nobody: a price asked for a visitor. No customer has this id, so quote_booking finds no membership for it. */
const NO_ACCOUNT = '00000000-0000-0000-0000-000000000000'

const dayText = (sql: string): string => `to_char(${sql}, 'YYYY-MM-DD')`
const STATE = onlineSessionStateSql('s', 'st')

/** A private session's size groups with a price, smallest first, none past the most people a booking may hold. */
const GROUPS_SQL = `COALESCE((
      SELECT jsonb_agg(jsonb_build_object('from', tier.min_people, 'to', LEAST(tier.max_people, ${MOST_PEOPLE.private}), 'price', tier.price::text) ORDER BY tier.min_people)
      FROM service_type_price_tiers tier
      WHERE st.booking_type = 'private' AND tier.service_type_id = s.service_type_id AND tier.band_id = s.band_id
        AND tier.price IS NOT NULL AND tier.min_people <= ${MOST_PEOPLE.private}), '[]'::jsonb)`
const SPOTS_LEFT_SQL = 'GREATEST(s.capacity - s.total_booked, 0)'

// --- Days

const DAYS_SQL = `SELECT q.day, bool_or(q.booking_type = 'public') AS public, bool_or(q.booking_type = 'private') AS private
  FROM (SELECT ${dayText(sessionDaySql('s'))} AS day, st.booking_type, ${STATE} AS state
          FROM sessions s JOIN service_types st ON st.id = s.service_type_id
         WHERE ${withinLondonDaysSql('s.start_time', '$1', '$2')}) q
 WHERE q.state = 'bookable' GROUP BY q.day ORDER BY q.day`

const FIRST_DAY_SQL = `SELECT ${dayText(sessionDaySql('s'))} AS day
  FROM sessions s JOIN service_types st ON st.id = s.service_type_id
 WHERE ${onOrAfterLondonDaySql('s.start_time', LONDON_NOW_SQL)} AND (${STATE}) = 'bookable'
 ORDER BY s.start_time LIMIT 1`

/** "2026-11" as its first and last day. */
function monthEnds(month: string): [string, string] {
  const [year, number] = month.split('-').map(Number) as [number, number]
  return [`${month}-01`, `${month}-${String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(2, '0')}`]
}

/** A month's days with a session bookable online, public and private apart, and the first from now whatever the month (WQ65). */
export async function shopBookingDays(db: Queryable, month: string): Promise<ShopBookingDaysRouteOutput> {
  const days = await namedRead<{ day: string; public: boolean; private: boolean }>(db, { name: 'shop.booking_days', sql: DAYS_SQL, params: monthEnds(month) })
  const first = await namedRead<{ day: string }>(db, { name: 'shop.first_booking_day', sql: FIRST_DAY_SQL })
  return {
    month,
    publicDays: days.filter((row) => row.public).map(({ day }) => day),
    privateDays: days.filter((row) => row.private).map(({ day }) => day),
    firstDay: first[0]?.day ?? null,
    lastDay: await sessionsMadeUpTo(db),
  }
}

// --- A day's sessions

interface SessionRow extends Record<string, unknown> {
  id: string
  service: string
  booking_type: 'public' | 'private'
  band_id: string
  band: string
  starts_at: string
  minutes: number
  spots_left: number
  state: OnlineSessionState
  prices: GroupPrice[]
}

/** The day's sessions as available-sessions.ts has them, with the online rule's answer, in one statement. */
const SESSIONS_SQL = `WITH on_day AS (${AVAILABLE_SESSIONS_SQL})
SELECT s.id, o.service_type_name AS service, o.booking_type, o.band_id, o.band_name AS band, ${londonIso('s.start_time')} AS starts_at,
       (EXTRACT(EPOCH FROM s.end_time - s.start_time) / 60)::int AS minutes, ${SPOTS_LEFT_SQL}::int AS spots_left, ${STATE} AS state, ${GROUPS_SQL} AS prices
  FROM on_day o JOIN sessions s ON s.id = o.id JOIN service_types st ON st.id = s.service_type_id
 ORDER BY s.start_time, o.service_type_name, s.id`

const onlineSession = (row: Pick<SessionRow, 'booking_type' | 'state' | 'spots_left' | 'prices'>): OnlineSession => ({
  type: row.booking_type,
  state: row.state,
  spotsLeft: row.spots_left,
  prices: row.prices,
})

/** What one visitor pays in each band, by the rule itself: asked of one session for each, since the band is what sets it. */
async function pricesByBand(db: Queryable, sessions: readonly SessionRow[]): Promise<Map<string, string>> {
  const prices = new Map<string, string>()
  for (const { id, band_id: band } of sessions) {
    if (prices.has(band)) continue
    const seat = (await quoteSeats(db, id, NO_ACCOUNT, 1))[0]
    if (seat) prices.set(band, seat.unit_price)
  }
  return prices
}

/**
 * One London date's sessions: public, and private by length. A session under the cut-off, blocked or otherwise not to
 * be had is left out; a full one stays, as `full`.
 */
export async function shopSessions(db: Queryable, date: string): Promise<ShopSessionsRouteOutput> {
  const rows = await namedRead<SessionRow>(db, { name: 'shop.sessions', sql: SESSIONS_SQL, params: [date, null, null] })
  const shown = rows.flatMap((row) => (row.state === 'bookable' || row.state === 'full' ? [{ ...row, state: row.state }] : []))
  const publicRows = shown.filter((row) => row.booking_type === 'public')
  const privateRows = shown.filter((row) => row.booking_type === 'private')
  const bandPrices = await pricesByBand(db, publicRows)
  const common = (row: (typeof shown)[number]) => ({
    id: row.id,
    startsAt: row.starts_at,
    minutes: row.minutes,
    service: row.service,
    band: row.band,
    state: row.state,
    mostPeople: mostPeopleOnline(onlineSession(row)),
  })
  const lengths = [...new Set(privateRows.map(({ minutes }) => minutes))].sort((a, b) => a - b)
  return {
    date,
    mostPeople: { public: MOST_PEOPLE.public, private: MOST_PEOPLE.private },
    public: publicRows.flatMap((row) => {
      const price = bandPrices.get(row.band_id)
      return price === undefined ? [] : [{ ...common(row), spotsLeft: row.spots_left, price }]
    }),
    private: lengths.map((minutes) => ({
      minutes,
      sessions: privateRows.filter((row) => row.minutes === minutes).map((row) => ({ ...common(row), prices: row.prices.map(({ from, to, price }) => ({ from, to, price })) })),
    })),
  }
}

// --- A group's price

const ONE_SESSION_SQL = `SELECT st.booking_type, ${STATE} AS state, ${SPOTS_LEFT_SQL}::int AS spots_left, ${GROUPS_SQL} AS prices
  FROM sessions s JOIN service_types st ON st.id = s.service_type_id WHERE s.id = $1::uuid`

type QuoteLine = ShopBookingQuoteRouteOutput['lines'][number]

const pounds = (inPence: number): string => (inPence / 100).toFixed(2)

/** The seats as lines: the booker, then the guests at each price they pay. */
function seatLines(seats: ReadonlyArray<{ seat_kind: 'account_holder' | 'guest'; unit_price: string }>): QuoteLine[] {
  const lines: QuoteLine[] = []
  for (const seat of seats) {
    const who = seat.seat_kind === 'account_holder' ? 'you' : 'guests'
    const line = lines.find((one) => one.who === who && one.each === seat.unit_price)
    if (line) line.people += 1
    else lines.push({ who, people: 1, each: seat.unit_price, total: seat.unit_price })
  }
  return lines.map((line) => ({ ...line, total: pounds(pence(line.each ?? '0') * line.people) }))
}

/** What a group of visitors pays for a session, or why it can't be booked. An unknown session is refused. */
export async function shopBookingQuote(db: Queryable, sessionId: string, people: number): Promise<ShopBookingQuoteRouteOutput> {
  const [row] = await namedRead<Pick<SessionRow, 'booking_type' | 'state' | 'spots_left' | 'prices'>>(db, { name: 'shop.booking_quote', sql: ONE_SESSION_SQL, params: [sessionId] })
  if (!row) throw new ApiError('NOT_FOUND', SHOP_WORDS.sessionNotFound, { field: 'session' })
  const session = onlineSession(row)
  const reason = onlineBookingRefusal(session, people)
  const answer = { session: sessionId, people, reason, mostPeople: mostPeopleOnline(session) }
  if (reason !== null) return { ...answer, total: null, lines: [] }
  if (session.type === 'private') {
    const total = groupPriceFor(session, people)?.price ?? null
    return { ...answer, total, lines: total === null ? [] : [{ who: 'group', people, each: null, total }] }
  }
  const lines = seatLines(await quoteSeats(db, sessionId, NO_ACCOUNT, people))
  return { ...answer, total: pounds(lines.reduce((sum, { total }) => sum + pence(total), 0)), lines }
}

// --- Add-ons

export interface ShopAddon {
  sanityId: string
  name: string
  /** Its category's word (`food_drink`, `amenities`, `services`); null when it has none. */
  category: string | null
  /** What a visitor pays for one. */
  price: string
}

type AddonRow = CatalogPrices & { sanity_addon_id: string | null; name: string; category: string | null }

/** Every add-on on sale with a price for a visitor, by its category then its name, as the catalogue lists them. */
export async function listShopAddons(db: Queryable): Promise<ShopAddon[]> {
  const rows = (await listAddons(db, { channel: 'customer' })) as unknown as AddonRow[]
  return rows.flatMap((row) => {
    const price = addonPriceFor(row, false)
    return row.sanity_addon_id === null || price === null ? [] : [{ sanityId: row.sanity_addon_id, name: row.name, category: row.category, price }]
  })
}

/** The add-ons on a connection of its own, for a page to call (no HTTP). */
export async function readShopAddons(): Promise<ShopAddon[]> {
  const db = openRequestDb()
  try {
    return await listShopAddons(db)
  } finally {
    await closeRequestDb(db)
  }
}
