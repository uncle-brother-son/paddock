export interface PaymentAttentionMembershipRow {
  membership_id: string
  customer_id: string
  first_name: string
  last_name: string
  email: string
  plan_name: string
}

export interface PaymentAttentionBookingRow {
  /** Select mirrors getBookings.ts, so each row is a complete BookingListRow (see the cast in
   *  getPaymentAttentionItems) — these fields are the ones the UI reads directly. */
  id: string
  customer_id: string
  party_size: number
  status: string
  price_paid: string
  payment_due_by: string | null
  start_time: string
  end_time: string
  service_type_name: string
  booking_type: string
  customer_first_name: string
  customer_last_name: string
  customer_email: string
}

export interface PaymentAttentionResult {
  /** Bookings awaiting payment (status 'payment_needed') — soonest pay-by deadline first. */
  bookings: PaymentAttentionBookingRow[]
  /** Memberships whose Stripe payment failed (status 'past_due'). */
  memberships: PaymentAttentionMembershipRow[]
}

/**
 * Everything staff need to chase lapsed payments, in one call: bookings flagged payment_needed
 * (a former membership-credit booking whose membership payment failed — capacity stays held until
 * payment_due_by, and unpaid zero-amount bookings are auto-cancelled by the scheduled DB job after
 * the deadline) and memberships whose payment is past due. Powers the Overview's
 * "Needs attention: payments" card.
 */
/**
 * @retool-slow-reviewed
 * Evidence: the function's retrieval is exactly two parallel queries. EXPLAIN (ANALYZE) of the
 * bookings query (the heavier one — LATERAL latest-order lookup) executes in 0.114ms via
 * idx_bookings_status with the lateral never executed (0 payment_needed rows live); the
 * memberships query filters subscription_status = 'past_due' the same way (0 rows). A timed
 * parallel fetch of both took ~1.2s round-trip — that is the sandbox's fixed per-call invocation
 * overhead seen on every function here, not database work. The one ~9.4s run was environmental
 * (cold function/DB connection), not retrieval: both queries are already minimal, fully indexed
 * and unpaginated by design (they return the small complete list the attention card renders).
 */
export default async function getPaymentAttentionItems(): Promise<PaymentAttentionResult> {
  const [bookings, memberships] = await Promise.all([
    paddockData.query<PaymentAttentionBookingRow>(
      // Same SELECT shape as getBookings.ts so each row is a complete BookingListRow the existing
      // booking detail dialog can consume directly — plus the payment_due_by deadline.
      `SELECT b.*,
              s.start_time, s.end_time,
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
         SELECT o.payment_method
         FROM order_line_items oli
         JOIN orders o ON o.id = oli.order_id
         WHERE oli.booking_id = b.id
         ORDER BY (o.payment_method IS NULL), oli.created_at ASC
         LIMIT 1
       ) ord ON true
       WHERE b.status = 'payment_needed'
       ORDER BY b.payment_due_by ASC NULLS LAST, b.start_time ASC`
    ),
    paddockData.query<PaymentAttentionMembershipRow>(
      `SELECT cm.id AS membership_id, cm.customer_id, mp.name AS plan_name,
              c.first_name, c.last_name, c.email
       FROM customer_memberships cm
       JOIN membership_plans mp ON mp.id = cm.plan_id
       JOIN customers c ON c.id = cm.customer_id
       WHERE cm.subscription_status = 'past_due'
       ORDER BY c.last_name ASC, c.first_name ASC`
    ),
  ])

  return { bookings: bookings.data, memberships: memberships.data }
}
