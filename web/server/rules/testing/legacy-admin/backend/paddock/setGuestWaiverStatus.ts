import { resolveStaffId } from './shared/resolveStaffId'

export type WaiverMethod = 'email_link' | 'in_person'

export interface SetGuestWaiverStatusParams {
  guestId: string
  accepted: boolean
  waiverMethod?: WaiverMethod
  waiverVersion?: string
}

export default async function setGuestWaiverStatus(req: { params: SetGuestWaiverStatusParams; user: User }) {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { guestId, accepted, waiverMethod, waiverVersion } = req.params

  if (accepted) {
    if (waiverMethod !== 'email_link' && waiverMethod !== 'in_person') {
      throw new Error('waiverMethod must be "email_link" or "in_person" when accepting a waiver')
    }
    const result = await paddockData.query(
      `UPDATE booking_guests
       SET waiver_accepted = true, waiver_accepted_at = now(), waiver_method = $1, waiver_version = $2
       WHERE id = $3
       RETURNING *`,
      [waiverMethod, waiverVersion?.trim() || 'v1', guestId]
    )
    return result.data[0] ?? null
  }

  const result = await paddockData.query(
    `UPDATE booking_guests
     SET waiver_accepted = false, waiver_accepted_at = NULL, waiver_method = NULL, waiver_version = NULL
     WHERE id = $1
     RETURNING *`,
    [guestId]
  )
  return result.data[0] ?? null
}
