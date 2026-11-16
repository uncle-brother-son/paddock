import { z } from 'zod'

/**
 * Step F (new in W36, F-plan 4.1 to 4.7): the membership, customer, store credit and gift card routes, ahead of the
 * slices that build them (W37 to W42). Field names match the Retool functions' params and results, so each staff app
 * function becomes a thin call with the same name and result shape. Input is loose wherever the old function answered
 * for itself (an amount is any value, a credit type any string), so the rule refuses with the old words instead of
 * zod giving a generic VALIDATION (W02's lesson). `confirmed` is new: the figure staff were shown (Q18).
 * Nothing calls these routes yet (dark); each slice firms up its own output when it builds the route.
 *
 *   POST /api/v1/staff/memberships/:membershipId/cancel               setMembershipCancellation, cancel: true   (W40)
 *   POST /api/v1/staff/memberships/:membershipId/undo-cancel          setMembershipCancellation, cancel: false  (W40)
 *   GET  /api/v1/staff/memberships                                    getSubscriptions                          (W40)
 *   GET  /api/v1/staff/memberships/:membershipId/payment-date/quote   getMembershipPaymentDateQuote             (W41)
 *   POST /api/v1/staff/memberships/:membershipId/payment-date         changeMembershipPaymentDate               (W41)
 *   POST /api/v1/staff/memberships/:membershipId/credits              adjustMembershipCredits                   (W37)
 *   GET  /api/v1/staff/memberships/:membershipId/credit-adjustments   getMembershipCreditAdjustments            (W37)
 *   POST /api/v1/staff/memberships/:membershipId/herd                 setMembershipHerd                         (W37)
 *   POST /api/v1/staff/customers/:customerId/store-credit             adjustCustomerStoreCredit                 (W37)
 *   POST /api/v1/staff/customers                                      createCustomer                            (W39)
 *   GET  /api/v1/staff/customers                                      getCustomers                              (W39)
 *   GET  /api/v1/staff/customers/:customerId                          getCustomerDetail                         (W39)
 *   POST /api/v1/staff/gift-cards/:giftCardId/extend                  extendGiftCardExpiry                      (W38)
 *   POST /api/v1/staff/gift-cards/:giftCardId/picked-up               setGiftCardPickedUp                       (W38)
 *   POST /api/v1/staff/gift-cards/:giftCardId/shipped                 setGiftCardShipped                        (W38)
 *   GET  /api/v1/staff/gift-cards                                     getGiftCards                              (W38)
 *   GET  /api/v1/staff/gift-cards/:giftCardId/redemptions             getGiftCardRedemptions                    (W38)
 *   POST /api/v1/staff/customers/:customerId/saved-card               saveCustomerCardOnFile (exists, terminal.ts); W42 adds the memberships moved
 *
 * The rows are the old functions' own (snake_case columns, money as the database gives it). A refusal is an ApiError
 * whose details carry the old reason and words (`accountRefusalDetailsSchema`), so the thin wrappers put the old
 * result shapes back (`updated: false, reason, message`; `adjusted: false…`; `ok: false…`; `changed: false, message`).
 */

const id = z.guid()
/** Pounds, as the screens send them. */
const pounds = z.number()
/** The staff app sends empty or missing optional text in both forms. */
const looseText = z.string().nullish()
/** A date as the database gives it (YYYY-MM-DD), or a moment (ISO). */
const dateText = z.string()
const timeText = z.string()
/** Money as the database gives it: a string of pounds and pence. */
const moneyText = z.string()

const membershipInPath = { membershipId: id }
const customerInPath = { customerId: id }
const giftCardInPath = { giftCardId: id }

/** Why the payment date button is refused, as the lists and the profile carry it (shared/membershipPaymentDate). */
const paymentDateStatus = {
  /** When the payment date was last changed, or null. */
  payment_date_changed_at: timeText.nullable(),
  /** Why "Change payment date" is refused right now (null: allowed). */
  payment_date_change_blocked: z.string().nullable(),
  /** A change in the last 6 months: staff must tick Override and give a reason. */
  payment_date_change_needs_override: z.boolean(),
}

// --- POST /api/v1/staff/memberships/:membershipId/cancel and /undo-cancel (setMembershipCancellation)

/** Nothing but the membership, which is in the path. */
export const membershipCancelInputSchema = z.object({})
export type MembershipCancelInput = z.infer<typeof membershipCancelInputSchema>
export const membershipCancelRouteInputSchema = membershipCancelInputSchema.extend(membershipInPath)

/** The membership row as the screen reads it back after the change. */
export const membershipCancellationRowSchema = z.object({
  id: z.string(),
  /** The last day of access, or null when no cancellation is scheduled. */
  cancel_effective_date: dateText.nullable(),
  billing_frequency: z.string().nullable(),
})

/**
 * The cancel's and the undo's answer, in the old function's fields. New (F-plan 4.3): `left`, when the database is
 * changed and Stripe gave no clear answer, so the Stripe step is left for the automatic check (memberships/left.ts).
 */
export const membershipCancelOutputSchema = z.object({
  membership: membershipCancellationRowSchema,
  /** A cancel: the day the paid term ends (the day after the last day of access). */
  endDate: dateText.optional(),
  /** A cancel: whether the Stripe subscription was changed (false when the membership has none). */
  stripeUpdated: z.boolean().optional(),
  left: z.object({ stepId: z.string(), message: z.string() }).optional(),
})
export type MembershipCancelOutput = z.infer<typeof membershipCancelOutputSchema>

// --- GET /api/v1/staff/memberships (getSubscriptions)

export const membershipListInputSchema = z.object({ search: z.string().optional() })
export type MembershipListInput = z.infer<typeof membershipListInputSchema>

/** One row of the Subscriptions page. */
export const membershipListRowSchema = z.object({
  id: z.string(),
  customer_id: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
  plan_name: z.string(),
  subscription_status: z.string().nullable(),
  cancel_effective_date: dateText.nullable(),
  billing_frequency: z.string().nullable(),
  start_date: dateText,
  next_renewal_date: dateText.nullable(),
  plan_is_unlimited: z.boolean(),
  /** The current credit period; null when none covers today. */
  current_period_end: dateText.nullable(),
  current_period_credits_allocated: z.number().nullable(),
  current_period_credits_remaining: z.number().nullable(),
  addon_credits_remaining: z.number(),
  is_herd: z.boolean(),
  herd_override: z.boolean().nullable(),
  created_at: timeText,
  ...paymentDateStatus,
  /** W40 (W35 row 10, lead call L9): the membership's order line has been refunded. */
  refunded: z.boolean().optional(),
})
export type MembershipListRow = z.infer<typeof membershipListRowSchema>
export const membershipListOutputSchema = z.array(membershipListRowSchema)

// --- GET /api/v1/staff/memberships/:membershipId/payment-date/quote (getMembershipPaymentDateQuote)

/** The date staff picked (YYYY-MM-DD); omitted for the allowed window alone. Any text: the quote answers a bad one itself. */
export const paymentDateQuoteInputSchema = z.object({ newRenewalDate: z.string().optional() })
export type PaymentDateQuoteInput = z.infer<typeof paymentDateQuoteInputSchema>
export const paymentDateQuoteRouteInputSchema = paymentDateQuoteInputSchema.extend(membershipInPath)

/** The quote, field for field. The old `null` (no such membership) becomes NOT_FOUND. */
export const paymentDateQuoteOutputSchema = z.object({
  membershipId: z.string(),
  customerId: z.string(),
  planId: z.string(),
  stripeSubscriptionId: z.string().nullable(),
  /** Why a change is refused, or null when one is allowed. */
  refusal: z.string().nullable(),
  needsOverride: z.boolean(),
  lastChangedAt: timeText.nullable(),
  currentRenewalDate: dateText.nullable(),
  /** The first and last new dates allowed; null with no next renewal date. */
  earliestDate: dateText.nullable(),
  latestDate: dateText.nullable(),
  /** Days from the current renewal date to the same day a month later. */
  daysInPeriod: z.number().nullable(),
  monthlyPrice: z.number().nullable(),
  cardLast4: z.string().nullable(),
  cardBrand: z.string().nullable(),
  /** Only when a new date was given and is inside the window. */
  newRenewalDate: dateText.optional(),
  extraDays: z.number().optional(),
  /** Pounds, to the penny: the monthly price × the extra days ÷ the days in the period. */
  amount: z.number().optional(),
  /** Set when a new date was given and is outside the window. */
  dateError: z.string().optional(),
})
export type PaymentDateQuoteOutput = z.infer<typeof paymentDateQuoteOutputSchema>

// --- POST /api/v1/staff/memberships/:membershipId/payment-date (changeMembershipPaymentDate)

/**
 * `confirmed.amount` is new (Q18, FB4): the part-month charge the dialog showed, checked to half a penny before the
 * card is charged. Loose otherwise: a missing date or an override with no reason is refused with the old words.
 */
export const changePaymentDateInputSchema = z.object({
  newRenewalDate: looseText,
  /** Staff ticked Override for the once-every-6-months rule. */
  override: z.boolean().optional(),
  overrideReason: looseText,
  confirmed: z.object({ amount: pounds }).optional(),
})
export type ChangePaymentDateInput = z.infer<typeof changePaymentDateInputSchema>
export const changePaymentDateRouteInputSchema = changePaymentDateInputSchema.extend(membershipInPath)

/** A change that went through, in the old function's fields. */
export const changePaymentDateOutputSchema = z.object({
  newRenewalDate: dateText,
  extraDays: z.number(),
  amountCharged: z.number(),
  paymentIntentId: z.string(),
  /** The charge's own order, so it can be refunded from the Orders page. */
  orderId: z.string().nullable(),
  /** Something for staff to check (the old code's warnings; the Worker's version has no half-recorded state to warn of). */
  warning: z.string().optional(),
})
export type ChangePaymentDateOutput = z.infer<typeof changePaymentDateOutputSchema>

// --- POST /api/v1/staff/memberships/:membershipId/credits (adjustMembershipCredits)

/** `creditType` is 'session' or 'addon'; `amount` a whole number, not 0. Any value: the rule refuses with the old words. */
export const adjustMembershipCreditsInputSchema = z.object({
  creditType: z.string(),
  amount: z.unknown().optional(),
  reason: looseText,
})
export type AdjustMembershipCreditsInput = z.infer<typeof adjustMembershipCreditsInputSchema>
export const adjustMembershipCreditsRouteInputSchema = adjustMembershipCreditsInputSchema.extend(membershipInPath)

export const adjustMembershipCreditsOutputSchema = z.object({
  /** A session adjustment: the current period after it. */
  period: z
    .object({
      period_id: z.string(),
      credits_allocated: z.number(),
      credits_used: z.number(),
      period_start: dateText,
      period_end: dateText,
    })
    .optional(),
  /** An add-on adjustment: the balance after it. */
  addon_credits_remaining: z.number().optional(),
})
export type AdjustMembershipCreditsOutput = z.infer<typeof adjustMembershipCreditsOutputSchema>

// --- GET /api/v1/staff/memberships/:membershipId/credit-adjustments (getMembershipCreditAdjustments)

export const membershipCreditAdjustmentsInputSchema = z.object(membershipInPath)

export const membershipCreditAdjustmentRowSchema = z.object({
  id: z.string(),
  membership_id: z.string(),
  staff_id: z.string().nullable(),
  staff_first_name: z.string().nullable(),
  staff_last_name: z.string().nullable(),
  staff_email: z.string().nullable(),
  staff_role: z.string().nullable(),
  amount: z.number(),
  credit_type: z.string(),
  reason: z.string(),
  created_at: timeText,
})
export type MembershipCreditAdjustmentRow = z.infer<typeof membershipCreditAdjustmentRowSchema>
export const membershipCreditAdjustmentsOutputSchema = z.array(membershipCreditAdjustmentRowSchema)

// --- POST /api/v1/staff/memberships/:membershipId/herd (setMembershipHerd)

/** true or false sets the override and the flag; null clears the override and re-applies the automatic rule. */
export const setMembershipHerdInputSchema = z.object({ herd: z.boolean().nullable() })
export type SetMembershipHerdInput = z.infer<typeof setMembershipHerdInputSchema>
export const setMembershipHerdRouteInputSchema = setMembershipHerdInputSchema.extend(membershipInPath)

export const setMembershipHerdOutputSchema = z.object({
  membership: z.object({
    id: z.string(),
    plan_name: z.string(),
    subscription_status: z.string().nullable(),
    is_herd: z.boolean(),
    herd_override: z.boolean().nullable(),
    addon_credits_remaining: z.number(),
  }),
})
export type SetMembershipHerdOutput = z.infer<typeof setMembershipHerdOutputSchema>

// --- POST /api/v1/staff/customers/:customerId/store-credit (adjustCustomerStoreCredit)

/** `mode` is 'add' or 'remove'; `amount` pounds above 0; `reason` at least 5 characters. Any value: the rule refuses with the old words. */
export const adjustStoreCreditInputSchema = z.object({
  mode: z.string(),
  amount: z.unknown().optional(),
  reason: z.unknown().optional(),
})
export type AdjustStoreCreditInput = z.infer<typeof adjustStoreCreditInputSchema>
export const adjustStoreCreditRouteInputSchema = adjustStoreCreditInputSchema.extend(customerInPath)

export const adjustStoreCreditOutputSchema = z.object({
  /** The customer's balance after the movement. */
  balance: z.number().optional(),
  /** What was applied: above 0 for add, below for remove. */
  appliedAmount: z.number(),
  transactionId: z.string().optional(),
})
export type AdjustStoreCreditOutput = z.infer<typeof adjustStoreCreditOutputSchema>

// --- POST /api/v1/staff/customers (createCustomer)

/** Every field as typed: the rule trims, lower-cases the email and refuses with the old words. */
export const createCustomerInputSchema = z.object({
  firstName: looseText,
  lastName: looseText,
  email: looseText,
  dateOfBirth: looseText,
  phone: looseText,
})
export type CreateCustomerInput = z.infer<typeof createCustomerInputSchema>

export const createCustomerOutputSchema = z.object({
  id: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  date_of_birth: dateText,
  created_at: timeText,
  updated_at: timeText,
})
export type CreateCustomerOutput = z.infer<typeof createCustomerOutputSchema>

// --- GET /api/v1/staff/customers (getCustomers)

/** One known customer by id, or a search (every word must match a name, the email or the phone), or the newest 200. */
export const customerListInputSchema = z.object({ search: z.string().optional(), customerId: z.string().optional() })
export type CustomerListInput = z.infer<typeof customerListInputSchema>

export const customerListRowSchema = createCustomerOutputSchema.extend({
  has_saved_card: z.boolean(),
  saved_card_last4: z.string().nullable(),
  saved_card_brand: z.string().nullable(),
  store_credit_balance: moneyText,
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  city: z.string().nullable(),
  postcode: z.string().nullable(),
  country: z.string().nullable(),
})
export type CustomerListRow = z.infer<typeof customerListRowSchema>
export const customerListOutputSchema = z.array(customerListRowSchema)

// --- GET /api/v1/staff/customers/:customerId (getCustomerDetail)

export const customerDetailInputSchema = z.object(customerInPath)

/** One of the customer's memberships, as the profile shows it. */
export const customerMembershipRowSchema = z.object({
  id: z.string(),
  customer_id: z.string(),
  plan_id: z.string(),
  plan_name: z.string(),
  billing_frequency: z.string().nullable(),
  subscription_status: z.string().nullable(),
  start_date: dateText,
  next_renewal_date: dateText.nullable(),
  cancel_effective_date: dateText.nullable(),
  addon_credits_remaining: z.number(),
  bonus_addon_credits: z.number(),
  is_herd: z.boolean(),
  herd_override: z.boolean().nullable(),
  stripe_subscription_id: z.string().nullable(),
  plan_is_unlimited: z.boolean(),
  current_period_end: dateText.nullable(),
  current_period_credits_allocated: z.number().nullable(),
  current_period_credits_remaining: z.number().nullable(),
  created_at: timeText,
  updated_at: timeText,
  ...paymentDateStatus,
  /** W40 (W35 row 10, lead call L9): the membership's order line has been refunded. */
  refunded: z.boolean().optional(),
})
export type CustomerMembershipRow = z.infer<typeof customerMembershipRowSchema>

export const customerSessionPassRowSchema = z.object({
  id: z.string(),
  customer_id: z.string(),
  pass_type_id: z.string(),
  pass_type_name: z.string(),
  /** 'core' passes can't be used on Peak sessions. */
  pass_type_level: z.string(),
  purchase_date: dateText,
  expiry_date: dateText.nullable(),
  sessions_remaining: z.number(),
  created_at: timeText,
  updated_at: timeText,
})
export type CustomerSessionPassRow = z.infer<typeof customerSessionPassRowSchema>

export const customerBookingHistoryRowSchema = z.object({
  id: z.string(),
  status: z.string(),
  party_size: z.number(),
  price_paid: moneyText,
  start_time: timeText,
  end_time: timeText,
  service_type_name: z.string(),
  checked_in_at: timeText.nullable(),
  /** Set while the booking is waiting for payment: the pay-by deadline. */
  payment_due_by: timeText.nullable(),
  created_at: timeText,
})
export type CustomerBookingHistoryRow = z.infer<typeof customerBookingHistoryRowSchema>

export const storeCreditTransactionRowSchema = z.object({
  id: z.string(),
  /** Above 0 added credit, below 0 took it. */
  amount: moneyText,
  balance_after: moneyText,
  reason: z.string(),
  note: z.string().nullable(),
  order_id: z.string().nullable(),
  booking_id: z.string().nullable(),
  created_at: timeText,
})
export type StoreCreditTransactionRow = z.infer<typeof storeCreditTransactionRowSchema>

export const customerEventBookingRowSchema = z.object({
  id: z.string(),
  event_id: z.string(),
  event_name: z.string(),
  event_starts_at: timeText.nullable(),
  places: z.number(),
  status: z.string(),
  price_paid: moneyText,
  created_at: timeText,
  /** Places still booked (cancelled ones left out of these three counts). */
  attendee_count: z.number(),
  checked_in_count: z.number(),
  waivers_outstanding: z.number(),
  /** Places booked originally, and how many were cancelled. */
  places_total: z.number(),
  cancelled_places: z.number(),
  /** Card and store credit given back for cancelled places, and the card part of it. */
  refunded_amount: moneyText,
  card_refunded_amount: moneyText,
  event_cancelled_at: timeText.nullable(),
})
export type CustomerEventBookingRow = z.infer<typeof customerEventBookingRowSchema>

/** The profile. A customer that doesn't exist answers empty lists and a balance of '0', as the old function. */
export const customerDetailOutputSchema = z.object({
  memberships: z.array(customerMembershipRowSchema),
  sessionPasses: z.array(customerSessionPassRowSchema),
  bookingHistory: z.array(customerBookingHistoryRowSchema),
  storeCreditBalance: moneyText,
  /** Newest first, the last 100. */
  storeCreditHistory: z.array(storeCreditTransactionRowSchema),
  eventBookings: z.array(customerEventBookingRowSchema),
})
export type CustomerDetailOutput = z.infer<typeof customerDetailOutputSchema>

// --- The gift card routes

/** A gift card as the database holds it. */
export const giftCardRowSchema = z.object({
  id: z.string(),
  code: z.string(),
  type: z.string(),
  original_value: moneyText,
  remaining_balance: moneyText,
  purchaser_id: z.string().nullable(),
  recipient_name: z.string().nullable(),
  recipient_email: z.string().nullable(),
  gift_message: z.string().nullable(),
  origin: z.string(),
  issue_date: dateText,
  expiry_date: dateText,
  redeemed_at: timeText.nullable(),
  fulfillment_method: z.string(),
  picked_up: z.boolean(),
  picked_up_at: timeText.nullable(),
  picked_up_by: z.string().nullable(),
  voided: z.boolean().nullable(),
  shipped_at: timeText.nullable(),
  shipped_by: z.string().nullable(),
  created_at: timeText,
  updated_at: timeText,
})
export type GiftCardRow = z.infer<typeof giftCardRowSchema>

// --- POST /api/v1/staff/gift-cards/:giftCardId/extend (extendGiftCardExpiry)

/** A whole number of months from 1 to 120 (W38a). Any value, or none (W38): the rule refuses a bad one as `invalid_months`. */
export const extendGiftCardInputSchema = z.object({ extendByMonths: z.unknown().optional() })
export type ExtendGiftCardInput = z.infer<typeof extendGiftCardInputSchema>
export const extendGiftCardRouteInputSchema = extendGiftCardInputSchema.extend(giftCardInPath)

export const extendGiftCardOutputSchema = z.object({
  giftCard: z.object({ id: z.string(), expiry_date: dateText, voided: z.boolean().nullable() }),
})
export type ExtendGiftCardOutput = z.infer<typeof extendGiftCardOutputSchema>

// --- POST /api/v1/staff/gift-cards/:giftCardId/picked-up and /shipped (setGiftCardPickedUp, setGiftCardShipped)

export const setGiftCardPickedUpInputSchema = z.object({ pickedUp: z.boolean() })
export type SetGiftCardPickedUpInput = z.infer<typeof setGiftCardPickedUpInputSchema>
export const setGiftCardPickedUpRouteInputSchema = setGiftCardPickedUpInputSchema.extend(giftCardInPath)

export const setGiftCardShippedInputSchema = z.object({ shipped: z.boolean() })
export type SetGiftCardShippedInput = z.infer<typeof setGiftCardShippedInputSchema>
export const setGiftCardShippedRouteInputSchema = setGiftCardShippedInputSchema.extend(giftCardInPath)

/** Both answer the card as it now is. */
export const giftCardFlagOutputSchema = z.object({ giftCard: giftCardRowSchema })
export type GiftCardFlagOutput = z.infer<typeof giftCardFlagOutputSchema>

// --- GET /api/v1/staff/gift-cards (getGiftCards) and GET /api/v1/staff/gift-cards/:giftCardId/redemptions

/** Every card, newest first; `search` matches the code, the recipient or the purchaser. */
export const giftCardListInputSchema = z.object({ search: z.string().optional() })
export type GiftCardListInput = z.infer<typeof giftCardListInputSchema>

export const giftCardListRowSchema = giftCardRowSchema.extend({
  purchaser_first_name: z.string().nullable(),
  purchaser_last_name: z.string().nullable(),
  purchaser_email: z.string().nullable(),
})
export type GiftCardListRow = z.infer<typeof giftCardListRowSchema>
export const giftCardListOutputSchema = z.array(giftCardListRowSchema)

export const giftCardRedemptionsInputSchema = z.object(giftCardInPath)

export const giftCardRedemptionRowSchema = z.object({
  id: z.string(),
  gift_card_id: z.string(),
  order_id: z.string().nullable(),
  booking_id: z.string().nullable(),
  /** The event booking it paid for, when it paid for one. */
  event_booking_id: z.string().nullable().optional(),
  amount_used: moneyText,
  redeemed_at: timeText,
})
export type GiftCardRedemptionRow = z.infer<typeof giftCardRedemptionRowSchema>
export const giftCardRedemptionsOutputSchema = z.array(giftCardRedemptionRowSchema)

// --- POST /api/v1/staff/customers/:customerId/saved-card, from W42 (Q19, Wayne's Q45)

/**
 * What W42 adds to the saved card's answer (terminal.ts, saveCustomerCardOutputSchema): how many of the customer's
 * live memberships now renew on the new card, and how many are still to move (left for the automatic check).
 */
export const savedCardMembershipsSchema = z.object({
  membershipsMoved: z.number(),
  membershipsToMove: z.number(),
})
export type SavedCardMemberships = z.infer<typeof savedCardMembershipsSchema>

// --- What a refusal carries

/** The step F actions a refusal can come from. */
export const accountActionSchema = z.enum([
  'cancel',
  'undo_cancel',
  'payment_date_quote',
  'payment_date',
  'credits',
  'herd',
  'store_credit',
  'create_customer',
  'gift_card_extend',
  'gift_card_picked_up',
  'gift_card_shipped',
  'saved_card',
])
export type AccountAction = z.infer<typeof accountActionSchema>

/**
 * The `details` of every step F refusal: the old reason (or a new one, where the old function gave only words) and
 * the words staff see, so the thin wrappers put the old result shapes back. With the quote when the confirmed amount
 * no longer fits (Q18), the record of a payment date change held for the automatic check, and the switch kinds that
 * are off for MEMBERSHIP_PATH_OFF.
 */
export const accountRefusalDetailsSchema = z.object({
  reason: z.string(),
  message: z.string(),
  action: accountActionSchema,
  quote: paymentDateQuoteOutputSchema.optional(),
  held: z.object({ changeId: z.string() }).optional(),
  kinds: z.array(z.string()).optional(),
})
export type AccountRefusalDetails = z.infer<typeof accountRefusalDetailsSchema>
