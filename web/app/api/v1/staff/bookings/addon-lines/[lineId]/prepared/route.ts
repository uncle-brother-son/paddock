import { addonPreparedRouteInputSchema, addonPreparedRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setAddonLinePrepared } from '@/server/rules/bookings/admin'

/**
 * W50 (G-plan 4.3, level C; bug GB17; W48 review L2): setAddonLinePrepared, the prepared tick on a booking's add-on
 * (the booking window, the Bookings page's session windows, Overview's prep card). Any active staff member. The
 * line's booking is held first, then one guarded statement and an audit row (`booking.addon_prepared_set`, with who)
 * in one transaction: refused on a cancelled booking and on a line already removed from its booking. Idempotent: each
 * call has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: addonPreparedRouteInputSchema, output: addonPreparedRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setAddonLinePrepared(db, input.lineId, input.prepared, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
