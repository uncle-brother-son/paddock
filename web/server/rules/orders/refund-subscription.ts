// New in W29 (E-plan 4.3 and 4.9; bug E10): a refunded membership's Stripe subscription, cancelled last.
//
// The old refundOrder cancelled the subscription between the money and its local writes. When the cancel failed after
// card money had gone it answered "success with a warning", nothing listed the live subscription, and it renewed a
// month later (E10). When it failed after store credit had been given, the credit was taken back and nothing was done.
//
// Here the cancel is its own step, after the money is settled, and never part of deciding the refund:
// - R2 (the transaction that finishes the claim with the refund standing) records each refunded membership's
//   subscription as `left` (an `order.subscription_left` row with `found: 'refund'`), W13c's pattern: the record is
//   committed with the money, before Stripe is asked, so a crash between the two leaves it listed, never lost.
// - The press (or reconcile, straight after its own R2) then cancels it, checked (membership.ts,
//   cancelSubscriptionChecked: only `canceled` counts), and writes the `cancelled` row that closes the record.
// - A cancel refused or unclear stays `left`: the stuck list shows it, and reconcile tries again. Cancelling
//   twice is harmless (a DELETE; the read decides). A person can close it by hand once it is cancelled in Stripe
//   (the stuck list's Mark sorted, `subscription_left`).
// - W36 (F-plan lead call L7; W29 review L2, the W35 audit's row 11): a cancel Stripe refuses for good on reconcile's
//   retry (Stripe answered, said no, and the subscription is still live or can't be found with the key in use) is
//   recorded as `refused`: still listed, with words that say a person must cancel it in Stripe, and never retried
//   again (W14b's pattern for W13's rows, and the ending memberships/left.ts gives every left step). The press's own
//   first try still leaves it `left`, so the automatic check always tries once more before giving it to a person.
// - A card refund Stripe refused is undone (R1 put back) and writes no such row, so a refusal never leaves a cancelled
//   subscription. A claim held for reconcile cancels nothing until reconcile's R2.
// - No refund is ever sent from here. (W13's retry of a `left` row, retryLeftSubscription, also refunds the first
//   invoice: it never takes a `found: 'refund'` row; reconcile.ts keeps the two apart.)
import 'server-only'
import { audit, type AuditEntry } from '@/server/audit'
import type { Db, Queryable } from '@/server/db'
import type { OrderClaim } from '@/server/rules/refunds/claims'
import { MEMBERSHIP_REFUND_WORDS } from '@/server/rules/refunds/failure-messages'
import type { StripeClient } from '@/server/stripe/client'
import type { StripeTiming } from '@/server/stripe/deadline'
import { cancelSubscriptionChecked, SUBSCRIPTION_LEFT_ACTION } from './membership'

/** `found` on a subscription left by a refund, which tells it from W13's (a subscription made for an order that was gone). */
export const LEFT_BY_REFUND = 'refund'

type Actor = { type: 'staff' | 'system'; id: string | null }

/** The Stripe subscriptions of the memberships a claim's lines refunded (none for most claims). */
export const refundedSubscriptions = (claim: OrderClaim): string[] => [
  ...new Set((claim.details.lines ?? []).map((line) => line.membership?.subscriptionId ?? null).filter((id): id is string => id !== null)),
]

/**
 * One `order.subscription_left` row for a refunded membership's subscription. The fields the stuck list and the close
 * by hand read are W13's (`state`, `subscriptionId`, `invoicePaymentIntentId`, `amountPaid`, `refunded`, `left`), with
 * no first invoice to refund: a refund's own claim gave the money back.
 */
function entry(actor: Actor, requestId: string, orderId: string, claimId: string, subscriptionId: string, left: string[], refused = false, missing = false): AuditEntry {
  return {
    actorType: actor.type,
    actorId: actor.id,
    action: SUBSCRIPTION_LEFT_ACTION,
    entityType: 'order',
    entityId: orderId,
    requestId,
    details: {
      state: left.length === 0 ? 'cancelled' : refused ? 'refused' : 'left',
      subscriptionId,
      invoicePaymentIntentId: null,
      amountPaid: 0,
      found: LEFT_BY_REFUND,
      claimId,
      refunded: [],
      ...(left.length > 0 ? { left } : {}),
      // W58b (the W45 audit's row 26): Stripe can't find the subscription, which the list words as that.
      ...(refused && missing ? { missing: true } : {}),
    },
  }
}

/** R2's rows (same transaction as the claim's finish): each refunded membership's subscription, not cancelled yet. */
export function subscriptionsLeftByRefund(claim: OrderClaim, by: { actor: Actor; requestId: string }): AuditEntry[] {
  return refundedSubscriptions(claim).map((subscriptionId) => entry(by.actor, by.requestId, claim.orderId, claim.id, subscriptionId, [MEMBERSHIP_REFUND_WORDS.notCancelledYet]))
}

export type RefundCancel =
  | { subscriptionId: string; cancelled: true }
  /** `refused`: Stripe refused for good on reconcile's retry, recorded, so it is a person's now and isn't retried (W36). */
  | { subscriptionId: string; cancelled: false; left: string; refused?: true }

/**
 * Cancels one refunded membership's subscription, checked, and closes its record when Stripe shows it cancelled.
 * Anything else leaves the record as it is (`left`). Never throws for Stripe, and never sends a refund. A `cancelled`
 * row that can't be written leaves the record open: the next run reads Stripe, finds it cancelled, and writes it.
 * W36: with `refusedIsForGood` (reconcile's retry), a cancel Stripe refuses writes a `refused` row, which ends the
 * retries; if that row can't be written the record stays `left` and the next run tries again.
 */
export async function cancelRefundedSubscription(
  db: Db,
  stripe: StripeClient,
  target: { orderId: string; claimId: string; subscriptionId: string },
  by: { actor: Actor; requestId: string },
  timing: StripeTiming | undefined,
  { refusedIsForGood = false }: { refusedIsForGood?: boolean } = {}
): Promise<RefundCancel> {
  const answer = await cancelSubscriptionChecked(stripe, target.subscriptionId, timing)
  if (answer.kind !== 'cancelled') {
    const left = `${answer.kind} (${answer.message})`
    if (answer.kind !== 'refused' || !refusedIsForGood) return { subscriptionId: target.subscriptionId, cancelled: false, left }
    try {
      await db.transaction((tx) => audit.recordAll(tx, [entry(by.actor, by.requestId, target.orderId, target.claimId, target.subscriptionId, [left], true, answer.missing === true)]))
    } catch (err) {
      return { subscriptionId: target.subscriptionId, cancelled: false, left: `${left}; not recorded as refused yet (${err instanceof Error ? err.message : String(err)})` }
    }
    return { subscriptionId: target.subscriptionId, cancelled: false, left, refused: true }
  }
  try {
    await db.transaction((tx) => audit.recordAll(tx, [entry(by.actor, by.requestId, target.orderId, target.claimId, target.subscriptionId, [])]))
  } catch (err) {
    return { subscriptionId: target.subscriptionId, cancelled: false, left: `cancelled in Stripe, not recorded yet (${err instanceof Error ? err.message : String(err)})` }
  }
  return { subscriptionId: target.subscriptionId, cancelled: true }
}

/**
 * After a claim has finished with its refund standing: each of its memberships' subscriptions cancelled, last. The
 * answer names the ones left (for the press's warning, and reconcile's detail).
 */
export async function cancelSubscriptionsAfterRefund(db: Db, stripe: StripeClient, claim: OrderClaim, by: { actor: Actor; requestId: string }, timing: StripeTiming | undefined): Promise<RefundCancel[]> {
  const results: RefundCancel[] = []
  for (const subscriptionId of refundedSubscriptions(claim)) {
    results.push(await cancelRefundedSubscription(db, stripe, { orderId: claim.orderId, claimId: claim.id, subscriptionId }, by, timing))
  }
  return results
}

/** What staff are told when a cancel is left: one sentence per subscription. Undefined when every one was cancelled. */
export function cancelLeftWarning(results: readonly RefundCancel[]): string | undefined {
  const left = results.filter((result) => !result.cancelled)
  return left.length > 0 ? left.map((result) => MEMBERSHIP_REFUND_WORDS.cancelLeft(result.subscriptionId)).join(' ') : undefined
}

/** A refunded membership's subscription still to cancel: its open `left` row (reconcile's retry). */
export interface RefundCancelDue {
  orderId: string
  claimId: string
  subscriptionId: string
}

/**
 * The open records reconcile retries, oldest first: `leftSql` is the stuck list's SUBSCRIPTIONS_LEFT_SQL (passed in,
 * because stuck-list.ts imports this file's words), which already leaves out a record a later `cancelled` row closed.
 */
export const refundCancelsDueSql = (leftSql: string): string => `
SELECT l.entity_id AS order_id, l.subscription_id, l.claim_id
FROM (${leftSql}) l
WHERE l.state = 'left' AND l.found = '${LEFT_BY_REFUND}'
ORDER BY l.at, l.entity_id`

export async function refundCancelsDue(db: Queryable, leftSql: string): Promise<RefundCancelDue[]> {
  const rows = await db.query<{ order_id: string; subscription_id: string; claim_id: string | null }>(refundCancelsDueSql(leftSql))
  return rows.map((row) => ({ orderId: row.order_id, subscriptionId: row.subscription_id, claimId: row.claim_id ?? '' }))
}
