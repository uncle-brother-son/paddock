export interface SessionSlotRow {
  id: string
  service_type_id: string
  service_type_name: string
  booking_type: 'public' | 'private'
  start_time: string
  end_time: string
  capacity: number
  total_booked: number
  status: string
  blocked_reason: string | null
  blocked_by: string | null
  /** True when the session has already started (or is in the past) — start_time is stored as
   *  London wall-clock labelled UTC, so it's compared like for like against London wall-clock
   *  now, never against raw now(). */
  started: boolean
  confirmed_booking_count: number
  band_id: string | null
  band_code: string | null
  band_name: string | null
  band_price: string | null
  band_overridden: boolean | null
}

export interface GetSessionsForRangeParams {
  /** Inclusive, both "YYYY-MM-DD". Pass the same value for both to fetch a single day (this
   *  generalizes what used to be getSessionsForDay.ts — the Day view now just calls this with
   *  startDate === endDate). */
  startDate: string
  endDate: string
}

/**
 * Every session (including zero-booking ones) whose start_time falls on any date in
 * [startDate, endDate] inclusive. Used by the Day, Week, and Month calendar views alike — each
 * groups the flat result by date client-side (see dayViewSlots.ts's buildDaySlotCards, run once
 * per date) so there's a single source of truth for how a day's sessions collapse into cards,
 * shared across all three granularities rather than re-implemented per view.
 */
export default async function getSessionsForRange(
  req: { params: GetSessionsForRangeParams }
): Promise<SessionSlotRow[]> {
  const { startDate, endDate } = req.params

  const result = await paddockData.query<SessionSlotRow>(
    `SELECT
       s.id,
       s.service_type_id,
       st.name AS service_type_name,
       st.booking_type,
       s.start_time,
       s.end_time,
       s.capacity,
       s.total_booked,
       s.status,
       s.blocked_reason,
       s.blocked_by,
       (s.start_time AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'Europe/London') AS started,
       sb.id AS band_id,
       sb.code AS band_code,
       sb.name AS band_name,
       sb.price AS band_price,
       s.band_overridden,
       COUNT(b.id) FILTER (WHERE b.status = 'confirmed')::int AS confirmed_booking_count
     FROM sessions s
     JOIN service_types st ON st.id = s.service_type_id
     LEFT JOIN session_bands sb ON sb.id = s.band_id
     LEFT JOIN bookings b ON b.session_id = s.id
     WHERE s.start_time::date BETWEEN $1::date AND $2::date
     GROUP BY s.id, st.name, st.booking_type, sb.id, sb.code, sb.name, sb.price, s.band_overridden
     ORDER BY s.start_time`,
    [startDate, endDate]
  )

  return result.data
}
