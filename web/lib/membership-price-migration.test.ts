import { describe, it, expect, vi } from 'vitest'
import { migrateSubscriptionsToPlanPrices, type PriceMigrationDeps } from './membership-price-migration'

const priceIds = { monthly: 'price_m_new', yearly: 'price_y_new' }

function makeDeps(subs: Record<string, { status: string; items: { id: string; priceId: string }[] }>) {
  const switchSubscriptionItemPrice = vi.fn(async () => {})
  const deps: PriceMigrationDeps = {
    retrieveSubscription: async (id) => {
      const sub = subs[id]
      if (!sub) throw new Error('No such subscription')
      return sub
    },
    switchSubscriptionItemPrice,
  }
  return { deps, switchSubscriptionItemPrice }
}

describe('migrateSubscriptionsToPlanPrices', () => {
  it('switches a monthly subscription on an old price to the new monthly price', async () => {
    const { deps, switchSubscriptionItemPrice } = makeDeps({
      sub_1: { status: 'active', items: [{ id: 'si_1', priceId: 'price_m_old' }] },
    })
    const result = await migrateSubscriptionsToPlanPrices(
      [{ id: 'm1', stripe_subscription_id: 'sub_1', billing_frequency: 'monthly' }],
      priceIds,
      deps
    )
    expect(result).toEqual({ migrated: 1, alreadyCurrent: 0, skipped: 0, failed: [] })
    expect(switchSubscriptionItemPrice).toHaveBeenCalledWith('sub_1', 'si_1', 'price_m_new')
  })

  it('uses the yearly price for yearly members', async () => {
    const { deps, switchSubscriptionItemPrice } = makeDeps({
      sub_y: { status: 'active', items: [{ id: 'si_y', priceId: 'price_y_old' }] },
    })
    await migrateSubscriptionsToPlanPrices(
      [{ id: 'm2', stripe_subscription_id: 'sub_y', billing_frequency: 'yearly' }],
      priceIds,
      deps
    )
    expect(switchSubscriptionItemPrice).toHaveBeenCalledWith('sub_y', 'si_y', 'price_y_new')
  })

  it('leaves a subscription already on the current price alone (idempotent)', async () => {
    const { deps, switchSubscriptionItemPrice } = makeDeps({
      sub_1: { status: 'active', items: [{ id: 'si_1', priceId: 'price_m_new' }] },
    })
    const result = await migrateSubscriptionsToPlanPrices(
      [{ id: 'm1', stripe_subscription_id: 'sub_1', billing_frequency: 'monthly' }],
      priceIds,
      deps
    )
    expect(result.alreadyCurrent).toBe(1)
    expect(switchSubscriptionItemPrice).not.toHaveBeenCalled()
  })

  it('skips ended subscriptions and plans with no price for that frequency', async () => {
    const { deps, switchSubscriptionItemPrice } = makeDeps({
      sub_c: { status: 'canceled', items: [{ id: 'si_c', priceId: 'price_m_old' }] },
    })
    const result = await migrateSubscriptionsToPlanPrices(
      [
        { id: 'm3', stripe_subscription_id: 'sub_c', billing_frequency: 'monthly' },
        { id: 'm4', stripe_subscription_id: 'sub_x', billing_frequency: 'yearly' },
      ],
      { monthly: 'price_m_new', yearly: null },
      deps
    )
    expect(result.skipped).toBe(2)
    expect(switchSubscriptionItemPrice).not.toHaveBeenCalled()
  })

  it('isolates failures so one bad subscription does not stop the rest', async () => {
    const { deps } = makeDeps({
      sub_ok: { status: 'active', items: [{ id: 'si_ok', priceId: 'price_m_old' }] },
      sub_multi: {
        status: 'active',
        items: [
          { id: 'a', priceId: 'p1' },
          { id: 'b', priceId: 'p2' },
        ],
      },
    })
    const result = await migrateSubscriptionsToPlanPrices(
      [
        { id: 'a', stripe_subscription_id: 'sub_missing', billing_frequency: 'monthly' },
        { id: 'b', stripe_subscription_id: 'sub_multi', billing_frequency: 'monthly' },
        { id: 'c', stripe_subscription_id: 'sub_ok', billing_frequency: 'monthly' },
      ],
      priceIds,
      deps
    )
    expect(result.migrated).toBe(1)
    expect(result.failed.map((f) => f.membershipId)).toEqual(['a', 'b'])
  })
})
