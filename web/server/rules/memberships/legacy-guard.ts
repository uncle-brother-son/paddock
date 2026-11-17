// New in W40d (W40c review S2): the two legacy membership routes (app/api/memberships/cancel and undo-cancel, which
// stay until W44) protect themselves from the new screen's check.
//
// A cancel or undo made through the new screen leaves a Stripe step, and every step that closes is checked against
// Stripe 20 minutes later (left.ts). A legacy change made inside that time is not a step: to the check it looks like
// a stale send, and the check would put the step's wish back over it (an undo over a legacy cancel keeps charging a
// member staff cancelled). Reconcile and the check never ask the switch, so this holds after a rollback with
// `membership_changes` off too. So each legacy route asks here first, before it reads or sends anything, and refuses
// while the membership has a step that is open, or closed and not yet checked.
//
// Here, not in the routes' core.ts files: those are frozen with the test-only copy (frozen-account-code.test.ts).
//
// W41a (W41 review S1): a payment date change the Worker started and is still holding (a pending row with its
// `started` audit row) stops all three legacy routes too, with the switch on or off. With `payment_date_changes`
// off and the old staff app put back (the date change's own rollback), a page loaded before the hold could still
// press: the old date route would charge again with no key (FB1), and an old cancel could be set over a change
// reconcile is about to finish. A pending row the old code wrote is not looked at here: the old function's own
// 15-minute rule covers it, as it always did.
import 'server-only'
import { closeRequestDb, openRequestDb } from '@/server/db/connection'
import { LEGACY_MEMBERSHIP_CHANGE_HELD_MESSAGE, LEGACY_PAYMENT_DATE_HELD_MESSAGE, PAYMENT_DATE_NEW_WORDS } from './failure-messages'
import { stepsUnsettled } from './left'
import { paymentDateChangesOn } from './membership-switch'
import { workerPaymentDateChangePending } from './payment-date'

/**
 * The words to refuse a legacy cancel or undo with (409), or null when it may go ahead. A read that fails throws: the
 * route answers 500 and changes nothing.
 */
export async function legacyMembershipChangeHeld(membershipId: unknown): Promise<string | null> {
  const db = openRequestDb()
  try {
    if (await stepsUnsettled(db, String(membershipId))) return LEGACY_MEMBERSHIP_CHANGE_HELD_MESSAGE
    // W41a: a payment date change the Worker is still finishing.
    return (await workerPaymentDateChangePending(db, { membershipId: String(membershipId) })) ? LEGACY_PAYMENT_DATE_HELD_MESSAGE : null
  } finally {
    await closeRequestDb(db)
  }
}

/**
 * W41 (brief item 6), W41a (its own kind): the legacy payment date route (app/api/memberships/change-payment-date,
 * which stays until W44) while `payment_date_changes` is on. The new route owns the action then: its record holds the
 * membership, its charge is keyed and reconciled, and a charge made here would be none of those (FB1). So the route
 * refuses, 409, before it reads or sends anything, with these words (the old function shows a route's `error` as it
 * is). With the kind off (a rollback: the kind is taken out of the secret and the old staff app put back) it runs as
 * it always did, whatever `membership_changes` says. Null: go ahead.
 */
export function legacyPaymentDateOff(switchValue: string | undefined | null = process.env.ORDER_SWITCH): string | null {
  return paymentDateChangesOn(switchValue) ? PAYMENT_DATE_NEW_WORDS.legacyOff : null
}

/**
 * W41a (W41 review S1): the legacy payment date route with the kind off. It still refuses, 409, while the
 * subscription's membership has a change the Worker started and is holding. `request`: a copy of the route's request
 * (the route reads the body itself afterwards); a body with no subscription id is the route's own refusal, so null.
 * A read that fails throws: the route answers 500 and changes nothing.
 */
export async function legacyPaymentDateHeld(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => null)) as { stripeSubscriptionId?: unknown } | null
  const subscriptionId = body?.stripeSubscriptionId
  if (typeof subscriptionId !== 'string' || subscriptionId === '') return null
  const db = openRequestDb()
  try {
    return (await workerPaymentDateChangePending(db, { subscriptionId })) ? LEGACY_PAYMENT_DATE_HELD_MESSAGE : null
  } finally {
    await closeRequestDb(db)
  }
}
