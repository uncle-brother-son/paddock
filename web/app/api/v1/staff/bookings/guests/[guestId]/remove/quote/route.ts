import { removeGuestOutputSchema, removeGuestQuoteRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { quoteRemoveGuest } from '@/server/rules/bookings/remove-guest'

/**
 * W22 (D-plan 1.5, 4.6): removeBookingGuest's first call. What removing the guest gives back (their seat's price, at
 * most what is left on the booking; £0 for a credit, pre-band or private seat), so staff confirm it before anything
 * changes. A read: any active staff member, as before, never gated by the switch. The account holder answers
 * `blocked`; a refusal (guest gone, booking cancelled) is an error with the old reason.
 */
export const POST = defineRoute(
  { auth: 'staff', input: removeGuestQuoteRouteInputSchema, output: removeGuestOutputSchema },
  async ({ db, input }) => quoteRemoveGuest(db, input.guestId)
)
