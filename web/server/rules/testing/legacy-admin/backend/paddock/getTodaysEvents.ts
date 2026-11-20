import { EXTRA_WAIVER_OUTSTANDING_SQL } from './shared/eventAttendance'

export interface TodaysEventRow {
  id: string
  name: string
  /** London wall-clock digits labelled UTC, like session times. */
  starts_at: string
  ends_at: string | null
  capacity: number | null
  places_booked: number
  has_extra_waiver: boolean
  /** Attendees on confirmed bookings. */
  attendee_count: number
  checked_in_count: number
  standard_waivers_outstanding: number
  extra_waivers_outstanding: number
}

export interface EventWaiverGapRow {
  /** event_attendees.id */
  id: string
  name: string
  attendee_type: 'account_holder' | 'guest'
  event_id: string
  event_name: string
  starts_at: string
  customer_first_name: string
  customer_last_name: string
  standard_outstanding: boolean
  extra_outstanding: boolean
}

export interface TodaysEventsResult {
  events: TodaysEventRow[]
  /** Today's attendees (confirmed bookings) with a standard or extra waiver outstanding. */
  waiverGaps: EventWaiverGapRow[]
}

/** Events on London's today that aren't cancelled, for the Overview (all staff, read-only). */
export default async function getTodaysEvents(): Promise<TodaysEventsResult> {
  // starts_at holds London wall-clock digits labelled UTC, so its UTC date is the London date.
  const today = `(e.starts_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'Europe/London')::date AND e.cancelled_at IS NULL`

  const [events, gaps] = await Promise.all([
    paddockData.query<TodaysEventRow>(
      `SELECT e.id, e.name, e.starts_at, e.ends_at, e.capacity, e.places_booked, e.has_extra_waiver,
              count(ea.id)::int AS attendee_count,
              count(ea.checked_in_at)::int AS checked_in_count,
              count(ea.id) FILTER (WHERE NOT ea.waiver_accepted)::int AS standard_waivers_outstanding,
              count(ea.id) FILTER (WHERE ${EXTRA_WAIVER_OUTSTANDING_SQL})::int AS extra_waivers_outstanding
       FROM events e
       LEFT JOIN event_bookings eb ON eb.event_id = e.id AND eb.status = 'confirmed'
       LEFT JOIN event_attendees ea ON ea.event_booking_id = eb.id AND ea.cancelled_at IS NULL
       WHERE ${today}
       GROUP BY e.id
       ORDER BY e.starts_at, e.name`
    ),
    paddockData.query<EventWaiverGapRow>(
      `SELECT ea.id, ea.name, ea.attendee_type, e.id AS event_id, e.name AS event_name, e.starts_at,
              c.first_name AS customer_first_name, c.last_name AS customer_last_name,
              NOT ea.waiver_accepted AS standard_outstanding, ${EXTRA_WAIVER_OUTSTANDING_SQL} AS extra_outstanding
       FROM event_attendees ea
       JOIN event_bookings eb ON eb.id = ea.event_booking_id AND eb.status = 'confirmed'
       JOIN events e ON e.id = eb.event_id
       JOIN customers c ON c.id = eb.customer_id
       WHERE ${today}
         AND ea.cancelled_at IS NULL
         AND (NOT ea.waiver_accepted OR ${EXTRA_WAIVER_OUTSTANDING_SQL})
       ORDER BY e.starts_at, e.name, ea.name`
    ),
  ])
  return { events: events.data, waiverGaps: gaps.data }
}
