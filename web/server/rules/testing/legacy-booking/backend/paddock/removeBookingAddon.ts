import { READER_PAYMENT_OPEN_MESSAGE, anyReaderPaymentOpenOnBooking } from './shared/readerPaymentOpen'
import { requireCanIssueRefunds } from './shared/staffAccess'
import { resolveStaffId } from './shared/resolveStaffId'
import {
  cancelBookingAddonLines,
  describeAddonCancellation,
  type AddonRefundChoice,
  type CancelAddonLinesResult,
} from './shared/bookingAddonCancellation'

export interface RemoveBookingAddonParams {
  addonLineId: string
  /** How a PAID add-on is refunded: 'card' / 'credit' need Issue refunds; 'none' ("Remove, no
   *  refund") is open to all staff. A membership-credit add-on gives its credit back either way. */
  refund: AddonRefundChoice
}

export type RemoveBookingAddonResult =
  | ({ removed: true; summary: string } & CancelAddonLinesResult)
  | { removed: false; reason: 'line_not_found' | 'already_removed' | 'session_started' | 'reader_payment_open'; message: string }

/**
 * Removes one add-on from a booking (before its session starts), with a refund under the same
 * rules as cancelling the booking: card first on the add-on's own order, the rest to store credit,
 * add-on credits back to the membership, nothing back inside 24 hours. Also works on a cancelled
 * booking whose add-ons were left in place (a credit booking's paid add-ons, or add-ons staff
 * unticked), so they can still be refunded.
 */
export default async function removeBookingAddon(
  req: { params: RemoveBookingAddonParams; user: User }
): Promise<RemoveBookingAddonResult> {
  const { addonLineId, refund } = req.params
  const lookup = await paddockData.query<{
    booking_id: string
    removed: boolean
    paid: boolean
    session_started: boolean
  }>(
    `SELECT aol.booking_id, aol.removed_at IS NOT NULL AS removed,
            COALESCE(aol.redemption_source, 'paid') <> 'membership_credit' AS paid,
            (s.start_time AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'Europe/London') AS session_started
     FROM addon_order_lines aol
     JOIN bookings b ON b.id = aol.booking_id
     JOIN sessions s ON s.id = b.session_id
     WHERE aol.id = $1`,
    [addonLineId]
  )
  const line = lookup.data[0]
  if (!line) return { removed: false, reason: 'line_not_found', message: 'This add-on is no longer on the booking.' }
  if (line.removed) return { removed: false, reason: 'already_removed', message: 'This add-on has already been removed.' }
  if (line.session_started) {
    return { removed: false, reason: 'session_started', message: "The session has started, so add-ons can't be removed." }
  }
  // An add-on on the reader hasn't been paid for yet, so a refund would give away money never
  // collected. Its line and the pending row are written together, so this read can't miss one.
  if (await anyReaderPaymentOpenOnBooking(line.booking_id)) {
    return { removed: false, reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE }
  }
  if (line.paid && (refund === 'card' || refund === 'credit')) {
    await requireCanIssueRefunds(req.user.email)
  }

  const outcome = await cancelBookingAddonLines({
    bookingId: line.booking_id,
    lineIds: [addonLineId],
    refund: refund === 'card' || refund === 'credit' ? refund : 'none',
    returnCredits: true,
    includePaidLines: true,
    staffId: await resolveStaffId(req.user.email),
  })
  if (outcome.cancelledLineIds.length === 0) {
    return {
      removed: false,
      reason: 'already_removed',
      message: outcome.warning || outcome.notes.join(' ') || 'The add-on could not be removed.',
    }
  }
  return { removed: true, summary: describeAddonCancellation(outcome), ...outcome }
}
