// Ported from backend/paddock/quoteEvent.ts.
import 'server-only'
import type { EventBlockReason, EventQuotePlace, QuoteEventInput, QuoteEventOutput } from '@/contracts'
import type { Queryable } from '@/server/db'
import { eventBlockMessage } from './event-blocks'

/**
 * The read-only event preview: can this customer book this event now, and what does each place
 * cost (quote_event: the account holder's own place at their member level when attending, every
 * other place at the public price). Nothing is written.
 */
export async function quoteEvent(db: Queryable, input: QuoteEventInput): Promise<QuoteEventOutput> {
  const { eventId, customerId, accountHolderAttending } = input
  const places = Number.isInteger(input.places) ? input.places : 0
  const frequency = input.newMembershipFrequency
  const newMembershipFrequency = frequency === 'monthly' || frequency === 'yearly' ? frequency : null

  const status = await db.query<{ reason: string | null; public_release_at: string | null; places_left: number | null }>(
    `SELECT event_booking_block_reason($1, $2, $3::text) AS reason, e.public_release_at, e.capacity - e.places_booked AS places_left
     FROM events e WHERE e.id = $4`,
    [eventId, customerId, newMembershipFrequency, eventId]
  )
  const row = status[0]
  if (!row) {
    return { blockReason: 'event_not_found', blockMessage: eventBlockMessage('event_not_found', null), places: [], total: 0, placesLeft: null }
  }
  if (row.reason) {
    const reason = row.reason as EventBlockReason
    return { blockReason: reason, blockMessage: eventBlockMessage(reason, row.public_release_at), places: [], total: 0, placesLeft: row.places_left }
  }
  if (places < 1) return { blockReason: null, blockMessage: null, places: [], total: 0, placesLeft: row.places_left }

  const quoted = await db.query<EventQuotePlace>(
    'SELECT place_no, attendee_type, price_level, unit_price FROM quote_event($1, $2, $3, $4, $5::text) ORDER BY place_no',
    [eventId, customerId, places, accountHolderAttending === true, newMembershipFrequency]
  )
  const total = Math.round(quoted.reduce((sum, p) => sum + Number.parseFloat(p.unit_price), 0) * 100) / 100
  return { blockReason: null, blockMessage: null, places: quoted, total, placesLeft: row.places_left }
}
