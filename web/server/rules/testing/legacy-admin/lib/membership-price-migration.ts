export type BillingFrequency = 'monthly' | 'yearly'

export interface PlanPriceIds {
  /** membership_plans.stripe_price_id (the monthly recurring price). */
  monthly: string | null
  /** membership_plans.stripe_price_id_yearly. */
  yearly: string | null
}

export interface MigratableMembership {
  id: string
  stripe_subscription_id: string
  billing_frequency: BillingFrequency | null
}

export interface StripeSubscriptionSnapshot {
  status: string
  items: { id: string; priceId: string }[]
}

export interface PriceMigrationDeps {
  retrieveSubscription: (subscriptionId: string) => Promise<StripeSubscriptionSnapshot>
  /** Must switch the item to the new price with NO proration: the member keeps the current
   *  period as paid and the new price first appears on the next renewal invoice. */
  switchSubscriptionItemPrice: (subscriptionId: string, itemId: string, priceId: string) => Promise<void>
}

export interface PriceMigrationFailure {
  membershipId: string
  subscriptionId: string
  error: string
}

export interface PriceMigrationResult {
  /** Subscriptions switched to the new price on this run. */
  migrated: number
  /** Subscriptions already on the plan's current price (nothing to do). */
  alreadyCurrent: number
  /** Subscriptions left alone (ended in Stripe, or the plan has no price for their frequency). */
  skipped: number
  failed: PriceMigrationFailure[]
}

const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired'])

/**
 * Moves every existing member of a plan onto the plan's CURRENT Stripe price. Idempotent: a
 * subscription already on the current price is left alone, so re-running after a partial failure
 * only retries the ones that failed. Each failure is isolated and reported; one bad subscription
 * never stops the others.
 */
export async function migrateSubscriptionsToPlanPrices(
  memberships: MigratableMembership[],
  priceIds: PlanPriceIds,
  deps: PriceMigrationDeps
): Promise<PriceMigrationResult> {
  const result: PriceMigrationResult = { migrated: 0, alreadyCurrent: 0, skipped: 0, failed: [] }

  for (const membership of memberships) {
    const targetPriceId = membership.billing_frequency === 'yearly' ? priceIds.yearly : priceIds.monthly
    if (!targetPriceId) {
      result.skipped++
      continue
    }
    try {
      const subscription = await deps.retrieveSubscription(membership.stripe_subscription_id)
      if (ENDED_STATUSES.has(subscription.status)) {
        result.skipped++
        continue
      }
      if (subscription.items.length !== 1) {
        result.failed.push({
          membershipId: membership.id,
          subscriptionId: membership.stripe_subscription_id,
          error: `Expected one subscription item, found ${subscription.items.length}.`,
        })
        continue
      }
      const item = subscription.items[0]!
      if (item.priceId === targetPriceId) {
        result.alreadyCurrent++
        continue
      }
      await deps.switchSubscriptionItemPrice(membership.stripe_subscription_id, item.id, targetPriceId)
      result.migrated++
    } catch (err) {
      result.failed.push({
        membershipId: membership.id,
        subscriptionId: membership.stripe_subscription_id,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }
  return result
}
