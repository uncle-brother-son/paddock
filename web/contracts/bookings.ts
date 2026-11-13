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
  /** W22a (Wayne's decision, 13 Nov): the session starts within 24 real hours, so the refund is £0 (Part refund instead). */
  insideTwentyFourHours: z.boolean(),
  partySize: z.number(),
})
export type RemoveGuestQuote = z.infer<typeof removeGuestQuoteSchema>

/**
 * W22: what removing the add-on gives back, for the dialog to show and send back as `confirmed.refund` (Q18): a paid
 * add-on's price × quantity (`amount`), and `refund`, what card or store credit would give (£0 inside 24 hours of the
 * session). "Remove, no refund" and a credit add-on give £0 of money.
 */
export const removeAddonQuoteSchema = z.object({
  lineId: id,
  bookingId: id,
  paid: z.boolean(),
  amount: z.number(),
  insideTwentyFourHours: z.boolean(),
  refund: z.number(),
})
export type RemoveAddonQuote = z.infer<typeof removeAddonQuoteSchema>

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
  /**
   * W21 (Q26): the cash that can be handed back: the cash recorded on the booking's own orders (an order paid in cash
   * or split with no Stripe payment), less cash already handed back, never more than the cash part above. Cash taken
   * with no order (Settle, Move: Q36) isn't counted, so it can only go back as store credit. The figures route always
   * sends it; the old figures had none.
   */
  cashLeft: z.number().optional(),
  /**
   * W21a (W21 review S1): what is left to refund, in words ("Left to refund: £25.00 card money.", "Nothing left to
   * refund."), shown in the Part refund dialog. Route only.
   */
  paidLine: z.string().optional(),
})
export type BookingRefundFigures = z.infer<typeof bookingRefundFiguresSchema>

/** W21 (Q26): Part refund also takes 'cash' (handed over by the staff member, capped at `cashLeft`). */
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

/**
 * W23: Cancel & Refund's press. `confirmed` is what the quote showed (Q18, half a penny each): `refund` the booking's
 * own money back (price paid, money still owed included), `addonsRefund` the ticked paid add-ons' money back. Missing
 * counts as £0, so a press without the figures is refused with the new quote whenever money goes back.
 */
export const cancelAndRefundInputSchema = z.object({
  refundMethod,
  addonLineIds: z.array(id).optional(),
  confirmed: moneyOutConfirmedSchema.optional(),
  /**
   * W23a (Wayne, 13 Nov): the club is cancelling (Block Session or Block Day), so the 24-hour rule doesn't apply: the
   * whole booking comes back at any time before the session starts. Money back still needs Issue refunds. Recorded on
   * the claim and the cancel's audit row. Missing: a cancel from the booking page, with the 24-hour rule.
   */
  clubCancelled: z.boolean().optional(),
})
export type CancelAndRefundInput = z.infer<typeof cancelAndRefundInputSchema>

/**
 * W23: Cancel & return credit's and Cancel (payment needed)'s press. `addonRefund` ('card' or 'credit') refunds the
 * ticked paid add-ons (Issue refunds); without it they are left as they are. `confirmed.addonsRefund` is what the quote
 * showed for them (missing counts as £0).
 */
export const cancelCreditBookingInputSchema = z.object({
  reason: looseText,
  addonLineIds: z.array(id).optional(),
  addonRefund: z.string().optional(),
  confirmed: moneyOutConfirmedSchema.optional(),
  /** W23a: as Cancel & Refund's: the club is cancelling, so credits, a pass session and add-on credits come back and ticked paid add-ons are refunded inside 24 hours too. */
  clubCancelled: z.boolean().optional(),
})
export type CancelCreditBookingInput = z.infer<typeof cancelCreditBookingInputSchema>

/**
 * W23: what cancelling gives back, for the dialogs to show and send back as `confirmed` (Q18). A read: never refused
 * for a payment still being taken or a refund still being checked; `blocked` says what a press would be refused with now
 * (those, the 24-hour rule, a booking that can't be cancelled this way), with the old words.
 */
export const cancelQuoteSchema = z.object({
  bookingId: id,
  status: z.string(),
  /** Cancel & Refund: the booking's own money back (its price paid, money still owed included). Cancel & return credit: £0. */
  refund: z.number(),
  /** Of `refund`, money owed from an earlier refund that didn't reach the customer. */
  owed: z.number(),
  /** The ticked paid add-ons' money back (price × quantity; £0 inside 24 hours of the session). */
  addonsRefund: z.number(),
  /** The ticked add-on lines counted: those still on this booking. */
  addonLineIds: z.array(id),
  /** With the card (Q37): what the card(s) that paid can take back, and the rest, which goes to store credit. */
  parts: z.object({ card: z.number(), storeCredit: z.number() }),
  /** Q37: the card is offered whenever card money is left to give back. */
  cardRefundAvailable: z.boolean(),
  insideTwentyFourHours: z.boolean(),
  /** What is left to refund on the booking, in words (the figures' line, W21a). */
  paidLine: z.string(),
  blocked: z.object({ reason: z.string(), message: z.string() }).nullable(),
})
export type CancelQuote = z.infer<typeof cancelQuoteSchema>

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

/**
 * W19: settleLapsedBooking's route. `figures` are what the Settle dialog showed (Q18): `amountDue` seat 1's price,
 * `toCollect` what the chosen method takes after the gift card and store credit. The old cash tick's
 * `payment.confirmedCashAmount` still counts as `figures.toCollect` when that is missing.
 */
export const settleBookingRouteInputSchema = settleBookingInputSchema.extend(bookingInPath)

/**
 * W19: settleLapsedBooking's answer, as the old function gave it: settled, with the booking and seat 1's price; or, on
 * the reader, not settled yet, with the payment the screen collects and then finalises or cancels (the flow routes).
 * A refusal, a decline and a held payment (Q35) are ApiErrors whose details carry the reason and words.
 */
export const settleBookingOutputSchema = z.object({
  settled: z.boolean(),
  booking: z
    .object({
      id,
      status: z.string(),
      redemption_source: z.string(),
      price_paid: z.string(),
      payment_due_by: z.string().nullable(),
    })
    .optional(),
  amountCharged: z.number().optional(),
  pendingReaderPayment: pendingFlowPaymentSchema.optional(),
})
export type SettleBookingOutput = z.infer<typeof settleBookingOutputSchema>

/**
 * W20: addBookingGuest's route (a guest, add-ons, or both). The dialog's first call sends no payment: when money is
 * due the answer is the Worker's figures (`priceImpact`) and nothing is added. The second call sends the payment and
 * `figures` (Q18): `amountDue` the guest's seat plus the paid add-ons, `toCollect` what the chosen method takes after
 * the gift card and store credit. The old cash tick's `payment.confirmedCashAmount` still counts as `figures.toCollect`
 * when that is missing.
 */
export const addBookingGuestRouteInputSchema = addBookingGuestInputSchema.extend(bookingInPath)

/** W20: the guest row as the old function answered it (`to_jsonb` of the inserted row). */
export const addedGuestSchema = z.object({
  id,
  guest_name: z.string(),
  guest_email: z.string().nullable(),
  guest_type: z.string(),
  unit_price: z.number().nullable(),
  pay_by: z.string().nullable(),
})
export type AddedGuest = z.infer<typeof addedGuestSchema>

/**
 * W20: addBookingGuest's answer, as the old function gave it: added (with the guest and the add-on lines); not added
 * with `priceImpact` (the quote: money is due and no payment was sent); not added with `limitReached`; or, on the
 * reader, added and pending the payment the screen collects and then finalises or cancels (the flow routes). A
 * refusal, a decline and a held payment (Q35) are ApiErrors whose details carry the reason, words and figures.
 */
export const addBookingGuestOutputSchema = z.object({
  added: z.boolean(),
  limitReached: z.boolean().optional(),
  guest: addedGuestSchema.nullable().optional(),
  priceImpact: addGuestPriceImpactSchema.optional(),
  addonLineIds: z.array(id).optional(),
  pendingReaderPayment: pendingFlowPaymentSchema.optional(),
})
export type AddBookingGuestOutput = z.infer<typeof addBookingGuestOutputSchema>

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
  /** W19: the flow's record when the change is held for reconcile (Q35) or was undone after a decline. */
  pendingId: z.string().optional(),
  /** W20 (W06 F4): which guest a guest refusal is about. Add Guest has one, so 0. */
  guestIndex: z.number().optional(),
  /** W22: Remove add-on's figures, when the refund staff confirmed is no longer what would go back. */
  addonQuote: removeAddonQuoteSchema.optional(),
  /** W22: Remove Guest refused for want of Issue refunds (the old blockedByRefundPermission). */
  blockedByRefundPermission: z.boolean().optional(),
  /** W23: Cancel & Refund's or Cancel & return credit's figures, when what staff confirmed is no longer what would go back. */
  cancelQuote: cancelQuoteSchema.optional(),
  /**
   * W20: true when the old function sent no words of its own for this reason, so `message` is the dialog's own words
   * for it. The Add Guest wrapper then leaves `message` out, as the old answer did; the dialog shows the same words.
   */
  screenWords: z.boolean().optional(),
})
export type BookingRefusalDetails = z.infer<typeof bookingRefusalDetailsSchema>

// --- W21: the refund figures, Part refund, Refund the rest and It already arrived (refundBooking's amount paths)

/** W21: GET /api/v1/staff/bookings/:bookingId/refund-figures (getBookingRefundFigures). */
export const bookingRefundFiguresRouteInputSchema = z.object(bookingInPath)
/** The figures route always sends `cashLeft` and `paidLine`. */
export const bookingRefundFiguresRouteOutputSchema = bookingRefundFiguresSchema.extend({ cashLeft: z.number(), paidLine: z.string() })
export type BookingRefundFiguresRouteOutput = z.infer<typeof bookingRefundFiguresRouteOutputSchema>

export const partRefundRouteInputSchema = partRefundInputSchema.extend(bookingInPath)
export const refundOwedRouteInputSchema = refundOwedInputSchema.extend(bookingInPath)
export const owedArrivedRouteInputSchema = owedArrivedInputSchema.extend(bookingInPath)

/**
 * W21: what Part refund, Refund the rest and It already arrived answer once the claim (R1) has committed, in the old
 * function's fields: what went to the card, to store credit and (Q26) in cash, the store credit balance after, the
 * booking's price paid after, and a warning when a later card part was refused and went to store credit. `held`: a
 * card refund got no clear answer (or went and couldn't be recorded yet), so the claim is held for reconcile (Q35):
 * nothing more is sent by any press, and the words say not to refund it again. A refusal before anything moved is an
 * ApiError whose details carry the old reason and words (with the new `figures` when the amount no longer fits).
 */
export const refundBookingOutputSchema = z.object({
  cardRefundedAmount: z.number(),
  storeCreditRefundedAmount: z.number(),
  cashRefundedAmount: z.number().optional(),
  storeCreditBalance: z.number().optional(),
  pricePaid: z.number().optional(),
  warning: z.string().optional(),
  held: z.object({ claimId: z.string(), reason: z.string(), message: z.string() }).optional(),
  /** W23: a cancel's ticked add-ons' share (the amounts above are then the booking's own money, as the old answer had them). */
  addons: z.object({ cardRefundedAmount: z.number(), storeCreditRefundedAmount: z.number(), storeCreditBalance: z.number().optional() }).optional(),
})
export type RefundBookingOutput = z.infer<typeof refundBookingOutputSchema>

// --- W22: Remove Guest and Remove add-on (removeBookingGuest, removeBookingAddon)

/** A card refund the press couldn't get a clear answer on (or couldn't record yet): held for reconcile (Q35). */
const heldRefundSchema = z.object({ claimId: z.string(), reason: z.string(), message: z.string() })

/** W22: the guest's id comes from the path (`/bookings/guests/:guestId/remove`, `.../remove/quote`). */
const guestInPath = { guestId: id }
export const removeGuestQuoteRouteInputSchema = z.object(guestInPath)
export const removeGuestRouteInputSchema = removeGuestInputSchema.extend(guestInPath)

/**
 * W22: removeBookingGuest's answer, as the old function gave it: the quote (`removed: false`, nothing changed);
 * `blocked` for the account holder; removed, with what went to the card and to store credit. `held`: the guest is
 * removed and a card refund got no clear answer (or went and couldn't be recorded yet), so it is held for reconcile
 * (Q35) and never sent again by a press. A refusal before anything changed is an ApiError whose details carry the old
 * reason and words (and the new `quote` when the amount no longer fits).
 */
export const removeGuestOutputSchema = z.object({
  removed: z.boolean(),
  blocked: z.boolean(),
  guestId: id,
  quote: removeGuestQuoteSchema.optional(),
  refundedAmount: z.number().optional(),
  cardRefundedAmount: z.number().optional(),
  storeCreditRefundedAmount: z.number().optional(),
  storeCreditBalance: z.number().optional(),
  warning: z.string().optional(),
  held: heldRefundSchema.optional(),
})
export type RemoveGuestOutput = z.infer<typeof removeGuestOutputSchema>

/** W22: the add-on line's id comes from the path (`/bookings/addon-lines/:lineId/remove`, `.../remove/quote`). */
const lineInPath = { lineId: id }
export const removeAddonQuoteRouteInputSchema = z.object(lineInPath)
export const removeBookingAddonRouteInputSchema = removeBookingAddonInputSchema.extend(lineInPath)


/**
 * W22: removeBookingAddon's answer once the add-on is removed, in the old fields (cancelBookingAddonLines' result and
 * its one-line summary). `held` as Remove Guest's. A refusal is an ApiError whose details carry the old reason and words
 * (and `addonQuote` when the confirmed refund no longer fits).
 */
export const removeBookingAddonOutputSchema = z.object({
  removed: z.literal(true),
  summary: z.string(),
  cancelledLineIds: z.array(id),
  refundedAmount: z.number(),
  cardRefundedAmount: z.number(),
  storeCreditRefundedAmount: z.number(),
  creditsReturned: z.number(),
  storeCreditBalance: z.number().optional(),
  notes: z.array(z.string()),
  warning: z.string().optional(),
  held: heldRefundSchema.optional(),
})
export type RemoveBookingAddonOutput = z.infer<typeof removeBookingAddonOutputSchema>

// --- W23: Cancel & Refund, Cancel & return credit and Cancel (payment needed) (refundBooking's Cancel & Refund,
// cancelCreditBooking)

/** W23: the quote's body: the ticked add-on lines (none, when missing, as the press reads it); W23a: the club's cancel. */
export const cancelQuoteInputSchema = z.object({
  addonLineIds: z.array(id).optional(),
  /** W23a: the club is cancelling (Block Session, Block Day): the quote shows the whole amount inside 24 hours too. */
  clubCancelled: z.boolean().optional(),
})
export type CancelQuoteInput = z.infer<typeof cancelQuoteInputSchema>
export const cancelQuoteRouteInputSchema = cancelQuoteInputSchema.extend(bookingInPath)
export const cancelAndRefundRouteInputSchema = cancelAndRefundInputSchema.extend(bookingInPath)
export const cancelCreditBookingRouteInputSchema = cancelCreditBookingInputSchema.extend(bookingInPath)

/** W23: the ticked add-ons' outcome, as cancelBookingAddonLines answered it, with its one-line summary. */
export const cancelAddonsOutcomeSchema = z.object({
  cancelledLineIds: z.array(id),
  refundedAmount: z.number(),
  cardRefundedAmount: z.number(),
  storeCreditRefundedAmount: z.number(),
  creditsReturned: z.number(),
  storeCreditBalance: z.number().optional(),
  notes: z.array(z.string()),
  summary: z.string(),
})
export type CancelAddonsOutcome = z.infer<typeof cancelAddonsOutcomeSchema>

/**
 * W23: Cancel & Refund's answer once R1 has committed, in the old fields: the booking's own money to the card and to
 * store credit (and the balance after), the ticked add-ons' outcome, a warning when a later card part was refused and
 * went to store credit. `held`: a card refund got no clear answer (or went and couldn't be recorded yet): the booking
 * is cancelled and the refund is held for reconcile (Q35), never sent again by a press. A refusal before anything
 * changed is an ApiError whose details carry the old reason and words (and `cancelQuote` when the figures moved).
 */
export const cancelAndRefundOutputSchema = z.object({
  cancelled: z.literal(true),
  cardRefundedAmount: z.number(),
  storeCreditRefundedAmount: z.number(),
  storeCreditBalance: z.number().optional(),
  addons: cancelAddonsOutcomeSchema.optional(),
  warning: z.string().optional(),
  held: heldRefundSchema.optional(),
})
export type CancelAndRefundOutput = z.infer<typeof cancelAndRefundOutputSchema>

/**
 * W23: cancelCreditBooking's answer once cancelled, as the old function gave it: whether the credit can be used again
 * (its period, or the pass, still covers today), the booking, the reason staff typed (as `message`), the ticked
 * add-ons' outcome, a warning, and `held` as Cancel & Refund's. A refusal is an ApiError with the old reason and words.
 */
export const cancelCreditBookingOutputSchema = z.object({
  cancelled: z.literal(true),
  creditUsableAgain: z.boolean(),
  booking: z.object({ id, status: z.string() }),
  message: z.string().optional(),
  addons: cancelAddonsOutcomeSchema.optional(),
  warning: z.string().optional(),
  held: heldRefundSchema.optional(),
})
export type CancelCreditBookingOutput = z.infer<typeof cancelCreditBookingOutputSchema>
