import { requireCanIssueRefunds } from './shared/staffAccess'
import { resolveStaffId } from './shared/resolveStaffId'
import { cancelEventBookingPlaces } from './shared/eventCancellation'

export interface CancelEventParams {
  eventId: string
  /** One choice for every booking: card (back to the card where there is one, the rest to store
   *  credit) or store credit. */
  refund: 'card' | 'credit'
  reason: string
}

export interface CancelEventBookingOutcome {
  eventBookingId: string
  customerName: string
  places: number
  ok: boolean
  cardRefundedAmount: number
  storeCreditRefundedAmount: number
  /** Why it failed (ok false), or what needs a manual check (ok true). */
  message?: string
}

export type CancelEventResult =
  | { ok: true; results: CancelEventBookingOutcome[] }
  | { ok: false; reason: 'invalid_params' | 'event_not_found' | 'event_ended' | 'bookings_pending'; message: string }

/**
 * Cancels a whole event (Issue refunds; a reason is required): first takes it off sale and marks it
 * cancelled so nothing more can be sold, then cancels every confirmed booking in full with a full
 * refund whatever the cut-off, one booking at a time so one failure doesn't stop the rest.
 * Running it again on a cancelled event processes only the bookings still confirmed — that is how
 * staff retry failures.
 */
export default async function cancelEvent(req: { params: CancelEventParams; user: User }): Promise<CancelEventResult> {
  await requireCanIssueRefunds(req.user.email)
  const { eventId, refund } = req.params
  const reason = typeof req.params.reason === 'string' ? req.params.reason.trim() : ''
  if (!eventId) return { ok: false, reason: 'invalid_params', message: 'Choose an event.' }
  if (refund !== 'card' && refund !== 'credit') {
    return { ok: false, reason: 'invalid_params', message: 'Choose Card or Store credit.' }
  }
  if (!reason) return { ok: false, reason: 'invalid_params', message: 'A reason is needed to cancel an event.' }

  // Ended: after ends_at, or the end of its London date when there's no ends_at (times are London
  // wall-clock digits labelled UTC). A retry on an event already cancelled is always allowed.
  const [eventLookup, pendingLookup] = await Promise.all([
    paddockData.query<{ cancelled_at: string | null; ended: boolean }>(
      `SELECT e.cancelled_at,
              (e.starts_at IS NOT NULL AND (now() AT TIME ZONE 'Europe/London') >= COALESCE(
                 e.ends_at AT TIME ZONE 'UTC', ((e.starts_at AT TIME ZONE 'UTC')::date + 1)::timestamp)) AS ended
       FROM events e WHERE e.id = $1`,
      [eventId]
    ),
    paddockData.query<{ name: string }>(
      `SELECT trim(concat_ws(' ', c.first_name, c.last_name)) AS name
       FROM event_bookings eb JOIN customers c ON c.id = eb.customer_id
       WHERE eb.event_id = $1 AND eb.status = 'pending'
       ORDER BY eb.created_at`,
      [eventId]
    ),
  ])
  const event = eventLookup.data[0]
  if (!event) return { ok: false, reason: 'event_not_found', message: 'This event no longer exists.' }
  if (!event.cancelled_at && event.ended) {
    return { ok: false, reason: 'event_ended', message: "This event has already ended, so it can't be cancelled." }
  }
  if (pendingLookup.data.length > 0) {
    return {
      ok: false,
      reason: 'bookings_pending',
      message: `A card reader payment is still in progress for ${pendingLookup.data.map((r) => r.name).join(', ')}. Finish or cancel it first.`,
    }
  }

  const staffId = await resolveStaffId(req.user.email)
  // Off sale and cancelled first, so nothing more can be sold while the bookings are worked
  // through. A retry keeps the original cancellation details.
  await paddockData.query(
    `UPDATE events
     SET active = false,
         cancelled_at = COALESCE(cancelled_at, now()),
         cancelled_by = COALESCE(cancelled_by, $1::uuid),
         cancel_reason = COALESCE(cancel_reason, $2),
         updated_at = now()
     WHERE id = $3`,
    [staffId, reason, eventId]
  )

  const bookings = await paddockData.query<{ id: string; name: string; places: number }>(
    `SELECT eb.id, trim(concat_ws(' ', c.first_name, c.last_name)) AS name, eb.places
     FROM event_bookings eb JOIN customers c ON c.id = eb.customer_id
     WHERE eb.event_id = $1 AND eb.status = 'confirmed'
     ORDER BY eb.created_at`,
    [eventId]
  )
  const results: CancelEventBookingOutcome[] = []
  for (const booking of bookings.data) {
    try {
      const outcome = await cancelEventBookingPlaces({
        eventBookingId: booking.id,
        refund,
        reason,
        staffId,
        user: req.user,
        wholeEvent: true,
      })
      results.push(
        outcome.ok
          ? {
              eventBookingId: booking.id,
              customerName: booking.name,
              places: outcome.places,
              ok: true,
              cardRefundedAmount: outcome.cardRefundedAmount,
              storeCreditRefundedAmount: outcome.storeCreditRefundedAmount,
              ...(outcome.warning ? { message: outcome.warning } : {}),
            }
          : {
              eventBookingId: booking.id,
              customerName: booking.name,
              places: booking.places,
              ok: false,
              cardRefundedAmount: 0,
              storeCreditRefundedAmount: 0,
              message: outcome.warning ? `${outcome.message} ${outcome.warning}` : outcome.message,
            }
      )
    } catch (err) {
      results.push({
        eventBookingId: booking.id,
        customerName: booking.name,
        places: booking.places,
        ok: false,
        cardRefundedAmount: 0,
        storeCreditRefundedAmount: 0,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { ok: true, results }
}
