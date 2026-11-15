// New in W31 (E-plan 4.4 "Whole event"; lead call L5; bugs E6 and E7): the whole event on the Worker. Replaces the
// staff app's cancelEvent (its first half) and getEventCancellationOverview.
//
// The event's cancel is one transaction under the event's own lock (bug E7): refused if the event has ended, or if
// any booking has a payment in progress; then off sale and cancelled, with who and why (a second run keeps the first
// details); it answers the bookings still to cancel. New Order locks the same event row before it claims places
// (orders/locks.ts) and its claim asks for an event that is not cancelled, so an order either commits first, and its
// pending booking refuses this cancel, or waits and is refused. No order can start on the event once this commits.
//
// No money moves here. The screen then cancels each booking with its own press of the place cancel
// (`wholeEvent: true`, cancel-places.ts): its own key and its own claim, so a big event can't run out of time in one
// request (bug E6), and Retry runs the bookings still confirmed.
import 'server-only'
import type { CancelEventInput, CancelEventOutput, EventCancelOverviewBooking, EventCancelOverviewOutput } from '@/contracts'
import { audit } from '@/server/audit'
import type { Db, Queryable, Tx } from '@/server/db'
import { inC1 } from '@/server/rules/bookings/money-in'
import { eventCancelRefusal } from './cancel-places'
import { EVENT_OVERVIEW_WORDS, EVENT_WHOLE_CANCEL_NEW_WORDS as NEW_WORDS, EVENT_WHOLE_CANCEL_WORDS as WORDS } from './failure-messages'

/** The event cancel's own audit row (same transaction, E-plan 4.10): written once, when the event is first cancelled. */
export const EVENT_CANCELLED = 'event.cancel'

export interface CancelEventOptions {
  actor: { type: 'staff'; id: string }
  requestId: string
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const iso = (value: unknown): string | null => (value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value))

/**
 * Ended, as the old function worked it out: after ends_at, or the end of its London date when there is no ends_at
 * (event times are London wall-clock digits labelled UTC). An event with no start can't have ended.
 */
const ENDED_SQL = `(e.starts_at IS NOT NULL AND (now() AT TIME ZONE 'Europe/London') >= COALESCE(
  e.ends_at AT TIME ZONE 'UTC', ((e.starts_at AT TIME ZONE 'UTC')::date + 1)::timestamp))`

interface EventRow {
  name: string
  ended: boolean
  cancelled_at: unknown
  cancel_reason: string | null
}

const EVENT_SQL = `SELECT e.name, e.cancelled_at, e.cancel_reason, ${ENDED_SQL} AS ended FROM events e WHERE e.id = $1::uuid`
/** The same read, taking the event's row lock: the lock an UPDATE of the row takes, and the one New Order takes (orders/locks.ts). */
const EVENT_LOCKED_SQL = `${EVENT_SQL} FOR NO KEY UPDATE OF e`

/**
 * The event's confirmed and pending bookings, oldest first: each confirmed one with the database's quote for every
 * place it has left (event_cancellation_quote) and the money still to refund on its order (Q39).
 */
const BOOKINGS_SQL = `
SELECT eb.id, trim(concat_ws(' ', c.first_name, c.last_name)) AS name, eb.status, eb.places,
       CASE WHEN eb.status = 'confirmed' THEN public.event_cancellation_quote(eb.id, NULL::uuid[]) END AS quote,
       COALESCE(paid.refund_owed_amount, 0)::text AS owed
FROM event_bookings eb
JOIN customers c ON c.id = eb.customer_id
LEFT JOIN LATERAL (
  SELECT o.refund_owed_amount
  FROM order_line_items oli JOIN orders o ON o.id = oli.order_id
  WHERE oli.event_booking_id = eb.id AND oli.item_type = 'event'
  ORDER BY oli.created_at, oli.id LIMIT 1
) paid ON true
WHERE eb.event_id = $1::uuid AND eb.status IN ('confirmed', 'pending')
ORDER BY eb.created_at, eb.id`

function parseQuote(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
}

/** The overview from the event's row and its bookings, in the old function's fields. */
async function overviewOf(db: Queryable, eventId: string, event: EventRow): Promise<EventCancelOverviewOutput> {
  const rows = await db.query<{ id: string; name: string; status: string; places: number; quote: unknown; owed: string }>(BOOKINGS_SQL, [eventId])
  const bookings: EventCancelOverviewBooking[] = []
  const pendingCustomers: string[] = []
  for (const row of rows) {
    if (row.status === 'pending') {
      pendingCustomers.push(row.name)
      continue
    }
    const quote = parseQuote(row.quote)
    const ok = quote?.['ok'] === true
    const owed = round2(Number.parseFloat(row.owed ?? '0'))
    bookings.push({
      eventBookingId: row.id,
      customerName: row.name,
      places: ok ? Number(quote?.['places'] ?? row.places) : Number(row.places),
      value: ok ? round2(Number(quote?.['value'] ?? 0)) : 0,
      problem: ok ? null : quote?.['reason'] === 'attendee_checked_in' ? EVENT_OVERVIEW_WORDS.placeCheckedIn : EVENT_OVERVIEW_WORDS.cannotBeCancelled(String(quote?.['reason'] ?? 'unknown')),
      ...(owed > 0 ? { refundOwed: owed } : {}),
    })
  }
  return {
    eventName: event.name,
    ended: event.ended === true,
    cancelledAt: iso(event.cancelled_at),
    cancelReason: event.cancel_reason,
    pendingCustomers,
    bookings,
    totalPlaces: bookings.reduce((total, booking) => total + booking.places, 0),
    totalValue: round2(bookings.reduce((total, booking) => total + booking.value, 0)),
  }
}

/**
 * GET /events/:id/cancel/overview (getEventCancellationOverview): what the Cancel event dialog shows. The event's
 * name, whether it has ended or is cancelled already (and why), the customers with a payment in progress, and each
 * confirmed booking still to cancel with the full refund for the places it has left (the figure the screen sends back
 * with that booking's press, Q18), any problem (a place checked in) and any money owed on its order. Null for an
 * event that is gone: the route answers NOT_FOUND (the old function answered null; W27 "Noticed" 3).
 */
export async function eventCancelOverview(db: Queryable, eventId: string): Promise<EventCancelOverviewOutput | null> {
  const event = (await db.query<EventRow>(EVENT_SQL, [eventId]))[0]
  return event ? overviewOf(db, eventId, event) : null
}

async function cancelInTransaction(tx: Tx, eventId: string, reason: string, options: CancelEventOptions): Promise<CancelEventOutput> {
  // The event's row lock: New Order takes the same one before it claims places, so the two queue (bug E7).
  const locked = (await tx.query<EventRow>(EVENT_LOCKED_SQL, [eventId]))[0]
  if (!locked) throw eventCancelRefusal('NOT_FOUND', 'event_not_found', WORDS.eventNotFound, 'cancel_event')
  // A second run on an event already cancelled is always allowed: that is how staff retry.
  if (!locked.cancelled_at && locked.ended) throw eventCancelRefusal('CONFLICT', 'event_ended', WORDS.eventEnded, 'cancel_event')
  // Read under the lock: an order that got in first has its pending booking here; one that didn't can't claim now.
  const pending = await tx.query<{ name: string }>(
    `SELECT trim(concat_ws(' ', c.first_name, c.last_name)) AS name
     FROM event_bookings eb JOIN customers c ON c.id = eb.customer_id
     WHERE eb.event_id = $1::uuid AND eb.status = 'pending'
     ORDER BY eb.created_at, eb.id`,
    [eventId]
  )
  if (pending.length > 0) throw eventCancelRefusal('CONFLICT', 'bookings_pending', WORDS.bookingsPending(pending.map((row) => row.name)), 'cancel_event')

  // Off sale and cancelled. A second run keeps the first cancellation's details.
  await tx.query(
    `UPDATE events
     SET active = false,
         cancelled_at = COALESCE(cancelled_at, now()),
         cancelled_by = COALESCE(cancelled_by, $1::uuid),
         cancel_reason = COALESCE(cancel_reason, $2::text),
         updated_at = now()
     WHERE id = $3::uuid`,
    [options.actor.id, reason, eventId]
  )
  const event = (await tx.query<EventRow>(EVENT_SQL, [eventId]))[0]
  if (!event) throw new Error(`Event ${eventId} went while it was locked.`)
  const overview = await overviewOf(tx, eventId, event)
  if (!locked.cancelled_at) {
    await audit.recordAll(tx, [
      {
        actorType: 'staff',
        actorId: options.actor.id,
        action: EVENT_CANCELLED,
        entityType: 'event',
        entityId: eventId,
        requestId: options.requestId,
        details: { reason, bookings: overview.bookings.length, places: overview.totalPlaces, value: overview.totalValue },
      },
    ])
  }
  return overview
}

/**
 * POST /events/:id/cancel (cancelEvent's first half): the old function's param checks with the old words, then the
 * one transaction above. A refusal is an ApiError whose details carry the old reason and words. The route checks Issue
 * refunds and the switch. Safe to run again: it changes nothing on an event already cancelled and answers the bookings
 * still to cancel as they now stand.
 */
export async function cancelEvent(db: Db, eventId: string, input: CancelEventInput, options: CancelEventOptions): Promise<CancelEventOutput> {
  if (!eventId) throw eventCancelRefusal('VALIDATION', 'invalid_params', WORDS.chooseEvent, 'cancel_event')
  // Q42: a whole event goes back to the card or to store credit; each booking's press sends this same choice.
  if (input.refund !== 'card' && input.refund !== 'credit') throw eventCancelRefusal('VALIDATION', 'invalid_params', WORDS.chooseRefund, 'cancel_event', { field: 'refund' })
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (!reason) throw eventCancelRefusal('VALIDATION', 'invalid_params', WORDS.reasonNeeded, 'cancel_event', { field: 'reason' })
  return inC1(
    db,
    (tx) => cancelInTransaction(tx, eventId, reason, options),
    (logDetail) => eventCancelRefusal('INTERNAL', 'cancel_not_saved', NEW_WORDS.notSaved, 'cancel_event', { logDetail })
  )
}
