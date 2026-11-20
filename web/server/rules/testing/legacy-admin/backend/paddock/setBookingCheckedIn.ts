import { resolveStaffId } from './shared/resolveStaffId'

export interface SetBookingCheckedInParams {
  bookingId: string
  checkedIn: boolean
}

export default async function setBookingCheckedIn(req: { params: SetBookingCheckedInParams; user: User }) {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { bookingId, checkedIn } = req.params
  const result = await paddockData.query(
    'UPDATE bookings SET checked_in_at = $1, updated_at = now() WHERE id = $2 RETURNING id, checked_in_at',
    [checkedIn ? new Date().toISOString() : null, bookingId]
  )
  return result.data[0] ?? null
}
