// New in W36 (F-plan 4.1, brief W36 item 1): every word staff see from a gift card action, moved here word for word
// from the staff app's functions (extendGiftCardExpiry, setGiftCardPickedUp, setGiftCardShipped) and the screens that
// show them (ExtendGiftCardDialog, the Gift Cards page, the order's line items), ahead of the slice that uses them
// (W38). Nothing uses them yet. The test beside this file holds each to its source (the frozen copy, legacy-account/,
// and the screens) until the old code goes. Most of these reasons have no words in the function: the screen has them.
import 'server-only'

export { INACTIVE_STAFF_MESSAGE } from '@/server/rules/bookings/failure-messages'

// --- Extend and reactivate (extendGiftCardExpiry.ts, ExtendGiftCardDialog)

/** extendGiftCardExpiry's reasons, as its result's `reason`. The test holds this list to the old function's own. */
export const GIFT_CARD_EXTEND_REASONS = ['gift_card_not_found', 'invalid_months', 'permission_denied'] as const
export type GiftCardExtendReason = (typeof GIFT_CARD_EXTEND_REASONS)[number]

export const GIFT_CARD_EXTEND_WORDS = {
  /** The function's only words. */
  permissionDenied: 'Needs the Issue refunds permission to extend or re-activate a gift card.',
  /** The dialog's, for `invalid_months` (and before the press). */
  monthsInvalid: 'Enter a whole number of months greater than 0.',
  /** The dialog's, when `permission_denied` carries no words. */
  permissionFallback: 'Needs the Issue refunds permission.',
  /** The dialog's, for any other refusal (`gift_card_not_found` among them) and a throw. */
  failed: 'Failed to extend gift card.',
} as const

// --- Picked up and shipped (setGiftCardPickedUp.ts, setGiftCardShipped.ts, the Gift Cards page, the order's line items)

/** The two functions' reasons, as their results' `reason`. */
export const GIFT_CARD_PICKED_UP_REASONS = ['not_found', 'not_pickup_fulfillment'] as const
export const GIFT_CARD_SHIPPED_REASONS = ['not_found', 'not_shipping_fulfillment'] as const

export const GIFT_CARD_FLAG_WORDS = {
  /** The functions' own, when the card can't be read back after the change. */
  notReadBack: 'The gift card was updated but could not be read back.',
  /** The Gift Cards page's. */
  notPickup: 'This gift card is not a pickup-fulfillment card',
  pickupFailed: 'Failed to update pickup status',
  notShipping: 'This gift card is not a shipping-fulfillment card',
  shippingFailed: 'Failed to update shipping status',
} as const

/** A flag needs a staff member to record (shared/resolveStaffId.ts, requireStaffId): the same words as the Worker's staff check. */
export const noStaffRecordMessage = (email: string): string =>
  `No staff record matches the logged-in user's email (${email}). Ask an admin to add you as staff before performing this action.`
