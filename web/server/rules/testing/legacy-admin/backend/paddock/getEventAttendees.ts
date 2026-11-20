import { CHECK_IN_WINDOW_SQL, type CheckInWindow } from './shared/eventAttendance'
import { loadEventAttendeeBookings, type EventAttendeeBooking } from './shared/eventAttendeeList'

export type { EventAttendeeBooking, EventAttendeeRow } from './shared/eventAttendeeList'

export interface GetEventAttendeesParams {
  eventId: string
}

export interface EventAttendeesResult {
  event: {
    id: string
    name: string
    /** London wall-clock digits labelled UTC, like session times. */
    starts_at: string | null
    ends_at: string | null
    capacity: number | null
    places_booked: number
    has_extra_waiver: boolean
    refund_cutoff_at: string | null
    cancelled_at: string | null
    cancel_reason: string | null
  } | null
  /** Open on the event's London date (until ends_at when later); closed after. */
  checkInWindow: CheckInWindow
  /** Confirmed and cancelled bookings, in booking order; attendees in place order. Cancelled
   *  places and bookings are there for history only. */
  bookings: EventAttendeeBooking[]
}

/** The attendee list for one event (all staff, read-only). */
export default async function getEventAttendees(req: { params: GetEventAttendeesParams }): Promise<EventAttendeesResult> {
  const { eventId } = req.params

  const [eventLookup, bookings] = await Promise.all([
    paddockData.query<NonNullable<EventAttendeesResult['event']> & { check_in_window: CheckInWindow }>(
      `SELECT e.id, e.name, e.starts_at, e.ends_at, e.capacity, e.places_booked, e.has_extra_waiver, e.refund_cutoff_at,
              e.cancelled_at, e.cancel_reason, ${CHECK_IN_WINDOW_SQL} AS check_in_window
       FROM events e
       WHERE e.id = $1`,
      [eventId]
    ),
    loadEventAttendeeBookings({ eventId }),
  ])

  const eventRow = eventLookup.data[0]
  if (!eventRow) return { event: null, checkInWindow: 'not_open', bookings: [] }
  const { check_in_window, ...event } = eventRow
  return { event, checkInWindow: check_in_window, bookings }
}
