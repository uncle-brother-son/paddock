import { z } from 'zod'

/**
 * Step D (new in W17, D-plan 4.6 and 4.7): the booking changes' routes, ahead of the slices that build them (W18 to
 * W24). Field names match the Retool functions' params (moveBooking, addBookingGuest, settleLapsedBooking,
 * removeBookingGuest, refundBooking, cancelCreditBooking, removeBookingAddon, setBookingSpecialRequests,
 * setBookingStatus, getBookingRefundFigures), so the staff app's functions become thin calls with the same names and
 * result shapes. Input is loose wherever the old function answered for itself (a method or status is any string, an
 * amount any number), so the rule refuses with the old reason and words instead of zod giving a generic VALIDATION
 * (W02's lesson). `confirmed` is new: the figures staff were shown (Q18), checked to half a penny before any money moves.
 * Nothing calls these routes yet (dark); each slice firms up its own output when it builds the route.
 */

const id = z.guid()
/** The staff app sends empty or missing optional text in both forms. */
const looseText = z.string().nullish()
/** Pounds, as the screens send them. Any number: the rule refuses a bad one with the old words. */
const pounds = z.number()

// --- What a booking change is paid with (money in: Move dearer, Add Guest, Settle)

export const bookingPaymentSchema = z.object({
  giftCard: z.object({ giftCardId: id, amount: pounds }).optional(),
  /** Drawn from the customer's own store credit balance, before any card money. */
  storeCredit: z.object({ amount: pounds }).optional(),
  /** 'card' (the saved card), 'reader' or 'cash'. A string, so anything else gets the old reason. */
  method: z.string().optional(),
  /** The old cash tick's figure. Still accepted: the route reads it as `confirmed.toCollect` when that is missing. */
  confirmedCashAmount: pounds.optional(),
})
export type BookingPayment = z.infer<typeof bookingPaymentSchema>

/** 'card' (the original card, the rest to store credit) or 'credit' (store credit). A string, for the old reason. */
const refundMethod = z.string()

// --- Confirmed figures (Q18, D-plan 4.7): what staff saw, checked to half a penny, either way, before money moves

export const moneyInConfirmedSchema = z.object({
  /** The whole amount due for the change (Move: signed, negative is a refund). */
  amountDue: pounds,
  /** What the chosen method collects after gift card and store credit (card, reader or cash). */
  toCollect: pounds.optional(),
})
export type MoneyInConfirmed = z.infer<typeof moneyInConfirmedSchema>

// --- Move

export const moveBookingInputSchema = z.object({
  newSessionId: id,
  /** The old second call's flag. The quote route ignores it; the move route needs it true. */
  confirmed: z.boolean().optional(),
  figures: moneyInConfirmedSchema.optional(),
  payment: bookingPaymentSchema.optional(),
  refundMethod: refundMethod.optional(),
})
export type MoveBookingInput = z.infer<typeof moveBookingInputSchema>

/** moveBooking's MoveSeatDelta, field for field. */
export const moveSeatDeltaSchema = z.object({
  seatNo: z.number(),
  seatKind: z.enum(['account_holder', 'guest']),
  payBy: z.enum(['paid', 'membership_credit', 'session_pass_credit']),
  oldUnitPrice: z.number().nullable(),
  newUnitPrice: z.number(),
  delta: z.number(),
  creditReleased: z.boolean(),
})

/** moveBooking's priceImpact. */
export const movePriceImpactSchema = z.object({
  amountDue: z.number(),
  refundDue: z.boolean(),
  seatDeltas: z.array(moveSeatDeltaSchema),
  legacyPricing: z.boolean(),
  customerId: id,
})
export type MovePriceImpact = z.infer<typeof movePriceImpactSchema>

// --- Add Guest (a guest, add-ons, or both)

export const bookingAddonLineSchema = z.object({
  addonId: id,
  quantity: z.number(),
  /** Only used with Manage pricing (then a different price needs a reason): the system price stands otherwise. */
  unitPrice: z.number().optional(),
  priceOverrideReason: looseText,
  redemptionSource: z.string().optional(),
  membershipId: id.nullish(),
})
export type BookingAddonLine = z.infer<typeof bookingAddonLineSchema>

export const addBookingGuestInputSchema = z.object({
  guestName: looseText,
  guestEmail: looseText,
  guestsOver18Confirmed: z.boolean().optional(),
  useExistingCredit: z.boolean().optional(),
  payment: bookingPaymentSchema.optional(),
  addons: z.array(bookingAddonLineSchema).optional(),
  figures: moneyInConfirmedSchema.optional(),
})
export type AddBookingGuestInput = z.infer<typeof addBookingGuestInputSchema>

/** addBookingGuest's priceImpact. */
export const addGuestPriceImpactSchema = z.object({
  amountDue: z.number(),
  guestAmount: z.number(),
  addonsAmount: z.number(),
  creditAvailable: z.boolean(),
  creditLabel: z.string().optional(),
})
export type AddGuestPriceImpact = z.infer<typeof addGuestPriceImpactSchema>

// --- Settle

export const settleBookingInputSchema = z.object({
  payment: bookingPaymentSchema.optional(),
  figures: moneyInConfirmedSchema.optional(),
})
export type SettleBookingInput = z.infer<typeof settleBookingInputSchema>

// --- A flow that waits for the reader (Move, Settle, Add Guest), as the old functions answered it

export const pendingFlowPaymentSchema = z.object({
  flow: z.enum(['move', 'settle', 'add_guest']),
  recordId: id,
  pendingId: id,
  paymentIntentId: z.string(),
  clientSecret: z.string(),
  amount: z.number(),
})
export type PendingFlowPayment = z.infer<typeof pendingFlowPaymentSchema>

// --- Remove Guest

export const removeGuestInputSchema = z.object({
  /** The quote route ignores it; the remove route refuses a different figure (half a penny, W02 finding 12). */
  confirmedRefundAmount: pounds.optional(),
  refundMethod: refundMethod.optional(),
})
export type RemoveGuestInput = z.infer<typeof removeGuestInputSchema>

export const removeGuestQuoteSchema = z.object({
  bookingId: id,
  bookingType: z.enum(['public', 'private']),
  refundAmount: z.number(),
  refundable: z.boolean(),
  partySize: z.number(),
})
export type RemoveGuestQuote = z.infer<typeof removeGuestQuoteSchema>

// --- Refund figures, and the three amount actions (refundBooking's amount paths)

/** getBookingRefundFigures, field for field (server/rules/bookings/money-left.ts). */
export const bookingRefundFiguresSchema = z.object({
  status: z.string(),
  customerId: id,
  pricePaid: z.number(),
  refundOwed: z.number(),
  left: z.number(),
  cardLeft: z.number(),
  parts: z.object({ card: z.number(), giftCard: z.number(), storeCredit: z.number(), cash: z.number() }),
})
export type BookingRefundFigures = z.infer<typeof bookingRefundFiguresSchema>

export const partRefundInputSchema = z.object({ amount: pounds, refundMethod, reason: looseText })
export type PartRefundInput = z.infer<typeof partRefundInputSchema>

/** Refund the rest: exactly what is owed. */
export const refundOwedInputSchema = z.object({ amount: pounds, refundMethod })
export type RefundOwedInput = z.infer<typeof refundOwedInputSchema>

/** It already arrived: what is owed reached the customer after all; no money moves. */
export const owedArrivedInputSchema = z.object({ amount: pounds, reason: looseText })
export type OwedArrivedInput = z.infer<typeof owedArrivedInputSchema>

// --- Cancel & Refund, Cancel & return credit, Remove add-on

export const moneyOutConfirmedSchema = z.object({
  /** The booking's own money back (Cancel & Refund), or an add-on's (Remove add-on). */
  refund: pounds.optional(),
  /** The ticked paid add-ons' money back. */
  addonsRefund: pounds.optional(),
})
export type MoneyOutConfirmed = z.infer<typeof moneyOutConfirmedSchema>

export const cancelAndRefundInputSchema = z.object({
  refundMethod,
  addonLineIds: z.array(id).optional(),
  confirmed: moneyOutConfirmedSchema.optional(),
})
export type CancelAndRefundInput = z.infer<typeof cancelAndRefundInputSchema>

export const cancelCreditBookingInputSchema = z.object({
  reason: looseText,
  addonLineIds: z.array(id).optional(),
  addonRefund: z.string().optional(),
  confirmed: moneyOutConfirmedSchema.optional(),
})
export type CancelCreditBookingInput = z.infer<typeof cancelCreditBookingInputSchema>

export const removeBookingAddonInputSchema = z.object({
  /** 'card', 'credit' or 'none' ("Remove, no refund"). A string, for the old reason. */
  refund: z.string(),
  confirmed: moneyOutConfirmedSchema.optional(),
})
export type RemoveBookingAddonInput = z.infer<typeof removeBookingAddonInputSchema>

// --- No money: special requests and status

export const bookingSpecialRequestsInputSchema = z.object({ specialRequests: z.string().nullish() })
export type BookingSpecialRequestsInput = z.infer<typeof bookingSpecialRequestsInputSchema>

/** Any string: N3's rule (the four statuses the screen offers) refuses the rest with words. */
export const bookingStatusInputSchema = z.object({ status: z.string() })
export type BookingStatusInput = z.infer<typeof bookingStatusInputSchema>

/** W18: the booking's id comes from the path (`/bookings/:bookingId/...`); the body is the input above. */
const bookingInPath = { bookingId: id }
export const bookingSpecialRequestsRouteInputSchema = bookingSpecialRequestsInputSchema.extend(bookingInPath)
export const bookingStatusRouteInputSchema = bookingStatusInputSchema.extend(bookingInPath)

/** W18: setBookingSpecialRequests' answer, as the old function gave it (the text as saved: trimmed, cut, or null). */
export const bookingSpecialRequestsOutputSchema = z.object({
  updated: z.literal(true),
  booking: z.object({ id, special_requests: z.string().nullable() }),
})
export type BookingSpecialRequestsOutput = z.infer<typeof bookingSpecialRequestsOutputSchema>

/** W18: setBookingStatus' answer, the row as the old function returned it. */
export const bookingStatusOutputSchema = z.object({ id, status: z.string(), cancelled_at: z.string().nullable() })
export type BookingStatusOutput = z.infer<typeof bookingStatusOutputSchema>

// --- Refusals (D-plan 4.6): an ApiError whose details carry the old reason, words and figures

export const bookingRefusalDetailsSchema = z.object({
  /** The old function's reason, word for word ('reader_payment_open', 'cash_amount_changed', ...). */
  reason: z.string(),
  /** What staff see (server/rules/bookings/failure-messages.ts, staffSees). */
  message: z.string(),
  /** Which action refused: the wrappers put the old result shape back from it. */
  action: z.enum(['move', 'add_guest', 'settle', 'remove_guest', 'refund', 'cancel_and_refund', 'cancel_credit', 'remove_addon', 'special_requests', 'status']),
  /** The new figures, so the screen moves to them (Q18, Q11's words). */
  priceImpact: z.union([movePriceImpactSchema, addGuestPriceImpactSchema]).optional(),
  quote: removeGuestQuoteSchema.optional(),
  amountDue: z.number().optional(),
  figures: bookingRefundFiguresSchema.optional(),
  /** Remove Guest: pressing again would refund a second time (the old retryLocked). */
  retryLocked: z.boolean().optional(),
})
export type BookingRefusalDetails = z.infer<typeof bookingRefusalDetailsSchema>
