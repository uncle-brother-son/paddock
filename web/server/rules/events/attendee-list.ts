// New in W30: one event booking as the attendee list shows it, ported from the staff app's
// shared/eventAttendeeList.ts (loadEventAttendeeBookings, for one booking) so the place cancel answers the booking as
// it now stands and the screen updates its rows without reloading, as before. Read-only. The whole list stays the
// staff app's getEventAttendees until step G.
//
// New from W30 (Wayne's Q39): `order_id` and `refund_owed_amount`, the order that paid for the booking and the money
// still to refund on it, for the attendee list's owed line (the staff app's own loader reads the same two).
import 'server-only'
import type { EventAttendeeBooking, EventAttendeeRow } from '@/contracts'
import type { Queryable } from '@/server/db'

/** ExtraWaiverState for one attendee (aliases `ea`, `e`), as the staff app's EXTRA_WAIVER_STATE_SQL. */
const EXTRA_WAIVER_STATE_SQL = `CASE
    WHEN NOT e.has_extra_waiver THEN 'not_needed'
    WHEN NOT ea.event_waiver_accepted THEN 'pending'
    WHEN ea.event_waiver_version IS DISTINCT FROM e.extra_waiver_version THEN 'older_version'
    ELSE 'accepted'
  END`

const BOOKING_SQL = `
SELECT eb.id, eb.customer_id, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
       c.email AS customer_email, c.phone AS customer_phone, eb.status, eb.places, eb.price_paid::text AS price_paid,
       COALESCE((SELECT min(o.created_at) FROM order_line_items oli JOIN orders o ON o.id = oli.order_id
                 WHERE oli.event_booking_id = eb.id), eb.created_at) AS ordered_at,
       eb.cancelled_at, eb.cancel_reason,
       paid.order_id, COALESCE(paid.refund_owed_amount, 0)::numeric(10,2)::text AS refund_owed_amount
FROM event_bookings eb
JOIN customers c ON c.id = eb.customer_id
LEFT JOIN LATERAL (
  SELECT o.id AS order_id, o.refund_owed_amount
  FROM order_line_items oli JOIN orders o ON o.id = oli.order_id
  WHERE oli.event_booking_id = eb.id AND oli.item_type = 'event'
  ORDER BY oli.created_at, oli.id LIMIT 1
) paid ON true
WHERE eb.id = $1::uuid AND eb.status IN ('confirmed', 'cancelled')`

const ATTENDEES_SQL = `
SELECT ea.id, ea.event_booking_id, ea.attendee_type, ea.name, ea.email, ea.price_level, ea.unit_price::text AS unit_price,
       ea.waiver_accepted, ea.waiver_method, ea.waiver_accepted_at,
       ${EXTRA_WAIVER_STATE_SQL} AS extra_waiver_state, ea.event_waiver_method, ea.event_waiver_accepted_at,
       ea.checked_in_at, ea.cancelled_at, ea.cancel_reason,
       NULLIF(trim(concat_ws(' ', s.first_name, s.last_name)), '') AS cancelled_by_name,
       ea.cancelled_value::text AS cancelled_value, ea.refunded_amount::text AS refunded_amount,
       ea.card_refunded_amount::text AS card_refunded_amount, ea.refund_method, ea.refund_after_cutoff
FROM event_attendees ea
JOIN event_bookings eb ON eb.id = ea.event_booking_id
JOIN events e ON e.id = eb.event_id
LEFT JOIN staff s ON s.id = ea.cancelled_by
WHERE eb.id = $1::uuid AND eb.status IN ('confirmed', 'cancelled')
ORDER BY (ea.attendee_type = 'account_holder') DESC, ea.created_at, ea.id`

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value))

type BookingRow = Omit<EventAttendeeBooking, 'attendees' | 'ordered_at' | 'cancelled_at'> & { ordered_at: unknown; cancelled_at: unknown }
type AttendeeRow = Omit<EventAttendeeRow, 'waiver_accepted_at' | 'event_waiver_accepted_at' | 'checked_in_at' | 'cancelled_at'> & {
  waiver_accepted_at: unknown
  event_waiver_accepted_at: unknown
  checked_in_at: unknown
  cancelled_at: unknown
}

/** The booking with its attendees in place order, or null when it doesn't exist or its reader payment is still open. */
export async function loadEventAttendeeBooking(db: Queryable, eventBookingId: string): Promise<EventAttendeeBooking | null> {
  const booking = (await db.query<BookingRow>(BOOKING_SQL, [eventBookingId]))[0]
  if (!booking) return null
  const attendees = await db.query<AttendeeRow>(ATTENDEES_SQL, [eventBookingId])
  return {
    ...booking,
    places: Number(booking.places),
    ordered_at: iso(booking.ordered_at) ?? '',
    cancelled_at: iso(booking.cancelled_at),
    attendees: attendees.map((attendee) => ({
      ...attendee,
      waiver_accepted_at: iso(attendee.waiver_accepted_at),
      event_waiver_accepted_at: iso(attendee.event_waiver_accepted_at),
      checked_in_at: iso(attendee.checked_in_at),
      cancelled_at: iso(attendee.cancelled_at),
    })),
  }
}
