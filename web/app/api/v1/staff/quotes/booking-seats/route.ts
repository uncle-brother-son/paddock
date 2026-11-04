import { quoteBookingSeatsInputSchema, quoteBookingSeatsOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { quoteBookingSeats } from '@/server/rules/pricing/quote-booking-seats'

/** Read-only, so not idempotent and no audit row. POST because the input is a structured body. */
export const POST = defineRoute({ auth: 'staff', input: quoteBookingSeatsInputSchema, output: quoteBookingSeatsOutputSchema }, async ({ db, input }) => quoteBookingSeats(db, input))
