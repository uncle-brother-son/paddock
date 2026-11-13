// Moved from frontend/components/CheckoutDialog.tsx (FAILURE_MESSAGES and the refusal branches of
// its submit) and frontend/utils/quoteReadiness.ts (three of its words), so the website and the staff
// app tell people the same thing.
import 'server-only'

/**
 * What staff are told when an order is refused. A refusal carries a reason and, sometimes, the old
 * function's own words for it; the screen put the two together with the words below. staffSees() is
 * that rule, and the error's message is what it gives, so a caller shows it as it is.
 *
 * The map holds every reason the screen had words for, including ones the Worker can't reach yet
 * (memberships, events, gift cards), so later slices find their words here. The test beside it
 * holds the map to the screen's, word for word, until the screen goes at W14.
 */

export const BAND_UNPRICED_MESSAGE =
  "No band covers this session's start time — check the band time windows under Admin → Pricing before booking."
export const PRIVATE_PRICE_NOT_SET_MESSAGE =
  'No private price is set for this group size and band — add one under Catalog → Session Types first.'
export const MEMBERSHIP_PRICE_NOT_SET_MESSAGE =
  'That membership plan does not have a price set for the chosen billing frequency yet.'

/** When nothing else has words for it. Eight createBooking reasons have only this (W03-plan 1.1). */
export const FALLBACK_MESSAGE = 'Failed to complete the order.'

export const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  customer_not_found: 'That customer no longer exists.',
  event_full: 'Not enough places are left on this event (or it has just gone off sale).',
  event_quote_failed: 'The event could not be priced — check its prices in Catalog → Events.',
  empty_order: 'Add at least one item to the order before checking out.',
  shipping_address_required: 'This order includes an item that must be shipped — a complete delivery address is required.',
  postage_method_required: 'This order includes an item that must be shipped — choose a postage option (Standard or Express) in the Delivery address step.',
  postage_settings_missing: 'Postage settings have not been configured yet — set them up on the Pricing page first.',
  price_override_reason_required:
    'A price on this order was changed from the system price — enter a reason for the price change on that line before completing the order.',
  membership_plan_not_found: 'The selected membership plan is no longer available.',
  membership_plan_inactive: 'The selected membership plan is inactive.',
  session_pass_type_not_found: 'The selected session pass type is no longer available.',
  session_pass_type_inactive: 'The selected session pass type is inactive.',
  product_variant_not_found: 'One of the selected products is no longer available.',
  product_inactive: 'One of the selected products is inactive.',
  invalid_product_quantity: 'Product quantities must be at least 1.',
  addon_not_found: 'One of the selected add-ons is no longer available.',
  addon_inactive: 'One of the selected add-ons is inactive.',
  invalid_addon_quantity: 'Add-on quantities must be at least 1.',
  invalid_gift_card_amount: 'Enter a gift card amount greater than £0.',
  gift_card_selection_required: 'Select a gift card preset or a custom-amount gift card type.',
  gift_card_preset_not_found: 'That gift card preset is no longer available.',
  gift_card_preset_inactive: 'That gift card preset is inactive.',
  gift_card_type_not_found: 'That gift card type is no longer available.',
  gift_card_type_inactive: 'That gift card type is inactive.',
  gift_card_custom_amount_not_allowed: 'That gift card type does not allow a custom amount — pick a preset instead.',
  gift_card_amount_out_of_range: 'That amount is outside the allowed range for this gift card type.',
  invalid_gift_card_fulfillment: 'Select a valid gift card fulfillment method.',
  insufficient_stock: 'Not enough stock for one of the selected products.',
  gift_card_creation_failed: 'Failed to create the gift card.',
  gift_card_code_exhausted: 'Failed to generate a unique gift card code — please try again.',
  charge_failed: 'The card charge failed.',
  unexpected_error: 'Something went wrong while processing the order.',
  addon_membership_id_required: 'Select which membership an add-on should draw credit from.',
  addon_membership_not_found: 'The selected membership for an add-on could not be found.',
  insufficient_addon_membership_credit: 'That membership does not have enough add-on credit remaining.',
  addon_membership_too_new: 'That membership is not a Herd member yet, so its add-on credits cannot be used.',
  membership_billing_frequency_required: 'Choose a billing frequency (monthly or yearly) for the membership.',
  membership_plan_price_not_set: MEMBERSHIP_PRICE_NOT_SET_MESSAGE,
  membership_cash_not_accepted: "Memberships are billed by Stripe and cannot be paid in cash. The saved card on file is charged for the membership's renewals (a gift card or store credit can reduce the first payment). Take a card on the reader to save one first if needed.",
  membership_no_saved_card: "This customer has no saved card. A membership always needs one — the card on file is charged for the membership's renewals (a gift card or store credit can reduce the first payment, but the card must be on file) — save a card on the card reader first, then retry checkout.",
  membership_plan_not_synced: 'This membership plan has no Stripe price synced for that billing frequency yet. Sync the plan in Stripe, then retry checkout.',
  membership_price_not_recurring: "The Stripe price for this membership plan isn't a recurring price of the right interval — check the plan's Stripe price setup, then retry checkout.",
  membership_payment_failed: "The customer's card was declined when Stripe tried to take the first membership payment. No money was taken and nothing was recorded — use a different card or retry.",
  membership_discount_exceeds_total: 'The gift card / store credit applied exceeds the membership first payment — reduce the amounts and retry.',
  membership_discount_invalid: 'The discount amount for the membership first payment was invalid — check the gift card / store credit amounts and retry.',
  membership_subscription_failed: 'Failed to create the membership subscription — nothing was recorded.',
  booking_membership_plan_required: 'Select which membership plan to purchase for this booking.',
  private_booking_requires_real_payment: 'Private bookings must always be paid with card, cash, or gift card — they can never use a membership or session pass credit.',
  booking_membership_plan_grants_no_sessions: 'That membership plan does not grant any session credit, so it cannot cover a booking.',
  booking_session_pass_type_required: 'Select which session pass type to purchase for this booking.',
  booking_session_pass_type_grants_no_sessions: 'That session pass type does not grant any sessions, so it cannot cover a booking.',
  booking_session_pass_type_not_valid_for_band: "A Core pass can't be used for a Peak session. Choose an All-Access pass or another way to pay.",
  session_pass_not_valid_for_band: "This is a Core pass, which can't be used for Peak sessions. Choose another way to pay.",
  no_pricing_permission: 'Needs the Manage pricing permission.',
  cancel_membership_requires_buy_new_membership: 'Cancelling an existing membership only applies when buying a new one.',
  exhausted_membership_not_found: "The membership to cancel could not be found on this customer's account.",
  exhausted_membership_not_active: 'That membership is not currently active.',
  exhausted_membership_still_has_credit: 'That membership still has credit remaining, so it cannot be cancelled this way.',
  membership_cancellation_failed: 'Failed to cancel the customer\'s existing membership subscription.',
  invalid_payment_method: 'Select a valid payment method.',
  gift_card_amount_invalid: 'Enter a gift card amount greater than £0.',
  gift_card_not_found: 'That gift card could not be found.',
  gift_card_voided: 'That gift card has been voided.',
  gift_card_expired: 'That gift card has expired.',
  gift_card_insufficient_or_invalid: 'That gift card no longer has enough balance remaining.',
  gift_card_amount_exceeds_total: 'The gift card amount cannot exceed the amount due.',
  store_credit_amount_invalid: 'Enter a store credit amount greater than £0.',
  store_credit_insufficient: 'The customer no longer has enough store credit remaining.',
  store_credit_amount_exceeds_total: 'The gift card + store credit amounts cannot exceed the amount due.',
  store_credit_failed: 'Applying the store credit failed — no payment was taken.',
  payment_method_required: 'Select how to pay the remaining amount.',
  reader_charge_amount_mismatch: 'The reader-charged amount no longer matches what this order owes — the card has already been charged; refund it manually if needed, then retry checkout.',
  session_not_found: 'That session no longer exists — it may have been removed. Pick a different session type.',
  session_blocked: 'That slot is currently blocked by staff and cannot be booked. Pick a different session type.',
  session_already_started: 'This session has already started.',
  duplicate_day_booking: 'This customer already has a booking on that day. Only one booking per customer per day is allowed.',
  band_unpriced: BAND_UNPRICED_MESSAGE,
  time_conflict: 'That slot conflicts with another booking at an overlapping time — the venue only allows one session type to be booked at a time. Pick a different session type.',
  insufficient_capacity: 'That slot no longer has room for this many guests — it may have just been booked or is already full. Pick a different session type or reduce the guest count.',
  price_pending: 'No price is configured for this session type at this guest count yet — check its pricing in the catalog before booking.',
  private_price_not_set: PRIVATE_PRICE_NOT_SET_MESSAGE,
  no_guests: 'Add at least one guest.',
  too_many_guests: 'Too many guests for this session type — reduce the guest count.',
  guest_name_required: 'Enter a name for every guest.',
  guest_dob_required: "Enter the account holder's date of birth.",
  guest_dob_invalid: "The account holder's date of birth is invalid.",
  guests_over_18_not_confirmed: 'Confirm that everyone else in the booking is 18 or over.',
  guest_under_18: 'Every guest must be at least 18 years old.',
}

/*
 * Words the screen has no entry for yet (W10). Each travels as its refusal's own message, which the
 * screen shows first, so FAILURE_MESSAGES stays the screen's, word for word, until W14 moves them.
 */

/** W03-decisions Q10, word for word: a card order while the customer has one still being processed. */
export const ORDER_STILL_PROCESSING_MESSAGE = 'This customer has an order still being processed. Check the Orders page before trying again.'

/** The old charge route's words when the customer has no saved card (charge-saved-card/core.ts). */
export const NO_SAVED_CARD_MESSAGE = 'Customer has no saved payment method on file.'

/** PAYMENT_UNCONFIRMED: Stripe gave no clear answer twice, so the card may or may not have been charged. */
export const PAYMENT_UNCONFIRMED_MESSAGE =
  "The card payment didn't get a clear answer, so it may or may not have been taken. The order is on hold: don't take payment again. Check the Orders page in a few minutes."

/** PAYMENT_UNCONFIRMED after the card was charged, when the order couldn't be marked paid. */
export const PAID_NOT_FINISHED_MESSAGE =
  "The card was charged, but the order couldn't be finished. It's on hold: don't take payment again. Check the Orders page in a few minutes."

/** PAYMENT_UNCONFIRMED when the card was charged for an order that had already been undone. */
export const CHARGED_WITHOUT_ORDER_MESSAGE =
  "The card was charged, but the order had already been cancelled, so the charge needs refunding. Don't take payment again: check the Orders page."

/*
 * W11: words for the reader that the old code had none for (the Worker holds or refuses where the old
 * code refunded or rolled back). Each travels as its answer's own message.
 */

/**
 * PAYMENT_UNCONFIRMED on the reader: Stripe gave no clear answer when asked for the reader's intent (or
 * it couldn't be written onto the order). No secret reached the screen, so no tap can have taken money.
 */
export const READER_INTENT_UNCONFIRMED_MESSAGE =
  "The card reader payment couldn't be started: Stripe gave no clear answer. Nothing has been taken, but the order is on hold while it's checked: don't take payment for it again. Check the Orders page in a few minutes."

/** Finalise: the tap took the money, but the order couldn't be marked paid (a database fault). Held, never refunded (W6-3). */
export const READER_PAID_NOT_FINISHED_MESSAGE =
  "The reader payment went through, but the order couldn't be finished. It's on hold: don't take payment again. Check the Orders page in a few minutes."

/** Finalise: the tap took the money for an order that had already been undone. */
export const READER_CHARGED_WITHOUT_ORDER_MESSAGE =
  "The reader took the payment, but the order had already been cancelled, so the payment needs refunding. Don't take payment again: check the Orders page."

/** Finalise: the intent belongs to another Stripe customer (the old code didn't check; W03-plan 2.7). */
export const readerCustomerMismatchMessage = (paymentIntentId: string): string =>
  `This PaymentIntent was made for a different Stripe customer — do NOT finalise automatically. Check the PaymentIntent (${paymentIntentId}) in Stripe before doing anything.`

/**
 * Cancel: the old rollback has started on it, and may have given things back already. W25 (W16 review 3): nothing
 * finishes an old rollback any more (Resolve now is the Worker's reconcile, which leaves it for a person), so the
 * words send staff to a manager, as the stuck list's do (OLD_ROLLBACK_WORDS).
 */
export const OLD_ROLLBACK_STARTED_MESSAGE =
  "The old checkout had started cancelling this order and couldn't finish, so it can't be cancelled here. Nothing more will be changed automatically: don't take payment again, and tell a manager."

/*
 * W12: words for reconcile, the reader flows and the stuck list (new; adjustable at W14).
 */

/** The undo refused: old code changed the booking or event booking after T1 (W10 review L1). Left for a person. */
export const CHANGED_SINCE_MESSAGE =
  "This order's booking was changed after the order was started (cancelled, moved, or guests added or removed), so it wasn't cancelled automatically and nothing was given back. No payment was taken for it. Check the booking on the Bookings page (it stays as it is now), then press Close order on the Orders page to give back what the order still holds (needs the Issue refunds permission)."

/*
 * W13: words for memberships. The old route's where it had them (create-subscription/core.ts, through
 * shared/createMembershipSubscription.ts); the rest are new (adjustable at W14).
 */

/** The old route's words when the plan's Stripe price couldn't be read (its 500, `unexpected`). */
export const PRICE_NOT_VERIFIED_MESSAGE = 'Failed to verify Stripe price'
/** The old route's words when the card couldn't be made the Stripe customer's default. */
export const DEFAULT_CARD_FAILED_MESSAGE = 'Failed to set default payment method'
/** The old route's words when the first-invoice coupon couldn't be made. */
export const COUPON_FAILED_MESSAGE = 'Failed to apply the discount'

/** The old route's words when a membership's customer has no Stripe customer or card (its `no_saved_card`). */
export const MEMBERSHIP_NO_CARD_MESSAGE =
  'This customer has no saved card. A membership is charged by Stripe, so take a card on the reader to save it first, then retry checkout.'

/** New: Stripe refused the club's key (401/403) on a membership step: nothing was taken (W10a's reasoning). */
export const MEMBERSHIP_STRIPE_REFUSED_MESSAGE =
  "The membership wasn't set up: Stripe turned down the club's payment account details, so nothing was taken and the order wasn't placed. Tell a manager so the Stripe connection can be fixed."

/** New: the plan's Stripe price is archived. */
export const membershipPriceInactiveMessage = (planName: string): string =>
  `The ${planName} membership's price in Stripe has been archived, so no subscription can be started on it. Nothing was taken. Check the plan's Stripe price, then retry checkout.`

/** New (W03-plan 2.7): Stripe's price isn't the plan's price, which the old route charged silently. */
export const membershipPriceMismatchMessage = (stripePence: number, ourPounds: number): string =>
  `The membership's price in Stripe is £${(stripePence / 100).toFixed(2)}, but the plan charges £${ourPounds.toFixed(2)}, so nothing was taken. Sync the plan's price in Stripe, then retry checkout.`

/** New: PAYMENT_UNCONFIRMED when Stripe gave no clear answer about the membership's subscription. */
export const MEMBERSHIP_UNCONFIRMED_MESSAGE =
  "The membership's subscription didn't get a clear answer from Stripe, so it may or may not have started. The order is on hold: don't take payment again. Check the Orders page in a few minutes."

/** New: PAYMENT_UNCONFIRMED when everything is paid but cancelling the old membership (Q8) got no clear answer. */
export const REPLACED_UNCONFIRMED_MESSAGE =
  "The new membership is paid for, but cancelling the customer's old membership in Stripe didn't get a clear answer. The order is on hold until it's checked: don't take payment again. Check the Orders page in a few minutes."

/** New: a definite failure after money was taken, whose reversal couldn't be confirmed yet. Held for reconcile. */
export const COMPENSATION_HELD_MESSAGE =
  "The membership couldn't be set up, and putting back what was taken hasn't been confirmed yet. The order is on hold and the automatic check will finish it: don't take payment again. Check the Orders page in a few minutes."

/** New: Stripe made a subscription that isn't what the order asked for (another price or amount, say). */
export const subscriptionWrongMessage = (detail: string): string =>
  `Stripe started the membership's subscription differently from the order (${detail}), so it was cancelled and its payment refunded.`

/**
 * New (W13a, B1): a reader membership's tap is to be refunded, but another finalise of the same order is starting
 * its subscription right now, so nothing was changed. Held; reconcile settles it.
 */
export const SUBSCRIPTION_STARTING_MESSAGE =
  "Another finalise of this order is setting up the membership right now, so nothing was changed here. Don't take payment again: check the Orders page in a few minutes."

/**
 * New (W13a, L1): added when a membership order is refused and put back after the customer's previous (exhausted)
 * membership had already been cancelled in Stripe (Q8): they now have neither.
 */
export const OLD_MEMBERSHIP_CANCELLED_NOTE =
  "The customer's previous membership had already been cancelled in Stripe, so they now have no membership: check their memberships before selling one again."

/** finaliseReaderOrder's ending once the tap was refunded and the order rolled back. */
export const readerRefundedMessage = (staffMessage: string, paymentIntentId: string): string =>
  `${staffMessage} The customer's card has been refunded in full (payment ${paymentIntentId}) and the order was rolled back.`

/** The words for the Herd gate, which name the waiting period from membership_settings. */
export function herdWaitMessage(addonCreditWaitMonths: number): string {
  return `That membership is not a Herd member yet — add-on credits unlock for Herd members (monthly members after ${addonCreditWaitMonths} month${addonCreditWaitMonths === 1 ? '' : 's'}, yearly members straight away).`
}

export interface RefusalWords {
  reason: string
  /** The old function's own words, when it had any. */
  message?: string | undefined
  /** Set on every refusal over the amount. */
  amountDueTotal?: number | undefined
}

/**
 * What the screen showed for a refusal, in its order:
 *   1. a changed cash figure: the refusal's own words, on the cash banner;
 *   2. any other refusal over the amount: the map's words, then the function's;
 *   3. the Herd gate: the words that name the waiting period, when the setting can be read;
 *   4. otherwise the function's words, else the map's, else the fallback.
 */
export function staffSees(refusal: RefusalWords, settings: { addonCreditWaitMonths?: number | null } = {}): string {
  const { reason, message, amountDueTotal } = refusal
  if (reason === 'cash_amount_changed' && amountDueTotal !== undefined) return message ?? ''
  if (amountDueTotal !== undefined) return [FAILURE_MESSAGES[reason], message].filter(Boolean).join(' ')
  const months = settings.addonCreditWaitMonths
  if (reason === 'addon_membership_too_new' && typeof months === 'number') return herdWaitMessage(months)
  return (message ? message : FAILURE_MESSAGES[reason]) ?? FALLBACK_MESSAGE
}
