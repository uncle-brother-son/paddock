// New in W30: one event booking as the attendee list shows it, ported from the staff app's
// shared/eventAttendeeList.ts (loadEventAttendeeBookings, for one booking) so the place cancel answers the booking as
// it now stands and the screen updates its rows without reloading, as before. Read-only.
//
// New from W30 (Wayne's Q39): `order_id` and `refund_owed_amount`, the order that paid for the booking and the money
// still to refund on it, for the attendee list's owed line (the staff app's own loader reads the same two).
//
// W52: the whole list moved here too (loadEventAttendeeBookings, for one event), for getEventAttendees
// (server/rules/events/attendance.ts). The list also says, for each booking, whether a refund of its own money is
// still being checked (`refund_open`; W35 audit row 18), so the screen can tell a cancelled place's shortfall that is
// still being checked from one that is owed and one that has been settled since. W52a (W52 review "For later" 3):
// that is an open claim on the booking itself, or an open Refund the rest on its order, not any claim that holds the
// order (refunds/claims.ts, eventBookingRefundOpenSql): with two event bookings on one order, a refund of one being
// checked no longer makes the other's settled shortfall read "still being checked". The one booking a place cancel
// answers is unchanged: it doesn't carry `refund_open` (the screen reads the list again).
import 'server-only'
import type { EventAttendeeBooking, EventAttendeeRow, EventAttendeesRouteOutput } from '@/contracts'
import type { Queryable } from '@/server/db'
import { eventBookingRefundOpenSql } from '@/server/rules/refunds/claims'

/** ExtraWaiverState for one attendee (aliases `ea`, `e`), as the staff app's EXTRA_WAIVER_STATE_SQL. An older version of the extra waiver is not "accepted". */
export const EXTRA_WAIVER_STATE_SQL = `CASE
    WHEN NOT e.has_extra_waiver THEN 'not_needed'
    WHEN NOT ea.event_waiver_accepted THEN 'pending'
    WHEN ea.event_waiver_version IS DISTINCT FROM e.extra_waiver_version THEN 'older_version'
    ELSE 'accepted'
  END`

/** The bookings named by `where` (confirmed or cancelled: a pending reader payment is left out), each with its customer, when it was ordered and the order that paid for it. */
const bookingsSql = (where: string, more = ''): string => `
SELECT eb.id, eb.customer_id, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
       c.email AS customer_email, c.phone AS customer_phone, eb.status, eb.places, eb.price_paid::text AS price_paid,
       COALESCE((SELECT min(o.created_at) FROM order_line_items oli JOIN orders o ON o.id = oli.order_id
                 WHERE oli.event_booking_id = eb.id), eb.created_at) AS ordered_at,
       eb.cancelled_at, eb.cancel_reason,
       paid.order_id, COALESCE(paid.refund_owed_amount, 0)::numeric(10,2)::text AS refund_owed_amount${more}
FROM event_bookings eb
JOIN customers c ON c.id = eb.customer_id
LEFT JOIN LATERAL (
  SELECT o.id AS order_id, o.refund_owed_amount
  FROM order_line_items oli JOIN orders o ON o.id = oli.order_id
  WHERE oli.event_booking_id = eb.id AND oli.item_type = 'event'
  ORDER BY oli.created_at, oli.id LIMIT 1
) paid ON true
WHERE ${where} AND eb.status IN ('confirmed', 'cancelled')`

/** Their places, the account holder first, then in the order booked. */
const attendeesSql = (where: string): string => `
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
WHERE ${where} AND eb.status IN ('confirmed', 'cancelled')
ORDER BY (ea.attendee_type = 'account_holder') DESC, ea.created_at, ea.id`

const BOOKING_SQL = bookingsSql('eb.id = $1::uuid')
const ATTENDEES_SQL = attendeesSql('eb.id = $1::uuid')

/**
 * W52: one event's bookings, in booking order (and by id, so two made in the same moment keep one order), each with
 * `refund_open`: a refund of the booking's own money is still being checked (W35 audit row 18; W52a: its own claim,
 * or a Refund the rest on the order that paid for it). A booking with no order can still have a claim of its own.
 */
const EVENT_BOOKINGS_SQL = `${bookingsSql('eb.event_id = $1::uuid', `,
       ${eventBookingRefundOpenSql('eb.id::text', 'paid.order_id::text')} AS refund_open`)}
ORDER BY eb.created_at, eb.id`
const EVENT_ATTENDEES_SQL = attendeesSql('eb.event_id = $1::uuid')

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value))

type BookingRow = Omit<EventAttendeeBooking, 'attendees' | 'ordered_at' | 'cancelled_at'> & { ordered_at: unknown; cancelled_at: unknown }
type AttendeeRow = Omit<EventAttendeeRow, 'waiver_accepted_at' | 'event_waiver_accepted_at' | 'checked_in_at' | 'cancelled_at'> & {
  waiver_accepted_at: unknown
  event_waiver_accepted_at: unknown
  checked_in_at: unknown
  cancelled_at: unknown
}

const attendeeOf = (attendee: AttendeeRow): EventAttendeeRow => ({
  ...attendee,
  waiver_accepted_at: iso(attendee.waiver_accepted_at),
  event_waiver_accepted_at: iso(attendee.event_waiver_accepted_at),
  checked_in_at: iso(attendee.checked_in_at),
  cancelled_at: iso(attendee.cancelled_at),
})

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
    attendees: attendees.map(attendeeOf),
  }
}

type ListBooking = EventAttendeesRouteOutput['bookings'][number]

/**
 * W52: every booking of one event as the attendee list shows it: confirmed and cancelled, in booking order, each
 * with its places in place order (cancelled places and fully cancelled bookings are there for history), the money
 * still to refund on its order and whether a refund of its own money is still being checked.
 */
export async function loadEventAttendeeBookings(db: Queryable, eventId: string): Promise<ListBooking[]> {
  const bookings = await db.query<BookingRow & { refund_open: unknown }>(EVENT_BOOKINGS_SQL, [eventId])
  if (bookings.length === 0) return []
  const attendees = await db.query<AttendeeRow>(EVENT_ATTENDEES_SQL, [eventId])
  const byBooking = new Map<string, EventAttendeeRow[]>()
  for (const attendee of attendees) {
    const list = byBooking.get(attendee.event_booking_id) ?? []
    list.push(attendeeOf(attendee))
    byBooking.set(attendee.event_booking_id, list)
  }
  return bookings.map(
    (booking) =>
      ({
        ...booking,
        places: Number(booking.places),
        ordered_at: iso(booking.ordered_at) ?? '',
        cancelled_at: iso(booking.cancelled_at),
        refund_open: booking.refund_open === true,
        attendees: byBooking.get(booking.id) ?? [],
      }) as ListBooking
  )
}
