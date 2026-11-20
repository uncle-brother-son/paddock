import type { BookingListRow } from './getBookings'

export interface GetBookingByIdParams {
  bookingId: string
}

/**
 * Fetches ONE booking row fresh from the database, shaped exactly like a getBookings row
 * (BookingListRow) so the Overview page's booking detail dialog can open on live data instead of
 * the row snapshot captured when the page's lists were loaded. Returns null when the booking
 * does not exist.
 */
export default async function getBookingById(
  req: { params: GetBookingByIdParams }
): Promise<BookingListRow | null> {
  const bookingId = req.params?.bookingId
  if (!bookingId) {
    return null
  }

  const result = await paddockData.query<BookingListRow>(
    `
    SELECT
      b.*,
      s.start_time,
      s.end_time,
      s.service_type_id,
      st.name AS service_type_name,
      st.booking_type,
      c.first_name AS customer_first_name,
      c.last_name AS customer_last_name,
      c.email AS customer_email,
      ord.payment_method
    FROM bookings b
    JOIN sessions s ON s.id = b.session_id
    JOIN service_types st ON st.id = s.service_type_id
    JOIN customers c ON c.id = b.customer_id
    LEFT JOIN LATERAL (
      -- The booking's OWN order: the earliest booking line whose order recorded a payment method
      -- (else the earliest). Later guest / add-on payments are separate orders and must never
      -- decide how the session was paid (a cash add-on on a card booking made it "Paid in cash").
      -- A credit booking settled later by card has no method on its first order, so the settling
      -- payment counts. orders.payment_method records how the order was actually settled.
      SELECT o.payment_method
      FROM order_line_items oli
      JOIN orders o ON o.id = oli.order_id
      WHERE oli.booking_id = b.id
      ORDER BY (o.payment_method IS NULL), oli.created_at ASC
      LIMIT 1
    ) ord ON true
    WHERE b.id = $1
    LIMIT 1
  `,
    [bookingId]
  )
  return result.data[0] ?? null
}
