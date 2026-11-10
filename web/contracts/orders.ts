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

// --- POST /api/v1/staff/orders (W06 to W09: cash, gift card, store credit and nothing owed; W10: the saved card; the rest answers NOT_BUILT)

/**
 * What staff saw and confirmed, from the quote. Each figure is loose, as the old function was. W06
 * checks `toCollect` on cash, with the old words, a missing figure counting as nothing confirmed.
 * W09 checks `toCollect` for every other method the same way, and `amountDue` when it is sent (the
 * old createOrder's params have none, so the shadow's dry run and the replay send none), with
 * W03-decisions Q11's words. `firstInvoice` is taken now and checked from W13 (W03-plan 2.7). W10: on
 * the saved card `toCollect` is what the card is charged, checked the same way; only the dry run takes
 * a missing card figure as confirmed (W03-decisions, "W10 setup calls").
 */
export const orderConfirmedSchema = z.object({
  amountDue: z.number().optional(),
  /** What the chosen method takes now: on cash, the figure on the tick. */
  toCollect: z.number().optional(),
  firstInvoice: z.number().optional(),
})
export type OrderConfirmed = z.infer<typeof orderConfirmedSchema>

export const placeOrderInputSchema = basketSchema.extend({
  /** Missing counts as none: nothing chosen, nothing applied. */
  payment: basketPaymentSchema.optional(),
  confirmed: orderConfirmedSchema.optional(),
})
export type PlaceOrderInput = z.infer<typeof placeOrderInputSchema>

/**
 * W11: what the screen collects on the reader, as createOrder's pendingReaderPayment: the intent, its
 * secret for the Terminal SDK, and the single tap's amount in pounds (the server's figure).
 */
export const pendingReaderPaymentSchema = z.object({
  orderId: z.string(),
  paymentIntentId: z.string(),
  clientSecret: z.string(),
  amount: z.number(),
})
export type PendingReaderPayment = z.infer<typeof pendingReaderPaymentSchema>

export const placeOrderOutputSchema = z.object({
  orderId: z.string(),
  /**
   * A saved-card order answers 'paid' only once the card is charged and the order marked paid (W10); a
   * refused card is an error (PAYMENT_FAILED or PAYMENT_NEEDS_AUTHENTICATION, nothing kept), and an
   * unclear one PAYMENT_UNCONFIRMED (held pending). W11: a reader order answers 'pending_reader' with
   * `pendingReaderPayment`, the order pending until the finalise route; an intent Stripe refused is an
   * error (PAYMENT_FAILED, reader_intent_failed, nothing kept), and an unclear one PAYMENT_UNCONFIRMED.
   */
  status: z.enum(['paid', 'pending_reader']),
  bookingId: z.string().nullable(),
  /** The session pass bought, on its own or to pay for the booking (W07). */
  sessionPassId: z.string().nullable(),
  /** The gift card bought, and its code, which staff give the customer (W07). */
  giftCardId: z.string().nullable(),
  giftCardCode: z.string().nullable(),
  /** The event booking, when the order has an event (W08). */
  eventBookingId: z.string().nullable(),
  payment: z.object({
    /** What orders.payment_method records: null when nothing was owed. On 'pending_reader' (W11), 'reader': T2 records it. */
    method: z.string().nullable(),
    /** Taken now by that method: on cash, what staff collect; on the saved card, what it was charged (W10). */
    collected: z.number(),
    /** Whether the saved card was charged (W10). */
    cardCharged: z.boolean(),
    /** The gift card and store credit taken, as sent (W09). createOrder answered them as giftCardRedeemedAmount and storeCreditRedeemedAmount. */
    giftCardApplied: z.number(),
    storeCreditApplied: z.number(),
  }),
  /** W11: on 'pending_reader', what the screen collects. Never in a dry run, which makes no intent. */
  pendingReaderPayment: pendingReaderPaymentSchema.optional(),
})
export type PlaceOrderOutput = z.infer<typeof placeOrderOutputSchema>

// --- POST /api/v1/staff/orders/:orderId/finalise and /cancel (W11)

/** The order, from the path. */
export const readerOrderInputSchema = z.object({ orderId: id })
export type ReaderOrderInput = z.infer<typeof readerOrderInputSchema>

/**
 * finaliseReaderOrder's answer, as data (W03-plan 2.3: an outcome after money has moved, not a
 * refusal). `reason` and `message` are the old function's, where it had them; W11's new ones are named
 * in server/rules/orders/reader-order.ts.
 */
export const finaliseReaderOrderOutputSchema = z.object({
  finalised: z.boolean(),
  orderId: z.string().optional(),
  paymentIntentId: z.string().optional(),
  /** The order was already paid with this same PaymentIntent: nothing was done. */
  alreadyFinalised: z.boolean().optional(),
  /** The PaymentIntent hasn't succeeded: the screen cancels instead, or the customer taps again. */
  paymentNotSucceeded: z.boolean().optional(),
  piStatus: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  warning: z.string().optional(),
})
export type FinaliseReaderOrderOutput = z.infer<typeof finaliseReaderOrderOutputSchema>

/** cancelReaderOrder's answer, as data. */
export const cancelReaderOrderOutputSchema = z.object({
  cancelled: z.boolean(),
  orderId: z.string().optional(),
  /** The order was already gone: nothing to cancel. */
  alreadyGone: z.boolean().optional(),
  /** The payment had in fact succeeded: the order was finalised instead (see `finaliseResult`). */
  finalisedInstead: z.boolean().optional(),
  finaliseResult: finaliseReaderOrderOutputSchema.optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  warning: z.string().optional(),
})
export type CancelReaderOrderOutput = z.infer<typeof cancelReaderOrderOutputSchema>

/**
 * A refusal's `details`, as the old createOrder answered it, so the staff app can hand the screen the
 * same `{ success: false, stage, reason, message }` it reads today. `message` is the old function's
 * own words, missing where it had none; the error's own message is what staff see.
 */
export const orderRefusalDetailsSchema = z.object({
  stage: basketProblemStageSchema,
  reason: z.string(),
  message: z.string().optional(),
  bookingFailureReason: z.string().optional(),
  productVariantId: z.string().optional(),
  amountDueTotal: z.number().optional(),
  guestIndex: z.number().optional(),
})
export type OrderRefusalDetails = z.infer<typeof orderRefusalDetailsSchema>

/** NOT_BUILT's `details`: the parts of the order that aren't built yet, in a fixed order. */
export const orderNotBuiltDetailsSchema = z.object({ notBuilt: z.array(z.string()) })
export type OrderNotBuiltDetails = z.infer<typeof orderNotBuiltDetailsSchema>

// --- POST /api/v1/staff/orders/dry-run (until W16)

const money = z.number()

/**
 * The rows an order wrote, read back by order id. Free text (names, emails, dates of birth, special
 * requests, override reasons, addresses, a gift card's recipient and message, an event attendee's name,
 * email and date of birth) is here for comparing, and the staff app never keeps it. A gift card's code is never read back: only whether it has the
 * app's format. The query is in server/rules/orders/order-rows.ts and, word for word, in the staff
 * app's shadow.
 */
export const orderRowsSchema = z.object({
  order: z.object({
    order_total: money,
    discount_amount: money.nullable(),
    promo_code: z.string().nullable(),
    payment_status: z.string(),
    payment_method: z.string().nullable(),
    order_source: z.string().nullable(),
    has_shipping_address: z.boolean(),
    /** The delivery address as the order keeps it (W07). Free text. */
    shipping_address: z.record(z.string(), z.unknown()).nullable(),
    has_payment_intent: z.boolean(),
    has_reader_payment: z.boolean(),
  }),
  lines: z.array(
    z.object({
      item_type: z.string(),
      quantity: z.number(),
      unit_price: money,
      line_total: money,
      discount_amount: money,
      system_unit_price: money.nullable(),
      price_override_reason: z.string().nullable(),
      addon_id: z.string().nullable(),
      is_the_booking: z.boolean(),
      fulfillment_status: z.string().nullable(),
      product_variant_id: z.string().nullable(),
      session_pass_type_id: z.string().nullable(),
      has_gift_card: z.boolean(),
    })
  ),
  booking: z
    .object({
      session_id: z.string(),
      status: z.string(),
      party_size: z.number(),
      price_paid: money,
      redemption_source: z.string().nullable(),
      redeemed_membership_id: z.string().nullable(),
      redeemed_session_pass_id: z.string().nullable(),
      credit_period_id: z.string().nullable(),
      band_id: z.string().nullable(),
      special_requests: z.string().nullable(),
      guests_over_18_confirmed: z.boolean(),
      for_the_order_customer: z.boolean(),
      times_are_the_session: z.boolean(),
      session_total_booked: z.number(),
      pass_sessions_remaining: z.number().nullable(),
      credit_period_used: z.number(),
      seats: z.array(
        z.object({
          guest_type: z.string(),
          guest_name: z.string(),
          guest_email: z.string().nullable(),
          date_of_birth: z.string().nullable(),
          unit_price: money.nullable(),
          pay_by: z.string().nullable(),
          waiver_accepted: z.boolean().nullable(),
        })
      ),
      addons: z.array(
        z.object({
          addon_id: z.string(),
          quantity: z.number(),
          price_at_purchase: money,
          sku_at_purchase: z.string(),
          redemption_source: z.string().nullable(),
          redeemed_membership_id: z.string().nullable(),
          for_the_order: z.boolean(),
          addon_credits_left: z.number().nullable(),
        })
      ),
    })
    .nullable(),
  /** Each variant the order's lines name, as its stock now stands (W07). */
  stock: z.array(z.object({ variant_id: z.string(), stock_quantity: z.number() })),
  /** The ledger rows naming the order, in the order written (W07). */
  stock_adjustments: z.array(z.object({ variant_id: z.string(), change_amount: z.number(), by_staff: z.boolean() })),
  /** The passes the order's lines issued (W07). */
  session_passes: z.array(
    z.object({
      pass_type_id: z.string(),
      purchase_date: z.string(),
      sessions_remaining: z.number(),
      expiry_date: z.string(),
      for_the_order_customer: z.boolean(),
      pays_for_the_booking: z.boolean(),
    })
  ),
  /** The gift cards the order's lines issued (W07). The code is never here, only whether its format is right. */
  gift_cards: z.array(
    z.object({
      type: z.string(),
      original_value: money,
      remaining_balance: money,
      bought_by_the_order_customer: z.boolean(),
      recipient_name: z.string().nullable(),
      recipient_email: z.string().nullable(),
      gift_message: z.string().nullable(),
      origin: z.string(),
      issue_date: z.string(),
      expiry_date: z.string(),
      fulfillment_method: z.string(),
      voided: z.boolean().nullable(),
      redeemed: z.boolean(),
      code_format_ok: z.boolean(),
    })
  ),
  /** The order customer's own address, after the order (W07: an order can save its delivery address). Free text. */
  customer_address: z
    .object({
      line1: z.string().nullable(),
      line2: z.string().nullable(),
      city: z.string().nullable(),
      postcode: z.string().nullable(),
      country: z.string().nullable(),
    })
    .nullable(),
  /**
   * The event booking the order's event line points at, with the event's places after the claim and
   * the attendees in place order (W08). An attendee's name, email and date of birth are free text.
   */
  event_booking: z
    .object({
      event_id: z.string(),
      status: z.string(),
      places: z.number(),
      account_holder_attending: z.boolean(),
      price_paid: money,
      created_by_staff_id: z.string().nullable(),
      guests_over_18_confirmed: z.boolean(),
      for_the_order_customer: z.boolean(),
      event_places_booked: z.number(),
      attendees: z.array(
        z.object({
          attendee_type: z.string(),
          name: z.string(),
          email: z.string().nullable(),
          date_of_birth: z.string().nullable(),
          unit_price: money,
          price_level: z.string(),
        })
      ),
    })
    .nullable(),
  /** The promo code's use the order recorded (W09). */
  promo_redemptions: z.array(z.object({ promo_code_id: z.string(), for_the_order_customer: z.boolean(), discount_amount: money })),
  /** The store credit the order took, in the order written (W09). The note is free text. */
  store_credit_transactions: z.array(
    z.object({
      amount: money,
      balance_after: money,
      reason: z.string(),
      for_the_order_customer: z.boolean(),
      for_a_booking: z.boolean(),
      from_a_gift_card: z.boolean(),
      staff_id: z.string().nullable(),
      note: z.string().nullable(),
    })
  ),
  /** The gift card the order was paid with, and that card after it (W09). Its code is never read. */
  gift_card_redemptions: z.array(
    z.object({
      gift_card_id: z.string(),
      amount_used: money,
      for_a_booking: z.boolean(),
      for_an_event_booking: z.boolean(),
      card_remaining_balance: money,
      card_redeemed: z.boolean(),
      card_voided: z.boolean().nullable(),
    })
  ),
  /** The order customer's store credit balance after the order (W09). */
  customer_store_credit_balance: money.nullable(),
})
export type OrderRows = z.infer<typeof orderRowsSchema>

export const orderDryRunOutputSchema = z.object({
  /**
   * What the order would have answered. Nothing was kept. On a saved-card order (W10) the dry run runs
   * T1 only, with no Stripe call: this is what the order answers once the card is charged, and `rows`
   * are as T1 leaves them, the order pending with its snapshot (has_reader_payment), its event booking
   * pending and its delivery address not yet saved to the customer.
   */
  order: placeOrderOutputSchema,
  /** What it wrote, read back inside the transaction before the rollback. */
  rows: orderRowsSchema,
})
export type OrderDryRunOutput = z.infer<typeof orderDryRunOutputSchema>
