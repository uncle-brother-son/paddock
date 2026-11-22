import type Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dispatchStripeEvent, type SubscriptionReader } from '@/app/api/stripe/webhook/dispatch'
import { processWebhookEvent } from '@/app/api/stripe/webhook/idempotency'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import { closeStuckOutputSchema, stuckCloseKindSchema, stuckListOutputSchema } from '@/contracts'
import type { Db } from '@/server/db'
import { CLOSE_ACTION } from '@/server/rules/orders/close-stuck'
import { reconcile } from '@/server/rules/orders/reconcile'
import { stuckList } from '@/server/rules/orders/stuck-list'
import { insert } from '@/server/rules/testing/database'
import { asOwner, BEFORE_031_SQL, migration031 } from '@/server/rules/testing/migration-031'
import { throughStaffApp } from '@/server/rules/testing/sweep/booking-presses'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { ID, MO_SUBSCRIPTION, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe, stripeClientsMade } from '@/server/rules/testing/replay/stripe-binding'
import { invoiceEvent, webhookClient, webhookRpc } from '@/server/rules/testing/webhook'
import type { FakeStripe } from '@/server/stripe/fake'
import { PAYMENT_RETRY_OWED_WORDS, PAYMENT_RETRY_WORDS } from './failure-messages'
import { INVOICE_LINE_CLOSING_STATES, INVOICE_PAID_AFTER_END_ACTION, listPaidAfterEnd } from './paid-after-end'

// Brief W47r-d (W47r-c "Noticed" 1 to 3): a renewal Stripe takes after Cancel was pressed here is listed.
//
// Cancel pressed here writes the membership's last day and leaves its status `active`; the row is marked cancelled
// only when Stripe ends the subscription. When that cancel never reaches Stripe, Stripe renews.
//   1. Migration 031: `membership_mark_paid` writes nothing for a row whose last day has passed and answers
//      `ignored_cancelled`, which W47r-c's listing then lists. 031 is not applied to live by W47r-d and the saved
//      schema is as live is, so this file puts 031 in from the migration file itself, and puts the function back as it
//      was (migration-031.ts) where a test shows what the Worker does without it: every test here reads the same
//      before and after the snapshot is refreshed.
//   2. A notice handled after a manager has cancelled the subscription in Stripe finds the payment "before the end"
//      there. It is listed all the same when the row's last day shows the payment was on or after it.
//   3. A line whose money was owed is cleared with Mark as owed: Issue refunds, a reason, no Stripe call.
//
// Mo pays £40 a month on the 10th. December's payment goes through. Cancel is pressed: his last day is 9 January 2027.
// Real events through the webhook's real handler and the route's own listing, the database's own functions on the
// replay's live schema, the Worker's own close route, and the fake Stripe.

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
const NO_REFUNDS = 'front.desk@example.com'
const MO_STRIPE = 'cus_member'
const MONTHLY_PRICE = 'price_seed_monthly'
const CARD = 'pm_member'
const secondsAt = (iso: string): number => Date.parse(iso) / 1000
/** 10 January and 10 February 2027, 00:00 UTC (London in winter): the ends of December's and January's periods. */
const JAN_10 = Date.UTC(2027, 0, 10) / 1000
const FEB_10 = Date.UTC(2027, 1, 10) / 1000
const LAST_DAY = '2027-01-09'
const FOUR_PM_DEC_10 = secondsAt('2026-12-10T16:00:00.000Z')
const TWO_PM_JAN_10 = secondsAt('2027-01-10T14:00:00.000Z')
const THREE_PM_JAN_10 = secondsAt('2027-01-10T15:00:00.000Z')
const ENDED_HERE_LINE = '£40.00 was taken by Stripe after this membership had ended here. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded.'
const PAST_LAST_DAY_LINE = "£40.00 was taken by Stripe on or after this membership's last day here (9 Jan 2027), before its subscription was cancelled in Stripe. Refund it in Stripe (tell a manager), then press Mark refunded."
const OWED_REASON = 'Paid for December, which Mo had: checked with the manager'

const VERSIONS = [
  ['before 031', false],
  ['with 031', true],
] as const

let environment: ReplayEnvironment
let db: Db
/** `membership_mark_paid` as it was before 031, or as 031 leaves it (from the migration file). */
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
 * next payment on 10 December; one more staff member, without Issue refunds; then `work`, with 031 in or not.
 */
async function onASeed(work: (stripe: FakeStripe) => Promise<void>, with031 = true): Promise<void> {
  await functions(with031)
  try {
    await replay(
      environment,
      {
        name: 'w47r-d cancelled here',
        async seed(seedDb, stripe) {
          await seed(seedDb, stripe)
          await seedDb.query("UPDATE customer_memberships SET stripe_subscription_id = $1, next_renewal_date = '2026-12-10' WHERE id = $2", [MO_SUBSCRIPTION, ID.membership])
          stripe.addSubscription(MO_SUBSCRIPTION, MO_STRIPE, MONTHLY_PRICE)
          await stripe.subscriptions.update(MO_SUBSCRIPTION, { default_payment_method: CARD })
          await insert(seedDb, 'staff', { first_name: 'Fran', last_name: 'Desk', email: NO_REFUNDS, role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
        },
        async run({ stripe }) {
          replayStripe.current = stripe
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
const invoiceRows = () => audited(INVOICE_PAID_AFTER_END_ACTION)
const closeRows = () => audited(CLOSE_ACTION)
const listed = async () => (await stuckList(db)).paymentRetries
const membership = async () =>
  (
    await db.query<{ status: string; renews: string | null; last_day: string | null; touched: string }>(
      'SELECT subscription_status AS status, next_renewal_date::text AS renews, cancel_effective_date::text AS last_day, updated_at::text AS touched FROM customer_memberships WHERE id = $1',
      [ID.membership]
    )
  )[0]
const creditPeriods = async () => Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM membership_credit_periods WHERE membership_id = $1', [ID.membership]))[0]?.n)
const methodsSince = (stripe: FakeStripe, from: number) => stripe.calls.slice(from).map((call) => call.method)
const lister = (requestId: string) => listPaidAfterEnd(db, { actor: { type: 'system', id: null }, requestId }, 'webhook')
/** Stripe's notice as the route handles it: its row claimed, the handler run with the route's listing, the outcome recorded. */
const notice = (stripe: SubscriptionReader, event: Stripe.Event) => processWebhookEvent(event, webhookClient(db), stripe, lister(event.id))
const eventRow = (event: Stripe.Event) => webhookClient(db).eventRow(event.id)
const paidEvent = (invoice: string, periodEnd: number): Stripe.Event => invoiceEvent('invoice.paid', MO_SUBSCRIPTION, { id: invoice, periodEnd, amountPaid: 4000 })
const failedEvent = (invoice: string, periodEnd: number): Stripe.Event => invoiceEvent('invoice.payment_failed', MO_SUBSCRIPTION, { id: invoice, periodEnd })
const deletedEvent = (): Stripe.Event => ({ id: `evt_${crypto.randomUUID()}`, type: 'customer.subscription.deleted', livemode: false, data: { object: { id: MO_SUBSCRIPTION, object: 'subscription' } } }) as unknown as Stripe.Event

let sessionNumber = 0
/** A credit booking of Mo's at 18:00 on a day, written straight to the table with a status. Its id. */
async function creditBooking(date: string, status: 'confirmed' | 'payment_needed'): Promise<string> {
  const slot = { start_time: `${date} 18:00:00+00`, end_time: `${date} 19:00:00+00` }
  const id = `10000000-0000-4000-8000-0000047d${String(++sessionNumber).padStart(4, '0')}`
  await insert(db, 'sessions', { id, service_type_id: ID.serviceType, type: 'public', capacity: 10, band_id: ID.band, ...slot })
  return insert(db, 'bookings', { customer_id: ID.member, party_size: 1, status, price_paid: '0', redemption_source: 'membership_credit', redeemed_membership_id: ID.membership, session_id: id, ...slot })
}
const bookingStatus = async (id: string) => (await db.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [id]))[0]?.status

/** What Cancel writes here (memberships/cancel.ts, M1): the last day only. The status stays as it is until Stripe ends the subscription. */
const cancelPressedHere = (lastDay: string | null = LAST_DAY) => db.query('UPDATE customer_memberships SET cancel_effective_date = $1::date WHERE id = $2', [lastDay, ID.membership])

/**
 * 10 December: Stripe starts Mo's renewal at 13:00 and takes £40 for it at 16:00 (the fake finalises a renewal as a
 * charge that fails at 14:00; Stripe's retry at 16:00 is the payment going through), and its notice marks him paid
 * to 10 January. The invoice.
 */
async function decemberPaid(stripe: FakeStripe): Promise<string> {
  vi.setSystemTime(new Date('2026-12-10T13:00:00.000Z'))
  stripe.startRenewal(MO_SUBSCRIPTION, JAN_10)
  vi.setSystemTime(new Date('2026-12-10T14:00:00.000Z'))
  const december = stripe.renewalFails(MO_SUBSCRIPTION)
  vi.setSystemTime(new Date('2026-12-10T16:00:00.000Z'))
  stripe.stripeRetryPays(december.invoice)
  expect(await dispatchStripeEvent(paidEvent(december.invoice, JAN_10), webhookRpc(db), stripe)).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated' } })
  expect(await membership()).toMatchObject({ status: 'active', renews: '2027-01-10', last_day: null })
  return december.invoice
}
/** 10 December: Mo's renewal fails at 14:00 and its notice marks him past due. The invoice, still open. */
async function decemberFailed(stripe: FakeStripe): Promise<string> {
  vi.setSystemTime(new Date('2026-12-10T13:00:00.000Z'))
  stripe.startRenewal(MO_SUBSCRIPTION, JAN_10)
  vi.setSystemTime(new Date('2026-12-10T14:00:00.000Z'))
  const december = stripe.renewalFails(MO_SUBSCRIPTION)
  expect(await dispatchStripeEvent(failedEvent(december.invoice, JAN_10), webhookRpc(db), stripe)).toMatchObject({ outcome: 'processed', detail: { action: 'past_due' } })
  expect(await membership()).toMatchObject({ status: 'past_due', renews: '2026-12-10' })
  return december.invoice
}
/** 10 January: Stripe, never told of the cancel, starts the renewal at 13:00 and takes £40 for it at 14:00. The invoice. */
function stripeRenewsInJanuary(stripe: FakeStripe): string {
  vi.setSystemTime(new Date('2027-01-10T13:00:00.000Z'))
  stripe.startRenewal(MO_SUBSCRIPTION, FEB_10)
  vi.setSystemTime(new Date('2027-01-10T14:00:00.000Z'))
  const january = stripe.renewalFails(MO_SUBSCRIPTION)
  stripe.stripeRetryPays(january.invoice)
  expect(stripe.subscription(MO_SUBSCRIPTION)?.status).toBe('active')
  return january.invoice
}
/** A manager cancels the subscription in Stripe's dashboard now, and Stripe's own notice of it marks the row here cancelled. */
async function cancelledInStripe(stripe: FakeStripe): Promise<void> {
  stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
  expect(await dispatchStripeEvent(deletedEvent(), webhookRpc(db), stripe)).toMatchObject({ outcome: 'processed', detail: { action: 'cancelled' } })
}

type ErrorBody = { code: string; message: string; details?: Record<string, unknown> }
type Answer = { status: number; data?: Record<string, unknown>; error?: ErrorBody }
/** The close route, as the Orders page reaches it. `body` is sent as given, so a press with no reason can be made. */
async function close(body: Record<string, unknown>, { email = REPLAY_USER.email as string, key = crypto.randomUUID() as string } = {}): Promise<Answer> {
  vi.setSystemTime(Date.now() + 1000)
  const response = await closeRoute(
    new Request('https://worker.test/api/v1/staff/orders/stuck/close', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': email, 'idempotency-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
  return { status: response.status, ...((await response.json()) as { data?: Record<string, unknown>; error?: ErrorBody }) }
}
/** Mark as owed. `reason`: null for a press that sends none. */
const markOwed = (orderId: string, reason: string | null = OWED_REASON, more: Parameters<typeof close>[1] = {}) => close({ kind: 'paid_after_end_owed', orderId, ...(reason === null ? {} : { reason }) }, more)
const markRefunded = (orderId: string) => close({ kind: 'retry_paid_after_end', orderId, reason: 'Refunded in Stripe by the manager' })
/** One run of the automatic check, a second on. */
const reconcileNow = (stripe: FakeStripe) => {
  vi.setSystemTime(Date.now() + 1000)
  return reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
}

describe("item 1 (migration 031): Cancel pressed here, the cancel never reaches Stripe, and Stripe renews after the last day", () => {
  it("with 031, the brief's case: Mo's last day is 9 January and Stripe takes £40 on 10 January. Nothing is written to the membership (no status, no next payment date, no booking put back, no credit period) and the £40 is listed once, with both closes; the notice sent again adds nothing", async () => {
    await onASeed(async (stripe) => {
      await decemberPaid(stripe)
      await cancelPressedHere()
      // A credit booking of his waiting for payment: a payment that is recorded puts it back to confirmed.
      const waiting = await creditBooking('2027-01-12', 'payment_needed')
      const invoice = stripeRenewsInJanuary(stripe)
      const before = { membership: await membership(), periods: await creditPeriods(), calls: stripe.calls.length, net: stripe.netPence }
      expect(before.membership).toMatchObject({ status: 'active', renews: '2027-01-10', last_day: LAST_DAY })

      const event = paidEvent(invoice, FEB_10)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      // The subscription, then (only because the paid write answered `ignored_cancelled`) its invoice. Nothing sent.
      expect(methodsSince(stripe, before.calls)).toEqual(['subscriptions.retrieve', 'invoices.retrieve'])
      expect(stripe.netPence).toBe(before.net)

      // Nothing written to the membership, to the last column; the booking still waits; no credit period for February.
      expect(await membership()).toEqual(before.membership)
      expect(await bookingStatus(waiting)).toBe('payment_needed')
      expect(await creditPeriods()).toBe(before.periods)

      const rows = await invoiceRows()
      expect(rows).toHaveLength(1)
      const listingId = rows[0]?.details['listingId'] as string
      expect(rows[0]).toEqual({
        action: INVOICE_PAID_AFTER_END_ACTION,
        actor_type: 'system',
        actor_id: null,
        entity_type: 'membership_invoice',
        entity_id: invoice,
        details: {
          listingId,
          state: 'listed',
          how: 'webhook',
          membershipId: ID.membership,
          customerId: ID.member,
          subscriptionId: MO_SUBSCRIPTION,
          invoiceId: invoice,
          amount: 40,
          status: 'active',
          paidAt: '2027-01-10T14:00:00.000Z',
          endedAt: null,
          livemode: false,
          cancelledHere: true,
          lastDay: LAST_DAY,
        },
      })
      // The notice's row says what the database answered (031's own answer, with the last day) and what was listed.
      expect(await eventRow(event)).toMatchObject({ outcome: 'processed', error: null })
      expect((await eventRow(event))?.detail).toEqual({
        found: true,
        action: 'ignored_cancelled',
        last_day: LAST_DAY,
        paid_after_end: { listed: true, why: 'listed', listing: listingId, last_day: LAST_DAY, cancelled_here: true, paid_at: TWO_PM_JAN_10 },
      })

      const line = {
        retryId: listingId,
        membershipId: ID.membership,
        customerId: ID.member,
        customerName: 'Mo Member',
        invoiceId: invoice,
        amount: 40,
        cardBrand: null,
        cardLast4: null,
        createdAt: expect.any(String),
        ageMinutes: 0,
        reason: 'paid_after_end',
        words: ENDED_HERE_LINE,
        close: { kind: 'retry_paid_after_end', orderId: listingId },
        closeOwed: { kind: 'paid_after_end_owed', orderId: listingId },
      }
      const list = await stuckList(db)
      expect(stuckListOutputSchema.safeParse(list).success).toBe(true)
      expect(list.paymentRetries).toEqual([line])

      // The same notice again: a duplicate. Another notice for the invoice (a new event id): listed already. A run: nothing.
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true, duplicate: true } })
      vi.setSystemTime(Date.now() + 1000)
      const resent = paidEvent(invoice, FEB_10)
      expect(await notice(stripe, resent)).toEqual({ status: 200, body: { received: true } })
      expect((await eventRow(resent))?.detail).toMatchObject({ action: 'ignored_cancelled', last_day: LAST_DAY, paid_after_end: { listed: false, why: 'already_listed' } })
      expect((await reconcileNow(stripe)).items.filter((item) => item.kind === 'payment_retry')).toEqual([])
      expect(await invoiceRows()).toHaveLength(1)
      expect(await listed()).toEqual([line])
      expect(await membership()).toEqual(before.membership)
    })
  })

  it("before 031 (what the Worker does on live until the lead applies it; W47r-c's proof A): the same £40 is recorded as a payment, the next payment date moves on to 10 February, the waiting booking is put back, and nothing is listed", async () => {
    await onASeed(async (stripe) => {
      await decemberPaid(stripe)
      await cancelPressedHere()
      const waiting = await creditBooking('2027-01-12', 'payment_needed')
      const invoice = stripeRenewsInJanuary(stripe)
      const calls = stripe.calls.length
      const event = paidEvent(invoice, FEB_10)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      expect((await eventRow(event))?.detail).toMatchObject({ found: true, action: 'reactivated', was: 'active', bookings_restored: 1 })
      expect((await eventRow(event))?.detail).not.toHaveProperty('paid_after_end')
      // The subscription twice (the write, then the read after it): no invoice read, since nothing said the membership had ended.
      expect(methodsSince(stripe, calls)).toEqual(['subscriptions.retrieve', 'subscriptions.retrieve'])
      expect(await membership()).toMatchObject({ status: 'active', renews: '2027-02-10', last_day: LAST_DAY })
      expect(await bookingStatus(waiting)).toBe('confirmed')
      expect(await invoiceRows()).toEqual([])
      expect(await listed()).toEqual([])
    }, false)
  })

  it.each(VERSIONS)("%s: a payment on 8 January, before the last day, is recorded as now: December's invoice, unpaid since 10 December, paid by Stripe's retry: Mo is marked paid, his flagged booking goes back to confirmed, nothing is listed and no invoice is read", async (_name, with031) => {
    await onASeed(async (stripe) => {
      const december = await decemberFailed(stripe)
      await cancelPressedHere()
      const waiting = await creditBooking('2027-01-09', 'payment_needed')
      vi.setSystemTime(new Date('2027-01-08T10:00:00.000Z'))
      stripe.stripeRetryPays(december)
      const calls = stripe.calls.length
      const event = paidEvent(december, JAN_10)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      expect((await eventRow(event))?.detail).toMatchObject({ found: true, action: 'reactivated', was: 'past_due', bookings_restored: 1 })
      expect((await eventRow(event))?.detail).not.toHaveProperty('paid_after_end')
      expect(methodsSince(stripe, calls)).toEqual(['subscriptions.retrieve', 'subscriptions.retrieve'])
      expect(await membership()).toMatchObject({ status: 'active', renews: '2027-01-10', last_day: LAST_DAY })
      expect(await bookingStatus(waiting)).toBe('confirmed')
      expect(await invoiceRows()).toEqual([])
      expect(await listed()).toEqual([])
    }, with031)
  })

  it("with 031, the edges of the day: a payment at 23:59:30 on the last day itself is recorded; one at 00:00:30 the day after is not, and is listed. By London's date: 23:59 on 30 June in London (22:59 UTC) is still the last day; 00:00:30 on 1 July in London (23:00:30 UTC on 30 June) is past it", async () => {
    // The last day itself, half a minute before midnight: still a day Mo has. Recorded.
    await onASeed(async (stripe) => {
      const december = await decemberFailed(stripe)
      await cancelPressedHere()
      vi.setSystemTime(new Date('2027-01-09T23:59:30.000Z'))
      stripe.stripeRetryPays(december)
      const event = paidEvent(december, JAN_10)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      expect((await eventRow(event))?.detail).toMatchObject({ action: 'reactivated', was: 'past_due' })
      expect(await membership()).toMatchObject({ status: 'active', renews: '2027-01-10' })
      expect(await invoiceRows()).toEqual([])
    })
    // Half a minute into the day after: nothing written (he stays past due, his next payment date stays), and the £40 is listed.
    await onASeed(async (stripe) => {
      const december = await decemberFailed(stripe)
      await cancelPressedHere()
      const before = await membership()
      vi.setSystemTime(new Date('2027-01-10T00:00:30.000Z'))
      stripe.stripeRetryPays(december)
      const event = paidEvent(december, JAN_10)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      expect((await eventRow(event))?.detail).toMatchObject({ action: 'ignored_cancelled', last_day: LAST_DAY, paid_after_end: { listed: true, why: 'listed', cancelled_here: true } })
      expect(await membership()).toEqual(before)
      expect(before).toMatchObject({ status: 'past_due', renews: '2026-12-10', last_day: LAST_DAY })
      expect(await listed()).toMatchObject([{ amount: 40, words: ENDED_HERE_LINE }])
    })
    // Summer, the function called as the Worker calls it. London is an hour ahead of UTC.
    await onASeed(async () => {
      await cancelPressedHere('2027-06-30')
      const paid = async () => (await webhookRpc(db).rpc('membership_mark_paid', { p_stripe_subscription_id: MO_SUBSCRIPTION, p_period_end: '2027-07-30T12:00:00.000Z' })).data
      vi.setSystemTime(new Date('2027-06-30T22:59:00.000Z'))
      expect(await paid()).toMatchObject({ found: true, action: 'reactivated' })
      vi.setSystemTime(new Date('2027-06-30T23:00:30.000Z'))
      expect(await paid()).toEqual({ found: true, action: 'ignored_cancelled', last_day: '2027-06-30' })
    })
  })

  it.each(VERSIONS)(
    "%s: a failed-payment notice for January's renewal, which goes through while the notice is being handled. Before 031 the row is marked past due, the second read (L8) shows it paid and the payment is recorded. With 031 (W47r-e: the same lines in membership_mark_payment_failed) the failed write itself answers `ignored_cancelled` and writes nothing, so there is no second read and this notice lists nothing; the invoice's own notice lists the £40, once",
    async (_name, with031) => {
      await onASeed(async (stripe) => {
        await decemberPaid(stripe)
        await cancelPressedHere()
        vi.setSystemTime(new Date('2027-01-10T13:00:00.000Z'))
        stripe.startRenewal(MO_SUBSCRIPTION, FEB_10)
        vi.setSystemTime(new Date('2027-01-10T14:00:00.000Z'))
        const january = stripe.renewalFails(MO_SUBSCRIPTION).invoice
        // The handler's first read shows the subscription behind; Stripe's retry then takes the £40 before its write.
        let reads = 0
        const reader: SubscriptionReader = {
          subscriptions: {
            retrieve: async (id) => {
              const seen = JSON.parse(JSON.stringify(await stripe.subscriptions.retrieve(id))) as Stripe.Subscription
              reads += 1
              if (reads === 1) stripe.stripeRetryPays(january)
              return seen
            },
          },
          invoices: { retrieve: (id) => stripe.invoices.retrieve(id) },
        }
        const event = failedEvent(january, FEB_10)
        expect(await notice(reader, event)).toEqual({ status: 200, body: { received: true } })
        const detail = (await eventRow(event))?.detail
        if (!with031) {
          expect(detail).toMatchObject({ found: true, action: 'reactivated', was: 'past_due', written_again: 1, last_write: 'membership_mark_paid' })
          expect(detail).not.toHaveProperty('paid_after_end')
          expect(await membership()).toMatchObject({ status: 'active', renews: '2027-02-10', last_day: LAST_DAY })
          expect(await invoiceRows()).toEqual([])
          expect(await listed()).toEqual([])
          return
        }
        // W47r-e (item 2): nothing written for the failed payment, so nothing to read again (one read), and nothing listed yet.
        expect(detail).toEqual({ found: true, action: 'ignored_cancelled', last_day: LAST_DAY })
        expect(reads).toBe(1)
        expect(await membership()).toMatchObject({ status: 'active', renews: '2027-01-10', last_day: LAST_DAY })
        expect(await invoiceRows()).toEqual([])
        // The invoice's own invoice.paid notice, handled next, lists it: once.
        const paid = paidEvent(january, FEB_10)
        expect(await notice(stripe, paid)).toEqual({ status: 200, body: { received: true } })
        const rows = await invoiceRows()
        expect(rows).toHaveLength(1)
        expect(rows[0]?.details).toMatchObject({ state: 'listed', how: 'webhook', invoiceId: january, amount: 40, status: 'active', paidAt: '2027-01-10T14:00:00.000Z', cancelledHere: true, lastDay: LAST_DAY })
        expect((await eventRow(paid))?.detail).toMatchObject({ action: 'ignored_cancelled', paid_after_end: { listed: true, why: 'listed', listing: rows[0]?.details['listingId'] } })
        expect(await listed()).toMatchObject([{ invoiceId: january, amount: 40, words: ENDED_HERE_LINE }])
        // A failed-payment notice whose membership has ended (the first write answers `ignored_cancelled`: nothing was taken) lists nothing.
        await db.query("UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE id = $1", [ID.membership])
        stripe.setSubscription(MO_SUBSCRIPTION, { status: 'past_due' })
        const failedAgain = failedEvent(january, FEB_10)
        expect(await notice(stripe, failedAgain)).toEqual({ status: 200, body: { received: true } })
        expect((await eventRow(failedAgain))?.detail).toEqual({ found: true, action: 'ignored_cancelled' })
        expect(await invoiceRows()).toHaveLength(1)
      }, with031)
    }
  )

  it("with 031, the read after a failed-payment notice's write (L8) still lists when it is the PAID write that answers `ignored_cancelled`: December's invoice is unpaid and Mo's last day is 9 January; a failed-payment notice is handled at 23:59:40 on the 9th (still a day he has: marked past due, as ever), Stripe's next try takes the £40 at 00:00:20 on the 10th, and the second read shows it paid: the paid write writes nothing and the £40 is listed there and then, once; the invoice's own notice afterwards adds nothing", async () => {
    await onASeed(async (stripe) => {
      const december = await decemberFailed(stripe)
      await cancelPressedHere()
      vi.setSystemTime(new Date('2027-01-09T23:59:40.000Z'))
      // The handler's first read shows the subscription behind; just after midnight Stripe's retry takes the £40, before the second read.
      let reads = 0
      const reader: SubscriptionReader = {
        subscriptions: {
          retrieve: async (id) => {
            reads += 1
            if (reads === 2) {
              vi.setSystemTime(new Date('2027-01-10T00:00:20.000Z'))
              stripe.stripeRetryPays(december)
            }
            return JSON.parse(JSON.stringify(await stripe.subscriptions.retrieve(id))) as Stripe.Subscription
          },
        },
        invoices: { retrieve: (id) => stripe.invoices.retrieve(id) },
      }
      const event = failedEvent(december, JAN_10)
      expect(await notice(reader, event)).toEqual({ status: 200, body: { received: true } })
      const rows = await invoiceRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.details).toMatchObject({ state: 'listed', how: 'webhook', invoiceId: december, amount: 40, status: 'active', paidAt: '2027-01-10T00:00:20.000Z', cancelledHere: true, lastDay: LAST_DAY })
      expect((await eventRow(event))?.detail).toEqual({
        found: true,
        action: 'ignored_cancelled',
        last_day: LAST_DAY,
        written_again: 1,
        last_write: 'membership_mark_paid',
        paid_after_end: { listed: true, why: 'listed', listing: rows[0]?.details['listingId'], last_day: LAST_DAY, cancelled_here: true, paid_at: secondsAt('2027-01-10T00:00:20.000Z') },
      })
      // The failed-payment write landed first, on the last day itself: past due; the paid write, a day later, changed nothing.
      expect(await membership()).toMatchObject({ status: 'past_due', renews: '2026-12-10', last_day: LAST_DAY })
      expect(await listed()).toMatchObject([{ invoiceId: december, amount: 40, words: ENDED_HERE_LINE }])
      // The invoice's own invoice.paid notice, handled next: the same answer from the database, and the line is there already.
      const paid = paidEvent(december, JAN_10)
      expect(await notice(stripe, paid)).toEqual({ status: 200, body: { received: true } })
      expect((await eventRow(paid))?.detail).toMatchObject({ action: 'ignored_cancelled', paid_after_end: { listed: false, why: 'already_listed' } })
      expect(await invoiceRows()).toHaveLength(1)
    })
  })
})

describe('item 2: a notice handled after a manager has cancelled the subscription in Stripe is still listed, by the last day here', () => {
  it("W47r-c's proof B, turned round: Mo's last day is 9 January; Stripe takes £40 on 10 January at 14:00 and its notice fails; a manager cancels the subscription in Stripe at 15:00; the notice sent again at 15:05 finds the payment 'before the end' there, and it is listed all the same, once, naming the last day", async () => {
    await onASeed(async (stripe) => {
      await decemberPaid(stripe)
      await cancelPressedHere()
      const invoice = stripeRenewsInJanuary(stripe)
      vi.setSystemTime(new Date('2027-01-10T15:00:00.000Z'))
      await cancelledInStripe(stripe)
      // Stripe's own notice of the end keeps the last day Cancel wrote here.
      expect(await membership()).toMatchObject({ status: 'cancelled', renews: '2027-01-10', last_day: LAST_DAY })
      vi.setSystemTime(new Date('2027-01-10T15:05:00.000Z'))
      const calls = stripe.calls.length
      const event = paidEvent(invoice, FEB_10)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      expect(methodsSince(stripe, calls)).toEqual(['subscriptions.retrieve', 'invoices.retrieve'])

      const rows = await invoiceRows()
      expect(rows).toHaveLength(1)
      const listingId = rows[0]?.details['listingId'] as string
      expect(rows[0]?.details).toEqual({
        listingId,
        state: 'listed',
        how: 'webhook',
        membershipId: ID.membership,
        customerId: ID.member,
        subscriptionId: MO_SUBSCRIPTION,
        invoiceId: invoice,
        amount: 40,
        status: 'canceled',
        paidAt: '2027-01-10T14:00:00.000Z',
        endedAt: '2027-01-10T15:00:00.000Z',
        livemode: false,
        pastLastDay: true,
        lastDay: LAST_DAY,
      })
      expect(await eventRow(event)).toEqual({
        event_type: 'invoice.paid',
        outcome: 'ignored',
        error: null,
        detail: { reason: 'subscription_not_paid_up', status: 'canceled', paid_after_end: { listed: true, why: 'listed', listing: listingId, last_day: LAST_DAY, paid_at: TWO_PM_JAN_10, ended_at: THREE_PM_JAN_10 } },
      })
      expect(await listed()).toEqual([
        {
          retryId: listingId,
          membershipId: ID.membership,
          customerId: ID.member,
          customerName: 'Mo Member',
          invoiceId: invoice,
          amount: 40,
          cardBrand: null,
          cardLast4: null,
          createdAt: expect.any(String),
          ageMinutes: 0,
          reason: 'paid_after_end',
          words: PAST_LAST_DAY_LINE,
          close: { kind: 'retry_paid_after_end', orderId: listingId },
          closeOwed: { kind: 'paid_after_end_owed', orderId: listingId },
        },
      ])
      expect(PAYMENT_RETRY_WORDS.invoicePaidAfterLastDay(40, '9 Jan 2027')).toBe(PAST_LAST_DAY_LINE)

      // Another notice for the invoice: listed already. Mark refunded: refused until Stripe shows the £40 back, then allowed.
      vi.setSystemTime(Date.now() + 1000)
      const resent = paidEvent(invoice, FEB_10)
      expect(await notice(stripe, resent)).toEqual({ status: 200, body: { received: true } })
      expect((await eventRow(resent))?.detail).toMatchObject({ paid_after_end: { listed: false, why: 'already_listed' } })
      expect(await invoiceRows()).toHaveLength(1)
      expect((await markRefunded(listingId)).data).toMatchObject({ closed: false, reason: 'not_refunded' })
      await stripe.refunds.create({ payment_intent: stripe.invoiceState(invoice).paymentIntent as string })
      expect((await markRefunded(listingId)).data).toMatchObject({ closed: true })
      expect(await listed()).toEqual([])
    })
  })

  it('the same when the notice of the end has not been handled here yet (the row still reads `active` with its last day): listed by the last day', async () => {
    await onASeed(async (stripe) => {
      await decemberPaid(stripe)
      await cancelPressedHere()
      const invoice = stripeRenewsInJanuary(stripe)
      vi.setSystemTime(new Date('2027-01-10T15:00:00.000Z'))
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      vi.setSystemTime(new Date('2027-01-10T15:05:00.000Z'))
      const event = paidEvent(invoice, FEB_10)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      expect((await eventRow(event))?.detail).toMatchObject({ reason: 'subscription_not_paid_up', paid_after_end: { listed: true, why: 'listed', last_day: LAST_DAY } })
      expect(await listed()).toMatchObject([{ invoiceId: invoice, words: PAST_LAST_DAY_LINE }])
    })
  })

  it("not listed, as before W47r-d: a payment before the last day (December's notice sent again after the cancel in Stripe); a row with no last day; no membership here with the subscription. Nothing is written for any of them", async () => {
    const found = async (stripe: SubscriptionReader, event: Stripe.Event) => (await dispatchStripeEvent(event, webhookRpc(db), stripe, lister(event.id)))?.detail?.['paid_after_end']
    await onASeed(async (stripe) => {
      const december = await decemberPaid(stripe)
      await cancelPressedHere()
      vi.setSystemTime(new Date('2027-01-10T15:00:00.000Z'))
      await cancelledInStripe(stripe)
      // December was paid on 10 December, a month before the last day: owed. The answer now carries the last day it was set against.
      expect(await found(stripe, paidEvent(december, JAN_10))).toEqual({ listed: false, why: 'paid_before_end', last_day: LAST_DAY, paid_at: FOUR_PM_DEC_10, ended_at: THREE_PM_JAN_10 })
      // 23:59:59 on 8 January, the day before the last day: owed.
      stripe.setInvoicePaidAt(december, secondsAt('2027-01-08T23:59:59.000Z'))
      expect(await found(stripe, paidEvent(december, JAN_10))).toMatchObject({ listed: false, why: 'paid_before_end', last_day: LAST_DAY })
      expect(await invoiceRows()).toEqual([])
      expect(await listed()).toEqual([])
    })
    // No last day on the row (Stripe ended the subscription and the row has none to go by): W47r-b's answer, to the letter.
    await onASeed(async (stripe) => {
      const december = await decemberPaid(stripe)
      vi.setSystemTime(new Date('2026-12-20T10:00:00.000Z'))
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      expect(await found(stripe, paidEvent(december, JAN_10))).toEqual({ listed: false, why: 'paid_before_end', paid_at: FOUR_PM_DEC_10, ended_at: secondsAt('2026-12-20T10:00:00.000Z') })
      // The row ended here with no last day (a refunded membership's row): the same.
      await db.query("UPDATE customer_memberships SET subscription_status = 'cancelled', cancel_effective_date = NULL WHERE id = $1", [ID.membership])
      expect(await found(stripe, paidEvent(december, JAN_10))).toEqual({ listed: false, why: 'paid_before_end', paid_at: FOUR_PM_DEC_10, ended_at: secondsAt('2026-12-20T10:00:00.000Z') })
      // No membership here has the subscription: nobody to list it against, and no last day. As before.
      await db.query('UPDATE customer_memberships SET stripe_subscription_id = NULL WHERE id = $1', [ID.membership])
      expect(await found(stripe, paidEvent(december, JAN_10))).toEqual({ listed: false, why: 'paid_before_end', paid_at: FOUR_PM_DEC_10, ended_at: secondsAt('2026-12-20T10:00:00.000Z') })
      expect(await invoiceRows()).toEqual([])
    })
  })

  it("the last day itself counts as after, by London's date: paid at 00:00:00 on 9 January is listed; 23:30 UTC on 30 June is 1 July in London, so with a last day of 1 July it is listed and with 2 July it is not", async () => {
    const found = async (stripe: SubscriptionReader, event: Stripe.Event) => (await dispatchStripeEvent(event, webhookRpc(db), stripe, lister(event.id)))?.detail?.['paid_after_end']
    await onASeed(async (stripe) => {
      const december = await decemberPaid(stripe)
      await cancelPressedHere()
      vi.setSystemTime(new Date('2027-01-10T15:00:00.000Z'))
      await cancelledInStripe(stripe)
      stripe.setInvoicePaidAt(december, secondsAt('2027-01-09T00:00:00.000Z'))
      expect(await found(stripe, paidEvent(december, JAN_10))).toMatchObject({ listed: true, why: 'listed', last_day: LAST_DAY })
      expect((await invoiceRows()).map((row) => row.details)).toMatchObject([{ state: 'listed', pastLastDay: true, lastDay: LAST_DAY, paidAt: '2027-01-09T00:00:00.000Z' }])
    })
    await onASeed(async (stripe) => {
      const december = await decemberPaid(stripe)
      const summer = secondsAt('2027-06-30T23:30:00.000Z')
      stripe.setInvoicePaidAt(december, summer)
      vi.setSystemTime(new Date('2027-07-05T10:00:00.000Z'))
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      await cancelPressedHere('2027-07-02')
      expect(await found(stripe, paidEvent(december, JAN_10))).toMatchObject({ listed: false, why: 'paid_before_end', last_day: '2027-07-02' })
      expect(await invoiceRows()).toEqual([])
      await cancelPressedHere('2027-07-01')
      expect(await found(stripe, paidEvent(december, JAN_10))).toMatchObject({ listed: true, why: 'listed', last_day: '2027-07-01', paid_at: summer })
      expect((await invoiceRows()).map((row) => row.details)).toMatchObject([{ pastLastDay: true, lastDay: '2027-07-01' }])
    })
  })
})

describe('item 3: Mark as owed, the second close of a paid-after-end line', () => {
  /** Mo's January renewal listed (item 1's case, with 031). The line's id and the invoice. */
  async function januaryListed(stripe: FakeStripe): Promise<{ listingId: string; invoice: string }> {
    await decemberPaid(stripe)
    await cancelPressedHere()
    const invoice = stripeRenewsInJanuary(stripe)
    expect(await notice(stripe, paidEvent(invoice, FEB_10))).toEqual({ status: 200, body: { received: true } })
    const listingId = (await invoiceRows())[0]?.details['listingId'] as string
    expect(await listed()).toMatchObject([{ retryId: listingId, closeOwed: { kind: 'paid_after_end_owed', orderId: listingId } }])
    return { listingId, invoice }
  }

  it('the kind is one the close route takes, and the states that end a line are refunded and owed', () => {
    expect(stuckCloseKindSchema.options).toContain('paid_after_end_owed')
    // W57, a named difference: `plan_step` (a plan's Stripe step marked sorted) comes after it, last.
    expect(stuckCloseKindSchema.options.slice(-2)).toEqual(['paid_after_end_owed', 'plan_step'])
    expect([...INVOICE_LINE_CLOSING_STATES]).toEqual(['refunded', 'owed'])
  })

  it('refused, with nothing written and Stripe never asked: without Issue refunds (403); with no reason, an empty one, or one under five characters (400)', async () => {
    await onASeed(async (stripe) => {
      const { listingId } = await januaryListed(stripe)
      const calls = stripe.calls.length
      const clients = stripeClientsMade.length
      const noPermission = await markOwed(listingId, OWED_REASON, { email: NO_REFUNDS })
      expect([noPermission.status, noPermission.error?.code]).toEqual([403, 'FORBIDDEN'])
      for (const reason of [null, '', '    ', 'owed']) {
        const answer = await markOwed(listingId, reason)
        expect([reason, answer.status, answer.error?.code]).toEqual([reason, 400, 'VALIDATION'])
      }
      expect((await invoiceRows()).map((row) => row.details['state'])).toEqual(['listed'])
      expect(await closeRows()).toEqual([])
      expect(await listed()).toHaveLength(1)
      expect(stripe.calls.length).toBe(calls)
      expect(stripeClientsMade.length).toBe(clients)
    })
  })

  it("Mark as owed with Issue refunds and a reason: the line ends `owed`, the reason is on its row and on the `order.close` row, nothing is sent to Stripe or read from it, and it is no longer listed; pressed again it answers 'already'; Mark refunded then finds it gone; the invoice's notice sent again never lists it again", async () => {
    await onASeed(async (stripe) => {
      const { listingId, invoice } = await januaryListed(stripe)
      const calls = stripe.calls.length
      const clients = stripeClientsMade.length
      const net = stripe.netPence
      const answer = await markOwed(listingId)
      expect(answer.status).toBe(200)
      expect(closeStuckOutputSchema.safeParse(answer.data).success).toBe(true)
      expect(answer.data).toEqual({
        kind: 'paid_after_end_owed',
        orderId: listingId,
        closed: true,
        message: 'Marked as owed: the £40.00 is recorded, with your reason, as a payment for a period the member had. Nothing was refunded. It is no longer listed.',
      })
      expect(PAYMENT_RETRY_OWED_WORDS.owed(40)).toBe(answer.data?.['message'])
      // No Stripe client was made, nothing was read and nothing sent.
      expect(stripe.calls.length).toBe(calls)
      expect(stripeClientsMade.length).toBe(clients)
      expect(stripe.netPence).toBe(net)

      const rows = await invoiceRows()
      expect(rows.map((row) => row.details['state'])).toEqual(['listed', 'owed'])
      expect(rows[1]).toEqual({
        action: INVOICE_PAID_AFTER_END_ACTION,
        actor_type: 'staff',
        actor_id: ID.staff,
        entity_type: 'membership_invoice',
        entity_id: invoice,
        details: { listingId, state: 'owed', how: 'close', why: OWED_REASON, membershipId: ID.membership, invoiceId: invoice, amount: 40 },
      })
      expect(await closeRows()).toEqual([
        {
          action: CLOSE_ACTION,
          actor_type: 'staff',
          actor_id: ID.staff,
          entity_type: 'membership_invoice',
          entity_id: invoice,
          details: { kind: 'paid_after_end_owed', why: OWED_REASON, listingId, membershipId: ID.membership, invoiceId: invoice, amount: 40 },
        },
      ])
      expect(await listed()).toEqual([])
      // The membership is as it was: Mark as owed records a decision about the money, nothing else.
      expect(await membership()).toMatchObject({ status: 'active', renews: '2027-01-10', last_day: LAST_DAY })

      // The same press again (a new key): already. Nothing more written.
      expect((await markOwed(listingId)).data).toEqual({ kind: 'paid_after_end_owed', orderId: listingId, closed: true, alreadyClosed: true, message: 'This was already marked as owed (an earlier press went through). Nothing more was done.' })
      // Mark refunded on a line marked as owed: no longer listed, and Stripe is not read for it.
      expect((await markRefunded(listingId)).data).toEqual({ kind: 'retry_paid_after_end', orderId: listingId, closed: false, reason: 'not_listed', message: 'This payment is no longer on the list (it was settled in the meantime). Nothing was changed.' })
      expect(stripe.calls.length).toBe(calls)
      expect((await invoiceRows()).map((row) => row.details['state'])).toEqual(['listed', 'owed'])
      expect(await closeRows()).toHaveLength(1)

      // The invoice's notice handled again, and a run: it has its line, ended; it is never listed a second time.
      vi.setSystemTime(Date.now() + 1000)
      const late = paidEvent(invoice, FEB_10)
      expect(await notice(stripe, late)).toEqual({ status: 200, body: { received: true } })
      expect((await eventRow(late))?.detail).toMatchObject({ paid_after_end: { listed: false, why: 'already_listed' } })
      expect((await reconcileNow(stripe)).items.filter((item) => item.kind === 'payment_retry')).toEqual([])
      expect((await invoiceRows()).map((row) => row.details['state'])).toEqual(['listed', 'owed'])
      expect(await listed()).toEqual([])
    })
  })

  it('a line already marked refunded can no longer be marked as owed; an id that is no line and no retry is not on the list; nothing is written for either', async () => {
    await onASeed(async (stripe) => {
      const { listingId, invoice } = await januaryListed(stripe)
      await stripe.refunds.create({ payment_intent: stripe.invoiceState(invoice).paymentIntent as string })
      expect((await markRefunded(listingId)).data).toMatchObject({ closed: true })
      const gone = { closed: false, reason: 'not_listed', message: 'This payment is no longer on the list (it was settled in the meantime). Nothing was changed.' }
      expect((await markOwed(listingId)).data).toEqual({ kind: 'paid_after_end_owed', orderId: listingId, ...gone })
      const nothing = crypto.randomUUID()
      expect((await markOwed(nothing)).data).toEqual({ kind: 'paid_after_end_owed', orderId: nothing, ...gone })
      expect((await invoiceRows()).map((row) => row.details['state'])).toEqual(['listed', 'refunded'])
      expect((await closeRows()).map((row) => row.details['kind'])).toEqual(['retry_paid_after_end'])
    })
  })

  it("through the staff app's own wrappers: getStuckReaderPayments passes the second close through as the Worker sends it, and closeStuckOrder marks it as owed", async () => {
    await onASeed(async (stripe) => {
      const { listingId } = await januaryListed(stripe)
      const list = (await throughStaffApp('getStuckReaderPayments')(db, {})) as { paymentRetries: Array<Record<string, unknown>> }
      expect(list.paymentRetries).toMatchObject([{ retryId: listingId, close: { kind: 'retry_paid_after_end', orderId: listingId }, closeOwed: { kind: 'paid_after_end_owed', orderId: listingId } }])
      const calls = stripe.calls.length
      // The wrapper's Worker call checks the reason too: one too short comes back as the Worker's refusal, with nothing written.
      expect(await throughStaffApp('closeStuckOrder')(db, { kind: 'paid_after_end_owed', orderId: listingId, reason: 'owed', idempotencyKey: crypto.randomUUID() })).toMatchObject({ closed: false, workerCode: 'VALIDATION' })
      expect(await closeRows()).toEqual([])
      expect(await throughStaffApp('closeStuckOrder')(db, { kind: 'paid_after_end_owed', orderId: listingId, reason: OWED_REASON, idempotencyKey: crypto.randomUUID() })).toMatchObject({ closed: true, kind: 'paid_after_end_owed', orderId: listingId })
      expect(stripe.calls.length).toBe(calls)
      expect((await closeRows()).map((row) => row.details)).toMatchObject([{ kind: 'paid_after_end_owed', why: OWED_REASON }])
      expect(((await throughStaffApp('getStuckReaderPayments')(db, {})) as { paymentRetries: unknown[] }).paymentRetries).toEqual([])
    })
  })
})
