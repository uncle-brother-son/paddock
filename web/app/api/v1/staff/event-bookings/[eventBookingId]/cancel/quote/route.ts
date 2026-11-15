import { eventCancelQuoteOutputSchema, eventCancelQuoteRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { quoteEventPlacesCancel } from '@/server/rules/events/cancel-places'

/**
 * W30 (E-plan 4.4, 4.8; Q18, bug E9): getEventCancellationQuote. What the Cancel place / Cancel booking dialog shows
 * and sends back with the press: what the places are worth now (the database's event_cancellation_quote), the refund
 * cut-off (Wayne's Q43: an event with none uses its start), where a Card refund would go, the cash that can be handed
 * back (Q42) and any money still to refund on the booking's order (Q39). The same code the cancel checks. A read: any
 * active staff member, never gated by the switch. POST because the places are a structured body.
 */
export const POST = defineRoute({ auth: 'staff', input: eventCancelQuoteRouteInputSchema, output: eventCancelQuoteOutputSchema }, async ({ db, input }) =>
  quoteEventPlacesCancel(db, input.eventBookingId, input.attendeeIds)
)
