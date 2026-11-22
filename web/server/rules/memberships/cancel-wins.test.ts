import { readFileSync } from 'node:fs'
import path from 'node:path'
import type Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CANCEL_WANTED_HERE, dispatchStripeEvent, type SubscriptionReader, type SyncCancelDate } from '@/app/api/stripe/webhook/dispatch'
import { processWebhookEvent } from '@/app/api/stripe/webhook/idempotency'
import { POST as cancelRoute } from '@/app/api/v1/staff/memberships/[membershipId]/cancel/route'
import { POST as undoRoute } from '@/app/api/v1/staff/memberships/[membershipId]/undo-cancel/route'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import { stuckListOutputSchema } from '@/contracts'
import type { Db } from '@/server/db'
import { MAX_STEP_CHECKS_PER_RUN, reconcile, STEPS_TRIED_ACTION } from '@/server/rules/orders/reconcile'
import { stuckList } from '@/server/rules/orders/stuck-list'
import { fixtures, insert } from '@/server/rules/testing/database'
import { asOwner, BEFORE_031_SQL, migration031 } from '@/server/rules/testing/migration-031'
import { throughStaffApp } from '@/server/rules/testing/sweep/booking-presses'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { ID, MO_SUBSCRIPTION, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import { invoiceEvent, subscriptionUpdatedEvent, webhookClient, webhookRpc } from '@/server/rules/testing/webhook'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { syncCancelDateUnlessWanted } from './cancel-kept'
import { LEFT_STEP_WORDS } from './failure-messages'
import { leaveStep, STEP_LEFT_ACTION } from './left'
import { INVOICE_PAID_AFTER_END_ACTION, listPaidAfterEnd } from './paid-after-end'
import { MAX_STILL_LIVE_READS_PER_RUN, MEMBERSHIP_STILL_LIVE, STILL_LIVE_ACTION, STILL_LIVE_AFTER_MINUTES, stillLiveDue } from './still-live'

// Brief W47r-e (W47r-d report "Noticed" 1 to 3): a cancel pressed here is never undone by Stripe, and a live
// subscription past its last day is listed.
//
//   1. Stripe's `customer.subscription.updated` notice no longer clears a last day that a cancel pressed here still
//      wants: while the membership has an open cancel step (left, or refused by Stripe and listed), the notice is
//      answered `ignored`, `cancel_wanted_here`, and writes nothing. An Undo pressed here, a cancel that finished,
//      one put back and one marked sorted are written as before (cancel-kept.ts, dispatch.ts).
//   2. Migration 031 gains the same lines in `membership_mark_payment_failed`: a failed payment after the last day
//      does not mark the row past due (migration-031.test.ts holds the function; Mo's case is here).
//   3. A membership past its last day that has not ended here, whose Stripe subscription the automatic check finds
//      still live, is listed under membership changes, once, and the line goes when Stripe ends it (still-live.ts).
//
// Mo pays £40 a month on the 10th. December's payment goes through. Cancel is pressed for real, through the Worker's
// route: his last day is 9 January 2027. Stripe gives the cancel no answer, and then refuses it.
// Real events through the webhook's real handler with the route's own listing and its own write for a subscription
// with no end, the database's own functions on the replay's live schema, the Worker's own routes, the fake Stripe.

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
const MO_STRIPE = 'cus_member'
const MONTHLY_PRICE = 'price_seed_monthly'
const CARD = 'pm_member'
/** 10 January and 10 February 2027, 00:00 UTC (London in winter): the ends of December's and January's periods. */
const JAN_10 = Date.UTC(2027, 0, 10) / 1000
const FEB_10 = Date.UTC(2027, 1, 10) / 1000
const LAST_DAY = '2027-01-09'
const WINDOW_MS = 15 * 60_000
const ENDED_HERE_LINE = '£40.00 was taken by Stripe after this membership had ended here. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded.'
/** The brief's sentence, word for word. */
const STILL_LIVE_LINE = "Mo Member's membership ended here on 9 January, but Stripe's subscription is still live and will keep charging. Tell a manager: cancel it in Stripe."

const VERSIONS = [
  ['before 031', false],
  ['with 031', true],
] as const

let environment: ReplayEnvironment
let db: Db
/** The two functions as they were before 031, or as 031 leaves them (from the migration file). */
const functions = (with031: boolean) => asOwner(environment.database.pg, with031 ? migration031() : BEFORE_031_SQL)

beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
  await functions(true)
})
afterAll(() => {
  replayStripe.current = null
  vi.unstubAllEnvs()
  return environment.stop()
})

/**
 * The replay's seed with Mo's membership as live ones are: a Stripe subscription whose card is his saved card, its
 * next payment on 10 December; then `work`, with 031 in or not.
 */
async function onASeed(work: (stripe: FakeStripe) => Promise<void>, with031 = true): Promise<void> {
  await functions(with031)
  try {
    await replay(
      environment,
      {
        name: 'w47r-e cancel wins',
        async seed(seedDb, stripe) {
          await seed(seedDb, stripe)
          await seedDb.query("UPDATE customer_memberships SET stripe_subscription_id = $1, next_renewal_date = '2026-12-10' WHERE id = $2", [MO_SUBSCRIPTION, ID.membership])
          stripe.addSubscription(MO_SUBSCRIPTION, MO_STRIPE, MONTHLY_PRICE)
          await stripe.subscriptions.update(MO_SUBSCRIPTION, { default_payment_method: CARD })
        },
        async run({ stripe }) {
          replayStripe.current = stripe
          // The harness's old side switches every kind off for its own calls; these presses run with the kind on.
          vi.stubEnv('ORDER_SWITCH', 'membership_changes')
          synced.length = 0
          try {
            await work(stripe)
          } finally {
            replayStripe.current = null
          }
        },
      },
      workerSide()
    )
  } finally {
    await functions(true)
  }
}

type AuditRow = { action: string; actor_type: string; actor_id: string | null; entity_type: string; entity_id: string; details: Record<string, unknown> }
const audited = (action: string) => db.query<AuditRow>('SELECT action, actor_type, actor_id, entity_type, entity_id, details FROM audit_log WHERE action = $1 ORDER BY at', [action])
const stillLiveRows = () => audited(STILL_LIVE_ACTION)
const paidLines = async () => (await stuckList(db)).paymentRetries
const stepLines = async () => (await stuckList(db)).steps
const stillLiveLines = async () => (await stepLines()).filter((line) => line.what === 'still_live')
const membership = async (id: string = ID.membership) =>
  (
    await db.query<{ status: string; renews: string | null; last_day: string | null; touched: string }>(
      'SELECT subscription_status AS status, next_renewal_date::text AS renews, cancel_effective_date::text AS last_day, updated_at::text AS touched FROM customer_memberships WHERE id = $1',
      [id]
    )
  )[0]
const lastDay = async () => (await membership())?.last_day ?? null
const statesOf = async (stepId: string) =>
  (await audited(STEP_LEFT_ACTION))
    .filter((row) => row.details['stepId'] === stepId)
    .map((row) => row.details['state'] as string)
    .sort()
const methodsSince = (stripe: FakeStripe, from: number) => stripe.calls.slice(from).map((call) => call.method)
/** How many times Stripe was asked for a subscription since call number `from`. */
const readsOf = (stripe: FakeStripe, subscriptionId: string, from = 0) => stripe.calls.slice(from).filter((call) => call.method === 'subscriptions.retrieve' && JSON.stringify(call.params).includes(subscriptionId)).length
/** Calls that would change something in Stripe. */
const SENDS = new Set(['subscriptions.update', 'subscriptions.cancel', 'invoices.pay', 'refunds.create', 'paymentIntents.create'])
const sendsSince = (stripe: FakeStripe, from: number) => methodsSince(stripe, from).filter((method) => SENDS.has(method))

/** What the route gives the handler for a subscription Stripe shows with no end: the real write, counted. */
const synced: Array<Parameters<SyncCancelDate>[0]> = []
const routeSync: SyncCancelDate = (params) => {
  synced.push(params)
  return syncCancelDateUnlessWanted(db, params)
}
const lister = (requestId: string) => listPaidAfterEnd(db, { actor: { type: 'system', id: null }, requestId }, 'webhook')
/** Stripe's notice as the route handles it: its row claimed, the handler run with the route's listing and its write, the outcome recorded. */
const notice = (stripe: SubscriptionReader, event: Stripe.Event, sync: SyncCancelDate = routeSync) => processWebhookEvent(event, webhookClient(db), stripe, lister(event.id), sync)
const eventRow = (event: Stripe.Event) => webhookClient(db).eventRow(event.id)
const paidEvent = (invoice: string, periodEnd: number): Stripe.Event => invoiceEvent('invoice.paid', MO_SUBSCRIPTION, { id: invoice, periodEnd, amountPaid: 4000 })
const failedEvent = (invoice: string, periodEnd: number): Stripe.Event => invoiceEvent('invoice.payment_failed', MO_SUBSCRIPTION, { id: invoice, periodEnd })
const deletedEvent = (subscriptionId: string = MO_SUBSCRIPTION): Stripe.Event => ({ id: `evt_${crypto.randomUUID()}`, type: 'customer.subscription.deleted', livemode: false, data: { object: { id: subscriptionId, object: 'subscription' } } }) as unknown as Stripe.Event
/** Stripe's notice that the subscription changed. The handler reads Stripe for what it shows now; the snapshot is only the event's. */
const updatedEvent = (periodEnd: number = FEB_10): Stripe.Event => subscriptionUpdatedEvent(MO_SUBSCRIPTION, { cancelAt: null, periodEnd })
/** The update notice handled, and its row. */
async function updateNotice(stripe: SubscriptionReader, sync: SyncCancelDate = routeSync) {
  const event = updatedEvent()
  expect(await notice(stripe, event, sync)).toEqual({ status: 200, body: { received: true } })
  return (await eventRow(event)) as { outcome: string | null; detail: Record<string, unknown> | null; error: string | null }
}

type ErrorBody = { code: string; message: string; details?: Record<string, unknown> }
type Answer = { status: number; data?: Record<string, unknown>; error?: ErrorBody }
/** Cancel or Undo, as the membership screen reaches the Worker. */
async function press(route: 'cancel' | 'undo-cancel'): Promise<Answer> {
  // The replay holds the clock still (Postgres's too): moved on between presses, so rows read in time order keep theirs.
  vi.setSystemTime(Date.now() + 1000)
  const response = await (route === 'cancel' ? cancelRoute : undoRoute)(
    new Request(`https://worker.test/api/v1/staff/memberships/${ID.membership}/${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      body: '{}',
    }),
    { params: Promise.resolve({ membershipId: ID.membership }) }
  )
  return { status: response.status, ...((await response.json()) as { data?: Record<string, unknown>; error?: ErrorBody }) }
}
/** Mark sorted on a refused step, as the Orders page reaches the Worker. */
async function markSorted(stepId: string): Promise<Answer> {
  vi.setSystemTime(Date.now() + 1000)
  const response = await closeRoute(
    new Request('https://worker.test/api/v1/staff/orders/stuck/close', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'left_step', orderId: stepId, reason: 'The manager set it in Stripe by hand' }),
    })
  )
  return { status: response.status, ...((await response.json()) as { data?: Record<string, unknown>; error?: ErrorBody }) }
}
const no = () => ({ kind: 'error' as const, error: fakeStripeErrors.invalid('subscription_update_refused', 'This subscription cannot be updated right now.') })
const noAnswer = () => ({ kind: 'error' as const, error: fakeStripeErrors.server() })
const pastTheWindow = () => vi.setSystemTime(Date.now() + WINDOW_MS + 60_000)
/** One run of the automatic check, a second on. */
const reconcileNow = (stripe: FakeStripe, more: { maxItems?: number; budgetMs?: number; actor?: { type: 'staff' | 'system'; id: string | null } } = {}) => {
  vi.setSystemTime(Date.now() + 1000)
  return reconcile(db, stripe, { actor: more.actor ?? { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: more.maxItems ?? 50, budgetMs: more.budgetMs ?? 60_000 })
}

/**
 * 10 December: Stripe starts Mo's renewal at 13:00 and takes £40 for it at 16:00 (the fake finalises a renewal as a
 * charge that fails at 14:00; Stripe's retry at 16:00 is the payment going through), and its notice marks him paid
 * to 10 January.
 */
async function decemberPaid(stripe: FakeStripe): Promise<void> {
  vi.setSystemTime(new Date('2026-12-10T13:00:00.000Z'))
  stripe.startRenewal(MO_SUBSCRIPTION, JAN_10)
  vi.setSystemTime(new Date('2026-12-10T14:00:00.000Z'))
  const december = stripe.renewalFails(MO_SUBSCRIPTION)
  vi.setSystemTime(new Date('2026-12-10T16:00:00.000Z'))
  stripe.stripeRetryPays(december.invoice)
  expect(await dispatchStripeEvent(paidEvent(december.invoice, JAN_10), webhookRpc(db), stripe)).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated' } })
  expect(await membership()).toMatchObject({ status: 'active', renews: '2027-01-10', last_day: null })
}
/** Cancel pressed for real, and Stripe gives its send no answer: the last day is written, and the step is left. Its id. */
async function cancelWithNoAnswer(stripe: FakeStripe): Promise<string> {
  stripe.failNext('subscriptions.update', noAnswer())
  const answer = await press('cancel')
  expect(answer.status).toBe(200)
  expect(answer.data).toMatchObject({ membership: { cancel_effective_date: LAST_DAY }, endDate: '2027-01-10', stripeUpdated: false })
  const stepId = (answer.data?.['left'] as { stepId: string }).stepId
  expect(await statesOf(stepId)).toEqual(['left'])
  expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
  return stepId
}
/** The automatic check, past the press's window, sends the step and Stripe refuses it for good: listed for a person. */
async function refusedByARun(stripe: FakeStripe, stepId: string): Promise<void> {
  pastTheWindow()
  stripe.failNext('subscriptions.update', no())
  expect((await reconcileNow(stripe)).items).toEqual([expect.objectContaining({ kind: 'step', id: stepId, outcome: 'left', reason: 'step_refused' })])
  expect(await statesOf(stepId)).toEqual(['left', 'refused'])
}
/** Mo pays December, Cancel is pressed, Stripe never answers it and then refuses it. The step's id. */
async function cancelStripeNeverTook(stripe: FakeStripe): Promise<string> {
  await decemberPaid(stripe)
  const stepId = await cancelWithNoAnswer(stripe)
  await refusedByARun(stripe, stepId)
  return stepId
}
/** 10 January: Stripe, which never had the cancel, starts the renewal at 13:00 (the period moves on, and it sends its update notice). */
function januaryRenewalStarts(stripe: FakeStripe): void {
  vi.setSystemTime(new Date('2027-01-10T13:00:00.000Z'))
  stripe.startRenewal(MO_SUBSCRIPTION, FEB_10)
  expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)).toMatchObject({ status: 'active', cancelAt: null })
}
/** ... and takes £40 for it at 14:00. The invoice. */
function januaryRenewalPaid(stripe: FakeStripe): string {
  vi.setSystemTime(new Date('2027-01-10T14:00:00.000Z'))
  const january = stripe.renewalFails(MO_SUBSCRIPTION)
  stripe.stripeRetryPays(january.invoice)
  expect(stripe.subscription(MO_SUBSCRIPTION)?.status).toBe('active')
  return january.invoice
}
/** What the notice's row says when the last day was kept. */
const keptDetail = (stepId: string, stepState: 'left' | 'refused', day: string = LAST_DAY) => ({ found: true, reason: 'cancel_wanted_here', membership: ID.membership, last_day: day, step: stepId, step_state: stepState, step_last_day: LAST_DAY })

describe('item 1: Stripe\'s update notice never clears a last day a cancel pressed here still wants', () => {
  it.each(VERSIONS)(
    "the reviewer's proof 1, with a real Cancel that Stripe refused (%s): the update notice at the renewal is handled first and is ignored, `cancel_wanted_here`, with nothing written; then the payment",
    async (_name, with031) => {
      await onASeed(async (stripe) => {
        const stepId = await cancelStripeNeverTook(stripe)
        januaryRenewalStarts(stripe)
        const before = await membership()
        expect(before).toMatchObject({ status: 'active', renews: '2027-01-10', last_day: LAST_DAY })

        const row = await updateNotice(stripe)
        expect(row).toEqual({ event_type: 'customer.subscription.updated', outcome: 'ignored', detail: keptDetail(stepId, 'refused'), error: null })
        expect(CANCEL_WANTED_HERE).toBe('cancel_wanted_here')
        // Nothing written: the row is as it was, to its updated_at. The write went by the route's own, once.
        expect(await membership()).toEqual(before)
        expect(synced).toEqual([{ p_stripe_subscription_id: MO_SUBSCRIPTION, p_cancel_at_period_end: false, p_cancel_at: null, p_period_end: new Date(FEB_10 * 1000).toISOString() }])
        // The step is as it was: still open, still refused, still listed with Mark sorted.
        expect(await statesOf(stepId)).toEqual(['left', 'refused'])
        expect((await stepLines()).map((line) => [line.stepId, line.what, line.lastDay, line.state, line.close])).toEqual([[stepId, 'cancel_date', LAST_DAY, 'refused', { kind: 'left_step', orderId: stepId }]])

        const invoice = januaryRenewalPaid(stripe)
        const event = paidEvent(invoice, FEB_10)
        expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
        if (with031) {
          // Last day kept, so 031 bites: nothing written, the £40 listed once.
          expect((await eventRow(event))?.detail).toMatchObject({ found: true, action: 'ignored_cancelled', last_day: LAST_DAY, paid_after_end: { listed: true, why: 'listed', cancelled_here: true } })
          expect(await membership()).toEqual(before)
          expect((await paidLines()).map((line) => [line.invoiceId, line.amount, line.reason, line.words])).toEqual([[invoice, 40, 'paid_after_end', ENDED_HERE_LINE]])
          // The same notice again, and a new one for the same invoice, and the update again: still once, still kept.
          expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true, duplicate: true } })
          expect(await notice(stripe, paidEvent(invoice, FEB_10))).toEqual({ status: 200, body: { received: true } })
          expect((await updateNotice(stripe)).detail).toEqual(keptDetail(stepId, 'refused'))
          expect(await paidLines()).toHaveLength(1)
          expect(await audited(INVOICE_PAID_AFTER_END_ACTION)).toHaveLength(1)
          expect(await membership()).toEqual(before)
        } else {
          // Without 031 the payment is recorded, as live does today; the last day is kept all the same.
          expect((await eventRow(event))?.detail).toMatchObject({ found: true, action: 'reactivated' })
          expect(await membership()).toMatchObject({ status: 'active', renews: '2027-02-10', last_day: LAST_DAY })
          expect(await paidLines()).toEqual([])
        }
      }, with031)
    }
  )

  it('the step still left (Stripe has given no answer yet, inside the window and past it): kept the same, and the row says `left`', async () => {
    await onASeed(async (stripe) => {
      await decemberPaid(stripe)
      const stepId = await cancelWithNoAnswer(stripe)
      const before = await membership()
      // Inside the press's window.
      expect(await updateNotice(stripe)).toMatchObject({ outcome: 'ignored', detail: keptDetail(stepId, 'left') })
      // Past it, with a run that still gets no answer.
      pastTheWindow()
      stripe.failNext('subscriptions.update', noAnswer())
      expect((await reconcileNow(stripe)).items).toEqual([expect.objectContaining({ id: stepId, outcome: 'left' })])
      expect(await updateNotice(stripe)).toMatchObject({ outcome: 'ignored', detail: keptDetail(stepId, 'left') })
      expect(await membership()).toEqual(before)
      // The next run's send goes: Stripe has the end, the step is done, and Stripe's notice now agrees with the row.
      pastTheWindow()
      expect((await reconcileNow(stripe)).items).toEqual([expect.objectContaining({ id: stepId, outcome: 'finalised' })])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(JAN_10)
      const calls = synced.length
      expect(await updateNotice(stripe)).toMatchObject({ outcome: 'processed', detail: { found: true, action: 'unchanged', cancel_effective_date: LAST_DAY } })
      // Stripe showed an end: written through Supabase's client as always, not by the route's write.
      expect(synced).toHaveLength(calls)
    })
  })

  it('an Undo pressed here, then the update: cleared as now. The Undo clears the day itself, and a day Stripe\'s older notice wrote back is cleared by the next notice even while the Undo\'s own step is still open', async () => {
    await onASeed(async (stripe) => {
      await decemberPaid(stripe)
      // The cancel lands in Stripe.
      expect((await press('cancel')).data).toMatchObject({ stripeUpdated: true })
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(JAN_10)
      // Undo, and Stripe gives it no answer: the day is cleared here, its step (wanting no end) is left.
      stripe.failNext('subscriptions.update', noAnswer())
      const undo = await press('undo-cancel')
      const undoStep = (undo.data?.['left'] as { stepId: string }).stepId
      expect(await lastDay()).toBeNull()
      // Stripe still has the end, and a notice of it writes the day back (as it always did: Stripe showed an end).
      expect(await updateNotice(stripe)).toMatchObject({ outcome: 'processed', detail: { action: 'cancel_scheduled', cancel_effective_date: LAST_DAY } })
      expect(await lastDay()).toBe(LAST_DAY)
      // The Undo's send then takes effect in Stripe with its answer lost: the step stays open, wanting no end.
      pastTheWindow()
      stripe.failNext('subscriptions.update', { kind: 'lost_response' })
      expect((await reconcileNow(stripe)).items).toEqual([expect.objectContaining({ id: undoStep, outcome: 'left' })])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
      expect(await statesOf(undoStep)).toEqual(['left'])
      // Stripe's notice: no end. The open step is an Undo's, so the day is cleared, as before W47r-e.
      expect(await updateNotice(stripe)).toEqual({ event_type: 'customer.subscription.updated', outcome: 'processed', detail: { found: true, action: 'cancel_cleared', cancel_effective_date: null }, error: null })
      expect(await lastDay()).toBeNull()
    })
  })

  it('a cancel that landed: Stripe\'s notice of the end changes nothing, as now; and an end then taken off in Stripe by hand clears the day, as now (the step is finished)', async () => {
    await onASeed(async (stripe) => {
      await decemberPaid(stripe)
      const answer = await press('cancel')
      expect(answer.data).toMatchObject({ stripeUpdated: true })
      expect(await updateNotice(stripe)).toMatchObject({ outcome: 'processed', detail: { found: true, action: 'unchanged', cancel_effective_date: LAST_DAY } })
      expect(synced).toEqual([])
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
      expect(await updateNotice(stripe)).toMatchObject({ outcome: 'processed', detail: { found: true, action: 'cancel_cleared', cancel_effective_date: null } })
      expect(synced).toHaveLength(1)
      expect(await lastDay()).toBeNull()
    })
  })

  it('a refused step a person marked sorted is theirs: the next notice with no end clears the day, as now', async () => {
    await onASeed(async (stripe) => {
      const stepId = await cancelStripeNeverTook(stripe)
      expect((await updateNotice(stripe)).detail).toEqual(keptDetail(stepId, 'refused'))
      expect((await markSorted(stepId)).data).toMatchObject({ closed: true })
      expect(await statesOf(stepId)).toEqual(['left', 'refused', 'sorted'])
      expect(await updateNotice(stripe)).toMatchObject({ outcome: 'processed', detail: { action: 'cancel_cleared', cancel_effective_date: null } })
      expect(await lastDay()).toBeNull()
    })
  })

  it('a cancel Stripe refused at the press is put back (its step `undone`): there is no day to keep, and the notice is answered as now', async () => {
    await onASeed(async (stripe) => {
      await decemberPaid(stripe)
      stripe.failNext('subscriptions.update', no())
      expect((await press('cancel')).status).toBe(409)
      expect(await lastDay()).toBeNull()
      expect(await updateNotice(stripe)).toMatchObject({ outcome: 'processed', detail: { found: true, action: 'unchanged', cancel_effective_date: null } })
    })
  })

  it.each([
    ['no step at all (a last day Stripe\'s own notice wrote, or one from before steps)', async () => {}],
    [
      'an open card step on the same subscription',
      async () => void (await db.transaction((tx) => leaveStep(tx, { membershipId: ID.membership, subscriptionId: MO_SUBSCRIPTION, kind: 'payment_method', want: { paymentMethod: 'pm_new' } }, { actor: { type: 'system', id: null }, requestId: 'test' }))),
    ],
    [
      "another membership's open cancel step",
      async () => {
        const other = await insert(db, 'customer_memberships', { customer_id: await fixtures.customer(db), plan_id: ID.plan, start_date: '2026-01-10', subscription_status: 'active', billing_frequency: 'monthly', stripe_subscription_id: 'sub_other', cancel_effective_date: LAST_DAY })
        await db.transaction((tx) => leaveStep(tx, { membershipId: other, subscriptionId: 'sub_other', kind: 'cancel_at', want: { cancelAt: JAN_10 } }, { actor: { type: 'system', id: null }, requestId: 'test' }))
      },
    ],
    [
      "an open cancel step that names this subscription on another membership's row",
      async () => {
        const other = await insert(db, 'customer_memberships', { customer_id: await fixtures.customer(db), plan_id: ID.plan, start_date: '2026-01-10', subscription_status: 'active', billing_frequency: 'monthly', stripe_subscription_id: 'sub_other' })
        await db.transaction((tx) => leaveStep(tx, { membershipId: other, subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', want: { cancelAt: JAN_10 } }, { actor: { type: 'system', id: null }, requestId: 'test' }))
      },
    ],
  ])('only an open cancel step of this membership that wants an end keeps the day: with %s the notice clears it, as now', async (_name, prepare) => {
    await onASeed(async (stripe) => {
      await db.query('UPDATE customer_memberships SET cancel_effective_date = $1::date WHERE id = $2', [LAST_DAY, ID.membership])
      await prepare()
      expect(await updateNotice(stripe)).toMatchObject({ outcome: 'processed', detail: { found: true, action: 'cancel_cleared', cancel_effective_date: null } })
      expect(await lastDay()).toBeNull()
    })
  })

  it('with an open cancel step but nothing to keep, the database function answers as it always did: a row that has ended (`ignored_cancelled`), a row with no last day (`unchanged`), and no membership at all (`found: false`, ignored)', async () => {
    await onASeed(async (stripe) => {
      await decemberPaid(stripe)
      const stepId = await cancelWithNoAnswer(stripe)
      await db.query("UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE id = $1", [ID.membership])
      expect(await updateNotice(stripe)).toMatchObject({ outcome: 'processed', detail: { found: true, action: 'ignored_cancelled' } })
      expect(await lastDay()).toBe(LAST_DAY)
      await db.query("UPDATE customer_memberships SET subscription_status = 'active', cancel_effective_date = NULL WHERE id = $1", [ID.membership])
      expect(await updateNotice(stripe)).toMatchObject({ outcome: 'processed', detail: { found: true, action: 'unchanged', cancel_effective_date: null } })
      expect(await statesOf(stepId)).toEqual(['left'])
      await db.query('UPDATE customer_memberships SET stripe_subscription_id = NULL WHERE id = $1', [ID.membership])
      expect(await updateNotice(stripe)).toMatchObject({ outcome: 'ignored', detail: { found: false } })
    })
  })

  it('the write that keeps the day fails (the database): the notice is an error and answered 500, nothing is written, and Stripe sending it again is handled', async () => {
    await onASeed(async (stripe) => {
      const stepId = await cancelStripeNeverTook(stripe)
      const before = await membership()
      const event = updatedEvent()
      let failed = 0
      const failing: SyncCancelDate = async (params) => {
        if (failed++ === 0) throw new Error('the database is not there')
        return routeSync(params)
      }
      expect(await notice(stripe, event, failing)).toEqual({ status: 500, body: { error: 'Internal server error' } })
      expect(await eventRow(event)).toMatchObject({ outcome: 'error', error: 'the database is not there' })
      expect(await membership()).toEqual(before)
      expect(await notice(stripe, event, failing)).toEqual({ status: 200, body: { received: true } })
      expect(await eventRow(event)).toMatchObject({ outcome: 'ignored', detail: keptDetail(stepId, 'refused'), error: null })
      expect(await membership()).toEqual(before)
    })
  })

  it('the read after the write (L8): Stripe shows an end at the first read (written, as always) and none at the second. That second write is held back for the open cancel step: processed, with the reason, and the day the first write wrote stays', async () => {
    await onASeed(async (stripe) => {
      const stepId = await cancelStripeNeverTook(stripe)
      // Stripe's subscription with an end of 10 February at the first read (set in Stripe by hand, say), then none.
      let reads = 0
      const flickering: SubscriptionReader = {
        subscriptions: {
          retrieve: async (id) => {
            const now = await stripe.subscriptions.retrieve(id)
            return reads++ === 0 ? ({ ...now, cancel_at: FEB_10 } as Stripe.Subscription) : now
          },
        },
      }
      const row = await updateNotice(flickering)
      expect(row).toEqual({
        event_type: 'customer.subscription.updated',
        outcome: 'processed',
        detail: { ...keptDetail(stepId, 'refused', '2027-02-09'), written_again: 1, last_write: 'membership_sync_cancel_at_period_end' },
        error: null,
      })
      expect(reads).toBe(2)
      expect(await lastDay()).toBe('2027-02-09')
    })
  })

  it('a caller that gives the handler no write of its own (a test of something else) gets it as it was before W47r-e: the day is cleared', async () => {
    await onASeed(async (stripe) => {
      await cancelStripeNeverTook(stripe)
      expect(await dispatchStripeEvent(updatedEvent(), webhookRpc(db), stripe)).toEqual({ outcome: 'processed', detail: { found: true, action: 'cancel_cleared', cancel_effective_date: null } })
      expect(await lastDay()).toBeNull()
    })
  })

  it("the webhook's route gives the handler that write, on the Worker's own connection, closed afterwards", () => {
    const route = readFileSync(path.join(__dirname, '../../../app/api/stripe/webhook/route.ts'), 'utf8')
    expect(route).toContain("import { syncCancelDateUnlessWanted } from '@/server/rules/memberships/cancel-kept'")
    expect(route).toMatch(/const syncCancelDate: SyncCancelDate = async \(params\) => \{\s+const db = openRequestDb\(\)\s+try \{\s+return await syncCancelDateUnlessWanted\(db, params\)\s+\} finally \{\s+await closeRequestDb\(db\)\s+\}\s+\}/)
    expect(route).toContain('createStripeClient(process.env.STRIPE_SECRET_KEY, READ_STRIPE_LIMITS), list, syncCancelDate)')
  })
})

describe('item 2: with 031, a failed payment after the last day does not mark the membership past due', () => {
  it.each(VERSIONS)('Mo, last day 9 January, the cancel never in Stripe; on 10 January his card is declined (%s)', async (_name, with031) => {
    await onASeed(async (stripe) => {
      const stepId = await cancelStripeNeverTook(stripe)
      januaryRenewalStarts(stripe)
      expect((await updateNotice(stripe)).detail).toEqual(keptDetail(stepId, 'refused'))
      const before = await membership()
      vi.setSystemTime(new Date('2027-01-10T14:00:00.000Z'))
      const january = stripe.renewalFails(MO_SUBSCRIPTION).invoice
      const event = failedEvent(january, FEB_10)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      const pastDuePastLastDay = async () => Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM customer_memberships WHERE subscription_status = 'past_due' AND cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date"))[0]?.n)
      if (with031) {
        expect(await eventRow(event)).toMatchObject({ outcome: 'processed', detail: { found: true, action: 'ignored_cancelled', last_day: LAST_DAY } })
        expect((await eventRow(event))?.detail).not.toHaveProperty('paid_after_end')
        expect(await membership()).toEqual(before)
        // 031's second pre-check no longer counts him.
        expect(await pastDuePastLastDay()).toBe(0)
      } else {
        expect(await eventRow(event)).toMatchObject({ outcome: 'processed', detail: { found: true, action: 'past_due' } })
        expect(await membership()).toMatchObject({ status: 'past_due', last_day: LAST_DAY })
        expect(await pastDuePastLastDay()).toBe(1)
      }
      // No money moved, so nothing is listed for a refund either way.
      expect(await paidLines()).toEqual([])
    }, with031)
  })
})

/** Mo's last day set as Cancel writes it, with no step: item 3 goes by the row and Stripe alone. Then the clock moved to `at`. */
async function pastLastDay(at = '2027-01-10T14:00:00.000Z', day: string = LAST_DAY): Promise<void> {
  await db.query('UPDATE customer_memberships SET cancel_effective_date = $1::date WHERE id = $2', [day, ID.membership])
  vi.setSystemTime(new Date(at))
}
/** One more member past their last day, with a live subscription in Stripe. The membership's id. */
async function anotherPastLastDay(stripe: FakeStripe, subscriptionId: string, row: Record<string, unknown> = {}): Promise<string> {
  stripe.addSubscription(subscriptionId, `cus_${subscriptionId}`, MONTHLY_PRICE)
  return insert(db, 'customer_memberships', { customer_id: await fixtures.customer(db), plan_id: ID.plan, start_date: '2026-01-10', subscription_status: 'active', billing_frequency: 'monthly', stripe_subscription_id: subscriptionId, cancel_effective_date: LAST_DAY, ...row })
}

describe('item 3: a membership past its last day whose Stripe subscription is still live is listed', () => {
  it.each(VERSIONS)("the brief's line, after the proof (%s): the automatic check reads Stripe, finds the subscription live and lists it once under membership changes, with no button; nothing is sent and the membership is not changed", async (_name, with031) => {
    await onASeed(async (stripe) => {
      const stepId = await cancelStripeNeverTook(stripe)
      januaryRenewalStarts(stripe)
      await updateNotice(stripe)
      const invoice = januaryRenewalPaid(stripe)
      await notice(stripe, paidEvent(invoice, FEB_10))
      const before = await membership()
      expect(before?.last_day).toBe(LAST_DAY)
      expect(await stillLiveLines()).toEqual([])

      const from = stripe.calls.length
      const run = await reconcileNow(stripe)
      const [row] = await stillLiveRows()
      const listingId = row?.details['listingId'] as string
      expect(listingId).toMatch(/^[0-9a-f-]{36}$/)
      expect(run.items).toEqual([
        { kind: 'step', id: listingId, outcome: 'left', reason: 'membership_still_live', detail: `membership ${ID.membership} ended here on ${LAST_DAY}, and Stripe shows its subscription ${MO_SUBSCRIPTION} active: listed for a person` },
      ])
      expect(MEMBERSHIP_STILL_LIVE).toBe('membership_still_live')
      expect(await stillLiveRows()).toEqual([
        { action: STILL_LIVE_ACTION, actor_type: 'system', actor_id: null, entity_type: 'membership', entity_id: ID.membership, details: { state: 'listed', subscriptionId: MO_SUBSCRIPTION, stripeStatus: 'active', listingId, lastDay: LAST_DAY, stripeEnds: null } },
      ])
      // The list: the refused cancel step (as before), then the new line, with the brief's words and no close.
      const list = await stuckList(db)
      expect(stuckListOutputSchema.parse(list).steps).toEqual(list.steps)
      expect(list.steps.map((line) => line.stepId)).toEqual([stepId, listingId])
      expect(list.steps[1]).toEqual({
        stepId: listingId,
        membershipId: ID.membership,
        subscriptionId: MO_SUBSCRIPTION,
        step: 'cancel_at',
        what: 'still_live',
        lastDay: LAST_DAY,
        customerId: ID.member,
        customerName: 'Mo Member',
        state: 'refused',
        at: expect.stringMatching(/^2027-01-10T14:00:01\.\d{3}Z$/),
        words: STILL_LIVE_LINE,
      })
      expect(LEFT_STEP_WORDS.stillLive('Mo Member', LAST_DAY)).toBe(STILL_LIVE_LINE)
      // Read only: Stripe was asked for the subscription and sent nothing; the membership is as it was.
      expect(readsOf(stripe, MO_SUBSCRIPTION, from)).toBe(1)
      expect(sendsSince(stripe, from)).toEqual([])
      expect(await membership()).toEqual(before)

      // Listed once: later runs read it again, write nothing and report nothing.
      for (let again = 0; again < 3; again += 1) expect((await reconcileNow(stripe)).items).toEqual([])
      expect(await stillLiveRows()).toHaveLength(1)
      expect(await stillLiveLines()).toHaveLength(1)
      expect(readsOf(stripe, MO_SUBSCRIPTION, from)).toBe(4)
      expect(sendsSince(stripe, from)).toEqual([])
      // With 031 the £40 is listed too, by its own line; without it, this is the only line that says anything is wrong.
      expect(await paidLines()).toHaveLength(with031 ? 1 : 0)
    }, with031)
  })

  it('once listed, Stripe ending it clears the line: the manager cancels the subscription in Stripe, Stripe\'s notice ends the membership here, and it is no longer listed or read', async () => {
    await onASeed(async (stripe) => {
      await pastLastDay()
      await reconcileNow(stripe)
      expect((await stillLiveLines()).map((line) => line.words)).toEqual([STILL_LIVE_LINE])
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      expect(await dispatchStripeEvent(deletedEvent(), webhookRpc(db), stripe)).toMatchObject({ outcome: 'processed', detail: { action: 'cancelled' } })
      expect(await stillLiveLines()).toEqual([])
      expect(await stillLiveDue(db)).toEqual([])
      const from = stripe.calls.length
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(readsOf(stripe, MO_SUBSCRIPTION, from)).toBe(0)
      expect(await stillLiveRows()).toHaveLength(1)
    })
  })

  it('the same when Stripe\'s notice of the end never arrives: the next run reads Stripe, sees it ended, records that, and the line is gone; it is not read again, and the membership is left alone', async () => {
    await onASeed(async (stripe) => {
      await pastLastDay()
      await reconcileNow(stripe)
      const [listedRow] = await stillLiveRows()
      expect(await stillLiveLines()).toHaveLength(1)
      const before = await membership()
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect((await stillLiveRows()).map((row) => row.details)).toEqual([listedRow?.details, { state: 'ended', subscriptionId: MO_SUBSCRIPTION, stripeStatus: 'canceled', wasListed: true, listingId: listedRow?.details['listingId'] }])
      expect(await stillLiveLines()).toEqual([])
      expect(await membership()).toEqual(before)
      const from = stripe.calls.length
      await reconcileNow(stripe)
      await reconcileNow(stripe)
      expect(readsOf(stripe, MO_SUBSCRIPTION, from)).toBe(0)
      expect(await stillLiveRows()).toHaveLength(2)
    })
  })

  it.each(['canceled', 'incomplete_expired'] as const)('a row Stripe shows ended (%s) is left alone: never listed, the membership untouched, one note so it is not read again', async (status) => {
    await onASeed(async (stripe) => {
      await pastLastDay()
      stripe.setSubscription(MO_SUBSCRIPTION, { status })
      const before = await membership()
      const from = stripe.calls.length
      for (let run = 0; run < 3; run += 1) expect((await reconcileNow(stripe)).items).toEqual([])
      expect(await stillLiveLines()).toEqual([])
      expect((await stillLiveRows()).map((row) => row.details)).toEqual([{ state: 'ended', subscriptionId: MO_SUBSCRIPTION, stripeStatus: status, wasListed: false }])
      expect(await membership()).toEqual(before)
      expect(readsOf(stripe, MO_SUBSCRIPTION, from)).toBe(1)
      expect(sendsSince(stripe, from)).toEqual([])
    })
  })

  it.each(['active', 'past_due', 'unpaid', 'trialing', 'paused'] as const)('live in Stripe as `%s`: listed (it has not ended, so it can still charge)', async (status) => {
    await onASeed(async (stripe) => {
      await pastLastDay()
      stripe.setSubscription(MO_SUBSCRIPTION, { status })
      expect((await reconcileNow(stripe)).items).toEqual([expect.objectContaining({ kind: 'step', outcome: 'left', reason: 'membership_still_live' })])
      expect((await stillLiveLines()).map((line) => line.words)).toEqual([STILL_LIVE_LINE])
      expect((await stillLiveRows())[0]?.details).toMatchObject({ state: 'listed', stripeStatus: status })
    })
  })

  it('a membership marked past due here is read and listed the same', async () => {
    await onASeed(async (stripe) => {
      await pastLastDay()
      await db.query("UPDATE customer_memberships SET subscription_status = 'past_due' WHERE id = $1", [ID.membership])
      await reconcileNow(stripe)
      expect((await stillLiveLines()).map((line) => line.words)).toEqual([STILL_LIVE_LINE])
    })
  })

  it.each([
    ['its last day is today', async () => pastLastDay('2027-01-09T14:00:00.000Z')],
    ['its last day is still to come', async () => pastLastDay('2027-01-05T14:00:00.000Z')],
    ['it has no last day', async () => vi.setSystemTime(new Date('2027-01-10T14:00:00.000Z'))],
    ['it has ended here', async () => (await pastLastDay(), void (await db.query("UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE id = $1", [ID.membership])))],
    ['its last day ended 19 minutes ago (London midnight)', async () => pastLastDay('2027-01-10T00:19:00.000Z')],
    ['its last day ended 19 minutes ago in summer (23:19 UTC is 00:19 in London)', async () => pastLastDay('2027-06-30T23:19:00.000Z', '2027-06-30')],
  ])('not read at all when %s: no Stripe call, no row, no line', async (_name, prepare) => {
    await onASeed(async (stripe) => {
      await prepare()
      const from = stripe.calls.length
      expect(await stillLiveDue(db)).toEqual([])
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(readsOf(stripe, MO_SUBSCRIPTION, from)).toBe(0)
      expect(await stillLiveRows()).toEqual([])
      expect(await stillLiveLines()).toEqual([])
    })
  })

  it.each([
    ['2027-01-10T00:21:00.000Z', LAST_DAY, '9 January'],
    ['2027-06-30T23:21:00.000Z', '2027-06-30', '30 June'],
  ])('read from 20 minutes after the last day ends in London (%s): listed, with the day in words', async (at, day, words) => {
    await onASeed(async (stripe) => {
      expect(STILL_LIVE_AFTER_MINUTES).toBe(20)
      await pastLastDay(at, day)
      expect(await stillLiveDue(db)).toEqual([{ membershipId: ID.membership, subscriptionId: MO_SUBSCRIPTION, lastDay: day }])
      await reconcileNow(stripe)
      expect((await stillLiveLines()).map((line) => [line.lastDay, line.words])).toEqual([[day, `Mo Member's membership ended here on ${words}, but Stripe's subscription is still live and will keep charging. Tell a manager: cancel it in Stripe.`]])
    })
  })

  it('a membership with no subscription is not this check\'s: W46 ends it in the database, with no Stripe read', async () => {
    await onASeed(async (stripe) => {
      await pastLastDay()
      await db.query('UPDATE customer_memberships SET stripe_subscription_id = NULL WHERE id = $1', [ID.membership])
      const from = stripe.calls.length
      await reconcileNow(stripe)
      expect(await membership()).toMatchObject({ status: 'cancelled', last_day: LAST_DAY })
      expect(readsOf(stripe, MO_SUBSCRIPTION, from)).toBe(0)
      expect(await stillLiveRows()).toEqual([])
    })
  })

  it("Stripe is ending it itself (its own end has fallen due and it still reads active for a moment): not listed; read again next run, and left alone once Stripe shows it ended. An end Stripe has that is still to come is listed", async () => {
    await onASeed(async (stripe) => {
      await pastLastDay('2027-01-10T00:21:00.000Z')
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: JAN_10 })
      const from = stripe.calls.length
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(await stillLiveRows()).toEqual([])
      expect(await stillLiveLines()).toEqual([])
      expect(readsOf(stripe, MO_SUBSCRIPTION, from)).toBe(1)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect((await stillLiveRows()).map((row) => row.details['state'])).toEqual(['ended'])
      expect(await stillLiveLines()).toEqual([])
    })
    await onASeed(async (stripe) => {
      await pastLastDay()
      // Stripe ends it on 10 February: live for a month after the last day here, and it renews on 10 January.
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: FEB_10 })
      await reconcileNow(stripe)
      expect((await stillLiveRows()).map((row) => row.details)).toEqual([expect.objectContaining({ state: 'listed', stripeEnds: FEB_10 })])
      expect(await stillLiveLines()).toHaveLength(1)
    })
  })

  it.each([
    ['gives no clear answer', () => noAnswer()],
    ["can't find the subscription with the key in use", () => ({ kind: 'error' as const, error: fakeStripeErrors.missing(`subscription: '${MO_SUBSCRIPTION}'`) })],
  ])('Stripe %s: nothing is written and nothing listed; the next run reads again and lists it', async (_name, fault) => {
    await onASeed(async (stripe) => {
      await pastLastDay()
      stripe.failNext('subscriptions.retrieve', fault())
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(await stillLiveRows()).toEqual([])
      expect(await stillLiveLines()).toEqual([])
      expect((await reconcileNow(stripe)).items).toEqual([expect.objectContaining({ reason: 'membership_still_live' })])
      expect(await stillLiveLines()).toHaveLength(1)
    })
  })

  it("nothing is listed for a membership that stopped being past its last day while Stripe was being read (Stripe's notice ended it meanwhile): the row is looked at again under its lock", async () => {
    await onASeed(async (stripe) => {
      await pastLastDay()
      const original = stripe.subscriptions.retrieve.bind(stripe.subscriptions)
      const racing = Object.create(stripe) as FakeStripe
      // Writable and configurable: reconcile reads the client through a Proxy, which may not answer a fixed property with its own wrapper.
      Object.defineProperty(racing, 'subscriptions', {
        writable: true,
        configurable: true,
        value: {
          ...stripe.subscriptions,
          retrieve: async (...args: Parameters<typeof original>) => {
            const answer = await original(...args)
            // Stripe showed it live; before the line is written, its ending is handled here.
            await db.query("UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE id = $1", [ID.membership])
            return answer
          },
        },
      })
      const from = stripe.calls.length
      expect((await reconcileNow(racing)).items).toEqual([])
      // The read was made, and the ending landed while it was out.
      expect(readsOf(stripe, MO_SUBSCRIPTION, from)).toBe(1)
      expect((await membership())?.status).toBe('cancelled')
      expect(await stillLiveRows()).toEqual([])
      expect(await stillLiveLines()).toEqual([])
    })
  })

  it('the line goes while the membership is no longer past its last day (Stripe\'s notice wrote a later end), and comes back, the same line, if that day passes too', async () => {
    await onASeed(async (stripe) => {
      await pastLastDay()
      await reconcileNow(stripe)
      const [line] = await stillLiveLines()
      await db.query("UPDATE customer_memberships SET cancel_effective_date = '2027-02-09' WHERE id = $1", [ID.membership])
      expect(await stillLiveLines()).toEqual([])
      vi.setSystemTime(new Date('2027-02-10T14:00:00.000Z'))
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(await stillLiveRows()).toHaveLength(1)
      expect(await stillLiveLines()).toEqual([{ ...line, lastDay: '2027-02-09', words: LEFT_STEP_WORDS.stillLive('Mo Member', '2027-02-09') }])
    })
  })

  it('by last checked, inside the run\'s limits: with seven due a run reads five, the next run reads the two it did not get to first, and all seven are listed, each once; a run with no time left reads none', async () => {
    await onASeed(async (stripe) => {
      expect(MAX_STILL_LIVE_READS_PER_RUN).toBe(5)
      expect(MAX_STEP_CHECKS_PER_RUN).toBe(5)
      await pastLastDay()
      const subscriptions = [MO_SUBSCRIPTION]
      for (let n = 1; n <= 6; n += 1) {
        subscriptions.push(`sub_live_${n}`)
        // Older last days than Mo's, so the due list has them first.
        await anotherPastLastDay(stripe, `sub_live_${n}`, { cancel_effective_date: `2027-01-0${n}` })
      }
      expect((await stillLiveDue(db)).map((due) => due.subscriptionId)).toEqual([...subscriptions.slice(1), MO_SUBSCRIPTION])
      const readsEach = (from: number) => subscriptions.map((id) => readsOf(stripe, id, from))

      // No time: nothing is read.
      const start = stripe.calls.length
      expect((await reconcileNow(stripe, { budgetMs: 0 })).items).toEqual([])
      expect(readsEach(start)).toEqual([0, 0, 0, 0, 0, 0, 0])

      const first = await reconcileNow(stripe)
      expect(first.items.map((item) => item.reason)).toEqual(Array(5).fill('membership_still_live'))
      expect(readsEach(start)).toEqual([0, 1, 1, 1, 1, 1, 0])
      // The run could not get to all seven: it says which it read, for the next runs.
      const tried = await audited(STEPS_TRIED_ACTION)
      expect(tried).toHaveLength(1)
      expect((tried[0]?.details['live'] as string[]).map((key) => key.split('|')[1])).toEqual(subscriptions.slice(1, 6))

      const second = await reconcileNow(stripe)
      expect(second.items.map((item) => item.reason)).toEqual(['membership_still_live', 'membership_still_live'])
      // The two not read before go first; then the three read longest ago.
      expect(readsEach(start)).toEqual([1, 2, 2, 2, 1, 1, 1])
      expect(await stillLiveLines()).toHaveLength(7)
      expect(await stillLiveRows()).toHaveLength(7)

      // All listed: later runs keep reading five a run and write nothing more. The third run takes the two read
      // longest ago (the last two of the first run), then, of the five the second run read, the first three due.
      const third = await reconcileNow(stripe)
      expect(third.items).toEqual([])
      expect(readsEach(start)).toEqual([1, 3, 3, 3, 2, 2, 1])
      // The fourth takes the two the third left (Mo's and the sixth), then three more: nobody waits more than a run.
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(readsEach(start)).toEqual([2, 4, 4, 4, 2, 2, 2])
      expect(await stillLiveRows()).toHaveLength(7)
      expect(sendsSince(stripe, start)).toEqual([])
    })
  })

  it("on staff's run (Resolve now) too, inside its ten items", async () => {
    await onASeed(async (stripe) => {
      await pastLastDay()
      const run = await reconcileNow(stripe, { actor: { type: 'staff', id: ID.staff }, maxItems: 10, budgetMs: 15_000 })
      expect(run.items).toEqual([expect.objectContaining({ kind: 'step', outcome: 'left', reason: 'membership_still_live' })])
      expect((await stillLiveRows())[0]).toMatchObject({ actor_type: 'staff', actor_id: ID.staff })
    })
  })

  it("the staff app: getStuckReaderPayments passes the line through as the Worker sends it; its heading says what it is, it has no button, and the banner counts it as a membership change", async () => {
    await onASeed(async (stripe) => {
      await pastLastDay()
      await reconcileNow(stripe)
      const [line] = await stillLiveLines()
      const list = (await throughStaffApp('getStuckReaderPayments')(db, {})) as { steps: Array<Record<string, unknown>> }
      expect(list.steps).toEqual([line])
      expect(line).not.toHaveProperty('close')
      const helpers = (await import(/* @vite-ignore */ path.join(staffAppDir(), 'frontend/utils/stuckList'))) as {
        stepLabel(item: { what: string; lastDay?: string; state: string; customerName: string | null }, formatDay: (isoDate: string) => string): string
        stuckCounts(data: unknown): { payments: number; memberships: number; watching: number }
      }
      const day = (isoDate: string) => `[${isoDate}]`
      expect(helpers.stepLabel(line as never, day)).toBe('Membership ended here (last day [2027-01-09]), still live in Stripe · Mo Member')
      expect(helpers.stepLabel({ what: 'still_live', state: 'refused', customerName: null }, day)).toBe('Membership ended here, still live in Stripe')
      // The older headings are as they were.
      expect(helpers.stepLabel({ what: 'cancel_date', lastDay: '2026-12-09', state: 'refused', customerName: 'Mo Member' }, day)).toBe('Membership cancellation (last day [2026-12-09]) refused by Stripe · Mo Member')
      expect(helpers.stuckCounts(list)).toMatchObject({ memberships: 1 })
      const banner = readFileSync(path.join(staffAppDir(), 'frontend/components/StuckPaymentsBanner.tsx'), 'utf8')
      // W58b (the lead's item 2): with the step's kind, for Mark sorted's words.
      expect(banner).toContain('{closeButton(item.close, stepLabel(item, formatDate), item.words, item.what)}')
    })
  })
})
