import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import { createMembershipSubscription, getInvoicePaymentIntentId, type StripeDeps } from './core'

function fakeSupabase(opts: { customer?: any; plan?: any; customerError?: any; planError?: any }) {
  const from = vi.fn((table: string) => {
    if (table === 'customers') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: opts.customer ?? null, error: opts.customerError ?? null }),
          }),
        }),
      }
    }
    if (table === 'membership_plans') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: opts.plan ?? null, error: opts.planError ?? null }),
          }),
        }),
      }
    }
    throw new Error(`Unexpected table in test: ${table}`)
  })
  return { from }
}

function fakeStripe(overrides: Partial<StripeDeps> = {}): StripeDeps & Record<keyof StripeDeps, ReturnType<typeof vi.fn>> {
  return {
    pricesRetrieve: vi.fn().mockResolvedValue({ recurring: { interval: 'month' }, currency: 'gbp' }),
    customersUpdate: vi.fn().mockResolvedValue({}),
    subscriptionsCreate: vi.fn().mockResolvedValue({
      id: 'sub_123',
      status: 'active',
      items: { data: [{ current_period_start: 1700000000, current_period_end: 1702592000 }] },
      latest_invoice: { id: 'in_123', amount_paid: 2500, payments: { data: [{ payment: { payment_intent: 'pi_123' } }] } },
    }),
    subscriptionsCancel: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as any
}

const baseCustomer = { id: 'cust_1', stripe_customer_id: 'cus_stripe1', saved_payment_method_id: 'pm_1' }
const basePlan = {
  id: 'plan_1',
  active: true,
  stripe_product_id: 'prod_1',
  stripe_price_id: 'price_monthly_1',
  stripe_price_id_yearly: 'price_yearly_1',
}

describe('getInvoicePaymentIntentId', () => {
  it('reads the PaymentIntent id from invoice.payments (new location)', () => {
    const invoice = { payments: { data: [{ payment: { payment_intent: 'pi_new' } }] } } as unknown as Stripe.Invoice
    expect(getInvoicePaymentIntentId(invoice)).toBe('pi_new')
  })

  it('unwraps an expanded PaymentIntent object at the new location', () => {
    const invoice = { payments: { data: [{ payment: { payment_intent: { id: 'pi_expanded' } } }] } } as unknown as Stripe.Invoice
    expect(getInvoicePaymentIntentId(invoice)).toBe('pi_expanded')
  })

  it('falls back to the legacy top-level payment_intent field', () => {
    const invoice = { payments: { data: [] }, payment_intent: 'pi_legacy' } as unknown as Stripe.Invoice
    expect(getInvoicePaymentIntentId(invoice)).toBe('pi_legacy')
  })

  it('returns undefined when neither location has a PaymentIntent', () => {
    const invoice = { payments: { data: [] } } as unknown as Stripe.Invoice
    expect(getInvoicePaymentIntentId(invoice)).toBeUndefined()
  })
})

describe('createMembershipSubscription', () => {
  it('returns no_saved_card when the customer has no saved payment method', async () => {
    const supabase = fakeSupabase({ customer: { ...baseCustomer, saved_payment_method_id: null } })
    const stripe = fakeStripe()
    const result = await createMembershipSubscription(
      { customerId: 'cust_1', membershipPlanId: 'plan_1', billingFrequency: 'monthly' },
      supabase,
      stripe
    )
    expect(result).toEqual({
      success: false,
      status: 400,
      error: 'Customer has no saved payment method on file.',
      code: 'no_saved_card',
    })
    expect(stripe.subscriptionsCreate).not.toHaveBeenCalled()
  })

  it('returns plan_not_synced when the chosen frequency has no price id', async () => {
    const supabase = fakeSupabase({ customer: baseCustomer, plan: { ...basePlan, stripe_price_id_yearly: null } })
    const stripe = fakeStripe()
    const result = await createMembershipSubscription(
      { customerId: 'cust_1', membershipPlanId: 'plan_1', billingFrequency: 'yearly' },
      supabase,
      stripe
    )
    expect(result).toMatchObject({ success: false, status: 400, code: 'plan_not_synced' })
    expect(stripe.subscriptionsCreate).not.toHaveBeenCalled()
  })

  it('rejects a non-recurring or mismatched-interval price', async () => {
    const supabase = fakeSupabase({ customer: baseCustomer, plan: basePlan })
    const stripe = fakeStripe({
      pricesRetrieve: vi.fn().mockResolvedValue({ recurring: null, currency: 'gbp' }),
    })
    const result = await createMembershipSubscription(
      { customerId: 'cust_1', membershipPlanId: 'plan_1', billingFrequency: 'monthly' },
      supabase,
      stripe
    )
    expect(result).toMatchObject({ success: false, status: 400, code: 'price_not_recurring' })
    expect(stripe.subscriptionsCreate).not.toHaveBeenCalled()
  })

  it('rejects a recurring price in the wrong currency', async () => {
    const supabase = fakeSupabase({ customer: baseCustomer, plan: basePlan })
    const stripe = fakeStripe({
      pricesRetrieve: vi.fn().mockResolvedValue({ recurring: { interval: 'month' }, currency: 'usd' }),
    })
    const result = await createMembershipSubscription(
      { customerId: 'cust_1', membershipPlanId: 'plan_1', billingFrequency: 'monthly' },
      supabase,
      stripe
    )
    expect(result).toMatchObject({ success: false, status: 400, code: 'price_not_recurring' })
  })

  it('succeeds for a monthly subscription, forwarding the correct price id and period', async () => {
    const supabase = fakeSupabase({ customer: baseCustomer, plan: basePlan })
    const stripe = fakeStripe()
    const result = await createMembershipSubscription(
      { customerId: 'cust_1', membershipPlanId: 'plan_1', billingFrequency: 'monthly' },
      supabase,
      stripe
    )

    expect(stripe.subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_stripe1',
        items: [{ price: 'price_monthly_1' }],
        default_payment_method: 'pm_1',
        off_session: true,
        payment_behavior: 'error_if_incomplete',
      }),
      undefined
    )
    expect(result).toEqual({
      success: true,
      subscriptionId: 'sub_123',
      status: 'active',
      currentPeriodStart: new Date(1700000000 * 1000).toISOString(),
      currentPeriodEnd: new Date(1702592000 * 1000).toISOString(),
      latestInvoiceId: 'in_123',
      paymentIntentId: 'pi_123',
      amountPaid: 25,
    })
  })

  it('succeeds for a yearly subscription, using the yearly price id', async () => {
    const supabase = fakeSupabase({ customer: baseCustomer, plan: basePlan })
    const stripe = fakeStripe({
      pricesRetrieve: vi.fn().mockResolvedValue({ recurring: { interval: 'year' }, currency: 'gbp' }),
    })
    const result = await createMembershipSubscription(
      { customerId: 'cust_1', membershipPlanId: 'plan_1', billingFrequency: 'yearly' },
      supabase,
      stripe
    )

    expect(stripe.subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ price: 'price_yearly_1' }] }),
      undefined
    )
    expect(result.success).toBe(true)
  })

  it('returns 402 payment_failed on a decline and leaves no subscription behind', async () => {
    const supabase = fakeSupabase({ customer: baseCustomer, plan: basePlan })
    const declineError = Object.assign(new Error('Your card was declined.'), { code: 'card_declined', type: 'StripeCardError' })
    const stripe = fakeStripe({ subscriptionsCreate: vi.fn().mockRejectedValue(declineError) })

    const result = await createMembershipSubscription(
      { customerId: 'cust_1', membershipPlanId: 'plan_1', billingFrequency: 'monthly' },
      supabase,
      stripe
    )

    expect(result).toEqual({ success: false, status: 402, error: 'Your card was declined.', code: 'payment_failed' })
    expect(stripe.subscriptionsCancel).not.toHaveBeenCalled()
  })

  it('gives a clear message for authentication_required declines', async () => {
    const supabase = fakeSupabase({ customer: baseCustomer, plan: basePlan })
    const authError = Object.assign(new Error('Authentication required.'), { code: 'authentication_required' })
    const stripe = fakeStripe({ subscriptionsCreate: vi.fn().mockRejectedValue(authError) })

    const result = await createMembershipSubscription(
      { customerId: 'cust_1', membershipPlanId: 'plan_1', billingFrequency: 'monthly' },
      supabase,
      stripe
    )

    expect(result).toMatchObject({
      success: false,
      status: 402,
      code: 'payment_failed',
      error: 'This card requires additional authentication — ask the customer to re-enter their card.',
    })
  })

  it('cancels a subscription Stripe returns in a non-active state', async () => {
    const supabase = fakeSupabase({ customer: baseCustomer, plan: basePlan })
    const stripe = fakeStripe({
      subscriptionsCreate: vi.fn().mockResolvedValue({
        id: 'sub_incomplete',
        status: 'incomplete',
        items: { data: [{ current_period_start: 1700000000, current_period_end: 1702592000 }] },
        latest_invoice: null,
      }),
    })

    const result = await createMembershipSubscription(
      { customerId: 'cust_1', membershipPlanId: 'plan_1', billingFrequency: 'monthly' },
      supabase,
      stripe
    )

    expect(stripe.subscriptionsCancel).toHaveBeenCalledWith('sub_incomplete')
    expect(result).toMatchObject({ success: false, status: 402, code: 'payment_failed' })
  })

  it('forwards the idempotency key to subscriptions.create when provided', async () => {
    const supabase = fakeSupabase({ customer: baseCustomer, plan: basePlan })
    const stripe = fakeStripe()

    await createMembershipSubscription(
      { customerId: 'cust_1', membershipPlanId: 'plan_1', billingFrequency: 'monthly', idempotencyKey: 'idem-key-1' },
      supabase,
      stripe
    )

    expect(stripe.subscriptionsCreate).toHaveBeenCalledWith(
      expect.anything(),
      { idempotencyKey: 'idem-key-1' }
    )
  })
})
