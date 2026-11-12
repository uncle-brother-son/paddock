import { resolveStaffId } from './shared/resolveStaffId'

export interface SetBookingStatusParams {
  bookingId: string
  status: string
}

/** Every booking status the schema and the app know about — 'payment_needed' and 'no-show' included. */
const ALLOWED_STATUSES = ['pending', 'confirmed', 'payment_needed', 'completed', 'cancelled', 'no-show'] as const

export default async function setBookingStatus(req: { params: SetBookingStatusParams; user: User }) {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { bookingId, status } = req.params

  if (!(ALLOWED_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Invalid booking status "${status}" — allowed: ${ALLOWED_STATUSES.join(', ')}.`)
  }

  const result = await paddockData.query(
    `UPDATE bookings
     SET status = $1,
         updated_at = now(),
         cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE NULL END
     WHERE id = $3 AND status <> 'cancelled'
     RETURNING id, status, cancelled_at`,
    [status, status, bookingId]
  )
  // A cancelled booking keeps its price_paid after its refund, so bringing one back, from a screen
  // opened before it was cancelled, would let that money be refunded again.
  if (result.data.length === 0) throw new Error('This booking is cancelled, so its status can no longer be changed.')
  return result.data[0]
}
