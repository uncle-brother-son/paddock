// New in W48 (G-plan 4.6, lead call L3): whether the Worker takes step G's membership plan actions that touch
// Stripe and the members already on a plan. ORDER_SWITCH lists the kinds on; with `plan_changes` off, making a plan,
// changing a plan's price (which moves its live members to the new price) and putting a plan on or off sale answer
// MEMBERSHIP_PATH_OFF, in the words every other switch uses, before anything is read. As the other switches
// (memberships/membership-switch.ts): an emergency stop, not a fallback, and only starting is gated: reconcile still
// finishes a price change that is held and sends a member's move that was left. Step G's other actions (every other
// price, bands, promo codes, stock, sessions, staff, check-in, the reads) are one transaction with nothing to stop
// part way, and never ask. No route calls this until W57 builds the plan actions.
import 'server-only'
import { ApiError } from '@/server/http/errors'
import { MEMBERSHIP_PATH_OFF_MESSAGE } from '@/server/rules/memberships/failure-messages'
import { kindsOn, type OrderKind } from '@/server/rules/orders/order-switch'

/** Step G's kind for the plan actions. Off unless the ORDER_SWITCH secret names it. */
export const PLAN_CHANGE_KINDS = ['plan_changes'] as const satisfies readonly OrderKind[]

/** Whether `plan_changes` is on. No other kind says anything about it, either way. */
export function planChangesOn(switchValue: string | undefined | null): boolean {
  return kindsOn(switchValue).has('plan_changes')
}

/** MEMBERSHIP_PATH_OFF (the same code and words, naming its own kind) when `plan_changes` is off, else null. The reads and reconcile never ask. */
export function planChangePathOff(switchValue: string | undefined | null): ApiError | null {
  return planChangesOn(switchValue)
    ? null
    : new ApiError('MEMBERSHIP_PATH_OFF', MEMBERSHIP_PATH_OFF_MESSAGE, { details: { reason: 'membership_path_off', message: MEMBERSHIP_PATH_OFF_MESSAGE, action: 'plan.change', kinds: [...PLAN_CHANGE_KINDS] } })
}
