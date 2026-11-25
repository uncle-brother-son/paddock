// Brief W77a (Wayne's WQ66): the one rule for "can this session still be booked online". Staff are not held to it: New
// Order books a session up to its start. Every read for the booking panel asks it here; the website's checkout must ask
// it too, again at Pay (briefs/W77a-report.md says where).
import 'server-only'
import type { ShopBookingRefusal } from '@/contracts'
import { MAX_GUESTS_PER_PRIVATE_BOOKING, MAX_GUESTS_PER_PUBLIC_BOOKING } from '@/server/rules/orders/guest-validation'
import { MADE_UP_TO_SQL } from '@/server/rules/sessions/admin'

/** Online booking closes this long before a session starts: at 31 minutes it can be booked, at 30 it can't. */
export const ONLINE_CUT_OFF_MINUTES = 30

/**
 * Why a session can or can't be booked by anybody online:
 * - `unavailable`: never shown. Blocked, its service off sale, no price for it, past the date sessions are made up to, or
 *   its time taken by a booking on another session;
 * - `closed`: under the cut-off, or started;
 * - `full`: no space left, or (private) taken.
 */
export type OnlineSessionState = 'bookable' | 'full' | 'closed' | 'unavailable'

/** A session's date as its stored digits have it (time/london-day-sql.ts). */
export const sessionDaySql = (session: string): string => `(${session}.start_time AT TIME ZONE 'UTC')::date`

/**
 * Whether the cut-off has passed. A start time is London wall-clock digits labelled UTC, so it is turned into the real
 * moment first: 30 real minutes, across both clock changes too, where the digits are an hour out.
 */
const closedSql = (session: string): string =>
  `((${session}.start_time AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London') - interval '${ONLINE_CUT_OFF_MINUTES} minutes' <= now()`

/**
 * A booking on another session at an overlapping time: what the table itself refuses a second booking for
 * (bookings_no_cross_session_overlap), so a little more than what available-sessions hides (a confirmed booking of
 * another type's). The first line is that constraint's own expression, so its index answers; the second leaves out a
 * booking with no times. GREATEST: an end before its start would raise.
 */
const takenSql = (session: string): string => `EXISTS (
      SELECT 1 FROM bookings other
      WHERE other.session_id <> ${session}.id AND other.status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'payment_needed'::text])
        AND tstzrange(other.start_time, other.end_time, '[)') && tstzrange(${session}.start_time, GREATEST(${session}.start_time, ${session}.end_time), '[)')
        AND other.start_time < ${session}.end_time AND other.end_time > ${session}.start_time)`

/** The session has a price to sell at: a public one its band (what quote_booking needs), a private one a size group with a price in its band. */
const pricedSql = (session: string, type: string): string => `CASE ${type}.booking_type
      WHEN 'public' THEN ${session}.type = 'public' AND ${session}.band_id IS NOT NULL
      WHEN 'private' THEN EXISTS (
        SELECT 1 FROM service_type_price_tiers tier
        WHERE tier.service_type_id = ${session}.service_type_id AND tier.band_id = ${session}.band_id
          AND tier.price IS NOT NULL AND tier.min_people <= ${MAX_GUESTS_PER_PRIVATE_BOOKING})
      ELSE false END`

/** The rule. `session` and `type` are the statement's aliases for a sessions row and its service_types row. */
export const onlineSessionStateSql = (session: string, type: string): string => `CASE
    WHEN ${session}.status <> 'open' OR ${type}.active IS NOT TRUE
      OR COALESCE(${sessionDaySql(session)} <= (${MADE_UP_TO_SQL})::date, false) IS NOT TRUE
      OR (${pricedSql(session, type)}) IS NOT TRUE
      OR ${takenSql(session)} THEN 'unavailable'
    WHEN ${closedSql(session)} THEN 'closed'
    WHEN (CASE ${type}.booking_type WHEN 'private' THEN ${session}.total_booked > 0 ELSE ${session}.total_booked >= ${session}.capacity END) THEN 'full'
    ELSE 'bookable' END`

/** The most people one booking may ever hold, from the checkout's own limits. */
export const MOST_PEOPLE = { public: MAX_GUESTS_PER_PUBLIC_BOOKING, private: MAX_GUESTS_PER_PRIVATE_BOOKING } as const

/** A private session's price for a group of `from` to `to` people, the whole group's. */
export interface GroupPrice {
  from: number
  to: number
  price: string
}

export interface OnlineSession {
  type: 'public' | 'private'
  state: OnlineSessionState
  /** Public only. */
  spotsLeft: number
  /** Private only, smallest group first. */
  prices: readonly GroupPrice[]
}

/** The most people who can book this session now: never above its spaces (public) or its largest group with a price (private). 0: nobody. */
export function mostPeopleOnline(session: OnlineSession): number {
  if (session.state !== 'bookable') return 0
  return session.type === 'public' ? Math.min(MOST_PEOPLE.public, session.spotsLeft) : Math.min(MOST_PEOPLE.private, Math.max(0, ...session.prices.map(({ to }) => to)))
}

/** A private session's price for this many people; null when no group with a price has them. */
export const groupPriceFor = (session: OnlineSession, people: number): GroupPrice | null => session.prices.find(({ from, to }) => from <= people && people <= to) ?? null

/** Why this many people can't book this session online, or null when they can. */
export function onlineBookingRefusal(session: OnlineSession, people: number): ShopBookingRefusal | null {
  if (session.state !== 'bookable') return session.state
  if (people > mostPeopleOnline(session)) return 'too_many'
  if (session.type === 'private' && groupPriceFor(session, people) === null) return 'unavailable'
  return null
}
