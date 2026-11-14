/**
 * Read-only: an event's bookings and attendees as the attendee list shows them. Used by
 * getEventAttendees (the whole event) and cancelEventPlaces (the one booking it changed, so the
 * screen can update its rows without reloading). No write SQL here (see CLAUDE.md): read-only
 * getters import this.
 *
 * Cancelled places and fully cancelled bookings are included for history, with their cancellation
 * and refund details; every count, check-in and waiver action ignores them.
 */
import { EXTRA_WAIVER_STATE_SQL, type ExtraWaiverState } from './eventAttendance'

export interface EventAttendeeRow {
  id: string
  event_booking_id: string
  attendee_type: 'account_holder' | 'guest'
  name: string
  email: string | null
  price_level: 'public' | 'pre_herd' | 'herd'
  /** Price paid for this place, net of its promo share. */
  unit_price: string
  waiver_accepted: boolean
  waiver_method: 'email_link' | 'in_person' | 'checkout' | null
  waiver_accepted_at: string | null
  extra_waiver_state: ExtraWaiverState
  event_waiver_method: 'email_link' | 'in_person' | 'checkout' | null
  event_waiver_accepted_at: string | null
  checked_in_at: string | null
  /** Set when this place was cancelled (it stays in the list for history). */
  cancelled_at: string | null
  cancel_reason: string | null
  /** First and last name of the staff member who cancelled it. */
  cancelled_by_name: string | null
  /** What the place was worth when cancelled, refunded or not. */
  cancelled_value: string
  /** Card + store credit given back for this place. */
  refunded_amount: string
  card_refunded_amount: string
  refund_method: 'card' | 'credit' | 'none' | null
  refund_after_cutoff: boolean
}

export interface EventAttendeeBooking {
  id: string
  customer_id: string
  customer_first_name: string
  customer_last_name: string
  customer_email: string | null
  customer_phone: string | null
  status: 'confirmed' | 'cancelled'
  /** Places still booked (cancelled places are taken off). */
  places: number
  price_paid: string
  /** The order's date, or the booking's own when it has no order line. */
  ordered_at: string
  cancelled_at: string | null
  cancel_reason: string | null
  attendees: EventAttendeeRow[]
}

/** The bookings of one event (`eventId`) or one booking (`eventBookingId`), confirmed or
 *  cancelled (pending reader payments are left out), in booking order; attendees in place order. */
export async function loadEventAttendeeBookings(
  scope: { eventId: string } | { eventBookingId: string }
): Promise<EventAttendeeBooking[]> {
  const byEvent = 'eventId' in scope
  const key = byEvent ? scope.eventId : scope.eventBookingId
  const where = byEvent ? 'eb.event_id = $1' : 'eb.id = $1'

  const [bookingLookup, attendeeLookup] = await Promise.all([
    paddockData.query<Omit<EventAttendeeBooking, 'attendees'>>(
      `SELECT eb.id, eb.customer_id, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
              c.email AS customer_email, c.phone AS customer_phone, eb.status, eb.places, eb.price_paid,
              COALESCE((SELECT min(o.created_at) FROM order_line_items oli JOIN orders o ON o.id = oli.order_id
                        WHERE oli.event_booking_id = eb.id), eb.created_at) AS ordered_at,
              eb.cancelled_at, eb.cancel_reason
       FROM event_bookings eb
       JOIN customers c ON c.id = eb.customer_id
       WHERE ${where} AND eb.status IN ('confirmed', 'cancelled')
       ORDER BY eb.created_at`,
      [key]
    ),
    paddockData.query<EventAttendeeRow>(
      `SELECT ea.id, ea.event_booking_id, ea.attendee_type, ea.name, ea.email, ea.price_level, ea.unit_price,
              ea.waiver_accepted, ea.waiver_method, ea.waiver_accepted_at,
              ${EXTRA_WAIVER_STATE_SQL} AS extra_waiver_state, ea.event_waiver_method, ea.event_waiver_accepted_at,
              ea.checked_in_at, ea.cancelled_at, ea.cancel_reason,
              NULLIF(trim(concat_ws(' ', s.first_name, s.last_name)), '') AS cancelled_by_name,
              ea.cancelled_value, ea.refunded_amount, ea.card_refunded_amount, ea.refund_method, ea.refund_after_cutoff
       FROM event_attendees ea
       JOIN event_bookings eb ON eb.id = ea.event_booking_id
       JOIN events e ON e.id = eb.event_id
       LEFT JOIN staff s ON s.id = ea.cancelled_by
       WHERE ${where} AND eb.status IN ('confirmed', 'cancelled')
       ORDER BY (ea.attendee_type = 'account_holder') DESC, ea.created_at, ea.id`,
      [key]
    ),
  ])

  const byBooking = new Map<string, EventAttendeeRow[]>()
  for (const attendee of attendeeLookup.data) {
    const list = byBooking.get(attendee.event_booking_id) ?? []
    list.push(attendee)
    byBooking.set(attendee.event_booking_id, list)
  }
  return bookingLookup.data.map((b) => ({ ...b, attendees: byBooking.get(b.id) ?? [] }))
}
