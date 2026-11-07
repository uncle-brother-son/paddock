import { z } from 'zod'

/**
 * Step C: the basket, shared by the quote and (from W06) the order. Field names match the Retool
 * createOrder params, so the staff app's functions stay thin. Input is loose wherever the old
 * function answered for itself: a quantity is any number and a method any string, so the rule
 * refuses with the old reason instead of zod giving a generic VALIDATION.
 */

const id = z.guid()
/** The staff app sends empty or missing optional text in both forms. */
const looseText = z.string().nullish()

// --- The basket

export const basketGuestSchema = z.object({
  name: looseText,
  email: looseText,
  dateOfBirth: looseText,
})
export type BasketGuest = z.infer<typeof basketGuestSchema>

export const basketAddonLineSchema = z.object({
  addonId: id,
  quantity: z.number(),
  /** Only used with Manage pricing: without it the system price stands. */
  unitPrice: z.number().optional(),
  redemptionSource: z.enum(['paid', 'membership_credit']).optional(),
  membershipId: id.nullish(),
  priceOverrideReason: looseText,
})
export type BasketAddonLine = z.infer<typeof basketAddonLineSchema>

export const basketProductLineSchema = z.object({
  productVariantId: id,
  quantity: z.number(),
  /** Only used with Manage pricing: without it the system price stands. */
  unitPrice: z.number().optional(),
  fulfillmentChoice: z.string().nullish(),
  priceOverrideReason: looseText,
})
export type BasketProductLine = z.infer<typeof basketProductLineSchema>

export const basketBookingSchema = z.object({
  sessionId: id,
  guests: z.array(basketGuestSchema),
  /** A string, so 'gift_card' and unknown values get the old reasons. */
  redemptionSource: z.string(),
  membershipId: id.nullish(),
  sessionPassId: id.nullish(),
  cancelExhaustedMembershipId: id.nullish(),
  addons: z.array(basketAddonLineSchema).optional(),
  specialRequests: looseText,
  guestsOver18Confirmed: z.boolean().optional(),
})
export type BasketBooking = z.infer<typeof basketBookingSchema>

export const basketGiftCardSchema = z.object({
  giftCardPresetId: id.nullish(),
  giftCardTypeId: id.nullish(),
  amount: z.number().nullish(),
  recipientName: looseText,
  recipientEmail: looseText,
  giftMessage: looseText,
  fulfillmentMethod: z.string().nullish(),
})
export type BasketGiftCard = z.infer<typeof basketGiftCardSchema>

export const basketEventAttendeeSchema = z.object({
  name: looseText,
  email: looseText,
  dateOfBirth: looseText,
  isAccountHolder: z.boolean().optional(),
})
export type BasketEventAttendee = z.infer<typeof basketEventAttendeeSchema>

export const basketEventSchema = z.object({
  eventId: id,
  attendees: z.array(basketEventAttendeeSchema),
  accountHolderAttending: z.boolean().optional(),
  guestsOver18Confirmed: z.boolean().optional(),
})
export type BasketEvent = z.infer<typeof basketEventSchema>

export const basketShippingAddressSchema = z.object({
  name: looseText,
  line1: looseText,
  line2: looseText,
  city: looseText,
  postcode: looseText,
  country: looseText,
})
export type BasketShippingAddress = z.infer<typeof basketShippingAddressSchema>

export const basketPaymentSchema = z.object({
  /** Redeeming an existing gift card. The basket's own `giftCard` is buying a new one. */
  giftCard: z.object({ giftCardId: id, amount: z.number() }).optional(),
  storeCredit: z.object({ amount: z.number() }).optional(),
  /** A string, so an unknown method gets the old reason. Empty means none chosen yet. */
  method: z.string().nullish(),
  readerSaveCard: z.boolean().optional(),
})
export type BasketPayment = z.infer<typeof basketPaymentSchema>

export const basketSchema = z.object({
  /** Missing for a website guest. */
  customerId: id.optional(),
  booking: basketBookingSchema.optional(),
  /** `membership_credit` here is refused by the rule, with its own reason: only an add-on on a booking can draw a credit. */
  standaloneAddons: z.array(basketAddonLineSchema).optional(),
  products: z.array(basketProductLineSchema).optional(),
  membershipPlanId: id.nullish(),
  membershipBillingFrequency: z.string().nullish(),
  sessionPassTypeId: id.nullish(),
  giftCard: basketGiftCardSchema.optional(),
  event: basketEventSchema.optional(),
  promoCode: looseText,
  postageMethod: z.string().nullish(),
  shippingAddress: basketShippingAddressSchema.optional(),
  saveShippingAddressToCustomer: z.boolean().optional(),
})
export type Basket = z.infer<typeof basketSchema>

// --- POST /api/v1/staff/quotes/basket

export const basketQuoteInputSchema = basketSchema.extend({ payment: basketPaymentSchema.optional() })
export type BasketQuoteInput = z.infer<typeof basketQuoteInputSchema>

export const basketProblemStageSchema = z.enum(['validation', 'booking', 'event', 'product', 'payment', 'gift_card'])
export type BasketProblemStage = z.infer<typeof basketProblemStageSchema>

/** Something that stops the basket. The first is what the order would refuse with. */
export const basketProblemSchema = z.object({
  stage: basketProblemStageSchema,
  reason: z.string(),
  /** Missing where the old function sent no words of its own. */
  message: z.string().optional(),
  bookingFailureReason: z.string().optional(),
  productVariantId: z.string().optional(),
  guestIndex: z.number().optional(),
  amountDueTotal: z.number().optional(),
})
export type BasketProblem = z.infer<typeof basketProblemSchema>

/** One order line, in the order they are written. `lineTotal` is before `discount`. */
export const basketLineSchema = z.object({
  kind: z.enum(['booking', 'event', 'addon', 'product', 'membership', 'session_pass', 'gift_card', 'postage']),
  /** The promo's key for this line, e.g. `product:0`. */
  key: z.string(),
  /** The add-on, variant, plan, pass type or event. Null for a booking, gift card or postage. */
  itemId: z.string().nullable(),
  name: z.string().nullable(),
  quantity: z.number(),
  unitPrice: z.number(),
  lineTotal: z.number(),
  discount: z.number(),
  /** Add-ons and products only. */
  systemUnitPrice: z.number().nullable(),
  /** Only when the price differs from the system price. */
  priceOverrideReason: z.string().nullable(),
})
export type BasketLine = z.infer<typeof basketLineSchema>

export const basketSeatSchema = z.object({
  seatNo: z.number(),
  kind: z.enum(['account_holder', 'guest']),
  payBy: z.enum(['paid', 'membership_credit', 'session_pass_credit']),
  listPrice: z.number().nullable(),
  /** Null on a private booking, which is priced as a whole. */
  unitPrice: z.number().nullable(),
  /** The member discount in the seat's price, as a percentage. */
  discountPercent: z.number(),
  /** Whether a membership credit can cover this seat. */
  creditEligible: z.boolean(),
  /** This seat's share of the promo. Nothing on a private booking, whose share is on the booking. */
  discount: z.number(),
})
export type BasketSeat = z.infer<typeof basketSeatSchema>

/** An add-on attached to the booking. Priced in order_total, but it isn't an order line. */
export const basketBookingAddonSchema = z.object({
  addonId: z.string(),
  name: z.string().nullable(),
  quantity: z.number(),
  unitPrice: z.number(),
  systemUnitPrice: z.number(),
  redemptionSource: z.enum(['paid', 'membership_credit']),
  /** Null with a credit means the membership being bought in this basket. */
  membershipId: z.string().nullable(),
  /** What it adds to the total: nothing when a credit covers it. */
  charged: z.number(),
})
export type BasketBookingAddon = z.infer<typeof basketBookingAddonSchema>

export const basketBookingQuoteSchema = z.object({
  sessionId: z.string(),
  bookingType: z.enum(['public', 'private']).nullable(),
  band: z.object({ code: z.string(), name: z.string() }).nullable(),
  /** What the booking is recorded as, once a credit that can't apply has fallen back to paid. */
  redemptionSource: z.enum(['paid', 'membership_credit', 'session_pass_credit']),
  /** The money seats, before the promo. A private booking's whole price. */
  price: z.number(),
  discount: z.number(),
  seats: z.array(basketSeatSchema),
  addons: z.array(basketBookingAddonSchema),
  /** Trimmed, at most 500 characters, null when empty. */
  specialRequests: z.string().nullable(),
})
export type BasketBookingQuote = z.infer<typeof basketBookingQuoteSchema>

export const basketEventQuoteSchema = z.object({
  eventId: z.string(),
  name: z.string().nullable(),
  places: z.array(
    z.object({
      placeNo: z.number(),
      attendeeType: z.enum(['account_holder', 'guest']),
      priceLevel: z.enum(['public', 'pre_herd', 'herd']),
      unitPrice: z.number(),
      discount: z.number(),
    })
  ),
  listTotal: z.number(),
  discount: z.number(),
  placesLeft: z.number().nullable(),
})
export type BasketEventQuote = z.infer<typeof basketEventQuoteSchema>

export const basketPostageSchema = z.object({
  method: z.enum(['standard', 'express']).nullable(),
  amount: z.number(),
  /** Shipped items before discounts, which decides free Standard postage. */
  shippedValue: z.number(),
})
export type BasketPostage = z.infer<typeof basketPostageSchema>

export const basketDeliverySchema = z.object({
  address: z.object({
    name: z.string(),
    line1: z.string(),
    line2: z.string().nullable(),
    city: z.string(),
    postcode: z.string(),
    country: z.string(),
  }),
  saveToCustomer: z.boolean(),
})
export type BasketDelivery = z.infer<typeof basketDeliverySchema>

export const basketPromoSchema = z.object({
  promoId: z.string(),
  code: z.string(),
  discountTotal: z.number(),
  perLine: z.array(z.object({ key: z.string(), discount: z.number() })),
})
export type BasketPromo = z.infer<typeof basketPromoSchema>

export const basketTotalsSchema = z.object({
  /** At list price: the promo is held separately, as on the orders row. */
  orderTotal: z.number(),
  promoDiscount: z.number(),
  /** Everything but the membership, after the promo. */
  nonMembershipDue: z.number(),
  /** The membership's price after its promo share. */
  membershipFirstPayment: z.number(),
  /** All of it, before gift card and store credit. */
  amountDue: z.number(),
  giftCardApplied: z.number(),
  storeCreditApplied: z.number(),
  /** The gift card and store credit left after everything else, taken off the first payment. */
  spillToMembership: z.number(),
  /** The same spill, by where it came from. Store credit is used first. */
  spillFromStoreCredit: z.number(),
  spillFromGiftCard: z.number(),
  /** The first payment after the promo and the spill, however it is taken. */
  membershipToPay: z.number(),
  /** What each method would take now. `card` and `cash` leave the membership to its invoice; the reader's one tap includes it. */
  toCollect: z.object({ card: z.number(), reader: z.number(), cash: z.number() }),
  /** What the subscription's first invoice takes from the saved card. Nothing on the reader. */
  firstInvoice: z.number(),
})
export type BasketTotals = z.infer<typeof basketTotalsSchema>

export const basketQuoteOutputSchema = z.object({
  lines: z.array(basketLineSchema),
  booking: basketBookingQuoteSchema.nullable(),
  event: basketEventQuoteSchema.nullable(),
  postage: basketPostageSchema.nullable(),
  delivery: basketDeliverySchema.nullable(),
  promo: basketPromoSchema.nullable(),
  totals: basketTotalsSchema,
  problems: z.array(basketProblemSchema),
})
export type BasketQuoteOutput = z.infer<typeof basketQuoteOutputSchema>
