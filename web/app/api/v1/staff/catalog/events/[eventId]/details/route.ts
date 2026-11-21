import { eventDetailsRouteInputSchema, eventDetailsRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setEventDetails } from '@/server/rules/catalog/events'

/**
 * W52 (G-plan 4.3; bug GB11; Wayne's Q51): setEventDetails, the Catalog → Events edit dialog. Manage pricing (the
 * rule, in the old words). One transaction under the event's own row lock, the one a sale of its places takes: the
 * table's constraints answered in the old words; once a place is booked the refund cut-off can move later but not
 * earlier (`cutoff_earlier`, with the earliest allowed), except that it follows an event brought forward to before
 * it, as far as the new start (W52a, Wayne's Q-a); and an `event.details_set` audit row with the event before and
 * after. Idempotent: each press has its own key. W54a: the press sends the event's `stamp` as the list read it;
 * an event whose date, places, access, prices or cut-off changed since is refused `changed_since`. The answer carries
 * the new stamp.
 */
export const POST = defineRoute({ auth: 'staff', input: eventDetailsRouteInputSchema, output: eventDetailsRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setEventDetails(db, input, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
