import { requireStaffId } from './shared/resolveStaffId'

export interface BlockDayParams {
  date: string
  reason: string
}

export interface ConflictingBookingRow {
  id: string
  session_id: string
  service_type_name: string
  /** Lets the Move Booking dialog list only sessions of the booking's own type. */
  booking_type: 'public' | 'private'
  session_start_time: string
  session_end_time: string
  customer_first_name: string
  customer_last_name: string
  party_size: number
  price_paid: string
  redemption_source: string
  status: string
}

export interface BlockDayResult {
  blocked: boolean
  conflict: boolean
  conflictingBookings: ConflictingBookingRow[]
  blockedCount: number
}

export default async function blockDay(req: { params: BlockDayParams; user: User }): Promise<BlockDayResult> {
  const { date, reason } = req.params

  // The conflict check and the acting-staff lookup are independent reads — run them in parallel.
  const [conflictCheck, staffId] = await Promise.all([
    paddockData.query<ConflictingBookingRow>(
      `SELECT
       b.id,
       s.id AS session_id,
       st.name AS service_type_name,
       st.booking_type,
       s.start_time AS session_start_time,
       s.end_time AS session_end_time,
       c.first_name AS customer_first_name,
       c.last_name AS customer_last_name,
       b.party_size,
       b.price_paid,
       b.redemption_source,
       b.status
     FROM sessions s
     JOIN service_types st ON st.id = s.service_type_id
     JOIN bookings b ON b.session_id = s.id AND b.status = 'confirmed'
     JOIN customers c ON c.id = b.customer_id
     WHERE s.start_time::date = $1::date
     ORDER BY s.start_time, b.created_at`,
      [date]
    ),
    requireStaffId(req.user.email),
  ])

  // Blocking is a hard failure while any confirmed booking still exists anywhere on this day —
  // there is no bypass. Staff must move each booking to a different session or cancel it first
  // (see moveBooking.ts), then retry the block.
  if (conflictCheck.data.length > 0) {
    return { blocked: false, conflict: true, conflictingBookings: conflictCheck.data, blockedCount: 0 }
  }

  const result = await paddockData.query<{ id: string }>(
    `UPDATE sessions
     SET status = 'blocked', blocked_reason = $1, blocked_by = $2, updated_at = now()
     WHERE start_time::date = $3::date
     RETURNING id`,
    [reason, staffId, date]
  )

  return { blocked: true, conflict: false, conflictingBookings: [], blockedCount: result.data.length }
}
