import type Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dispatchStripeEvent, type DispatchResult } from '@/app/api/stripe/webhook/dispatch'
import { processWebhookEvent } from '@/app/api/stripe/webhook/idempotency'
import { POST as cancelRoute } from '@/app/api/v1/staff/memberships/[membershipId]/cancel/route'
import { POST as undoRoute } from '@/app/api/v1/staff/memberships/[membershipId]/undo-cancel/route'
import type { Db } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { stuckList } from '@/server/rules/orders/stuck-list'
import { insert } from '@/server/rules/testing/database'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { ID, MO_SUBSCRIPTION, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { invoiceEvent, subscriptionUpdatedEvent, webhookClient, webhookRpc } from '@/server/rules/testing/webhook'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { CHECK_AFTER_MINUTES } from './left'

// Brief W45a item 2 (W45 audit S1, briefs/W45-audit-logs/proof-a.test.ts.txt turned round): Stripe's webhook acts on
// the subscription as Stripe holds it when the event is handled, never on the event's own snapshot. Real events
// through the real handlers (dispatch.ts, idempotency.ts), the Worker's cancel and undo routes, the database's own
// functions on the replay's live schema, and the fake Stripe. What must hold:
// - customer.subscription.updated: whatever order the events are handled in, the membership's last day is the one
//   Stripe has. The audit's case: Cancel, then Undo, with the Cancel's event handled last, used to leave the row
//   ending on 9 December while Stripe had no end, and from 10 December the credit allocation failed for every member.
// - invoice.payment_failed: only a subscription Stripe still shows as past due (or unpaid) marks the membership. One
//   handled after the payment that followed it went through leaves the member active and no booking flagged.
// - A read of Stripe that fails: nothing is written from the event, and the event is not marked processed, so
//   Stripe sends it again.

vi.setConfig({ testTimeout: 120_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal())
})

const KEY = 'test-staff-api-key'
const MEMBER_STRIPE_CUSTOMER = 'cus_member'
const MONTHLY_PRICE = 'price_seed_monthly'
/** 10 December 2026, 00:00 in London: Mo's next payment, and when his membership ends if cancelled today (10 November). */
const ENDS = Date.UTC(2026, 11, 10) / 1000
/** 10 January 2027, 00:00 in London: the end of the period Mo's 10 December payment starts. */
const NEXT_END = Date.UTC(2027, 0, 10) / 1000
const SAM_MEMBERSHIP = '10000000-0000-4000-8000-0000000000f5'
const SAM_SUBSCRIPTION = 'sub_sam_w45a'
const CREDIT_SESSION = '10000000-0000-4000-8000-0000000000f6'

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => {
  replayStripe.current = null
  vi.unstubAllEnvs()
  return environment.stop()
})

/**
 * The replay's seed with Mo's membership as live ones are (a Stripe subscription, its next payment on 10 December);
 * Sam, a second member who renews on the 10th too; and a credit booking of Mo's on 15 December, after the period he
 * has paid for.
 */
async function onASeed(work: (stripe: FakeStripe) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w45a webhook',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await seedDb.query("UPDATE customer_memberships SET stripe_subscription_id = $1, next_renewal_date = '2026-12-10' WHERE id = $2", [MO_SUBSCRIPTION, ID.membership])
        stripe.addSubscription(MO_SUBSCRIPTION, MEMBER_STRIPE_CUSTOMER, MONTHLY_PRICE)
        await insert(seedDb, 'customer_memberships', {
          id: SAM_MEMBERSHIP,
          customer_id: ID.customer,
          plan_id: ID.plan,
          start_date: '2026-02-10',
          next_renewal_date: '2026-12-10',
          subscription_status: 'active',
          billing_frequency: 'monthly',
          is_herd: false,
          addon_credits_remaining: 0,
          stripe_subscription_id: SAM_SUBSCRIPTION,
        })
        const slot = { start_time: '2026-12-15 10:00:00+00', end_time: '2026-12-15 11:00:00+00' }
        await insert(seedDb, 'sessions', { id: CREDIT_SESSION, service_type_id: ID.serviceType, type: 'public', capacity: 10, band_id: ID.band, ...slot })
        await insert(seedDb, 'bookings', { session_id: CREDIT_SESSION, customer_id: ID.member, party_size: 1, status: 'confirmed', price_paid: '0', redemption_source: 'membership_credit', redeemed_membership_id: ID.membership, ...slot })
      },
      async run({ stripe }) {
        replayStripe.current = stripe
        vi.stubEnv('ORDER_SWITCH', 'membership_changes')
        try {
          await work(stripe)
        } finally {
          replayStripe.current = null
        }
      },
    },
    oldSide
  )
}

async function press(route: 'cancel' | 'undo-cancel'): Promise<number> {
  // The replay holds the clock still (Postgres's too): moved on between presses, so rows read in time order keep theirs.
  vi.setSystemTime(Date.now() + 1000)
  const membershipId = ID.membership as string
  const response = await (route === 'cancel' ? cancelRoute : undoRoute)(
    new Request(`https://worker.test/api/v1/staff/memberships/${membershipId}/${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      body: '{}',
    }),
    { params: Promise.resolve({ membershipId }) }
  )
  return response.status
}

/** The webhook's handler for one event, on the test database, reading the fake Stripe as it is at that moment. */
const handle = (stripe: FakeStripe, event: Stripe.Event): Promise<DispatchResult> => dispatchStripeEvent(event, webhookRpc(db), stripe)
/** The event Stripe made for the Cancel: the subscription ending on 10 December. */
const cancelEvent = () => subscriptionUpdatedEvent(MO_SUBSCRIPTION, { cancelAt: ENDS, periodEnd: ENDS })
/** The event Stripe made for the Undo: no end. */
const undoEvent = () => subscriptionUpdatedEvent(MO_SUBSCRIPTION, { cancelAt: null, periodEnd: ENDS })

const lastDay = async () => (await db.query<{ ends: string | null }>('SELECT cancel_effective_date::text AS ends FROM customer_memberships WHERE id = $1', [ID.membership]))[0]?.ends ?? null
const stripeCancelAt = (stripe: FakeStripe) => stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt ?? null
/** The membership's last day and Stripe's end, side by side. */
const both = async (stripe: FakeStripe) => ({ row: await lastDay(), stripe: stripeCancelAt(stripe) })
const reads = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'subscriptions.retrieve').length
const reconcileNow = (stripe: FakeStripe) => reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
const memberLevel = async () => (await db.query<{ level: string | null }>('SELECT public.event_member_level($1) AS level', [ID.member]))[0]?.level ?? null
/** A statement's outcome: 'ok', or the error's message (the test carries on). */
const attempt = async (sql: string): Promise<string> => {
  try {
    await db.query(sql)
    return 'ok'
  } catch (err) {
    return `failed: ${err instanceof Error ? err.message : String(err)}`
  }
}
const samPeriods = async () => (await db.query<{ start: string }>('SELECT period_start::text AS start FROM membership_credit_periods WHERE membership_id = $1 ORDER BY period_start', [SAM_MEMBERSHIP])).map((row) => row.start)
/** Mo's membership status, and his 15 December credit booking: its status and whether it has a payment deadline. */
const member = async () => {
  const status = (await db.query<{ s: string }>('SELECT subscription_status AS s FROM customer_memberships WHERE id = $1', [ID.membership]))[0]?.s
  const booking = (await db.query<{ status: string; due: boolean }>('SELECT status, payment_due_by IS NOT NULL AS due FROM bookings WHERE session_id = $1', [CREDIT_SESSION]))[0]
  return { status, booking: booking?.status, deadline: booking?.due }
}
const stripeDown = () => ({ kind: 'error' as const, error: fakeStripeErrors.server() })

describe('customer.subscription.updated: the membership ends when Stripe says, whatever order the events are handled in (W45a item 2; audit S1)', () => {
  it.each([
    ['in the order they were made', ['cancel', 'undo']],
    ["with the Cancel's event last (the audit's proof A)", ['undo', 'cancel']],
  ] as const)(
    'Cancel then Undo, their events handled %s: the membership has no end, as Stripe; nothing is listed; on 10 December the credits are allocated, the hourly job runs, Sam\'s renewal is recorded and Mo has his access',
    async (_name, order) => {
      await onASeed(async (stripe) => {
        expect(await press('cancel')).toBe(200)
        expect(await press('undo-cancel')).toBe(200)
        expect(await both(stripe)).toEqual({ row: null, stripe: null })
        for (const which of order) {
          const before = reads(stripe)
          const result = await handle(stripe, which === 'cancel' ? cancelEvent() : undoEvent())
          // Each event is one read of Stripe, and what is written is what Stripe shows: no end, whatever the event said.
          expect(reads(stripe) - before).toBe(1)
          expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'unchanged', cancel_effective_date: null } })
          expect(await both(stripe)).toEqual({ row: null, stripe: null })
        }
        // 21 minutes on, a run: its check finds Stripe as the newest wish, and nothing is listed.
        vi.setSystemTime(Date.now() + (CHECK_AFTER_MINUTES + 1) * 60_000)
        await reconcileNow(stripe)
        expect((await stuckList(db)).steps).toEqual([])
        // 10 December, 00:05: the day after what the Cancel's event said was the last day.
        vi.setSystemTime(new Date('2026-12-10T00:05:00.000Z'))
        expect(await attempt('SELECT public.allocate_membership_credit_periods()')).toBe('ok')
        expect(await attempt('SELECT public.run_membership_maintenance()')).toBe('ok')
        expect((await handle(stripe, invoiceEvent('invoice.paid', SAM_SUBSCRIPTION, { periodEnd: NEXT_END }))).outcome).toBe('processed')
        expect(await samPeriods()).toEqual(['2026-12-10'])
        expect(await memberLevel()).toBe('herd')
        expect(await both(stripe)).toEqual({ row: null, stripe: null })
        expect((await stuckList(db)).steps).toEqual([])
      })
    }
  )

  // Cancel, Undo, Cancel again: Stripe ends the subscription on 10 December. Three events, six orders.
  it.each([
    [['cancel', 'undo', 'cancel again']],
    [['cancel', 'cancel again', 'undo']],
    [['undo', 'cancel', 'cancel again']],
    [['undo', 'cancel again', 'cancel']],
    [['cancel again', 'cancel', 'undo']],
    [['cancel again', 'undo', 'cancel']],
  ] as const)('Cancel, Undo, Cancel again, their events handled as %j: the last day is 9 December, as Stripe (an Undo\'s event handled last never clears it)', async (order) => {
    await onASeed(async (stripe) => {
      expect(await press('cancel')).toBe(200)
      expect(await press('undo-cancel')).toBe(200)
      expect(await press('cancel')).toBe(200)
      expect(await both(stripe)).toEqual({ row: '2026-12-09', stripe: ENDS })
      for (const which of order) {
        const result = await handle(stripe, which === 'undo' ? undoEvent() : cancelEvent())
        expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'unchanged', cancel_effective_date: '2026-12-09' } })
        expect(await both(stripe)).toEqual({ row: '2026-12-09', stripe: ENDS })
      }
    })
  })

  it("an event handled between two presses writes what Stripe shows at that moment: the Cancel's, handled after the Undo landed, clears nothing and sets nothing; a change made in Stripe itself is copied by whichever event comes next", async () => {
    await onASeed(async (stripe) => {
      expect(await press('cancel')).toBe(200)
      // The Cancel's event, handled at once: Stripe ends it on 10 December, and so does the row (M1 wrote it already).
      expect((await handle(stripe, cancelEvent())).detail).toMatchObject({ action: 'unchanged', cancel_effective_date: '2026-12-09' })
      expect(await press('undo-cancel')).toBe(200)
      // A second delivery of the Cancel's snapshot (another event for the same change), after the Undo: no end.
      expect((await handle(stripe, cancelEvent())).detail).toMatchObject({ action: 'unchanged', cancel_effective_date: null })
      expect(await both(stripe)).toEqual({ row: null, stripe: null })
      // Someone sets an end in Stripe's dashboard (20 December); the event that says so is not handled yet. An older
      // event handled now copies Stripe as it is, the new end included.
      const DASHBOARD_END = Date.UTC(2026, 11, 20) / 1000
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: DASHBOARD_END })
      expect(await handle(stripe, undoEvent())).toEqual({ outcome: 'processed', detail: { found: true, action: 'cancel_scheduled', cancel_effective_date: '2026-12-19' } })
      expect(await both(stripe)).toEqual({ row: '2026-12-19', stripe: DASHBOARD_END })
    })
  })

  it("Stripe can't be read: nothing is written from the event; it is recorded as an error and answered 500, never as processed, so Stripe sends it again; the next delivery writes what Stripe then shows, and one after that is a duplicate with no read", async () => {
    await onASeed(async (stripe) => {
      const client = webhookClient(db)
      expect(await press('cancel')).toBe(200)
      expect(await press('undo-cancel')).toBe(200)
      // The Cancel's event arrives last, and Stripe answers the read with a 500, then can't be reached at all.
      const late = cancelEvent()
      for (const fault of [stripeDown(), { kind: 'unreachable' as const }]) {
        stripe.failNext('subscriptions.retrieve', fault)
        expect(await processWebhookEvent(late, client, stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
        const recorded = await client.eventRow(late.id)
        expect(recorded).toMatchObject({ event_type: 'customer.subscription.updated', outcome: 'error', detail: null })
        expect(recorded?.error).toBeTruthy()
        // No database function was called: the event's own 10 December was never written.
        expect(client.calls).toEqual([])
        expect(await both(stripe)).toEqual({ row: null, stripe: null })
      }
      // Stripe sends it again, and can be read: the row is as Stripe has it (no end), and the event is done.
      expect(await processWebhookEvent(late, client, stripe)).toEqual({ status: 200, body: { received: true } })
      expect(await client.eventRow(late.id)).toMatchObject({ outcome: 'processed', error: null, detail: { found: true, action: 'unchanged', cancel_effective_date: null } })
      // All three values are Stripe's own: no end, and the fake's period end (10 December, 09:00), not the event's (00:00).
      const stripePeriodEnd = stripe.subscriptionSettings(MO_SUBSCRIPTION)?.periodEnd ?? 0
      expect(stripePeriodEnd).not.toBe(ENDS)
      expect(client.calls).toEqual([
        { fn: 'membership_sync_cancel_at_period_end', params: { p_stripe_subscription_id: MO_SUBSCRIPTION, p_cancel_at_period_end: false, p_cancel_at: null, p_period_end: new Date(stripePeriodEnd * 1000).toISOString() } },
      ])
      expect(await both(stripe)).toEqual({ row: null, stripe: null })
      const readsSoFar = reads(stripe)
      expect(await processWebhookEvent(late, client, stripe)).toEqual({ status: 200, body: { received: true, duplicate: true } })
      expect(reads(stripe)).toBe(readsSoFar)
      expect(client.calls).toHaveLength(1)
    })
  })
})

describe('invoice.payment_failed: only a subscription Stripe still shows behind on its payment marks the membership (W45a item 2; audit S1)', () => {
  /** 10 December, 14:00: Mo's renewal. */
  const RENEWAL = new Date('2026-12-10T14:00:00.000Z')
  const failedEvent = () => invoiceEvent('invoice.payment_failed', MO_SUBSCRIPTION, { periodStart: ENDS, periodEnd: NEXT_END })
  const paidEvent = () => invoiceEvent('invoice.paid', MO_SUBSCRIPTION, { periodStart: ENDS, periodEnd: NEXT_END })
  const PAID_UP = { status: 'active', booking: 'confirmed', deadline: false }

  it('the events in order: the failure, handled while Stripe shows the subscription past due, marks the member past due and flags the credit booking; the payment going through puts both back', async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(RENEWAL)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'past_due' })
      expect(await handle(stripe, failedEvent())).toMatchObject({ outcome: 'processed', detail: { found: true, action: 'past_due', covered_through: '2026-12-09', bookings_flagged: 1 } })
      expect(await member()).toEqual({ status: 'past_due', booking: 'payment_needed', deadline: true })
      // Two days on the retry goes through: Stripe shows active, and invoice.paid is handled.
      vi.setSystemTime(new Date('2026-12-12T14:00:00.000Z'))
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'active', periodEnd: NEXT_END })
      expect(await handle(stripe, paidEvent())).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'past_due', bookings_restored: 1 } })
      expect(await member()).toEqual(PAID_UP)
    })
  })

  it('the failure handled late, after the invoice.paid that followed it: Stripe shows the subscription active, so the event is ignored; the member stays active, no booking is flagged and no database function is called', async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(RENEWAL)
      // The first try failed and the retry went through; the failure's own delivery failed and comes again later.
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'active', periodEnd: NEXT_END })
      expect((await handle(stripe, paidEvent())).outcome).toBe('processed')
      expect(await member()).toEqual(PAID_UP)
      vi.setSystemTime(new Date('2026-12-10T20:00:00.000Z'))
      const rpc = webhookRpc(db)
      const before = reads(stripe)
      expect(await dispatchStripeEvent(failedEvent(), rpc, stripe)).toEqual({ outcome: 'ignored', detail: { reason: 'subscription_not_past_due', status: 'active' } })
      expect(reads(stripe) - before).toBe(1)
      expect(rpc.calls).toEqual([])
      expect(await member()).toEqual(PAID_UP)
    })
  })

  it('both handled late, the failure first: ignored, then the payment recorded; the member is active and the booking confirmed throughout', async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(RENEWAL)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'active', periodEnd: NEXT_END })
      expect((await handle(stripe, failedEvent())).outcome).toBe('ignored')
      expect(await member()).toEqual(PAID_UP)
      expect(await handle(stripe, paidEvent())).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'active', bookings_restored: 0 } })
      expect(await member()).toEqual(PAID_UP)
    })
  })

  it.each(['past_due', 'unpaid'] as const)('a subscription Stripe shows as %s is marked', async (status) => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(RENEWAL)
      stripe.setSubscription(MO_SUBSCRIPTION, { status })
      expect((await handle(stripe, failedEvent())).detail).toMatchObject({ action: 'past_due', bookings_flagged: 1 })
      expect(await member()).toEqual({ status: 'past_due', booking: 'payment_needed', deadline: true })
    })
  })

  it.each(['active', 'trialing', 'canceled'] as const)('a subscription Stripe shows as %s is left alone, with the status it showed kept on the event', async (status) => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(RENEWAL)
      stripe.setSubscription(MO_SUBSCRIPTION, { status })
      expect(await handle(stripe, failedEvent())).toEqual({ outcome: 'ignored', detail: { reason: 'subscription_not_past_due', status } })
      expect(await member()).toEqual(PAID_UP)
    })
  })

  it("Stripe can't be read: the member is not marked, the event is recorded as an error and answered 500, never as processed; sent again with Stripe showing past due, it marks the member", async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(RENEWAL)
      const client = webhookClient(db)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'past_due' })
      const event = failedEvent()
      stripe.failNext('subscriptions.retrieve', stripeDown())
      expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
      expect(await client.eventRow(event.id)).toMatchObject({ event_type: 'invoice.payment_failed', outcome: 'error', detail: null })
      expect(client.calls).toEqual([])
      expect(await member()).toEqual(PAID_UP)
      expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 200, body: { received: true } })
      expect(await client.eventRow(event.id)).toMatchObject({ outcome: 'processed', error: null, detail: { action: 'past_due', bookings_flagged: 1 } })
      expect(client.calls.map((call) => call.fn)).toEqual(['membership_mark_payment_failed'])
      expect(await member()).toEqual({ status: 'past_due', booking: 'payment_needed', deadline: true })
    })
  })
})
