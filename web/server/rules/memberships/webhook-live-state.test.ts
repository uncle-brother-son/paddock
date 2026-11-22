import type Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dispatchStripeEvent, type DispatchResult, type RpcClient, type SubscriptionReader } from '@/app/api/stripe/webhook/dispatch'
import { processWebhookEvent } from '@/app/api/stripe/webhook/idempotency'
import { POST as cancelRoute } from '@/app/api/v1/staff/memberships/[membershipId]/cancel/route'
import { POST as undoRoute } from '@/app/api/v1/staff/memberships/[membershipId]/undo-cancel/route'
import type { Db } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { stuckList, WEBHOOK_ERROR_MINUTES, WEBHOOK_LISTED_DAYS } from '@/server/rules/orders/stuck-list'
import { insert } from '@/server/rules/testing/database'
import { asOwner, BEFORE_030_SQL, migration030, savedFunctionsSql } from '@/server/rules/testing/migration-030'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { ID, MO_SUBSCRIPTION, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { asLive, invoiceEvent, subscriptionUpdatedEvent, webhookClient, webhookRpc } from '@/server/rules/testing/webhook'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { CHECK_AFTER_MINUTES } from './left'
import { WEBHOOK_NOTICE_WORDS } from './failure-messages'
import { stuckListOutputSchema } from '@/contracts'

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
// Brief W46 item 2 (W45a "Noticed" 1, 2 and 3), the same way:
// - invoice.paid: only a subscription Stripe shows as paid up (active, or trialing) records the payment, and the next
//   payment date is the period's end as Stripe has it. The date change's £0 invoice handled after the first full
//   payment failed leaves the member past due, as Stripe.
// - Stripe has no such subscription (a 404): the event is finished as ignored, with the reason.
// - A change that lands between a handler's read and its write (lead call L8): the handler reads again after the
//   write and writes what Stripe then shows, so the membership ends as Stripe is.
// Brief W46b (W46 review B1 and S1):
// - invoice.paid records a payment only for the subscription's newest invoice (every invoice event here says which
//   invoice it is for). The review's proofs, turned round, are in latest-invoice.test.ts.
// - "No such subscription" is ignored only for a test-mode event. For a live event it is an error, sent again.

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
        // W46: invoice.paid reads the subscription, so Sam's is in Stripe too.
        stripe.addSubscription(SAM_SUBSCRIPTION, MEMBER_STRIPE_CUSTOMER, MONTHLY_PRICE)
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
    workerSide()
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
          // What is written is what Stripe shows: no end, whatever the event said. Each event reads Stripe twice
          // (W46, L8): before its write, and after it, where Stripe still shows the same.
          expect(reads(stripe) - before).toBe(2)
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
        // Sam's renewal went through: Stripe shows the new period.
        stripe.setSubscription(SAM_SUBSCRIPTION, { status: 'active', periodEnd: NEXT_END })
        expect((await handle(stripe, invoiceEvent('invoice.paid', SAM_SUBSCRIPTION, { id: stripe.latestInvoice(SAM_SUBSCRIPTION), periodEnd: NEXT_END }))).outcome).toBe('processed')
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
  // W46b: both are for the renewal's invoice, the subscription's newest.
  const failedEvent = (stripe: FakeStripe) => invoiceEvent('invoice.payment_failed', MO_SUBSCRIPTION, { id: stripe.latestInvoice(MO_SUBSCRIPTION), periodStart: ENDS, periodEnd: NEXT_END })
  const paidEvent = (stripe: FakeStripe) => invoiceEvent('invoice.paid', MO_SUBSCRIPTION, { id: stripe.latestInvoice(MO_SUBSCRIPTION), periodStart: ENDS, periodEnd: NEXT_END })
  const PAID_UP = { status: 'active', booking: 'confirmed', deadline: false }

  it('the events in order: the failure, handled while Stripe shows the subscription past due, marks the member past due and flags the credit booking; the payment going through puts both back', async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(RENEWAL)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'past_due' })
      expect(await handle(stripe, failedEvent(stripe))).toMatchObject({ outcome: 'processed', detail: { found: true, action: 'past_due', covered_through: '2026-12-09', bookings_flagged: 1 } })
      expect(await member()).toEqual({ status: 'past_due', booking: 'payment_needed', deadline: true })
      // Two days on the retry goes through: Stripe shows active, and invoice.paid is handled.
      vi.setSystemTime(new Date('2026-12-12T14:00:00.000Z'))
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'active', periodEnd: NEXT_END })
      expect(await handle(stripe, paidEvent(stripe))).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'past_due', bookings_restored: 1 } })
      expect(await member()).toEqual(PAID_UP)
    })
  })

  it('the failure handled late, after the invoice.paid that followed it: Stripe shows the subscription active, so the event is ignored; the member stays active, no booking is flagged and no database function is called', async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(RENEWAL)
      // The first try failed and the retry went through; the failure's own delivery failed and comes again later.
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'active', periodEnd: NEXT_END })
      expect((await handle(stripe, paidEvent(stripe))).outcome).toBe('processed')
      expect(await member()).toEqual(PAID_UP)
      vi.setSystemTime(new Date('2026-12-10T20:00:00.000Z'))
      const rpc = webhookRpc(db)
      const before = reads(stripe)
      expect(await dispatchStripeEvent(failedEvent(stripe), rpc, stripe)).toEqual({ outcome: 'ignored', detail: { reason: 'subscription_not_past_due', status: 'active' } })
      expect(reads(stripe) - before).toBe(1)
      expect(rpc.calls).toEqual([])
      expect(await member()).toEqual(PAID_UP)
    })
  })

  it('both handled late, the failure first: ignored, then the payment recorded; the member is active and the booking confirmed throughout', async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(RENEWAL)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'active', periodEnd: NEXT_END })
      expect((await handle(stripe, failedEvent(stripe))).outcome).toBe('ignored')
      expect(await member()).toEqual(PAID_UP)
      expect(await handle(stripe, paidEvent(stripe))).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'active', bookings_restored: 0 } })
      expect(await member()).toEqual(PAID_UP)
    })
  })

  it.each(['past_due', 'unpaid'] as const)('a subscription Stripe shows as %s is marked', async (status) => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(RENEWAL)
      stripe.setSubscription(MO_SUBSCRIPTION, { status })
      expect((await handle(stripe, failedEvent(stripe))).detail).toMatchObject({ action: 'past_due', bookings_flagged: 1 })
      expect(await member()).toEqual({ status: 'past_due', booking: 'payment_needed', deadline: true })
    })
  })

  it.each(['active', 'trialing', 'canceled'] as const)('a subscription Stripe shows as %s is left alone, with the status it showed kept on the event', async (status) => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(RENEWAL)
      stripe.setSubscription(MO_SUBSCRIPTION, { status })
      expect(await handle(stripe, failedEvent(stripe))).toEqual({ outcome: 'ignored', detail: { reason: 'subscription_not_past_due', status } })
      expect(await member()).toEqual(PAID_UP)
    })
  })

  it("Stripe can't be read: the member is not marked, the event is recorded as an error and answered 500, never as processed; sent again with Stripe showing past due, it marks the member", async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(RENEWAL)
      const client = webhookClient(db)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'past_due' })
      const event = failedEvent(stripe)
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

// --- Brief W46 item 2

/** 12 December 2026, 00:00 in London: the new payment date Mo's is moved to on 9 December (2 days later than the 10th). */
const NEW_DATE = Date.UTC(2026, 11, 12) / 1000
/** 12 January 2027: the end of the period his first full payment on the new date starts. */
const NEW_NEXT_END = Date.UTC(2027, 0, 12) / 1000
const renews = async () => (await db.query<{ renews: string | null }>('SELECT next_renewal_date::text AS renews FROM customer_memberships WHERE id = $1', [ID.membership]))[0]?.renews ?? null
/** W46b: the two invoices by id. Each is the subscription's newest from the moment Stripe makes it. */
const ZERO_INVOICE = 'in_date_change_zero'
const FULL_INVOICE = 'in_first_full_payment'
/** The date change's £0 invoice (9 December: no charge until the 12th). */
const zeroInvoicePaid = () => invoiceEvent('invoice.paid', MO_SUBSCRIPTION, { id: ZERO_INVOICE, periodStart: Date.UTC(2026, 11, 9) / 1000, periodEnd: NEW_DATE, billingReason: 'subscription_update', amountPaid: 0 })
/** The first full payment on the new date (12 December, £40), paid or failed. */
const fullInvoice = (type: 'invoice.paid' | 'invoice.payment_failed') => invoiceEvent(type, MO_SUBSCRIPTION, { id: FULL_INVOICE, periodStart: NEW_DATE, periodEnd: NEW_NEXT_END, amountPaid: type === 'invoice.paid' ? 4000 : 0 })
/** Stripe after the date change on 9 December: no charge until the 12th. */
const dateChanged = (stripe: FakeStripe) => stripe.setSubscription(MO_SUBSCRIPTION, { status: 'trialing', periodEnd: NEW_DATE, latestInvoice: ZERO_INVOICE })
/**
 * W46b (W46 review B1): Stripe on 12 December in the hour before it charges the £40. The no-charge days are over, the
 * new period has started and the subscription reads active; its newest invoice is the £40 one, still a draft.
 */
const fullInvoiceIsADraft = (stripe: FakeStripe) => stripe.setSubscription(MO_SUBSCRIPTION, { status: 'active', periodEnd: NEW_NEXT_END, latestInvoice: FULL_INVOICE })
/** Stripe on 12 December once the £40 has failed: the new period has started, and its payment is owed. */
const fullPaymentFailed = (stripe: FakeStripe) => stripe.setSubscription(MO_SUBSCRIPTION, { status: 'past_due', periodEnd: NEW_NEXT_END, latestInvoice: FULL_INVOICE })
const fullPaymentTaken = (stripe: FakeStripe) => stripe.setSubscription(MO_SUBSCRIPTION, { status: 'active', periodEnd: NEW_NEXT_END, latestInvoice: FULL_INVOICE })
const NINTH = new Date('2026-12-09T15:00:00.000Z')
const TWELFTH = new Date('2026-12-12T09:00:00.000Z')
const OWING = { status: 'past_due', booking: 'payment_needed', deadline: true }
const PAID = { status: 'active', booking: 'confirmed', deadline: false }

describe('invoice.paid: only a subscription Stripe shows as paid up records the payment, with the period end Stripe has (W46 item 2; W45a "Noticed" 1)', () => {
  it("the date change's £0 invoice, then the failed first full payment, in the order they happened: the new date is written, then the member is past due and the credit booking flagged", async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(NINTH)
      dateChanged(stripe)
      expect(await handle(stripe, zeroInvoicePaid())).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'active', bookings_restored: 0 } })
      expect(await renews()).toBe('2026-12-12')
      expect(await member()).toEqual(PAID)
      vi.setSystemTime(TWELFTH)
      fullPaymentFailed(stripe)
      expect(await handle(stripe, fullInvoice('invoice.payment_failed'))).toMatchObject({ outcome: 'processed', detail: { action: 'past_due', bookings_flagged: 1 } })
      expect(await member()).toEqual(OWING)
    })
  })

  it("the same two with the £0 invoice's event handled last (it failed at the webhook and Stripe sent it again): Stripe shows the subscription past due, so it is ignored; the member stays past due with £40 unpaid, the booking stays flagged and the payment date is not written; the retry going through then records the payment", async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(TWELFTH)
      fullPaymentFailed(stripe)
      expect((await handle(stripe, fullInvoice('invoice.payment_failed'))).detail).toMatchObject({ action: 'past_due', bookings_flagged: 1 })
      expect(await member()).toEqual(OWING)
      // Later that day the £0 invoice's event gets through. Before W46 it marked Mo active and confirmed the booking.
      vi.setSystemTime(new Date('2026-12-12T18:00:00.000Z'))
      const rpc = webhookRpc(db)
      const before = reads(stripe)
      expect(await dispatchStripeEvent(zeroInvoicePaid(), rpc, stripe)).toEqual({ outcome: 'ignored', detail: { reason: 'subscription_not_paid_up', status: 'past_due' } })
      expect(reads(stripe) - before).toBe(1)
      expect(rpc.calls).toEqual([])
      expect(await member()).toEqual(OWING)
      expect(await renews()).toBe('2026-12-10')
      // Two days on Stripe's retry takes the £40.
      vi.setSystemTime(new Date('2026-12-14T09:00:00.000Z'))
      fullPaymentTaken(stripe)
      expect(await handle(stripe, fullInvoice('invoice.paid'))).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'past_due', bookings_restored: 1 } })
      expect(await member()).toEqual(PAID)
      expect(await renews()).toBe('2027-01-12')
    })
  })

  // W46b (W46 review B1): W46 had the £0 invoice's event, handled last, write the period Stripe was in. It is no longer
  // the subscription's newest invoice then, so it is ignored: the £40 invoice's own event writes the date.
  it.each([
    ['in the order they happened', ['zero', 'full']],
    ["with the £0 invoice's event last", ['full', 'zero']],
  ] as const)("two paid invoices, the date change's £0 one and the first full payment, their events handled %s: the next payment date ends as the period Stripe is in (12 January), written by the £40 invoice's event, never back on the £0 invoice's 12 December; the £0 event handled last is ignored (not the newest invoice)", async (_name, order) => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(TWELFTH)
      if (order[0] === 'zero') {
        // Handled in time: Stripe still showed the no-charge days, and the £0 invoice was its newest.
        dateChanged(stripe)
        const rpc = webhookRpc(db)
        expect((await dispatchStripeEvent(zeroInvoicePaid(), rpc, stripe)).outcome).toBe('processed')
        expect(rpc.calls).toEqual([{ fn: 'membership_mark_paid', params: { p_stripe_subscription_id: MO_SUBSCRIPTION, p_period_end: new Date(NEW_DATE * 1000).toISOString() } }])
        expect(await renews()).toBe('2026-12-12')
      }
      fullPaymentTaken(stripe)
      const full = webhookRpc(db)
      expect((await dispatchStripeEvent(fullInvoice('invoice.paid'), full, stripe)).outcome).toBe('processed')
      // The date written is Stripe's own period end.
      expect(full.calls).toEqual([{ fn: 'membership_mark_paid', params: { p_stripe_subscription_id: MO_SUBSCRIPTION, p_period_end: new Date(NEW_NEXT_END * 1000).toISOString() } }])
      expect(await renews()).toBe('2027-01-12')
      expect(await member()).toEqual(PAID)
      if (order[0] === 'full') {
        const late = webhookRpc(db)
        expect(await dispatchStripeEvent(zeroInvoicePaid(), late, stripe)).toEqual({ outcome: 'ignored', detail: { reason: 'not_latest_invoice' } })
        expect(late.calls).toEqual([])
        expect(await renews()).toBe('2027-01-12')
        expect(await member()).toEqual(PAID)
      }
    })
  })

  it.each(['past_due', 'unpaid', 'canceled', 'incomplete_expired', 'paused'] as const)('a subscription Stripe shows as %s: an invoice.paid for it is left alone, with the status it showed kept on the event', async (status) => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(TWELFTH)
      stripe.setSubscription(MO_SUBSCRIPTION, { status, periodEnd: NEW_NEXT_END })
      expect(await handle(stripe, fullInvoice('invoice.paid'))).toEqual({ outcome: 'ignored', detail: { reason: 'subscription_not_paid_up', status } })
      expect(await renews()).toBe('2026-12-10')
      expect(await member()).toEqual(PAID)
    })
  })

  it("Stripe can't be read: the payment is not recorded, the event is an error answered 500; sent again, it records the payment", async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(TWELFTH)
      const client = webhookClient(db)
      fullPaymentTaken(stripe)
      const event = fullInvoice('invoice.paid')
      stripe.failNext('subscriptions.retrieve', stripeDown())
      expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
      expect(await client.eventRow(event.id)).toMatchObject({ event_type: 'invoice.paid', outcome: 'error', detail: null })
      expect(client.calls).toEqual([])
      expect(await renews()).toBe('2026-12-10')
      expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 200, body: { received: true } })
      expect(await client.eventRow(event.id)).toMatchObject({ outcome: 'processed', error: null, detail: { action: 'reactivated' } })
      expect(await renews()).toBe('2027-01-12')
    })
  })
})

describe('Stripe has no such subscription (a 404): a test-mode event is finished as ignored, with the reason; a live event is an error, sent again (W46 item 2; W45a "Noticed" 3; W46b, W46 review S1)', () => {
  const GONE = 'sub_deleted_in_stripe'
  const events = (): Stripe.Event[] => [
    subscriptionUpdatedEvent(GONE, { cancelAt: ENDS, periodEnd: ENDS }),
    invoiceEvent('invoice.payment_failed', GONE, { id: 'in_gone', periodStart: ENDS, periodEnd: NEXT_END }),
    invoiceEvent('invoice.paid', GONE, { id: 'in_gone', periodStart: ENDS, periodEnd: NEXT_END }),
  ]
  const membershipRow = () => db.query('SELECT to_jsonb(cm) AS row FROM customer_memberships cm WHERE id = $1', [ID.membership])

  it('test mode, each event that reads Stripe: answered 200 and recorded as ignored with the reason and the subscription, no database function called and the membership untouched; sent again it is a duplicate, with no read', async () => {
    await onASeed(async (stripe) => {
      // Mo's membership names a subscription Stripe doesn't have with this key (test data deleted).
      await db.query('UPDATE customer_memberships SET stripe_subscription_id = $1 WHERE id = $2', [GONE, ID.membership])
      const before = await membershipRow()
      for (const event of events()) {
        expect(event.livemode).toBe(false)
        const client = webhookClient(db)
        const readsBefore = reads(stripe)
        expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 200, body: { received: true } })
        expect(reads(stripe) - readsBefore).toBe(1)
        // W47, a named difference: `livemode` (false: a test-mode event) is on the row too, for the banner's line.
        expect(await client.eventRow(event.id)).toEqual({ event_type: event.type, outcome: 'ignored', error: null, detail: { reason: 'subscription_missing', subscription: GONE, message: `No such subscription: '${GONE}'`, livemode: false } })
        expect(client.calls).toEqual([])
        expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 200, body: { received: true, duplicate: true } })
        expect(reads(stripe) - readsBefore).toBe(1)
      }
      expect(await membershipRow()).toEqual(before)
      expect(await member()).toEqual(PAID)
    })
  })

  // W46b (S1): the same three events as live Stripe sends them. Nothing is finished: each delivery is a 500 with the
  // event left as an error, so Stripe keeps sending it (for three days), and each delivery reads Stripe afresh.
  it('live mode, each event that reads Stripe: answered 500 and recorded as an error, never as ignored or processed, no database function called and the membership untouched; sent again it is read again and is still an error, not a duplicate', async () => {
    await onASeed(async (stripe) => {
      await db.query('UPDATE customer_memberships SET stripe_subscription_id = $1 WHERE id = $2', [GONE, ID.membership])
      const before = await membershipRow()
      for (const event of events().map(asLive)) {
        expect(event.livemode).toBe(true)
        const client = webhookClient(db)
        const readsBefore = reads(stripe)
        for (const delivery of [1, 2]) {
          expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
          expect(reads(stripe) - readsBefore).toBe(delivery)
          expect(await client.eventRow(event.id)).toEqual({ event_type: event.type, outcome: 'error', error: `No such subscription: '${GONE}'`, detail: null })
          expect(client.calls).toEqual([])
        }
      }
      expect(await membershipRow()).toEqual(before)
      expect(await member()).toEqual(PAID)
    })
  })

  it.each([
    ['test mode', false],
    ['live mode', true],
  ] as const)("%s: a subscription made with the other mode's key is a 404 too: a test-mode event is ignored, a live one is an error", async (_name, live) => {
    await onASeed(async (stripe) => {
      const client = webhookClient(db)
      // The fake answers a subscription of the other mode as missing, as Stripe does.
      stripe.keyLivemode = true
      const made = subscriptionUpdatedEvent(MO_SUBSCRIPTION, { cancelAt: ENDS, periodEnd: ENDS })
      const event = live ? asLive(made) : made
      if (live) {
        expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
        expect(await client.eventRow(event.id)).toMatchObject({ outcome: 'error', detail: null })
      } else {
        expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 200, body: { received: true } })
        expect(await client.eventRow(event.id)).toMatchObject({ outcome: 'ignored', detail: { reason: 'subscription_missing', subscription: MO_SUBSCRIPTION } })
      }
      expect(client.calls).toEqual([])
      expect(await lastDay()).toBeNull()
    })
  })

  // W46b (S1), the review's example: the go-live evening, with STRIPE_SECRET_KEY still the test key for two hours.
  // Mo's live subscription is past due, his 15 December booking flagged. Stripe's retry takes his £40 at 19:00.
  it("the review's example: a live invoice.paid while the Worker still has the test key is an error answered 500, and Mo stays past due with nothing written; once the key is the live one Stripe's next delivery records the payment: active, the booking confirmed and its deadline cleared", async () => {
    await onASeed(async (stripe) => {
      const LIVE_SUBSCRIPTION = 'sub_mo_live'
      stripe.keyLivemode = true
      stripe.addSubscription(LIVE_SUBSCRIPTION, MEMBER_STRIPE_CUSTOMER, MONTHLY_PRICE)
      await db.query('UPDATE customer_memberships SET stripe_subscription_id = $1 WHERE id = $2', [LIVE_SUBSCRIPTION, ID.membership])
      // 10 December 14:00: his renewal fails, handled with the live key.
      vi.setSystemTime(new Date('2026-12-10T14:00:00.000Z'))
      const invoice = stripe.startRenewal(LIVE_SUBSCRIPTION, NEXT_END)
      stripe.setSubscription(LIVE_SUBSCRIPTION, { status: 'past_due' })
      expect((await handle(stripe, asLive(invoiceEvent('invoice.payment_failed', LIVE_SUBSCRIPTION, { id: invoice, periodStart: ENDS, periodEnd: NEXT_END })))).detail).toMatchObject({ action: 'past_due', bookings_flagged: 1 })
      expect(await member()).toEqual(OWING)
      // 19:00: the retry takes the £40. The Worker has the test key: Stripe answers "no such subscription".
      vi.setSystemTime(new Date('2026-12-10T19:00:00.000Z'))
      stripe.setSubscription(LIVE_SUBSCRIPTION, { status: 'active' })
      stripe.keyLivemode = false
      const client = webhookClient(db)
      const paid = asLive(invoiceEvent('invoice.paid', LIVE_SUBSCRIPTION, { id: invoice, periodStart: ENDS, periodEnd: NEXT_END, amountPaid: 4000 }))
      expect(await processWebhookEvent(paid, client, stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
      expect(await client.eventRow(paid.id)).toMatchObject({ outcome: 'error', detail: null })
      expect(client.calls).toEqual([])
      expect(await member()).toEqual(OWING)
      // 21:00: the key is put right, and Stripe sends the event again.
      vi.setSystemTime(new Date('2026-12-10T21:00:00.000Z'))
      stripe.keyLivemode = true
      expect(await processWebhookEvent(paid, client, stripe)).toEqual({ status: 200, body: { received: true } })
      expect(await client.eventRow(paid.id)).toMatchObject({ outcome: 'processed', error: null, detail: { action: 'reactivated', was: 'past_due', bookings_restored: 1 } })
      expect(await member()).toEqual(PAID)
      expect(await renews()).toBe('2027-01-10')
    })
  })

  it('any other failed read is still an error, sent again: a 500 from Stripe, and Stripe not reached', async () => {
    await onASeed(async (stripe) => {
      for (const fault of [stripeDown(), { kind: 'unreachable' as const }]) {
        for (const event of [subscriptionUpdatedEvent(MO_SUBSCRIPTION, { cancelAt: ENDS, periodEnd: ENDS }), invoiceEvent('invoice.payment_failed', MO_SUBSCRIPTION, { id: stripe.latestInvoice(MO_SUBSCRIPTION), periodEnd: NEXT_END }), invoiceEvent('invoice.paid', MO_SUBSCRIPTION, { id: stripe.latestInvoice(MO_SUBSCRIPTION), periodEnd: NEXT_END })]) {
          const client = webhookClient(db)
          stripe.failNext('subscriptions.retrieve', fault)
          expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
          expect(await client.eventRow(event.id)).toMatchObject({ outcome: 'error', detail: null })
          expect(client.calls).toEqual([])
        }
      }
    })
  })
})

describe('a change that lands between a handler\'s read and its write: the handler reads again and writes what Stripe then shows (W46 item 2; lead call L8)', () => {
  /** The webhook's database calls on `db`, with `landing` run once, after the handler's first read and before its first write is made. */
  const withAChangeBeforeTheWrite = (landing: () => Promise<void>): RpcClient & { calls: ReturnType<typeof webhookRpc>['calls'] } => {
    const real = webhookRpc(db)
    let landed = false
    return {
      calls: real.calls,
      async rpc(fn, params) {
        if (!landed) {
          landed = true
          await landing()
        }
        return real.rpc(fn, params)
      },
    }
  }

  /** Stripe as the handlers read it, with `landing` run once, after the handler's first read is answered and before the handler carries on with it. */
  const withAChangeAfterTheRead = (stripe: FakeStripe, landing: () => Promise<void>): SubscriptionReader => {
    let landed = false
    return {
      subscriptions: {
        async retrieve(id) {
          const read = await stripe.subscriptions.retrieve(id)
          if (!landed) {
            landed = true
            await landing()
          }
          return read
        },
      },
    }
  }

  it("customer.subscription.updated: the Cancel's event is read (ends 10 December), then the Undo lands and is written before the event's own write: the stale date is written, the second read shows no end, and it is cleared: the membership has no end, as Stripe", async () => {
    await onASeed(async (stripe) => {
      expect(await press('cancel')).toBe(200)
      expect(await both(stripe)).toEqual({ row: '2026-12-09', stripe: ENDS })
      let readsWhileLanding = 0
      const rpc = withAChangeBeforeTheWrite(async () => {
        // The Undo, and its own event handled in full, while the Cancel's handler is between its read and its write.
        const landingFrom = reads(stripe)
        expect(await press('undo-cancel')).toBe(200)
        expect((await handle(stripe, undoEvent())).outcome).toBe('processed')
        expect(await both(stripe)).toEqual({ row: null, stripe: null })
        readsWhileLanding = reads(stripe) - landingFrom
      })
      const before = reads(stripe)
      const result = await dispatchStripeEvent(cancelEvent(), rpc, stripe)
      // Written twice: the date it read, then (Stripe showing no end after that write) no date.
      expect(rpc.calls.map((call) => call.params['p_cancel_at'])).toEqual([new Date(ENDS * 1000).toISOString(), null])
      expect(result).toEqual({ outcome: 'processed', detail: { found: true, action: 'cancel_cleared', cancel_effective_date: null, written_again: 1, last_write: 'membership_sync_cancel_at_period_end' } })
      // The handler's own reads: before its write, after it, and after its second write.
      expect(reads(stripe) - before - readsWhileLanding).toBe(3)
      expect(await both(stripe)).toEqual({ row: null, stripe: null })
    })
  })

  it('invoice.payment_failed: read while Stripe shows past due, then the retry goes through and its invoice.paid is handled before the failure\'s own write: the member is marked past due and the booking flagged, the second read shows the subscription active, and the payment is recorded again: active, the booking confirmed, the date Stripe has', async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(TWELFTH)
      fullPaymentFailed(stripe)
      const rpc = withAChangeBeforeTheWrite(async () => {
        fullPaymentTaken(stripe)
        expect((await handle(stripe, fullInvoice('invoice.paid'))).outcome).toBe('processed')
        expect(await member()).toEqual(PAID)
      })
      const result = await dispatchStripeEvent(fullInvoice('invoice.payment_failed'), rpc, stripe)
      expect(rpc.calls.map((call) => call.fn)).toEqual(['membership_mark_payment_failed', 'membership_mark_paid'])
      // `was: 'past_due'`: the failure's own write did land over the payment. It flagged no booking: the payment's
      // event had already given Mo his next credit period, which covers 15 December.
      expect(result).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'past_due', bookings_restored: 0, written_again: 1, last_write: 'membership_mark_paid' } })
      expect(await member()).toEqual(PAID)
      expect(await renews()).toBe('2027-01-12')
    })
  })

  // W46a pinned W46's "Noticed" 2 here with the £0 event's read showing `trialing` just before the £40's failure, and
  // said 030 mended it. Stripe would not show that at that moment (W46 review, B1 and proof B): between the no-charge
  // days ending and the charge there is the hour the £40 invoice is a draft, when the subscription reads active with
  // its period already moved on. Read then, W46's handler wrote 12 January, and 030 (which goes by that date) flagged
  // nothing after it. W46b: the read is modelled as Stripe shows it, and the £0 invoice is not the subscription's
  // newest, so its event is ignored and writes nothing. There is no stale write left to take back, with either
  // version of the two functions (each put in for the test, as W46a did).
  it.each([
    ['before 030', false],
    ['with 030', true],
  ] as const)(
    "invoice.paid, %s: the £0 invoice's event, sent again, is read in the hour the £40 invoice is a draft (the subscription active, its period to 12 January), then the £40 fails and its event is handled before the £0 event's handler carries on: the £0 event is ignored (not the newest invoice) and calls no database function; the member is past due and the booking flagged, as the failure left them, and the payment date is not written",
    async (_name, with030) => {
      await asOwner(environment.database.pg, with030 ? migration030() : BEFORE_030_SQL)
      try {
        await onASeed(async (stripe) => {
          vi.setSystemTime(TWELFTH)
          fullInvoiceIsADraft(stripe)
          const reader = withAChangeAfterTheRead(stripe, async () => {
            fullPaymentFailed(stripe)
            expect((await handle(stripe, fullInvoice('invoice.payment_failed'))).detail).toMatchObject({ action: 'past_due', covered_through: '2026-12-09', bookings_flagged: 1 })
            expect(await member()).toEqual(OWING)
          })
          const rpc = webhookRpc(db)
          expect(await dispatchStripeEvent(zeroInvoicePaid(), rpc, reader)).toEqual({ outcome: 'ignored', detail: { reason: 'not_latest_invoice' } })
          expect(rpc.calls).toEqual([])
          expect(await member()).toEqual(OWING)
          expect(await renews()).toBe('2026-12-10')
        })
      } finally {
        await asOwner(environment.database.pg, savedFunctionsSql())
      }
    }
  )

  it('nothing changes between the read and the write: one write, a second read that agrees, and the answer as it was before W46', async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(TWELFTH)
      fullPaymentFailed(stripe)
      const rpc = webhookRpc(db)
      const before = reads(stripe)
      expect(await dispatchStripeEvent(fullInvoice('invoice.payment_failed'), rpc, stripe)).toEqual({ outcome: 'processed', detail: { found: true, action: 'past_due', covered_through: '2026-12-09', bookings_flagged: 1 } })
      expect(rpc.calls).toHaveLength(1)
      expect(reads(stripe) - before).toBe(2)
    })
  })

  it("the read after the write fails: the event is an error answered 500 with its write made; sent again, it is processed and the membership is as Stripe shows", async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(TWELFTH)
      const client = webhookClient(db)
      fullPaymentFailed(stripe)
      const event = fullInvoice('invoice.payment_failed')
      // The first read answers; the one after the write gets a 500.
      stripe.failNext('subscriptions.retrieve', { kind: 'none' })
      stripe.failNext('subscriptions.retrieve', stripeDown())
      expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
      expect(await client.eventRow(event.id)).toMatchObject({ outcome: 'error' })
      expect(client.calls.map((call) => call.fn)).toEqual(['membership_mark_payment_failed'])
      expect(await member()).toEqual(OWING)
      expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 200, body: { received: true } })
      expect(await client.eventRow(event.id)).toMatchObject({ outcome: 'processed', error: null, detail: { action: 'past_due' } })
      expect(await member()).toEqual(OWING)
    })
  })
})

// Brief W47 item 3 (W46 review L2; W46b "Noticed" 2): the Orders page's line for Stripe notices the Worker couldn't
// take in. Real events through the real handler leave the rows; the stuck list reads them.
describe("the banner's line for Stripe notices in error for over an hour (W47 item 3)", () => {
  const GONE = 'sub_w47_gone'
  const notice = async () => (await stuckList(db)).webhook
  const minutesOn = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60_000)
  const failedLive = async (stripe: FakeStripe, id: string): Promise<Stripe.Event> => {
    // A live notice for a subscription Stripe doesn't have with the key in use: the wrong key at go-live (W46b).
    const event = { ...asLive(invoiceEvent('invoice.paid', GONE, { id: `in_${id}`, periodStart: ENDS, periodEnd: NEXT_END })), id: `evt_w47_${id}` }
    expect(await processWebhookEvent(event, webhookClient(db), stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
    return event
  }

  it('nothing in error: no line', async () => {
    await onASeed(async () => {
      expect(await notice()).toBeNull()
    })
  })

  it('a notice in error for 59 minutes shows no line; for 61 minutes it does, with the count, when the oldest came in, what it means and who to call', async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(new Date('2026-12-10T14:00:00.000Z'))
      const event = await failedLive(stripe, 'one')
      expect(await webhookClient(db).eventRow(event.id)).toMatchObject({ outcome: 'error' })
      minutesOn(59)
      expect(await notice()).toBeNull()
      minutesOn(2)
      const line = await notice()
      expect(line).toEqual({ count: 1, oldestAt: '2026-12-10T14:00:00.000Z', words: WEBHOOK_NOTICE_WORDS.inError(1, '2026-12-10T14:00:00.000Z') })
      expect(line?.words).toBe(
        "The booking system couldn't take in 1 notice from Stripe (the oldest came in on 10 December 2026 at 14:00). Stripe's notices are how it hears that a membership payment was taken or failed, or that a membership ended, so a member's payment date, credits or bookings may be out of date here. This is a fault in the set-up between the booking system and Stripe, not anything a member has done, and nothing on this page can fix it: don't change memberships by hand to work round it. Tell a manager today, so they can call Uncle Brother Son, who look after the booking system."
      )
      // A second one: counted, and the oldest is still the first.
      await failedLive(stripe, 'two')
      minutesOn(61)
      expect(await notice()).toMatchObject({ count: 2, oldestAt: '2026-12-10T14:00:00.000Z' })
      expect((await notice())?.words).toContain("couldn't take in 2 notices from Stripe")
    })
  })

  it('a notice sent again that goes through leaves the line: its row is processed', async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(TWELFTH)
      const client = webhookClient(db)
      fullPaymentFailed(stripe)
      const event = fullInvoice('invoice.payment_failed')
      stripe.failNext('subscriptions.retrieve', stripeDown())
      expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
      minutesOn(61)
      expect(await notice()).toMatchObject({ count: 1 })
      expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 200, body: { received: true } })
      expect(await notice()).toBeNull()
    })
  })

  it('a notice never finished (claimed, no outcome) counts after an hour, not before', async () => {
    await onASeed(async () => {
      vi.setSystemTime(new Date('2026-12-10T14:00:00.000Z'))
      await db.query("INSERT INTO stripe_webhook_events (event_id, event_type) VALUES ('evt_w47_unfinished', 'invoice.paid')")
      minutesOn(59)
      expect(await notice()).toBeNull()
      minutesOn(2)
      expect(await notice()).toMatchObject({ count: 1, oldestAt: '2026-12-10T14:00:00.000Z' })
    })
  })

  it("a test-mode notice ignored because Stripe has no such subscription shows no line, however old; a live one left like that does, at once", async () => {
    await onASeed(async (stripe) => {
      vi.setSystemTime(new Date('2026-12-10T14:00:00.000Z'))
      const event = { ...invoiceEvent('invoice.paid', GONE, { id: 'in_w47_test', periodStart: ENDS, periodEnd: NEXT_END }), id: 'evt_w47_test_mode' }
      expect(event.livemode).toBe(false)
      const client = webhookClient(db)
      expect(await processWebhookEvent(event, client, stripe)).toEqual({ status: 200, body: { received: true } })
      expect(await client.eventRow(event.id)).toMatchObject({ outcome: 'ignored', detail: { reason: 'subscription_missing', livemode: false } })
      minutesOn(61)
      expect(await notice()).toBeNull()
      // A row from before W47 doesn't say which mode it was: test data, not listed.
      await db.query(`INSERT INTO stripe_webhook_events (event_id, event_type, processed_at, outcome, detail) VALUES ('evt_w47_old_row', 'invoice.paid', now(), 'ignored', '{"reason":"subscription_missing","subscription":"sub_x"}'::jsonb)`)
      expect(await notice()).toBeNull()
      // No handler writes this today (a live one is an error, W46b): if a later change ever does, it shows.
      await db.query(`INSERT INTO stripe_webhook_events (event_id, event_type, processed_at, outcome, detail) VALUES ('evt_w47_live_ignored', 'invoice.paid', now(), 'ignored', '{"reason":"subscription_missing","subscription":"sub_y","livemode":true}'::jsonb)`)
      expect(await notice()).toMatchObject({ count: 1 })
    })
  })

  it('what is set aside on purpose is never counted: processed, ignored for any other reason (not_latest_invoice among them)', async () => {
    await onASeed(async () => {
      vi.setSystemTime(new Date('2026-12-10T14:00:00.000Z'))
      for (const [id, outcome, detail] of [
        ['a', 'processed', '{"found":true}'],
        ['b', 'ignored', '{"reason":"not_latest_invoice"}'],
        ['c', 'ignored', '{"reason":"first_invoice"}'],
        ['d', 'ignored', '{"reason":"unhandled_event_type"}'],
      ] as const) {
        await db.query('INSERT INTO stripe_webhook_events (event_id, event_type, processed_at, outcome, detail) VALUES ($1::text, $2::text, now(), $3::text, $4::text::jsonb)', [`evt_w47_${id}`, 'invoice.paid', outcome, detail])
      }
      minutesOn(600)
      expect(await notice()).toBeNull()
    })
  })

  it("a notice in error from more than 30 days ago is no longer counted: Stripe can't send it again, so it could never clear", async () => {
    // The figures are written out here, not read from the code: 30 days is how long Stripe keeps an event, and an
    // hour is the brief's.
    expect([WEBHOOK_LISTED_DAYS, WEBHOOK_ERROR_MINUTES]).toEqual([30, 60])
    await onASeed(async (stripe) => {
      vi.setSystemTime(new Date('2026-12-10T14:00:00.000Z'))
      await failedLive(stripe, 'old')
      // 29 days on it still counts; 31 days on it doesn't.
      vi.setSystemTime(new Date('2027-01-08T14:00:00.000Z'))
      expect(await notice()).toMatchObject({ count: 1, oldestAt: '2026-12-10T14:00:00.000Z' })
      vi.setSystemTime(new Date('2027-01-10T14:00:00.000Z'))
      expect(await notice()).toBeNull()
    })
  })

  it("the line doesn't stop the rest of the list: when the notices can't be read, the list still answers and the line says so", async () => {
    await onASeed(async () => {
      const failing: Db = {
        ...db,
        query: ((sql: string, params?: readonly never[]) => (sql.includes('stripe_webhook_events') ? Promise.reject(new Error('permission denied for table stripe_webhook_events')) : db.query(sql, params))) as Db['query'],
      }
      const list = await stuckList(failing)
      expect(list.webhook).toEqual({ count: 0, oldestAt: null, words: WEBHOOK_NOTICE_WORDS.unreadable })
      expect(list.checkout).toEqual([])
      expect(stuckListOutputSchema.parse(list)).toEqual(list)
    })
  })
})
