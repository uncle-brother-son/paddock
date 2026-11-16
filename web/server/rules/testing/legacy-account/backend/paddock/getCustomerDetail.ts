import { EXTRA_WAIVER_OUTSTANDING_SQL } from './shared/eventAttendance'
import {
  PAYMENT_DATE_CHANGE_COLUMNS_SQL,
  PAYMENT_DATE_CHANGE_JOIN_SQL,
  paymentDateChangeStatus,
  withoutPaymentDateFacts,
  type PaymentDateChangeFacts,
  type PaymentDateChangeStatus,
} from './shared/membershipPaymentDate'

export interface CustomerMembershipRow extends PaymentDateChangeStatus {
  id: string
  customer_id: string
  plan_id: string
  plan_name: string
  billing_frequency: string | null
  subscription_status: string | null
  start_date: string
  next_renewal_date: string | null
  cancel_effective_date: string | null
  addon_credits_remaining: number
  bonus_addon_credits: number
  /** Herd membership flag — add-on credits are usable if and only if this is true. */
  is_herd: boolean
  /** Manual Herd override by staff (null = automatic rule: yearly, or monthly past the wait). */
  herd_override: boolean | null
  stripe_subscription_id: string | null
  /** Whether the plan is unlimited — session credit display comes from the CURRENT period. */
  plan_is_unlimited: boolean
  /** Current credit period (from membership_current_credits) — null when no period covers today. */
  current_period_end: string | null
  current_period_credits_allocated: number | null
  current_period_credits_remaining: number | null
  created_at: string
  updated_at: string
}

export interface CustomerSessionPassRow {
  id: string
  customer_id: string
  pass_type_id: string
  pass_type_name: string
  /** The pass type's level — 'core' passes can't be used on Peak sessions. */
  pass_type_level: 'core' | 'all_access'
  purchase_date: string
  expiry_date: string | null
  sessions_remaining: number
  created_at: string
  updated_at: string
}

export interface CustomerBookingHistoryRow {
  id: string
  status: string
  party_size: number
  price_paid: string
  start_time: string
  end_time: string
  service_type_name: string
  checked_in_at: string | null
  /** Set while the booking is awaiting payment (status 'payment_needed') — the pay-by deadline. */
  payment_due_by: string | null
  created_at: string
}

export interface GetCustomerDetailParams {
  customerId: string
}

export interface StoreCreditTransactionRow {
  id: string
  /** Signed amount in pounds — positive added credit, negative redeemed/removed credit. */
  amount: string
  /** The customer's store_credit_balance immediately after this movement. */
  balance_after: string
  reason: string
  note: string | null
  order_id: string | null
  booking_id: string | null
  created_at: string
}

/** One of the customer's event bookings, for the profile's Events list. */
export interface CustomerEventBookingRow {
  id: string
  event_id: string
  event_name: string
  /** Wall-clock digits labelled UTC, like session times. */
  event_starts_at: string | null
  places: number
  status: 'pending' | 'confirmed' | 'cancelled'
  price_paid: string
  created_at: string
  /** Places still booked (cancelled places left out of these three counts). */
  attendee_count: number
  checked_in_count: number
  /** Attendees with the standard and/or extra waiver outstanding (an extra waiver signed on an
   *  older version counts as outstanding). */
  waivers_outstanding: number
  /** Places booked originally (cancelled ones included). */
  places_total: number
  cancelled_places: number
  /** Card + store credit given back for cancelled places, and the card part of it. */
  refunded_amount: string
  card_refunded_amount: string
  /** Set when the event itself was cancelled. */
  event_cancelled_at: string | null
}

export interface CustomerDetail {
  memberships: CustomerMembershipRow[]
  sessionPasses: CustomerSessionPassRow[]
  bookingHistory: CustomerBookingHistoryRow[]
  /** Current store_credit_balance (customers.store_credit_balance). */
  storeCreditBalance: string
  /** Newest-first store credit movements. Empty when the customer has none. */
  storeCreditHistory: StoreCreditTransactionRow[]
  /** Event bookings, latest event first. */
  eventBookings: CustomerEventBookingRow[]
}

export default async function getCustomerDetail(req: { params: GetCustomerDetailParams }): Promise<CustomerDetail> {
  const { customerId } = req.params

  const [memberships, sessionPasses, bookingHistory, storeCredit, eventBookings] = await Promise.all([
    paddockData.query<Omit<CustomerMembershipRow, keyof PaymentDateChangeStatus> & PaymentDateChangeFacts>(
      `SELECT cm.*, mp.name AS plan_name, mp.is_unlimited AS plan_is_unlimited,
              mcc.period_end AS current_period_end, mcc.credits_allocated AS current_period_credits_allocated,
              mcc.credits_remaining AS current_period_credits_remaining,
              ${PAYMENT_DATE_CHANGE_COLUMNS_SQL}
       FROM customer_memberships cm
       JOIN membership_plans mp ON mp.id = cm.plan_id
       JOIN customers c ON c.id = cm.customer_id
       LEFT JOIN membership_current_credits mcc ON mcc.membership_id = cm.id
       ${PAYMENT_DATE_CHANGE_JOIN_SQL}
       WHERE cm.customer_id = $1
       ORDER BY cm.created_at DESC`,
      [customerId]
    ),
    paddockData.query<CustomerSessionPassRow>(
      `SELECT csp.*, spt.name AS pass_type_name, spt.level AS pass_type_level
       FROM customer_session_passes csp
       JOIN session_pass_types spt ON spt.id = csp.pass_type_id
       WHERE csp.customer_id = $1
       ORDER BY csp.created_at DESC`,
      [customerId]
    ),
    paddockData.query<CustomerBookingHistoryRow>(
      `SELECT b.id, b.status, b.party_size, b.price_paid, b.checked_in_at, b.created_at,
              b.payment_due_by,
              s.start_time, s.end_time, st.name AS service_type_name
       FROM bookings b
       JOIN sessions s ON s.id = b.session_id
       JOIN service_types st ON st.id = s.service_type_id
       WHERE b.customer_id = $1
       ORDER BY s.start_time DESC`,
      [customerId]
    ),
    (async () => {
      // Store credit balance + movement history in one parallel branch. A missing customer row
      // degrades to a £0 balance with no history rather than failing the whole profile.
      const [balanceLookup, historyLookup] = await Promise.all([
        paddockData.query<{ store_credit_balance: string }>(
          'SELECT store_credit_balance FROM customers WHERE id = $1',
          [customerId]
        ),
        paddockData.query<StoreCreditTransactionRow>(
          `SELECT id, amount, balance_after, reason, note, order_id, booking_id, created_at
           FROM store_credit_transactions
           WHERE customer_id = $1
           ORDER BY created_at DESC
           LIMIT 100`,
          [customerId]
        ),
      ])
      return {
        balance: balanceLookup.data[0]?.store_credit_balance ?? '0',
        history: historyLookup.data,
      }
    })(),
    paddockData.query<CustomerEventBookingRow>(
      `SELECT eb.id, eb.event_id, e.name AS event_name, e.starts_at AS event_starts_at, eb.places, eb.status,
              eb.price_paid, eb.created_at,
              count(ea.id) FILTER (WHERE ea.cancelled_at IS NULL)::int AS attendee_count,
              count(ea.checked_in_at) FILTER (WHERE ea.cancelled_at IS NULL)::int AS checked_in_count,
              count(ea.id) FILTER (WHERE ea.cancelled_at IS NULL
                                     AND (NOT ea.waiver_accepted OR ${EXTRA_WAIVER_OUTSTANDING_SQL}))::int AS waivers_outstanding,
              count(ea.id)::int AS places_total,
              count(ea.cancelled_at)::int AS cancelled_places,
              COALESCE(sum(ea.refunded_amount), 0) AS refunded_amount,
              COALESCE(sum(ea.card_refunded_amount), 0) AS card_refunded_amount,
              e.cancelled_at AS event_cancelled_at
       FROM event_bookings eb
       JOIN events e ON e.id = eb.event_id
       LEFT JOIN event_attendees ea ON ea.event_booking_id = eb.id
       WHERE eb.customer_id = $1
       GROUP BY eb.id, e.id
       ORDER BY e.starts_at DESC NULLS LAST, eb.created_at DESC`,
      [customerId]
    ),
  ])

  return {
    memberships: memberships.data.map((m) => ({ ...withoutPaymentDateFacts(m), ...paymentDateChangeStatus(m) })),
    sessionPasses: sessionPasses.data,
    bookingHistory: bookingHistory.data,
    storeCreditBalance: storeCredit.balance,
    storeCreditHistory: storeCredit.history,
    eventBookings: eventBookings.data,
  }
}
