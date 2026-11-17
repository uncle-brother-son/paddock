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
// and the legacy change-payment-date route's guard (legacy-guard.ts) ask that kind and never `membership_changes`;
// the cancel and the undo ask `membership_changes` and never that one. So the date change can be switched off, and
// the old staff app put back for it, while W40's cancel and undo stay on. The quote, reconcile and the check never
// ask either: a held change is always finished.
import 'server-only'
import { ApiError } from '@/server/http/errors'
import { kindsOn, type OrderKind } from '@/server/rules/orders/order-switch'
import { MEMBERSHIP_PATH_OFF_MESSAGE } from './failure-messages'

/** Step F's kind for a cancel, its undo and the replaced card. Off unless the ORDER_SWITCH secret names it. */
export const MEMBERSHIP_KINDS = ['membership_changes'] as const satisfies readonly OrderKind[]
/** W41a: the payment date change's own kind. Off unless the ORDER_SWITCH secret names it. */
export const PAYMENT_DATE_KINDS = ['payment_date_changes'] as const satisfies readonly OrderKind[]

/** Whether `membership_changes` is on. For the saved card (W42): off, the card is still saved and the memberships are left to move. */
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
