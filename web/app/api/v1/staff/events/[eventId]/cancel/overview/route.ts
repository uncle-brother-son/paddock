import { eventCancelOverviewOutputSchema, eventCancelOverviewRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { eventCancelRefusal } from '@/server/rules/events/cancel-places'
import { eventCancelOverview } from '@/server/rules/events/cancel-event'
import { EVENT_WHOLE_CANCEL_WORDS } from '@/server/rules/events/failure-messages'

/**
 * W31 (E-plan 4.8): getEventCancellationOverview. What the Cancel event dialog shows: whether the event has ended or
 * is cancelled already, the customers with a payment in progress, and each booking still to cancel with the full
 * refund for the places it has left (the figure the screen sends back with that booking's press, Q18), any problem
 * and any money owed on its order (Q39). An event that is gone answers NOT_FOUND (the old function answered null:
 * W27 "Noticed" 3). A read: any active staff member, never gated by the switch.
 */
export const GET = defineRoute({ auth: 'staff', input: eventCancelOverviewRouteInputSchema, output: eventCancelOverviewOutputSchema }, async ({ db, input }) => {
  const overview = await eventCancelOverview(db, input.eventId)
  if (!overview) throw eventCancelRefusal('NOT_FOUND', 'event_not_found', EVENT_WHOLE_CANCEL_WORDS.eventNotFound, 'overview')
  return overview
})
