import { round2 } from './shared/eventCancellationQuote'

export interface GetEventCancellationOverviewParams {
  eventId: string
}

export interface EventCancellationOverviewBooking {
  eventBookingId: string
  customerName: string
  places: number
  /** The full refund for this booking's remaining places (event_cancellation_quote). */
  value: number
  /** Set when the booking can't be cancelled as things stand (e.g. a place is checked in). */
  problem: string | null
}

export interface GetEventCancellationOverviewResult {
  eventName: string
  ended: boolean
  cancelledAt: string | null
  cancelReason: string | null
  /** Customers with a card reader payment still in progress (cancelling is refused meanwhile). */
  pendingCustomers: string[]
  /** Confirmed bookings still to cancel. */
  bookings: EventCancellationOverviewBooking[]
  totalPlaces: number
  totalValue: number
}

/** Read-only preview for Cancel event (all staff may read; cancelling needs Issue refunds). */
export default async function getEventCancellationOverview(
  req: { params: GetEventCancellationOverviewParams }
): Promise<GetEventCancellationOverviewResult | null> {
  const { eventId } = req.params
  const [eventLookup, bookingLookup] = await Promise.all([
    paddockData.query<{ name: string; ended: boolean; cancelled_at: string | null; cancel_reason: string | null }>(
      `SELECT e.name, e.cancelled_at, e.cancel_reason,
              (e.starts_at IS NOT NULL AND (now() AT TIME ZONE 'Europe/London') >= COALESCE(
                 e.ends_at AT TIME ZONE 'UTC', ((e.starts_at AT TIME ZONE 'UTC')::date + 1)::timestamp)) AS ended
       FROM events e WHERE e.id = $1`,
      [eventId]
    ),
    paddockData.query<{ id: string; name: string; status: string; places: number; quote: unknown }>(
      `SELECT eb.id, trim(concat_ws(' ', c.first_name, c.last_name)) AS name, eb.status, eb.places,
              CASE WHEN eb.status = 'confirmed' THEN event_cancellation_quote(eb.id) END AS quote
       FROM event_bookings eb JOIN customers c ON c.id = eb.customer_id
       WHERE eb.event_id = $1 AND eb.status IN ('confirmed', 'pending')
       ORDER BY eb.created_at`,
      [eventId]
    ),
  ])
  const event = eventLookup.data[0]
  if (!event) return null

  const bookings: EventCancellationOverviewBooking[] = []
  const pendingCustomers: string[] = []
  for (const row of bookingLookup.data) {
    if (row.status === 'pending') {
      pendingCustomers.push(row.name)
      continue
    }
    const quote = (typeof row.quote === 'string' ? JSON.parse(row.quote) : row.quote) as Record<string, unknown> | null
    const ok = quote?.['ok'] === true
    bookings.push({
      eventBookingId: row.id,
      customerName: row.name,
      places: ok ? Number(quote?.['places'] ?? row.places) : row.places,
      value: ok ? round2(Number(quote?.['value'] ?? 0)) : 0,
      problem: ok
        ? null
        : quote?.['reason'] === 'attendee_checked_in'
          ? 'A place is checked in. Undo check-in first.'
          : `Can't be cancelled (${String(quote?.['reason'] ?? 'unknown')}).`,
    })
  }
  return {
    eventName: event.name,
    ended: event.ended,
    cancelledAt: event.cancelled_at,
    cancelReason: event.cancel_reason,
    pendingCustomers,
    bookings,
    totalPlaces: bookings.reduce((sum, b) => sum + b.places, 0),
    totalValue: round2(bookings.reduce((sum, b) => sum + b.value, 0)),
  }
}
