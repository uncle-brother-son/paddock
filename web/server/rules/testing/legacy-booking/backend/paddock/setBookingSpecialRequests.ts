import { resolveStaffId } from './shared/resolveStaffId'

export interface SetBookingSpecialRequestsParams {
  bookingId: string
  /** The booking's special requests (dietary/accessibility needs etc.). Trimmed; saved as NULL
   *  when empty. Max 500 characters — longer input is truncated. */
  specialRequests: string
}

export interface SetBookingSpecialRequestsResult {
  updated: boolean
  reason?: 'booking_not_found' | 'booking_cancelled'
  booking?: { id: string; special_requests: string | null }
}

/**
 * Staff-facing edit of a booking's special requests (dietary/accessibility needs etc.). The
 * requests belong to the booking (the account holder), not to individual guests. Works for
 * non-cancelled bookings only — a cancelled booking's record is frozen.
 */
export default async function setBookingSpecialRequests(
  req: { params: SetBookingSpecialRequestsParams; user: User }
): Promise<SetBookingSpecialRequestsResult> {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { bookingId, specialRequests } = req.params
  if (!bookingId) {
    return { updated: false }
  }
  const normalized =
    typeof specialRequests === 'string' && specialRequests.trim() !== ''
      ? specialRequests.trim().slice(0, 500)
      : null

  const result = await paddockData.query<{ id: string; status: string; special_requests: string | null }>(
    `UPDATE bookings
     SET special_requests = $1, updated_at = now()
     WHERE id = $2 AND status != 'cancelled'
     RETURNING id, status, special_requests`,
    [normalized, bookingId]
  )
  const row = result.data[0]
  if (!row) {
    // Distinguish a cancelled booking from one that does not exist.
    const lookup = await paddockData.query<{ id: string; status: string }>(
      'SELECT id, status FROM bookings WHERE id = $1',
      [bookingId]
    )
    if (lookup.data[0]?.status === 'cancelled') {
      return { updated: false, reason: 'booking_cancelled' }
    }
    return { updated: false, reason: 'booking_not_found' }
  }
  return { updated: true, booking: { id: row.id, special_requests: row.special_requests } }
}
