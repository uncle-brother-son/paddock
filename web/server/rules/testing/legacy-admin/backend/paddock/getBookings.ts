export interface BookingListRow {
  id: string
  session_id: string
  customer_id: string
  party_size: number
  status: string
  price_paid: string
  stripe_payment_id: string | null
  redemption_source: string | null
  /** The booking's special requests (dietary/accessibility needs etc.) — null when none. */
  special_requests: string | null
  /** The credit period seat 1 drew from — set only when a membership credit was really claimed;
   *  null for paid bookings, session-pass credits, and credit bookings that fell back to paid. */
  credit_period_id: string | null
  /** How the booking's order was actually paid — orders.payment_method ('card' | 'reader' |
   *  'cash' | 'gift_card' | 'split' | null). Null when the booking has no order line (legacy
   *  data) or nothing was owed. Drives the "paid in cash vs card" label and the default refund
   *  method in the booking detail UI. */
  payment_method: string | null
  checked_in_at: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
  start_time: string
  end_time: string
  service_type_id: string
  service_type_name: string
  booking_type: 'public' | 'private'
  customer_first_name: string
  customer_last_name: string
  customer_email: string
}

export interface GetBookingsParams {
  startDate?: string
  endDate?: string
  status?: string
}

export default async function getBookings(req: { params: GetBookingsParams }): Promise<BookingListRow[]> {
  const { startDate, endDate, status } = req.params ?? {}

  const conditions: string[] = []
  const values: unknown[] = []

  if (startDate) {
    values.push(startDate)
    conditions.push(`s.start_time >= $${values.length}::date`)
  }
  if (endDate) {
    values.push(endDate)
    conditions.push(`s.start_time < ($${values.length}::date + interval '1 day')`)
  }
  if (status) {
    values.push(status)
    conditions.push(`b.status = $${values.length}`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const sql = `
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
    ${whereClause}
    ORDER BY s.start_time DESC
  `

  const result = await paddockData.query<BookingListRow>(sql, values)
  return result.data
}
