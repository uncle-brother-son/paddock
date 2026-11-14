import { z } from 'zod'

/**
 * Step E (new in W27, E-plan 4.4, 4.7 and 4.8): the event cancellation routes, ahead of the slices that build them
 * (W30 event places, W31 the whole event). Field names match the Retool functions' params and results
 * (cancelEventPlaces, cancelEvent, getEventCancellationQuote, getEventCancellationOverview), so the staff app's
 * functions become thin calls with the same names and result shapes. Input is loose wherever the old function
 * answered for itself (a refund choice is any string), so the rule refuses with the old reason and words instead of
 * zod giving a generic VALIDATION (W02's lesson). `confirmed` is new: the figure staff were shown (Q18), checked to
 * half a penny before any money moves.
 * Nothing calls these routes yet (dark); each slice firms up its own output when it builds the route.
 *
 *   POST /api/v1/staff/event-bookings/:eventBookingId/cancel/quote   getEventCancellationQuote
 *   POST /api/v1/staff/event-bookings/:eventBookingId/cancel         cancelEventPlaces, and cancelEvent's per-booking half
 *   GET  /api/v1/staff/events/:eventId/cancel/overview               getEventCancellationOverview
 *   POST /api/v1/staff/events/:eventId/cancel                        cancelEvent's first half (lead call L5)
 *
 * The event quote and basket schemas of New Order are in quotes.ts and orders.ts; these are only the cancellations'.
 */

const id = z.guid()
/** Pounds, as the screens send them. Any number: the rule refuses a bad one with the old words. */
const pounds = z.number()
/** The staff app sends empty or missing optional text in both forms. */
const looseText = z.string().nullish()

const eventBookingInPath = { eventBookingId: id }
const eventInPath = { eventId: id }

/** A card refund the press couldn't get a clear answer on (or couldn't record yet): held for reconcile, as step D's. */
const heldEventRefundSchema = z.object({ claimId: z.string(), reason: z.string(), message: z.string() })

// --- POST /api/v1/staff/event-bookings/:eventBookingId/cancel/quote (getEventCancellationQuote)

/** The places to cancel; omit for every remaining place in the booking. */
export const eventCancelQuoteInputSchema = z.object({ attendeeIds: z.array(z.string()).optional() })
export type EventCancelQuoteInput = z.infer<typeof eventCancelQuoteInputSchema>
export const eventCancelQuoteRouteInputSchema = eventCancelQuoteInputSchema.extend(eventBookingInPath)

/**
 * The quote, in the old function's fields: what the places are worth now (event_cancellation_quote), the cut-off, and
 * where a Card refund would go. New from W30: the cash that can be handed back (Q26) and any money owed on the
 * booking's order (Q39). A refusal is an ApiError whose details carry the old reason and words.
 */
export const eventCancelQuoteOutputSchema = z.object({
  places: z.number(),
  wholeBooking: z.boolean(),
  /** The refund in full. */
  value: z.number(),
  refundCutoffAt: z.string().nullable(),
  beforeCutoff: z.boolean(),
  eventStarted: z.boolean(),
  /** The card part of a Card refund: capped at the order's card money still refundable, 0 with no card on the order. */
  cardAmount: z.number(),
  /** The rest of a Card refund, to store credit. */
  storeCreditAmount: z.number(),
  cashAmount: z.number().optional(),
  refundOwed: z.number().optional(),
})
export type EventCancelQuoteOutput = z.infer<typeof eventCancelQuoteOutputSchema>

// --- POST /api/v1/staff/event-bookings/:eventBookingId/cancel (cancelEventPlaces; cancelEvent's per-booking half)

export const eventCancelConfirmedSchema = z.object({
  /** The refund staff saw on the quote, or on the overview for a whole-event cancel (Q18). £0 for No refund. */
  refund: pounds,
})
export type EventCancelConfirmed = z.infer<typeof eventCancelConfirmedSchema>

/** cancelEventPlaces's params, with `confirmed` and `wholeEvent`. Loose: the rule answers the old reasons. */
export const cancelEventPlacesInputSchema = z.object({
  attendeeIds: z.array(z.string()).optional(),
  /** 'card', 'credit', 'none' or, from W30, 'cash' (Q26). A string, for the old reason. */
  refund: z.string().optional(),
  /** Required to refund after the event's refund cut-off; recorded either way. */
  reason: looseText,
  /** The booking is cancelled because its event was: no cut-off rule. Honoured only when the event is cancelled in the database. */
  wholeEvent: z.boolean().optional(),
  confirmed: eventCancelConfirmedSchema.optional(),
})
export type CancelEventPlacesInput = z.infer<typeof cancelEventPlacesInputSchema>
export const cancelEventPlacesRouteInputSchema = cancelEventPlacesInputSchema.extend(eventBookingInPath)

/** One place as the attendee list shows it (shared/eventAttendeeList.ts's EventAttendeeRow). */
export const eventAttendeeRowSchema = z.object({
  id,
  event_booking_id: id,
  attendee_type: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  price_level: z.string(),
  unit_price: z.string(),
  waiver_accepted: z.boolean(),
  waiver_method: z.string().nullable(),
  waiver_accepted_at: z.string().nullable(),
  extra_waiver_state: z.string(),
  event_waiver_method: z.string().nullable(),
  event_waiver_accepted_at: z.string().nullable(),
  checked_in_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  cancel_reason: z.string().nullable(),
  cancelled_by_name: z.string().nullable(),
  cancelled_value: z.string(),
  refunded_amount: z.string(),
  card_refunded_amount: z.string(),
  refund_method: z.string().nullable(),
  refund_after_cutoff: z.boolean(),
})
export type EventAttendeeRow = z.infer<typeof eventAttendeeRowSchema>

/** The booking as the attendee list shows it after a cancel (EventAttendeeBooking). */
export const eventAttendeeBookingSchema = z.object({
  id,
  customer_id: id,
  customer_first_name: z.string(),
  customer_last_name: z.string(),
  customer_email: z.string().nullable(),
  customer_phone: z.string().nullable(),
  status: z.string(),
  places: z.number(),
  price_paid: z.string(),
  ordered_at: z.string(),
  cancelled_at: z.string().nullable(),
  cancel_reason: z.string().nullable(),
  attendees: z.array(eventAttendeeRowSchema),
})
export type EventAttendeeBooking = z.infer<typeof eventAttendeeBookingSchema>

/**
 * cancelEventPlaces's answer once the cancel (R1) has committed, in the old function's fields. `held`: a card refund
 * got no clear answer (or went and couldn't be recorded yet), so the claim is held for reconcile; the places stay
 * cancelled. `refundOwed`: money left on the booking's order as still to refund (Q39).
 */
export const cancelEventPlacesOutputSchema = z.object({
  places: z.number(),
  /** Card + store credit + cash given back. */
  refundedAmount: z.number(),
  cardRefundedAmount: z.number(),
  storeCreditRefundedAmount: z.number(),
  cashRefundedAmount: z.number().optional(),
  storeCreditBalance: z.number().optional(),
  /** The booking as the attendee list shows it now (null when it couldn't be re-read). */
  booking: eventAttendeeBookingSchema.nullable(),
  /** The event's places booked after the cancel, for the attendee list header. */
  eventPlacesBooked: z.number().optional(),
  refundOwed: z.number().optional(),
  warning: z.string().optional(),
  held: heldEventRefundSchema.optional(),
})
export type CancelEventPlacesOutput = z.infer<typeof cancelEventPlacesOutputSchema>

// --- GET /api/v1/staff/events/:eventId/cancel/overview (getEventCancellationOverview)

export const eventCancelOverviewBookingSchema = z.object({
  eventBookingId: id,
  customerName: z.string(),
  places: z.number(),
  /** The full refund for this booking's remaining places (event_cancellation_quote). */
  value: z.number(),
  /** Set when the booking can't be cancelled as things stand (a place is checked in). */
  problem: z.string().nullable(),
  /** From W31: where a Card refund of it would go, for the figure the screen sends back (Q18). */
  cardAmount: z.number().optional(),
  storeCreditAmount: z.number().optional(),
})
export type EventCancelOverviewBooking = z.infer<typeof eventCancelOverviewBookingSchema>

/** The overview, in the old function's fields. The old function answered null for an event that is gone; the route answers NOT_FOUND. */
export const eventCancelOverviewOutputSchema = z.object({
  eventName: z.string(),
  ended: z.boolean(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  /** Customers with a payment still in progress (cancelling is refused meanwhile). */
  pendingCustomers: z.array(z.string()),
  /** Confirmed bookings still to cancel. */
  bookings: z.array(eventCancelOverviewBookingSchema),
  totalPlaces: z.number(),
  totalValue: z.number(),
})
export type EventCancelOverviewOutput = z.infer<typeof eventCancelOverviewOutputSchema>
export const eventCancelOverviewRouteInputSchema = z.object(eventInPath)

// --- POST /api/v1/staff/events/:eventId/cancel (cancelEvent's first half; lead call L5)

/**
 * The whole event: one transaction marks it off sale and cancelled (E7), and answers the bookings still to cancel.
 * The screen then cancels each booking with its own press of the place cancel (`wholeEvent: true`), so `refund` is no
 * longer a param of this route (L5); the old function took it here and cancelled every booking in one call (E6).
 */
export const cancelEventInputSchema = z.object({ reason: looseText })
export type CancelEventInput = z.infer<typeof cancelEventInputSchema>
export const cancelEventRouteInputSchema = cancelEventInputSchema.extend(eventInPath)

/** What the event's cancel answers: the overview as it now stands (the bookings still to cancel). */
export const cancelEventOutputSchema = eventCancelOverviewOutputSchema
export type CancelEventOutput = z.infer<typeof cancelEventOutputSchema>

/** One booking's outcome in the whole-event run, as the old function listed it (the screen builds the list from each press). */
export const cancelEventBookingOutcomeSchema = z.object({
  eventBookingId: id,
  customerName: z.string(),
  places: z.number(),
  ok: z.boolean(),
  cardRefundedAmount: z.number(),
  storeCreditRefundedAmount: z.number(),
  /** Why it failed (ok false), or what needs a check (ok true). */
  message: z.string().optional(),
})
export type CancelEventBookingOutcome = z.infer<typeof cancelEventBookingOutcomeSchema>

// --- A refusal (an ApiError's `details`)

/**
 * A refused event cancel: the old function's reason and the words staff see (server/rules/events/failure-messages.ts),
 * so the thin wrappers put the old result shapes back (`ok: false, reason, message`). With the new `quote` when the
 * confirmed refund no longer fits (Q18).
 */
export const eventCancelRefusalDetailsSchema = z.object({
  reason: z.string(),
  message: z.string(),
  action: z.enum(['cancel_places', 'cancel_event', 'quote', 'overview']),
  quote: eventCancelQuoteOutputSchema.optional(),
  /** REFUND_PATH_OFF: the switch kinds that are off. */
  kinds: z.array(z.string()).optional(),
})
export type EventCancelRefusalDetails = z.infer<typeof eventCancelRefusalDetailsSchema>
