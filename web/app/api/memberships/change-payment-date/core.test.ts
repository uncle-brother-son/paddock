import { describe, it, expect, vi } from 'vitest'
import {
  changeMembershipPaymentDate,
  addOneMonth,
  daysBetween,
  londonDateOf,
  londonMidnightUnix,
  type StripeChangePaymentDateDeps,
} from './core'

// 3 Dec 2026 14:00 UTC (GMT), the subscription's current period end.
const PERIOD_END = Date.UTC(2026, 11, 3, 14, 0, 0) / 1000

const activeMembership = {
  id: 'membership-1',
  customer_id: 'customer-1',
  subscription_status: 'active',
  billing_frequency: 'monthly',
  next_renewal_date: '2026-12-03',
  cancel_effective_date: null,
}

const customerWithCard = { id: 'customer-1', stripe_customer_id: 'cus_1', saved_payment_method_id: 'pm_1' }

function fakeSupabase(opts: { membership?: any; customer?: any } = {}) {
  const rows: Record<string, any> = {
    customer_memberships: opts.membership === undefined ? activeMembership : opts.membership,
    customers: opts.customer === undefined ? customerWithCard : opts.customer,
  }
  const from = vi.fn((table: string) => ({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: rows[table] ?? null, error: rows[table] ? null : { message: 'not found' } }),
      }),
    }),
  }))
  return { from }
}

function fakeSubscription(overrides: Record<string, any> = {}): any {
  return {
    id: 'sub_123',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    cancel_at: null,
    items: {
      data: [
        {
          current_period_end: PERIOD_END,
          quantity: 1,
          price: { unit_amount: 3000, recurring: { interval: 'month', interval_count: 1 } },
        },
      ],
    },
    ...overrides,
  }
}

function fakeStripe(overrides: Partial<StripeChangePaymentDateDeps> = {}) {
  const trialEnd = londonMidnightUnix('2026-12-25')
  return {
    subscriptionsRetrieve: vi.fn().mockResolvedValue(fakeSubscription()),
    subscriptionsUpdate: vi.fn().mockResolvedValue(
      fakeSubscription({
        status: 'trialing',
        trial_end: trialEnd,
        billing_cycle_anchor: trialEnd,
        items: { data: [{ current_period_end: trialEnd, quantity: 1, price: { unit_amount: 3000, recurring: { interval: 'month', interval_count: 1 } } }] },
      })
    ),
    paymentIntentsCreate: vi.fn().mockResolvedValue({ id: 'pi_1', status: 'succeeded' }),
    refundsCreate: vi.fn().mockResolvedValue({ id: 're_1' }),
    ...overrides,
  } as any
}

const params = { stripeSubscriptionId: 'sub_123', newRenewalDate: '2026-12-25', partMonthAmount: 22 }

describe('date helpers', () => {
  it('addOneMonth clamps to the end of a shorter month, like Postgres', () => {
    expect(addOneMonth('2026-01-31')).toBe('2026-02-28')
    expect(addOneMonth('2028-01-31')).toBe('2028-02-29')
    expect(addOneMonth('2026-12-03')).toBe('2027-01-03')
    expect(addOneMonth('2026-11-03')).toBe('2026-12-03')
  })

  it('daysBetween counts calendar days', () => {
    expect(daysBetween('2026-12-03', '2026-12-25')).toBe(22)
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2) // across the BST change
  })

  it('londonMidnightUnix is 00:00 London in GMT and in BST', () => {
    expect(londonMidnightUnix('2026-12-25')).toBe(Date.UTC(2026, 11, 25, 0, 0, 0) / 1000)
    expect(londonMidnightUnix('2026-07-25')).toBe(Date.UTC(2026, 6, 24, 23, 0, 0) / 1000)
    expect(londonDateOf(londonMidnightUnix('2026-07-25'))).toBe('2026-07-25')
  })
})

describe('changeMembershipPaymentDate', () => {
  it('charges the extra days, then moves the billing date with trial_end and no proration', async () => {
    const supabase = fakeSupabase()
    const stripe = fakeStripe()

    const result = await changeMembershipPaymentDate(params, supabase, stripe)

    expect(stripe.paymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 2200,
        currency: 'gbp',
        customer: 'cus_1',
        payment_method: 'pm_1',
        off_session: true,
        confirm: true,
        description: 'Payment date change: 22 extra days',
      })
    )
    expect(stripe.subscriptionsUpdate).toHaveBeenCalledWith('sub_123', {
      trial_end: londonMidnightUnix('2026-12-25'),
      proration_behavior: 'none',
    })
    expect(stripe.paymentIntentsCreate.mock.invocationCallOrder[0]).toBeLessThan(
      stripe.subscriptionsUpdate.mock.invocationCallOrder[0]
    )
    expect(result).toEqual({
      success: true,
      paymentIntentId: 'pi_1',
      newPeriodEnd: new Date(londonMidnightUnix('2026-12-25') * 1000).toISOString(),
      extraDays: 22,
    })
  })

  it('refunds the charge in full when moving the date fails', async () => {
    const stripe = fakeStripe({ subscriptionsUpdate: vi.fn().mockRejectedValue(new Error('Stripe is down')) })

    const result = await changeMembershipPaymentDate(params, fakeSupabase(), stripe)

    expect(stripe.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_1' })
    expect(result).toMatchObject({ success: false, status: 500, code: 'subscription_update_failed' })
  })

  it('says the charge needs refunding by hand when the automatic refund also fails', async () => {
    const stripe = fakeStripe({
      subscriptionsUpdate: vi.fn().mockRejectedValue(new Error('Stripe is down')),
      refundsCreate: vi.fn().mockRejectedValue(new Error('refund failed')),
    })

    const result = await changeMembershipPaymentDate(params, fakeSupabase(), stripe)

    expect(result).toMatchObject({ success: false, code: 'refund_failed' })
    expect((result as { error: string }).error).toContain('pi_1')
  })

  it('stops before touching the subscription when the card is declined', async () => {
    const declined = Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined' })
    const stripe = fakeStripe({ paymentIntentsCreate: vi.fn().mockRejectedValue(declined) })

    const result = await changeMembershipPaymentDate(params, fakeSupabase(), stripe)

    expect(result).toEqual({ success: false, status: 402, error: 'Your card was declined.', code: 'payment_failed' })
    expect(stripe.subscriptionsUpdate).not.toHaveBeenCalled()
    expect(stripe.refundsCreate).not.toHaveBeenCalled()
  })

  it('refuses when Stripe renews on a different date from the membership row (stale data)', async () => {
    const supabase = fakeSupabase({ membership: { ...activeMembership, next_renewal_date: '2026-11-03' } })
    const stripe = fakeStripe()

    const result = await changeMembershipPaymentDate(params, supabase, stripe)

    expect(result).toMatchObject({ success: false, status: 409, code: 'stale_renewal_date' })
    expect(stripe.paymentIntentsCreate).not.toHaveBeenCalled()
  })

  it('refuses a date on or before the current renewal, or on or after the renewal after it', async () => {
    for (const newRenewalDate of ['2026-12-03', '2026-12-01', '2027-01-03', '2027-01-10']) {
      const stripe = fakeStripe()
      const result = await changeMembershipPaymentDate({ ...params, newRenewalDate }, fakeSupabase(), stripe)
      expect(result).toMatchObject({ success: false, code: 'date_out_of_range' })
      expect(stripe.paymentIntentsCreate).not.toHaveBeenCalled()
    }
  })

  it('refuses yearly memberships with the agreed wording', async () => {
    const supabase = fakeSupabase({ membership: { ...activeMembership, billing_frequency: 'yearly' } })
    const result = await changeMembershipPaymentDate(params, supabase, fakeStripe())
    expect(result).toEqual({
      success: false,
      status: 400,
      error: "Yearly memberships renew once a year, so the payment date can't be changed",
      code: 'not_monthly',
    })
  })

  it('refuses a scheduled cancellation, in the database or on Stripe', async () => {
    const dbCancel = await changeMembershipPaymentDate(
      params,
      fakeSupabase({ membership: { ...activeMembership, cancel_effective_date: '2026-12-02' } }),
      fakeStripe()
    )
    expect(dbCancel).toMatchObject({ success: false, code: 'cancel_scheduled' })

    const stripe = fakeStripe({ subscriptionsRetrieve: vi.fn().mockResolvedValue(fakeSubscription({ cancel_at_period_end: true })) })
    const stripeCancel = await changeMembershipPaymentDate(params, fakeSupabase(), stripe)
    expect(stripeCancel).toMatchObject({ success: false, code: 'cancel_scheduled' })
    expect(stripe.paymentIntentsCreate).not.toHaveBeenCalled()
  })

  it('refuses a subscription that is not active on Stripe (past_due, trialing)', async () => {
    for (const status of ['past_due', 'trialing']) {
      const stripe = fakeStripe({ subscriptionsRetrieve: vi.fn().mockResolvedValue(fakeSubscription({ status })) })
      const result = await changeMembershipPaymentDate(params, fakeSupabase(), stripe)
      expect(result).toMatchObject({ success: false, code: 'not_active' })
    }
  })

  it('refuses when the customer has no saved card', async () => {
    const supabase = fakeSupabase({ customer: { ...customerWithCard, saved_payment_method_id: null } })
    const result = await changeMembershipPaymentDate(params, supabase, fakeStripe())
    expect(result).toMatchObject({ success: false, code: 'no_saved_card' })
  })

  it('refuses a part-month amount above a full month, and amounts that are not pounds and pence', async () => {
    const tooHigh = await changeMembershipPaymentDate({ ...params, partMonthAmount: 30.01 }, fakeSupabase(), fakeStripe())
    expect(tooHigh).toMatchObject({ success: false, code: 'amount_too_high' })

    const fraction = await changeMembershipPaymentDate({ ...params, partMonthAmount: 1.234 }, fakeSupabase(), fakeStripe())
    expect(fraction).toMatchObject({ success: false, status: 400 })
  })

  it('returns a warning when Stripe does not report the expected trial end / anchor', async () => {
    const stripe = fakeStripe({
      subscriptionsUpdate: vi.fn().mockResolvedValue(fakeSubscription({ trial_end: 1, billing_cycle_anchor: 1 })),
    })
    const result = await changeMembershipPaymentDate(params, fakeSupabase(), stripe)
    expect(result).toMatchObject({ success: true, paymentIntentId: 'pi_1' })
    expect((result as { warning?: string }).warning).toContain('check the subscription in Stripe')
  })
})
