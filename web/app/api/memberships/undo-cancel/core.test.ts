import { describe, it, expect, vi } from 'vitest'
import { undoCancelMembership, type StripeUndoCancelDeps } from './core'

function fakeSupabase(opts: {
  membership?: any
  membershipError?: any
  updateError?: any
}) {
  const single = vi.fn().mockResolvedValue({ data: opts.membership ?? null, error: opts.membershipError ?? null })
  const select = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single }) })
  const updateEq = vi.fn().mockResolvedValue({ error: opts.updateError ?? null })
  const update = vi.fn().mockReturnValue({ eq: updateEq })
  const from = vi.fn().mockReturnValue({ select, update })
  return { from, update, updateEq }
}

function fakeStripe(overrides: Partial<StripeUndoCancelDeps> = {}): StripeUndoCancelDeps & { subscriptionsUpdate: ReturnType<typeof vi.fn> } {
  return {
    subscriptionsUpdate: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as any
}

describe('undoCancelMembership', () => {
  it('clears cancel_at on Stripe and cancel_effective_date in the DB when a subscription id exists', async () => {
    const supabase = fakeSupabase({ membership: { id: 'membership-1', stripe_subscription_id: 'sub_123' } })
    const stripe = fakeStripe()

    const result = await undoCancelMembership({ membershipId: 'membership-1' }, supabase, stripe)

    expect(stripe.subscriptionsUpdate).toHaveBeenCalledWith('sub_123', { cancel_at: '' })
    expect(supabase.update).toHaveBeenCalledWith({ cancel_effective_date: null })
    expect(result).toEqual({ success: true })
  })

  it('skips Stripe and still clears cancel_effective_date when there is no subscription id', async () => {
    const supabase = fakeSupabase({ membership: { id: 'membership-1', stripe_subscription_id: null } })
    const stripe = fakeStripe()

    const result = await undoCancelMembership({ membershipId: 'membership-1' }, supabase, stripe)

    expect(stripe.subscriptionsUpdate).not.toHaveBeenCalled()
    expect(supabase.update).toHaveBeenCalledWith({ cancel_effective_date: null })
    expect(result).toEqual({ success: true })
  })

  it('returns an error and leaves the DB untouched when the Stripe call fails', async () => {
    const supabase = fakeSupabase({ membership: { id: 'membership-1', stripe_subscription_id: 'sub_123' } })
    const stripe = fakeStripe({ subscriptionsUpdate: vi.fn().mockRejectedValue(new Error('Stripe is down')) })

    const result = await undoCancelMembership({ membershipId: 'membership-1' }, supabase, stripe)

    expect(result).toEqual({ success: false, status: 500, error: 'Stripe is down' })
    expect(supabase.update).not.toHaveBeenCalled()
  })

  it('returns 404 when the membership does not exist', async () => {
    const supabase = fakeSupabase({ membership: null })
    const stripe = fakeStripe()

    const result = await undoCancelMembership({ membershipId: 'missing' }, supabase, stripe)

    expect(result).toEqual({ success: false, status: 404, error: 'Membership not found' })
    expect(stripe.subscriptionsUpdate).not.toHaveBeenCalled()
  })
})
