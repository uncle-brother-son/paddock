// New in W36 (F-plan 4.11, lead call L3): whether the Worker takes step F's membership changes that touch Stripe.
// ORDER_SWITCH lists the kinds on; with `membership_changes` off, a membership's cancel or undo, a payment date
// change, and the move of memberships to a replaced card answer MEMBERSHIP_PATH_OFF before anything is read. As the
// other switches (bookings/booking-switch.ts, refunds/refund-switch.ts): an emergency stop, not a fallback (each slice
// deletes its old body, L4, and switching back is a Retool rollback), and only starting is gated: reconcile still
// settles a payment date change that is held and sends a step that was left. Step F's other actions (credits, Herd,
// store credit, gift cards, customers) are one transaction with nothing to stop part way, and never ask.
// No route calls this until W40 (cancel and undo) and W42 (replace card).
//
// W41a (lead call, 17 Nov 2026): the payment date change has a kind of its own, `payment_date_changes`. Its press
// asks that kind and never `membership_changes` (the legacy change-payment-date route and its guard left at W44);
// the cancel and the undo ask `membership_changes` and never that one. So the date change can be switched off while
// W40's cancel and undo stay on (since W44 there is no old route behind it: off, nobody can change a payment date
// until it is on again). The quote, reconcile and the check never ask either: a held change is always finished.
//
// W42 (brief item 1): the replaced card has a kind of its own too, `card_moves`. The saved-card route asks that kind
// and never `membership_changes`: off, the card is saved as before W42 and no membership is moved; on, each live
// membership's renewals move to the new card (customers/saved-card.ts). So the moves can be switched off on their own
// (no Retool rollback: the staff app shows whatever the Worker answers). Reconcile and the check never ask it for a
// step: a card step that was left is always sent, listed and checked.
// W42a: an order's T2 asks it too (orders/finalise-order.ts): on, a T2 that writes a membership or saves a card
// leaves a card step for each of the customer's live memberships; off, it is as it was. That is asked wherever T2
// runs, a reconcile run included (an order it finalises is the same T2).
import 'server-only'
import { ApiError } from '@/server/http/errors'
import { kindsOn, type OrderKind } from '@/server/rules/orders/order-switch'
import { MEMBERSHIP_PATH_OFF_MESSAGE } from './failure-messages'

/** Step F's kind for a cancel and its undo. Off unless the ORDER_SWITCH secret names it. */
export const MEMBERSHIP_KINDS = ['membership_changes'] as const satisfies readonly OrderKind[]
/** W41a: the payment date change's own kind. Off unless the ORDER_SWITCH secret names it. */
export const PAYMENT_DATE_KINDS = ['payment_date_changes'] as const satisfies readonly OrderKind[]

/** Whether `membership_changes` is on: the cancel and the undo. */
export function membershipChangesOn(switchValue: string | undefined | null): boolean {
  return kindsOn(switchValue).has('membership_changes')
}

/** MEMBERSHIP_PATH_OFF when `membership_changes` is off, else null. The quotes, the reads and reconcile never ask. */
export function membershipChangePathOff(switchValue: string | undefined | null): ApiError | null {
  return membershipChangesOn(switchValue)
    ? null
    : new ApiError('MEMBERSHIP_PATH_OFF', MEMBERSHIP_PATH_OFF_MESSAGE, { details: { reason: 'membership_path_off', message: MEMBERSHIP_PATH_OFF_MESSAGE, kinds: [...MEMBERSHIP_KINDS] } })
}

/** W41a: whether `payment_date_changes` is on. `membership_changes` says nothing about it, either way. */
export function paymentDateChangesOn(switchValue: string | undefined | null): boolean {
  return kindsOn(switchValue).has('payment_date_changes')
}

/** W41a: MEMBERSHIP_PATH_OFF (the same code and words, naming its own kind) when `payment_date_changes` is off, else null. The quote and reconcile never ask. */
export function paymentDatePathOff(switchValue: string | undefined | null): ApiError | null {
  return paymentDateChangesOn(switchValue)
    ? null
    : new ApiError('MEMBERSHIP_PATH_OFF', MEMBERSHIP_PATH_OFF_MESSAGE, { details: { reason: 'membership_path_off', message: MEMBERSHIP_PATH_OFF_MESSAGE, kinds: [...PAYMENT_DATE_KINDS] } })
}

/** W42: the replaced card's own kind. Off unless the ORDER_SWITCH secret names it. */
export const CARD_MOVE_KINDS = ['card_moves'] as const satisfies readonly OrderKind[]

/**
 * W42: whether `card_moves` is on. Off is not a refusal: the card is saved as before W42 and no membership is moved.
 * `membership_changes` and `payment_date_changes` say nothing about it, either way.
 */
export function cardMovesOn(switchValue: string | undefined | null): boolean {
  return kindsOn(switchValue).has('card_moves')
}
