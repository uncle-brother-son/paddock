// Ported from backend/paddock/shared/eventOrders.ts (the block reasons and messages only).
import 'server-only'
import type { EventBlockReason } from '@/contracts'

export const EVENT_BLOCK_MESSAGES: Record<EventBlockReason, string> = {
  event_not_found: 'That event no longer exists.',
  event_cancelled: 'That event has been cancelled.',
  event_not_on_sale: 'That event is not on sale.',
  event_started: 'That event has already started.',
  event_members_only: 'This event is for members only — the customer needs an active membership.',
  event_not_released_yet: "Members can book now; public booking hasn't opened yet for this event.",
}

/** Staff-facing text for a block reason; the release time is spelled out for members-first events
 *  (wall-clock digits labelled UTC, like session times). */
export function eventBlockMessage(reason: EventBlockReason, publicReleaseAt: string | null): string {
  if (reason === 'event_not_released_yet' && publicReleaseAt) {
    const when = new Date(publicReleaseAt).toLocaleString('en-GB', {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    return `Members can book now; public booking opens ${when}.`
  }
  return EVENT_BLOCK_MESSAGES[reason] ?? 'This event cannot be booked.'
}
