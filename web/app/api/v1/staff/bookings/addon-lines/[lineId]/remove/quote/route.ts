import { removeAddonQuoteRouteInputSchema, removeAddonQuoteSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { quoteRemoveAddon } from '@/server/rules/bookings/remove-addon'

/**
 * W22 (D-plan 1.8, 4.7): what removing a booking's add-on gives back, so the Remove add-on dialog shows it and sends
 * it back as `confirmed.refund`: a paid add-on's price × quantity, £0 inside 24 hours of the session. A read: any
 * active staff member, never gated by the switch. Refused, with the old words, for a line that is gone, already
 * removed, or whose session has started.
 */
export const POST = defineRoute(
  { auth: 'staff', input: removeAddonQuoteRouteInputSchema, output: removeAddonQuoteSchema },
  async ({ db, input }) => quoteRemoveAddon(db, input.lineId)
)
