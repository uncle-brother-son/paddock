export interface SlotServiceTypeOption {
  service_type_id: string
  service_type_name: string
  booking_type: 'public' | 'private'
  duration: number
  /** The real, already-generated session row at this exact start_time for this service type —
   *  this is what's actually booked against. */
  session_id: string
  start_time: string
  end_time: string
  capacity: number
  total_booked: number
  status: string
  blocked_reason: string | null
  /** True when the session has already started (or is in the past) — start_time is stored as
   *  London wall-clock labelled UTC, so it's compared like for like against London wall-clock
   *  now, never against raw now(). */
  started: boolean
  band_id: string | null
  band_code: string | null
  band_name: string | null
  band_price: string | null
  band_overridden: boolean | null
}

export interface GetServiceTypesForSlotParams {
  /** The exact start_time (ISO timestamp) of the session backing the calendar card that was
   *  clicked — day-of-week and time-of-day are both derived from this. */
  startTime: string
}

/**
 * Resolves which Service Types are eligible to book at one exact, already-known time slot — used
 * by the "Add Booking" action on a day-view calendar card, which skips the normal date/session
 * picker entirely since the time is already fixed by whichever card was clicked.
 *
 * A service type is eligible when it has a `service_type_schedule_slots` row matching this exact
 * day-of-week + time-of-day (its own weekly schedule, same source generateUpcomingSessions.ts
 * reads), AND a real `sessions` row already exists for it at this exact start_time — required
 * because a booking must reference a real session id. A schedule slot with no matching generated
 * session (a schedule/generation gap) is left out for that structural reason alone; this
 * deliberately does NOT filter on capacity, status, or cross-session conflicts — those are surfaced
 * naturally when the actual booking attempt is made, per this app's "don't pre-check, let the real
 * attempt succeed or fail" policy for this flow.
 */
export default async function getServiceTypesForSlot(
  req: { params: GetServiceTypesForSlotParams }
): Promise<SlotServiceTypeOption[]> {
  const { startTime } = req.params

  const result = await paddockData.query<SlotServiceTypeOption>(
    `SELECT
       st.id AS service_type_id,
       st.name AS service_type_name,
       st.booking_type,
       st.duration,
       s.id AS session_id,
       s.start_time,
       s.end_time,
       s.capacity,
       s.total_booked,
       s.status,
       s.blocked_reason,
       (s.start_time AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'Europe/London') AS started,
       sb.id AS band_id,
       sb.code AS band_code,
       sb.name AS band_name,
       sb.price AS band_price,
       s.band_overridden
     FROM service_type_schedule_slots sl
     JOIN service_types st ON st.id = sl.service_type_id AND st.active = true
     JOIN sessions s ON s.service_type_id = st.id AND s.start_time = $1::timestamptz
     LEFT JOIN session_bands sb ON sb.id = s.band_id
     WHERE sl.day_of_week = EXTRACT(DOW FROM $2::timestamptz)::smallint
       AND sl.start_time = ($3::timestamptz)::time
     ORDER BY st.booking_type, st.name`,
    [startTime, startTime, startTime]
  )

  return result.data
}
