import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest'
import Stripe from 'stripe'
import { fixtures, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { membershipFunctions } from './database'
import { dispatchStripeEvent, MOST_WRITES_AGAIN, type RpcClient, type SubscriptionReader } from './dispatch'

// W66 (H8, N1): until W66 the database functions here were a mock that answered whatever each test chose. They are
// now the four membership functions as the live database has them (live-schema.sql), on PGlite, through the
// webhook's own calls (database.ts, membershipFunctions) as the role `paddock_worker`. Before each test the
// subscriptions these tests name belong to fresh members (active, no last day, next payment 10 December 2026), so
// every answer below is the function's real one. Stripe is still a stand-in for the one read the handlers make.
vi.setConfig({ testTimeout: 60_000 })

let database: TestDatabase
beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
})
afterAll(() => database.stop())

/** The subscriptions these tests name. `sub_unknown` and `sub_gone` are nobody's. */
const MEMBERS = ['sub_123', 'sub_456', 'sub_789', 'sub_999', 'sub_1']

beforeEach(async () => {
  const { db } = database
  for (const subscription of MEMBERS) {
    // The last test's member keeps its rows (its credit periods name it) under another subscription id.
    await db.query("UPDATE customer_memberships SET stripe_subscription_id = stripe_subscription_id || '_before_' || gen_random_uuid()::text WHERE stripe_subscription_id = $1", [subscription])
    const customer = await fixtures.customer(db)
    const plan = await fixtures.plan(db)
    await fixtures.membership(db, { customer_id: customer, plan_id: plan, billing_frequency: 'monthly', stripe_subscription_id: subscription, next_renewal_date: '2026-12-10' })
  }
})

/** The membership of a subscription, as the functions left it. */
const memberRow = async (subscription: string) =>
  (await database.db.query<{ status: string; last_day: string | null; next: string | null }>('SELECT subscription_status AS status, cancel_effective_date::text AS last_day, next_renewal_date::text AS next FROM customer_memberships WHERE stripe_subscription_id = $1', [subscription]))[0]

// W46b (S1): an event says which mode it was made in. Test mode unless a test says live.
function fakeEvent(type: string, object: unknown, livemode = false): Stripe.Event {
  return { id: 'evt_test', type, livemode, data: { object } } as unknown as Stripe.Event
}

/** The real functions on the test's database, each call recorded. */
function databaseFunctions(): RpcClient & { rpc: ReturnType<typeof vi.fn> } {
  const real = membershipFunctions(database.db)
  return { rpc: vi.fn((fn: string, params?: Record<string, unknown>) => real.rpc(fn, params)) }
}

/** The real functions, with call number `failing` (1 = the first) answered as a database failure. */
function failingCall(failing: number, error: Error): RpcClient & { rpc: ReturnType<typeof vi.fn> } {
  const real = membershipFunctions(database.db)
  let calls = 0
  return { rpc: vi.fn((fn: string, params?: Record<string, unknown>) => (++calls === failing ? Promise.resolve({ data: null, error }) : real.rpc(fn, params))) }
}

// W45a: Stripe as the handlers read it. `showing` is the subscription as Stripe holds it now, which is what must be
// written, whatever the event carries. With nothing given, any read fails the test's expectations on it.
// W46 (L8): with several given, each read answers the next and the last one stays: the subscription changing between
// a handler's reads.
function fakeStripe(...showing: unknown[]): SubscriptionReader & { subscriptions: { retrieve: ReturnType<typeof vi.fn> } } {
  if (showing.length === 0) return { subscriptions: { retrieve: vi.fn().mockRejectedValue(new Error('no read expected')) } }
  const retrieve = vi.fn()
  showing.forEach((subscription, index) => (index === showing.length - 1 ? retrieve.mockResolvedValue(subscription) : retrieve.mockResolvedValueOnce(subscription)))
  return { subscriptions: { retrieve } }
}

/** Stripe's answer for a subscription the key in use can't find (a 404). */
const noSuchSubscription = (id: string) => new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code: 'resource_missing', message: `No such subscription: '${id}'` })

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()
// W46b (B1): a payment is recorded only for the subscription's newest invoice. `in_1` is the invoice these events are
// for and, unless a test says otherwise, the newest one Stripe shows.
const INVOICE = 'in_1'
/** A marker for "the answer has no latest_invoice on it" (passing undefined would take the default). */
const NONE = Symbol('no latest_invoice')
const paidUp = (id: string, periodEnd: number, status = 'active', latestInvoice: unknown = INVOICE) => ({
  id,
  status,
  ...(latestInvoice === NONE ? {} : { latest_invoice: latestInvoice }),
  items: { data: [{ current_period_end: periodEnd }] },
})
const cycleInvoice = (subscription: string, periodEnd = 1700000000) => ({
  id: INVOICE,
  billing_reason: 'subscription_cycle',
  parent: { subscription_details: { subscription } },
  lines: { data: [{ period: { end: periodEnd } }] },
})

describe('dispatchStripeEvent', () => {
  // W46 (W45a "Noticed" 1): the period end is the subscription's as Stripe has it, not the invoice's line's.
  it.each(['active', 'trialing'])('invoice.paid reads the subscription and, for one Stripe shows as %s, calls membership_mark_paid with its period end as Stripe has it, not the invoice\'s', async (status) => {
    const supabase = databaseFunctions()
    const stripe = fakeStripe(paidUp('sub_123', 1702592000, status))
    const result = await dispatchStripeEvent(fakeEvent('invoice.paid', cycleInvoice('sub_123', 1700000000)), supabase, stripe)

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('membership_mark_paid', {
      p_stripe_subscription_id: 'sub_123',
      p_period_end: iso(1702592000),
    })
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'reactivated', was: 'active', bookings_restored: 0, periods_created: expect.any(Number) } })
    // One read before the write, and (L8) one after it that agrees.
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(2)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_123')
    // Stripe's period end (14 Dec 2023 23:33 London) is the next payment date.
    expect(await memberRow('sub_123')).toEqual({ status: 'active', last_day: null, next: '2023-12-14' })
  })

  it.each(['past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused'])(
    'invoice.paid for a subscription Stripe now shows as %s is ignored without calling the RPC, and says what Stripe showed',
    async (status) => {
      const supabase = databaseFunctions()
      const stripe = fakeStripe(paidUp('sub_123', 1702592000, status))
      const result = await dispatchStripeEvent(fakeEvent('invoice.paid', cycleInvoice('sub_123')), supabase, stripe)

      expect(supabase.rpc).not.toHaveBeenCalled()
      expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'subscription_not_paid_up', status } })
      expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    }
  )

  it('invoice.paid with no period end on the subscription Stripe shows is ignored (the invoice having one changes nothing)', async () => {
    const supabase = databaseFunctions()
    const result = await dispatchStripeEvent(fakeEvent('invoice.paid', cycleInvoice('sub_123')), supabase, fakeStripe({ id: 'sub_123', status: 'active', latest_invoice: INVOICE, items: { data: [] } }))
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'no_period_end' } })
  })

  it('invoice.paid throws when Stripe cannot be read, without calling the RPC: the event is not finished, so it is sent again', async () => {
    const supabase = databaseFunctions()
    const stripe = { subscriptions: { retrieve: vi.fn().mockRejectedValue(new Error('stripe unreachable')) } }
    await expect(dispatchStripeEvent(fakeEvent('invoice.paid', cycleInvoice('sub_123')), supabase, stripe)).rejects.toThrow('stripe unreachable')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('invoice.paid skips the first invoice (billing_reason subscription_create) without reading Stripe or calling the RPC', async () => {
    const supabase = databaseFunctions()
    const invoice = {
      billing_reason: 'subscription_create',
      parent: { subscription_details: { subscription: 'sub_123' } },
      lines: { data: [{ period: { end: 1700000000 } }] },
    }
    const stripe = fakeStripe()
    const result = await dispatchStripeEvent(fakeEvent('invoice.paid', invoice), supabase, stripe)

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'first_invoice' } })
  })

  it.each(['past_due', 'unpaid'])('invoice.payment_failed reads the subscription, and for one Stripe shows as %s calls membership_mark_payment_failed with the resolved subscription id', async (status) => {
    const supabase = databaseFunctions()
    const invoice = {
      billing_reason: 'subscription_cycle',
      parent: { subscription_details: { subscription: 'sub_456' } },
    }
    const stripe = fakeStripe({ id: 'sub_456', status })
    const result = await dispatchStripeEvent(fakeEvent('invoice.payment_failed', invoice), supabase, stripe)

    // One read before the write, and (L8) one after it that agrees.
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(2)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_456')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('membership_mark_payment_failed', {
      p_stripe_subscription_id: 'sub_456',
    })
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'past_due', covered_through: expect.any(String), bookings_flagged: 0 } })
    expect(await memberRow('sub_456')).toMatchObject({ status: 'past_due' })
  })

  // W45a (W45 audit S1): a failure handled after the payment that followed it went through.
  it.each(['active', 'trialing', 'canceled', 'incomplete', 'incomplete_expired', 'paused'])(
    'invoice.payment_failed for a subscription Stripe now shows as %s is ignored without calling the RPC, and says what Stripe showed',
    async (status) => {
      const supabase = databaseFunctions()
      const invoice = { billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_456' } } }
      const stripe = fakeStripe({ id: 'sub_456', status })
      const result = await dispatchStripeEvent(fakeEvent('invoice.payment_failed', invoice), supabase, stripe)

      expect(supabase.rpc).not.toHaveBeenCalled()
      expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'subscription_not_past_due', status } })
      expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    }
  )

  it('invoice.payment_failed throws when Stripe cannot be read, without calling the RPC: the event is not finished, so it is sent again', async () => {
    const supabase = databaseFunctions()
    const invoice = { billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_456' } } }
    const stripe = { subscriptions: { retrieve: vi.fn().mockRejectedValue(new Error('stripe unreachable')) } }
    await expect(dispatchStripeEvent(fakeEvent('invoice.payment_failed', invoice), supabase, stripe)).rejects.toThrow('stripe unreachable')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('invoice.payment_failed skips the first invoice without reading Stripe or calling the RPC', async () => {
    const supabase = databaseFunctions()
    const invoice = { billing_reason: 'subscription_create', parent: { subscription_details: { subscription: 'sub_456' } } }
    const stripe = fakeStripe()
    const result = await dispatchStripeEvent(fakeEvent('invoice.payment_failed', invoice), supabase, stripe)

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'first_invoice' } })
  })

  it('customer.subscription.deleted calls membership_mark_cancelled_by_stripe', async () => {
    const supabase = databaseFunctions()
    const stripe = fakeStripe()
    const result = await dispatchStripeEvent(
      fakeEvent('customer.subscription.deleted', { id: 'sub_789' }),
      supabase,
      stripe
    )

    expect(supabase.rpc).toHaveBeenCalledWith('membership_mark_cancelled_by_stripe', {
      p_stripe_subscription_id: 'sub_789',
    })
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'cancelled', covered_through: expect.any(String), bookings_flagged: 0 } })
    expect(await memberRow('sub_789')).toMatchObject({ status: 'cancelled' })
    // W45a: only the id is taken from the event, and an ended subscription never comes back: no read.
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
  })

  it('customer.subscription.updated reads the subscription and calls membership_sync_cancel_at_period_end with the resolved period end', async () => {
    const supabase = databaseFunctions()
    const subscription = {
      id: 'sub_999',
      cancel_at_period_end: true,
      cancel_at: null,
      items: { data: [{ current_period_end: 1700000000 }] },
    }
    const stripe = fakeStripe(subscription)
    const result = await dispatchStripeEvent(fakeEvent('customer.subscription.updated', subscription), supabase, stripe)

    // One read before the write, and (L8) one after it that agrees.
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(2)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_999')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('membership_sync_cancel_at_period_end', {
      p_stripe_subscription_id: 'sub_999',
      p_cancel_at_period_end: true,
      p_cancel_at: null,
      p_period_end: iso(1700000000),
    })
    // Ending with the period that ends 14 Nov 2023 22:13 London: the last day is the day before.
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'cancel_scheduled', cancel_effective_date: '2023-11-13' } })
    expect(await memberRow('sub_999')).toMatchObject({ last_day: '2023-11-13' })
  })

  it('customer.subscription.updated forwards a set cancel_at as an ISO timestamp', async () => {
    const supabase = databaseFunctions()
    const subscription = {
      id: 'sub_999',
      cancel_at_period_end: false,
      cancel_at: 1700000000,
      items: { data: [{ current_period_end: 1702592000 }] },
    }
    await dispatchStripeEvent(fakeEvent('customer.subscription.updated', subscription), supabase, fakeStripe(subscription))

    expect(supabase.rpc).toHaveBeenCalledWith('membership_sync_cancel_at_period_end', {
      p_stripe_subscription_id: 'sub_999',
      p_cancel_at_period_end: false,
      p_cancel_at: iso(1700000000),
      p_period_end: iso(1702592000),
    })
  })

  // W45a (W45 audit S1): an event handled after a newer one. Each of the three values is Stripe's, not the event's.
  it.each([
    [
      'the event says an end is set, Stripe now shows none',
      { cancel_at_period_end: false, cancel_at: 1700000000, items: { data: [{ current_period_end: 1700000000 }] } },
      { cancel_at_period_end: false, cancel_at: null, items: { data: [{ current_period_end: 1702592000 }] } },
      { p_cancel_at_period_end: false, p_cancel_at: null, p_period_end: iso(1702592000) },
    ],
    [
      'the event says no end, Stripe now shows one',
      { cancel_at_period_end: false, cancel_at: null, items: { data: [{ current_period_end: 1700000000 }] } },
      { cancel_at_period_end: false, cancel_at: 1702592000, items: { data: [{ current_period_end: 1702592000 }] } },
      { p_cancel_at_period_end: false, p_cancel_at: iso(1702592000), p_period_end: iso(1702592000) },
    ],
    [
      'the event says it ends with the period, Stripe now shows it carrying on into the next period',
      { cancel_at_period_end: true, cancel_at: null, items: { data: [{ current_period_end: 1700000000 }] } },
      { cancel_at_period_end: false, cancel_at: null, items: { data: [{ current_period_end: 1702592000 }] } },
      { p_cancel_at_period_end: false, p_cancel_at: null, p_period_end: iso(1702592000) },
    ],
    [
      'the event says it carries on, Stripe now shows it ending with a later period',
      { cancel_at_period_end: false, cancel_at: null, items: { data: [{ current_period_end: 1700000000 }] } },
      { cancel_at_period_end: true, cancel_at: null, items: { data: [{ current_period_end: 1702592000 }] } },
      { p_cancel_at_period_end: true, p_cancel_at: null, p_period_end: iso(1702592000) },
    ],
  ])("customer.subscription.updated passes what Stripe shows now, not the event's snapshot: %s", async (_name, snapshot, showing, passed) => {
    const supabase = databaseFunctions()
    await dispatchStripeEvent(fakeEvent('customer.subscription.updated', { id: 'sub_999', ...snapshot }), supabase, fakeStripe({ id: 'sub_999', ...showing }))

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('membership_sync_cancel_at_period_end', { p_stripe_subscription_id: 'sub_999', ...passed })
  })

  it('customer.subscription.updated throws when Stripe cannot be read, without calling the RPC: nothing is written from the event', async () => {
    const supabase = databaseFunctions()
    const snapshot = { id: 'sub_999', cancel_at_period_end: false, cancel_at: 1700000000, items: { data: [{ current_period_end: 1700000000 }] } }
    const stripe = { subscriptions: { retrieve: vi.fn().mockRejectedValue(new Error('stripe unreachable')) } }
    await expect(dispatchStripeEvent(fakeEvent('customer.subscription.updated', snapshot), supabase, stripe)).rejects.toThrow('stripe unreachable')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('customer.subscription.updated with no period end on the subscription Stripe shows is ignored (the event having one changes nothing)', async () => {
    const supabase = databaseFunctions()
    const snapshot = { id: 'sub_999', cancel_at_period_end: false, cancel_at: null, items: { data: [{ current_period_end: 1700000000 }] } }
    const result = await dispatchStripeEvent(fakeEvent('customer.subscription.updated', snapshot), supabase, fakeStripe({ id: 'sub_999', cancel_at_period_end: false, cancel_at: null, items: { data: [] } }))
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'no_period_end' } })
  })

  // Payment date change (server/rules/memberships/payment-date.ts) sets trial_end on an active
  // subscription. The subscription reports 'trialing' until the new date; these events must keep
  // the membership as it is and move next_renewal_date to the new date.
  const trialEnd = Date.UTC(2026, 11, 25) / 1000 // 25 Dec 2026 00:00 London (GMT)

  it('payment date change: the £0 trial invoice marks paid with the trial end as the period end', async () => {
    const supabase = databaseFunctions()
    const invoice = {
      id: INVOICE,
      billing_reason: 'subscription_update',
      amount_paid: 0,
      parent: { subscription_details: { subscription: 'sub_123' } },
      lines: { data: [{ amount: 0, period: { start: Date.UTC(2026, 10, 29) / 1000, end: trialEnd } }] },
    }
    // Stripe shows the subscription in its no-charge days, to the new date.
    const result = await dispatchStripeEvent(fakeEvent('invoice.paid', invoice), supabase, fakeStripe({ ...paidUp('sub_123', trialEnd, 'trialing'), trial_end: trialEnd }))

    expect(supabase.rpc).toHaveBeenCalledWith('membership_mark_paid', {
      p_stripe_subscription_id: 'sub_123',
      p_period_end: iso(trialEnd),
    })
    expect(result.outcome).toBe('processed')
    expect(await memberRow('sub_123')).toEqual({ status: 'active', last_day: null, next: '2026-12-25' })
  })

  it('payment date change: subscription.updated while trialing only syncs the (cleared) cancellation', async () => {
    const supabase = databaseFunctions()
    const subscription = {
      id: 'sub_123',
      status: 'trialing',
      trial_end: trialEnd,
      cancel_at_period_end: false,
      cancel_at: null,
      items: { data: [{ current_period_end: trialEnd }] },
    }
    const result = await dispatchStripeEvent(fakeEvent('customer.subscription.updated', subscription), supabase, fakeStripe(subscription))

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('membership_sync_cancel_at_period_end', {
      p_stripe_subscription_id: 'sub_123',
      p_cancel_at_period_end: false,
      p_cancel_at: null,
      p_period_end: iso(trialEnd),
    })
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'unchanged', cancel_effective_date: null } })
  })

  it('payment date change: the first full invoice on the new date marks paid for the month after it', async () => {
    const supabase = databaseFunctions()
    const nextPeriodEnd = Date.UTC(2027, 0, 25) / 1000
    const invoice = {
      id: INVOICE,
      billing_reason: 'subscription_cycle',
      parent: { subscription_details: { subscription: 'sub_123' } },
      lines: { data: [{ period: { start: trialEnd, end: nextPeriodEnd } }] },
    }
    await dispatchStripeEvent(fakeEvent('invoice.paid', invoice), supabase, fakeStripe(paidUp('sub_123', nextPeriodEnd)))

    expect(supabase.rpc).toHaveBeenCalledWith('membership_mark_paid', {
      p_stripe_subscription_id: 'sub_123',
      p_period_end: iso(nextPeriodEnd),
    })
    expect(await memberRow('sub_123')).toMatchObject({ next: '2027-01-25' })
  })

  // W46 (W45a "Noticed" 1) had the £0 invoice's event, handled after the first full payment on the new date went
  // through, write the period Stripe was in. W46b (W46 review B1): the £0 invoice is not the newest by then, so its
  // event is ignored; the full payment's own event writes that date (the test above).
  it("payment date change: the £0 trial invoice handled late, after the first full payment, is ignored: it is not the subscription's newest invoice", async () => {
    const supabase = databaseFunctions()
    const nextPeriodEnd = Date.UTC(2027, 0, 25) / 1000
    const invoice = {
      id: INVOICE,
      billing_reason: 'subscription_update',
      amount_paid: 0,
      parent: { subscription_details: { subscription: 'sub_123' } },
      lines: { data: [{ amount: 0, period: { start: Date.UTC(2026, 10, 29) / 1000, end: trialEnd } }] },
    }
    const stripe = fakeStripe(paidUp('sub_123', nextPeriodEnd, 'active', 'in_full_payment'))
    const result = await dispatchStripeEvent(fakeEvent('invoice.paid', invoice), supabase, stripe)

    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'not_latest_invoice' } })
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
  })

  it('ignores event types that are not handled, without calling the RPC', async () => {
    const supabase = databaseFunctions()
    const stripe = fakeStripe()
    const result = await dispatchStripeEvent(fakeEvent('charge.succeeded', {}), supabase, stripe)

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'unhandled_event_type' } })
  })

  it('treats an RPC result of found:false as ignored (no membership has the subscription)', async () => {
    const supabase = databaseFunctions()
    const result = await dispatchStripeEvent(
      fakeEvent('customer.subscription.deleted', { id: 'sub_unknown' }),
      supabase,
      fakeStripe()
    )

    expect(result).toEqual({ outcome: 'ignored', detail: { found: false } })
  })

  it('throws when the RPC call itself returns an error', async () => {
    const supabase = failingCall(1, new Error('db exploded'))
    await expect(
      dispatchStripeEvent(fakeEvent('customer.subscription.deleted', { id: 'sub_789' }), supabase, fakeStripe())
    ).rejects.toThrow('db exploded')
    expect(await memberRow('sub_789')).toMatchObject({ status: 'active' })
  })

  // W66: a name or argument the database doesn't have is refused before anything is sent (as PostgREST refused it).
  it('a function the webhook does not call, or the wrong arguments, is answered as an error and nothing runs', async () => {
    const functions = membershipFunctions(database.db)
    expect((await functions.rpc('membership_mark_everything', { p_stripe_subscription_id: 'sub_1' })).error).toBeInstanceOf(Error)
    expect((await functions.rpc('membership_mark_paid', { p_stripe_subscription_id: 'sub_1' })).error).toBeInstanceOf(Error)
    expect(await memberRow('sub_1')).toEqual({ status: 'active', last_day: null, next: '2026-12-10' })
  })
})

// W46b (W46 review B1): the hour Stripe holds a renewal's invoice as a draft. The subscription reads active with its
// period already moved on, and its newest invoice is the draft. An invoice.paid for any other invoice is not recorded.
describe("dispatchStripeEvent: invoice.paid records a payment only for the subscription's newest invoice (W46b)", () => {
  it.each(['active', 'trialing'])('a subscription Stripe shows as %s with a newer invoice than the event\'s: ignored as not_latest_invoice after one read, without calling the RPC', async (status) => {
    const supabase = databaseFunctions()
    const stripe = fakeStripe(paidUp('sub_123', 1702592000, status, 'in_draft'))
    const result = await dispatchStripeEvent(fakeEvent('invoice.paid', cycleInvoice('sub_123')), supabase, stripe)

    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'not_latest_invoice' } })
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no newest invoice at all', null],
    ['none on the answer', NONE],
    ["an expanded invoice with another id", { id: 'in_draft', object: 'invoice' }],
    ["the subscription's own id (never an invoice's)", 'sub_123'],
  ])('Stripe shows %s: ignored as not_latest_invoice', async (_name, latestInvoice) => {
    const supabase = databaseFunctions()
    const result = await dispatchStripeEvent(fakeEvent('invoice.paid', cycleInvoice('sub_123')), supabase, fakeStripe(paidUp('sub_123', 1702592000, 'active', latestInvoice)))
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'not_latest_invoice' } })
  })

  it("an event whose invoice has no id is never the newest: ignored, even when Stripe shows no newest invoice either", async () => {
    const noId = Object.fromEntries(Object.entries(cycleInvoice('sub_123')).filter(([field]) => field !== 'id'))
    expect(noId).not.toHaveProperty('id')
    for (const latestInvoice of [INVOICE, NONE, null, '']) {
      const supabase = databaseFunctions()
      const result = await dispatchStripeEvent(fakeEvent('invoice.paid', noId), supabase, fakeStripe(paidUp('sub_123', 1702592000, 'active', latestInvoice)))
      expect(supabase.rpc).not.toHaveBeenCalled()
      expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'not_latest_invoice' } })
    }
  })

  it('the newest invoice answered expanded (an object) with the event\'s id is the same invoice: the payment is recorded', async () => {
    const supabase = databaseFunctions()
    const result = await dispatchStripeEvent(fakeEvent('invoice.paid', cycleInvoice('sub_123')), supabase, fakeStripe(paidUp('sub_123', 1702592000, 'active', { id: INVOICE, object: 'invoice' })))
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('membership_mark_paid', { p_stripe_subscription_id: 'sub_123', p_period_end: iso(1702592000) })
    expect(result.outcome).toBe('processed')
  })

  it('a subscription behind on its payment is still answered subscription_not_paid_up, whichever invoice is its newest', async () => {
    for (const latestInvoice of [INVOICE, 'in_draft']) {
      const supabase = databaseFunctions()
      const result = await dispatchStripeEvent(fakeEvent('invoice.paid', cycleInvoice('sub_123')), supabase, fakeStripe(paidUp('sub_123', 1702592000, 'past_due', latestInvoice)))
      expect(supabase.rpc).not.toHaveBeenCalled()
      expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'subscription_not_paid_up', status: 'past_due' } })
    }
  })

  it('invoice.payment_failed does not look at the newest invoice before its write: a subscription behind on its payment is marked', async () => {
    const supabase = databaseFunctions()
    const invoice = { id: INVOICE, billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_456' } } }
    const result = await dispatchStripeEvent(fakeEvent('invoice.payment_failed', invoice), supabase, fakeStripe({ id: 'sub_456', status: 'past_due', latest_invoice: 'in_newer' }))
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('membership_mark_payment_failed', { p_stripe_subscription_id: 'sub_456' })
    expect(result.outcome).toBe('processed')
  })
})

// W46 (W45a "Noticed" 3): Stripe answering "no such subscription" is an answer. The event is ignored with the reason,
// so it is not sent again for three days; any other failed read is still an error.
// W46b (W46 review S1): only for a test-mode event. For a live event it is an error like any other: Stripe signed the
// event for a subscription it has, so the key in use is the wrong one, and the event must be sent again.
describe('dispatchStripeEvent: a subscription Stripe cannot find (W46, W46b)', () => {
  const events: Array<[string, unknown]> = [
    ['invoice.paid', cycleInvoice('sub_gone')],
    ['invoice.payment_failed', { id: INVOICE, billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_gone' } } }],
    ['customer.subscription.updated', { id: 'sub_gone', cancel_at_period_end: false, cancel_at: 1700000000, items: { data: [{ current_period_end: 1700000000 }] } }],
  ]

  it.each(events)('%s, test mode: a 404 on the read is ignored with the reason and the subscription, and no database function is called', async (type, object) => {
    const supabase = databaseFunctions()
    const stripe = { subscriptions: { retrieve: vi.fn().mockRejectedValue(noSuchSubscription('sub_gone')) } }
    const result = await dispatchStripeEvent(fakeEvent(type, object, false), supabase, stripe)

    // W47, a named difference: the row also says which mode the event was (false: a test-mode one), for the banner.
    expect(result).toEqual({ outcome: 'ignored', detail: { reason: 'subscription_missing', subscription: 'sub_gone', message: "No such subscription: 'sub_gone'", livemode: false } })
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it.each(events)('%s, live mode: a 404 on the read is an error: it throws Stripe\'s own error, and no database function is called', async (type, object) => {
    const supabase = databaseFunctions()
    const error = noSuchSubscription('sub_gone')
    const stripe = { subscriptions: { retrieve: vi.fn().mockRejectedValue(error) } }
    await expect(dispatchStripeEvent(fakeEvent(type, object, true), supabase, stripe)).rejects.toBe(error)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  // Only `false` is test mode: an event with no mode on it, or anything else there, is held as live.
  it.each([
    ['no livemode on the event', undefined],
    ['null', null],
    ["the word 'false'", 'false'],
    ['0', 0],
  ])('%s: a 404 is an error, as for a live event', async (_name, livemode) => {
    for (const [type, object] of events) {
      const supabase = databaseFunctions()
      const error = noSuchSubscription('sub_gone')
      const event = { id: 'evt_test', type, data: { object }, ...(livemode === undefined ? {} : { livemode }) } as unknown as Stripe.Event
      await expect(dispatchStripeEvent(event, supabase, { subscriptions: { retrieve: vi.fn().mockRejectedValue(error) } })).rejects.toBe(error)
      expect(supabase.rpc).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['a Stripe error with another code', new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code: 'parameter_invalid_empty', message: 'Bad request' })],
    ['a 500 from Stripe', new Stripe.errors.StripeAPIError({ type: 'api_error', message: 'An error occurred with our API.' })],
    ["an error that isn't Stripe's whose message says resource_missing", new Error('resource_missing')],
  ])('%s is still an error in either mode: it throws, and nothing is written', async (_name, error) => {
    for (const livemode of [false, true]) {
      for (const [type, object] of events) {
        const supabase = databaseFunctions()
        const stripe = { subscriptions: { retrieve: vi.fn().mockRejectedValue(error) } }
        await expect(dispatchStripeEvent(fakeEvent(type, object, livemode), supabase, stripe)).rejects.toBe(error)
        expect(supabase.rpc).not.toHaveBeenCalled()
      }
    }
  })

  it('test mode, a 404 on the read after the write: the write stands, the event is processed, and the answer says the second read found no subscription', async () => {
    const supabase = databaseFunctions()
    const retrieve = vi.fn().mockResolvedValueOnce({ id: 'sub_456', status: 'past_due' }).mockRejectedValue(noSuchSubscription('sub_456'))
    const invoice = { id: INVOICE, billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_456' } } }
    const result = await dispatchStripeEvent(fakeEvent('invoice.payment_failed', invoice, false), supabase, { subscriptions: { retrieve } })

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(retrieve).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'past_due', covered_through: expect.any(String), bookings_flagged: 0, read_again: 'subscription_missing' } })
    expect(await memberRow('sub_456')).toMatchObject({ status: 'past_due' })
  })

  it('live mode, a 404 on the read after the write: it throws, so the event is an error and is sent again (the write stands, and is made again then)', async () => {
    const supabase = databaseFunctions()
    const error = noSuchSubscription('sub_456')
    const retrieve = vi.fn().mockResolvedValueOnce({ id: 'sub_456', status: 'past_due' }).mockRejectedValue(error)
    const invoice = { id: INVOICE, billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_456' } } }
    await expect(dispatchStripeEvent(fakeEvent('invoice.payment_failed', invoice, true), supabase, { subscriptions: { retrieve } })).rejects.toBe(error)
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(retrieve).toHaveBeenCalledTimes(2)
  })
})

// W46 (lead call L8; W45a "Noticed" 2): the read and the write are not one step, so each write is followed by a read,
// and what Stripe then shows is written if it is something else.
describe('dispatchStripeEvent: the subscription is read again after the write (W46, L8)', () => {
  const failedInvoice = { id: INVOICE, billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1' } } }
  const updated = (cancelAt: number | null, periodEnd = 1702592000) => ({ id: 'sub_1', status: 'active', cancel_at_period_end: false, cancel_at: cancelAt, items: { data: [{ current_period_end: periodEnd }] } })
  const syncParams = (cancelAt: number | null, periodEnd = 1702592000) => ({ p_stripe_subscription_id: 'sub_1', p_cancel_at_period_end: false, p_cancel_at: cancelAt === null ? null : iso(cancelAt), p_period_end: iso(periodEnd) })

  it('customer.subscription.updated: Stripe changes between the read and the write: the first values are written, then the ones Stripe shows after, and a third read agrees', async () => {
    const supabase = databaseFunctions()
    const stripe = fakeStripe(updated(1700000000), updated(null))
    const result = await dispatchStripeEvent(fakeEvent('customer.subscription.updated', updated(1700000000)), supabase, stripe)

    expect(supabase.rpc.mock.calls).toEqual([
      ['membership_sync_cancel_at_period_end', syncParams(1700000000)],
      ['membership_sync_cancel_at_period_end', syncParams(null)],
    ])
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'cancel_cleared', cancel_effective_date: null, written_again: 1, last_write: 'membership_sync_cancel_at_period_end' } })
    expect(await memberRow('sub_1')).toMatchObject({ last_day: null })
  })

  it.each([
    ['cancel_at', updated(1700000000), updated(1700086400)],
    ['cancel_at_period_end', updated(null), { ...updated(null), cancel_at_period_end: true }],
    ['the period end', updated(null, 1700000000), updated(null, 1702592000)],
  ])('customer.subscription.updated: a change to %s alone between the read and the write is written again', async (_name, first, second) => {
    const supabase = databaseFunctions()
    await dispatchStripeEvent(fakeEvent('customer.subscription.updated', first), supabase, fakeStripe(first, second))
    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })

  it('invoice.payment_failed: the payment goes through between the read and the write: marked past due, then the payment recorded with the period end Stripe shows', async () => {
    const supabase = databaseFunctions()
    const stripe = fakeStripe({ id: 'sub_1', status: 'past_due' }, paidUp('sub_1', 1702592000))
    const result = await dispatchStripeEvent(fakeEvent('invoice.payment_failed', failedInvoice), supabase, stripe)

    expect(supabase.rpc.mock.calls).toEqual([
      ['membership_mark_payment_failed', { p_stripe_subscription_id: 'sub_1' }],
      ['membership_mark_paid', { p_stripe_subscription_id: 'sub_1', p_period_end: iso(1702592000) }],
    ])
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'reactivated', was: 'past_due', bookings_restored: 0, periods_created: expect.any(Number), written_again: 1, last_write: 'membership_mark_paid' } })
    expect(await memberRow('sub_1')).toMatchObject({ status: 'active', next: '2023-12-14' })
  })

  it('invoice.paid: a later payment fails between the read and the write: the payment recorded, then the member marked past due', async () => {
    const supabase = databaseFunctions()
    const stripe = fakeStripe(paidUp('sub_1', 1700000000, 'trialing'), { id: 'sub_1', status: 'past_due', items: { data: [{ current_period_end: 1702592000 }] } })
    const result = await dispatchStripeEvent(fakeEvent('invoice.paid', cycleInvoice('sub_1')), supabase, stripe)

    expect(supabase.rpc.mock.calls).toEqual([
      ['membership_mark_paid', { p_stripe_subscription_id: 'sub_1', p_period_end: iso(1700000000) }],
      ['membership_mark_payment_failed', { p_stripe_subscription_id: 'sub_1' }],
    ])
    expect(result.detail).toMatchObject({ written_again: 1, last_write: 'membership_mark_payment_failed' })
    expect(await memberRow('sub_1')).toMatchObject({ status: 'past_due' })
  })

  // W46 wrote the later period end here whatever invoice it belonged to. W46b (W46 review B1): only while the event's
  // invoice is still the newest.
  it("invoice.paid: Stripe shows a later period end after the write, with the event's invoice still its newest: the later period end is written too", async () => {
    const supabase = databaseFunctions()
    await dispatchStripeEvent(fakeEvent('invoice.paid', cycleInvoice('sub_1')), supabase, fakeStripe(paidUp('sub_1', 1700000000), paidUp('sub_1', 1702592000)))
    expect(supabase.rpc.mock.calls.map((call) => call[1])).toEqual([
      { p_stripe_subscription_id: 'sub_1', p_period_end: iso(1700000000) },
      { p_stripe_subscription_id: 'sub_1', p_period_end: iso(1702592000) },
    ])
  })

  it.each(['active', 'trialing'])("invoice.paid: the subscription renews between the read and the write (the next renewal's draft hour: %s, the period moved on, a draft its newest invoice): the renewal's date is not written; the write stands, after two reads", async (status) => {
    const supabase = databaseFunctions()
    const stripe = fakeStripe(paidUp('sub_1', 1700000000), paidUp('sub_1', 1702592000, status, 'in_draft'))
    const result = await dispatchStripeEvent(fakeEvent('invoice.paid', cycleInvoice('sub_1')), supabase, stripe)
    expect(supabase.rpc.mock.calls).toEqual([['membership_mark_paid', { p_stripe_subscription_id: 'sub_1', p_period_end: iso(1700000000) }]])
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'reactivated', was: 'active', bookings_restored: 0, periods_created: expect.any(Number) } })
    expect(await memberRow('sub_1')).toMatchObject({ next: '2023-11-14' })
  })

  it("invoice.payment_failed: Stripe shows the subscription paid up after the write with a newer invoice than the one that failed: no payment is recorded from this event; the write stands", async () => {
    const supabase = databaseFunctions()
    const stripe = fakeStripe({ id: 'sub_1', status: 'past_due', latest_invoice: INVOICE }, paidUp('sub_1', 1702592000, 'active', 'in_draft'))
    const result = await dispatchStripeEvent(fakeEvent('invoice.payment_failed', failedInvoice), supabase, stripe)
    expect(supabase.rpc.mock.calls).toEqual([['membership_mark_payment_failed', { p_stripe_subscription_id: 'sub_1' }]])
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'past_due', covered_through: expect.any(String), bookings_flagged: 0 } })
  })

  it("invoice.paid: a newer invoice fails between the read and the write: the member is marked past due, whichever invoice is then the newest", async () => {
    const supabase = databaseFunctions()
    const stripe = fakeStripe(paidUp('sub_1', 1700000000), paidUp('sub_1', 1702592000, 'past_due', 'in_draft'))
    await dispatchStripeEvent(fakeEvent('invoice.paid', cycleInvoice('sub_1')), supabase, stripe)
    expect(supabase.rpc.mock.calls.map((call) => call[0])).toEqual(['membership_mark_paid', 'membership_mark_payment_failed'])
  })

  it.each(['canceled', 'incomplete_expired', 'paused'])('invoice.payment_failed: Stripe shows %s after the write: nothing more is written (an ended subscription has its own event)', async (status) => {
    const supabase = databaseFunctions()
    const stripe = fakeStripe({ id: 'sub_1', status: 'past_due' }, { id: 'sub_1', status })
    const result = await dispatchStripeEvent(fakeEvent('invoice.payment_failed', failedInvoice), supabase, stripe)
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'past_due', covered_through: expect.any(String), bookings_flagged: 0 } })
  })

  it.each([
    ['no membership has the subscription', { found: false }, 'ignored'],
    ['the membership has ended', { found: true, action: 'ignored_cancelled' }, 'processed'],
  ] as const)('nothing was written (%s): no second read', async (name, data, outcome) => {
    if (name === 'the membership has ended') await database.db.query("UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE stripe_subscription_id = 'sub_1'")
    else await database.db.query("UPDATE customer_memberships SET stripe_subscription_id = 'sub_1_moved_' || gen_random_uuid()::text WHERE stripe_subscription_id = 'sub_1'")
    for (const [type, object, showing] of [
      ['invoice.paid', cycleInvoice('sub_1'), paidUp('sub_1', 1700000000)],
      ['invoice.payment_failed', failedInvoice, { id: 'sub_1', status: 'past_due' }],
      ['customer.subscription.updated', updated(null), updated(null)],
    ] as const) {
      const supabase = databaseFunctions()
      const stripe = fakeStripe(showing)
      expect(await dispatchStripeEvent(fakeEvent(type, object), supabase, stripe)).toEqual({ outcome, detail: data })
      expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
      expect(supabase.rpc).toHaveBeenCalledTimes(1)
    }
  })

  it('the read after the write fails: it throws, so the event is an error and is sent again (the write stands, and is made again then)', async () => {
    const supabase = databaseFunctions()
    const retrieve = vi.fn().mockResolvedValueOnce({ id: 'sub_1', status: 'past_due' }).mockRejectedValue(new Error('stripe unreachable'))
    await expect(dispatchStripeEvent(fakeEvent('invoice.payment_failed', failedInvoice), supabase, { subscriptions: { retrieve } })).rejects.toThrow('stripe unreachable')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('the second write failing throws', async () => {
    const { rpc } = failingCall(2, new Error('db exploded'))
    await expect(dispatchStripeEvent(fakeEvent('customer.subscription.updated', updated(null)), { rpc }, fakeStripe(updated(null), updated(1700000000)))).rejects.toThrow('db exploded')
    expect(rpc).toHaveBeenCalledTimes(2)
    // The first write (no end: unchanged) stands; the second never ran.
    expect(await memberRow('sub_1')).toMatchObject({ last_day: null })
  })

  it(`a subscription that shows something else after every write: ${MOST_WRITES_AGAIN + 1} writes, then it throws, so the event is an error and Stripe sends it again`, async () => {
    const supabase = databaseFunctions()
    // Each read shows a later end than the one before.
    let end = 1700000000
    const retrieve = vi.fn().mockImplementation(async () => updated((end += 86400)))
    await expect(dispatchStripeEvent(fakeEvent('customer.subscription.updated', updated(null)), supabase, { subscriptions: { retrieve } })).rejects.toThrow(
      `Subscription sub_1 showed something else after each of ${MOST_WRITES_AGAIN + 1} writes`
    )
    expect(supabase.rpc).toHaveBeenCalledTimes(MOST_WRITES_AGAIN + 1)
    expect(retrieve).toHaveBeenCalledTimes(MOST_WRITES_AGAIN + 2)
  })

  it(`a subscription that settles on its last allowed write is processed: ${MOST_WRITES_AGAIN + 1} writes and a read that agrees`, async () => {
    const supabase = databaseFunctions()
    const stripe = fakeStripe(updated(null), updated(1700000000), updated(1700086400))
    const result = await dispatchStripeEvent(fakeEvent('customer.subscription.updated', updated(null)), supabase, stripe)
    expect(supabase.rpc).toHaveBeenCalledTimes(3)
    expect(supabase.rpc).toHaveBeenLastCalledWith('membership_sync_cancel_at_period_end', syncParams(1700086400))
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(4)
    expect(result.detail).toMatchObject({ written_again: 2 })
  })
})
