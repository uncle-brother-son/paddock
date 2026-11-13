import { cancelQuoteRouteInputSchema, cancelQuoteSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { quoteCancel } from '@/server/rules/bookings/cancel'

/**
 * W23 (D-plan 1.7, 4.6, 4.7): the Cancel & return credit and Cancel (payment needed) dialogs' first call (and again
 * when the ticks change). What the ticked paid add-ons would give back (£0 inside 24 hours), where it can go, and what a
 * press would be refused with now (`blocked`: the old words, including "Remove paid guests first, then cancel."). A read.
 * W23a: `clubCancelled` (Block Session, Block Day) shows the whole amount inside 24 hours too.
 */
export const POST = defineRoute(
  { auth: 'staff', input: cancelQuoteRouteInputSchema, output: cancelQuoteSchema },
  async ({ db, input }) => quoteCancel(db, 'cancel_credit', input.bookingId, input.addonLineIds, input.clubCancelled === true)
)
