import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import { processWebhookEvent } from './idempotency'

function fakeEvent(type: string, object: unknown): Stripe.Event {
  return { id: 'evt_test', type, data: { object } } as unknown as Stripe.Event
}

function createFakeSupabase(opts: {
  upsertError?: any
  existing?: { outcome: string | null } | null
  lookupError?: any
  updateError?: any
  rpcData?: any
  rpcError?: any
}) {
  const upsert = vi.fn().mockResolvedValue({ error: opts.upsertError ?? null })
  const single = vi.fn().mockResolvedValue({ data: opts.existing ?? null, error: opts.lookupError ?? null })
  const select = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single }) })
  const updateEq = vi.fn().mockResolvedValue({ error: opts.updateError ?? null })
  const update = vi.fn().mockReturnValue({ eq: updateEq })
  const from = vi.fn().mockReturnValue({ upsert, select, update })
  const rpc = vi.fn().mockResolvedValue({ data: opts.rpcData ?? { found: true }, error: opts.rpcError ?? null })

  return { from, rpc, upsert, select, update, updateEq }
}

// W45a: Stripe as the handlers read it. These events (a deleted subscription, an unhandled type) make no read.
const NO_READ = { subscriptions: { retrieve: vi.fn().mockRejectedValue(new Error('no read expected')) } }

describe('processWebhookEvent', () => {
  it('processes a fresh event and records outcome processed', async () => {
    const supabase = createFakeSupabase({ existing: { outcome: null }, rpcData: { found: true, action: 'cancelled' } })
    const result = await processWebhookEvent(
      fakeEvent('customer.subscription.deleted', { id: 'sub_1' }),
      supabase,
      NO_READ
    )

    expect(result).toEqual({ status: 200, body: { received: true } })
    expect(supabase.update).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'processed', error: null })
    )
  })

  it('skips a duplicate event whose prior attempt already finished (processed)', async () => {
    const supabase = createFakeSupabase({ existing: { outcome: 'processed' } })
    const result = await processWebhookEvent(
      fakeEvent('customer.subscription.deleted', { id: 'sub_1' }),
      supabase,
      NO_READ
    )

    expect(result).toEqual({ status: 200, body: { received: true, duplicate: true } })
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(supabase.update).not.toHaveBeenCalled()
  })

  it('skips a duplicate event whose prior attempt already finished (ignored)', async () => {
    const supabase = createFakeSupabase({ existing: { outcome: 'ignored' } })
    const result = await processWebhookEvent(fakeEvent('charge.succeeded', {}), supabase, NO_READ)

    expect(result).toEqual({ status: 200, body: { received: true, duplicate: true } })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('retries an event whose prior attempt crashed (outcome error)', async () => {
    const supabase = createFakeSupabase({ existing: { outcome: 'error' }, rpcData: { found: true } })
    const result = await processWebhookEvent(
      fakeEvent('customer.subscription.deleted', { id: 'sub_1' }),
      supabase,
      NO_READ
    )

    expect(result).toEqual({ status: 200, body: { received: true } })
    expect(supabase.rpc).toHaveBeenCalled()
  })

  it('retries an event whose prior attempt never finished (outcome null)', async () => {
    const supabase = createFakeSupabase({ existing: { outcome: null }, rpcData: { found: true } })
    const result = await processWebhookEvent(
      fakeEvent('customer.subscription.deleted', { id: 'sub_1' }),
      supabase,
      NO_READ
    )

    expect(result).toEqual({ status: 200, body: { received: true } })
    expect(supabase.rpc).toHaveBeenCalled()
  })

  it('returns 500 and records outcome error when the handler throws', async () => {
    const supabase = createFakeSupabase({
      existing: { outcome: null },
      rpcError: new Error('db exploded'),
    })
    const result = await processWebhookEvent(
      fakeEvent('customer.subscription.deleted', { id: 'sub_1' }),
      supabase,
      NO_READ
    )

    expect(result).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(supabase.update).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', error: 'db exploded' })
    )
  })

  // W45a (W45 audit S1): the handler's read of Stripe failing is a handler that threw. The event must never be
  // recorded as processed or ignored: it stays an error, and Stripe's next delivery is handled afresh.
  it.each([
    ['customer.subscription.updated', { id: 'sub_1', cancel_at: 1700000000, cancel_at_period_end: false, items: { data: [{ current_period_end: 1700000000 }] } }],
    ['invoice.payment_failed', { billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1' } } }],
  ])('%s: returns 500 and records outcome error, with nothing written, when Stripe cannot be read', async (type, object) => {
    const supabase = createFakeSupabase({ existing: { outcome: null }, rpcData: { found: true } })
    const stripe = { subscriptions: { retrieve: vi.fn().mockRejectedValue(new Error('stripe unreachable')) } }
    const result = await processWebhookEvent(fakeEvent(type, object), supabase, stripe)

    expect(result).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1')
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(supabase.update).toHaveBeenCalledTimes(1)
    expect(supabase.update).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', error: 'stripe unreachable' }))
    expect(supabase.update).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'processed' }))
    expect(supabase.update).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ignored' }))
  })

  it('returns 500 when claiming the event row itself fails', async () => {
    const supabase = createFakeSupabase({ upsertError: new Error('insert failed') })
    const result = await processWebhookEvent(
      fakeEvent('customer.subscription.deleted', { id: 'sub_1' }),
      supabase,
      NO_READ
    )

    expect(result).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})
