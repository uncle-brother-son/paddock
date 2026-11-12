import {
  createBookingUnguarded as createBooking,
  GIFT_CARD_SOURCE_REMOVED_MESSAGE,
  isRemovedRedemptionSource,
  type RedemptionSource,
} from './createBooking'
import { AMOUNT_CHANGED_MESSAGE, amountLeftToPay, cashDifferenceRefusal, exceedsAmount } from '../../../legacy-booking/backend/paddock/shared/cashConfirmation'
import { chargeSavedCardUnguarded as chargeSavedCard } from '../../../legacy-booking/backend/paddock/chargeSavedCard'
import { extractApiErrorMessage } from '../../../legacy-booking/backend/paddock/shared/extractApiErrorMessage'
import { isHtmlErrorPage } from '../../../legacy-booking/backend/paddock/shared/isHtmlErrorPage'
import { generateGiftCardCode } from './shared/generateGiftCardCode'
import { cancelMembershipSubscription } from '@retool-app/backend/paddock/shared/cancelMembershipSubscription'
import createMembershipSubscription, {
  MEMBERSHIP_SUBSCRIPTION_FAILURE_REASONS,
  type MembershipSubscriptionSuccess,
} from './shared/createMembershipSubscription'
import { refundPaymentIntent } from '../../../legacy-booking/backend/paddock/shared/refundPaymentIntent'
import { createTerminalPaymentIntentUnguarded as createTerminalPaymentIntent } from '../../../legacy-booking/backend/paddock/createTerminalPaymentIntent'
import type { ReaderPaymentSnapshot } from './shared/readerOrderRollback'
import type { GuestInput } from '../../../legacy-booking/backend/paddock/shared/guestValidation'
import {
  reserveMembershipAddonCredit,
  releaseMembershipAddonCredit,
  releaseSessionPassCredit,
} from '../../../legacy-booking/backend/paddock/shared/creditRedemption'
import { insertStockAdjustment, deleteStockAdjustment } from '@retool-app/backend/paddock/shared/stockAdjustments'
import { releaseSessionCapacity } from '../../../legacy-booking/backend/paddock/shared/sessionCapacity'
import { applyStoreCredit } from '../../../legacy-booking/backend/paddock/shared/storeCredit'
import { storeCreditMoved } from '../../../legacy-booking/backend/paddock/shared/storeCreditRefund'
import { getStaffAccessRow } from '../../../legacy-booking/backend/paddock/shared/staffAccess'
import { addMonthsToIsoDate, londonToday } from '../../../legacy-booking/backend/paddock/shared/londonTime'
import { quoteSeats } from '../../../legacy-booking/backend/paddock/shared/bandPricing'
import { addonSystemPrice as catalogAddonPrice, customerHasActiveMembership } from '../../../legacy-booking/backend/paddock/shared/addonPricing'
import { applyPromoCode, type PromoEligibleLine } from '@retool-app/backend/paddock/shared/promoCodes'
import { loadPromoAndUsage } from './shared/promoCodeLookup'
import {
  validateEventLine,
  eventPromoLines,
  writeEventBooking,
  type CheckoutEventInput,
  type ValidatedEventLine,
} from './shared/eventOrders'

export interface CheckoutAddonLine {
  addonId: string
  quantity: number
  unitPrice: number
  /** Only meaningful for booking-attached addons — matches addon_order_lines' own CHECK constraint. */
  redemptionSource?: 'paid' | 'membership_credit'
  /**
   * Required when redemptionSource is 'membership_credit', UNLESS the booking itself is buying a
   * brand new membership in this same order (redemptionSource 'buy_new_membership') — in that
   * case, omitting this defaults the add-on to drawing from that same newly-purchased membership.
   */
  membershipId?: string
  /** The line's system price (member, else sale, else base) as computed by the UI. Recomputed
   *  server-side — never trusted. */
  systemUnitPrice?: number
  /** Required (trimmed, max 200 chars) when unitPrice differs from the system price — only
   *  possible for staff with can_manage_pricing. */
  priceOverrideReason?: string
}

export interface CheckoutProductLine {
  productVariantId: string
  quantity: number
  unitPrice: number
  /** For products whose fulfilment is 'shipping_or_pickup': the staff member's choice for this
   *  line. 'shipping' makes the order need a delivery address. Ignored for pure shipping/pickup
   *  products (their catalog fulfilment method decides). */
  fulfillmentChoice?: 'pickup' | 'shipping'
  /** The line's system price (member, else variant override, else sale, else base) as computed
   *  by the UI. Recomputed server-side — never trusted. */
  systemUnitPrice?: number
  /** Required (trimmed, max 200 chars) when unitPrice differs from the system price — only
   *  possible for staff with can_manage_pricing. */
  priceOverrideReason?: string
}

/**
 * The booking's own redemption choice — the two 'buy_new_*' values are resolved entirely within
 * createOrder.ts (never passed down to createBooking.ts): they mean "add a new membership/session
 * pass to this same basket, then use it to cover this booking", reusing the order's own top-level
 * `membershipPlanId`/`sessionPassTypeId` fields as the purchase itself.
 */
export type BookingRedemptionSource = RedemptionSource | 'buy_new_membership' | 'buy_new_session_pass'

export interface CheckoutBookingInput {
  sessionId: string
  /** One row per attendee (1-10) — party_size is derived as guests.length. */
  guests: GuestInput[]
  redemptionSource: BookingRedemptionSource
  /** Required when redemptionSource is 'membership_credit'. */
  membershipId?: string
  /** Required when redemptionSource is 'session_pass_credit'. */
  sessionPassId?: string
  /**
   * Only meaningful with redemptionSource 'buy_new_membership'. Staff-confirmed id of an existing
   * active-but-exhausted (zero session credit) membership to cancel as part of this order — must
   * be explicit (no silent auto-detection), since cancelling a real Stripe subscription is
   * irreversible.
   */
  cancelExhaustedMembershipId?: string
  /** Add-ons attached to this specific booking (recorded in addon_order_lines, not order_line_items). */
  addons?: CheckoutAddonLine[]
  /** Optional special requests for the booking (the account holder) — trimmed, NULL when empty. */
  specialRequests?: string
  /** "Everyone else in this booking is 18 or over" — required true when guests has more than the
   *  account holder (passed through to createBooking.ts, which enforces it). */
  guestsOver18Confirmed?: boolean
}

export interface CheckoutGiftCardInput {
  /** Fixed catalog amount — mutually exclusive with giftCardTypeId/amount. */
  giftCardPresetId?: string
  /** Custom-amount path — requires the type's custom_amount_enabled and amount within its
   *  custom_amount_min/max. Mutually exclusive with giftCardPresetId. */
  giftCardTypeId?: string
  /** Required (and validated against the type's range) only for the giftCardTypeId path. */
  amount?: number
  recipientName?: string
  recipientEmail?: string
  giftMessage?: string
  fulfillmentMethod: 'digital' | 'pickup' | 'shipping'
}

/**
 * How the order's remaining balance (whatever isn't already covered by a redeemed membership/
 * session-pass credit — i.e. `cardAmount`) gets paid. `giftCard` redeems an EXISTING gift card's
 * balance — distinct from the top-level `giftCard` field above, which purchases a brand NEW
 * gift card as a basket item. `giftCard` can combine with exactly one of the methods below for
 * the remainder; `method` is required whenever gift card alone doesn't cover the full amount due.
 *
 * 'card' charges the customer's already-saved payment method via chargeSavedCard, same as
 * before. 'reader' is NOT the same thing anymore: the frontend now charges the Terminal reader
 * directly (one tap, via a real PaymentIntent) BEFORE createOrder.ts is even called — so by the
 * time this function runs, the money has already moved. `readerCharge` carries proof of that
 * charge; createOrder.ts never calls chargeSavedCard for 'reader' (that would double-charge the
 * customer) — it only verifies the charged amount actually matches what's owed and records the
 * real PaymentIntent id.
 */
export interface CheckoutPaymentInput {
  giftCard?: {
    giftCardId: string
    amount: number
  }
  /** Store credit drawn from the customer's own store_credit_balance — a separate payment part
   *  from the gift card above, applied (claimed, negative) BEFORE any card money is taken. */
  storeCredit?: {
    amount: number
  }
  method?: 'card' | 'reader' | 'cash'
  /** Cash only: the figure on the tick staff confirmed. The order is refused if the amount
   *  works out different (shared/cashConfirmation). */
  confirmedCashAmount?: number
  /** Reader flow only: the customer consented to saving this card for future off-session
   *  charges (required true when the basket contains a membership — renewals need the card). */
  readerSaveCard?: boolean
}

export interface CreateOrderParams {
  customerId: string
  booking?: CheckoutBookingInput
  /** Add-ons sold with no booking at all (recorded in order_line_items via addon_id). */
  standaloneAddons?: CheckoutAddonLine[]
  products?: CheckoutProductLine[]
  membershipPlanId?: string
  /** Required whenever membershipPlanId is set (either the top-level purchase or the booking's
   *  'buy_new_membership' flow) — the customer's choice at purchase time, since billing frequency
   *  is no longer fixed per plan. Determines which of price_monthly/price_yearly is charged and
   *  how next_renewal_date is computed. */
  membershipBillingFrequency?: 'monthly' | 'yearly'
  sessionPassTypeId?: string
  giftCard?: CheckoutGiftCardInput
  /** An event line: one attendee row per place. Validated, quoted (quote_event) and written by
   *  shared/eventOrders.ts — never paid with membership credits or session passes. */
  event?: CheckoutEventInput
  payment: CheckoutPaymentInput
  /** Required when the basket needs shipping (a product whose fulfilment is shipping — or a
   *  shipping-or-pickup product the staff marked as ship — or a shipping gift card). Stored on
   *  orders.shipping_address as JSON. */
  shippingAddress?: {
    name: string
    line1: string
    line2?: string
    city: string
    postcode: string
    country?: string
  }
  /** When true, the delivery address given above is also saved onto the customer's profile
   *  (customers.address_*). */
  saveShippingAddressToCustomer?: boolean
  /** Required for shipping baskets — the staff member's postage choice. The amount is computed
   *  server-side from the postage_settings table (never trusted from the client). */
  postageMethod?: 'standard' | 'express'
  /** Optional promo code (staff-entered at New Order). Re-validated here with the Retool copy of
   *  the promo logic — the client's discount figure is never trusted. The preview now comes from
   *  the Worker, so until step C any promo rule change must be made in both. */
  promoCode?: string
  /** Stable per-basket idempotency key passed through to the Stripe create-subscription route,
   *  so retrying a checkout can never create a second subscription. Generated once per checkout
   *  dialog open by the frontend; a fallback is generated server-side when absent. */
  membershipIdempotencyKey?: string
  /** Brief W14a: the press's Idempotency-Key for the Worker's order route (W03-plan 2.6). The screen keeps it
   *  after no answer and makes a new one after a definite answer. Made here when a caller sends none. */
  idempotencyKey?: string
  /** Brief W14a (W03-plan 2.7, Q11): what staff saw and confirmed, from the basket quote. Only the Worker
   *  reads it; the old code still reads `payment.confirmedCashAmount`. */
  confirmed?: {
    amountDue?: number
    toCollect?: number
    firstInvoice?: number
  }
}

export type CreateOrderFailureStage = 'validation' | 'booking' | 'event' | 'product' | 'payment' | 'gift_card'

export interface CreateOrderResult {
  success: boolean
  stage?: CreateOrderFailureStage
  reason?: string
  message?: string
  orderId?: string
  bookingId?: string
  eventBookingId?: string
  bookingFailureReason?: string
  productVariantId?: string
  giftCardId?: string
  giftCardCode?: string
  membershipId?: string
  sessionPassId?: string
  cardCharged?: boolean
  cardAmount?: number
  /** With every refusal over the amount: the whole amount due, before gift card and store credit,
   *  counted as the screen's amount due is. */
  amountDueTotal?: number
  /** Set when method is 'reader' (new flow): the order is created PENDING, the PaymentIntent is
   *  created with metadata.order_id, and the frontend collects on the reader then calls
   *  finaliseReaderOrder. */
  pendingReaderPayment?: {
    orderId: string
    paymentIntentId: string
    clientSecret: string
    amount: number
  }
  /** The promo code applied to this order, when one was used. */
  promoCode?: string
  /** Total promo discount applied across the order (order lines + membership first payment). */
  promoDiscountAmount?: number
  giftCardRedeemedAmount?: number
  storeCreditRedeemedAmount?: number
  paymentMethodUsed?: string | null
  warning?: string
  /** A membership's subscription and what its first invoice took, as the old code and the Worker answer them. */
  membershipSubscriptionId?: string
  membershipAmountPaid?: number
  membershipInvoiceId?: string
  /** Brief W14a: the Worker's error code on a failure the Worker gave (the screen's key rule reads it). */
  workerCode?: string
}

interface CatalogRow {
  id: string
  name: string
  price: string | null
  active: boolean | null
  sessions_included: number | null
  addons_included: number | null
}

interface MembershipPlanCatalogRow {
  id: string
  name: string
  price_monthly: string | null
  price_yearly: string | null
  active: boolean | null
  is_unlimited: boolean
  sessions_included: number | null
  addons_included: number | null
}

interface ProductVariantLookup {
  id: string
  stock_quantity: number
  product_name: string
  product_active: boolean | null
  /** Catalog prices for the non-override fallback (caller lacks can_manage_pricing). */
  product_member_price: string | null
  product_sale_price: string | null
  product_base_price: string | null
  price_override: string | null
  /** The owning product's fulfilment method: 'shipping' | 'pickup' | 'both'. */
  product_fulfillment_method: string | null
}

interface AddonLookup {
  id: string
  name: string
  sku: string | null
  active: boolean | null
  /** Catalog prices for the non-override fallback (caller lacks can_manage_pricing). */
  member_price: string | null
  sale_price: string | null
  base_price: string | null
}



/** Normalizes a timestamp from the Stripe subscription response (e.g. currentPeriodStart/End) to
 *  the date-only form the customer_memberships columns store, falling back to `fallback` when
 *  the response didn't carry a usable value. */
function toDateOnly(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback
  const parsed = new Date(value)
  // The London calendar date of the instant (a UTC date is a day early just after midnight in BST).
  return Number.isNaN(parsed.getTime()) ? fallback : londonToday(parsed)
}

/**
 * @retool-slow-reviewed
 * Evidence: inspected every statement in createOrder.ts and its callers (CheckoutDialog, Bookings
 * page flows, move/settle flows). All ~35 paddockData statements are single-row point lookups by
 * primary key / unique id (customers, membership plans, product variants, add-ons, gift cards,
 * presets, memberships by id) or single-row writes guarded by id — no scans, no aggregates, no
 * large result sets (each returns ≤ a handful of rows), so there is no retrieval volume to reduce.
 * The measured ~25s run was a membership checkout, whose latency is dominated by unavoidable
 * external Stripe round-trips (create-subscription with first-invoice charge plus price validation
 * inside the Worker, and the saved-card charge) and by the deliberately sequential order of
 * operations — payment is taken BEFORE any write and each write is gated on the previous result
 * for money-safety/rollback correctness — which cannot be parallelized without changing those
 * semantics.
 */
export default async function createOrder(
  req: { params: CreateOrderParams; user: User }
): Promise<CreateOrderResult> {
  // Test fixture (W16): the old body exactly as it ran with every kind off, before W14's request key and
  // `confirmed` (which it never read) and without the shadow (which wrote nothing the replay records).
  const { idempotencyKey: _key, confirmed: _confirmed, ...params } = req.params
  return placeOrder({ params, user: req.user })
}

async function placeOrder(
  req: { params: CreateOrderParams; user: User }
): Promise<CreateOrderResult> {
  const { customerId, booking, standaloneAddons, products, membershipPlanId, membershipBillingFrequency, sessionPassTypeId, giftCard, event, payment, shippingAddress, saveShippingAddressToCustomer } =
    req.params

  if (!customerId) {
    return { success: false, stage: 'validation', reason: 'customer_id_required' }
  }
  if (
    !booking &&
    (!standaloneAddons || standaloneAddons.length === 0) &&
    (!products || products.length === 0) &&
    !membershipPlanId &&
    !sessionPassTypeId &&
    !giftCard &&
    !event
  ) {
    return { success: false, stage: 'validation', reason: 'empty_order' }
  }
  if (booking && isRemovedRedemptionSource(booking.redemptionSource)) {
    return { success: false, stage: 'validation', reason: 'gift_card_source_removed', message: GIFT_CARD_SOURCE_REMOVED_MESSAGE }
  }

  const customerLookup = await paddockData.query<{ id: string }>('SELECT id FROM customers WHERE id = $1', [
    customerId,
  ])
  if (customerLookup.data.length === 0) {
    return { success: false, stage: 'validation', reason: 'customer_not_found' }
  }

  const bookingBuysNewMembership = booking?.redemptionSource === 'buy_new_membership'
  const bookingBuysNewSessionPass = booking?.redemptionSource === 'buy_new_session_pass'
  const bookingBuysNew = bookingBuysNewMembership || bookingBuysNewSessionPass

  // Private bookings are always paid with real money — never a credit redemption of any kind
  // (existing or newly-purchased), and never stacking multiple credits. Checked here, before any
  // membership/pass purchase work happens, so a private booking with a credit-based redemption
  // source is rejected immediately rather than after wastefully buying (then rolling back) a new
  // membership/pass. createBooking.ts re-enforces the same rule server-side as the authoritative
  // check for the 'membership_credit'/'session_pass_credit' case (this covers 'buy_new_*' too,
  // which createBooking.ts never sees directly).
  const bookingNeedsCreditCheck =
    booking?.redemptionSource === 'membership_credit' ||
    booking?.redemptionSource === 'session_pass_credit' ||
    bookingBuysNew
  if (booking && bookingNeedsCreditCheck) {
    const sessionTypeLookup = await paddockData.query<{ booking_type: 'public' | 'private' }>(
      `SELECT st.booking_type FROM sessions s JOIN service_types st ON st.id = s.service_type_id WHERE s.id = $1`,
      [booking.sessionId]
    )
    if (sessionTypeLookup.data[0]?.booking_type === 'private') {
      return { success: false, stage: 'booking', reason: 'private_booking_requires_real_payment' }
    }
  }

  let membershipPlan: MembershipPlanCatalogRow | null = null
  if (membershipPlanId) {
    if (membershipBillingFrequency !== 'monthly' && membershipBillingFrequency !== 'yearly') {
      return { success: false, stage: 'validation', reason: 'membership_billing_frequency_required' }
    }
    const lookup = await paddockData.query<MembershipPlanCatalogRow>(
      'SELECT id, name, price_monthly, price_yearly, active, is_unlimited, sessions_included, addons_included FROM membership_plans WHERE id = $1',
      [membershipPlanId]
    )
    membershipPlan = lookup.data[0] ?? null
    if (!membershipPlan) return { success: false, stage: 'validation', reason: 'membership_plan_not_found' }
    if (membershipPlan.active === false) return { success: false, stage: 'validation', reason: 'membership_plan_inactive' }
    const priceForFrequency = membershipBillingFrequency === 'yearly' ? membershipPlan.price_yearly : membershipPlan.price_monthly
    if (priceForFrequency === null) {
      return { success: false, stage: 'validation', reason: 'membership_plan_price_not_set' }
    }
  }
  if (bookingBuysNewMembership) {
    if (!membershipPlan) return { success: false, stage: 'validation', reason: 'booking_membership_plan_required' }
    // Unlimited plans store sessions_included = 0 but still grant credit — only a limited plan
    // with no sessions can fail to cover a booking.
    if (!membershipPlan.is_unlimited && (membershipPlan.sessions_included ?? 0) <= 0) {
      return { success: false, stage: 'validation', reason: 'booking_membership_plan_grants_no_sessions' }
    }
  }

  let passType: CatalogRow | null = null
  let passTypeExpiryMonths = 12
  if (sessionPassTypeId) {
    const lookup = await paddockData.query<CatalogRow & { expiry_months: number | null }>(
      'SELECT id, name, price, active, expiry_months, sessions_included FROM session_pass_types WHERE id = $1',
      [sessionPassTypeId]
    )
    const row = lookup.data[0]
    if (!row) return { success: false, stage: 'validation', reason: 'session_pass_type_not_found' }
    if (row.active === false) return { success: false, stage: 'validation', reason: 'session_pass_type_inactive' }
    passType = row
    passTypeExpiryMonths = row.expiry_months ?? 12
  }
  if (bookingBuysNewSessionPass) {
    if (!passType) return { success: false, stage: 'validation', reason: 'booking_session_pass_type_required' }
    if ((passType.sessions_included ?? 0) <= 0) {
      return { success: false, stage: 'validation', reason: 'booking_session_pass_type_grants_no_sessions' }
    }
    // The new pass must cover this booking's session (a Core pass never covers Peak) — checked
    // before anything is charged or written. Buying a pass on its own is always allowed.
    const coverage = await paddockData.query<{ covers: boolean }>(
      'SELECT pass_covers_session($1, $2) AS covers',
      [sessionPassTypeId, booking!.sessionId]
    )
    if (coverage.data[0]?.covers !== true) {
      return {
        success: false,
        stage: 'validation',
        reason: 'booking_session_pass_type_not_valid_for_band',
        message: "A Core pass can't be used for a Peak session. Choose an All-Access pass or another way to pay.",
      }
    }
  }

  // Pre-compute prices now — used by both the normal flow (totals computed after booking
  // creation) and the "buying new to cover this booking" flow (needs the price before the
  // booking exists, to write the membership/pass order_line_items row up front).
  const membershipPrice = membershipPlan
    ? Number.parseFloat((membershipBillingFrequency === 'yearly' ? membershipPlan.price_yearly : membershipPlan.price_monthly) ?? '0')
    : 0
  const passPrice = passType ? Number.parseFloat(passType.price ?? '0') : 0

  let exhaustedMembershipStripeSubscriptionId: string | null = null
  if (booking?.cancelExhaustedMembershipId) {
    if (!bookingBuysNewMembership) {
      return { success: false, stage: 'validation', reason: 'cancel_membership_requires_buy_new_membership' }
    }
    const lookup = await paddockData.query<{
      id: string
      subscription_status: string
      stripe_subscription_id: string | null
      cancel_effective_date: string | null
      is_unlimited: boolean
      credits_remaining: number | null
    }>(
      `SELECT cm.id, cm.subscription_status, cm.stripe_subscription_id, cm.cancel_effective_date,
              mcc.is_unlimited, mcc.credits_remaining
       FROM customer_memberships cm
       LEFT JOIN membership_current_credits mcc ON mcc.membership_id = cm.id
       WHERE cm.id = $1 AND cm.customer_id = $2`,
      [booking.cancelExhaustedMembershipId, customerId]
    )
    const old = lookup.data[0]
    if (!old) return { success: false, stage: 'validation', reason: 'exhausted_membership_not_found' }
    const todayStr = londonToday()
    // cancel_effective_date is the LAST DAY OF ACCESS (inclusive) — the membership is still
    // usable on that date, so it only counts as past its cancellation when the date is strictly
    // before today.
    if (old.subscription_status !== 'active' || (old.cancel_effective_date !== null && old.cancel_effective_date < todayStr)) {
      return { success: false, stage: 'validation', reason: 'exhausted_membership_not_active' }
    }
    // "Exhausted" is period-based now: an unlimited membership always has credit, and a limited
    // one is exhausted only when its current period has nothing left (or no current period).
    if (old.is_unlimited || (old.credits_remaining ?? 0) > 0) {
      return { success: false, stage: 'validation', reason: 'exhausted_membership_still_has_credit' }
    }
    exhaustedMembershipStripeSubscriptionId = old.stripe_subscription_id
  }

  const productLines = products ?? []
  for (const line of productLines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      return { success: false, stage: 'validation', reason: 'invalid_product_quantity' }
    }
  }
  const productLookups = new Map<string, ProductVariantLookup>()
  for (const line of productLines) {
    if (productLookups.has(line.productVariantId)) continue
    const lookup = await paddockData.query<ProductVariantLookup>(
      `SELECT pv.id, pv.stock_quantity, p.name AS product_name, p.active AS product_active,
              p.fulfillment_method AS product_fulfillment_method,
              p.member_price AS product_member_price, p.sale_price AS product_sale_price,
              p.base_price AS product_base_price, pv.price_override
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE pv.id = $1`,
      [line.productVariantId]
    )
    const row = lookup.data[0]
    if (!row) return { success: false, stage: 'validation', reason: 'product_variant_not_found', productVariantId: line.productVariantId }
    if (row.product_active === false) {
      return { success: false, stage: 'validation', reason: 'product_inactive', productVariantId: line.productVariantId }
    }
    productLookups.set(line.productVariantId, row)
  }

  // --- Event line: who may book, attendees (18+ on the event date) and the server-side quote,
  // all before any money moves. The client's prices are never used.
  let eventLine: ValidatedEventLine | null = null
  if (event) {
    // A membership bought in this same order counts for the event straight away.
    const validated = await validateEventLine(customerId, event, membershipPlan ? membershipBillingFrequency ?? null : null)
    if (!validated.ok) {
      return { success: false, stage: 'event', reason: validated.reason, message: validated.message }
    }
    eventLine = validated.line
  }

  // --- Delivery address requirement ----------------------------------------------------------
  // The basket needs shipping when it contains a product whose catalog fulfilment is 'shipping',
  // a 'shipping or pickup' product the staff member chose to ship, or a gift card bought with
  // Shipping fulfilment. Such an order MUST carry a delivery address — refused otherwise, before
  // any money moves or any row is written.
  const normalizedShippingAddress = (() => {
    if (!shippingAddress) return null
    const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    const name = trim(shippingAddress.name)
    const line1 = trim(shippingAddress.line1)
    const line2 = trim(shippingAddress.line2) || null
    const city = trim(shippingAddress.city)
    const postcode = trim(shippingAddress.postcode)
    const country = trim(shippingAddress.country) || 'United Kingdom'
    return { name, line1, line2, city, postcode, country }
  })()
  const shippingProductLine = productLines.find((line) => {
    const method = productLookups.get(line.productVariantId)?.product_fulfillment_method
    return method === 'shipping' || (method === 'both' && line.fulfillmentChoice === 'shipping')
  })
  const needsShipping = Boolean(shippingProductLine) || giftCard?.fulfillmentMethod === 'shipping'
  if (needsShipping) {
    if (!normalizedShippingAddress) {
      return {
        success: false,
        stage: 'validation',
        reason: 'shipping_address_required',
        message:
          "This order includes an item that must be shipped — a delivery address is required. Add it in the checkout's Delivery address step.",
      }
    }
    const missing: string[] = []
    if (!normalizedShippingAddress.name) missing.push('recipient name')
    if (!normalizedShippingAddress.line1) missing.push('address line 1')
    if (!normalizedShippingAddress.city) missing.push('town/city')
    if (!normalizedShippingAddress.postcode) missing.push('postcode')
    if (missing.length > 0) {
      return {
        success: false,
        stage: 'validation',
        reason: 'shipping_address_required',
        message: `The delivery address is incomplete — ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required.`,
      }
    }
  }

  // Declared here, BEFORE the postage block below reads resolvedGiftCardAmount for a shipping
  // gift card — a `let` declared further down would be a use-before-declaration (TDZ) error.
  let resolvedGiftCardAmount: number | undefined
  let resolvedGiftCardExpiryMonths = 12

  // --- Postage (shipped baskets only) ----------------------------------------------------------
  // The postage amount is computed server-side from the postage_settings table and the basket's
  // shipped value (line totals of items being shipped: products with Ship chosen/shipping-only,
  // and physical gift cards with Shipping fulfilment). Memberships, session passes, bookings,
  // add-ons, and pickup items do not count toward the threshold or the postage.
  let postageAmount = 0
  let postageMethod: 'standard' | 'express' | undefined = req.params.postageMethod
  let postageSettings: { standard_price: string; express_price: string; free_shipping_threshold: string } | null = null
  if (needsShipping) {
    if (postageMethod !== 'standard' && postageMethod !== 'express') {
      return {
        success: false,
        stage: 'validation',
        reason: 'postage_method_required',
        message: 'This order includes an item that must be shipped — choose a postage option (Standard or Express) in the Delivery address step.',
      }
    }
    const settingsResult = await paddockData.query<{ standard_price: string; express_price: string; free_shipping_threshold: string }>(
      'SELECT standard_price, express_price, free_shipping_threshold FROM postage_settings LIMIT 1'
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('does not exist')) {
        throw new Error('The postage_settings table does not exist yet — run the postage migration first.')
      }
      throw err
    })
    const settings = settingsResult.data[0]
    if (!settings) {
      return {
        success: false,
        stage: 'validation',
        reason: 'postage_settings_missing',
        message: 'Postage settings have not been configured yet — run the postage_settings migration to set them up.',
      }
    }
    // The amount is worked out once the line prices are corrected, further down.
    postageSettings = settings
  }

  // System-price bookkeeping for the order_line_items inserts: the server-computed system price
  // is always recorded; the override reason is stored only when the charged price differs.
  const addonSystemPrice = (line: CheckoutAddonLine): number => systemAddonPrice.get(line) ?? line.unitPrice
  const productSystemPrice = (line: CheckoutProductLine): number => systemProductPrice.get(line) ?? line.unitPrice
  const overrideReasonOrNull = (
    unitPrice: number,
    system: number,
    line: { priceOverrideReason?: string }
  ): string | null =>
    Math.round(unitPrice * 100) !== Math.round(system * 100) ? line.priceOverrideReason ?? null : null

  const attachedAddons = booking?.addons ?? []
  const standaloneAddonLines = standaloneAddons ?? []
  const allAddonLines = [...attachedAddons, ...standaloneAddonLines]
  for (const line of allAddonLines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      return { success: false, stage: 'validation', reason: 'invalid_addon_quantity' }
    }
  }
  for (const line of attachedAddons) {
    // An attached add-on redeeming membership credit needs an explicit membershipId — UNLESS the
    // booking itself is buying a brand new membership in this order, in which case a missing
    // membershipId just means "use that new membership" (resolved once it exists, below).
    if (line.redemptionSource === 'membership_credit' && !line.membershipId && !bookingBuysNewMembership) {
      return { success: false, stage: 'validation', reason: 'addon_membership_id_required' }
    }
  }
  for (const line of standaloneAddonLines) {
    // Only an add-on on a booking can draw an add-on credit. Before this a standalone line sent
    // with a credit was charged in full and drew nothing.
    if (line.redemptionSource === 'membership_credit') {
      return {
        success: false,
        stage: 'validation',
        reason: 'standalone_addon_credit_not_allowed',
        message: 'An add-on credit can only pay for an add-on on a booking. Charge this add-on, or add it to the booking.',
      }
    }
  }
  const addonLookups = new Map<string, AddonLookup>()
  for (const line of allAddonLines) {
    if (addonLookups.has(line.addonId)) continue
    const lookup = await paddockData.query<AddonLookup>(
      'SELECT id, name, sku, active, member_price, sale_price, base_price FROM addons WHERE id = $1',
      [line.addonId]
    )
    const row = lookup.data[0]
    if (!row) return { success: false, stage: 'validation', reason: 'addon_not_found' }
    if (row.active === false) return { success: false, stage: 'validation', reason: 'addon_inactive' }
    addonLookups.set(line.addonId, row)
  }

  // --- Line price override enforcement ---
  // Only staff with can_manage_pricing may set a custom unit price on add-on/product lines.
  // Callers without it get their client-supplied unitPrice silently ignored and replaced with
  // the catalog price, resolved here from the database with the same rules the checkout UI
  // defaults to: the member price when the customer has an active membership (active and not
  // past a scheduled cancellation — the same gate shared/creditRedemption.ts uses), else the
  // sale price where set, else the base price (products also honour a variant price_override
  // ahead of sale/base).
  // The membership gate and the add-on price rule are shared with adding add-ons to an existing
  // booking (shared/addonPricing), so both always charge the same.
  const [staffAccess, hasActiveMembership] = await Promise.all([
    getStaffAccessRow(req.user.email),
    customerHasActiveMembership(customerId),
  ])
  const callerCanManagePricing = staffAccess?.can_manage_pricing === true
  // getStaffAccessRow refuses an inactive account here, before anything is written, so nothing
  // below has to look the staff member up between taking money and reversing it.
  const actingStaffId = staffAccess?.id ?? null
  const catalogPrice = (...candidates: (string | null | undefined)[]): number => {
    for (const candidate of candidates) {
      if (candidate !== null && candidate !== undefined) return Number.parseFloat(candidate)
    }
    return 0
  }
  // For EVERY line the system price is resolved and recorded (system_unit_price on the line
  // item row). When a manage-pricing caller's price differs from it, a non-blank
  // priceOverrideReason is required — the order is rejected otherwise.
  const systemAddonPrice = new Map<CheckoutAddonLine, number>()
  const systemProductPrice = new Map<CheckoutProductLine, number>()
  for (const line of allAddonLines) {
    const addon = addonLookups.get(line.addonId)
    const system = addon ? catalogAddonPrice(addon, hasActiveMembership) : line.unitPrice
    systemAddonPrice.set(line, system)
    if (!callerCanManagePricing) line.unitPrice = system
  }
  for (const line of productLines) {
    const variant = productLookups.get(line.productVariantId)
    const system = variant
      ? catalogPrice(
          hasActiveMembership ? variant.product_member_price : null,
          variant.price_override,
          variant.product_sale_price,
          variant.product_base_price
        )
      : line.unitPrice
    systemProductPrice.set(line, system)
    if (!callerCanManagePricing) line.unitPrice = system
  }
  if (callerCanManagePricing) {
    const roundForCompare = (n: number) => Math.round(n * 100) / 100
    for (const [line, system] of systemAddonPrice) {
      if (roundForCompare(line.unitPrice) !== roundForCompare(system)) {
        const reason = (line.priceOverrideReason ?? '').trim()
        if (!reason) {
          return {
            success: false,
            stage: 'validation',
            reason: 'price_override_reason_required',
            message:
              'A price on this order was changed from the system price — enter a reason for the price change (up to 200 characters) on that line before completing the order.',
          }
        }
        line.priceOverrideReason = reason
      }
    }
    for (const [line, system] of systemProductPrice) {
      if (roundForCompare(line.unitPrice) !== roundForCompare(system)) {
        const reason = (line.priceOverrideReason ?? '').trim()
        if (!reason) {
          return {
            success: false,
            stage: 'validation',
            reason: 'price_override_reason_required',
            message:
              'A price on this order was changed from the system price — enter a reason for the price change (up to 200 characters) on that line before completing the order.',
          }
        }
        line.priceOverrideReason = reason
      }
    }
  }

  // --- Postage amount (W03-decisions Q23): measured on the corrected prices, so a price sent
  // without Manage pricing can't earn or lose free postage. Shipped value = line totals of items
  // being shipped, BEFORE discounts. The gift card isn't resolved yet, so a shipped one still adds
  // nothing here: that is Q4, which the Worker's order fixes at W06.
  if (postageSettings) {
    let shippedValue = 0
    for (const line of productLines) {
      const method = productLookups.get(line.productVariantId)?.product_fulfillment_method
      if (method === 'shipping' || (method === 'both' && line.fulfillmentChoice === 'shipping')) {
        shippedValue += line.unitPrice * line.quantity
      }
    }
    if (giftCard?.fulfillmentMethod === 'shipping') {
      shippedValue += resolvedGiftCardAmount ?? 0
    }
    const standardPrice = Number.parseFloat(postageSettings.standard_price)
    const expressPrice = Number.parseFloat(postageSettings.express_price)
    const freeThreshold = Number.parseFloat(postageSettings.free_shipping_threshold)
    if (postageMethod === 'standard') {
      // Free-shipping threshold: shipped value >= threshold → Standard is free. Threshold 0
      // means no free shipping (shipped value >= 0 is always true, but 0 threshold is the
      // admin's explicit choice to disable it).
      postageAmount = freeThreshold > 0 && shippedValue >= freeThreshold ? 0 : standardPrice
    } else {
      postageAmount = expressPrice
    }
  }

  if (giftCard) {
    if (giftCard.giftCardPresetId && giftCard.giftCardTypeId) {
      return {
        success: false,
        stage: 'validation',
        reason: 'gift_card_selection_required',
        message: 'Choose either a preset amount or a custom amount, not both.',
      }
    }
    if (giftCard.giftCardPresetId) {
      const presetLookup = await paddockData.query<{ amount: string; active: boolean; gift_card_type_id: string }>(
        'SELECT amount, active, gift_card_type_id FROM gift_card_presets WHERE id = $1',
        [giftCard.giftCardPresetId]
      )
      const preset = presetLookup.data[0]
      if (!preset) return { success: false, stage: 'validation', reason: 'gift_card_preset_not_found' }
      if (!preset.active) return { success: false, stage: 'validation', reason: 'gift_card_preset_inactive' }
      resolvedGiftCardAmount = Number.parseFloat(preset.amount)
      const presetTypeLookup = await paddockData.query<{ expiry_months: number | null }>(
        'SELECT expiry_months FROM gift_card_types WHERE id = $1',
        [preset.gift_card_type_id]
      )
      resolvedGiftCardExpiryMonths = presetTypeLookup.data[0]?.expiry_months ?? 12
    } else if (giftCard.giftCardTypeId) {
      const typeLookup = await paddockData.query<{
        active: boolean
        custom_amount_enabled: boolean
        custom_amount_min: string | null
        custom_amount_max: string | null
        expiry_months: number | null
      }>(
        'SELECT active, custom_amount_enabled, custom_amount_min, custom_amount_max, expiry_months FROM gift_card_types WHERE id = $1',
        [giftCard.giftCardTypeId]
      )
      const giftCardType = typeLookup.data[0]
      if (!giftCardType) return { success: false, stage: 'validation', reason: 'gift_card_type_not_found' }
      if (!giftCardType.active) return { success: false, stage: 'validation', reason: 'gift_card_type_inactive' }
      if (!giftCardType.custom_amount_enabled) {
        return { success: false, stage: 'validation', reason: 'gift_card_custom_amount_not_allowed' }
      }
      if (!Number.isFinite(giftCard.amount) || (giftCard.amount ?? 0) <= 0) {
        return { success: false, stage: 'validation', reason: 'invalid_gift_card_amount' }
      }
      const min = giftCardType.custom_amount_min !== null ? Number.parseFloat(giftCardType.custom_amount_min) : null
      const max = giftCardType.custom_amount_max !== null ? Number.parseFloat(giftCardType.custom_amount_max) : null
      if ((min !== null && giftCard.amount! < min) || (max !== null && giftCard.amount! > max)) {
        return { success: false, stage: 'validation', reason: 'gift_card_amount_out_of_range' }
      }
      resolvedGiftCardAmount = giftCard.amount!
      resolvedGiftCardExpiryMonths = giftCardType.expiry_months ?? 12
    } else {
      return {
        success: false,
        stage: 'validation',
        reason: 'gift_card_selection_required',
        message: 'Select a gift card preset or a custom-amount gift card type.',
      }
    }
    if (giftCard.fulfillmentMethod !== 'digital' && giftCard.fulfillmentMethod !== 'pickup' && giftCard.fulfillmentMethod !== 'shipping') {
      return { success: false, stage: 'validation', reason: 'invalid_gift_card_fulfillment' }
    }
  }

  if (payment.method && payment.method !== 'card' && payment.method !== 'reader' && payment.method !== 'cash') {
    return { success: false, stage: 'validation', reason: 'invalid_payment_method' }
  }

  // Memberships are sold as real Stripe subscriptions charged off-session by Stripe itself, so
  // cash can never pay for one. Gift card / store credit CAN reduce the first payment (the card
  // on file is always charged for renewals); the saved card itself must exist regardless —
  // checked below. Enforced here (server-side) and mirrored in the checkout UI.
  if (membershipPlan) {
    if (payment.method === 'cash') {
      return {
        success: false,
        stage: 'payment',
        reason: 'membership_cash_not_accepted',
        message:
          "Memberships are billed by Stripe and cannot be paid in cash. The saved card on file is charged for the membership's renewals (a gift card or store credit can reduce the first payment). Take a card on the reader to save one first if needed.",
      }
    }
  }

  let redeemedGiftCard: { id: string; remaining_balance: number; type: string } | null = null
  if (payment.giftCard) {
    if (!Number.isFinite(payment.giftCard.amount) || payment.giftCard.amount <= 0) {
      return { success: false, stage: 'validation', reason: 'gift_card_amount_invalid' }
    }
    const lookup = await paddockData.query<{
      id: string
      remaining_balance: string
      voided: boolean | null
      expiry_date: string
      type: string
    }>(
      'SELECT id, remaining_balance, voided, expiry_date, type FROM gift_cards WHERE id = $1',
      [payment.giftCard.giftCardId]
    )
    const row = lookup.data[0]
    if (!row) return { success: false, stage: 'validation', reason: 'gift_card_not_found' }
    if (row.voided) return { success: false, stage: 'validation', reason: 'gift_card_voided' }
    // Valid through its expiry date (London).
    if (row.expiry_date.slice(0, 10) < londonToday()) {
      return { success: false, stage: 'validation', reason: 'gift_card_expired' }
    }
    if (Number.parseFloat(row.remaining_balance) <= 0) {
      return { success: false, stage: 'validation', reason: 'gift_card_insufficient_or_invalid' }
    }
    redeemedGiftCard = { id: row.id, remaining_balance: Number.parseFloat(row.remaining_balance), type: row.type }
    if (payment.giftCard.amount > redeemedGiftCard.remaining_balance) {
      return { success: false, stage: 'validation', reason: 'gift_card_insufficient_or_invalid' }
    }
  }

  // Store credit redemption — a separate payment part from the gift card above, drawn from the
  // customer's own store_credit_balance (never a gift card). The balance is checked here; the
  // amount-due check happens once cardAmount is known below, and the claim itself (a negative
  // 'redemption' movement through public.store_credit_apply) happens inside the rollback-able
  // block, before any card money is taken.
  if (payment.storeCredit) {
    if (!Number.isFinite(payment.storeCredit.amount) || payment.storeCredit.amount <= 0) {
      return { success: false, stage: 'validation', reason: 'store_credit_amount_invalid' }
    }
    const balanceLookup = await paddockData.query<{ store_credit_balance: string }>(
      'SELECT store_credit_balance FROM customers WHERE id = $1',
      [customerId]
    )
    if (!balanceLookup.data[0]) {
      return { success: false, stage: 'validation', reason: 'customer_not_found' }
    }
    if (payment.storeCredit.amount > Number.parseFloat(balanceLookup.data[0].store_credit_balance)) {
      return { success: false, stage: 'validation', reason: 'store_credit_insufficient' }
    }
  }

  // The payment-part amounts, hoisted here (before any writes) so the membership first-payment
  // discount can be computed before the subscription is created.
  const giftCardRedeemAmount = redeemedGiftCard ? payment.giftCard!.amount : 0
  const storeCreditRedeemAmount = payment.storeCredit ? payment.storeCredit.amount : 0

  // Every mutation below is tracked here so it can be undone (in reverse order) if a later step
  // fails — there is no cross-statement transaction available on this resource (see
  // createBooking.ts / moveBooking.ts for the same pattern), so correctness relies on this
  // manual compensation instead. Rollbacks are pushed in creation order and run in reverse.
  //
  // For the normal flow, that's why `customer_memberships`/`customer_session_passes` (pushed
  // after the order/order_line_items rows they reference via order_line_item_id) get deleted
  // *before* those rows during rollback — required, since both have a plain FK to
  // order_line_items(id).
  //
  // The "buying new to cover this booking" flow additionally creates the order BEFORE the
  // booking (the booking needs to reference the new membership/pass, which needs the order to
  // exist first for its own order_line_item). That flow's booking rollback explicitly deletes the
  // booking's own order_line_items row before deleting the booking itself (bookings are otherwise
  // still referenced by it), and the booking rollback is pushed AFTER the membership/pass
  // rollback (bookings.redeemed_membership_id/redeemed_session_pass_id block deleting those rows
  // while a booking still references them) — so creation order there is order → membership/pass
  // → booking, and rollback (reverse) is booking → membership/pass → order, which is exactly the
  // sequence the real FK constraints require.
  const rollbacks: Array<() => Promise<void>> = []
  async function rollbackAll() {
    for (const fn of rollbacks.slice().reverse()) {
      try {
        await fn()
      } catch {
        // Best-effort — a failed rollback step shouldn't block the others from running.
      }
    }
  }

  // Captured while creating the order so a LATER rollback (cancelReaderOrder / finalise failure)
  // can undo precisely without the in-memory closures — stored on orders.reader_payment.
  const readerStockAdjustmentIds: string[] = []
  let membershipFirstPaymentDue = 0

  let bookingId: string | undefined
  let bookingPrice = 0
  let eventBookingId: string | undefined
  let giftCardId: string | undefined
  let giftCardCode: string | undefined
  let giftCardRedemptionId: string | undefined
  let membershipId: string | undefined
  let sessionPassId: string | undefined
  let orderId: string | undefined
  let orderTotal = 0
  let cardAmount = 0
  let amountToCharge = 0
  let amountDueTotal = 0
  let cancelledExhaustedMembership = false
  let oldMembershipPreviousState:
    | { subscription_status: string; addon_credits_remaining: number }
    | undefined

  /** The event's order line: quantity = places, line_total = the quoted list total (unit_price is
   *  its per-place average for display — places can be priced differently; refunds read
   *  line_total minus discount_amount), discount_amount = the promo's event share. */
  async function insertEventOrderLine(): Promise<void> {
    if (!eventLine || !eventBookingId) return
    const places = eventLine.quote.length
    await paddockData.query(
      `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, event_booking_id, discount_amount)
       VALUES ($1, 'event', $2, $3, $4, $5, $6)`,
      [
        orderId,
        places,
        Math.round((eventLine.listTotal / places) * 100) / 100,
        eventLine.listTotal,
        eventBookingId,
        currentPromo()?.eventDiscount ?? 0,
      ]
    )
  }

  // --- Membership subscriptions: money moves FIRST ---
  // A membership in the basket is billed by Stripe as a real subscription, charged off-session
  // against the customer's saved card. The create-subscription route takes the first invoice
  // payment immediately and writes NOTHING to Postgres, so it must be called before any DB row
  // is written (requirement: only after it succeeds do the membership/order rows exist). If it
  // fails, nothing has been written and nothing is left behind — the specific failure codes are
  // mapped to staff-facing messages by createMembershipSubscription + FAILURE_MESSAGES.
  let membershipSubscription: MembershipSubscriptionSuccess | null = null
  // Set by the compensation rollback below when the subscription had to be cancelled and
  // refunded after a later failure — appended to the failure message staff see.
  let membershipCompensationNote: string | null = null

  /** Wraps a failure result for any failure that happens after the Stripe subscription was
   *  created, appending what happened to the subscription so staff never mistake a refunded
   *  charge for kept money. Also flags a reader charge taken before the failure (the reader
   *  money moved outside this function and is not auto-refunded). A no-op for baskets without
   *  a membership. */
  function membershipAwareFailure(base: CreateOrderResult): CreateOrderResult {
    if (!membershipSubscription) return base
    const parts: string[] = [
      membershipCompensationNote ??
        'The membership subscription was cancelled and its first payment refunded automatically — no membership or order was kept.',
    ]
    // The reader's own message already directs staff to refund that charge manually.
    const note = parts.join(' ')
    return { ...base, message: base.message ? `${base.message} ${note}` : note }
  }

  /** Read-through accessors — TS's control flow can't see the assignments that happen inside
   *  createSubscriptionForBasket() / resolvePromoForBasket(), so direct reads of those `let`s
   *  narrow to `never`. Going through a function reads the declared type. */
  function currentSubscription(): MembershipSubscriptionSuccess | null {
    return membershipSubscription
  }
  function currentPromo(): typeof promoApplied {
    return promoApplied
  }

  const readerNewMode = payment.method === 'reader'

  if (membershipPlan && !readerNewMode) {
    // A subscription is charged off-session against the customer's saved card — without one
    // there is nothing Stripe can charge, so refuse before any money moves. Staff save a card
    // via the reader flow first (the checkout's "Save card via reader" step). A saved card is
    // ALWAYS required to buy a membership, even when gift card / store credit covers the whole
    // first payment (the card is still charged for renewals).
    // EXCEPT in the new reader flow: the reader tap itself saves the card (finaliseReaderOrder
    // resolves and persists it from the PaymentIntent before the subscription is created) —
    // there the save-card CONSENT flag is required instead.
    const savedCardLookup = await paddockData.query<{ saved_payment_method_id: string | null }>(
      'SELECT saved_payment_method_id FROM customers WHERE id = $1',
      [customerId]
    )
    if (!savedCardLookup.data[0]?.saved_payment_method_id) {
      return membershipAwareFailure({
        success: false,
        stage: 'payment',
        reason: 'membership_no_saved_card',
        message:
          "This customer has no saved card. A membership always needs one — the card on file is charged for the membership's renewals (a gift card or store credit can reduce the first payment, but the card must be on file) — save a card on the card reader first, then retry checkout.",
      })
    }
  }
  if (membershipPlan && readerNewMode && payment.readerSaveCard !== true) {
    return membershipAwareFailure({
      success: false,
      stage: 'payment',
      reason: 'reader_save_card_required',
      message:
        'Saving the card on the reader is required for a membership — the saved card is charged for the membership\'s renewals. Tick "Save this card for future charges?" (the customer must agree) before charging.',
    })
  }

  /** Creates the membership subscription (with the first-payment discount when gift card /
   *  store credit is applied to it) and registers the compensating rollback (cancel the
   *  subscription + refund the card-charged part of the first invoice on any later failure).
   *  Sets `membershipSubscription`. Returns a failure result, or null on success. */
  async function createSubscriptionForBasket(discountAmount: number): Promise<CreateOrderResult | null> {
    const subscriptionResult = await createMembershipSubscription({
      customerId,
      membershipPlanId: membershipPlanId!,
      billingFrequency: membershipBillingFrequency!,
      ...(req.params.membershipIdempotencyKey ? { idempotencyKey: req.params.membershipIdempotencyKey } : {}),
      ...(discountAmount > 0 ? { discountAmount } : {}),
    })
    if (!subscriptionResult.ok) {
      return membershipAwareFailure({
        success: false,
        stage: 'payment',
        reason: MEMBERSHIP_SUBSCRIPTION_FAILURE_REASONS[subscriptionResult.code],
        message: subscriptionResult.message,
      })
    }
    membershipSubscription = subscriptionResult.subscription

    // Compensation: if anything later fails, cancel the subscription and refund the card-charged
    // part of its first invoice (the discounted part was never card money — the gift card /
    // store credit reversals restore those ledgers separately).
    const capturedSubscription = membershipSubscription
    rollbacks.push(async () => {
      const cancelResult = await cancelMembershipSubscription(capturedSubscription.subscriptionId)
      let refundProblem: string | null = null
      if (capturedSubscription.paymentIntentId && capturedSubscription.amountPaid > 0) {
        // The whole first payment, once: Stripe can't refund it twice, and the key makes a repeat of
        // this call safe. Nothing in the app sends it again, as the order is rolled back.
        const refund = await refundPaymentIntent(
          capturedSubscription.paymentIntentId,
          capturedSubscription.amountPaid,
          `subscription-undo:${capturedSubscription.paymentIntentId}:${Math.round(capturedSubscription.amountPaid * 100)}`
        )
        if (!refund.ok) {
          refundProblem = refund.unsure
            ? `the refund of its first payment gave no clear answer, so it may have gone through (${refund.message ?? 'no answer'}). Check payment ${capturedSubscription.paymentIntentId} in Stripe first: it can't be refunded twice`
            : (refund.message ?? 'the refund failed')
        }
      }
      membershipCompensationNote =
        cancelResult.attempted && cancelResult.success && !refundProblem
          ? 'The membership subscription was cancelled and its card-charged first payment refunded automatically — no membership or order was kept.'
          : `The membership subscription (${capturedSubscription.subscriptionId}) could not be fully cancelled and refunded automatically${refundProblem ? `: ${refundProblem}` : ''} — cancel it and refund the first invoice payment in Stripe manually.`
    })
    return null
  }

  /** Claims the payment step's store credit and gift card (the reversible local writes):
   *  negative 'redemption' movements / balance debits recorded against this order, with
   *  compensating rollbacks registered. Returns a failure result, or null on success.
   *  Idempotent within one checkout: the membership flow claims before the subscription, the
   *  reader flow claims again before its PaymentIntent, and the saved-card/cash paths claim
   *  before the charge — the guard makes repeat calls no-ops instead of double claims. */
  let paymentPartsClaimed = false
  async function claimStoreCreditAndGiftCard(): Promise<CreateOrderResult | null> {
    if (paymentPartsClaimed) return null
    if (storeCreditRedeemAmount > 0) {
      const applied = await applyStoreCredit({
        customerId,
        amount: -storeCreditRedeemAmount,
        reason: 'redemption',
        orderId: orderId!,
        staffId: actingStaffId,
        note: 'Store credit redeemed at checkout.',
      })
      if (!applied.ok) {
        return membershipAwareFailure({
          success: false,
          stage: 'payment',
          reason: applied.reason === 'insufficient_store_credit' ? 'store_credit_insufficient' : 'store_credit_failed',
        })
      }
      rollbacks.push(async () => {
        // Found by its note if its answer is lost (shared/storeCreditRefund), so it is never put back twice.
        const back = await storeCreditMoved({
          customerId,
          amount: storeCreditRedeemAmount,
          reason: 'redemption_reversal',
          orderId: orderId!,
          staffId: actingStaffId,
          note: 'Automatic reversal — the order failed after the store credit was redeemed.',
        })
        if (!back) throw new Error('Putting the store credit back failed.')
      })
    }

    if (redeemedGiftCard) {
      const capturedGiftCardId = redeemedGiftCard.id
      const capturedAmount = giftCardRedeemAmount
      const claim = await paddockData.query<{ id: string; remaining_balance: string }>(
        `UPDATE gift_cards SET remaining_balance = remaining_balance - $1, updated_at = now()
         WHERE id = $2 AND remaining_balance >= $3 AND voided IS NOT TRUE AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date
         RETURNING id, remaining_balance`,
        [capturedAmount, capturedGiftCardId, capturedAmount]
      )
      if (claim.data.length === 0) {
        return membershipAwareFailure({ success: false, stage: 'payment', reason: 'gift_card_insufficient_or_invalid' })
      }
      const newBalance = Number.parseFloat(claim.data[0]!.remaining_balance)
      const wasFullyRedeemed = newBalance <= 0
      if (wasFullyRedeemed) {
        await paddockData.query(`UPDATE gift_cards SET redeemed_at = now() WHERE id = $1 AND redeemed_at IS NULL`, [
          capturedGiftCardId,
        ])
      }
      const redemptionResult = await paddockData.query<{ id: string }>(
        `INSERT INTO gift_card_redemptions (gift_card_id, order_id, amount_used, redeemed_at)
         VALUES ($1, $2, $3, now())
         RETURNING id`,
        [capturedGiftCardId, orderId!, capturedAmount]
      )
      giftCardRedemptionId = redemptionResult.data[0]!.id
      const capturedRedemptionId = giftCardRedemptionId
      rollbacks.push(async () => {
        await paddockData.query(`DELETE FROM gift_card_redemptions WHERE id = $1`, [capturedRedemptionId])
        if (wasFullyRedeemed) {
          await paddockData.query(
            `UPDATE gift_cards SET remaining_balance = remaining_balance + $1, redeemed_at = NULL, updated_at = now() WHERE id = $2`,
            [capturedAmount, capturedGiftCardId]
          )
        } else {
          await paddockData.query(
            `UPDATE gift_cards SET remaining_balance = remaining_balance + $1, updated_at = now() WHERE id = $2`,
            [capturedAmount, capturedGiftCardId]
          )
        }
      })
    }
    paymentPartsClaimed = true
    return null
  }

  // --- Promo code (optional) -------------------------------------------------------------------
  // Filled in by resolvePromoForBasket() — called exactly ONCE per order, always before any
  // payment money moves; that one result is used for the order lines, the order's
  // discount_amount, the booking seats and the promo_code_redemptions row. Normal flow: right
  // after the booking is created (its written seats are individually eligible). "Buy new to cover
  // this booking" flow: before anything is written, with the guest seats priced up front by the
  // same quote createBooking uses (the membership's share must be known before its subscription).
  let promoApplied: {
    promoId: string
    promoCode: string
    totalDiscount: number
    bookingDiscount: number
    bookingGuestDiscounts: Array<{ guestId: string; discount: number }>
    /** "Buy new to cover this booking" flow only: the guest seats are priced before the booking
     *  exists, so their discounts are keyed by seat number and mapped onto the written
     *  booking_guests rows afterwards (verifyPreBookingSeats). */
    bookingSeatDiscounts: Array<{ seatNo: number; amount: number; discount: number }>
    addonDiscounts: Map<CheckoutAddonLine, number>
    productDiscounts: Map<CheckoutProductLine, number>
    passDiscount: number
    membershipDiscount: number
    /** Event line: per-place discount keyed by place_no, and their sum. */
    eventPlaceDiscounts: Map<number, number>
    eventDiscount: number
  } | null = null
  const promoCodeInput = typeof req.params.promoCode === 'string' ? req.params.promoCode.trim() : ''

  /** Promo lines for a WRITTEN booking: one per money-paid seat (a seat priced below the
   *  session band's list price is a member-discounted account-holder seat, for the
   *  applies_on_member_prices rule; guests always pay the full band price). A private booking has
   *  no seat prices, so it is one line for the whole price, which is never a member price
   *  (W03-decisions Q24). */
  async function writtenBookingSeatPromoLines(bookingIdForSeats: string, bookingListPrice: number): Promise<PromoEligibleLine[]> {
    const eligible: PromoEligibleLine[] = []
    if (bookingListPrice > 0.005) {
      // One eligible line per money-paid seat. A seat priced below the session band's list price
      // is a member-discounted account-holder seat (guests always pay the full band price).
      const seats = await paddockData.query<{
        id: string
        unit_price: string
        pay_by: string | null
        guest_type: string
        band_list_price: string | null
        booking_type: string | null
      }>(
        `SELECT bg.id, bg.unit_price, bg.pay_by, bg.guest_type, sb.price AS band_list_price, st.booking_type
         FROM booking_guests bg
         JOIN bookings b ON b.id = bg.booking_id
         LEFT JOIN sessions s ON s.id = b.session_id
         LEFT JOIN session_bands sb ON sb.id = s.band_id
         LEFT JOIN service_types st ON st.id = s.service_type_id
         WHERE bg.booking_id = $1`,
        [bookingIdForSeats]
      )
      if (seats.data[0]?.booking_type === 'private') {
        return [{ key: 'booking', itemType: 'booking', amount: bookingListPrice, isMemberPriced: false }]
      }
      for (const seat of seats.data) {
        if (seat.pay_by !== 'paid') continue
        const amount = Number.parseFloat(seat.unit_price)
        if (!(amount > 0.005)) continue
        const memberPriced =
          seat.guest_type === 'account_holder' &&
          seat.band_list_price !== null &&
          amount < Number.parseFloat(seat.band_list_price) - 0.005
        eligible.push({ key: `guest:${seat.id}`, itemType: 'booking', amount, isMemberPriced: memberPriced })
      }
    }
    return eligible
  }

  /** Buy-new flow: the booking's paid seats priced before the booking exists (filled by
   *  preBookingSeatPromoLines, checked against the written seats by verifyPreBookingSeats). */
  let preBookingSeatLines: PromoEligibleLine[] = []
  /** Buy-new flow: how seat 1 must be written — covered by the credit being bought, or (a new
   *  membership whose level doesn't cover this session's band) paid at the plan's member price. */
  let preBookingSeat1: { payBy: 'membership_credit' | 'session_pass_credit' } | { payBy: 'paid'; amount: number } | null = null

  /** Prices the buy-new flow's booking before it exists, with the same figures createBooking will
   *  write: guest seats (seat 2 on) from quote_booking (guests always pay the full band price,
   *  whatever membership is being bought); seat 1 is covered by the new pass (its band coverage is
   *  validated above) or by the new membership's credit — except when the plan's level doesn't
   *  cover the session's band (e.g. Core on Peak), when it is a paid seat at the plan's member
   *  price (plan_seat_terms, which mirrors quote_booking's seat 1). Paid seats are promo lines
   *  (seat 1 member-priced) and count as money before gift card / store credit spill onto the
   *  membership. Unpriceable sessions give no lines (createBooking then refuses with band_unpriced). */
  async function preBookingSeatPromoLines(): Promise<PromoEligibleLine[]> {
    if (!booking) return []
    const lines: PromoEligibleLine[] = []
    preBookingSeat1 = { payBy: bookingBuysNewMembership ? 'membership_credit' : 'session_pass_credit' }
    if (bookingBuysNewMembership && membershipPlanId) {
      const terms = await paddockData.query<{ credit_eligible: boolean; unit_price: string }>(
        'SELECT credit_eligible, unit_price FROM plan_seat_terms($1, $2)',
        [membershipPlanId, booking.sessionId]
      )
      const seat1 = terms.data[0]
      if (!seat1) {
        preBookingSeat1 = null
      } else if (!seat1.credit_eligible) {
        const amount = Number.parseFloat(seat1.unit_price)
        preBookingSeat1 = { payBy: 'paid', amount }
        if (amount > 0.005) lines.push({ key: 'seat:1', itemType: 'booking', amount, isMemberPriced: true })
      }
    }
    if (booking.guests.length < 2) return lines
    let seats: Awaited<ReturnType<typeof quoteSeats>>
    try {
      seats = await quoteSeats(booking.sessionId, customerId, booking.guests.length)
    } catch {
      return lines
    }
    for (const seat of seats) {
      if (seat.seat_no < 2 || !(Number.parseFloat(seat.unit_price) > 0.005)) continue
      lines.push({ key: `seat:${seat.seat_no}`, itemType: 'booking', amount: Number.parseFloat(seat.unit_price), isMemberPriced: false })
    }
    return lines
  }

  /** Resolves the promo code against the basket using the Retool copy of the promo logic — the
   *  client's discount figure is never trusted. The preview now comes from the Worker, through
   *  validatePromoCode.ts, so until step C any promo rule change must be made in both.
   *  Booking seats come in `bookingSeatLines` (writtenBookingSeatPromoLines in the normal flow,
   *  preBookingSeatPromoLines in the buy-new flow). Returns a failure result, or null on
   *  success/no-code. */
  async function resolvePromoForBasket(bookingSeatLines: PromoEligibleLine[]): Promise<CreateOrderResult | null> {
    if (!promoCodeInput) return null
    const loaded = await loadPromoAndUsage(promoCodeInput, customerId)
    if (!loaded) {
      return {
        success: false,
        stage: 'validation',
        reason: 'promo_code_invalid',
        message: `Promo code "${promoCodeInput.toUpperCase()}" does not exist.`,
      }
    }

    const eligible: PromoEligibleLine[] = [...bookingSeatLines]
    standaloneAddonLines.forEach((line, i) => {
      const addon = addonLookups.get(line.addonId)
      const memberPriced =
        hasActiveMembership && addon?.member_price != null && Math.round(line.unitPrice * 100) === Math.round(Number.parseFloat(addon.member_price) * 100)
      eligible.push({ key: `addon:${i}`, itemType: 'addon', amount: line.unitPrice * line.quantity, isMemberPriced: memberPriced })
    })
    productLines.forEach((line, i) => {
      const variant = productLookups.get(line.productVariantId)
      const memberPriced =
        hasActiveMembership && variant?.product_member_price != null && Math.round(line.unitPrice * 100) === Math.round(Number.parseFloat(variant.product_member_price) * 100)
      eligible.push({ key: `product:${i}`, itemType: 'product', amount: line.unitPrice * line.quantity, isMemberPriced: memberPriced })
    })
    if (passType && passPrice > 0.005) {
      eligible.push({ key: 'session_pass', itemType: 'session_pass', amount: passPrice, isMemberPriced: false })
    }
    if (membershipPlan && membershipPrice > 0.005) {
      eligible.push({ key: 'membership', itemType: 'membership', amount: membershipPrice, isMemberPriced: false })
    }
    // Event places: one eligible line per paid place (same shape as booking seats).
    if (eventLine) eligible.push(...eventPromoLines(eventLine))

    const result = applyPromoCode({
      promo: loaded.promo,
      usage: loaded.usage,
      todayLondon: londonToday(),
      customerId,
      lines: eligible,
    })
    if (!result.ok) {
      return {
        success: false,
        stage: 'validation',
        reason: 'promo_code_invalid',
        message: `Promo code "${promoCodeInput.toUpperCase()}" cannot be used: ${result.message}`,
      }
    }

    const byKey = new Map(result.perLine.map((l) => [l.key, l.discount]))
    const addonDiscounts = new Map<CheckoutAddonLine, number>()
    standaloneAddonLines.forEach((line, i) => {
      const discount = byKey.get(`addon:${i}`)
      if (discount && discount > 0) addonDiscounts.set(line, discount)
    })
    const productDiscounts = new Map<CheckoutProductLine, number>()
    productLines.forEach((line, i) => {
      const discount = byKey.get(`product:${i}`)
      if (discount && discount > 0) productDiscounts.set(line, discount)
    })
    const bookingGuestDiscounts: Array<{ guestId: string; discount: number }> = []
    const bookingSeatDiscounts: Array<{ seatNo: number; amount: number; discount: number }> = []
    const seatAmounts = new Map(bookingSeatLines.map((l) => [l.key, l.amount]))
    let bookingDiscount = 0
    for (const l of result.perLine) {
      if (l.key.startsWith('guest:')) {
        bookingGuestDiscounts.push({ guestId: l.key.slice('guest:'.length), discount: l.discount })
        bookingDiscount += l.discount
      } else if (l.key.startsWith('seat:')) {
        bookingSeatDiscounts.push({
          seatNo: Number.parseInt(l.key.slice('seat:'.length), 10),
          amount: seatAmounts.get(l.key) ?? 0,
          discount: l.discount,
        })
        bookingDiscount += l.discount
      } else if (l.key === 'booking') {
        // A private booking: the share comes off price_paid and the booking line, as it has no seats.
        bookingDiscount += l.discount
      }
    }
    bookingDiscount = Math.round(bookingDiscount * 100) / 100
    const eventPlaceDiscounts = new Map<number, number>()
    let eventDiscount = 0
    for (const l of result.perLine) {
      if (!l.key.startsWith('event:') || !(l.discount > 0)) continue
      eventPlaceDiscounts.set(Number.parseInt(l.key.slice('event:'.length), 10), l.discount)
      eventDiscount += l.discount
    }
    eventDiscount = Math.round(eventDiscount * 100) / 100
    promoApplied = {
      promoId: result.promoId,
      promoCode: result.code,
      totalDiscount: result.discountTotal,
      bookingDiscount,
      bookingGuestDiscounts,
      bookingSeatDiscounts,
      addonDiscounts,
      productDiscounts,
      passDiscount: byKey.get('session_pass') ?? 0,
      membershipDiscount: byKey.get('membership') ?? 0,
      eventPlaceDiscounts,
      eventDiscount,
    }
    return null
  }

  /** Inserts the promo_code_redemptions row for this order and enforces the usage limits
   *  race-safely via insert-then-count: the order's own redemption is committed first, then the
   *  counts are re-read — so two simultaneous orders can never both keep the last use (the
   *  loser of a race sees the winner's row in its own count and rolls back). Over-blocking
   *  under contention is possible (both racers fail when only one use was left); over-issuing
   *  is not. The unique (promo_code_id, order_id) index is the backstop for retried checkouts.
   *  Rollback of the order (which cascades to redemptions) releases the use if the order later
   *  fails; an explicit delete-rollback is registered as well. Returns a failure result, or
   *  null on success/no-code. */
  async function claimPromoRedemption(): Promise<CreateOrderResult | null> {
    if (!promoApplied || !orderId) return null
    const insert = await paddockData.query<{ id: string }>(
      `INSERT INTO promo_code_redemptions (promo_code_id, order_id, customer_id, discount_amount)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (promo_code_id, order_id) DO NOTHING
       RETURNING id`,
      [promoApplied.promoId, orderId, customerId, promoApplied.totalDiscount]
    )
    const redemptionId = insert.data[0]?.id
    if (!redemptionId) {
      // The unique (promo_code_id, order_id) index fired — this exact order already claimed the
      // code (a retried checkout). Nothing more to do; the earlier claim stands.
      return null
    }
    const capturedRedemptionId = redemptionId
    rollbacks.push(async () => {
      await paddockData.query(`DELETE FROM promo_code_redemptions WHERE id = $1`, [capturedRedemptionId])
    })

    const counts = await paddockData.query<{ total_uses: string; customer_uses: string }>(
      `SELECT COUNT(*) AS total_uses,
              COUNT(*) FILTER (WHERE customer_id = $1) AS customer_uses
       FROM promo_code_redemptions
       WHERE promo_code_id = $2`,
      [customerId, promoApplied.promoId]
    )
    const totalUses = Number.parseInt(counts.data[0]?.total_uses ?? '0', 10)
    const customerUses = Number.parseInt(counts.data[0]?.customer_uses ?? '0', 10)
    const promoLimits = await paddockData.query<{ max_total_uses: number | null; one_use_per_customer: boolean }>(
      'SELECT max_total_uses, one_use_per_customer FROM promo_codes WHERE id = $1',
      [promoApplied.promoId]
    )
    const maxTotalUses = promoLimits.data[0]?.max_total_uses ?? null
    const oneUsePerCustomer = promoLimits.data[0]?.one_use_per_customer === true
    if (maxTotalUses !== null && totalUses > maxTotalUses) {
      return {
        success: false,
        stage: 'payment',
        reason: 'promo_code_invalid',
        message: `Promo code "${promoApplied.promoCode}" has just reached its maximum number of uses (${maxTotalUses}) — the discount cannot be applied. Remove the code and retry.`,
      }
    }
    if (oneUsePerCustomer && customerUses > 1) {
      return {
        success: false,
        stage: 'payment',
        reason: 'promo_code_invalid',
        message: `Promo code "${promoApplied.promoCode}" can only be used once per customer and this customer has just used it in another order. Remove the code and retry.`,
      }
    }
    return null
  }

  /** Buy-new flow, after createBooking: checks the written seats match what was priced up front
   *  (seat 1 covered by the new credit, or paid at the plan's member price; each guest paid at
   *  its quoted price), then maps the promo's per-seat shares onto the written rows (seat 1 = the
   *  account holder row, seat 2 on = the guest rows in order; guests all pay the same band price,
   *  so their order can't change what a seat is worth). Runs with or without a promo: the gift
   *  card / store credit spill onto the membership was worked out from these figures too. A
   *  mismatch (the session's price changed mid-checkout) refuses the order, so no discount or
   *  spill can be wrong. */
  async function verifyPreBookingSeats(): Promise<CreateOrderResult | null> {
    if (!bookingId) return null
    const rows = await paddockData.query<{ id: string; guest_type: string; unit_price: string | null; pay_by: string | null }>(
      'SELECT id, guest_type, unit_price, pay_by FROM booking_guests WHERE booking_id = $1 ORDER BY created_at, id',
      [bookingId]
    )
    const holder = rows.data.find((r) => r.guest_type === 'account_holder')
    const guests = rows.data.filter((r) => r.guest_type === 'additional_guest')
    const priceChanged: CreateOrderResult = {
      success: false,
      stage: 'booking',
      reason: 'promo_booking_price_changed',
      message: "The session's price changed while this order was being made, so nothing was kept. Try again.",
    }
    const seat1 = preBookingSeat1
    if (seat1 && (!holder || holder.pay_by !== seat1.payBy)) return priceChanged
    const rowForSeat = new Map<number, string>()
    for (const line of preBookingSeatLines) {
      const seatNo = Number.parseInt(line.key.slice('seat:'.length), 10)
      const row = seatNo === 1 ? holder : guests[seatNo - 2]
      if (!row || row.pay_by !== 'paid' || Math.abs(Number.parseFloat(row.unit_price ?? '0') - line.amount) > 0.005) {
        return priceChanged
      }
      rowForSeat.set(seatNo, row.id)
    }
    const promo = currentPromo()
    if (promo) {
      promo.bookingGuestDiscounts = promo.bookingSeatDiscounts.flatMap((seat) => {
        const guestId = rowForSeat.get(seat.seatNo)
        return guestId ? [{ guestId, discount: seat.discount }] : []
      })
    }
    return null
  }

  try {
    if (bookingBuysNew) {
      // --- Promo code: worked out once, before any write in this flow — the membership's share
      // must be known before the subscription is created further down. The booking's paid seats
      // are priced up front (see preBookingSeatPromoLines).
      preBookingSeatLines = await preBookingSeatPromoLines()
      const promoFailureBuyingNew = await resolvePromoForBasket(preBookingSeatLines)
      if (promoFailureBuyingNew) return promoFailureBuyingNew

      // --- "Buy new to cover this booking" flow: order first, then the new membership/pass (+
      // its order_line_item), then the booking referencing it.
      const orderResult = await paddockData.query<{ id: string }>(
        `INSERT INTO orders (customer_id, order_total, payment_status, order_source)
         VALUES ($1, 0, 'pending', 'staff_created')
         RETURNING id`,
        [customerId]
      )
      orderId = orderResult.data[0]!.id
      const capturedOrderId = orderId
      rollbacks.push(async () => {
        // store_credit_transactions' FK to orders has NO ON DELETE action (order_line_items and
        // promo_code_redemptions cascade) — the failed order's redemption/reversal movements are
        // bookkeeping for money that has been fully reversed, so they are deleted first, or the
        // order delete itself would fail and leave the pending order behind.
        await paddockData.query(`DELETE FROM store_credit_transactions WHERE order_id = $1`, [capturedOrderId])
        await paddockData.query(`DELETE FROM orders WHERE id = $1`, [capturedOrderId])
      })
      const promoClaimFailureBuyingNew = await claimPromoRedemption()
      if (promoClaimFailureBuyingNew) {
        await rollbackAll()
        return membershipAwareFailure(promoClaimFailureBuyingNew)
      }

      if (booking!.cancelExhaustedMembershipId) {
        const prev = await paddockData.query<{
          subscription_status: string
          addon_credits_remaining: number
        }>(
          'SELECT subscription_status, addon_credits_remaining FROM customer_memberships WHERE id = $1',
          [booking!.cancelExhaustedMembershipId]
        )
        oldMembershipPreviousState = prev.data[0]
        const capturedOldMembershipId = booking!.cancelExhaustedMembershipId
        const capturedPreviousState = oldMembershipPreviousState
        // Local deactivation only, here — fully reversible. The real Stripe cancellation (which
        // is NOT reversible) happens later, after every local write below has succeeded.
        await paddockData.query(
          `UPDATE customer_memberships
           SET subscription_status = 'cancelled', addon_credits_remaining = 0, updated_at = now()
           WHERE id = $1`,
          [capturedOldMembershipId]
        )
        rollbacks.push(async () => {
          if (!capturedPreviousState) return
          await paddockData.query(
            `UPDATE customer_memberships
             SET subscription_status = $1, addon_credits_remaining = $2, updated_at = now()
             WHERE id = $3`,
            [
              capturedPreviousState.subscription_status,
              capturedPreviousState.addon_credits_remaining,
              capturedOldMembershipId,
            ]
          )
        })
      }

      let membershipLineItemId: string | undefined
      let sessionPassLineItemId: string | undefined

      if (bookingBuysNewMembership) {
        const lineResult = await paddockData.query<{ id: string }>(
          `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, membership_plan_id, discount_amount)
           VALUES ($1, 'membership', 1, $2, $3, $4, $5)
           RETURNING id`,
          [orderId, membershipPrice, membershipPrice, membershipPlanId, currentPromo()?.membershipDiscount ?? 0]
        )
        membershipLineItemId = lineResult.data[0]!.id

        // The reversible payment-part writes (store credit deduction, gift card debit) happen
        // BEFORE the subscription is created, so a failed subscription leaves nothing behind
        // (the rollbacks reverse them). The discount = the gift card / store credit remaining
        // after the basket's other money items, applied to the first payment only.
        const claimFailure = await claimStoreCreditAndGiftCard()
        if (claimFailure) {
          await rollbackAll()
          return membershipAwareFailure(claimFailure)
        }
        const otherMoneyTotal = (booking.addons ?? []).reduce(
          (sum, line) => ((line.redemptionSource ?? 'paid') === 'paid' ? sum + line.unitPrice * line.quantity : sum),
          0
        ) + productLines.reduce((sum, line) => sum + line.unitPrice * line.quantity - (currentPromo()?.productDiscounts.get(line) ?? 0), 0)
          + (giftCard ? resolvedGiftCardAmount ?? 0 : 0)
          + (eventLine ? eventLine.listTotal - (currentPromo()?.eventDiscount ?? 0) : 0)
          // The booking's paid seats (guests, and seat 1 when the plan doesn't cover this session),
          // net of their promo share, are money too, so the gift card / store credit covers them
          // before spilling onto the membership's first payment.
          + preBookingSeatLines.reduce((sum, line) => sum + line.amount, 0) - (currentPromo()?.bookingDiscount ?? 0)
        // The promo's membership share discounts the first invoice FIRST; gift card / store
        // credit then discount what remains of it. Combined never above the membership price.
        // New reader flow: the subscription is created by finaliseReaderOrder instead (the
        // reader tap has saved the card by then), so skip it here — the membership ROW below is
        // still created (the booking needs it to claim its session credit), with a NULL Stripe
        // subscription id that finalise patches.
        if (!readerNewMode) {
          const promoMembershipDiscount = currentPromo()?.membershipDiscount ?? 0
          const discountOnMembership = Math.max(
            0,
            Math.min(giftCardRedeemAmount + storeCreditRedeemAmount - otherMoneyTotal, membershipPrice - promoMembershipDiscount)
          )
          const subscriptionFailure = await createSubscriptionForBasket(promoMembershipDiscount + discountOnMembership)
          if (subscriptionFailure) {
            await rollbackAll()
            return membershipAwareFailure(subscriptionFailure)
          }
        }

        // The Stripe subscription is the source of truth for the billing period — start_date and
        // next_renewal_date come from its current period rather than being computed locally.
        const startDate = toDateOnly(currentSubscription()?.currentPeriodStart, londonToday())
        const nextRenewal = toDateOnly(
          currentSubscription()?.currentPeriodEnd,
          addMonthsToIsoDate(londonToday(), membershipBillingFrequency === 'yearly' ? 12 : 1)
        )
        const result = await paddockData.query<{ id: string }>(
          `INSERT INTO customer_memberships
             (customer_id, plan_id, start_date, next_renewal_date, addon_credits_remaining,
              subscription_status, stripe_subscription_id, order_line_item_id, billing_frequency, is_herd)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            customerId,
            membershipPlanId,
            startDate,
            nextRenewal,
            membershipPlan!.addons_included ?? 0,
            currentSubscription()?.status ?? 'active',
            // New reader flow: no subscription exists yet — finaliseReaderOrder patches this id
            // (and the period dates) after creating the subscription via the Worker.
            currentSubscription()?.subscriptionId ?? null,
            membershipLineItemId,
            membershipBillingFrequency,
            // Yearly memberships are Herd (add-on credits usable) from sign-up; monthly ones
            // become Herd automatically after the configured waiting period (refresh_herd_flags).
            membershipBillingFrequency === 'yearly',
          ]
        )
        membershipId = result.data[0]!.id
        // Session credits are no longer granted into the counter — the daily/period engine owns
        // them now. Allocate the new membership's first credit period immediately so it can cover
        // this very booking (createBooking below draws from the CURRENT period).
        await paddockData.query('SELECT public.allocate_membership_credit_periods()')
        const capturedNewMembershipId = membershipId
        rollbacks.push(async () => {
          await paddockData.query(`DELETE FROM customer_memberships WHERE id = $1`, [capturedNewMembershipId])
        })
      }

      if (bookingBuysNewSessionPass) {
        const lineResult = await paddockData.query<{ id: string }>(
          `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, session_pass_type_id, discount_amount)
           VALUES ($1, 'session_pass', 1, $2, $3, $4, $5)
           RETURNING id`,
          [orderId, passPrice, passPrice, sessionPassTypeId, currentPromo()?.passDiscount ?? 0]
        )
        sessionPassLineItemId = lineResult.data[0]!.id

        // London dates: bought today in London, valid through the same date N months on.
        const purchaseDate = londonToday()
        const expiryDate = addMonthsToIsoDate(purchaseDate, passTypeExpiryMonths)
        const result = await paddockData.query<{ id: string }>(
          `INSERT INTO customer_session_passes
             (customer_id, pass_type_id, purchase_date, sessions_remaining, expiry_date, order_line_item_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [customerId, sessionPassTypeId, purchaseDate, passType!.sessions_included ?? 0, expiryDate, sessionPassLineItemId]
        )
        sessionPassId = result.data[0]!.id
        const capturedNewSessionPassId = sessionPassId
        rollbacks.push(async () => {
          await paddockData.query(`DELETE FROM customer_session_passes WHERE id = $1`, [capturedNewSessionPassId])
        })
      }

      const bookingResult = await createBooking({
        params: {
          sessionId: booking!.sessionId,
          customerId,
          guests: booking!.guests,
          guestsOver18Confirmed: booking!.guestsOver18Confirmed === true,
          redemptionSource: bookingBuysNewMembership ? 'membership_credit' : 'session_pass_credit',
          ...(bookingBuysNewMembership && membershipId ? { membershipId } : sessionPassId ? { sessionPassId } : {}),
        },
        user: req.user,
      })
      if (!bookingResult.created) {
        await rollbackAll()
        return membershipAwareFailure({
          success: false,
          stage: 'booking',
          ...(bookingResult.reason !== undefined ? { reason: bookingResult.reason } : {}),
          ...(bookingResult.reason !== undefined ? { bookingFailureReason: bookingResult.reason } : {}),
          ...(bookingResult.message !== undefined ? { message: bookingResult.message } : {}),
        })
      }
      const createdBooking = bookingResult.booking as { id: string; price_paid: number; session_id: string }
      bookingId = createdBooking.id
      bookingPrice = createdBooking.price_paid
      const capturedBookingId = bookingId
      const capturedSessionId = createdBooking.session_id
      const capturedGuestCount = booking!.guests.length
      rollbacks.push(async () => {
        // The booking's own order_line_items row must go first — bookings are still referenced
        // by it (order_line_items.booking_id), and the order itself hasn't been rolled back yet
        // at this point in the reversed sequence.
        await paddockData.query(`DELETE FROM order_line_items WHERE booking_id = $1`, [capturedBookingId])
        await releaseSessionCapacity(capturedSessionId, capturedGuestCount)
        // booking_guests and addon_order_lines rows cascade-delete automatically.
        await paddockData.query(`DELETE FROM bookings WHERE id = $1`, [capturedBookingId])
      })

      // The booking's promo share is written onto its seats below (verifyPreBookingSeats);
      // the line carries the same figure, as in the normal flow.
      await paddockData.query(
        `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, booking_id, discount_amount)
         VALUES ($1, 'booking', 1, $2, $3, $4, $5)`,
        [orderId, bookingPrice, bookingPrice, bookingId, currentPromo()?.bookingDiscount ?? 0]
      )

      // Attached add-ons redeeming membership credit: an explicit membershipId is honored as-is;
      // otherwise (only possible when bookingBuysNewMembership, per the validation above) default
      // to the membership just purchased.
      for (const line of attachedAddons) {
        if (line.redemptionSource !== 'membership_credit') continue
        const effectiveMembershipId = line.membershipId ?? membershipId!
        if (line.membershipId) {
          const membershipLookup = await paddockData.query<{ id: string }>(
            `SELECT id FROM customer_memberships
             WHERE id = $1 AND customer_id = $2 AND subscription_status = 'active'
               AND (cancel_effective_date IS NULL OR cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)`,
            [effectiveMembershipId, customerId]
          )
          if (membershipLookup.data.length === 0) {
            await rollbackAll()
            return membershipAwareFailure({ success: false, stage: 'booking', reason: 'addon_membership_not_found' })
          }
        }
        const reserved = await reserveMembershipAddonCredit(effectiveMembershipId, line.quantity)
        if (!reserved.reserved) {
          await rollbackAll()
          return membershipAwareFailure({
            success: false,
            stage: 'booking',
            reason: reserved.reason === 'membership_too_new' ? 'addon_membership_too_new' : 'insufficient_addon_membership_credit',
          })
        }
        const capturedMembershipId = effectiveMembershipId
        const capturedQuantity = line.quantity
        rollbacks.push(async () => {
          await releaseMembershipAddonCredit(capturedMembershipId, capturedQuantity)
        })
        // Record which membership actually ended up covering this line (defaulted or explicit).
        line.membershipId = effectiveMembershipId
      }
    } else if (booking) {
      // --- Normal flow: booking against an existing credit (or paid), created first.
      const bookingResult = await createBooking({
        params: {
          sessionId: booking.sessionId,
          customerId,
          guests: booking.guests,
          guestsOver18Confirmed: booking.guestsOver18Confirmed === true,
          redemptionSource: booking.redemptionSource as RedemptionSource,
          ...(booking.membershipId ? { membershipId: booking.membershipId } : {}),
          ...(booking.sessionPassId ? { sessionPassId: booking.sessionPassId } : {}),
          ...(booking.specialRequests ? { specialRequests: booking.specialRequests } : {}),
        },
        user: req.user,
      })
      if (!bookingResult.created) {
        return {
          success: false,
          stage: 'booking',
          ...(bookingResult.reason !== undefined ? { reason: bookingResult.reason } : {}),
          ...(bookingResult.reason !== undefined ? { bookingFailureReason: bookingResult.reason } : {}),
          ...(bookingResult.message !== undefined ? { message: bookingResult.message } : {}),
        }
      }
      const createdBooking = bookingResult.booking as { id: string; price_paid: number; session_id: string }
      bookingId = createdBooking.id
      bookingPrice = createdBooking.price_paid
      rollbacks.push(async () => {
        await releaseSessionCapacity(createdBooking.session_id, booking.guests.length)
        // booking_guests rows cascade-delete automatically (ON DELETE CASCADE).
        await paddockData.query(`DELETE FROM bookings WHERE id = $1`, [createdBooking.id])
      })
      // Membership session credits need no rollback here — usage is counted from non-cancelled
      // bookings carrying credit_period_id, and the booking itself is deleted by the rollback
      // above, which un-uses its credit automatically.
      if (booking.redemptionSource === 'session_pass_credit' && booking.sessionPassId && bookingResult.seat1PayBy === 'session_pass_credit') {
        const capturedSessionPassId = booking.sessionPassId
        rollbacks.push(async () => {
          await releaseSessionPassCredit(capturedSessionPassId)
        })
      }

      // Attached add-ons redeeming membership credit each draw from their own specified
      // membership (validated to belong to this customer here, since — unlike the booking's own
      // redemption — this isn't routed through createBooking.ts).
      for (const line of attachedAddons) {
        if (line.redemptionSource !== 'membership_credit') continue
        const membershipLookup = await paddockData.query<{ id: string }>(
          `SELECT id FROM customer_memberships
           WHERE id = $1 AND customer_id = $2 AND subscription_status = 'active'
             AND (cancel_effective_date IS NULL OR cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)`,
          [line.membershipId, customerId]
        )
        if (membershipLookup.data.length === 0) {
          await rollbackAll()
          return membershipAwareFailure({ success: false, stage: 'booking', reason: 'addon_membership_not_found' })
        }
        const reserved = await reserveMembershipAddonCredit(line.membershipId!, line.quantity)
        if (!reserved.reserved) {
          await rollbackAll()
          return membershipAwareFailure({
            success: false,
            stage: 'booking',
            reason: reserved.reason === 'membership_too_new' ? 'addon_membership_too_new' : 'insufficient_addon_membership_credit',
          })
        }
        const capturedMembershipId = line.membershipId!
        const capturedQuantity = line.quantity
        rollbacks.push(async () => {
          await releaseMembershipAddonCredit(capturedMembershipId, capturedQuantity)
        })
      }
    }

    for (const line of productLines) {
      const claim = await paddockData.query<{ id: string; stock_quantity: number }>(
        `UPDATE product_variants
         SET stock_quantity = stock_quantity - $1, updated_at = now()
         WHERE id = $2 AND stock_quantity >= $3
         RETURNING id, stock_quantity`,
        [line.quantity, line.productVariantId, line.quantity]
      )
      if (claim.data.length === 0) {
        await rollbackAll()
        return membershipAwareFailure({
          success: false,
          stage: 'product',
          reason: 'insufficient_stock',
          productVariantId: line.productVariantId,
        })
      }
      rollbacks.push(async () => {
        await paddockData.query(
          `UPDATE product_variants SET stock_quantity = stock_quantity + $1, updated_at = now() WHERE id = $2`,
          [line.quantity, line.productVariantId]
        )
      })
    }

    // --- Promo code: authoritative validation + per-line discounts -----------------------------
    // Runs after the booking's real price is known (its seats are individually eligible) and
    // before any payment money moves; on failure everything so far is rolled back (the
    // provisional booking included). Credit-paid bookings contribute 0 naturally (price_paid = 0).
    // The buy-new flow already worked the promo out (once) before anything was written; here the
    // written seats are checked against that up-front pricing and its seat shares mapped onto them.
    if (bookingBuysNew) {
      const mapFailure = await verifyPreBookingSeats()
      if (mapFailure) {
        await rollbackAll()
        return membershipAwareFailure(mapFailure)
      }
    } else {
      const promoFailure = await resolvePromoForBasket(
        bookingId ? await writtenBookingSeatPromoLines(bookingId, bookingPrice) : []
      )
      if (promoFailure) {
        await rollbackAll()
        return membershipAwareFailure(promoFailure)
      }
    }
    const promo = currentPromo()
    if (promo && promo.bookingDiscount > 0 && bookingId) {
      // Spread the booking's discount across its money-paid seats (per-seat shares come from the
      // shared logic) and reduce price_paid to what will actually be paid — booking refunds,
      // Cancel & Refund and remove-guest refunds read these stored values, so they automatically
      // refund what was actually paid rather than the list price.
      const seatRows = await paddockData.query<{ id: string; unit_price: string }>(
        'SELECT id, unit_price FROM booking_guests WHERE booking_id = $1',
        [bookingId]
      )
      const originalSeatPriceById = new Map(seatRows.data.map((r) => [r.id, r.unit_price]))
      for (const g of promo.bookingGuestDiscounts) {
        await paddockData.query(`UPDATE booking_guests SET unit_price = unit_price - $1 WHERE id = $2`, [
          g.discount,
          g.guestId,
        ])
      }
      await paddockData.query(`UPDATE bookings SET price_paid = price_paid - $1, updated_at = now() WHERE id = $2`, [
        promo.bookingDiscount,
        bookingId,
      ])
      const capturedBookingId = bookingId
      const capturedDiscount = promo.bookingDiscount
      const capturedGuestDiscounts = promo.bookingGuestDiscounts
      rollbacks.push(async () => {
        // Restore pre-discount seat prices and price_paid (this runs before the booking-delete
        // rollback in the reverse order — a belt-and-braces restore).
        for (const g of capturedGuestDiscounts) {
          const original = originalSeatPriceById.get(g.guestId)
          if (original === undefined) continue
          await paddockData.query(`UPDATE booking_guests SET unit_price = $1 WHERE id = $2`, [original, g.guestId])
        }
        await paddockData.query(`UPDATE bookings SET price_paid = price_paid + $1 WHERE id = $2`, [
          capturedDiscount,
          capturedBookingId,
        ])
      })
    }

    // --- Event line: claim the places, then the event booking + attendees (unit prices net of
    // the promo). 'pending' on the reader path — finaliseReaderOrder confirms it. Its order line
    // is written with the order's other lines below; the rollback registered here removes both.
    if (eventLine) {
      const written = await writeEventBooking({
        line: eventLine,
        customerId,
        staffId: actingStaffId,
        status: readerNewMode ? 'pending' : 'confirmed',
        placeDiscounts: currentPromo()?.eventPlaceDiscounts ?? new Map<number, number>(),
        pushRollback: (fn) => rollbacks.push(fn),
      })
      if (!written.ok) {
        await rollbackAll()
        return membershipAwareFailure({
          success: false,
          stage: 'event',
          reason: 'event_full',
          message: 'Not enough places are left on this event (or it has just gone off sale).',
        })
      }
      eventBookingId = written.eventBookingId
    }

    if (giftCard) {
      // London dates: issued today in London, valid through the same date N months on.
      const issueDate = londonToday()
      const expiryDate = addMonthsToIsoDate(issueDate, resolvedGiftCardExpiryMonths)
      let inserted = false
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        const code = generateGiftCardCode()
        try {
          const result = await paddockData.query<{ id: string; code: string }>(
            `INSERT INTO gift_cards
               (code, type, original_value, remaining_balance, purchaser_id, recipient_name, recipient_email,
                gift_message, origin, issue_date, expiry_date, fulfillment_method)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'customer_purchase', $9, $10, $11)
             RETURNING id, code`,
            [
              code,
              'monetary',
              resolvedGiftCardAmount,
              resolvedGiftCardAmount,
              customerId,
              giftCard.recipientName ?? null,
              giftCard.recipientEmail ?? null,
              giftCard.giftMessage ?? null,
              issueDate,
              expiryDate,
              giftCard.fulfillmentMethod,
            ]
          )
          giftCardId = result.data[0]!.id
          giftCardCode = result.data[0]!.code
          inserted = true
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (!message.includes('gift_cards_code_key')) {
            await rollbackAll()
            return membershipAwareFailure({ success: false, stage: 'gift_card', reason: 'gift_card_creation_failed', message })
          }
          // Unique code collision — loop and try another generated code.
        }
      }
      if (!inserted) {
        await rollbackAll()
        return membershipAwareFailure({ success: false, stage: 'gift_card', reason: 'gift_card_code_exhausted' })
      }
      const capturedGiftCardId = giftCardId
      rollbacks.push(async () => {
        await paddockData.query(`DELETE FROM gift_cards WHERE id = $1`, [capturedGiftCardId])
      })
    }

    // Compute totals now that every price input is known (booking price, addon/product unit
    // prices, catalog membership/session-pass prices, gift card amount).
    if (bookingId) {
      orderTotal += bookingPrice
      // price_paid is the sum of seats actually paid with money (credit-covered seats excluded).
      // Every booking therefore contributes its price_paid to the card/cash/reader amount —
      // including membership/session-pass bookings whose guest seats are paid. A gift card pays
      // for it the normal way, as a payment part taken off this amount below. The promo discount
      // reduces the money the booking contributes (its price_paid was reduced to match above);
      // order_total stays at the list price with the discount held separately on
      // orders.discount_amount / order_line_items.discount_amount.
      cardAmount += bookingPrice - (currentPromo()?.bookingDiscount ?? 0)
    }
    // Booking add-ons covered by an add-on credit cost nothing, so they stay out of order_total
    // (as credit-covered seats do — bookingPrice is price_paid): order_total is what was owed, and
    // the card-portion helper works from it, so a credit add-on in it let a later card refund ask
    // Stripe for more than it took.
    for (const line of attachedAddons) {
      if ((line.redemptionSource ?? 'paid') !== 'paid') continue
      const lineTotal = line.unitPrice * line.quantity
      orderTotal += lineTotal
      cardAmount += lineTotal
    }
    for (const line of standaloneAddonLines) {
      const lineTotal = line.unitPrice * line.quantity
      orderTotal += lineTotal
      cardAmount += lineTotal - (currentPromo()?.addonDiscounts.get(line) ?? 0)
    }
    for (const line of productLines) {
      const lineTotal = line.unitPrice * line.quantity
      orderTotal += lineTotal
      cardAmount += lineTotal - (currentPromo()?.productDiscounts.get(line) ?? 0)
    }
    if (membershipPlan) {
      orderTotal += membershipPrice
      // The membership's money moves via the Stripe subscription's first invoice (discounted by
      // the promo code first, then any gift card / store credit applied to it) — it must never
      // ALSO be charged as part of the basket's card amount.
    }
    if (passType) {
      orderTotal += passPrice
      cardAmount += passPrice - (currentPromo()?.passDiscount ?? 0)
    }
    if (giftCard) {
      orderTotal += resolvedGiftCardAmount!
      cardAmount += resolvedGiftCardAmount!
    }
    if (eventLine) {
      orderTotal += eventLine.listTotal
      cardAmount += eventLine.listTotal - (currentPromo()?.eventDiscount ?? 0)
    }
    if (postageAmount > 0 || needsShipping) {
      orderTotal += postageAmount
      cardAmount += postageAmount
    }

    // Membership-aware payment caps: gift card + store credit may cover the other items AND the
    // membership's first payment (the discount), but never more than the total due. The card
    // pays whatever remains (0 when fully covered — the subscription's first invoice is then
    // fully discounted). The membership's first payment is its list price minus the promo's
    // membership share.
    const membershipFirstPayment = membershipPlan
      ? membershipPrice - (currentPromo()?.membershipDiscount ?? 0)
      : 0
    membershipFirstPaymentDue = Math.max(0, membershipFirstPayment)
    const totalDue = cardAmount + membershipFirstPayment
    // New reader flow: the ONE reader tap covers everything the customer owes — the
    // non-membership remainder AND the membership's first payment net of its promo share,
    // after gift card / store credit (which cover the non-membership money first, then the
    // membership). Other methods unchanged: the membership is billed by Stripe separately.
    if (readerNewMode) {
      const credits = giftCardRedeemAmount + storeCreditRedeemAmount
      const nonMembershipRemaining = Math.max(0, cardAmount - credits)
      const membershipRemaining = Math.max(0, membershipFirstPaymentDue - Math.max(0, credits - cardAmount))
      amountToCharge = Math.round((nonMembershipRemaining + membershipRemaining) * 100) / 100
    } else {
      amountToCharge = amountLeftToPay(cardAmount, giftCardRedeemAmount, storeCreditRedeemAmount)
    }
    amountDueTotal = Math.round(totalDue * 100) / 100
    // Staff confirmed a cash figure on screen, and a price can change after that, either way.
    // Refused here, while everything is still reversible, so an order can't record a different
    // amount from what they took. Ahead of the checks below so that a price falling under the
    // gift card and store credit still gets the new figure.
    const cashRefusal = cashDifferenceRefusal(payment.method, amountToCharge, payment.confirmedCashAmount)
    if (cashRefusal) {
      await rollbackAll()
      return membershipAwareFailure({
        success: false,
        stage: 'payment',
        reason: cashRefusal.reason,
        message: cashRefusal.message,
        amountDueTotal,
      })
    }
    if (exceedsAmount(giftCardRedeemAmount, totalDue)) {
      await rollbackAll()
      return membershipAwareFailure({ success: false, stage: 'payment', reason: 'gift_card_amount_exceeds_total', amountDueTotal })
    }
    if (exceedsAmount(giftCardRedeemAmount + storeCreditRedeemAmount, totalDue)) {
      await rollbackAll()
      return membershipAwareFailure({ success: false, stage: 'payment', reason: 'store_credit_amount_exceeds_total', amountDueTotal })
    }
    // The card charge covers only the non-membership remainder — when gift card / store credit
    // spills onto the membership's first payment, that part is discounted on the subscription's
    // invoice instead (never a negative card charge). The new reader flow already assigned its
    // own amount above (the one tap covers the membership's first payment too).
    if (!readerNewMode) {
      amountToCharge = amountLeftToPay(cardAmount, giftCardRedeemAmount, storeCreditRedeemAmount)
    }
    if (amountToCharge > 0 && !payment.method) {
      await rollbackAll()
      // The screen thought nothing was owed, so it offered no way to pay: the total brings them up.
      return membershipAwareFailure({ success: false, stage: 'payment', reason: 'payment_method_required', amountDueTotal })
    }

    if (!bookingBuysNew) {
      // Normal flow: order didn't exist yet — create it now, with the correct total already
      // known, then every remaining order_line_items row, then the membership/pass rows (which
      // need their own line item's id first).
      const orderResult = await paddockData.query<{ id: string }>(
        `INSERT INTO orders (customer_id, order_total, payment_status, order_source, shipping_address, promo_code, discount_amount)
         VALUES ($1, $2, 'pending', 'staff_created', $3::jsonb, $4, $5)
         RETURNING id`,
        [
          customerId,
          orderTotal,
          needsShipping && normalizedShippingAddress ? JSON.stringify(normalizedShippingAddress) : null,
          currentPromo()?.promoCode ?? null,
          currentPromo()?.totalDiscount ?? 0,
        ]
      )
      orderId = orderResult.data[0]!.id
      const capturedOrderId = orderId
      rollbacks.push(async () => {
        // order_line_items and promo_code_redemptions cascade from this delete; the store-credit
        // movements do NOT (their FK has no ON DELETE action) — the failed order's
        // redemption/reversal rows are bookkeeping for money that has been fully reversed, so
        // they are deleted first, or the order delete itself would fail and leave the pending
        // order behind.
        await paddockData.query(`DELETE FROM store_credit_transactions WHERE order_id = $1`, [capturedOrderId])
        await paddockData.query(`DELETE FROM orders WHERE id = $1`, [capturedOrderId])
      })
      const promoClaimFailure = await claimPromoRedemption()
      if (promoClaimFailure) {
        await rollbackAll()
        return membershipAwareFailure(promoClaimFailure)
      }

      if (bookingId) {
        await paddockData.query(
          `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, booking_id, discount_amount)
           VALUES ($1, 'booking', 1, $2, $3, $4, $5)`,
          [orderId, bookingPrice, bookingPrice, bookingId, currentPromo()?.bookingDiscount ?? 0]
        )
      }
      await insertEventOrderLine()
      for (const line of standaloneAddonLines) {
        const lineTotal = line.unitPrice * line.quantity
        const system = addonSystemPrice(line)
        await paddockData.query(
          `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, addon_id, system_unit_price, price_override_reason, discount_amount)
           VALUES ($1, 'addon', $2, $3, $4, $5, $6, $7, $8)`,
          [orderId, line.quantity, line.unitPrice, lineTotal, line.addonId, system, overrideReasonOrNull(line.unitPrice, system, line), currentPromo()?.addonDiscounts.get(line) ?? 0]
        )
      }
      for (const line of productLines) {
        const lineTotal = line.unitPrice * line.quantity
        const system = productSystemPrice(line)
        await paddockData.query(
          `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, product_variant_id, fulfillment_status, system_unit_price, price_override_reason, discount_amount)
           VALUES ($1, 'product', $2, $3, $4, $5, 'pending', $6, $7, $8)`,
          [orderId, line.quantity, line.unitPrice, lineTotal, line.productVariantId, system, overrideReasonOrNull(line.unitPrice, system, line), currentPromo()?.productDiscounts.get(line) ?? 0]
        )
        // Audit entry for the stock this sale already claimed earlier — staff_id NULL marks it
        // as system-generated. Rolled back alongside everything else if a later step fails.
        const saleAdjustmentId = await insertStockAdjustment({
          variantId: line.productVariantId,
          changeAmount: -line.quantity,
          reason: `Sale (Order #${orderId})`,
          staffId: null,
        })
        // Recorded on the reader snapshot so a later rollback can delete the exact audit rows.
        readerStockAdjustmentIds.push(saleAdjustmentId)
        rollbacks.push(async () => {
          await deleteStockAdjustment(saleAdjustmentId)
        })
      }

      let membershipLineItemId: string | undefined
      if (membershipPlan) {
        const lineResult = await paddockData.query<{ id: string }>(
          `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, membership_plan_id, discount_amount)
           VALUES ($1, 'membership', 1, $2, $3, $4, $5)
           RETURNING id`,
          [orderId, membershipPrice, membershipPrice, membershipPlanId, currentPromo()?.membershipDiscount ?? 0]
        )
        membershipLineItemId = lineResult.data[0]!.id
      }

      let sessionPassLineItemId: string | undefined
      if (passType) {
        const lineResult = await paddockData.query<{ id: string }>(
          `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, session_pass_type_id, discount_amount)
           VALUES ($1, 'session_pass', 1, $2, $3, $4, $5)
           RETURNING id`,
          [orderId, passPrice, passPrice, sessionPassTypeId, currentPromo()?.passDiscount ?? 0]
        )
        sessionPassLineItemId = lineResult.data[0]!.id
      }

      if (giftCardId) {
        await paddockData.query(
          `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, gift_card_id)
           VALUES ($1, 'gift_card', 1, $2, $3, $4)`,
          [orderId, resolvedGiftCardAmount, resolvedGiftCardAmount, giftCardId]
        )
      }

      if (membershipPlan) {
        // The reversible payment-part writes (store credit deduction, gift card debit) happen
        // BEFORE the subscription is created, so a failed subscription leaves nothing behind
        // (the rollbacks reverse them). The discount = the gift card / store credit remaining
        // after the basket's other money items (booking, add-ons, products, pass, gift-card
        // purchase), applied to the first payment only.
        const claimFailure = await claimStoreCreditAndGiftCard()
        if (claimFailure) {
          await rollbackAll()
          return membershipAwareFailure(claimFailure)
        }
        // New reader flow: the subscription is created by finaliseReaderOrder (after the reader
        // tap has saved the card), so nothing subscription-related happens here — the credits
        // above are still claimed and held while the order is pending.
        if (!readerNewMode) {
          const promoMembershipDiscount = currentPromo()?.membershipDiscount ?? 0
          const otherMoneyTotal =
            bookingPrice - (currentPromo()?.bookingDiscount ?? 0) +
            (booking?.addons ?? []).reduce(
              (sum, line) => ((line.redemptionSource ?? 'paid') === 'paid' ? sum + line.unitPrice * line.quantity : sum),
              0
            ) +
            standaloneAddonLines.reduce((sum, line) => sum + line.unitPrice * line.quantity - (currentPromo()?.addonDiscounts.get(line) ?? 0), 0) +
            productLines.reduce((sum, line) => sum + line.unitPrice * line.quantity - (currentPromo()?.productDiscounts.get(line) ?? 0), 0) +
            (passType ? passPrice - (currentPromo()?.passDiscount ?? 0) : 0) +
            (giftCardId ? resolvedGiftCardAmount ?? 0 : 0) +
            (eventLine ? eventLine.listTotal - (currentPromo()?.eventDiscount ?? 0) : 0)
          // The promo's membership share discounts the first invoice FIRST; gift card / store
          // credit then discount what remains of it (their non-membership spending above is
          // measured on the promo-discounted basket). Combined never above the membership price.
          const discountOnMembership = Math.max(
            0,
            Math.min(giftCardRedeemAmount + storeCreditRedeemAmount - otherMoneyTotal, membershipPrice - promoMembershipDiscount)
          )
          const subscriptionFailure = await createSubscriptionForBasket(promoMembershipDiscount + discountOnMembership)
          if (subscriptionFailure) {
            await rollbackAll()
            return membershipAwareFailure(subscriptionFailure)
          }
        }
      }

      // New reader flow: the customer_memberships row is created by finaliseReaderOrder (after
      // the reader tap saved the card and the subscription exists) — everything the row needs
      // (plan id, frequency, idempotency key, first-payment amount) travels in the order's
      // reader_payment snapshot instead.
      if (membershipPlan && !readerNewMode) {
        // The Stripe subscription is the source of truth for the billing period — start_date and
        // next_renewal_date come from its current period rather than being computed locally.
        const startDate = toDateOnly(currentSubscription()?.currentPeriodStart, londonToday())
        const nextRenewal = toDateOnly(
          currentSubscription()?.currentPeriodEnd,
          addMonthsToIsoDate(londonToday(), membershipBillingFrequency === 'yearly' ? 12 : 1)
        )
        const planDetail = await paddockData.query<{ sessions_included: number | null; addons_included: number | null }>(
          'SELECT sessions_included, addons_included FROM membership_plans WHERE id = $1',
          [membershipPlanId]
        )
        const detail = planDetail.data[0]
        const result = await paddockData.query<{ id: string }>(
          `INSERT INTO customer_memberships
             (customer_id, plan_id, start_date, next_renewal_date, addon_credits_remaining,
              subscription_status, stripe_subscription_id, order_line_item_id, billing_frequency, is_herd)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            customerId,
            membershipPlanId,
            startDate,
            nextRenewal,
            detail?.addons_included ?? 0,
            currentSubscription()?.status ?? 'active',
            membershipSubscription!.subscriptionId,
            membershipLineItemId,
            membershipBillingFrequency,
            // Yearly memberships are Herd (add-on credits usable) from sign-up; monthly ones
            // become Herd automatically after the configured waiting period (refresh_herd_flags).
            membershipBillingFrequency === 'yearly',
          ]
        )
        membershipId = result.data[0]!.id
        // Session credits are no longer granted into the counter — allocate the first credit
        // period immediately so the membership is usable straight away.
        await paddockData.query('SELECT public.allocate_membership_credit_periods()')
        const capturedMembershipId = membershipId
        rollbacks.push(async () => {
          await paddockData.query(`DELETE FROM customer_memberships WHERE id = $1`, [capturedMembershipId])
        })
      }

      if (passType) {
        // London dates: bought today in London, valid through the same date N months on.
        const purchaseDate = londonToday()
        const expiryDate = addMonthsToIsoDate(purchaseDate, passTypeExpiryMonths)
        const passDetail = await paddockData.query<{ sessions_included: number | null }>(
          'SELECT sessions_included FROM session_pass_types WHERE id = $1',
          [sessionPassTypeId]
        )
        const result = await paddockData.query<{ id: string }>(
          `INSERT INTO customer_session_passes
             (customer_id, pass_type_id, purchase_date, sessions_remaining, expiry_date, order_line_item_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            customerId,
            sessionPassTypeId,
            purchaseDate,
            passDetail.data[0]?.sessions_included ?? 0,
            expiryDate,
            sessionPassLineItemId,
          ]
        )
        sessionPassId = result.data[0]!.id
        const capturedSessionPassId = sessionPassId
        rollbacks.push(async () => {
          await paddockData.query(`DELETE FROM customer_session_passes WHERE id = $1`, [capturedSessionPassId])
        })
      }
    } else {
      // "Buying new to cover this booking" flow: order + membership/pass + booking (+ its own
      // order_line_item) all already exist. Only the remaining, booking-independent line items
      // (event, standalone add-ons, products, gift card) are left to insert.
      await insertEventOrderLine()
      for (const line of standaloneAddonLines) {
        const lineTotal = line.unitPrice * line.quantity
        const system = addonSystemPrice(line)
        await paddockData.query(
          `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, addon_id, system_unit_price, price_override_reason, discount_amount)
           VALUES ($1, 'addon', $2, $3, $4, $5, $6, $7, $8)`,
          [orderId, line.quantity, line.unitPrice, lineTotal, line.addonId, system, overrideReasonOrNull(line.unitPrice, system, line), currentPromo()?.addonDiscounts.get(line) ?? 0]
        )
      }
      for (const line of productLines) {
        const lineTotal = line.unitPrice * line.quantity
        const system = productSystemPrice(line)
        await paddockData.query(
          `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, product_variant_id, fulfillment_status, system_unit_price, price_override_reason, discount_amount)
           VALUES ($1, 'product', $2, $3, $4, $5, 'pending', $6, $7, $8)`,
          [orderId, line.quantity, line.unitPrice, lineTotal, line.productVariantId, system, overrideReasonOrNull(line.unitPrice, system, line), currentPromo()?.productDiscounts.get(line) ?? 0]
        )
        // Audit entry for the stock this sale already claimed earlier — staff_id NULL marks it
        // as system-generated. Rolled back alongside everything else if a later step fails.
        const saleAdjustmentId = await insertStockAdjustment({
          variantId: line.productVariantId,
          changeAmount: -line.quantity,
          reason: `Sale (Order #${orderId})`,
          staffId: null,
        })
        // Recorded on the reader snapshot so a later rollback can delete the exact audit rows.
        readerStockAdjustmentIds.push(saleAdjustmentId)
        rollbacks.push(async () => {
          await deleteStockAdjustment(saleAdjustmentId)
        })
      }
      if (giftCardId) {
        await paddockData.query(
          `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, gift_card_id)
           VALUES ($1, 'gift_card', 1, $2, $3, $4)`,
          [orderId, resolvedGiftCardAmount, resolvedGiftCardAmount, giftCardId]
        )
      }
      // The order was inserted with a 0 placeholder total (booking price wasn't known yet at
      // that point) — now that everything is known, correct it (plus the promo code/discount).
      await paddockData.query(
        `UPDATE orders SET order_total = $1, promo_code = $2, discount_amount = $3, updated_at = now() WHERE id = $4`,
        [orderTotal, currentPromo()?.promoCode ?? null, currentPromo()?.totalDiscount ?? 0, orderId]
      )
    }

    // Postage line — added for every shipping basket (even £0 for free Standard) so the postage
    // method and amount are visible on the Orders page and refundable via the same line-item
    // refund path.
    if (needsShipping && postageAmount >= 0) {
      await paddockData.query(
        `INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total)
         VALUES ($1, 'postage', 1, $2, $3)`,
        [orderId, postageAmount, postageAmount]
      )
    }

    // Attached add-ons go into addon_order_lines (booking_id is NOT NULL on that table — it exists
    // solely to represent add-ons tied to a specific booking), snapshotting price/SKU at purchase.
    if (bookingId) {
      const createdAddonOrderLineIds: string[] = []
      for (const line of attachedAddons) {
        const addon = addonLookups.get(line.addonId)!
        const result = await paddockData.query<{ id: string }>(
          `INSERT INTO addon_order_lines (booking_id, addon_id, quantity, price_at_purchase, sku_at_purchase, redemption_source, redeemed_membership_id, order_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            bookingId,
            line.addonId,
            line.quantity,
            line.unitPrice,
            addon.sku ?? addon.id,
            line.redemptionSource ?? 'paid',
            line.redemptionSource === 'membership_credit' ? line.membershipId : null,
            // The order that paid for the line (refunds go back against it).
            orderId ?? null,
          ]
        )
        createdAddonOrderLineIds.push(result.data[0]!.id)
      }
      if (createdAddonOrderLineIds.length > 0) {
        rollbacks.push(async () => {
          await paddockData.query(`DELETE FROM addon_order_lines WHERE id = ANY($1::uuid[])`, [createdAddonOrderLineIds])
        })
      }
    }
  } catch (err) {
    await rollbackAll()
    const message = err instanceof Error ? err.message : String(err)
    return membershipAwareFailure({ success: false, stage: 'validation', reason: 'unexpected_error', message })
  }

  // --- New reader flow: the order is PENDING, the PaymentIntent is created with
  // metadata.order_id, and the frontend collects on the reader then calls finaliseReaderOrder.
  // Everything the later finalise/cancel needs travels in orders.reader_payment (see
  // shared/readerOrderRollback.ts for how it is replayed).
  if (readerNewMode) {
    if (amountToCharge <= 0.005) {
      await rollbackAll()
      return {
        success: false,
        stage: 'payment',
        reason: 'reader_nothing_to_charge',
        // Without a membership the screen only sends the reader with something left to pay, so
        // here the amount has changed.
        message: membershipPlan
          ? 'Nothing is left for the card reader to charge (the basket is fully covered by credit — and a membership still needs a saved card for its renewals, so use the saved-card flow). Remove the credit parts or use a different payment method.'
          : AMOUNT_CHANGED_MESSAGE,
        amountDueTotal,
      }
    }
    // Claim the reversible payment parts (store credit / gift card) BEFORE creating the
    // PaymentIntent — the pending order must already hold the claims, exactly like the other
    // paths (rollbackReaderOrder reverses them from the order's 'redemption' rows and the
    // snapshot). Membership baskets already claimed above; the guard makes the repeat call a
    // no-op. A failed claim (e.g. store credit spent elsewhere meanwhile) rolls everything back.
    const readerClaimFailure = await claimStoreCreditAndGiftCard()
    if (readerClaimFailure) {
      await rollbackAll()
      return membershipAwareFailure(readerClaimFailure)
    }
    const readerPayment: ReaderPaymentSnapshot = {
      flow: 'checkout',
      expected_amount: amountToCharge,
      save_card: payment.readerSaveCard === true,
      save_address_to_customer: saveShippingAddressToCustomer === true && needsShipping === true,
      ...(membershipPlan && membershipPlanId && membershipBillingFrequency
        ? {
            membership: {
              plan_id: membershipPlanId,
              plan_name: membershipPlan.name,
              billing_frequency: membershipBillingFrequency,
              ...(req.params.membershipIdempotencyKey ? { idempotency_key: req.params.membershipIdempotencyKey } : {}),
              price: membershipPrice,
              first_payment_amount: membershipFirstPaymentDue,
              // Buy-new flow only: the membership row already exists (the booking claimed its
              // session credit) with a NULL Stripe subscription id that finalise patches.
              ...(membershipId ? { membership_row_id: membershipId } : {}),
            },
          }
        : {}),
      ...(exhaustedMembershipStripeSubscriptionId && booking?.cancelExhaustedMembershipId
        ? {
            exhausted_membership_stripe_id: exhaustedMembershipStripeSubscriptionId,
            ...(oldMembershipPreviousState
              ? {
                  exhausted_membership_previous: {
                    subscription_status: oldMembershipPreviousState.subscription_status,
                    addon_credits_remaining: oldMembershipPreviousState.addon_credits_remaining,
                    membership_id: booking.cancelExhaustedMembershipId,
                  },
                }
              : {}),
          }
        : {}),
      ...(redeemedGiftCard ? { gift_card_redemption: { gift_card_id: redeemedGiftCard.id, amount: giftCardRedeemAmount } } : {}),
      stock_adjustment_ids: [...readerStockAdjustmentIds],
      ...(eventBookingId ? { event_booking_id: eventBookingId } : {}),
      created_at: new Date().toISOString(),
    }
    try {
      const intent = await createTerminalPaymentIntent({
        params: {
          customerId,
          amount: amountToCharge,
          saveCard: payment.readerSaveCard === true,
          metadata: { order_id: orderId!, flow: 'checkout' },
          description: `Paddock order ${orderId}`,
        },
      })
      const snapshot: ReaderPaymentSnapshot = { ...readerPayment, payment_intent_id: intent.paymentIntentId }
      await paddockData.query(`UPDATE orders SET reader_payment = $1::jsonb WHERE id = $2`, [
        JSON.stringify(snapshot),
        orderId,
      ])
      return {
        success: true,
        orderId: orderId!,
        cardCharged: false,
        paymentMethodUsed: 'reader',
        pendingReaderPayment: {
          orderId: orderId!,
          paymentIntentId: intent.paymentIntentId,
          clientSecret: intent.clientSecret,
          amount: amountToCharge,
        },
      }
    } catch (err) {
      // Nothing has been charged yet — roll back exactly like a saved-card charge failure.
      await rollbackAll()
      const rawMessage = err instanceof Error ? err.message : String(err)
      const message = isHtmlErrorPage({ message: rawMessage })
        ? 'The payment-intent endpoint returned an HTML page instead of a JSON response — no card was charged, and everything created for this order has been rolled back.'
        : extractApiErrorMessage(err, 'Failed to create the card reader payment')
      return membershipAwareFailure({ success: false, stage: 'payment', reason: 'reader_intent_failed', message })
    }
  }

  // Claim the reversible payment parts for the saved-card / cash paths too — the charge is net
  // of store credit / gift card, so the claims must be recorded against the order before money
  // moves. Membership baskets already claimed above; the guard makes the repeat call a no-op.
  const preChargeClaimFailure = await claimStoreCreditAndGiftCard()
  if (preChargeClaimFailure) {
    await rollbackAll()
    return membershipAwareFailure(preChargeClaimFailure)
  }

  // Cancelling the exhausted membership's real Stripe subscription (if requested) is the first of
  // two irreversible external actions, run only now that every local write above has succeeded
  // and is still fully reversible. If this fails, nothing irreversible has happened yet, so a
  // plain rollback is correct. If it succeeds but the charge below then fails, the local rows are
  // still rolled back as usual (they're just Postgres writes) — but the cancellation itself
  // cannot be undone, so that failure is surfaced as a `warning` instead of pretending nothing
  // happened. In the new reader flow this moves to finaliseReaderOrder (the reader tap may still
  // be cancelled, so nothing irreversible may happen yet).
  if (!readerNewMode && booking?.cancelExhaustedMembershipId && exhaustedMembershipStripeSubscriptionId) {
    const cancelResult = await cancelMembershipSubscription(exhaustedMembershipStripeSubscriptionId)
    if (cancelResult.attempted && !cancelResult.success) {
      await rollbackAll()
      return membershipAwareFailure({
        success: false,
        stage: 'payment',
        reason: 'membership_cancellation_failed',
        message: cancelResult.message ?? 'Failed to cancel the existing membership subscription.',
      })
    }
    if (cancelResult.attempted) {
      cancelledExhaustedMembership = true
    }
  }

  // Charging the basket's remainder is the point of no return for non-membership items: once a
  // real charge succeeds, those goods/services have been paid for and must not be rolled back
  // just because the step below (flipping the order to 'paid') has trouble — that failure mode
  // is surfaced as a `warning` instead (same idea as refundBooking.ts's own "succeeded but needs
  // a manual check" warning). For a membership basket the subscription creation above already
  // moved money (its own compensation is wired into the rollbacks); everything else — including
  // the order and every order_line_items/customer_memberships/customer_session_passes row — is
  // created above, inside the fully rollback-able block, so this is now the only remaining
  // post-charge step.
  let paymentIntentId: string | undefined
  // The new reader flow returns earlier (pending order + PaymentIntent), so method 'reader'
  // can never reach this point — the saved-card charge below is the only card path left.
  if (payment.method === 'reader') {
    return {
      success: false,
      stage: 'payment',
      reason: 'unexpected_error',
      message: 'Internal error: a reader order reached the charge step without going through the pending-reader flow.',
    }
  } else if (amountToCharge > 0 && payment.method !== 'cash') {
    try {
      const description = `Staff-created order for ${[
        bookingId ? 'booking' : null,
        allAddonLines.length > 0 ? 'add-ons' : null,
        productLines.length > 0 ? 'merchandise' : null,
        membershipPlan && !membershipSubscription ? 'membership' : null,
        passType ? 'session pass' : null,
        giftCard ? 'gift card' : null,
        eventBookingId ? 'event' : null,
      ]
        .filter(Boolean)
        .join(', ')}`
      // skipOrderRecord: true — createOrder creates its own orders row and line items and stores
      // the returned paymentIntentId on it; without this flag the route wrote a second, empty
      // orders row for every saved-card charge. The route returns orderId: null when skipped;
      // nothing here reads it.
      const chargeResult = await chargeSavedCard({ params: { customerId, amount: amountToCharge, description, skipOrderRecord: true } })
      // chargeSavedCard.ts already rejects an HTML response internally before returning — this is
      // a deliberate second, independent check at this call site too. createOrder.ts is the
      // highest-stakes function in the app (it can move real money and grant real bookings,
      // memberships, session passes, and gift cards in the same request), so it must not rely
      // solely on a nested function's guard staying correct forever: if a future change to
      // chargeSavedCard.ts ever weakens that internal check, this still catches it here before
      // the order is marked paid.
      if (isHtmlErrorPage(chargeResult)) {
        throw new Error(
          'The payment endpoint returned an HTML page instead of a JSON response, which means this ' +
            'request never reached a real payments API — no card was charged. Rolling back the ' +
            'booking/membership/session-pass/gift-card records created for this order.'
        )
      }
      if (typeof chargeResult['paymentIntentId'] === 'string') {
        paymentIntentId = chargeResult['paymentIntentId']
      }
    } catch (err) {
      await rollbackAll()
      // Also check the error message itself for a leaked HTML page — belt-and-braces in case a
      // raw (unguarded) error ever surfaces here instead of chargeSavedCard's own cleaned message.
      const rawMessage = err instanceof Error ? err.message : String(err)
      const message = isHtmlErrorPage({ message: rawMessage })
        ? 'The payment endpoint returned an HTML page instead of a JSON response — no card was charged, and everything created for this order has been rolled back.'
        : extractApiErrorMessage(err, 'Failed to charge saved card')
      return membershipAwareFailure({
        success: false,
        stage: 'payment',
        reason: 'charge_failed',
        message,
        ...(cancelledExhaustedMembership
          ? {
              warning:
                "The customer's previous membership subscription was already cancelled with the payment " +
                'processor before this charge failed, and cannot be automatically restored. The customer ' +
                'currently has no active membership — manually reinstate or recreate it, or retry checkout.',
            }
          : {}),
      })
    }
  }

  // Resolve what to record in orders.payment_method: 'split' when the gift card covered part but
  // not all of amountToCharge, 'gift_card' when it covered everything, otherwise whichever method
  // paid the (whole) remainder — and null if nothing was owed at all (e.g. a booking fully covered
  // by an existing credit, with no products/addons/membership/pass/gift-card purchase either).
  // For a membership basket the membership is billed by Stripe (recorded as 'card' — the
  // subscription charged the saved card), so gift card / split outcomes are impossible there.
  // Store-credit amounts are recorded on store_credit_transactions (with this order_id) rather
  // than in orders.payment_method — no new orders column or payment_method value is introduced.
  const giftCardRedeemAmountFinal = redeemedGiftCard ? payment.giftCard!.amount : 0
  const storeCreditRedeemAmountFinal = payment.storeCredit ? payment.storeCredit.amount : 0
  // TS's control flow can't see the assignment inside createSubscriptionForBasket(), so reads of
  // membershipSubscription here narrow to `never` — alias it with its declared type.
  const subscription = membershipSubscription as MembershipSubscriptionSuccess | null
  // The reader flow returned earlier, so TS has narrowed payment.method to 'card' | 'cash' —
  // widen it back for the recording logic below (kept for safety if the flow ever changes).
  const finalMethod = payment.method as 'card' | 'reader' | 'cash' | undefined
  let resolvedPaymentMethod: string | null = null
  if (subscription) {
    resolvedPaymentMethod = amountToCharge > 0 && finalMethod === 'reader' ? 'reader' : 'card'
  } else if (giftCardRedeemAmountFinal > 0 && amountToCharge > 0) {
    resolvedPaymentMethod = 'split'
  } else if (giftCardRedeemAmountFinal > 0) {
    resolvedPaymentMethod = 'gift_card'
  } else if (amountToCharge > 0) {
    resolvedPaymentMethod = finalMethod === 'reader' ? 'reader' : finalMethod === 'cash' ? 'cash' : 'card'
  }

  // The subscription's first-invoice PaymentIntent is the order's recorded payment intent unless
  // a separate remainder charge produced one (reader capture or saved-card charge) — that charge
  // is what refundOrder.ts refunds against, so it takes priority.
  if (!paymentIntentId && subscription) {
    paymentIntentId = subscription.paymentIntentId ?? undefined
  }

  let warning: string | undefined
  try {
    await paddockData.query(
      `UPDATE orders SET payment_status = 'paid', stripe_payment_intent_id = $1, order_total = $2, payment_method = $3, updated_at = now() WHERE id = $4`,
      [
        paymentIntentId ?? null,
        orderTotal,
        resolvedPaymentMethod,
        orderId,
      ]
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warning = `Payment succeeded, but marking the order as paid failed and needs a manual check: ${message}`
  }

  // Save the delivery address onto the customer's profile when staff asked for it — a
  // non-critical bookkeeping step: a failure here appends a warning instead of failing an
  // order that has already been paid.
  if (saveShippingAddressToCustomer && needsShipping && normalizedShippingAddress) {
    try {
      await paddockData.query(
        `UPDATE customers
         SET address_line1 = $1, address_line2 = $2, city = $3, postcode = $4, country = $5, updated_at = now()
         WHERE id = $6`,
        [
          normalizedShippingAddress.line1,
          normalizedShippingAddress.line2,
          normalizedShippingAddress.city,
          normalizedShippingAddress.postcode,
          normalizedShippingAddress.country,
          customerId,
        ]
      )
    } catch (err) {
      warning = `The order completed, but saving the delivery address to the customer's profile failed and needs a manual check: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  return {
    success: true,
    orderId: orderId!,
    ...(bookingId ? { bookingId } : {}),
    ...(eventBookingId ? { eventBookingId } : {}),
    ...(giftCardId ? { giftCardId } : {}),
    ...(giftCardCode ? { giftCardCode } : {}),
    ...(membershipId ? { membershipId } : {}),
    ...(sessionPassId ? { sessionPassId } : {}),
    cardCharged: (amountToCharge > 0 && payment.method !== 'cash') || subscription != null,
    cardAmount: subscription ? subscription.amountPaid + amountToCharge : amountToCharge,
    ...(giftCardRedeemAmountFinal > 0 ? { giftCardRedeemedAmount: giftCardRedeemAmountFinal } : {}),
    ...(storeCreditRedeemAmountFinal > 0 ? { storeCreditRedeemedAmount: storeCreditRedeemAmountFinal } : {}),
    paymentMethodUsed: resolvedPaymentMethod,
    ...(subscription
      ? {
          membershipSubscriptionId: subscription.subscriptionId,
          membershipAmountPaid: subscription.amountPaid,
          ...(subscription.latestInvoiceId ? { membershipInvoiceId: subscription.latestInvoiceId } : {}),
        }
      : {}),
    ...(warning ? { warning } : {}),
  }
}
