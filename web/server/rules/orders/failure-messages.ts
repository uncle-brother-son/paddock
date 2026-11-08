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
