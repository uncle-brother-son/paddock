/**
 * Read-only: event_cancellation_quote, read and explained. Used by the cancellation itself
 * (shared/eventCancellation) and by the read-only quote getters behind the cancel dialogs, so no
 * write SQL here (CLAUDE.md).
 */
// The runtime globals (paddockData) are typed by the generated declarations in backend/resources/.
import '../globals'

export type CancelPlacesFailureReason =
  | 'invalid_params'
  | 'booking_not_found'
  | 'booking_pending'
  | 'booking_not_confirmed'
  | 'attendee_not_found'
  | 'already_cancelled'
  | 'nothing_to_cancel'
  | 'attendee_checked_in'
  | 'reason_required_after_cutoff'
  | 'order_not_found'
  | 'refund_failed'
  /** A card refund gave no clear answer: nothing was cancelled, and the next press settles it first. */
  | 'refund_unsure'
  | 'store_credit_failed'
  | 'changed_by_someone_else'
  | 'unexpected_error'

const QUOTE_REFUSALS: Record<string, { reason: CancelPlacesFailureReason; message: string }> = {
  booking_not_found: { reason: 'booking_not_found', message: 'This event booking no longer exists.' },
  booking_not_confirmed: { reason: 'booking_not_confirmed', message: 'This event booking has already been cancelled.' },
  attendee_not_found: { reason: 'attendee_not_found', message: "One of the places isn't on this booking any more." },
  already_cancelled: { reason: 'already_cancelled', message: 'One of the places has already been cancelled.' },
  nothing_to_cancel: { reason: 'nothing_to_cancel', message: 'There are no places left to cancel on this booking.' },
  attendee_checked_in: { reason: 'attendee_checked_in', message: 'A place you chose is checked in. Undo check-in first.' },
}

export interface EventCancellationQuote {
  event_id: string
  customer_id: string
  attendee_ids: string[]
  places: number
  whole_booking: boolean
  value: number
  refund_cutoff_at: string | null
  before_cutoff: boolean
  event_started: boolean
  event_cancelled: boolean
  /** The booking's place count in the same snapshot as the amounts above: the cancellation's
   *  concurrency guard (any other cancel changes it). */
  booking_places: number
}

export const round2 = (n: number) => Math.round(n * 100) / 100

function parseJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
}

/** Runs event_cancellation_quote and reads the booking's status (to tell a pending reader payment
 *  from a cancelled booking). Read-only. */
export async function quoteEventCancellation(
  eventBookingId: string,
  attendeeIds: string[] | undefined
): Promise<{ ok: true; quote: EventCancellationQuote } | { ok: false; reason: CancelPlacesFailureReason; message: string }> {
  const lookup = await paddockData.query<{ quote: unknown; status: string | null; places: number | null }>(
    `SELECT event_cancellation_quote($1::uuid, $2::uuid[]) AS quote, eb.status, eb.places
     FROM (SELECT 1) AS one
     LEFT JOIN event_bookings eb ON eb.id = $3`,
    [eventBookingId, attendeeIds && attendeeIds.length > 0 ? attendeeIds : null, eventBookingId]
  )
  const row = lookup.data[0]
  if (row?.status === 'pending') {
    return {
      ok: false,
      reason: 'booking_pending',
      message: 'A card reader payment is still in progress for this booking. Finish or cancel it first.',
    }
  }
  const parsed = parseJson(row?.quote)
  if (!parsed || parsed['ok'] !== true) {
    const refusal = QUOTE_REFUSALS[String(parsed?.['reason'] ?? 'booking_not_found')] ?? QUOTE_REFUSALS['booking_not_found']!
    return { ok: false, ...refusal }
  }
  return {
    ok: true,
    quote: {
      event_id: String(parsed['event_id']),
      customer_id: String(parsed['customer_id']),
      attendee_ids: Array.isArray(parsed['attendee_ids']) ? (parsed['attendee_ids'] as unknown[]).map(String) : [],
      places: Number(parsed['places'] ?? 0),
      whole_booking: parsed['whole_booking'] === true,
      value: round2(Number(parsed['value'] ?? 0)),
      refund_cutoff_at: typeof parsed['refund_cutoff_at'] === 'string' ? (parsed['refund_cutoff_at'] as string) : null,
      before_cutoff: parsed['before_cutoff'] === true,
      event_started: parsed['event_started'] === true,
      event_cancelled: parsed['event_cancelled'] === true,
      booking_places: Number(row?.places ?? 0),
    },
  }
}
