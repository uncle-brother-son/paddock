import { describe, it, expect, vi } from 'vitest'
import Stripe from 'stripe'
import { processWebhookEvent } from './idempotency'

// W46b (S1): an event says which mode it was made in. Test mode unless a test says live.
function fakeEvent(type: string, object: unknown, livemode = false): Stripe.Event {
  return { id: 'evt_test', type, livemode, data: { object } } as unknown as Stripe.Event
}

function createFakeSupabase(opts: {
  upsertError?: Error
  existing?: { outcome: string | null } | null
  lookupError?: Error
  updateError?: Error
  rpcData?: Record<string, unknown>
  rpcError?: Error
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
  // W46: and invoice.paid, which reads Stripe too.
  const READING_EVENTS: Array<[string, unknown]> = [
    ['customer.subscription.updated', { id: 'sub_1', cancel_at: 1700000000, cancel_at_period_end: false, items: { data: [{ current_period_end: 1700000000 }] } }],
    ['invoice.payment_failed', { billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1' } } }],
    ['invoice.paid', { billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1' } }, lines: { data: [{ period: { end: 1700000000 } }] } }],
  ]

  it.each(READING_EVENTS)('%s: returns 500 and records outcome error, with nothing written, when Stripe cannot be read', async (type, object) => {
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

  // W46 (W45a "Noticed" 3): Stripe answering that it has no such subscription is not a failed read. The event is
  // finished as ignored, with the reason, and answered 200, so Stripe stops sending it; a later delivery is a duplicate.
  // W46b (W46 review S1): for a test-mode event only.
  it.each(READING_EVENTS)('%s, test mode: Stripe has no such subscription (a 404): returns 200 and records outcome ignored with the reason, with nothing written', async (type, object) => {
    const supabase = createFakeSupabase({ existing: { outcome: null }, rpcData: { found: true } })
    const missing = new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code: 'resource_missing', message: "No such subscription: 'sub_1'" })
    const stripe = { subscriptions: { retrieve: vi.fn().mockRejectedValue(missing) } }
    const result = await processWebhookEvent(fakeEvent(type, object, false), supabase, stripe)

    expect(result).toEqual({ status: 200, body: { received: true } })
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(supabase.update).toHaveBeenCalledTimes(1)
    expect(supabase.update).toHaveBeenCalledWith(
      // W47, a named difference: `livemode` (false here) is on the row too.
      expect.objectContaining({ outcome: 'ignored', error: null, detail: { reason: 'subscription_missing', subscription: 'sub_1', message: "No such subscription: 'sub_1'", livemode: false } })
    )
  })

  // W46b (W46 review S1): a live event for a subscription the key in use can't find is the key being the wrong one
  // (the test key at go-live). Answered 200 it would be dropped for good; it is an error, so Stripe sends it again.
  it.each(READING_EVENTS)('%s, live mode: Stripe has no such subscription (a 404): returns 500 and records outcome error, never ignored or processed, with nothing written', async (type, object) => {
    const supabase = createFakeSupabase({ existing: { outcome: null }, rpcData: { found: true } })
    const missing = new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code: 'resource_missing', message: "No such subscription: 'sub_1'" })
    const stripe = { subscriptions: { retrieve: vi.fn().mockRejectedValue(missing) } }
    const result = await processWebhookEvent(fakeEvent(type, object, true), supabase, stripe)

    expect(result).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(supabase.update).toHaveBeenCalledTimes(1)
    expect(supabase.update).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', error: "No such subscription: 'sub_1'" }))
    expect(supabase.update).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ignored' }))
    expect(supabase.update).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'processed' }))
  })

  // W46 (L8): the read after the write failing is a handler that threw, like the read before it.
  it('returns 500 and records outcome error when the read after the write fails: the event is sent again', async () => {
    const supabase = createFakeSupabase({ existing: { outcome: null }, rpcData: { found: true, action: 'past_due' } })
    const stripe = { subscriptions: { retrieve: vi.fn().mockResolvedValueOnce({ id: 'sub_1', status: 'past_due' }).mockRejectedValue(new Error('stripe unreachable')) } }
    const result = await processWebhookEvent(fakeEvent('invoice.payment_failed', { billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1' } } }), supabase, stripe)

    expect(result).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.update).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', error: 'stripe unreachable' }))
    expect(supabase.update).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'processed' }))
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
