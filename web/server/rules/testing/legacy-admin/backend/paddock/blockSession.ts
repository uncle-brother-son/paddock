import { requireStaffId } from './shared/resolveStaffId'

export interface BlockSessionParams {
  sessionId: string
  reason: string
}

export interface ConflictingBookingRow {
  id: string
  customer_first_name: string
  customer_last_name: string
  party_size: number
  price_paid: string
  redemption_source: string
  status: string
}

export interface BlockSessionResult {
  blocked: boolean
  conflict: boolean
  conflictingBookings: ConflictingBookingRow[]
  session: Record<string, unknown> | null
}

export default async function blockSession(
  req: { params: BlockSessionParams; user: User }
): Promise<BlockSessionResult> {
  const { sessionId, reason } = req.params

  // The conflict check and the acting-staff lookup are independent reads — run them in parallel.
  const [conflictCheck, staffId] = await Promise.all([
    paddockData.query<ConflictingBookingRow>(
      `SELECT b.id, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
            b.party_size, b.price_paid, b.redemption_source, b.status
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     WHERE b.session_id = $1 AND b.status = 'confirmed'
     ORDER BY b.created_at`,
      [sessionId]
    ),
    requireStaffId(req.user.email),
  ])

  // Blocking is a hard failure while any confirmed booking still references this session — there
  // is no bypass. Staff must move each booking to a different session or cancel it first (see
  // moveBooking.ts), then retry the block.
  if (conflictCheck.data.length > 0) {
    return { blocked: false, conflict: true, conflictingBookings: conflictCheck.data, session: null }
  }

  const result = await paddockData.query(
    `UPDATE sessions
     SET status = 'blocked', blocked_reason = $1, blocked_by = $2, updated_at = now()
     WHERE id = $3
     RETURNING *`,
    [reason, staffId, sessionId]
  )

  return { blocked: true, conflict: false, conflictingBookings: [], session: result.data[0] ?? null }
}
