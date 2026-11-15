import { z } from 'zod'

// --- W33 (E-plan 4.11; Wayne's Q44, 15 Nov): the website's cancels. Built dark: nothing calls them until the website
// exists, and all four answer REFUND_PATH_OFF until ORDER_SWITCH names `customer_cancels`. The customer is the
// signed-in one; only their own booking; everything paid goes to store credit, never to a card.
//
// In a file of its own, exported last from index.ts, so the types printed for the staff app (workerContracts.ts) only
// gain these: declared earlier, its literal unions change the order the older types' unions are printed in.

const id = z.guid()

/** Why a cancel is refused, in the customer's words (server/rules/customer/cancel-words.ts). */
export const customerCancelBlockedSchema = z.object({ reason: z.string(), message: z.string() })
export type CustomerCancelBlocked = z.infer<typeof customerCancelBlockedSchema>

/** What the customer saw on the quote and now confirms (Q18): required, checked to half a penny. £0 when nothing comes back. */
export const customerCancelConfirmedSchema = z.object({ storeCredit: z.number().optional() })
export type CustomerCancelConfirmed = z.infer<typeof customerCancelConfirmedSchema>

// POST /api/v1/customer/bookings/:bookingId/cancel/quote

export const customerBookingCancelQuoteRouteInputSchema = z.object({ bookingId: id })

export const customerBookingCancelQuoteSchema = z.object({
  bookingId: id,
  /** False when `blocked` says why not. */
  canCancel: z.boolean(),
  /**
   * Everything paid that the cancel gives back, all of it to store credit: the seats (paid guests included) and every
   * paid add-on. The figure the cancel must send back as `confirmed.storeCredit`. £0 when blocked.
   */
  storeCredit: z.number(),
  /** A credit or pass booking: the credit the cancel returns. Null on a paid or payment-needed booking. */
  creditReturned: z.enum(['membership_credit', 'session_pass_credit']).nullable(),
  blocked: customerCancelBlockedSchema.nullable(),
})
export type CustomerBookingCancelQuote = z.infer<typeof customerBookingCancelQuoteSchema>

// POST /api/v1/customer/bookings/:bookingId/cancel (Idempotency-Key required)

export const customerBookingCancelInputSchema = z.object({ confirmed: customerCancelConfirmedSchema.optional() })
export type CustomerBookingCancelInput = z.infer<typeof customerBookingCancelInputSchema>
export const customerBookingCancelRouteInputSchema = customerBookingCancelInputSchema.extend({ bookingId: id })

export const customerBookingCancelOutputSchema = z.object({
  cancelled: z.literal(true),
  bookingId: id,
  /** What went to store credit. */
  storeCreditRefunded: z.number(),
  /** The customer's store credit balance afterwards, when any was given. */
  storeCreditBalance: z.number().optional(),
  creditReturned: z.enum(['membership_credit', 'session_pass_credit']).nullable(),
  /** The returned credit or pass session can be used again (false when its period or the pass has ended). */
  creditUsableAgain: z.boolean(),
  /** Add-on credits given back to the membership. */
  addonCreditsReturned: z.number(),
})
export type CustomerBookingCancelOutput = z.infer<typeof customerBookingCancelOutputSchema>

// POST /api/v1/customer/event-bookings/:eventBookingId/cancel/quote

/** `attendeeIds`: the places to cancel; left out, every place the booking has left. Loose: the rule answers in words. */
export const customerEventCancelQuoteInputSchema = z.object({ attendeeIds: z.array(z.string()).optional() })
export const customerEventCancelQuoteRouteInputSchema = customerEventCancelQuoteInputSchema.extend({ eventBookingId: id })

export const customerEventCancelQuoteSchema = z.object({
  eventBookingId: id,
  canCancel: z.boolean(),
  /** The places the cancel would take (0 when blocked). */
  places: z.number(),
  /** True when they are every place the booking has left, so the booking itself is cancelled. */
  wholeBooking: z.boolean(),
  /** What the places are worth now, all of it to store credit: the figure to send back as `confirmed.storeCredit`. £0 when blocked. */
  storeCredit: z.number(),
  /** The event's refund cut-off as stored; null when it has none (Q43: its start is then the cut-off). Null when blocked. */
  refundCutoffAt: z.string().nullable(),
  blocked: customerCancelBlockedSchema.nullable(),
})
export type CustomerEventCancelQuote = z.infer<typeof customerEventCancelQuoteSchema>

// POST /api/v1/customer/event-bookings/:eventBookingId/cancel (Idempotency-Key required)

export const customerEventCancelInputSchema = z.object({
  attendeeIds: z.array(z.string()).optional(),
  confirmed: customerCancelConfirmedSchema.optional(),
})
export type CustomerEventCancelInput = z.infer<typeof customerEventCancelInputSchema>
export const customerEventCancelRouteInputSchema = customerEventCancelInputSchema.extend({ eventBookingId: id })

export const customerEventCancelOutputSchema = z.object({
  cancelled: z.literal(true),
  eventBookingId: id,
  /** The places cancelled. */
  places: z.number(),
  storeCreditRefunded: z.number(),
  storeCreditBalance: z.number().optional(),
  /** True when no place is left, so the booking itself is cancelled. */
  bookingCancelled: z.boolean(),
  /** The places the booking still has. */
  placesLeft: z.number(),
})
export type CustomerEventCancelOutput = z.infer<typeof customerEventCancelOutputSchema>

// A refusal (an ApiError's `details`)

/**
 * A refused customer cancel: the reason and the customer's words. With the quote as it now stands when the amount
 * confirmed is missing or no longer what would come back (Q18), and the switch kinds that are off for REFUND_PATH_OFF.
 */
export const customerCancelRefusalDetailsSchema = z.object({
  reason: z.string(),
  message: z.string(),
  quote: z.union([customerBookingCancelQuoteSchema, customerEventCancelQuoteSchema]).optional(),
  kinds: z.array(z.string()).optional(),
})
export type CustomerCancelRefusalDetails = z.infer<typeof customerCancelRefusalDetailsSchema>
