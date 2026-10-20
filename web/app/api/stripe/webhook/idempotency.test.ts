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

describe('processWebhookEvent', () => {
  it('processes a fresh event and records outcome processed', async () => {
    const supabase = createFakeSupabase({ existing: { outcome: null }, rpcData: { found: true, action: 'cancelled' } })
    const result = await processWebhookEvent(
      fakeEvent('customer.subscription.deleted', { id: 'sub_1' }),
      supabase
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
      supabase
    )

    expect(result).toEqual({ status: 200, body: { received: true, duplicate: true } })
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(supabase.update).not.toHaveBeenCalled()
  })

  it('skips a duplicate event whose prior attempt already finished (ignored)', async () => {
    const supabase = createFakeSupabase({ existing: { outcome: 'ignored' } })
    const result = await processWebhookEvent(fakeEvent('charge.succeeded', {}), supabase)

    expect(result).toEqual({ status: 200, body: { received: true, duplicate: true } })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('retries an event whose prior attempt crashed (outcome error)', async () => {
    const supabase = createFakeSupabase({ existing: { outcome: 'error' }, rpcData: { found: true } })
    const result = await processWebhookEvent(
      fakeEvent('customer.subscription.deleted', { id: 'sub_1' }),
      supabase
    )

    expect(result).toEqual({ status: 200, body: { received: true } })
    expect(supabase.rpc).toHaveBeenCalled()
  })

  it('retries an event whose prior attempt never finished (outcome null)', async () => {
    const supabase = createFakeSupabase({ existing: { outcome: null }, rpcData: { found: true } })
    const result = await processWebhookEvent(
      fakeEvent('customer.subscription.deleted', { id: 'sub_1' }),
      supabase
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
      supabase
    )

    expect(result).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(supabase.update).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', error: 'db exploded' })
    )
  })

  it('returns 500 when claiming the event row itself fails', async () => {
    const supabase = createFakeSupabase({ upsertError: new Error('insert failed') })
    const result = await processWebhookEvent(
      fakeEvent('customer.subscription.deleted', { id: 'sub_1' }),
      supabase
    )

    expect(result).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})
