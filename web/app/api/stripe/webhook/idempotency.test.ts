import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Stripe from 'stripe'
import { fixtures, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { webhookClient } from '@/server/rules/testing/webhook'
import type { WebhookStore } from './database'
import { processWebhookEvent } from './idempotency'

// W66 (H8, N1): until W66 these ran against a mocked Supabase client. They now run the webhook's own database steps
// (database.ts) on PGlite with the live schema: the event's row in `stripe_webhook_events` and the four membership
// functions as the live database has them, through the Worker's driver as the role `paddock_worker`. Stripe is a
// stand-in for the one read the handlers make. `webhookClient` is the real store with a record of each function call.

vi.setConfig({ testTimeout: 60_000 })

let database: TestDatabase
beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
})
afterAll(() => database.stop())

// W46b (S1): an event says which mode it was made in. Test mode unless a test says live. Each event its own id.
function fakeEvent(type: string, object: unknown, livemode = false, id = `evt_${crypto.randomUUID()}`): Stripe.Event {
  return { id, type, livemode, data: { object } } as unknown as Stripe.Event
}

/** A member with a subscription of their own, active, next payment 10 December 2026. */
async function member(fields: Record<string, unknown> = {}): Promise<{ id: string; subscription: string }> {
  const { db } = database
  const subscription = `sub_${crypto.randomUUID()}`
  const customer = await fixtures.customer(db)
  const plan = await fixtures.plan(db)
  const id = await fixtures.membership(db, { customer_id: customer, plan_id: plan, billing_frequency: 'monthly', stripe_subscription_id: subscription, next_renewal_date: '2026-12-10', ...fields })
  return { id, subscription }
}

const membershipRow = async (id: string) =>
  (await database.db.query<{ status: string; last_day: string | null; next: string | null }>('SELECT subscription_status AS status, cancel_effective_date::text AS last_day, next_renewal_date::text AS next FROM customer_memberships WHERE id = $1::uuid', [id]))[0]

const eventRows = () => database.db.query<{ event_id: string; outcome: string | null; detail: Record<string, unknown> | null; error: string | null }>('SELECT event_id, outcome, detail, error FROM stripe_webhook_events ORDER BY event_id')

// W45a: Stripe as the handlers read it. These events (a deleted subscription, an unhandled type) make no read.
const NO_READ = { subscriptions: { retrieve: vi.fn().mockRejectedValue(new Error('no read expected')) } }

/** A store whose `step` fails once with `message`, then works: the database away for one call. */
function failingOnce(store: WebhookStore, step: 'claim' | 'outcomeOf' | 'recordOutcome' | 'recordError' | 'rpc', message: string): WebhookStore {
  let failed = false
  const fail = () => {
    failed = true
    return Promise.reject(new Error(message))
  }
  return {
    ...store,
    claim: (...args) => (step === 'claim' && !failed ? fail() : store.claim(...args)),
    outcomeOf: (...args) => (step === 'outcomeOf' && !failed ? fail() : store.outcomeOf(...args)),
    recordOutcome: (...args) => (step === 'recordOutcome' && !failed ? fail() : store.recordOutcome(...args)),
    recordError: (...args) => (step === 'recordError' && !failed ? fail() : store.recordError(...args)),
    rpc: (...args) => (step === 'rpc' && !failed ? fail() : store.rpc(...args)),
  }
}

describe('processWebhookEvent on the live schema (W66)', () => {
  it('processes a fresh event: the membership function writes, and the row records outcome processed with its answer', async () => {
    const { id, subscription } = await member()
    const client = webhookClient(database.db)
    const event = fakeEvent('customer.subscription.deleted', { id: subscription })
    const result = await processWebhookEvent(event, client, NO_READ)

    expect(result).toEqual({ status: 200, body: { received: true } })
    expect(client.calls).toEqual([{ fn: 'membership_mark_cancelled_by_stripe', params: { p_stripe_subscription_id: subscription } }])
    expect(await membershipRow(id)).toMatchObject({ status: 'cancelled' })
    expect(await client.eventRow(event.id)).toEqual({ event_type: 'customer.subscription.deleted', outcome: 'processed', detail: expect.objectContaining({ found: true, action: 'cancelled' }), error: null })
  })

  it('skips a duplicate event whose prior attempt already finished (processed): no function called again, the row unchanged', async () => {
    const { id, subscription } = await member()
    const event = fakeEvent('customer.subscription.deleted', { id: subscription })
    expect(await processWebhookEvent(event, webhookClient(database.db), NO_READ)).toEqual({ status: 200, body: { received: true } })
    const first = await webhookClient(database.db).eventRow(event.id)
    // The member comes back by some other way; the duplicate must not end them again.
    await database.db.query("UPDATE customer_memberships SET subscription_status = 'active', cancel_effective_date = NULL WHERE id = $1::uuid", [id])

    const again = webhookClient(database.db)
    expect(await processWebhookEvent(event, again, NO_READ)).toEqual({ status: 200, body: { received: true, duplicate: true } })
    expect(again.calls).toEqual([])
    expect(await again.eventRow(event.id)).toEqual(first)
    expect(await membershipRow(id)).toMatchObject({ status: 'active', last_day: null })
  })

  it('skips a duplicate event whose prior attempt already finished (ignored)', async () => {
    const event = fakeEvent('charge.succeeded', {})
    expect(await processWebhookEvent(event, webhookClient(database.db), NO_READ)).toEqual({ status: 200, body: { received: true } })
    const client = webhookClient(database.db)
    expect(await client.eventRow(event.id)).toMatchObject({ outcome: 'ignored', detail: { reason: 'unhandled_event_type' } })
    expect(await processWebhookEvent(event, client, NO_READ)).toEqual({ status: 200, body: { received: true, duplicate: true } })
    expect(client.calls).toEqual([])
  })

  it('an event erroring, then sent again: the first records outcome error with nothing written; the second is handled afresh and processed, the function called once in all', async () => {
    const { id, subscription } = await member()
    const event = fakeEvent('customer.subscription.deleted', { id: subscription })
    const first = webhookClient(database.db)
    expect(await processWebhookEvent(event, failingOnce(first, 'rpc', 'the database is away'), NO_READ)).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(await first.eventRow(event.id)).toEqual({ event_type: 'customer.subscription.deleted', outcome: 'error', detail: null, error: 'the database is away' })
    expect(await membershipRow(id)).toMatchObject({ status: 'active' })

    const second = webhookClient(database.db)
    expect(await processWebhookEvent(event, second, NO_READ)).toEqual({ status: 200, body: { received: true } })
    expect(second.calls).toHaveLength(1)
    expect(await second.eventRow(event.id)).toMatchObject({ outcome: 'processed', error: null, detail: { action: 'cancelled' } })
    expect(await membershipRow(id)).toMatchObject({ status: 'cancelled' })
  })

  it('the membership function itself failing in the database (an error from Postgres): outcome error, the event retryable, nothing half written', async () => {
    const { id, subscription } = await member()
    const event = fakeEvent('invoice.payment_failed', { id: 'in_1', billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription } } })
    const stripe = { subscriptions: { retrieve: vi.fn().mockResolvedValue({ id: subscription, status: 'past_due' }) } }
    // The function's own UPDATE of the membership is refused by Postgres (a trigger for this test): the whole call
    // rolls back, as it did through PostgREST.
    await database.pg.exec(`
      RESET ROLE;
      CREATE FUNCTION public.w66_refuse_membership_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'membership write refused for the test'; END $$;
      CREATE TRIGGER w66_refuse BEFORE UPDATE ON public.customer_memberships FOR EACH ROW
        WHEN (OLD.stripe_subscription_id = '${subscription}') EXECUTE FUNCTION public.w66_refuse_membership_write();
      SET ROLE paddock_worker;`)
    try {
      expect(await processWebhookEvent(event, webhookClient(database.db), stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
    } finally {
      await database.pg.exec('RESET ROLE; DROP TRIGGER w66_refuse ON public.customer_memberships; DROP FUNCTION public.w66_refuse_membership_write(); SET ROLE paddock_worker;')
    }
    const row = await webhookClient(database.db).eventRow(event.id)
    expect(row).toMatchObject({ outcome: 'error', detail: null })
    expect(row?.error).toMatch(/membership write refused for the test/)
    expect(await membershipRow(id)).toMatchObject({ status: 'active' })

    expect(await processWebhookEvent(event, webhookClient(database.db), stripe)).toEqual({ status: 200, body: { received: true } })
    expect(await membershipRow(id)).toMatchObject({ status: 'past_due' })
  })

  it('retries an event whose prior attempt never finished (outcome null)', async () => {
    const { id, subscription } = await member()
    const event = fakeEvent('customer.subscription.deleted', { id: subscription })
    await database.db.query('INSERT INTO stripe_webhook_events (event_id, event_type) VALUES ($1, $2)', [event.id, event.type])
    const client = webhookClient(database.db)
    expect(await processWebhookEvent(event, client, NO_READ)).toEqual({ status: 200, body: { received: true } })
    expect(client.calls).toHaveLength(1)
    expect(await membershipRow(id)).toMatchObject({ status: 'cancelled' })
  })

  it('an error leaves the detail of an earlier attempt as it was, as the client\'s update did (only the fields given)', async () => {
    const { subscription } = await member()
    const event = fakeEvent('customer.subscription.deleted', { id: subscription })
    await database.db.query(`INSERT INTO stripe_webhook_events (event_id, event_type, outcome, detail) VALUES ($1, $2, 'error', '{"earlier": true}'::jsonb)`, [event.id, event.type])
    expect(await processWebhookEvent(event, failingOnce(webhookClient(database.db), 'rpc', 'away again'), NO_READ)).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(await webhookClient(database.db).eventRow(event.id)).toMatchObject({ outcome: 'error', detail: { earlier: true }, error: 'away again' })
  })

  it('a handler answering no detail records SQL NULL, never the JSON value null', async () => {
    const event = fakeEvent('customer.subscription.deleted', { id: `sub_${crypto.randomUUID()}` })
    // No membership has the subscription: the function answers found false and the event is ignored with that answer.
    expect(await processWebhookEvent(event, webhookClient(database.db), NO_READ)).toEqual({ status: 200, body: { received: true } })
    expect(await webhookClient(database.db).eventRow(event.id)).toMatchObject({ outcome: 'ignored', detail: { found: false } })
    const store = webhookClient(database.db)
    await store.recordOutcome(event.id, { processedAt: new Date().toISOString(), outcome: 'ignored', detail: null })
    const [kind] = await database.db.query<{ kind: string | null }>('SELECT jsonb_typeof(detail) AS kind FROM stripe_webhook_events WHERE event_id = $1', [event.id])
    expect(kind).toEqual({ kind: null })
  })

  it('each event\'s outcome is written on its own row and no other', async () => {
    const one = await member()
    const two = await member()
    const first = fakeEvent('customer.subscription.deleted', { id: one.subscription })
    const second = fakeEvent('charge.succeeded', {})
    const third = fakeEvent('customer.subscription.deleted', { id: two.subscription })
    await processWebhookEvent(first, webhookClient(database.db), NO_READ)
    await processWebhookEvent(second, webhookClient(database.db), NO_READ)
    expect(await processWebhookEvent(third, failingOnce(webhookClient(database.db), 'rpc', 'third away'), NO_READ)).toEqual({ status: 500, body: { error: 'Internal server error' } })
    const rows = new Map((await eventRows()).map((row) => [row.event_id, row]))
    expect(rows.get(first.id)).toMatchObject({ outcome: 'processed', detail: { action: 'cancelled' }, error: null })
    expect(rows.get(second.id)).toMatchObject({ outcome: 'ignored', detail: { reason: 'unhandled_event_type' }, error: null })
    expect(rows.get(third.id)).toMatchObject({ outcome: 'error', detail: null, error: 'third away' })
  })

  // W45a (W45 audit S1): the handler's read of Stripe failing is a handler that threw. The event must never be
  // recorded as processed or ignored: it stays an error, and Stripe's next delivery is handled afresh.
  // W46: and invoice.paid, which reads Stripe too.
  const READING_EVENTS: Array<[string, (subscription: string) => unknown]> = [
    ['customer.subscription.updated', (subscription) => ({ id: subscription, cancel_at: 1700000000, cancel_at_period_end: false, items: { data: [{ current_period_end: 1700000000 }] } })],
    ['invoice.payment_failed', (subscription) => ({ id: 'in_1', billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription } } })],
    ['invoice.paid', (subscription) => ({ id: 'in_1', billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription } }, lines: { data: [{ period: { end: 1700000000 } }] } })],
  ]

  it.each(READING_EVENTS)('%s: returns 500 and records outcome error, with nothing written, when Stripe cannot be read', async (type, object) => {
    const { id, subscription } = await member()
    const client = webhookClient(database.db)
    const stripe = { subscriptions: { retrieve: vi.fn().mockRejectedValue(new Error('stripe unreachable')) } }
    const event = fakeEvent(type, object(subscription))
    expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith(subscription)
    expect(client.calls).toEqual([])
    expect(await client.eventRow(event.id)).toEqual({ event_type: type, outcome: 'error', detail: null, error: 'stripe unreachable' })
    expect(await membershipRow(id)).toEqual({ status: 'active', last_day: null, next: '2026-12-10' })
  })

  // W46 (W45a "Noticed" 3): Stripe answering that it has no such subscription is not a failed read. The event is
  // finished as ignored, with the reason, and answered 200, so Stripe stops sending it; a later delivery is a duplicate.
  // W46b (W46 review S1): for a test-mode event only.
  it.each(READING_EVENTS)('%s, test mode: Stripe has no such subscription (a 404): returns 200 and records outcome ignored with the reason, with nothing written', async (type, object) => {
    const { id, subscription } = await member()
    const client = webhookClient(database.db)
    const missing = new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code: 'resource_missing', message: `No such subscription: '${subscription}'` })
    const event = fakeEvent(type, object(subscription), false)
    expect(await processWebhookEvent(event, client, { subscriptions: { retrieve: vi.fn().mockRejectedValue(missing) } })).toEqual({ status: 200, body: { received: true } })
    expect(client.calls).toEqual([])
    // W47, a named difference: `livemode` (false here) is on the row too.
    expect(await client.eventRow(event.id)).toEqual({ event_type: type, outcome: 'ignored', error: null, detail: { reason: 'subscription_missing', subscription, message: `No such subscription: '${subscription}'`, livemode: false } })
    expect(await processWebhookEvent(event, client, NO_READ)).toEqual({ status: 200, body: { received: true, duplicate: true } })
    expect(await membershipRow(id)).toEqual({ status: 'active', last_day: null, next: '2026-12-10' })
  })

  // W46b (W46 review S1): a live event for a subscription the key in use can't find is the key being the wrong one
  // (the test key at go-live). Answered 200 it would be dropped for good; it is an error, so Stripe sends it again.
  it.each(READING_EVENTS)('%s, live mode: Stripe has no such subscription (a 404): returns 500 and records outcome error, never ignored or processed, with nothing written', async (type, object) => {
    const { subscription } = await member()
    const client = webhookClient(database.db)
    const missing = new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code: 'resource_missing', message: `No such subscription: '${subscription}'` })
    const event = fakeEvent(type, object(subscription), true)
    expect(await processWebhookEvent(event, client, { subscriptions: { retrieve: vi.fn().mockRejectedValue(missing) } })).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(client.calls).toEqual([])
    expect(await client.eventRow(event.id)).toEqual({ event_type: type, outcome: 'error', detail: null, error: `No such subscription: '${subscription}'` })
  })

  // W46 (L8): the read after the write failing is a handler that threw, like the read before it.
  it('returns 500 and records outcome error when the read after the write fails: the write stands and the event is sent again', async () => {
    const { id, subscription } = await member()
    const client = webhookClient(database.db)
    const stripe = { subscriptions: { retrieve: vi.fn().mockResolvedValueOnce({ id: subscription, status: 'past_due' }).mockRejectedValue(new Error('stripe unreachable')) } }
    const event = fakeEvent('invoice.payment_failed', { id: 'in_1', billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription } } })
    expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(client.calls).toHaveLength(1)
    expect(await client.eventRow(event.id)).toMatchObject({ outcome: 'error', error: 'stripe unreachable' })
    expect(await membershipRow(id)).toMatchObject({ status: 'past_due' })
  })

  it('returns 500 when claiming the event row itself fails: no row, no function called', async () => {
    const { id, subscription } = await member()
    const client = webhookClient(database.db)
    const event = fakeEvent('customer.subscription.deleted', { id: subscription })
    expect(await processWebhookEvent(event, failingOnce(client, 'claim', 'insert failed'), NO_READ)).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(client.calls).toEqual([])
    expect(await client.eventRow(event.id)).toBeNull()
    expect(await membershipRow(id)).toMatchObject({ status: 'active' })
  })

  it('returns 500 when the row cannot be read back after the claim: no function called, the row left unfinished', async () => {
    const { subscription } = await member()
    const client = webhookClient(database.db)
    const event = fakeEvent('customer.subscription.deleted', { id: subscription })
    expect(await processWebhookEvent(event, failingOnce(client, 'outcomeOf', 'select failed'), NO_READ)).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(client.calls).toEqual([])
    expect(await client.eventRow(event.id)).toMatchObject({ outcome: null })
  })

  it('the outcome failing to record after the handler wrote: still answered 200 (as before W66), the row left unfinished, so a delivery sent again is handled afresh', async () => {
    const { id, subscription } = await member()
    const client = webhookClient(database.db)
    const event = fakeEvent('customer.subscription.deleted', { id: subscription })
    expect(await processWebhookEvent(event, failingOnce(client, 'recordOutcome', 'update failed'), NO_READ)).toEqual({ status: 200, body: { received: true } })
    expect(client.calls).toHaveLength(1)
    expect(await client.eventRow(event.id)).toMatchObject({ outcome: null })
    expect(await membershipRow(id)).toMatchObject({ status: 'cancelled' })
  })

  it('the error failing to record: still answered 500, so Stripe sends it again', async () => {
    const { subscription } = await member()
    const event = fakeEvent('customer.subscription.deleted', { id: subscription })
    const store = failingOnce(failingOnce(webhookClient(database.db), 'rpc', 'away'), 'recordError', 'update failed too')
    expect(await processWebhookEvent(event, store, NO_READ)).toEqual({ status: 500, body: { error: 'Internal server error' } })
    expect(await webhookClient(database.db).eventRow(event.id)).toMatchObject({ outcome: null })
  })
})
