// New in W17 (D-plan 4.8): every word staff see from a booking change, moved here ahead of the slices that use them
// (W18 to W24), so the website and the staff app tell people the same thing. Unused yet. Three sources:
// - the screens' reason maps, word for word: frontend/components/MoveBookingDialog.tsx, SettleLapsedPaymentDialog.tsx,
//   AddGuestDialog.tsx and RemoveGuestDialog.tsx (their FAILURE_MESSAGES / REASON_MESSAGES), and the dialogs' own
//   "Failed to ..." words for when nothing else has any;
// - the old functions' own words, word for word (the frozen copy in server/rules/testing/legacy-booking): what they
//   sent as `message`, which the screens show before their own;
// - the words W17 adds: the switch, Wayne's Q35 and Q37 answers (12 Nov), and a held card flow.
// failure-messages.test.ts holds the first two to their sources.
import 'server-only'

// --- What staff see: the old function's words when it sent some, else the screen's for the reason, else the screen's
// fallback. Every dialog did exactly this (MoveBookingDialog, SettleLapsedPaymentDialog, AddGuestDialog's refusalText,
// RemoveGuestDialog's refusalText); Add Guest and Remove Guest show the bare reason when they have no words for it.

/** MoveBookingDialog.tsx's FAILURE_MESSAGES. */
export const MOVE_REASON_WORDS: Readonly<Record<string, string>> = {
  booking_not_found: 'This booking no longer exists.',
  booking_not_movable: 'This booking is cancelled or completed and can no longer be moved.',
  reader_payment_open: 'A card reader payment is still open on this booking. Finish or cancel it first.',
  booking_changed: 'The booking changed while it was being moved, so it was not moved and any payment was put back. Check it and try again.',
  same_session: 'Pick a different session than the one this booking is already on.',
  session_not_found: 'That session no longer exists. Please pick another.',
  session_blocked: 'This slot has been blocked since you loaded it. Please pick another.',
  session_already_started: 'This session has already started.',
  time_conflict: 'This time is already committed to another session type (e.g. a private booking). Please pick another slot.',
  insufficient_capacity: "Not enough capacity left in this slot for this booking's party size.",
  band_unpriced: "No band covers the new session's start time — check the band time windows under Admin → Pricing.",
  private_price_not_set: 'No private price is set for this group size and band — add one under Catalog → Session Types first.',
  payment_method_required: 'Select how to pay the difference.',
  cash_amount_changed: 'The amount due has changed. Check it with the customer and confirm again.',
  gift_card_amount_exceeds_total: 'The gift card amount cannot exceed the amount due.',
  store_credit_amount_exceeds_total: 'The gift card + store credit amounts cannot exceed the amount due.',
  store_credit_insufficient_or_invalid: 'The customer no longer has enough store credit remaining.',
  refund_method_required: 'Choose how to refund the difference (original card or store credit).',
  gift_card_insufficient_or_invalid: 'That gift card no longer has enough balance remaining.',
  no_refund_permission: 'Needs Issue refunds permission — this move refunds money back to the customer. Ask a manager to process it.',
  card_charge_failed: 'The saved-card charge failed — nothing was moved and nothing was charged.',
  card_charge_in_progress: 'A payment for this booking is still being taken. Wait a minute, then reload.',
  already_moved: 'This booking was already moved with the same payment, so it was only taken once. Reload the booking.',
  move_failed_refund_failed: 'The move failed after money was taken and a reversal step failed — check store credit / gift card / card manually.',
  move_failed: 'The move failed after money was taken and every payment part was reversed — retry the move.',
  move_failed_restore_failed:
    'The move failed and the booking could not be put back automatically — check this booking and both sessions by hand (which session it is on, its seat prices and credits, and that each session counts it correctly).',
  promo_discounted_booking: 'This booking was paid with a promo code. Cancel it and make a new booking instead.',
  booking_type_mismatch:
    'A public booking can only move to a public session, and a private booking to a private session. To change type, cancel and rebook.',
}

/** SettleLapsedPaymentDialog.tsx's FAILURE_MESSAGES. */
export const SETTLE_REASON_WORDS: Readonly<Record<string, string>> = {
  booking_not_found: 'This booking no longer exists.',
  booking_not_payment_needed: 'This booking is no longer awaiting payment — refresh and check its status.',
  seat_price_missing: "Seat 1 has no stored price on this booking, so the amount due can't be determined. Resolve it manually.",
  payment_method_required: 'Select how to take the payment.',
  cash_amount_changed: 'The amount due has changed. Check it with the customer and confirm again.',
  gift_card_amount_exceeds_total: 'The gift card amount cannot exceed the amount due.',
  store_credit_amount_exceeds_total: 'The gift card + store credit amounts cannot exceed the amount due.',
  store_credit_insufficient_or_invalid: 'The customer no longer has enough store credit remaining. Nothing was taken.',
  store_credit_failed: 'Applying the store credit failed — nothing was taken.',
  gift_card_insufficient_or_invalid: 'That gift card no longer has enough balance remaining. Nothing was taken.',
  settle_undo_failed: 'Creating the card reader payment failed — the booking was restored to awaiting payment and nothing was charged.',
  reader_payment_open: 'A card reader payment is still open on this booking.',
  card_charge_in_progress: 'A payment for this booking is still being taken. Wait a minute, then reload.',
  settle_failed: "Recording the payment failed. Check the booking and the customer's money before trying again.",
}

/** AddGuestDialog.tsx's REASON_MESSAGES. */
export const ADD_GUEST_REASON_WORDS: Readonly<Record<string, string>> = {
  booking_not_found: 'This booking no longer exists.',
  booking_cancelled: 'This booking has been cancelled and can no longer take guests.',
  session_already_started: 'This session has already started.',
  price_pending: "This booking's headcount tier has no confirmed price yet — set one before adding more guests.",
  private_price_not_set: 'No private price is set for this group size and band — add one under Catalog → Session Types first.',
  guests_over_18_not_confirmed: 'Confirm that this guest is 18 or over.',
  credit_not_available_for_guests: 'Guests are always paid — credit can only ever cover the account-holder seat.',
  gift_card_amount_exceeds_total: 'The gift card amount cannot exceed the amount due.',
  store_credit_amount_exceeds_total: 'The gift card + store credit amounts cannot exceed the amount due.',
  store_credit_insufficient_or_invalid: 'The customer no longer has enough store credit remaining.',
  store_credit_failed: 'Applying the store credit failed — nothing was taken.',
  gift_card_insufficient_or_invalid: 'That gift card no longer has enough balance remaining.',
  payment_method_required: 'Select how to pay the seat price.',
  invalid_payment_method: 'Select a valid payment method.',
  reader_charge_amount_mismatch: 'The reader-charged amount no longer matches what is owed — refund it manually if needed, then retry.',
  insufficient_capacity: 'This session is now full — there is no room for another guest.',
  invalid_addon_quantity: 'Each add-on needs a quantity of at least 1.',
  invalid_addon_price: "An add-on price can't be negative.",
  addon_not_found: 'One of the add-ons no longer exists.',
  addon_inactive: 'One of the add-ons is no longer on sale.',
  addon_membership_id_required: 'Choose which membership an add-on credit comes from.',
  addon_membership_not_found: "That membership isn't active on this customer's account.",
  addon_membership_too_new: "That membership isn't a Herd member yet, so its add-on credits can't be used.",
  insufficient_addon_membership_credit: "That membership doesn't have enough add-on credits left.",
  price_override_reason_required: 'An add-on price was changed — enter a reason for the change.',
}

/** AddGuestDialog.tsx's ADDONS_PAYMENT_MESSAGE. */
export const ADDONS_PAYMENT_MESSAGE = 'Select how to pay for the add-ons.'

/** AddGuestDialog.tsx's ADDONS_REASON_MESSAGES: add-ons on their own (no guest, no seat). */
export const ADD_ADDONS_REASON_WORDS: Readonly<Record<string, string>> = {
  ...ADD_GUEST_REASON_WORDS,
  booking_cancelled: 'This booking has been cancelled and can no longer take add-ons.',
  payment_method_required: ADDONS_PAYMENT_MESSAGE,
}

/** RemoveGuestDialog.tsx's REASON_MESSAGES. */
export const REMOVE_GUEST_REASON_WORDS: Readonly<Record<string, string>> = {
  booking_not_found: 'This booking no longer exists.',
  booking_cancelled: 'This booking has been cancelled, so guests can no longer be removed.',
  guest_not_found: 'This guest has already been removed.',
  no_refund_permission: "Needs Issue refunds permission — this seat's refund cannot be issued without it.",
  refund_method_required: 'Choose how to refund the difference (original card or store credit).',
}

/** RemoveGuestDialog.tsx's RETRY_LOCKED_MESSAGE: shown once pressing Remove again would refund a second time. */
export const RETRY_LOCKED_MESSAGE = 'Check the booking first. Close this and reopen it to try again.'

/** Each dialog's words when nothing else has any (its "Failed to ..."). */
export const FALLBACK_WORDS = {
  move: 'Failed to move booking.',
  settle: 'Failed to take the payment.',
  add_guest: 'Failed to add guest.',
  add_addons: 'Failed to add the add-ons.',
  remove_guest: 'Failed to remove guest.',
  remove_guest_quote: 'Failed to quote this removal.',
  part_refund: 'Failed to process the part refund.',
  refund_owed: 'Failed to process the refund.',
  cancel_and_refund: 'Failed to process refund.',
  cancel_credit: 'Failed to cancel the booking.',
  cancel_payment_needed: 'Failed to cancel the booking.',
  remove_addon: 'Failed to remove the add-on.',
  special_requests: 'Failed to save special requests.',
} as const

/** BookingDetailContent.tsx's words when saving special requests on a cancelled booking. */
export const SPECIAL_REQUESTS_CANCELLED_WORDS = 'Cancelled bookings cannot be edited.'

export type BookingAction = keyof typeof FALLBACK_WORDS

const REASON_WORDS: Partial<Record<BookingAction, Readonly<Record<string, string>>>> = {
  move: MOVE_REASON_WORDS,
  settle: SETTLE_REASON_WORDS,
  add_guest: ADD_GUEST_REASON_WORDS,
  add_addons: ADD_ADDONS_REASON_WORDS,
  remove_guest: REMOVE_GUEST_REASON_WORDS,
  special_requests: { booking_cancelled: SPECIAL_REQUESTS_CANCELLED_WORDS },
}

/** Add Guest and Remove Guest showed the bare reason when they had no words for it; the others their fallback. */
const SHOWS_BARE_REASON = new Set<BookingAction>(['add_guest', 'add_addons', 'remove_guest'])

/** What staff see for a refusal: the old function's words when it sent some, else the screen's (D-plan 4.8). */
export function staffSees(action: BookingAction, reason: string | undefined, message?: string): string {
  if (message) return message
  const words = reason ? REASON_WORDS[action]?.[reason] : undefined
  if (words) return words
  if (reason && SHOWS_BARE_REASON.has(action)) return reason
  return FALLBACK_WORDS[action]
}

// --- The old functions' own words (each sent as `message`), word for word

/** shared/readerPaymentOpen.ts: any open flow or order being paid on the booking. */
export const READER_PAYMENT_OPEN_MESSAGE =
  'A card reader payment is still open on this booking. Finish or cancel it first, or use Resolve now on the Orders page after 15 minutes.'
/** shared/bookingCardCharge.ts. */
export const CARD_CHARGE_IN_PROGRESS_MESSAGE = 'A payment for this booking is still being taken. Wait a minute, then reload.'
export const CARD_CHARGE_ANSWER_LOST_MESSAGE = "The card charge's answer was lost, so it may have gone through. Check Stripe. Pressing again won't charge twice."
/** shared/cashConfirmation.ts (Q11). */
export const AMOUNT_CHANGED_MESSAGE = 'The amount due has changed. Check it with the customer and confirm again.'
export const NOTHING_LEFT_IN_CASH_MESSAGE = "The amount due has changed. There's nothing left to collect in cash. Check it with the customer and confirm again."
export const amountChangedToMessage = (amount: number): string => `The amount due has changed to £${amount.toFixed(2)}. Check it with the customer and confirm again.`
/** shared/staffAccess.ts. */
export const INACTIVE_STAFF_MESSAGE = 'This staff account is inactive. Ask an admin to reactivate it.'
export const ISSUE_REFUNDS_NEEDED_MESSAGE = 'Needs Issue refunds permission — this action moves money back to the customer.'
/** shared/bookingRefund.ts and cancelCreditBooking.ts: the 24-hour rule. */
export const WITHIN_24_HOURS_MESSAGE = 'Not eligible for refund or credit — within 24 hours of session start.'
export const REFUND_UNSURE_MESSAGE = 'This may have gone through. Check Stripe or their balance, then use It already arrived or Refund the rest.'

/** moveBooking.ts. */
export const MOVE_WORDS = {
  promoDiscounted: 'This booking was paid with a promo code. Cancel it and make a new booking instead.',
  typeMismatch: 'A public booking can only move to a public session, and a private booking to a private session. To change type, cancel and rebook.',
  privatePriceNotSet: 'No private price is set for this group size and band — add one under Catalog → Session Types first.',
  readerCannotRefund: 'This move refunds the price difference — a card reader cannot refund. Choose a refund method instead.',
  movedWithThisPayment:
    'This booking was already moved with the same payment (by a press at the same moment, or this one with its answer lost), so it was only taken once. Reload the booking.',
  saveUnclear:
    "Saving the move gave no answer, and checking whether it was saved failed too, so nothing was put back. Reload the booking: if it is on the new session, the move is done. If not, check both sessions' places, and give back by hand any gift card, store credit or cash taken for it.",
  bookingChanged: 'The booking changed while it was being moved, so it was not moved and any payment was put back. Check it and try again.',
} as const
export const moveReaderSetupFailedMessage = (detail: string): string =>
  `Creating the card reader payment failed — the move was undone and nothing was charged (${detail}).`
/** A cheaper move whose refund didn't all go: what is still on the booking. */
export const moveRefundUnsureMessage = (notGiven: number): string => `The £${notGiven.toFixed(2)} is still on the booking. ${REFUND_UNSURE_MESSAGE}`
export const moveCardRefundFailedMessage = (notGiven: number): string =>
  `The card refund of £${notGiven.toFixed(2)} failed, so it is still on the booking: use Refund the rest.`
export const moveStoreCreditUnclearMessage = (notGiven: number): string =>
  `The £${notGiven.toFixed(2)} is still on the booking: check their store credit balance, then use Refund the rest if it isn't there.`

/** addBookingGuest.ts. */
export const ADD_GUEST_WORDS = {
  saveUnclear:
    "Saving this gave no answer, and checking whether it was saved failed too, so nothing was put back. Reload the booking: if the guest or add-ons are there, it is done. If not, check the session's places and give back by hand any gift card, store credit, credits or cash taken for it.",
  alreadyAdded:
    'This was already added with the same payment (by a press at the same moment, or this one with its answer lost), so it was only taken once. Reload the booking.',
  guestNameRequired: 'Guest name is required',
  overrideReasonRequired: 'An add-on price was changed from the system price — enter a reason for the change.',
  bookingChanged: 'The booking changed while this was being added, so nothing was added and any payment was put back. Check it and try again.',
} as const
export const addGuestGiftCardClaimFailedMessage = (detail: string): string =>
  `Claiming the gift card failed (${detail}). Nothing was charged to the card. Check the gift card's balance before trying again.`

/** settleLapsedBooking.ts. */
export const SETTLE_WORDS = {
  saveUnclear:
    "Saving the settle gave no answer, and checking whether it was saved failed too, so nothing was put back. Reload the booking: if it is confirmed, it is settled. If it is still awaiting payment, give back by hand any gift card, store credit or cash taken for it.",
  alreadySettled:
    'This booking was already settled with the same payment (by a press at the same moment, or this one with its answer lost), so it was only taken once. Reload the booking.',
  everythingPutBack: 'Everything taken was put back.',
  noLongerAwaiting: 'The booking is no longer awaiting payment, so the payment was put back. Check the booking.',
  storeCreditGivenBack: 'The store credit was given back.',
  checkGiftCard: "Check the gift card's balance before trying again.",
} as const

/** removeBookingGuest.ts. */
export const REMOVE_GUEST_WORDS = {
  notRemovedNothingRefunded: "The guest couldn't be removed and nothing was refunded. Please try again.",
  refundedNotRemoved: "The refund went through, but the guest couldn't be removed. Check the booking before trying again.",
  partRefundedNotRemoved: "Part of the refund went through, but the guest couldn't be removed. Check the booking before trying again.",
} as const
export const removeGuestUnsureMessage = (detail: string, stuck: string): string => `The guest hasn't been removed. ${REFUND_UNSURE_MESSAGE} (${detail})${stuck}`
export const removeGuestRefundFailedMessage = (detail: string, stuck: string): string =>
  `The refund didn't go through, so the guest hasn't been removed. Please try again. (${detail})${stuck}`

/** refundBooking.ts and shared/bookingRefund.ts. */
export const REFUND_WORDS = {
  bookingNotFound: 'Booking not found.',
  alreadyCancelled: 'This booking is already cancelled.',
  amountNotPositive: 'The refund amount must be more than £0.',
  figuresChanged: 'The figures on this booking have just changed. Check them and confirm again.',
  nothingOwed: 'Nothing is owed on this booking any more.',
  nothingLeft: "There's nothing left to refund on this booking.",
  noCardLeft: 'No card money is left on this booking, so this can only go to store credit.',
  owedAmountRequired: 'The amount owed is required.',
  couldNotRefund: 'The booking could not be refunded.',
  cancelChanged: 'The booking changed while it was being cancelled, so it was not cancelled. Reload and try again.',
} as const
export const reasonRequiredMessage = (what: string): string => `A reason is required for ${what}.`
export const reasonTooLongMessage = (max: number): string => `The reason must be ${max} characters or fewer.`
const money = (pounds: number): string => `£${pounds.toFixed(2)}`
export const owedChangedMessage = (owed: number): string => `The amount owed has changed to ${money(owed)}. Check it and confirm again.`
export const onlyLeftMessage = (left: number): string => `Only ${money(left)} is left on this booking. Check the amount and confirm again.`
export const onlyCardLeftMessage = (limit: number): string => `Only ${money(limit)} of card money is left on this booking. Check the amount and confirm again.`

/** cancelCreditBooking.ts. */
export const CANCEL_CREDIT_WORDS = {
  bookingIdRequired: 'Booking id is required.',
  bookingNotFound: 'Booking not found.',
  notCreditBooking: 'Only bookings paid with a membership or session-pass credit can be cancelled this way.',
  paidGuestsPresent: 'Remove paid guests first, then cancel.',
  moneyPaid: 'This booking includes a money payment - use Cancel & Refund instead.',
} as const
export const notCancellableMessage = (status: string): string => `Only confirmed or pending bookings can be cancelled — this one is ${status}.`

/** removeBookingAddon.ts. */
export const REMOVE_ADDON_WORDS = {
  lineNotFound: 'This add-on is no longer on the booking.',
  alreadyRemoved: 'This add-on has already been removed.',
  sessionStarted: "The session has started, so add-ons can't be removed.",
  couldNotRemove: 'The add-on could not be removed.',
} as const

/** setBookingStatus.ts. N3 (W18) narrows the statuses; its words for the rest are W18's. */
export const STATUS_WORDS = {
  cancelled: 'This booking is cancelled, so its status can no longer be changed.',
} as const
export const invalidStatusMessage = (status: string, allowed: readonly string[]): string => `Invalid booking status "${status}" — allowed: ${allowed.join(', ')}.`

// --- New in W18

/**
 * N3: a booking awaiting payment leaves that status only through Settle (paid) or Cancel (payment needed), never the
 * status select, which the screen hides for it.
 */
export const STATUS_PAYMENT_NEEDED_MESSAGE =
  "This booking is awaiting payment, so its status can't be changed here. Take the payment with Settle, or cancel it."
/** A status change the bookings_no_cross_session_overlap constraint refuses (a no-show made active again). */
export const STATUS_TIME_CONFLICT_MESSAGE = "Another booking now overlaps this booking's time, so it can't be made active again."

// --- New in W19 (Settle on the Worker)

/** C1 failed in the database and was rolled back (as step C's ORDER_NOT_SAVED): nothing was kept or taken. */
export const SETTLE_NOT_SAVED_MESSAGE =
  "The payment couldn't be saved (the system was busy, or one of its records couldn't be written), so nothing was kept and no payment was taken. The booking is still awaiting payment: try again."
/** settleLapsedBooking.ts's words when the reader's payment couldn't be started (nothing was charged). */
export const settleReaderNotStartedMessage = (detail: string): string =>
  `Creating the card reader payment failed — the settle was undone and nothing was charged (${detail}).`
/** A decline whose undo couldn't run yet: nothing was taken, and reconcile puts the booking back. */
export const DECLINED_NOT_UNDONE_MESSAGE =
  "Nothing was taken, but the booking couldn't be put back to awaiting payment yet. Don't take payment again: check the Orders page in a few minutes."
/**
 * W19a (W19 review later 3): the reader's payment couldn't be started and the undo then failed too. The first sentence
 * without "the settle was undone", which would contradict the second.
 */
export const settleReaderNotStartedNotUndoneMessage = (detail: string): string =>
  `Creating the card reader payment failed (${detail}). ${DECLINED_NOT_UNDONE_MESSAGE}`

// --- New in W20 (Add Guest on the Worker)

/** C1 failed in the database and was rolled back (as Settle's): nothing was added and nothing was taken. */
export const ADD_GUEST_NOT_SAVED_MESSAGE =
  "This couldn't be saved (the system was busy, or one of its records couldn't be written), so nothing was added and no payment was taken. Try again."
/** What the change added, in the old words: the guest, or the add-ons alone. */
const addedThing = (addingGuest: boolean): string => (addingGuest ? 'guest was' : 'add-ons were')
/** addBookingGuest.ts's words when the reader's payment couldn't be started (the change was undone, nothing charged). */
export const addGuestReaderNotStartedMessage = (addingGuest: boolean, detail: string): string =>
  `Creating the card reader payment failed — the ${addedThing(addingGuest)} removed and nothing was charged (${detail}).`
/** A decline (or a reader that couldn't start) whose undo couldn't run yet: nothing was taken, and reconcile undoes it. */
export const ADD_GUEST_NOT_UNDONE_MESSAGE =
  "Nothing was taken, but this couldn't be taken off the booking yet. Don't take payment again: check the Orders page in a few minutes."
/** The reader's payment couldn't be started and the undo failed too (as W19a's Settle words, without "removed"). */
export const addGuestReaderNotStartedNotUndoneMessage = (detail: string): string => `Creating the card reader payment failed (${detail}). ${ADD_GUEST_NOT_UNDONE_MESSAGE}`

// --- New in W17

/** The switch (D-plan 4.9, lead call L1), worded as W16's ORDER_PATH_OFF. */
export const BOOKING_PATH_OFF_MESSAGE = 'This is switched off in the booking system. Tell a manager.'

/**
 * Wayne's Q35 (12 Nov, as recommended): a booking change Stripe gave no clear answer on is held, and reconcile
 * finishes or undoes it. The D-plan's two sentences, word for word: money in, then money back.
 */
export const CHANGE_PAYMENT_UNCONFIRMED_MESSAGE =
  "The card payment didn't get a clear answer, so it may or may not have been taken. The change is on hold: don't take payment again. Check the Orders page in a few minutes."
export const CHANGE_REFUND_UNCONFIRMED_MESSAGE =
  "The refund didn't get a clear answer, so it may or may not have gone. Don't refund it again. Check the Orders page in a few minutes."

/**
 * A card flow (W17): the saved card was charged, and the change couldn't be finished. Held for reconcile, which
 * finishes it (W6-3: never refunded for a database fault). W12's reader words, for the saved card.
 */
export const CARD_FLOW_PAID_NOT_FINISHED_MESSAGE =
  "The card payment went through, but the change couldn't be finished. It's on hold: don't take payment again. Check the Orders page in a few minutes."
/** A card flow charged after it had been undone (a race with reconcile): the money is refunded by reconcile. */
export const CARD_FLOW_CHARGED_WITHOUT_RECORD_MESSAGE =
  "The card was charged, but the change had already been undone, so the payment needs refunding. Don't take payment again: check the Orders page."
/**
 * W05 review 1, finding 18 (D-plan 2.3): the held-payment words when every held flow is a card one. W19 (W17 review,
 * later 1): a saved-card payment has no finish or cancel button (the press settles it, or reconcile does), so the words
 * send staff to Resolve now only.
 */
export const CARD_PAYMENT_OPEN_MESSAGE =
  "A card payment on this booking is still being checked. Don't take payment again: use Resolve now on the Orders page after 15 minutes."
/** The reader routes (finalise, cancel) given a saved-card flow's pending id: nothing was touched. */
export const NOT_A_READER_FLOW_MESSAGE = "This is a saved-card payment, not a card reader payment, so it can't be finished or cancelled on the reader."

/**
 * Wayne's Q37 (12 Nov, as recommended): the booking detail's payment line says what was paid, as New Order's result
 * line does, rather than one method ("Paid in cash" for card + gift card). Parts at £0 are left out; the gift card
 * and store credit are named together, as Q37's example has it.
 */
export function paidLineWords(parts: { card: number; giftCardOrStoreCredit: number; cash: number }): string {
  const named = [
    parts.card > 0.005 ? `${money(parts.card)} by card` : null,
    parts.giftCardOrStoreCredit > 0.005 ? `${money(parts.giftCardOrStoreCredit)} by gift card / store credit` : null,
    parts.cash > 0.005 ? `${money(parts.cash)} in cash` : null,
  ].filter((part): part is string => part !== null)
  if (named.length === 0) return 'Nothing was paid.'
  const last = named.pop() as string
  return `Paid ${named.length > 0 ? `${named.join(', ')} and ${last}` : last}.`
}

/**
 * W21a (W21 review S1): the Part refund dialog's line. Its parts are what is left to refund (price paid less what is
 * owed), not what was paid, so it says so. paidLineWords stays for W23's booking-detail line, worked out from the
 * payments themselves.
 */
export function leftLineWords(parts: { card: number; giftCardOrStoreCredit: number; cash: number }): string {
  const named = [
    parts.card > 0.005 ? `${money(parts.card)} card money` : null,
    parts.giftCardOrStoreCredit > 0.005 ? `${money(parts.giftCardOrStoreCredit)} gift card / store credit` : null,
    parts.cash > 0.005 ? `${money(parts.cash)} cash` : null,
  ].filter((part): part is string => part !== null)
  if (named.length === 0) return 'Nothing left to refund.'
  const last = named.pop() as string
  return `Left to refund: ${named.length > 0 ? `${named.join(', ')} and ${last}` : last}.`
}

// --- New in W21 (the refund pipeline: Part refund, Refund the rest, It already arrived)

/** The old function's refusal of a method it doesn't know (refundBooking.ts), and Part refund's with Q26's cash. */
export const REFUND_METHOD_WORDS = 'refundMethod must be "card" or "credit"'
export const PART_REFUND_METHOD_WORDS = 'refundMethod must be "card", "credit" or "cash"'
/** shared/bookingRefund.ts's words for a card refund Stripe refused before anything went. */
export const cardRefundFailedMessage = (detail: string): string => `The card refund failed, so nothing was refunded: ${detail}`
/** shared/bookingRefund.ts's warning when a later card part was refused and the rest went to store credit. */
export const laterCardRefundFailedMessage = (amount: number, detail: string): string =>
  `A further card refund of ${money(amount)} failed (${detail}), so the rest went to store credit.`
/** The legacy refund route's words for a refusal, which the old messages carried (`Failed to refund payment: …`). */
export const refundRefusedDetail = (stripeMessage: string): string => `Failed to refund payment: ${stripeMessage}`
/** A part that was never sent because the press ran out of time: nothing went, as a refusal. */
export const REFUND_NOT_SENT_DETAIL = 'it was not sent: there was no time left to send it'

/** A refund on the booking is held (no clear answer yet): no other refund until reconcile settles it. */
export const REFUND_OPEN_MESSAGE = "A refund on this booking is still being checked. Don't refund it again: check the Orders page in a few minutes."
/** R1 failed in the database and was rolled back: nothing was claimed and nothing was sent. */
export const REFUND_NOT_SAVED_MESSAGE =
  "The refund couldn't be saved (the system was busy, or one of its records couldn't be written), so nothing was refunded. Try again."
/** The card parts went, and R2 couldn't record them yet: held for reconcile, which records them (never resent). */
export const refundGoneNotRecordedMessage = (cardGone: number): string =>
  `${money(cardGone)} went back to the card, but the refund couldn't be finished on the booking yet. It's on hold: don't refund it again. Check the Orders page in a few minutes.`
/** The first card part was refused, and putting the booking back failed: held for reconcile, which puts it back as owed. */
export const REFUND_REFUSED_NOT_PUT_BACK_MESSAGE =
  "The card refund was refused, so nothing went back, but the booking couldn't be put back yet. Don't refund it again: check the Orders page in a few minutes."

/** Q26: more cash than the booking's orders recorded, or none to hand back. */
export const onlyCashLeftMessage = (limit: number): string =>
  `Only ${money(limit)} of cash recorded on this booking's orders can be handed back. Check the amount and confirm again.`
export const NO_CASH_LEFT_MESSAGE = "No cash recorded on this booking's orders can be handed back, so this can only go to store credit."
/** Refund the rest couldn't ask Stripe whether an old refund with no clear answer went: nothing was sent. */
export const REFUND_CHECK_FAILED_MESSAGE =
  "Checking Stripe for an earlier card refund on this booking failed, so nothing was refunded. Try again in a minute."
/**
 * W21a (W21 review L1): Refund the rest found an old card refund with no clear answer that reached the customer, and
 * it isn't exactly one of the card refunds planned now, so nothing was sent: staff check Stripe first.
 */
export function oldRefundReachedCustomerMessage(amounts: readonly number[]): string {
  const named = amounts.map(money)
  const last = named.pop() ?? money(0)
  const which = named.length > 0 ? `Earlier card refunds of ${named.join(', ')} and ${last} on this booking` : `An earlier card refund of ${last} on this booking`
  return `${which} reached the customer, so nothing was refunded. Check Stripe, then use It already arrived for what arrived.`
}
/**
 * W21a (W21 review L6): a later card part the press had no time left to send. Stripe never refused it, so it stays
 * owed on the booking for Refund the rest to send to the card (a real refusal still goes to store credit).
 */
export const laterCardRefundNotSentMessage = (amount: number): string =>
  `A further card refund of ${money(amount)} wasn't sent in time, so it's owed on the booking: use Refund the rest to send it to the card.`

// --- New in W22 (Remove Guest and Remove add-on on the Worker)

/** R1 failed in the database and was rolled back: the guest is still there and nothing was refunded (the old words). */
export const REMOVE_GUEST_NOT_SAVED_MESSAGE = REMOVE_GUEST_WORDS.notRemovedNothingRefunded
/** R1 failed in the database and was rolled back: the add-on is still there and nothing was refunded. */
export const REMOVE_ADDON_NOT_SAVED_MESSAGE =
  "The add-on couldn't be removed (the system was busy, or one of its records couldn't be written), so nothing was refunded. Try again."

/** cancelBookingAddonLines' words when the first card refund for a paying order was refused: the add-ons stay on. */
export function addonCardRefundFailedMessage(names: string, count: number, detail: string): string {
  const one = count === 1
  return `The card refund for ${names} failed (${detail}), so ${one ? 'it was' : 'they were'} left on the booking — refund ${one ? 'it' : 'them'} manually.`
}
/** cancelBookingAddonLines' notes. */
export const ADDON_INSIDE_24_HOURS_NOTE = 'Inside 24 hours of the session, so no add-on money or credit was given back.'
export const addonMembershipNotActiveNote = (name: string): string =>
  `The membership that paid for ${name} is no longer active, so its add-on credit couldn't be returned.`

/** describeAddonCancellation: "1 add-on cancelled: £5.00 to the card, 1 add-on credit returned". */
export function addonRemovalSummary(result: { count: number; cardRefundedAmount: number; storeCreditRefundedAmount: number; creditsReturned: number }): string {
  const parts: string[] = []
  if (result.cardRefundedAmount > 0) parts.push(`${money(result.cardRefundedAmount)} to the card`)
  if (result.storeCreditRefundedAmount > 0) parts.push(`${money(result.storeCreditRefundedAmount)} to store credit`)
  if (result.creditsReturned > 0) parts.push(`${result.creditsReturned} add-on credit${result.creditsReturned === 1 ? '' : 's'} returned`)
  const head = `${result.count} add-on${result.count === 1 ? '' : 's'} cancelled`
  return parts.length > 0 ? `${head}: ${parts.join(', ')}` : `${head}, nothing given back`
}
