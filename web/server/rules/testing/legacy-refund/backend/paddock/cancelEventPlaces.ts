import { requireCanIssueRefunds } from './shared/staffAccess'
import { resolveStaffId } from './shared/resolveStaffId'
import { cancelEventBookingPlaces, type CancelPlacesResult, type EventRefundChoice } from './shared/eventCancellation'

export interface CancelEventPlacesParams {
  eventBookingId: string
  /** The places to cancel; omit for every remaining place in the booking. */
  attendeeIds?: string[]
  refund: EventRefundChoice
  /** Required to refund after the event's refund cut-off; recorded either way. */
  reason?: string
}

/**
 * Cancels one or more places of an event booking, or the whole booking, from the attendee list.
 * Cancelling with no refund is open to all staff (like the plain Cancel booking on sessions); a
 * refund to card or store credit needs Issue refunds, checked here. Before the event's refund
 * cut-off the places' value can be refunded; after it a refund needs a reason and is recorded as
 * an after-cut-off refund. See shared/eventCancellation for the money and the recording.
 */
export default async function cancelEventPlaces(req: { params: CancelEventPlacesParams; user: User }): Promise<CancelPlacesResult> {
  const { eventBookingId, attendeeIds, refund, reason } = req.params
  if (refund === 'card' || refund === 'credit') {
    await requireCanIssueRefunds(req.user.email)
  }
  if (!eventBookingId) return { ok: false, reason: 'invalid_params', message: 'Choose a booking.' }
  if (attendeeIds !== undefined && (!Array.isArray(attendeeIds) || attendeeIds.length === 0)) {
    return { ok: false, reason: 'invalid_params', message: 'Choose at least one place.' }
  }
  return cancelEventBookingPlaces({
    eventBookingId,
    ...(attendeeIds ? { attendeeIds } : {}),
    refund,
    reason: reason ?? null,
    staffId: await resolveStaffId(req.user.email),
    user: req.user,
  })
}
