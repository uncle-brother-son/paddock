// New in W36 (F-plan 4.11, lead call L3): whether the Worker takes step F's membership changes that touch Stripe.
// ORDER_SWITCH lists the kinds on; with `membership_changes` off, a membership's cancel or undo, a payment date
// change, and the move of memberships to a replaced card answer MEMBERSHIP_PATH_OFF before anything is read. As the
// other switches (bookings/booking-switch.ts, refunds/refund-switch.ts): an emergency stop, not a fallback (each slice
// deletes its old body, L4, and switching back is a Retool rollback), and only starting is gated: reconcile still
// settles a payment date change that is held and sends a step that was left. Step F's other actions (credits, Herd,
// store credit, gift cards, customers) are one transaction with nothing to stop part way, and never ask.
// No route calls this until W40 (cancel and undo), W41 (payment date) and W42 (replace card).
import 'server-only'
import { ApiError } from '@/server/http/errors'
import { kindsOn, type OrderKind } from '@/server/rules/orders/order-switch'
import { MEMBERSHIP_PATH_OFF_MESSAGE } from './failure-messages'

/** Step F's one kind. Off unless the ORDER_SWITCH secret names it. */
export const MEMBERSHIP_KINDS = ['membership_changes'] as const satisfies readonly OrderKind[]

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
