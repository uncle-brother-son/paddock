import type Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dispatchStripeEvent, type DispatchResult, type RpcClient, type SubscriptionReader } from '@/app/api/stripe/webhook/dispatch'
import { processWebhookEvent } from '@/app/api/stripe/webhook/idempotency'
import type { Db } from '@/server/db'
import { getCustomerCreditOptions } from '@/server/rules/credits/credit-options'
import { insert } from '@/server/rules/testing/database'
import { asOwner, migration030 } from '@/server/rules/testing/migration-030'
import { oldSide, replay, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { ID, MO_SUBSCRIPTION, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { invoiceEvent, subscriptionUpdatedEvent, webhookClient, webhookRpc } from '@/server/rules/testing/webhook'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'

// Brief W46b item 1 (W46 review B1; its proofs A and B, briefs/W46-review-logs/proof-draft-hour.test.ts.txt, turned
// round): the webhook records a payment only for the subscription's newest invoice. Real events through the webhook's
// real handlers (dispatch.ts, idempotency.ts), the database's own functions with migration 030 put in from the
// migration file (as live is since 18 Nov, and as W46a's tests do: the saved schema is still as live was before it),
// and the fake Stripe.
//
// What Stripe shows at a renewal, which the review's blocker turns on: the period moves on at once, the new invoice
// is held as a draft for about an hour before the charge is tried, and the subscription reads `active` in that hour
// with the draft as its newest invoice (the fake's `startRenewal`). W46's invoice.paid checked only the status, so an
// older invoice.paid handled in that hour (one Stripe is sending again after a failed delivery) wrote next month's
// date as the next payment date. Migration 030 goes by that date, so the renewal's failure an hour later flagged
// nothing, and Stripe ending the subscription wrote the end of the unpaid month as the last day.
//
// Mo pays £40 a month; his credit periods start on the 10th (his start date). On 8 December his payment date is moved
// from the 10th to the 11th (W41: the row's next_renewal_date is moved, Stripe shows the no-charge days to the 11th
// and sends a £0 invoice.paid). He has credit bookings on 15 December and 5 January.

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

const MEMBER_STRIPE_CUSTOMER = 'cus_member'
const MONTHLY_PRICE = 'price_seed_monthly'
/** 11 December 2026, 11 January and 11 February 2027 (00:00 UTC = London in winter): his payment date once moved, and each month on. */
const MOVED = Date.UTC(2026, 11, 11) / 1000
const MOVED_NEXT_END = Date.UTC(2027, 0, 11) / 1000
const MOVED_END_AFTER = Date.UTC(2027, 1, 11) / 1000
/** The date change's £0 invoice: the subscription's newest from 8 December until the renewal on the 11th. */
const ZERO_INVOICE = 'in_date_change_zero'
const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

let environment: ReplayEnvironment
let db: Db

beforeAll(async () => {
  process.env.STAFF_API_KEY = 'test-staff-api-key'
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
  await asOwner(environment.database.pg, migration030())
})
afterAll(() => {
  replayStripe.current = null
  vi.unstubAllEnvs()
  return environment.stop()
})

/** The replay's seed with Mo's membership as live ones are: a Stripe subscription, its next payment on 10 December. */
async function onASeed(work: (stripe: FakeStripe) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w46b latest invoice',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await seedDb.query("UPDATE customer_memberships SET stripe_subscription_id = $1, next_renewal_date = '2026-12-10' WHERE id = $2", [MO_SUBSCRIPTION, ID.membership])
        stripe.addSubscription(MO_SUBSCRIPTION, MEMBER_STRIPE_CUSTOMER, MONTHLY_PRICE)
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
    oldSide
  )
}

let sessionNumber = 0
/** A confirmed credit booking of Mo's at 10:00 on a day, written straight to the table (what the functions read). Its id. */
async function creditBooking(date: string): Promise<string> {
  const slot = { start_time: `${date} 10:00:00+00`, end_time: `${date} 11:00:00+00` }
  const id = `10000000-0000-4000-8000-0000000c${String(++sessionNumber).padStart(4, '0')}`
  await insert(db, 'sessions', { id, service_type_id: ID.serviceType, type: 'public', capacity: 10, band_id: ID.band, ...slot })
  return insert(db, 'bookings', { customer_id: ID.member, party_size: 1, status: 'confirmed', price_paid: '0', redemption_source: 'membership_credit', redeemed_membership_id: ID.membership, session_id: id, ...slot })
}

const handle = (stripe: FakeStripe, event: Stripe.Event, rpc: RpcClient = webhookRpc(db)): Promise<DispatchResult> => dispatchStripeEvent(event, rpc, stripe)
const membership = async () =>
  (await db.query<{ status: string; renews: string | null; last_day: string | null }>('SELECT subscription_status AS status, next_renewal_date::text AS renews, cancel_effective_date::text AS last_day FROM customer_memberships WHERE id = $1', [ID.membership]))[0]
/** A booking's status and whether it has a payment deadline. */
const booking = async (id: string) => (await db.query<{ status: string; due: boolean }>('SELECT status, payment_due_by IS NOT NULL AS due FROM bookings WHERE id = $1', [id]))[0]
const allocate = () => db.query('SELECT public.allocate_membership_credit_periods()')
const CONFIRMED = { status: 'confirmed', due: false }
const FLAGGED = { status: 'payment_needed', due: true }

/** The £0 invoice's event, as Stripe makes it on 8 December. */
const zeroInvoicePaid = () => invoiceEvent('invoice.paid', MO_SUBSCRIPTION, { id: ZERO_INVOICE, periodStart: Date.UTC(2026, 11, 8, 15) / 1000, periodEnd: MOVED, billingReason: 'subscription_update', amountPaid: 0 })
/** An event of the £40 invoice of 11 December (`invoice`: its id, the subscription's newest from the renewal on). */
const fullInvoice = (type: 'invoice.paid' | 'invoice.payment_failed', invoice: string) => invoiceEvent(type, MO_SUBSCRIPTION, { id: invoice, periodStart: MOVED, periodEnd: MOVED_NEXT_END, amountPaid: type === 'invoice.paid' ? 4000 : 0 })
const endedEvent = () => ({ ...subscriptionUpdatedEvent(MO_SUBSCRIPTION, { cancelAt: null, periodEnd: MOVED_NEXT_END, status: 'canceled' }), type: 'customer.subscription.deleted' }) as Stripe.Event

/** 8 December 15:00: the payment date is moved to the 11th. The row has the new date (W41's own write); Stripe shows the no-charge days, with the £0 invoice its newest. */
async function dateMoved(stripe: FakeStripe): Promise<void> {
  vi.setSystemTime(new Date('2026-12-08T15:00:00.000Z'))
  await db.query("UPDATE customer_memberships SET next_renewal_date = '2026-12-11' WHERE id = $1", [ID.membership])
  stripe.setSubscription(MO_SUBSCRIPTION, { status: 'trialing', periodEnd: MOVED, latestInvoice: ZERO_INVOICE })
}
/** The same, with the £0 invoice's event failing at the webhook (Stripe answers the handler's read with a 500): left as an error, for Stripe to send again. */
async function dateMovedAndItsEventFails(stripe: FakeStripe): Promise<Stripe.Event> {
  await dateMoved(stripe)
  const zero = zeroInvoicePaid()
  stripe.failNext('subscriptions.retrieve', { kind: 'error', error: fakeStripeErrors.server() })
  const client = webhookClient(db)
  expect(await processWebhookEvent(zero, client, stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
  expect(await client.eventRow(zero.id)).toMatchObject({ outcome: 'error' })
  expect(client.calls).toEqual([])
  return zero
}
/** 10 December 00:05: the daily credit job gives Mo 10 December to 9 January (he is active). */
async function allocation(): Promise<void> {
  vi.setSystemTime(new Date('2026-12-10T00:05:00.000Z'))
  await allocate()
}
/**
 * 11 December 14:00: the no-charge days end. Stripe moves the period on and holds the £40 invoice as a draft for an
 * hour: the subscription reads active, its period to 11 January, its newest invoice the draft. The draft's id.
 */
function draftHour(stripe: FakeStripe): string {
  vi.setSystemTime(new Date('2026-12-11T14:00:00.000Z'))
  const draft = stripe.startRenewal(MO_SUBSCRIPTION, MOVED_NEXT_END)
  expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)).toMatchObject({ status: 'active', periodEnd: MOVED_NEXT_END })
  expect(stripe.latestInvoice(MO_SUBSCRIPTION)).toBe(draft)
  expect(draft).not.toBe(ZERO_INVOICE)
  return draft
}
/** 11 December 15:00: Stripe tries the £40 and it fails. */
function chargeFails(stripe: FakeStripe): void {
  vi.setSystemTime(new Date('2026-12-11T15:00:00.000Z'))
  stripe.setSubscription(MO_SUBSCRIPTION, { status: 'past_due' })
}
/** Stripe as the handlers read it, with `landing` run once, after the handler's first read is answered and before the handler carries on with it. */
function withAChangeAfterTheRead(stripe: FakeStripe, landing: () => Promise<void>): SubscriptionReader {
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
/** The webhook's database calls on `db`, with `landing` run once at the moment `at` says: before the first call is made, or after it has answered. */
function withAChangeAtTheWrite(at: 'before' | 'after', landing: () => Promise<void>): RpcClient & { calls: ReturnType<typeof webhookRpc>['calls'] } {
  const real = webhookRpc(db)
  let landed = false
  return {
    calls: real.calls,
    async rpc(fn, params) {
      const first = !landed
      landed = true
      if (first && at === 'before') await landing()
      const answer = await real.rpc(fn, params)
      if (first && at === 'after') await landing()
      return answer
    },
  }
}

describe("W46 review B1, its proofs turned round: an invoice.paid for an invoice that is not the subscription's newest is not recorded (W46b item 1)", () => {
  it('the £0 invoice on time (unchanged, and the review\'s control): handled on 8 December while it is the newest invoice, it is recorded with the no-charge days\' end; the £40 failing on the 11th flags both bookings (covered through 10 December), and Stripe ending the subscription writes 10 December as the last day', async () => {
    await onASeed(async (stripe) => {
      const fifteenth = await creditBooking('2026-12-15')
      const fifthOfJanuary = await creditBooking('2027-01-05')
      await dateMoved(stripe)
      const rpc = webhookRpc(db)
      expect(await handle(stripe, zeroInvoicePaid(), rpc)).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'active', bookings_restored: 0 } })
      expect(rpc.calls).toEqual([{ fn: 'membership_mark_paid', params: { p_stripe_subscription_id: MO_SUBSCRIPTION, p_period_end: iso(MOVED) } }])
      expect(await membership()).toEqual({ status: 'active', renews: '2026-12-11', last_day: null })
      await allocation()
      const draft = draftHour(stripe)
      chargeFails(stripe)
      expect(await handle(stripe, fullInvoice('invoice.payment_failed', draft))).toMatchObject({ outcome: 'processed', detail: { action: 'past_due', covered_through: '2026-12-10', bookings_flagged: 2 } })
      expect([await booking(fifteenth), await booking(fifthOfJanuary)]).toEqual([FLAGGED, FLAGGED])
      vi.setSystemTime(new Date('2026-12-31T09:00:00.000Z'))
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      expect(await handle(stripe, endedEvent())).toMatchObject({ outcome: 'processed', detail: { action: 'cancelled', covered_through: '2026-12-10' } })
      expect(await membership()).toEqual({ status: 'cancelled', renews: '2026-12-11', last_day: '2026-12-10' })
      expect([await booking(fifteenth), await booking(fifthOfJanuary)]).toEqual([FLAGGED, FLAGGED])
    })
  })

  it("proof A turned round: the £0 event's first delivery fails; Stripe sends it again at 14:10 on the 11th, in the hour the £40 invoice is a draft: it is finished as ignored (not the newest invoice), writes nothing, and the next payment date stays 11 December; the £40 fails at 15:00 and flags both bookings (covered through 10 December); every retry fails and Stripe ends it on 31 December with his last day 10 December: no month for £0", async () => {
    await onASeed(async (stripe) => {
      const fifteenth = await creditBooking('2026-12-15')
      const fifthOfJanuary = await creditBooking('2027-01-05')
      const zero = await dateMovedAndItsEventFails(stripe)
      await allocation()
      const draft = draftHour(stripe)
      // 14:10: Stripe sends the £0 invoice's event again (its retries run for 3 days).
      vi.setSystemTime(new Date('2026-12-11T14:10:00.000Z'))
      const client = webhookClient(db)
      expect(await processWebhookEvent(zero, client, stripe)).toEqual({ status: 200, body: { received: true } })
      expect(await client.eventRow(zero.id)).toEqual({ event_type: 'invoice.paid', outcome: 'ignored', error: null, detail: { reason: 'not_latest_invoice' } })
      expect(client.calls).toEqual([])
      expect(await membership()).toEqual({ status: 'active', renews: '2026-12-11', last_day: null })
      // Sent once more, it is a duplicate.
      expect(await processWebhookEvent(zero, client, stripe)).toEqual({ status: 200, body: { received: true, duplicate: true } })
      // 15:00: Stripe tries the £40 and it fails.
      chargeFails(stripe)
      expect(await handle(stripe, fullInvoice('invoice.payment_failed', draft))).toMatchObject({ outcome: 'processed', detail: { action: 'past_due', covered_through: '2026-12-10', bookings_flagged: 2 } })
      expect([await booking(fifteenth), await booking(fifthOfJanuary)]).toEqual([FLAGGED, FLAGGED])
      // Past due, none of the new period's credits can be spent.
      expect((await getCustomerCreditOptions(db, ID.member)).membershipsWithSessionCredit).toEqual([])
      // 31 December: every retry has failed; Stripe ends the subscription.
      vi.setSystemTime(new Date('2026-12-31T09:00:00.000Z'))
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      expect(await handle(stripe, endedEvent())).toMatchObject({ outcome: 'processed', detail: { action: 'cancelled', covered_through: '2026-12-10' } })
      expect(await membership()).toEqual({ status: 'cancelled', renews: '2026-12-11', last_day: '2026-12-10' })
      expect([await booking(fifteenth), await booking(fifthOfJanuary)]).toEqual([FLAGGED, FLAGGED])
    })
  })

  it("proof B turned round (W46 \"Noticed\" 2 as it would really cross): the resent £0 event's read lands in the draft hour, and the £40's failure is handled before that handler carries on: the failure flags the booking (covered through 10 December), and the £0 event is ignored with no database function called, so nothing puts the booking back or moves the date: past due, the booking payment needed", async () => {
    await onASeed(async (stripe) => {
      const fifteenth = await creditBooking('2026-12-15')
      const zero = await dateMovedAndItsEventFails(stripe)
      await allocation()
      const draft = draftHour(stripe)
      let failure: DispatchResult | null = null
      const reader = withAChangeAfterTheRead(stripe, async () => {
        // Between the £0 handler's read (active, the period to 11 January, the draft its newest invoice) and what it does with it.
        chargeFails(stripe)
        failure = await handle(stripe, fullInvoice('invoice.payment_failed', draft))
      })
      const rpc = webhookRpc(db)
      expect(await dispatchStripeEvent(zero, rpc, reader)).toEqual({ outcome: 'ignored', detail: { reason: 'not_latest_invoice' } })
      expect(failure).toMatchObject({ outcome: 'processed', detail: { action: 'past_due', covered_through: '2026-12-10', bookings_flagged: 1 } })
      expect(rpc.calls).toEqual([])
      expect(await membership()).toEqual({ status: 'past_due', renews: '2026-12-11', last_day: null })
      expect(await booking(fifteenth)).toEqual(FLAGGED)
    })
  })
})

describe('the invoice that failed, then paid: it is still the newest, so its payment is recorded (W46b item 1)', () => {
  it('a paid retry: the £40 fails on the 11th and both bookings are flagged; Stripe\'s retry takes it on the 13th: the payment is recorded, both bookings are confirmed again with their deadlines cleared, and the next payment is 11 January', async () => {
    await onASeed(async (stripe) => {
      const fifteenth = await creditBooking('2026-12-15')
      const fifthOfJanuary = await creditBooking('2027-01-05')
      await dateMoved(stripe)
      expect((await handle(stripe, zeroInvoicePaid())).outcome).toBe('processed')
      await allocation()
      const draft = draftHour(stripe)
      chargeFails(stripe)
      expect((await handle(stripe, fullInvoice('invoice.payment_failed', draft))).detail).toMatchObject({ action: 'past_due', covered_through: '2026-12-10', bookings_flagged: 2 })
      expect([await booking(fifteenth), await booking(fifthOfJanuary)]).toEqual([FLAGGED, FLAGGED])
      // 13 December 09:00: the retry goes through. The invoice is the same one, still the subscription's newest.
      vi.setSystemTime(new Date('2026-12-13T09:00:00.000Z'))
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'active' })
      const rpc = webhookRpc(db)
      expect(await handle(stripe, fullInvoice('invoice.paid', draft), rpc)).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'past_due', bookings_restored: 2 } })
      expect(rpc.calls).toEqual([{ fn: 'membership_mark_paid', params: { p_stripe_subscription_id: MO_SUBSCRIPTION, p_period_end: iso(MOVED_NEXT_END) } }])
      expect(await membership()).toEqual({ status: 'active', renews: '2027-01-11', last_day: null })
      expect([await booking(fifteenth), await booking(fifthOfJanuary)]).toEqual([CONFIRMED, CONFIRMED])
    })
  })

  it("a payment that goes through between the failure handler's read and its write: the failure is read while Stripe shows past due, the retry is taken and its invoice.paid handled, then the failure's own write lands over it; the second read shows the subscription active with the failed invoice still its newest, so the payment is recorded again: active, both bookings confirmed, the next payment 11 January", async () => {
    await onASeed(async (stripe) => {
      const fifteenth = await creditBooking('2026-12-15')
      const fifthOfJanuary = await creditBooking('2027-01-05')
      await dateMoved(stripe)
      expect((await handle(stripe, zeroInvoicePaid())).outcome).toBe('processed')
      await allocation()
      const draft = draftHour(stripe)
      chargeFails(stripe)
      const rpc = withAChangeAtTheWrite('before', async () => {
        stripe.setSubscription(MO_SUBSCRIPTION, { status: 'active' })
        expect(await handle(stripe, fullInvoice('invoice.paid', draft))).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'active' } })
        expect(await membership()).toEqual({ status: 'active', renews: '2027-01-11', last_day: null })
      })
      const result = await dispatchStripeEvent(fullInvoice('invoice.payment_failed', draft), rpc, stripe)
      expect(rpc.calls).toEqual([
        { fn: 'membership_mark_payment_failed', params: { p_stripe_subscription_id: MO_SUBSCRIPTION } },
        { fn: 'membership_mark_paid', params: { p_stripe_subscription_id: MO_SUBSCRIPTION, p_period_end: iso(MOVED_NEXT_END) } },
      ])
      expect(result).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'past_due', written_again: 1, last_write: 'membership_mark_paid' } })
      expect(await membership()).toEqual({ status: 'active', renews: '2027-01-11', last_day: null })
      expect([await booking(fifteenth), await booking(fifthOfJanuary)]).toEqual([CONFIRMED, CONFIRMED])
    })
  })
})

describe("an invoice.paid when the subscription has a newer invoice writes nothing, on the first read or the read after the write (W46b item 1)", () => {
  it('an older invoice paid while a newer one exists (a hand change in Stripe): the £40 of 11 December is paid and recorded; an invoice.paid for an older invoice is then ignored, with no database function called and the membership as it was', async () => {
    await onASeed(async (stripe) => {
      const fifteenth = await creditBooking('2026-12-15')
      await dateMoved(stripe)
      expect((await handle(stripe, zeroInvoicePaid())).outcome).toBe('processed')
      await allocation()
      const draft = draftHour(stripe)
      vi.setSystemTime(new Date('2026-12-11T15:00:00.000Z'))
      expect(await handle(stripe, fullInvoice('invoice.paid', draft))).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'active' } })
      const before = await db.query('SELECT to_jsonb(cm) AS row FROM customer_memberships cm WHERE id = $1', [ID.membership])
      // 20 December: an invoice from November, left open, is marked paid by hand in Stripe's dashboard.
      vi.setSystemTime(new Date('2026-12-20T10:00:00.000Z'))
      const older = invoiceEvent('invoice.paid', MO_SUBSCRIPTION, { id: 'in_an_older_one', periodStart: Date.UTC(2026, 10, 10) / 1000, periodEnd: Date.UTC(2026, 11, 10) / 1000, amountPaid: 4000 })
      const client = webhookClient(db)
      expect(await processWebhookEvent(older, client, stripe)).toEqual({ status: 200, body: { received: true } })
      expect(await client.eventRow(older.id)).toEqual({ event_type: 'invoice.paid', outcome: 'ignored', error: null, detail: { reason: 'not_latest_invoice' } })
      expect(client.calls).toEqual([])
      expect(await db.query('SELECT to_jsonb(cm) AS row FROM customer_memberships cm WHERE id = $1', [ID.membership])).toEqual(before)
      expect(await membership()).toEqual({ status: 'active', renews: '2027-01-11', last_day: null })
      expect(await booking(fifteenth)).toEqual(CONFIRMED)
    })
  })

  it("the read after the write (L8) lands in the next renewal's draft hour: December's invoice.paid, sent again, is read at 13:59 on 11 January while its invoice is still the newest, and writes 11 January; Stripe starts January's renewal before the handler reads again: active, the period to 11 February, a draft its newest invoice. Nothing more is written: the next payment date stays 11 January, and January's £40 failing at 15:00 flags the booking it didn't pay for (covered through 10 January)", async () => {
    await onASeed(async (stripe) => {
      await dateMoved(stripe)
      expect((await handle(stripe, zeroInvoicePaid())).outcome).toBe('processed')
      await allocation()
      const decembers = draftHour(stripe)
      vi.setSystemTime(new Date('2026-12-11T15:00:00.000Z'))
      // December's £40 is taken, but its event's first delivery fails at the webhook.
      const paid = fullInvoice('invoice.paid', decembers)
      stripe.failNext('subscriptions.retrieve', { kind: 'error', error: fakeStripeErrors.server() })
      const client = webhookClient(db)
      expect(await processWebhookEvent(paid, client, stripe)).toEqual({ status: 500, body: { error: 'Internal server error' } })
      expect(await membership()).toEqual({ status: 'active', renews: '2026-12-11', last_day: null })
      // A month on. The daily job gives 10 January to 9 February; Mo has a credit booking on 20 January.
      vi.setSystemTime(new Date('2027-01-10T00:05:00.000Z'))
      await allocate()
      const twentieth = await creditBooking('2027-01-20')
      // 11 January 13:59: the event is handled (a resend from the dashboard). Its invoice is still the newest.
      vi.setSystemTime(new Date('2027-01-11T13:59:59.000Z'))
      let januarys = ''
      const rpc = withAChangeAtTheWrite('after', async () => {
        // 14:00, between the handler's write and its second read: January's renewal starts.
        vi.setSystemTime(new Date('2027-01-11T14:00:00.000Z'))
        januarys = stripe.startRenewal(MO_SUBSCRIPTION, MOVED_END_AFTER)
      })
      const before = stripe.calls.filter((call) => call.method === 'subscriptions.retrieve').length
      const result = await dispatchStripeEvent(paid, rpc, stripe)
      // One write, with the period end the first read showed, and two reads: the second asks for nothing.
      expect(rpc.calls).toEqual([{ fn: 'membership_mark_paid', params: { p_stripe_subscription_id: MO_SUBSCRIPTION, p_period_end: iso(MOVED_NEXT_END) } }])
      expect(stripe.calls.filter((call) => call.method === 'subscriptions.retrieve').length - before).toBe(2)
      expect(result).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'active' } })
      expect(result.detail).not.toHaveProperty('written_again')
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)).toMatchObject({ status: 'active', periodEnd: MOVED_END_AFTER })
      expect(await membership()).toEqual({ status: 'active', renews: '2027-01-11', last_day: null })
      // 15:00: January's £40 fails.
      vi.setSystemTime(new Date('2027-01-11T15:00:00.000Z'))
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'past_due' })
      const failed = invoiceEvent('invoice.payment_failed', MO_SUBSCRIPTION, { id: januarys, periodStart: MOVED_NEXT_END, periodEnd: MOVED_END_AFTER })
      expect(await handle(stripe, failed)).toMatchObject({ outcome: 'processed', detail: { action: 'past_due', covered_through: '2027-01-10', bookings_flagged: 1 } })
      expect(await booking(twentieth)).toEqual(FLAGGED)
    })
  })
})
