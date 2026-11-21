import { eventActiveRouteInputSchema, eventActiveRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setEventActive } from '@/server/rules/catalog/events'

/**
 * W52 (G-plan 4.3): setEventActive, the Catalog → Events on-sale switch. Manage pricing (the rule, in the old words).
 * One transaction under the event's row lock: the switch and an `event.active_set` audit row. An event that isn't
 * finished, or is cancelled, can't go on sale (the table's own rule, in the old words). Idempotent: each call has its
 * own key.
 */
export const POST = defineRoute({ auth: 'staff', input: eventActiveRouteInputSchema, output: eventActiveRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setEventActive(db, input.eventId, input.active, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
