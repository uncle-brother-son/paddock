import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import { dispatchStripeEvent, type RpcClient } from './dispatch'

function fakeEvent(type: string, object: unknown): Stripe.Event {
  return { id: 'evt_test', type, data: { object } } as unknown as Stripe.Event
}

function fakeRpcClient(response: { data: any; error: any }): RpcClient & { rpc: ReturnType<typeof vi.fn> } {
  return { rpc: vi.fn().mockResolvedValue(response) }
}

describe('dispatchStripeEvent', () => {
  it('invoice.paid calls membership_mark_paid with the resolved subscription id and ISO period end', async () => {
    const supabase = fakeRpcClient({ data: { found: true, action: 'reactivated' }, error: null })
    const invoice = {
      billing_reason: 'subscription_cycle',
      parent: { subscription_details: { subscription: 'sub_123' } },
      lines: { data: [{ period: { end: 1700000000 } }] },
    }
    const result = await dispatchStripeEvent(fakeEvent('invoice.paid', invoice), supabase)

    expect(supabase.rpc).toHaveBeenCalledWith('membership_mark_paid', {
      p_stripe_subscription_id: 'sub_123',
      p_period_end: new Date(1700000000 * 1000).toISOString(),
    })
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'reactivated' } })
  })

  it('invoice.paid skips the first invoice (billing_reason subscription_create) without calling the RPC', async () => {
    const supabase = fakeRpcClient({ data: null, error: null })
    const invoice = {
      billing_reason: 'subscription_create',
      parent: { subscription_details: { subscription: 'sub_123' } },
      lines: { data: [{ period: { end: 1700000000 } }] },
    }
    const result = await dispatchStripeEvent(fakeEvent('invoice.paid', invoice), supabase)

    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'first_invoice' } })
  })

  it('invoice.payment_failed calls membership_mark_payment_failed with the resolved subscription id', async () => {
    const supabase = fakeRpcClient({ data: { found: true, action: 'past_due' }, error: null })
    const invoice = {
      billing_reason: 'subscription_cycle',
      parent: { subscription_details: { subscription: 'sub_456' } },
    }
    const result = await dispatchStripeEvent(fakeEvent('invoice.payment_failed', invoice), supabase)

    expect(supabase.rpc).toHaveBeenCalledWith('membership_mark_payment_failed', {
      p_stripe_subscription_id: 'sub_456',
    })
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'past_due' } })
  })

  it('invoice.payment_failed skips the first invoice without calling the RPC', async () => {
    const supabase = fakeRpcClient({ data: null, error: null })
    const invoice = { billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_456' } } }
    const result = await dispatchStripeEvent(fakeEvent('invoice.payment_failed', invoice), supabase)

    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'first_invoice' } })
  })

  it('customer.subscription.deleted calls membership_mark_cancelled_by_stripe', async () => {
    const supabase = fakeRpcClient({ data: { found: true, action: 'cancelled' }, error: null })
    const result = await dispatchStripeEvent(
      fakeEvent('customer.subscription.deleted', { id: 'sub_789' }),
      supabase
    )

    expect(supabase.rpc).toHaveBeenCalledWith('membership_mark_cancelled_by_stripe', {
      p_stripe_subscription_id: 'sub_789',
    })
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'cancelled' } })
  })

  it('customer.subscription.updated calls membership_sync_cancel_at_period_end with the resolved period end', async () => {
    const supabase = fakeRpcClient({ data: { found: true, action: 'cancel_scheduled' }, error: null })
    const subscription = {
      id: 'sub_999',
      cancel_at_period_end: true,
      items: { data: [{ current_period_end: 1700000000 }] },
    }
    const result = await dispatchStripeEvent(fakeEvent('customer.subscription.updated', subscription), supabase)

    expect(supabase.rpc).toHaveBeenCalledWith('membership_sync_cancel_at_period_end', {
      p_stripe_subscription_id: 'sub_999',
      p_cancel_at_period_end: true,
      p_period_end: new Date(1700000000 * 1000).toISOString(),
    })
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'cancel_scheduled' } })
  })

  it('ignores event types that are not handled, without calling the RPC', async () => {
    const supabase = fakeRpcClient({ data: null, error: null })
    const result = await dispatchStripeEvent(fakeEvent('charge.succeeded', {}), supabase)

    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'unhandled_event_type' } })
  })

  it('treats an RPC result of found:false as ignored', async () => {
    const supabase = fakeRpcClient({ data: { found: false }, error: null })
    const result = await dispatchStripeEvent(
      fakeEvent('customer.subscription.deleted', { id: 'sub_unknown' }),
      supabase
    )

    expect(result).toEqual({ outcome: 'ignored', detail: { found: false } })
  })

  it('throws when the RPC call itself returns an error', async () => {
    const supabase = fakeRpcClient({ data: null, error: new Error('db exploded') })
    await expect(
      dispatchStripeEvent(fakeEvent('customer.subscription.deleted', { id: 'sub_789' }), supabase)
    ).rejects.toThrow('db exploded')
  })
})
