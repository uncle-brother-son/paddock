import { describe, it, expect } from 'vitest'
import type Stripe from 'stripe'
import { getInvoiceSubscriptionId, getSubscriptionPeriodEnd } from './dispatch'

describe('getInvoiceSubscriptionId', () => {
  it('reads the subscription id from parent.subscription_details (new location)', () => {
    const invoice = {
      parent: { subscription_details: { subscription: 'sub_new123' } },
    } as unknown as Stripe.Invoice
    expect(getInvoiceSubscriptionId(invoice)).toBe('sub_new123')
  })

  it('unwraps an expanded subscription object at the new location', () => {
    const invoice = {
      parent: { subscription_details: { subscription: { id: 'sub_expanded' } } },
    } as unknown as Stripe.Invoice
    expect(getInvoiceSubscriptionId(invoice)).toBe('sub_expanded')
  })

  it('falls back to the legacy top-level subscription field when parent is absent', () => {
    const invoice = { parent: null, subscription: 'sub_legacy123' } as unknown as Stripe.Invoice
    expect(getInvoiceSubscriptionId(invoice)).toBe('sub_legacy123')
  })

  it('returns undefined when neither location has a subscription id', () => {
    const invoice = { parent: null } as unknown as Stripe.Invoice
    expect(getInvoiceSubscriptionId(invoice)).toBeUndefined()
  })
})

describe('getSubscriptionPeriodEnd', () => {
  it('reads current_period_end from items.data[0] (new location)', () => {
    const subscription = {
      items: { data: [{ current_period_end: 1700000000 }] },
    } as unknown as Stripe.Subscription
    expect(getSubscriptionPeriodEnd(subscription)).toBe(1700000000)
  })

  it('falls back to the legacy top-level current_period_end when items is absent', () => {
    const subscription = { items: { data: [] }, current_period_end: 1600000000 } as unknown as Stripe.Subscription
    expect(getSubscriptionPeriodEnd(subscription)).toBe(1600000000)
  })

  it('returns undefined when neither location has a period end', () => {
    const subscription = { items: { data: [] } } as unknown as Stripe.Subscription
    expect(getSubscriptionPeriodEnd(subscription)).toBeUndefined()
  })
})
