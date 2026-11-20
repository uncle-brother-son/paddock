import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dispatchStripeEvent, type SubscriptionReader } from '@/app/api/stripe/webhook/dispatch'
import { processWebhookEvent } from '@/app/api/stripe/webhook/idempotency'
import { POST as savedCardRoute } from '@/app/api/v1/staff/customers/[customerId]/saved-card/route'
import { GET as quoteRoute } from '@/app/api/v1/staff/memberships/[membershipId]/retry-payment/quote/route'
import { POST as retryRoute } from '@/app/api/v1/staff/memberships/[membershipId]/retry-payment/route'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import { reconcileRunOutputSchema, retryPaymentOutputSchema, retryPaymentQuoteOutputSchema, stuckCloseKindSchema, stuckListOutputSchema } from '@/contracts'
import type { Db } from '@/server/db'
import { lapseSweep } from '@/server/rules/bookings/lapse-sweep'
import { reconcile } from '@/server/rules/orders/reconcile'
import { CLOSE_ACTION } from '@/server/rules/orders/close-stuck'
import { stuckList, WEBHOOK_ERROR_MINUTES } from '@/server/rules/orders/stuck-list'
import { insert } from '@/server/rules/testing/database'
import { asOwner, BEFORE_031_SQL, migration031, savedFunctionSql } from '@/server/rules/testing/migration-031'
import { throughStaffApp } from '@/server/rules/testing/replay/booking-side'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { ID, MO_SUBSCRIPTION, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe, stripeClientsMade } from '@/server/rules/testing/replay/stripe-binding'
import { asLive, invoiceEvent, webhookClient, webhookRpc } from '@/server/rules/testing/webhook'
import type { StripeClient } from '@/server/stripe/client'
import { fakeStripeErrors, type FakeFault, type FakeStripe } from '@/server/stripe/fake'
import { MEMBERSHIP_PATH_OFF_MESSAGE, PAYMENT_RETRY_CLOSE_WORDS, PAYMENT_RETRY_REFUSALS, PAYMENT_RETRY_STUCK_WORDS, PAYMENT_RETRY_WORDS } from './failure-messages'
import { leaveStep, STEP_LEFT_ACTION } from './left'
import { INVOICE_PAID_AFTER_END_ACTION, listPaidAfterEnd } from './paid-after-end'
import { PAYMENT_RETRY_ACTION, PAYMENT_RETRY_CLOSING_STATES, paymentRetryKey } from './retry-payment'
import { PAYMENT_RETRY_HOLDS_LAPSE_MINUTES } from './retry-record'

// Brief W47r ("Try the payment again now"; the W47 review's point 10): a past-due member's failed renewal charged
// from the desk, through the Worker's routes on the replay's live schema with the fake Stripe. What must hold: every
// refusal comes before anything is sent; the record is written before the one send; the send names the card and is
// never made twice for a record; a paid invoice is recorded on the membership at once by the webhook's own write, and
// the webhook's event afterwards changes nothing; a decline writes nothing to the membership; and an answer that
// isn't clear is held, with reconcile only reading until Stripe says how the payment ended, and no way to close it.
//
// Mo pays £40 a month on the 10th. On 10 December 2026 his renewal fails at 14:00 (his card, visa 4444, is declined):
// the membership is past due, and his credit bookings on the 11th and the 15th are flagged payment needed.

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
const INACTIVE = 'gone@example.com'
const MO_STRIPE = 'cus_member'
const MONTHLY_PRICE = 'price_seed_monthly'
const OLD_CARD = 'pm_member'
const NEW_CARD = 'pm_new_card'
/** 10 January 2027, 00:00 UTC (London in winter): the end of the period the failed renewal is for. */
const JAN_10 = Date.UTC(2027, 0, 10) / 1000
const FEB_10 = Date.UTC(2027, 1, 10) / 1000
const SECOND_MEMBERSHIP = '10000000-0000-4000-8000-0000000047a1'
const SECOND_SUBSCRIPTION = 'sub_mo_second'
/** Every kind a test's presses use: the retry's own, and the card replace's. */
const ON = 'payment_retries,card_moves'
const WINDOW_MS = 15 * 60_000
const pastTheWindow = () => vi.setSystemTime(Date.now() + WINDOW_MS + 60_000)

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

type Prepare = (seedDb: Db, stripe: FakeStripe) => Promise<void> | void

/**
 * The replay's seed with Mo's membership as live ones are: a Stripe subscription whose card is his saved card, its
 * next payment on 10 December; two more staff; then `prepare`, then `work`.
 */
async function onASeed(work: (stripe: FakeStripe) => Promise<void>, prepare?: Prepare, switchValue: string = ON): Promise<void> {
  await replay(
    environment,
    {
      name: 'w47r retry payment',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await seedDb.query("UPDATE customer_memberships SET stripe_subscription_id = $1, next_renewal_date = '2026-12-10' WHERE id = $2", [MO_SUBSCRIPTION, ID.membership])
        stripe.addSubscription(MO_SUBSCRIPTION, MO_STRIPE, MONTHLY_PRICE)
        await stripe.subscriptions.update(MO_SUBSCRIPTION, { default_payment_method: OLD_CARD })
        await insert(seedDb, 'staff', { first_name: 'Fran', last_name: 'Desk', email: NO_REFUNDS, role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
        await insert(seedDb, 'staff', { first_name: 'Gone', last_name: 'Away', email: INACTIVE, role: 'staff', can_issue_refunds: true, can_manage_pricing: true, active: false })
        await prepare?.(seedDb, stripe)
      },
      async run({ stripe }) {
        replayStripe.current = stripe
        // The harness's old side switches every kind off for its own calls; these presses run with the kinds named.
        vi.stubEnv('ORDER_SWITCH', switchValue)
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

type ErrorBody = { code: string; message: string; details?: { reason?: string; message?: string; action?: string; held?: { retryId: string }; amountNow?: number; kinds?: string[] } }
type Answer = { status: number; replayed: boolean; data?: Record<string, unknown>; error?: ErrorBody }
type PressBody = { confirmed?: { invoiceId?: string | null; amount?: number | null; paymentMethodId?: string | null } }

async function read(response: Response): Promise<Answer> {
  const body = (await response.json()) as { data?: Record<string, unknown>; error?: ErrorBody }
  return { status: response.status, replayed: response.headers.get('Idempotency-Replayed') === 'true', ...body }
}
const headers = (email: string, key?: string | null) => ({ authorization: `Bearer ${KEY}`, 'x-staff-email': email, ...(key ? { 'idempotency-key': key } : {}), 'content-type': 'application/json' })

async function press(body: PressBody, { membershipId = ID.membership as string, email = REPLAY_USER.email, key = crypto.randomUUID() as string | null } = {}): Promise<Answer> {
  // The replay holds the clock still (Postgres's too): moved on between presses, so rows read in time order keep theirs.
  vi.setSystemTime(Date.now() + 1000)
  return read(
    await retryRoute(new Request(`https://worker.test/api/v1/staff/memberships/${membershipId}/retry-payment`, { method: 'POST', headers: headers(email, key), body: JSON.stringify(body) }), {
      params: Promise.resolve({ membershipId }),
    })
  )
}
async function quote({ membershipId = ID.membership as string, email = REPLAY_USER.email } = {}): Promise<Answer> {
  return read(await quoteRoute(new Request(`https://worker.test/api/v1/staff/memberships/${membershipId}/retry-payment/quote`, { headers: headers(email) }), { params: Promise.resolve({ membershipId }) }))
}
/** The customer's saved card as the database has it now: what a window opened this moment names. */
const savedCard = async (membershipId: string = ID.membership): Promise<string | null> =>
  (await db.query<{ card: string | null }>('SELECT c.saved_payment_method_id AS card FROM customer_memberships cm JOIN customers c ON c.id = cm.customer_id WHERE cm.id = $1', [membershipId]))[0]?.card ?? null
/**
 * The press as the window makes it: what the quote showed, sent back. W47r-a (S3): the card too. `card`: the card the
 * window named, when it isn't the one saved at the moment of the press (the window was opened earlier).
 */
const pressShown = async (invoice: string, amount = 40, more: Parameters<typeof press>[1] & { card?: string | null } = {}) => {
  const { card, ...rest } = more
  return press({ confirmed: { invoiceId: invoice, amount, paymentMethodId: card === undefined ? await savedCard(rest.membershipId) : card } }, rest)
}
const refusalOf = (answer: Answer) => [answer.status, answer.error?.code, answer.error?.details?.reason, answer.error?.details?.message]

let sessionNumber = 0
/** A confirmed credit booking of Mo's at 18:00 on a day, written straight to the table. Its id. */
async function creditBooking(date: string): Promise<string> {
  const slot = { start_time: `${date} 18:00:00+00`, end_time: `${date} 19:00:00+00` }
  const id = `10000000-0000-4000-8000-0000047c${String(++sessionNumber).padStart(4, '0')}`
  await insert(db, 'sessions', { id, service_type_id: ID.serviceType, type: 'public', capacity: 10, band_id: ID.band, ...slot })
  return insert(db, 'bookings', { customer_id: ID.member, party_size: 1, status: 'confirmed', price_paid: '0', redemption_source: 'membership_credit', redeemed_membership_id: ID.membership, session_id: id, ...slot })
}
const booking = async (id: string) => (await db.query<{ status: string; due: string | null }>('SELECT status, payment_due_by::text AS due FROM bookings WHERE id = $1', [id]))[0]
const membership = async (id: string = ID.membership) =>
  (await db.query<{ status: string; renews: string | null }>('SELECT subscription_status AS status, next_renewal_date::text AS renews FROM customer_memberships WHERE id = $1', [id]))[0]
type AuditRow = { action: string; actor_type: string; actor_id: string | null; entity_type: string; entity_id: string; details: Record<string, unknown> }
const audited = (action: string) => db.query<AuditRow>('SELECT action, actor_type, actor_id, entity_type, entity_id, details FROM audit_log WHERE action = $1 ORDER BY at', [action])
const retryRows = () => audited(PAYMENT_RETRY_ACTION)
const states = async () => (await retryRows()).map((row) => row.details['state'] as string)
const callsOf = (stripe: FakeStripe, method: string) => stripe.calls.filter((call) => call.method === method)
const pays = (stripe: FakeStripe) => callsOf(stripe, 'invoices.pay')
/** Every call that could change anything in Stripe, by method, from a point in the call list on. */
const WRITES = ['invoices.pay', 'paymentIntents.create', 'paymentIntents.cancel', 'refunds.create', 'subscriptions.update', 'subscriptions.cancel', 'subscriptions.create', 'customers.update']
const writesSince = (stripe: FakeStripe, from: number) => stripe.calls.slice(from).filter((call) => WRITES.includes(call.method)).map((call) => call.method)
const listed = async () => (await stuckList(db)).paymentRetries
/** One run. The replay holds the clock still, so it is moved on a second first: each run's rows then come after the last one's. */
const reconcileNow = (stripe: FakeStripe, requestId: string = crypto.randomUUID()) => {
  vi.setSystemTime(Date.now() + 1000)
  return reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId, maxItems: 50, budgetMs: 60_000 })
}
const retryItems = async (stripe: FakeStripe) => (await reconcileNow(stripe)).items.filter((item) => item.kind === 'payment_retry')
const noAnswer = (): FakeFault => ({ kind: 'error', error: fakeStripeErrors.server() })
interface Failed {
  invoice: string
  paymentIntent: string
  /** Mo's credit bookings: 11 December (inside 72 hours, so due by its own start) and 15 December. */
  eleventh: string
  fifteenth: string
}

/**
 * 10 December: at 13:00 Stripe starts Mo's renewal (the period moves on to 10 January; a draft invoice); at 14:00 it
 * finalises the invoice and his card is declined. The webhook's own `invoice.payment_failed` handler marks the
 * membership past due and flags his two credit bookings.
 */
async function renewalHasFailed(stripe: FakeStripe): Promise<Failed> {
  const eleventh = await creditBooking('2026-12-11')
  const fifteenth = await creditBooking('2026-12-15')
  vi.setSystemTime(new Date('2026-12-10T13:00:00.000Z'))
  stripe.startRenewal(MO_SUBSCRIPTION, JAN_10)
  vi.setSystemTime(new Date('2026-12-10T14:00:00.000Z'))
  const failed = stripe.renewalFails(MO_SUBSCRIPTION)
  expect(await dispatchStripeEvent(invoiceEvent('invoice.payment_failed', MO_SUBSCRIPTION, { id: failed.invoice, periodEnd: JAN_10 }), webhookRpc(db), stripe)).toMatchObject({
    outcome: 'processed',
    detail: { action: 'past_due', bookings_flagged: 2 },
  })
  expect(await membership()).toEqual({ status: 'past_due', renews: '2026-12-10' })
  expect((await booking(eleventh))?.status).toBe('payment_needed')
  expect((await booking(fifteenth))?.status).toBe('payment_needed')
  vi.setSystemTime(new Date('2026-12-10T16:00:00.000Z'))
  return { ...failed, eleventh, fifteenth }
}

/** Mo taps a new card on the reader and it is saved to him through the Worker's own route (W42): his membership's subscription is moved to it. */
async function replaceCard(stripe: FakeStripe, card: string = NEW_CARD): Promise<Answer> {
  const intent = await stripe.setupIntents.create({ customer: MO_STRIPE, payment_method_types: ['card_present'], usage: 'off_session' })
  stripe.completeReaderSetup(intent.id, { generatedCard: card })
  vi.setSystemTime(Date.now() + 1000)
  return read(
    await savedCardRoute(
      new Request(`https://worker.test/api/v1/staff/customers/${ID.member}/saved-card`, { method: 'POST', headers: headers(REPLAY_USER.email, crypto.randomUUID()), body: JSON.stringify({ setupIntentId: intent.id }) }),
      { params: Promise.resolve({ customerId: ID.member }) }
    )
  )
}

/** The fake as the route reaches it, with `landing` run once just after the first call of `resource.method` is answered and before the route carries on. */
function withAChangeAfter(stripe: FakeStripe, resource: 'subscriptions' | 'invoices', method: string, landing: () => Promise<void> | void): StripeClient {
  let landed = false
  const real = stripe[resource] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  const wrapped = {
    ...real,
    [method]: async (...args: unknown[]) => {
      const answer = await (real[method] as (...a: unknown[]) => Promise<unknown>)(...args)
      if (!landed) {
        landed = true
        await landing()
      }
      return answer
    },
  }
  return new Proxy(stripe, { get: (target, prop) => (prop === resource ? wrapped : Reflect.get(target, prop)) }) as unknown as StripeClient
}

/** The fake as the route reaches it, dying at `invoices.pay`: the request never gets an answer and nothing after it runs. `after`: the payment is taken in Stripe first. */
function dyingAtThePay(stripe: FakeStripe, after: boolean): { client: StripeClient; reached: Promise<void> } {
  let reach: () => void = () => {}
  const reached = new Promise<void>((resolve) => (reach = resolve))
  const invoices = {
    ...stripe.invoices,
    pay: async (...args: Parameters<StripeClient['invoices']['pay']>) => {
      if (after) await stripe.invoices.pay(...args)
      reach()
      return new Promise<never>(() => {})
    },
  }
  return { client: new Proxy(stripe, { get: (target, prop) => (prop === 'invoices' ? invoices : Reflect.get(target, prop)) }) as unknown as StripeClient, reached }
}

/** Mark refunded on a retry, through the Orders page's real close route (W47r-a). */
async function markRefunded(retryId: string, { email = REPLAY_USER.email, key = crypto.randomUUID() as string } = {}): Promise<Answer> {
  vi.setSystemTime(Date.now() + 1000)
  return read(
    await closeRoute(
      new Request('https://worker.test/api/v1/staff/orders/stuck/close', {
        method: 'POST',
        headers: headers(email, key),
        body: JSON.stringify({ kind: 'retry_paid_after_end', orderId: retryId, reason: 'Refunded in Stripe by the manager' }),
      })
    )
  )
}
/** One run of the lapse sweep, a second on (the replay holds the clock still). */
const sweepNow = () => {
  vi.setSystemTime(Date.now() + 1000)
  return lapseSweep(db, { requestId: `lapse-sweep-${crypto.randomUUID()}`, orderSwitch: 'lapse_sweep' })
}

const paidEvent = (invoice: string): Stripe.Event => invoiceEvent('invoice.paid', MO_SUBSCRIPTION, { id: invoice, periodEnd: JAN_10, amountPaid: 4000 })

describe('the quote (brief item 5): what the window shows, read from Stripe now, with nothing written and nothing sent', () => {
  it("Mo's failed renewal: £40 on the invoice Stripe shows as its newest, his saved card, and his two bookings waiting for payment; any active staff member may read it", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      const before = stripe.calls.length
      const shown = await quote()
      expect(shown.status).toBe(200)
      expect(shown.data).toEqual({
        membershipId: ID.membership,
        customerId: ID.member,
        customerName: 'Mo Member',
        planName: expect.any(String),
        refusal: null,
        reason: null,
        alreadyPaid: false,
        invoiceId: failed.invoice,
        amount: 40,
        cardBrand: 'visa',
        cardLast4: '4444',
        // W47r-a (S3): the card by its id, for the press to send back.
        paymentMethodId: OLD_CARD,
        bookingsWaiting: 2,
        ifPaid: 'If the payment goes through, the membership is active again and its 2 bookings waiting for payment go back to confirmed straight away.',
      })
      expect(retryPaymentQuoteOutputSchema.safeParse(shown.data).success).toBe(true)
      // Two reads, and nothing else.
      expect(stripe.calls.slice(before).map((call) => call.method)).toEqual(['subscriptions.retrieve', 'invoices.retrieve'])
      expect(await retryRows()).toEqual([])
      // A staff member without Issue refunds reads the same; an inactive one is refused by the route.
      expect((await quote({ email: NO_REFUNDS })).data).toEqual(shown.data)
      expect((await quote({ email: INACTIVE })).status).toBe(403)
      expect(refusalOf(await quote({ membershipId: '10000000-0000-4000-8000-00000000ffff' }))).toEqual([404, 'NOT_FOUND', 'membership_not_found', 'Membership not found.'])
    })
  })

  it('a membership that is not past due is refused from its own row: Stripe is not read at all; with one booking waiting the line says "1 booking"', async () => {
    await onASeed(async (stripe) => {
      const before = stripe.calls.length
      const shown = await quote()
      expect(shown.data).toMatchObject({ refusal: PAYMENT_RETRY_REFUSALS.notPastDue, reason: 'not_past_due', invoiceId: null, amount: null, alreadyPaid: false, bookingsWaiting: 0 })
      expect(shown.data?.['ifPaid']).toBe('If the payment goes through, the membership is active again straight away. None of its bookings is waiting for payment.')
      expect(stripe.calls.slice(before)).toEqual([])
      expect(PAYMENT_RETRY_WORDS.ifPaid(1)).toBe('If the payment goes through, the membership is active again and its 1 booking waiting for payment goes back to confirmed straight away.')
    })
  })

  it('the quote carries every refusal the press would give, in the same words: a card step still open', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      // The replace's move reaches Stripe and its answer is lost: the subscription shows the new card, and the step stays open.
      stripe.failNext('subscriptions.update', { kind: 'lost_response' })
      expect((await replaceCard(stripe)).data).toMatchObject({ membershipsMoved: 0, membershipsToMove: 1 })
      const shown = await quote()
      expect(shown.data).toMatchObject({ refusal: PAYMENT_RETRY_REFUSALS.cardStepOpen, reason: 'card_step_open', invoiceId: failed.invoice, amount: 40, cardLast4: '1881', cardBrand: 'mastercard' })
      expect(refusalOf(await pressShown(failed.invoice))).toEqual([409, 'CONFLICT', 'card_step_open', PAYMENT_RETRY_REFUSALS.cardStepOpen])
    })
  })
})

describe("Mo (the brief's case): the renewal fails, the card is replaced, the payment is tried again and goes through", () => {
  it('one charge of £40 on the new card; his bookings are confirmed at once and his next payment date moves on; the record is written first; the webhook\'s invoice.paid afterwards changes nothing', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      const dueBefore = [(await booking(failed.eleventh))?.due, (await booking(failed.fifteenth))?.due]
      expect(dueBefore.every((due) => typeof due === 'string')).toBe(true)
      // 16:00: Mo replaces his card at the desk. Nothing is charged by that, and his bookings are still flagged.
      expect((await replaceCard(stripe)).data).toMatchObject({ membershipsMoved: 1, membershipsToMove: 0 })
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.defaultPaymentMethod).toBe(NEW_CARD)
      expect(stripe.netPence).toBe(0)
      expect((await booking(failed.eleventh))?.status).toBe('payment_needed')

      const shown = (await quote()).data as { invoiceId: string; amount: number; cardLast4: string; cardBrand: string; paymentMethodId: string }
      expect(shown).toMatchObject({ invoiceId: failed.invoice, amount: 40, cardBrand: 'mastercard', cardLast4: '1881', paymentMethodId: NEW_CARD, refusal: null })
      const before = stripe.calls.length
      const answer = await press({ confirmed: { invoiceId: shown.invoiceId, amount: shown.amount, paymentMethodId: shown.paymentMethodId } })
      expect(answer.status).toBe(200)
      const rows = await retryRows()
      const retryId = rows[0]?.details['retryId'] as string
      expect(answer.data).toEqual({
        retryId,
        invoiceId: failed.invoice,
        amountCharged: 40,
        alreadyPaid: false,
        cardBrand: 'mastercard',
        cardLast4: '1881',
        membershipUpdated: true,
        bookingsRestored: 2,
        bookingsWaiting: 0,
        subscriptionStatus: 'active',
        nextRenewalDate: '2027-01-10',
        message: '£40.00 was taken on the Mastercard card ending 1881. The membership is active again and its next payment is on 10 Jan 2027. 2 bookings that were waiting for payment are confirmed again.',
      })
      expect(retryPaymentOutputSchema.safeParse(answer.data).success).toBe(true)

      // The bookings, at once, with no webhook event handled since the failure.
      expect(await booking(failed.eleventh)).toEqual({ status: 'confirmed', due: null })
      expect(await booking(failed.fifteenth)).toEqual({ status: 'confirmed', due: null })
      expect(await membership()).toEqual({ status: 'active', renews: '2027-01-10' })

      // Stripe: the press's calls, in order. One send, naming the card, under the record's key.
      expect(stripe.calls.slice(before).map((call) => call.method)).toEqual(['subscriptions.retrieve', 'invoices.retrieve', 'invoices.pay', 'subscriptions.retrieve', 'subscriptions.retrieve'])
      expect(pays(stripe)).toEqual([{ method: 'invoices.pay', params: { id: failed.invoice, payment_method: NEW_CARD, off_session: true }, idempotencyKey: `${retryId}:pay` }])
      expect(paymentRetryKey(retryId)).toBe(`${retryId}:pay`)
      // The route's client is the order's: 10 seconds a call and no retries by the SDK, so nothing is sent twice behind the rule's back.
      expect(stripeClientsMade.at(-1)?.limits).toEqual({ timeoutMs: 10_000, networkRetries: 0 })
      expect(stripe.invoiceState(failed.invoice)).toEqual({ status: 'paid', amountPaid: 4000, paymentIntent: failed.paymentIntent, paymentStatus: 'succeeded', paymentMethod: NEW_CARD })
      expect([...stripe.chargedByIntent]).toEqual([[failed.paymentIntent, 4000]])
      expect(stripe.netPence).toBe(4000)

      // The record: `started` with everything the send and reconcile need, then `paid` with what the write did.
      expect(rows.map((row) => row.details['state'])).toEqual(['started', 'paid'])
      expect(rows[0]).toEqual({
        action: 'membership.payment_retried',
        actor_type: 'staff',
        actor_id: ID.staff,
        entity_type: 'membership',
        entity_id: ID.membership,
        details: {
          retryId,
          state: 'started',
          channel: 'staff',
          customerId: ID.member,
          subscriptionId: MO_SUBSCRIPTION,
          stripeCustomerId: MO_STRIPE,
          invoiceId: failed.invoice,
          amount: 40,
          paymentMethodId: NEW_CARD,
          cardBrand: 'mastercard',
          cardLast4: '1881',
          livemode: false,
          shown: { invoiceId: failed.invoice, amount: 40, paymentMethodId: NEW_CARD },
        },
      })
      expect(rows[1]?.details).toMatchObject({ retryId, state: 'paid', how: 'press', invoiceId: failed.invoice, amount: 40, alreadyPaid: false, membership: { outcome: 'processed', action: 'reactivated', was: 'past_due', bookings_restored: 2 } })

      // The webhook's own invoice.paid, arriving afterwards: the same write, and nothing changes.
      const late = await dispatchStripeEvent(paidEvent(failed.invoice), webhookRpc(db), stripe)
      expect(late).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', was: 'active', bookings_restored: 0 } })
      expect(await membership()).toEqual({ status: 'active', renews: '2027-01-10' })
      expect(await booking(failed.eleventh)).toEqual({ status: 'confirmed', due: null })
      expect(await states()).toEqual(['started', 'paid'])
      // Nothing is listed, and a run past the window has nothing of it to do and sends nothing.
      pastTheWindow()
      expect(await listed()).toEqual([])
      const callsBefore = stripe.calls.length
      expect(await retryItems(stripe)).toEqual([])
      expect(writesSince(stripe, callsBefore)).toEqual([])
      expect(pays(stripe)).toHaveLength(1)
      expect(stripe.netPence).toBe(4000)
    })
  })

  it('the record is committed before anything is sent: a Worker that dies at the send leaves the `started` row and nothing else, and no second send is ever made for it', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      const dying = dyingAtThePay(stripe, false)
      replayStripe.current = dying.client
      void pressShown(failed.invoice)
      await dying.reached
      replayStripe.current = stripe
      const rows = await retryRows()
      expect(rows.map((row) => row.details['state'])).toEqual(['started'])
      expect(rows[0]?.details).toMatchObject({ invoiceId: failed.invoice, amount: 40, paymentMethodId: OLD_CARD })
      // A new press while it is open: refused, and nothing is sent.
      expect(refusalOf(await pressShown(failed.invoice))).toEqual([409, 'CONFLICT', 'retry_held', PAYMENT_RETRY_REFUSALS.retryHeld])
      expect(pays(stripe)).toEqual([])
      // Past the window a run reads the invoice: open, its payment took nothing. The record ends; nothing was sent.
      pastTheWindow()
      const callsBefore = stripe.calls.length
      expect(await retryItems(stripe)).toMatchObject([{ kind: 'payment_retry', outcome: 'undone' }])
      expect(stripe.calls.slice(callsBefore).filter((call) => call.method.startsWith('invoices') || call.method.startsWith('paymentIntents')).map((call) => call.method)).toEqual(['invoices.retrieve', 'paymentIntents.retrieve'])
      expect(await states()).toEqual(['started', 'not_taken'])
      expect(pays(stripe)).toEqual([])
      expect(stripe.netPence).toBe(0)
      expect(await membership()).toMatchObject({ status: 'past_due' })
    })
  })

  it('a Worker that dies after the send landed: the payment is in Stripe, the record is open; the run past the window reads the invoice as paid and makes the write, once', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      const dying = dyingAtThePay(stripe, true)
      replayStripe.current = dying.client
      void pressShown(failed.invoice)
      await dying.reached
      replayStripe.current = stripe
      expect(await states()).toEqual(['started'])
      expect(stripe.netPence).toBe(4000)
      expect((await booking(failed.eleventh))?.status).toBe('payment_needed')
      // Inside the window the run leaves it alone (its press may still be running).
      expect(await retryItems(stripe)).toEqual([])
      pastTheWindow()
      expect(await retryItems(stripe)).toMatchObject([{ kind: 'payment_retry', outcome: 'finalised' }])
      expect(await states()).toEqual(['started', 'paid'])
      expect((await retryRows())[1]?.details).toMatchObject({ how: 'reconcile', membership: { action: 'reactivated', bookings_restored: 2 } })
      expect(await booking(failed.eleventh)).toEqual({ status: 'confirmed', due: null })
      expect(await membership()).toEqual({ status: 'active', renews: '2027-01-10' })
      expect(await retryItems(stripe)).toEqual([])
      expect(pays(stripe)).toHaveLength(1)
      expect(stripe.netPence).toBe(4000)
    })
  })
})

describe('declined (brief item 4): nothing is written to the membership, and the bookings keep their deadline', () => {
  it("Mo's old card is declined again: the words say so and that Stripe's own retries carry on; then, after a new card, a second press goes through: two records, two sends, one charge", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.declineCard(OLD_CARD)
      const before = { eleventh: await booking(failed.eleventh), fifteenth: await booking(failed.fifteenth) }
      const declined = await pressShown(failed.invoice)
      expect(refusalOf(declined)).toEqual([
        402,
        'PAYMENT_FAILED',
        'payment_failed',
        // W47r-a (review S4.3): Stripe's plain "Your card was declined" is not said a second time.
        "The card was declined. Nothing was charged and the membership is still overdue. Stripe's own retries carry on, and the bookings waiting for payment keep the deadline they had.",
      ])
      expect(declined.error?.details?.held).toBeUndefined()
      expect(await membership()).toEqual({ status: 'past_due', renews: '2026-12-10' })
      expect(await booking(failed.eleventh)).toEqual(before.eleventh)
      expect(await booking(failed.fifteenth)).toEqual(before.fifteenth)
      expect(stripe.netPence).toBe(0)
      const first = await retryRows()
      expect(first.map((row) => row.details['state'])).toEqual(['started', 'declined'])
      expect(first[1]?.details).toMatchObject({ stripeCode: 'card_declined', stripeSaid: 'Your card was declined' })
      // Ended, so it is not held: nothing is listed, a run has nothing to do, and a new press is allowed.
      pastTheWindow()
      expect(await listed()).toEqual([])
      expect(await retryItems(stripe)).toEqual([])

      expect((await replaceCard(stripe)).data).toMatchObject({ membershipsMoved: 1, membershipsToMove: 0 })
      const paid = await pressShown(failed.invoice)
      expect(paid.data).toMatchObject({ amountCharged: 40, alreadyPaid: false, cardLast4: '1881', membershipUpdated: true, bookingsRestored: 2, subscriptionStatus: 'active' })
      const sends = pays(stripe)
      expect(sends.map((call) => (call.params as { payment_method: string }).payment_method)).toEqual([OLD_CARD, NEW_CARD])
      expect(new Set(sends.map((call) => call.idempotencyKey)).size).toBe(2)
      expect(await states()).toEqual(['started', 'declined', 'started', 'paid'])
      expect(stripe.invoiceState(failed.invoice)).toMatchObject({ status: 'paid', paymentMethod: NEW_CARD })
      expect(stripe.netPence).toBe(4000)
    })
  })

  it("a card that needs the customer's approval and is refused outright (authentication_required): its own words, nothing held", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.failNext('invoices.pay', { kind: 'error', error: fakeStripeErrors.authenticationRequired() })
      expect(refusalOf(await pressShown(failed.invoice))).toEqual([402, 'PAYMENT_NEEDS_AUTHENTICATION', 'payment_failed', PAYMENT_RETRY_WORDS.authenticationRequired])
      expect(await states()).toEqual(['started', 'declined'])
      expect(await membership()).toMatchObject({ status: 'past_due' })
    })
  })

  it("Stripe refuses the payment for a reason that isn't the bank's: said as Stripe's, in its own words; nothing charged, nothing held", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.failNext('invoices.pay', { kind: 'error', error: fakeStripeErrors.invalid('payment_method_not_attached', 'The payment method pm_member is not attached to this customer.') })
      expect(refusalOf(await pressShown(failed.invoice))).toEqual([
        402,
        'PAYMENT_FAILED',
        'payment_failed',
        "The payment was not taken: The payment method pm_member is not attached to this customer. Nothing was charged and the membership is still overdue. Stripe's own retries carry on, and the bookings waiting for payment keep the deadline they had. If this happens again, tell a manager.",
      ])
      expect(await states()).toEqual(['started', 'declined'])
      expect((await retryRows())[1]?.details).toMatchObject({ stripeCode: 'payment_method_not_attached' })
      expect(stripe.netPence).toBe(0)
    })
  })
})

describe('no clear answer (brief item 4, review point 3): held, listed, never closed by hand; reconcile only reads', () => {
  it('Stripe answers the send with a 500: held, with its record named; a second press is refused and sends nothing; past the window the run reads the invoice paid and records it, once', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.failNext('invoices.pay', noAnswer())
      const answer = await pressShown(failed.invoice)
      const retryId = (await retryRows())[0]?.details['retryId'] as string
      expect(refusalOf(answer)).toEqual([
        502,
        'PAYMENT_UNCONFIRMED',
        'payment_unconfirmed',
        "The payment didn't get a clear answer from Stripe, so the card may or may not have been charged. It is on hold and the automatic check will finish it. Don't take the payment again or another way. Check the Orders page in a few minutes.",
      ])
      expect(answer.error?.details).toMatchObject({ action: 'payment_retry', held: { retryId } })
      expect(await states()).toEqual(['started', 'held'])
      expect(await membership()).toMatchObject({ status: 'past_due' })

      // Point 3: no new press while one is held. The quote says the same.
      const before = stripe.calls.length
      expect(refusalOf(await pressShown(failed.invoice))).toEqual([409, 'CONFLICT', 'retry_held', PAYMENT_RETRY_REFUSALS.retryHeld])
      expect((await quote()).data).toMatchObject({ refusal: PAYMENT_RETRY_REFUSALS.retryHeld, reason: 'retry_held' })
      expect(writesSince(stripe, before)).toEqual([])
      expect(await states()).toEqual(['started', 'held'])

      // W47r-a (S2 a): the press has written its `held` row, so the list shows it and a run reads it without waiting for
      // the window. Inside the window a run never ends it as not taken (the send may still land): left, `waiting`.
      expect(await listed()).toMatchObject([{ retryId, ageMinutes: 0, reason: 'waiting', words: PAYMENT_RETRY_STUCK_WORDS['waiting'] }])
      const early = stripe.calls.length
      expect(await retryItems(stripe)).toEqual([
        { kind: 'payment_retry', id: retryId, outcome: 'left', reason: 'waiting', detail: `invoice ${failed.invoice} is open; ${failed.paymentIntent} requires_payment_method; not ended as not taken until it is 15 minutes old` },
      ])
      expect(writesSince(stripe, early)).toEqual([])
      expect(await states()).toEqual(['started', 'held'])
      pastTheWindow()
      const list = await stuckList(db)
      expect(list.paymentRetries).toEqual([
        {
          retryId,
          membershipId: ID.membership,
          customerId: ID.member,
          customerName: 'Mo Member',
          invoiceId: failed.invoice,
          amount: 40,
          cardBrand: 'visa',
          cardLast4: '4444',
          createdAt: expect.any(String),
          ageMinutes: 16,
          reason: 'waiting',
          words: PAYMENT_RETRY_STUCK_WORDS['waiting'],
        },
      ])
      expect(stuckListOutputSchema.safeParse(list).success).toBe(true)

      // Stripe's own retry (or the send, landing late) has paid the invoice meanwhile. The run reads, and records it.
      stripe.stripeRetryPays(failed.invoice)
      const callsBefore = stripe.calls.length
      const run = await reconcileNow(stripe)
      expect(reconcileRunOutputSchema.safeParse(run).success).toBe(true)
      expect(run.items.filter((item) => item.kind === 'payment_retry')).toEqual([{ kind: 'payment_retry', id: retryId, outcome: 'finalised', detail: `invoice ${failed.invoice} is paid; the membership was marked paid` }])
      expect(writesSince(stripe, callsBefore)).toEqual([])
      expect(await states()).toEqual(['started', 'held', 'paid'])
      expect((await retryRows())[2]?.details).toMatchObject({ how: 'reconcile', membership: { action: 'reactivated', bookings_restored: 2 } })
      expect(await booking(failed.eleventh)).toEqual({ status: 'confirmed', due: null })
      expect(await booking(failed.fifteenth)).toEqual({ status: 'confirmed', due: null })
      expect(await membership()).toEqual({ status: 'active', renews: '2027-01-10' })
      // Once: another run has nothing of it, the list is empty, and the webhook's event changes nothing.
      expect(await retryItems(stripe)).toEqual([])
      expect(await listed()).toEqual([])
      expect(await dispatchStripeEvent(paidEvent(failed.invoice), webhookRpc(db), stripe)).toMatchObject({ detail: { was: 'active', bookings_restored: 0 } })
      expect(await states()).toEqual(['started', 'held', 'paid'])
      expect(pays(stripe)).toHaveLength(1)
      expect(stripe.netPence).toBe(4000)
    })
  })

  it("the one-send rule (review point 5): the press's key repeated gets the first answer; and after Stripe has dropped its key (24 hours), runs and presses still never send for the record", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.failNext('invoices.pay', { kind: 'unreachable' })
      const key = crypto.randomUUID()
      const first = await pressShown(failed.invoice, 40, { key })
      expect(first.error?.code).toBe('PAYMENT_UNCONFIRMED')
      const again = await pressShown(failed.invoice, 40, { key })
      expect(again.replayed).toBe(true)
      expect(again.error).toEqual(first.error)
      expect(pays(stripe)).toHaveLength(1)
      // A day later Stripe no longer knows the key: the same key sent again would be a new payment attempt.
      vi.setSystemTime(Date.now() + 25 * 3_600_000)
      stripe.forgetIdempotencyKeys()
      for (let run = 0; run < 3; run += 1) {
        expect(await retryItems(stripe)).toMatchObject([{ outcome: run === 0 ? 'undone' : 'settled_elsewhere' }].slice(0, run === 0 ? 1 : 0))
        vi.setSystemTime(Date.now() + 5 * 60_000)
      }
      expect(pays(stripe)).toHaveLength(1)
      expect(stripe.netPence).toBe(0)
      // The record ended `not_taken` (the invoice open, its payment took nothing), so a NEW press is a new record with a key of its own.
      expect(await states()).toEqual(['started', 'held', 'not_taken'])
      const paid = await pressShown(failed.invoice)
      expect(paid.status).toBe(200)
      const sends = pays(stripe)
      expect(sends).toHaveLength(2)
      expect(sends[0]?.idempotencyKey).not.toBe(sends[1]?.idempotencyKey)
      expect(stripe.netPence).toBe(4000)
    })
  })

  it('the run reads the invoice still open with its payment ended and nothing taken: the record ends "not taken", the membership is untouched, and the payment can be tried again', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.failNext('invoices.pay', noAnswer())
      expect((await pressShown(failed.invoice)).error?.code).toBe('PAYMENT_UNCONFIRMED')
      const retryId = (await retryRows())[0]?.details['retryId'] as string
      pastTheWindow()
      const callsBefore = stripe.calls.length
      expect(await retryItems(stripe)).toEqual([{ kind: 'payment_retry', id: retryId, outcome: 'undone', detail: `invoice ${failed.invoice} is open; ${failed.paymentIntent} requires_payment_method` }])
      expect(writesSince(stripe, callsBefore)).toEqual([])
      expect(await states()).toEqual(['started', 'held', 'not_taken'])
      expect(await membership()).toEqual({ status: 'past_due', renews: '2026-12-10' })
      expect((await booking(failed.eleventh))?.status).toBe('payment_needed')
      expect(await listed()).toEqual([])
      expect((await quote()).data).toMatchObject({ refusal: null, amount: 40 })
      expect((await pressShown(failed.invoice)).status).toBe(200)
      expect(stripe.netPence).toBe(4000)
    })
  })

  it("Stripe shows the invoice's payment as succeeded while the invoice itself still reads open (it hasn't caught up): never 'not taken'; left, and read again", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.failNext('invoices.pay', noAnswer())
      const retryId = (await pressShown(failed.invoice)).error?.details?.held?.retryId as string
      pastTheWindow()
      // The payment reads `succeeded`; the invoice, read a moment earlier, was still `open`.
      const real = stripe.paymentIntents.retrieve
      const ahead = new Proxy(stripe, {
        get: (target, prop) => (prop === 'paymentIntents' ? { ...target.paymentIntents, retrieve: async (...args: Parameters<typeof real>) => ({ ...(await real(...args)), status: 'succeeded' }) } : Reflect.get(target, prop)),
      }) as unknown as StripeClient
      vi.setSystemTime(Date.now() + 1000)
      const run = await reconcile(db, ahead, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
      expect(run.items.filter((item) => item.kind === 'payment_retry')).toEqual([{ kind: 'payment_retry', id: retryId, outcome: 'left', reason: 'unclear', detail: `invoice ${failed.invoice} is open; ${failed.paymentIntent} succeeded` }])
      expect(await states()).toEqual(['started', 'held'])
      expect((await listed())[0]).toMatchObject({ retryId, reason: 'unclear' })
      // The record is still open, so a new press is still refused.
      expect(refusalOf(await pressShown(failed.invoice))).toEqual([409, 'CONFLICT', 'retry_held', PAYMENT_RETRY_REFUSALS.retryHeld])
    })
  })

  it('a record that is ended while a run is reading Stripe for it gets no second ending: the run looks again under the lock and writes nothing', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.failNext('invoices.pay', noAnswer())
      const retryId = (await pressShown(failed.invoice)).error?.details?.held?.retryId as string
      pastTheWindow()
      // While the run's read of the invoice is out, something else ends the record (a press finishing late, or another run).
      const ending = withAChangeAfter(stripe, 'invoices', 'retrieve', async () => {
        await db.query(
          "INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details) VALUES ('staff', $1, $2, 'membership', $3, 'ended-meanwhile', $4)",
          [ID.staff, PAYMENT_RETRY_ACTION, ID.membership, { retryId, state: 'declined' }]
        )
      })
      vi.setSystemTime(Date.now() + 1000)
      const run = await reconcile(db, ending, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
      expect(run.items.filter((item) => item.kind === 'payment_retry')).toEqual([{ kind: 'payment_retry', id: retryId, outcome: 'settled_elsewhere', detail: 'ended' }])
      expect(await states()).toEqual(['started', 'held', 'declined'])
      // And from then on it is nobody's: no run lists it.
      expect(await retryItems(stripe)).toEqual([])
      expect(await listed()).toEqual([])
    })
  })

  it("the bank is still processing the payment: held; after 31 days it is still held, still read every run, and has no close; when the bank finishes, the run records it", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.nextPayEnds(failed.invoice, 'processing')
      const answer = await pressShown(failed.invoice)
      expect(refusalOf(answer)).toEqual([502, 'PAYMENT_UNCONFIRMED', 'payment_processing', PAYMENT_RETRY_WORDS.heldProcessing])
      const retryId = answer.error?.details?.held?.retryId as string
      expect(await states()).toEqual(['started', 'held'])
      expect(stripe.invoiceState(failed.invoice)).toMatchObject({ status: 'open', paymentStatus: 'processing' })
      pastTheWindow()
      expect(await retryItems(stripe)).toEqual([{ kind: 'payment_retry', id: retryId, outcome: 'left', reason: 'payment_processing', detail: `invoice ${failed.invoice} is open; ${failed.paymentIntent} processing` }])
      // 31 days on (W47a S2's lesson): nothing has ended it, and nothing offers to.
      vi.setSystemTime(Date.now() + 31 * 24 * 3_600_000)
      const callsBefore = stripe.calls.length
      expect(await retryItems(stripe)).toMatchObject([{ id: retryId, outcome: 'left', reason: 'payment_processing' }])
      expect(writesSince(stripe, callsBefore)).toEqual([])
      const [line] = await listed()
      expect(line).toMatchObject({ retryId, reason: 'payment_processing', words: PAYMENT_RETRY_STUCK_WORDS['payment_processing'] })
      expect(line && 'close' in line).toBe(false)
      // W47r-a: the only close a retry ever has is Mark refunded, for one paid after its subscription ended.
      expect(stuckCloseKindSchema.options.filter((kind) => kind.includes('retry'))).toEqual(['retry_paid_after_end'])
      expect((await markRefunded(retryId)).data).toMatchObject({ closed: false, reason: 'not_paid_after_end', message: PAYMENT_RETRY_CLOSE_WORDS.notForAPerson })
      expect(await states()).toEqual(['started', 'held'])
      expect(refusalOf(await pressShown(failed.invoice))).toEqual([409, 'CONFLICT', 'retry_held', PAYMENT_RETRY_REFUSALS.retryHeld])
      // The bank finishes it.
      stripe.settleInvoicePayment(failed.invoice, 'succeeded')
      expect(await retryItems(stripe)).toMatchObject([{ id: retryId, outcome: 'finalised' }])
      expect(await states()).toEqual(['started', 'held', 'paid'])
      expect(await membership()).toMatchObject({ status: 'active' })
      expect(pays(stripe)).toHaveLength(1)
      expect(stripe.netPence).toBe(4000)
    })
  })

  it("the payment is left waiting on the customer (requires_action): held, not declined; the run leaves it until Stripe shows it ended, then ends the record with nothing taken", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.nextPayEnds(failed.invoice, 'requires_action')
      const answer = await pressShown(failed.invoice)
      expect(refusalOf(answer)).toEqual([502, 'PAYMENT_UNCONFIRMED', 'payment_needs_action', PAYMENT_RETRY_WORDS.heldNeedsAction])
      expect(await states()).toEqual(['started', 'held'])
      pastTheWindow()
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'left', reason: 'payment_needs_action' }])
      expect((await listed())[0]).toMatchObject({ reason: 'payment_needs_action', words: PAYMENT_RETRY_STUCK_WORDS['payment_needs_action'] })
      stripe.settleInvoicePayment(failed.invoice, 'failed')
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'undone' }])
      expect(await states()).toEqual(['started', 'held', 'not_taken'])
      expect(stripe.netPence).toBe(0)
      expect(await membership()).toMatchObject({ status: 'past_due' })
    })
  })

  it('the send lands and its answer is lost: the press reads the invoice once, finds it paid and answers paid there and then', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.failNext('invoices.pay', { kind: 'lost_response' })
      const answer = await pressShown(failed.invoice)
      expect(answer.data).toMatchObject({ amountCharged: 40, alreadyPaid: false, membershipUpdated: true, bookingsRestored: 2, subscriptionStatus: 'active' })
      expect(await states()).toEqual(['started', 'paid'])
      expect(pays(stripe)).toHaveLength(1)
      expect(stripe.netPence).toBe(4000)
    })
  })

  it("no clear answer and then the invoice can't be read either: held; a read that fails at the run leaves it for the next run; a key of the other Stripe mode is said as such", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.failNext('invoices.pay', noAnswer())
      stripe.failNext('invoices.retrieve', { kind: 'none' })
      stripe.failNext('invoices.retrieve', noAnswer())
      expect((await pressShown(failed.invoice)).error?.details?.reason).toBe('payment_unconfirmed')
      pastTheWindow()
      stripe.failNext('invoices.retrieve', noAnswer())
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'left', reason: 'unclear' }])
      expect((await listed())[0]).toMatchObject({ reason: 'unclear', words: PAYMENT_RETRY_STUCK_WORDS['unclear'] })
      // The Worker redeployed with the other mode's key: Stripe has no such invoice for it.
      stripe.keyLivemode = true
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'left', reason: 'other_mode' }])
      expect((await listed())[0]).toMatchObject({ reason: 'other_mode', words: PAYMENT_RETRY_STUCK_WORDS['other_mode'] })
      expect(await states()).toEqual(['started', 'held'])
      stripe.keyLivemode = false
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'undone' }])
    })
  })

  it('paid in Stripe, and the write here fails: held as paid but not recorded, the bookings still flagged; the run makes the write', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      // The press's first read of the subscription (S1) answers; the write's own read, after the payment, gets a 500.
      stripe.failNext('subscriptions.retrieve', { kind: 'none' })
      stripe.failNext('subscriptions.retrieve', noAnswer())
      const answer = await pressShown(failed.invoice)
      expect(refusalOf(answer)).toEqual([502, 'PAYMENT_UNCONFIRMED', 'paid_not_recorded', PAYMENT_RETRY_WORDS.paidNotRecorded])
      expect(stripe.netPence).toBe(4000)
      expect(await states()).toEqual(['started', 'held'])
      expect((await retryRows())[1]?.details).toMatchObject({ reason: 'paid_not_recorded' })
      expect(await membership()).toMatchObject({ status: 'past_due' })
      expect((await booking(failed.eleventh))?.status).toBe('payment_needed')
      pastTheWindow()
      expect((await listed())[0]).toMatchObject({ reason: 'waiting' })
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'finalised' }])
      expect(await states()).toEqual(['started', 'held', 'paid'])
      expect(await membership()).toEqual({ status: 'active', renews: '2027-01-10' })
      expect(await booking(failed.eleventh)).toEqual({ status: 'confirmed', due: null })
      expect(pays(stripe)).toHaveLength(1)
      expect(stripe.netPence).toBe(4000)
    })
  })

  it("paid in Stripe with the write failed, and the run's write fails too: left as paid but not recorded, and tried again next run; a press meanwhile finds the invoice paid, sends nothing and brings the membership up to date", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.failNext('subscriptions.retrieve', { kind: 'none' })
      stripe.failNext('subscriptions.retrieve', noAnswer())
      expect((await pressShown(failed.invoice)).error?.details?.reason).toBe('paid_not_recorded')
      pastTheWindow()
      stripe.failNext('subscriptions.retrieve', noAnswer())
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'left', reason: 'paid_not_recorded' }])
      expect((await listed())[0]).toMatchObject({ reason: 'paid_not_recorded', words: PAYMENT_RETRY_STUCK_WORDS['paid_not_recorded'] })
      expect(await membership()).toMatchObject({ status: 'past_due' })
      // Staff press again: Stripe shows the invoice paid, so nothing is sent (there is nothing to charge twice).
      const again = await pressShown(failed.invoice)
      expect(again.data).toMatchObject({ retryId: null, alreadyPaid: true, amountCharged: 0, membershipUpdated: true, bookingsRestored: 2 })
      expect(await membership()).toEqual({ status: 'active', renews: '2027-01-10' })
      // The held record is still the run's to end: it reads the invoice paid, makes the same write (nothing changes) and ends it.
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'finalised' }])
      expect(await listed()).toEqual([])
      expect(pays(stripe)).toHaveLength(1)
      expect(stripe.netPence).toBe(4000)
    })
  })

  it('no time left to send, and a key Stripe turns away: the record ends "not sent", nothing was charged, and the payment can be tried again', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      // The reads before the record use up the press's 30 seconds.
      replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', () => void vi.setSystemTime(Date.now() + 29_000))
      expect(refusalOf(await pressShown(failed.invoice))).toEqual([409, 'CONFLICT', 'not_sent', PAYMENT_RETRY_REFUSALS.notSent])
      replayStripe.current = stripe
      expect(await states()).toEqual(['started', 'not_sent'])
      expect(pays(stripe)).toEqual([])
      stripe.failNext('invoices.pay', { kind: 'error', error: fakeStripeErrors.authentication() })
      expect(refusalOf(await pressShown(failed.invoice))).toEqual([409, 'CONFLICT', 'key_refused', PAYMENT_RETRY_REFUSALS.keyRefused])
      expect(await states()).toEqual(['started', 'not_sent', 'started', 'not_sent'])
      expect(stripe.netPence).toBe(0)
      expect((await pressShown(failed.invoice)).status).toBe(200)
      expect(stripe.netPence).toBe(4000)
    })
  })
})

describe("already paid by Stripe's own retry (review point 3): treated as paid, never as an error", () => {
  it("Stripe's retry pays the invoice between the press's reads and its send: Stripe refuses the pay, the invoice reads paid, and the membership is marked paid; this press took nothing", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', () => stripe.stripeRetryPays(failed.invoice))
      const answer = await pressShown(failed.invoice)
      replayStripe.current = stripe
      expect(answer.status).toBe(200)
      expect(answer.data).toMatchObject({
        amountCharged: 0,
        alreadyPaid: true,
        membershipUpdated: true,
        bookingsRestored: 2,
        subscriptionStatus: 'active',
        nextRenewalDate: '2027-01-10',
        message:
          'Stripe shows this payment had already gone through (one of its own retries got there first), so nothing was charged by this press. The membership is active again and its next payment is on 10 Jan 2027. 2 bookings that were waiting for payment are confirmed again.',
      })
      expect(await states()).toEqual(['started', 'paid'])
      expect((await retryRows())[1]?.details).toMatchObject({ alreadyPaid: true })
      expect(await booking(failed.eleventh)).toEqual({ status: 'confirmed', due: null })
      // One payment in all: Stripe's own, on the subscription's card.
      expect(pays(stripe)).toHaveLength(1)
      expect([...stripe.chargedByIntent]).toEqual([[failed.paymentIntent, 4000]])
      expect(stripe.netPence).toBe(4000)
    })
  })

  it("Stripe's retry paid it before the press, and the webhook's notice hasn't been handled: the window says so, the press sends nothing and brings the membership up to date", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.stripeRetryPays(failed.invoice)
      expect(await membership()).toMatchObject({ status: 'past_due' })
      const shown = await quote()
      expect(shown.data).toMatchObject({
        refusal: null,
        alreadyPaid: true,
        invoiceId: failed.invoice,
        amount: 0,
        ifPaid: 'Stripe shows this payment has already gone through, so nothing will be charged. Pressing brings the membership up to date here: it will be active again and its 2 bookings waiting for payment go back to confirmed.',
      })
      const before = stripe.calls.length
      const answer = await press({ confirmed: { invoiceId: failed.invoice, amount: 0 } })
      expect(answer.data).toMatchObject({ retryId: null, invoiceId: failed.invoice, amountCharged: 0, alreadyPaid: true, membershipUpdated: true, bookingsRestored: 2, subscriptionStatus: 'active', nextRenewalDate: '2027-01-10' })
      expect(writesSince(stripe, before)).toEqual([])
      expect(pays(stripe)).toEqual([])
      const rows = await retryRows()
      expect(rows.map((row) => row.details['state'])).toEqual(['paid'])
      expect(rows[0]?.details).toMatchObject({ sent: false, alreadyPaid: true, amount: 0, invoiceId: failed.invoice, membership: { action: 'reactivated', bookings_restored: 2 } })
      expect(await booking(failed.fifteenth)).toEqual({ status: 'confirmed', due: null })
      // It was never open: nothing is listed and no run looks for it.
      pastTheWindow()
      expect(await listed()).toEqual([])
      expect(await retryItems(stripe)).toEqual([])
      expect(stripe.netPence).toBe(4000)
    })
  })

  it("paid up in Stripe with a newer invoice still a draft (the next renewal's hour): nothing is owed yet, so the press is refused and writes nothing", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.stripeRetryPays(failed.invoice)
      stripe.startRenewal(MO_SUBSCRIPTION, FEB_10)
      expect(refusalOf(await pressShown(failed.invoice))).toEqual([409, 'CONFLICT', 'not_behind', PAYMENT_RETRY_REFUSALS.stripeNotBehind('active')])
      expect(await membership()).toEqual({ status: 'past_due', renews: '2026-12-10' })
      expect(await retryRows()).toEqual([])
    })
  })

  it("paid, but Stripe has started a newer invoice by the time of the write: the payment is recorded as paid, and the membership is left for that invoice's own events (W46b)", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      const real = stripe.invoices.pay
      replayStripe.current = new Proxy(stripe, {
        get: (target, prop) =>
          prop === 'invoices'
            ? {
                ...target.invoices,
                pay: async (...args: Parameters<typeof real>) => {
                  const paid = await real(...args)
                  stripe.startRenewal(MO_SUBSCRIPTION, FEB_10)
                  return paid
                },
              }
            : Reflect.get(target, prop),
      }) as unknown as StripeClient
      const answer = await pressShown(failed.invoice)
      replayStripe.current = stripe
      expect(answer.data).toMatchObject({
        amountCharged: 40,
        membershipUpdated: false,
        bookingsRestored: 0,
        subscriptionStatus: 'past_due',
        message:
          "£40.00 was taken on the Visa card ending 4444. The membership here was not changed: Stripe has started a newer invoice for it since, and that invoice's own payment decides whether the membership is paid up. Look at the membership again in an hour.",
      })
      expect(await states()).toEqual(['started', 'paid'])
      expect((await retryRows())[1]?.details).toMatchObject({ membership: { outcome: 'ignored', reason: 'not_latest_invoice' } })
      expect(await membership()).toEqual({ status: 'past_due', renews: '2026-12-10' })
    })
  })
})

describe('refused before anything is sent (brief item 2): plain words, nothing written to Stripe, no record', () => {
  /** A press that must be refused with no record, no send and nothing taken. */
  async function refused(stripe: FakeStripe, answer: Answer, expected: [number, string, string, string]): Promise<void> {
    expect(refusalOf(answer)).toEqual(expected)
    expect(expected[3].includes('Nothing was charged') || expected[3].startsWith('Needs the Issue refunds') || expected[3] === MEMBERSHIP_PATH_OFF_MESSAGE).toBe(true)
    expect(pays(stripe)).toEqual([])
    expect(await retryRows()).toEqual([])
    expect(stripe.netPence).toBe(0)
  }

  it('no Issue refunds: FORBIDDEN before anything is read, in the database or in Stripe', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      const before = stripe.calls.length
      await refused(stripe, await pressShown(failed.invoice, 40, { email: NO_REFUNDS }), [403, 'FORBIDDEN', 'permission_denied', 'Needs the Issue refunds permission to try a membership payment again.'])
      expect(stripe.calls.slice(before)).toEqual([])
      expect((await pressShown(failed.invoice, 40, { email: INACTIVE })).status).toBe(403)
      expect(pays(stripe)).toEqual([])
    })
  })

  it.each([
    ['unset', ''],
    ['every other kind on', 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows,order_refunds,event_cancels,membership_changes,payment_date_changes,card_moves,lapse_sweep'],
  ])('the switch off (%s): the press and the quote answer the existing "switched off" words, naming the kind, and read nothing', async (_name, switchValue) => {
    await onASeed(
      async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        const before = stripe.calls.length
        const answer = await pressShown(failed.invoice)
        expect([answer.status, answer.error?.code, answer.error?.message, answer.error?.details]).toEqual([
          501,
          'MEMBERSHIP_PATH_OFF',
          'This is switched off in the booking system. Tell a manager.',
          { reason: 'membership_path_off', message: MEMBERSHIP_PATH_OFF_MESSAGE, kinds: ['payment_retries'] },
        ])
        expect((await quote()).error).toMatchObject({ code: 'MEMBERSHIP_PATH_OFF', details: { kinds: ['payment_retries'] } })
        expect(stripe.calls.slice(before)).toEqual([])
        expect(await retryRows()).toEqual([])
      },
      undefined,
      switchValue
    )
  })

  it('the kind alone turns it on: no other kind is needed for the press', async () => {
    await onASeed(
      async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        expect((await pressShown(failed.invoice)).status).toBe(200)
      },
      undefined,
      'payment_retries'
    )
  })

  it("the membership's own row: not past due; its last day passed; no subscription; no saved card. Stripe is not read for any of them", async () => {
    await onASeed(async (stripe) => {
      const before = stripe.calls.length
      await refused(stripe, await press({ confirmed: { invoiceId: 'in_any', amount: 40 } }), [409, 'CONFLICT', 'not_past_due', "This membership's payment isn't overdue, so there is nothing to try again. Nothing was charged."])
      expect(stripe.calls.slice(before)).toEqual([])
    })
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      const before = stripe.calls.length
      await db.query("UPDATE customer_memberships SET cancel_effective_date = '2026-12-09' WHERE id = $1", [ID.membership])
      await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'last_day_passed', "This membership's last day was 9 Dec 2026, so its overdue payment can't be taken. Nothing was charged."])
      // Its last day today or later doesn't refuse: the month is owed.
      await db.query("UPDATE customer_memberships SET cancel_effective_date = '2026-12-10', stripe_subscription_id = NULL WHERE id = $1", [ID.membership])
      await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'no_subscription', PAYMENT_RETRY_REFUSALS.noSubscription])
      await db.query('UPDATE customer_memberships SET cancel_effective_date = NULL, stripe_subscription_id = $2 WHERE id = $1', [ID.membership, MO_SUBSCRIPTION])
      await db.query('UPDATE customers SET saved_payment_method_id = NULL WHERE id = $1', [ID.member])
      await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'no_saved_card', PAYMENT_RETRY_REFUSALS.noSavedCard])
      expect(stripe.calls.slice(before)).toEqual([])
      expect(refusalOf(await press({ confirmed: { invoiceId: 'in_any', amount: 40 } }, { membershipId: '10000000-0000-4000-8000-00000000ffff' }))).toEqual([404, 'NOT_FOUND', 'membership_not_found', 'Membership not found.'])
    })
  })

  it("Stripe shows the subscription cancelled, with its invoice still open (review point 2): refused, so a member whose membership has ended is never charged", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      // Stripe gave up on the invoice and ended the subscription; the event that says so hasn't been handled, so the row still reads past due.
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      expect(stripe.invoiceState(failed.invoice).status).toBe('open')
      await refused(stripe, await pressShown(failed.invoice), [
        409,
        'CONFLICT',
        'subscription_cancelled',
        "Stripe shows this membership's subscription has been cancelled, so its unpaid invoice won't be charged: that would take money from someone whose membership has ended. Nothing was charged. If they want to carry on, sell them a new membership.",
      ])
      expect((await quote()).data).toMatchObject({ refusal: PAYMENT_RETRY_REFUSALS.stripeCancelled, reason: 'subscription_cancelled' })
    })
  })

  it('a cancel date already reached in Stripe: refused; one still to come is not', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      // Set to end at 15:00 on 10 December; it is 16:00.
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: Date.UTC(2026, 11, 10, 15) / 1000 })
      await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'cancel_date_reached', PAYMENT_RETRY_REFUSALS.stripeCancelDateReached('10 Dec 2026')])
      expect(PAYMENT_RETRY_REFUSALS.stripeCancelDateReached('10 Dec 2026')).toBe(
        "Stripe shows this membership's subscription was set to end on 10 Dec 2026, and that has passed, so its unpaid invoice won't be charged. Nothing was charged. If they want to carry on, sell them a new membership."
      )
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: JAN_10 })
      expect((await pressShown(failed.invoice)).status).toBe(200)
    })
  })

  it.each([
    ['incomplete' as const],
    ['paused' as const],
  ])('Stripe shows the subscription as %s (neither behind on a payment nor paid up): refused', async (status) => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.setSubscription(MO_SUBSCRIPTION, { status })
      await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'not_behind', `Stripe shows this membership's subscription as ${status}, not behind on a payment, so there is nothing to try again. Nothing was charged.`])
    })
  })

  it('unpaid is behind on a payment too: the payment is tried', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'unpaid' })
      expect((await pressShown(failed.invoice)).data).toMatchObject({ amountCharged: 40, subscriptionStatus: 'active' })
    })
  })

  it.each([['void' as const], ['uncollectible' as const]])("Stripe's newest invoice is %s, not open: refused", async (status) => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.setInvoiceStatus(failed.invoice, status)
      await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'invoice_not_open', `Stripe's newest invoice for this membership is ${status}, not waiting to be paid, so there is nothing to try again. Nothing was charged. Tell a manager.`])
    })
  })

  it("the invoice the window showed is no longer the subscription's newest: refused, and neither invoice is paid", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      expect((await quote()).data).toMatchObject({ invoiceId: failed.invoice, amount: 40 })
      // A month on, the next renewal fails too: Stripe's newest invoice is now January's, with December's still open.
      stripe.startRenewal(MO_SUBSCRIPTION, FEB_10)
      const january = stripe.renewalFails(MO_SUBSCRIPTION)
      await refused(stripe, await pressShown(failed.invoice), [
        409,
        'CONFLICT',
        'invoice_changed',
        "Stripe now shows a different invoice as this membership's newest than the one this window showed. Nothing was charged. Close this and open it again to see what is owed now.",
      ])
      expect(stripe.invoiceState(failed.invoice).status).toBe('open')
      expect(stripe.invoiceState(january.invoice).status).toBe('open')
      expect((await quote()).data).toMatchObject({ invoiceId: january.invoice, refusal: null })
    })
  })

  it("what the window showed: nothing sent, and an amount that is no longer Stripe's; within half a penny it is the same", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      await refused(stripe, await press({}), [400, 'VALIDATION', 'amount_not_confirmed', PAYMENT_RETRY_REFUSALS.figureMissing])
      await refused(stripe, await press({ confirmed: { invoiceId: failed.invoice } }), [400, 'VALIDATION', 'amount_not_confirmed', PAYMENT_RETRY_REFUSALS.figureMissing])
      await refused(stripe, await press({ confirmed: { amount: 40 } }), [400, 'VALIDATION', 'amount_not_confirmed', PAYMENT_RETRY_REFUSALS.figureMissing])
      // W47r-a (S3): the invoice and the amount without the card are refused the same way.
      await refused(stripe, await press({ confirmed: { invoiceId: failed.invoice, amount: 40 } }), [400, 'VALIDATION', 'amount_not_confirmed', PAYMENT_RETRY_REFUSALS.figureMissing])
      await refused(stripe, await pressShown(failed.invoice, 40, { card: null }), [400, 'VALIDATION', 'amount_not_confirmed', PAYMENT_RETRY_REFUSALS.figureMissing])
      expect(PAYMENT_RETRY_REFUSALS.figureMissing).toBe("The amount and the card shown on screen were not sent, so the payment wasn't tried. Nothing was charged. Close this, open it again and try again.")
      const changed = await pressShown(failed.invoice, 45)
      await refused(stripe, changed, [409, 'TOTAL_CHANGED', 'amount_changed', 'The amount to pay is now £40.00, not the £45.00 shown. Nothing was charged. Check the new amount with the customer and press again.'])
      expect(changed.error?.details?.amountNow).toBe(40)
      await refused(stripe, await pressShown(failed.invoice, 39.99), [409, 'TOTAL_CHANGED', 'amount_changed', PAYMENT_RETRY_REFUSALS.amountChanged(39.99, 40)])
      expect((await pressShown(failed.invoice, 40.004)).status).toBe(200)
    })
  })

  it("the card (review point 1): the subscription's default card in Stripe isn't the customer's saved card: refused, with words to finish the card replace first", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      // The replace saved the new card here, and its move of the subscription got no answer from Stripe.
      stripe.failNext('subscriptions.update', noAnswer())
      expect((await replaceCard(stripe)).data).toMatchObject({ membershipsMoved: 0, membershipsToMove: 1 })
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.defaultPaymentMethod).toBe(OLD_CARD)
      await refused(stripe, await pressShown(failed.invoice), [
        409,
        'CONFLICT',
        'card_not_moved',
        "This membership's subscription in Stripe isn't set to the customer's saved card, so the payment won't be tried: Stripe's own retries would still go to another card. Nothing was charged. Finish the card replace first: save the customer's card on the reader, wait until the membership's card change is off the Orders page list, then try the payment again.",
      ])
      // Past the window the automatic check moves the subscription; then the payment goes to the new card.
      pastTheWindow()
      await reconcileNow(stripe)
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.defaultPaymentMethod).toBe(NEW_CARD)
      expect((await pressShown(failed.invoice)).data).toMatchObject({ cardLast4: '1881', amountCharged: 40 })
      expect(pays(stripe).map((call) => (call.params as { payment_method: string }).payment_method)).toEqual([NEW_CARD])
    })
  })

  it("a subscription with no default card of its own in Stripe (it would fall back to the customer's): refused the same way", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      await stripe.subscriptions.update(MO_SUBSCRIPTION, { default_payment_method: '' })
      await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'card_not_moved', PAYMENT_RETRY_REFUSALS.cardNotMoved])
    })
  })

  it('the card is replaced between the press reading Stripe and its record: under the locks the saved card is no longer the one Stripe showed, so nothing is sent', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', async () => {
        await db.query("UPDATE customers SET saved_payment_method_id = $2, saved_card_last4 = '1881', saved_card_brand = 'mastercard' WHERE id = $1", [ID.member, NEW_CARD])
      })
      const answer = await pressShown(failed.invoice)
      replayStripe.current = stripe
      await refused(stripe, answer, [409, 'CONFLICT', 'card_not_moved', PAYMENT_RETRY_REFUSALS.cardNotMoved])
    })
  })

  it("a card step of the customer's open (the replace's send landed, its answer was lost) and then held past its window: refused each time, with the subscription already on the new card", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.failNext('subscriptions.update', { kind: 'lost_response' })
      expect((await replaceCard(stripe)).data).toMatchObject({ membershipsMoved: 0, membershipsToMove: 1 })
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.defaultPaymentMethod).toBe(NEW_CARD)
      const words =
        "The customer's card replace hasn't finished: a membership's move to the new card is still listed on the Orders page. Nothing was charged. Finish the card replace first: once that line is off the list, try the payment again."
      // Open, inside its window.
      await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'card_step_open', words])
      // Held: past its window, and no run has settled it yet.
      pastTheWindow()
      await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'card_step_open', words])
      // The run reads Stripe, finds the card moved and closes the step: the payment can be tried.
      await reconcileNow(stripe)
      expect((await pressShown(failed.invoice)).status).toBe(200)
    })
  })

  it("a card step left for a person (Stripe refused it), on ANOTHER of the customer's memberships: refused, though this membership's own subscription is on the new card", async () => {
    await onASeed(
      async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        // The replace moves Mo's first membership (the past-due one) and Stripe refuses the second's for good.
        stripe.failNext('subscriptions.update', { kind: 'none' })
        stripe.failNext('subscriptions.update', { kind: 'error', error: fakeStripeErrors.invalid('subscription_update_refused', 'This subscription cannot be updated right now.') })
        expect((await replaceCard(stripe)).data).toMatchObject({ membershipsMoved: 1, membershipsToMove: 1 })
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.defaultPaymentMethod).toBe(NEW_CARD)
        await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'card_step_open', PAYMENT_RETRY_REFUSALS.cardStepOpen])
        // Past the window the run sends it again, Stripe refuses again, and it is left for a person: still refused.
        pastTheWindow()
        stripe.failNext('subscriptions.update', { kind: 'error', error: fakeStripeErrors.invalid('subscription_update_refused', 'This subscription cannot be updated right now.') })
        await reconcileNow(stripe)
        expect((await stuckList(db)).steps).toMatchObject([{ membershipId: SECOND_MEMBERSHIP, step: 'payment_method', state: 'refused' }])
        await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'card_step_open', PAYMENT_RETRY_REFUSALS.cardStepOpen])
      },
      async (seedDb, stripe) => {
        await insert(seedDb, 'customer_memberships', { id: SECOND_MEMBERSHIP, customer_id: ID.member, plan_id: ID.plan, start_date: '2026-02-01', subscription_status: 'active', billing_frequency: 'monthly', stripe_subscription_id: SECOND_SUBSCRIPTION })
        stripe.addSubscription(SECOND_SUBSCRIPTION, MO_STRIPE, MONTHLY_PRICE)
      }
    )
  })

  it('taking turns (W40): a payment date change on hold on the membership; a cancel or undo step open on its subscription', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      const change = await insert(db, 'membership_payment_date_changes', { membership_id: ID.membership, old_renewal_date: '2026-11-10', new_renewal_date: '2026-11-15', extra_days: 5, amount_charged: '6.67', staff_id: ID.staff, status: 'pending' })
      await refused(stripe, await pressShown(failed.invoice), [
        409,
        'CONFLICT',
        'payment_date_changing',
        'A payment date change is on hold for this membership (it is listed on the Orders page). Nothing was charged. Try the payment again once that line is off the list.',
      ])
      await db.query("UPDATE membership_payment_date_changes SET status = 'failed' WHERE id = $1", [change])
      await db.transaction(async (tx) => {
        await tx.query('SELECT id FROM customer_memberships WHERE id = $1 FOR NO KEY UPDATE', [ID.membership])
        await leaveStep(tx, { membershipId: ID.membership, subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', want: { cancelAt: JAN_10 } }, { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID() })
      })
      expect((await audited(STEP_LEFT_ACTION)).length).toBe(1)
      await refused(stripe, await pressShown(failed.invoice), [
        409,
        'CONFLICT',
        'step_open',
        "The last change to this membership hasn't been confirmed by Stripe yet (it is listed on the Orders page). Nothing was charged. Try the payment again once it is off the list.",
      ])
    })
  })

  it("Stripe shows no invoice for the subscription, an invoice that isn't in pounds, or one with nothing left to pay: refused", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      /** The fake as the route reaches it, with one read's answer changed on the way back. */
      const altered = (resource: 'subscriptions' | 'invoices', change: Record<string, unknown>): StripeClient => {
        const real = stripe[resource] as unknown as Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>
        const wrapped = { ...real, retrieve: async (...args: unknown[]) => ({ ...(await (real['retrieve'] as (...a: unknown[]) => Promise<Record<string, unknown>>)(...args)), ...change }) }
        return new Proxy(stripe, { get: (target, prop) => (prop === resource ? wrapped : Reflect.get(target, prop)) }) as unknown as StripeClient
      }
      for (const [client, expected] of [
        [altered('subscriptions', { latest_invoice: null }), ['no_invoice', "Stripe shows no invoice for this membership's subscription, so there is nothing to try again. Nothing was charged. Tell a manager."]],
        [altered('invoices', { currency: 'usd' }), ['not_pounds', "Stripe's newest invoice for this membership isn't in pounds, so it can't be paid from here. Nothing was charged. Tell a manager."]],
        [altered('invoices', { amount_remaining: 0 }), ['nothing_to_pay', "Stripe's newest invoice for this membership has nothing left to pay. Nothing was charged."]],
      ] as const) {
        replayStripe.current = client
        const answer = await pressShown(failed.invoice)
        replayStripe.current = stripe
        await refused(stripe, answer, [409, 'CONFLICT', expected[0], expected[1]])
      }
    })
  })

  it("Stripe can't be read, can't find the subscription, or shows it as another customer's: refused, nothing sent; and a row that changes while Stripe is being read", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.failNext('subscriptions.retrieve', noAnswer())
      await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'not_read', "Stripe couldn't be asked about this membership just now, so the payment wasn't tried. Nothing was charged. Try again in a minute."])
      stripe.failNext('invoices.retrieve', noAnswer())
      await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'not_read', PAYMENT_RETRY_REFUSALS.notRead])
      stripe.failNext('subscriptions.retrieve', { kind: 'error', error: fakeStripeErrors.missing(`subscription: '${MO_SUBSCRIPTION}'`) })
      await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'subscription_missing', PAYMENT_RETRY_REFUSALS.subscriptionMissing])
      await db.query("UPDATE customers SET stripe_customer_id = 'cus_someone_else' WHERE id = $1", [ID.member])
      await refused(stripe, await pressShown(failed.invoice), [409, 'CONFLICT', 'customer_mismatch', PAYMENT_RETRY_REFUSALS.customerMismatch])
      await db.query('UPDATE customers SET stripe_customer_id = $2 WHERE id = $1', [ID.member, MO_STRIPE])
      // The row is given another subscription between the press's read of Stripe and its record.
      replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', async () => {
        await db.query("UPDATE customer_memberships SET stripe_subscription_id = 'sub_another' WHERE id = $1", [ID.membership])
      })
      const answer = await pressShown(failed.invoice)
      replayStripe.current = stripe
      await refused(stripe, answer, [409, 'CONFLICT', 'changed_since', PAYMENT_RETRY_REFUSALS.changedSince])
    })
  })
})

describe("through the staff app's own thin wrappers and the real routes (brief item 5)", () => {
  const quoteWrapper = (membershipId: string = ID.membership) => throughStaffApp('getMembershipRetryPaymentQuote')(db, { membershipId })
  const pressWrapper = (params: Record<string, unknown>) => {
    vi.setSystemTime(Date.now() + 1000)
    return throughStaffApp('retryMembershipPayment')(db, { membershipId: ID.membership, idempotencyKey: crypto.randomUUID(), ...params })
  }

  it('the window reads the quote, the press sends back what it showed, and each answer comes back in the shape the window reads: paid, the amount changed, declined', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      const shown = (await quoteWrapper()) as { ok: boolean; invoiceId: string; amount: number; paymentMethodId: string }
      expect(shown).toMatchObject({ ok: true, refusal: null, invoiceId: failed.invoice, amount: 40, cardBrand: 'visa', cardLast4: '4444', paymentMethodId: OLD_CARD, bookingsWaiting: 2 })
      expect(await quoteWrapper('10000000-0000-4000-8000-00000000ffff')).toBeNull()
      expect(await quoteWrapper('')).toBeNull()
      // The amount changed since the window: nothing charged, the Worker's amount now.
      expect(await pressWrapper({ confirmedInvoiceId: shown.invoiceId, confirmedAmount: 45, confirmedPaymentMethodId: shown.paymentMethodId })).toEqual({
        paid: false,
        reason: 'amount_changed',
        message: 'The amount to pay is now £40.00, not the £45.00 shown. Nothing was charged. Check the new amount with the customer and press again.',
        amountNow: 40,
      })
      stripe.declineCard(OLD_CARD)
      const asShown = { confirmedInvoiceId: shown.invoiceId, confirmedAmount: shown.amount, confirmedPaymentMethodId: shown.paymentMethodId }
      expect(await pressWrapper(asShown)).toEqual({ paid: false, reason: 'payment_failed', message: PAYMENT_RETRY_WORDS.declined('Your card was declined') })
      // W47r-a (S3): the wrapper carries the card; without it the press is refused, and another card than the saved one too.
      expect(await pressWrapper({ confirmedInvoiceId: shown.invoiceId, confirmedAmount: shown.amount })).toEqual({ paid: false, reason: 'amount_not_confirmed', message: PAYMENT_RETRY_REFUSALS.figureMissing })
      expect(await pressWrapper({ ...asShown, confirmedPaymentMethodId: NEW_CARD })).toEqual({ paid: false, reason: 'card_changed', message: PAYMENT_RETRY_REFUSALS.cardChanged })
      stripe.declineCard(OLD_CARD, false)
      expect(await pressWrapper(asShown)).toEqual({
        paid: true,
        message: '£40.00 was taken on the Visa card ending 4444. The membership is active again and its next payment is on 10 Jan 2027. 2 bookings that were waiting for payment are confirmed again.',
        amountCharged: 40,
        alreadyPaid: false,
        membershipUpdated: true,
        bookingsRestored: 2,
        nextRenewalDate: '2027-01-10',
      })
      expect(stripe.netPence).toBe(4000)
      // The stuck list's wrapper carries the held retries' field (empty here).
      expect(await throughStaffApp('getStuckReaderPayments')(db, {})).toMatchObject({ paymentRetries: [] })
    })
  })

  it('a payment with no clear answer comes back `held`, and the Orders page lists it through the stuck list wrapper; a press without the window\'s figures is refused', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      expect(await pressWrapper({})).toEqual({ paid: false, reason: 'amount_not_confirmed', message: PAYMENT_RETRY_REFUSALS.figureMissing })
      stripe.failNext('invoices.pay', noAnswer())
      expect(await pressWrapper({ confirmedInvoiceId: failed.invoice, confirmedAmount: 40, confirmedPaymentMethodId: OLD_CARD })).toEqual({ paid: false, reason: 'payment_unconfirmed', message: PAYMENT_RETRY_WORDS.held, held: true })
      pastTheWindow()
      const list = (await throughStaffApp('getStuckReaderPayments')(db, {})) as { paymentRetries: Array<Record<string, unknown>> }
      expect(list.paymentRetries).toMatchObject([{ membershipId: ID.membership, customerName: 'Mo Member', invoiceId: failed.invoice, amount: 40, cardLast4: '4444', reason: 'waiting', words: PAYMENT_RETRY_STUCK_WORDS['waiting'] }])
      expect(list.paymentRetries[0] && 'close' in list.paymentRetries[0]).toBe(false)
    })
  })

  it("W47r-a (S1): a payment taken after the subscription ended comes back `held` in the Worker's words; the Orders page's list carries its Mark refunded; the close wrapper reaches the Worker, which refuses until Stripe shows the refund", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', () => stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' }))
      const answer = await pressWrapper({ confirmedInvoiceId: failed.invoice, confirmedAmount: 40, confirmedPaymentMethodId: OLD_CARD })
      replayStripe.current = stripe
      expect(answer).toEqual({ paid: false, reason: 'paid_after_end', message: PAYMENT_RETRY_WORDS.paidAfterEndAtThePress(40, '4444'), held: true })
      const stuck = async () => ((await throughStaffApp('getStuckReaderPayments')(db, {})) as { paymentRetries: Array<{ retryId: string; close?: { kind: string; orderId: string } }> }).paymentRetries
      const [line] = await stuck()
      expect(line).toMatchObject({ reason: 'paid_after_end', words: PAYMENT_RETRY_WORDS.paidAfterEnd(40, '4444'), close: { kind: 'retry_paid_after_end', orderId: line?.retryId } })
      const close = () => {
        vi.setSystemTime(Date.now() + 1000)
        return throughStaffApp('closeStuckOrder')(db, { ...line?.close, reason: 'Refunded in Stripe by the manager', idempotencyKey: crypto.randomUUID() })
      }
      expect(await close()).toMatchObject({ closed: false, kind: 'retry_paid_after_end', reason: 'not_refunded', message: 'Stripe shows none of the £40.00 refunded. Nothing was changed. Refund it in Stripe, then press Mark refunded again.' })
      await stripe.refunds.create({ payment_intent: stripe.invoiceState(failed.invoice).paymentIntent as string })
      expect(await close()).toEqual({ closed: true, kind: 'retry_paid_after_end', orderId: line?.retryId, message: 'Marked as refunded: Stripe shows the £40.00 refunded in full. It is no longer listed.' })
      expect(await stuck()).toEqual([])
    })
  })

  it('switched off: the window shows the "switched off" words in place of an amount, and a press answers them too', async () => {
    await onASeed(
      async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        expect(await quoteWrapper()).toEqual({ ok: false, problem: 'This is switched off in the booking system. Tell a manager.' })
        expect(await pressWrapper({ confirmedInvoiceId: failed.invoice, confirmedAmount: 40, confirmedPaymentMethodId: OLD_CARD })).toEqual({ paid: false, reason: 'membership_path_off', message: 'This is switched off in the booking system. Tell a manager.' })
        expect(pays(stripe)).toEqual([])
      },
      undefined,
      'no_stripe,saved_card,reader,membership,booking_changes,reader_flows,order_refunds,event_cancels,membership_changes,payment_date_changes,card_moves,lapse_sweep'
    )
  })
})

describe("W47r-a S1 (the W47r review): money taken after the subscription ended is held for a person, never closed as paid", () => {
  const AFTER_END_LISTED = "£40.00 was taken on the card ending 4444 after this membership's subscription had ended. Refund it in Stripe (tell a manager), then press Mark refunded."
  const AFTER_END_PRESS = "£40.00 was taken on the card ending 4444 after this membership's subscription had ended. Refund it in Stripe (tell a manager), then press Mark refunded on the Orders page."

  it("the reviewer's P1, turned round: Stripe cancels the subscription between the press reading it and the charge. £40 is taken; the record stays open, held `paid_after_end`; it is listed at once with Mark refunded; the press says so", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      // The press's read of the invoice is answered, then Stripe's own dunning (or a manager) cancels the subscription.
      replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', () => stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' }))
      const answer = await pressShown(failed.invoice)
      replayStripe.current = stripe
      expect(stripe.netPence).toBe(4000)
      expect(pays(stripe)).toHaveLength(1)
      expect(refusalOf(answer)).toEqual([502, 'PAYMENT_UNCONFIRMED', 'paid_after_end', AFTER_END_PRESS])
      const rows = await retryRows()
      const retryId = rows[0]?.details['retryId'] as string
      expect(answer.error?.details).toMatchObject({ action: 'payment_retry', held: { retryId } })
      // Open: `started` and a `held` note, no ending. Until W47r-a this read ['started', 'paid'].
      expect(rows.map((row) => row.details['state'])).toEqual(['started', 'held'])
      expect(rows[1]?.details).toMatchObject({ reason: 'paid_after_end', detail: `invoice ${failed.invoice} is paid; Stripe shows the subscription as canceled` })
      // Nothing was written to the membership: still past due, its bookings still waiting.
      expect(await membership()).toEqual({ status: 'past_due', renews: '2026-12-10' })
      expect((await booking(failed.fifteenth))?.status).toBe('payment_needed')

      // Listed straight away (no window to wait out), in the brief's words, with its one close.
      const list = await stuckList(db)
      expect(stuckListOutputSchema.safeParse(list).success).toBe(true)
      expect(list.paymentRetries).toEqual([
        {
          retryId,
          membershipId: ID.membership,
          customerId: ID.member,
          customerName: 'Mo Member',
          invoiceId: failed.invoice,
          amount: 40,
          cardBrand: 'visa',
          cardLast4: '4444',
          createdAt: expect.any(String),
          ageMinutes: 0,
          reason: 'paid_after_end',
          words: AFTER_END_LISTED,
          close: { kind: 'retry_paid_after_end', orderId: retryId },
          // W47r-d, a named difference: the line's second close, Mark as owed.
          closeOwed: { kind: 'paid_after_end_owed', orderId: retryId },
        },
      ])
      // The run (it has a `held` row, so it is read at once) leaves it for a person, sends nothing and never ends it.
      const before = stripe.calls.length
      expect(await retryItems(stripe)).toEqual([{ kind: 'payment_retry', id: retryId, outcome: 'left', reason: 'paid_after_end', detail: `invoice ${failed.invoice} is paid; Stripe shows the subscription as canceled` }])
      pastTheWindow()
      expect(await retryItems(stripe)).toMatchObject([{ id: retryId, outcome: 'left', reason: 'paid_after_end' }])
      expect(writesSince(stripe, before)).toEqual([])
      // The note is on the record once, however many runs read it.
      expect(await states()).toEqual(['started', 'held'])
      expect((await listed())[0]).toMatchObject({ reason: 'paid_after_end', words: AFTER_END_LISTED, close: { kind: 'retry_paid_after_end', orderId: retryId } })
      // A new press is refused before anything is sent: Stripe shows the subscription cancelled.
      expect(refusalOf(await pressShown(failed.invoice))).toEqual([409, 'CONFLICT', 'subscription_cancelled', PAYMENT_RETRY_REFUSALS.stripeCancelled])
      expect(pays(stripe)).toHaveLength(1)
    })
  })

  it('Mark refunded reads the refunds in Stripe first: refused with nothing refunded, with part refunded, and with the rest still on its way; allowed once Stripe shows it all refunded; it sends nothing, and needs Issue refunds', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', () => stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' }))
      const answer = await pressShown(failed.invoice)
      replayStripe.current = stripe
      const retryId = answer.error?.details?.held?.retryId as string
      const payment = stripe.invoiceState(failed.invoice).paymentIntent as string
      const closedRows = async () => (await audited('order.close')).filter((row) => row.entity_id === retryId)

      // No Issue refunds: the route refuses before anything is read.
      const calls = stripe.calls.length
      expect((await markRefunded(retryId, { email: NO_REFUNDS })).status).toBe(403)
      expect(stripe.calls.slice(calls)).toEqual([])

      // Nothing refunded yet: refused, and the only calls are reads.
      const first = await markRefunded(retryId)
      expect(first.status).toBe(200)
      expect(first.data).toEqual({
        kind: 'retry_paid_after_end',
        orderId: retryId,
        closed: false,
        reason: 'not_refunded',
        message: 'Stripe shows none of the £40.00 refunded. Nothing was changed. Refund it in Stripe, then press Mark refunded again.',
      })
      expect(stripe.calls.slice(calls).map((call) => call.method)).toEqual(['invoices.retrieve', 'paymentIntents.retrieve', 'refunds.list'])
      expect(await states()).toEqual(['started', 'held'])
      expect(await closedRows()).toEqual([])

      // The manager refunds £15 of it in Stripe: still refused.
      await stripe.refunds.create({ payment_intent: payment, amount: 1500 })
      expect((await markRefunded(retryId)).data).toMatchObject({
        closed: false,
        reason: 'not_refunded',
        message: 'Stripe shows only £15.00 of the £40.00 refunded. Nothing was changed. Refund the rest in Stripe, then press Mark refunded again.',
      })
      // The other £25, which Stripe answers `pending`: not money back yet, so still refused.
      stripe.refundsStayPending = true
      const rest = await stripe.refunds.create({ payment_intent: payment, amount: 2500 })
      stripe.refundsStayPending = false
      expect((await markRefunded(retryId)).data).toMatchObject({
        closed: false,
        reason: 'not_refunded',
        message: 'Stripe shows only £15.00 of the £40.00 refunded, with a refund of £25.00 still on its way. Nothing was changed. Press Mark refunded again once Stripe shows the refund as succeeded.',
      })
      // Stripe can't be read: refused, nothing concluded.
      stripe.failNext('refunds.list', noAnswer())
      expect((await markRefunded(retryId)).data).toMatchObject({ closed: false, reason: 'refunds_not_read', message: PAYMENT_RETRY_CLOSE_WORDS.notRead })
      expect(await states()).toEqual(['started', 'held'])
      expect((await listed())[0]).toMatchObject({ retryId, reason: 'paid_after_end' })

      // The refund succeeds: Stripe shows the whole £40 back. Now it is marked, and nothing was sent by any press.
      stripe.settleRefund(rest.id, 'succeeded')
      expect(stripe.netPence).toBe(0)
      const sends = stripe.calls.length
      const key = crypto.randomUUID()
      const done = await markRefunded(retryId, { key })
      expect(done.data).toEqual({ kind: 'retry_paid_after_end', orderId: retryId, closed: true, message: 'Marked as refunded: Stripe shows the £40.00 refunded in full. It is no longer listed.' })
      expect(writesSince(stripe, sends)).toEqual([])
      const rows = await retryRows()
      expect(rows.map((row) => row.details['state'])).toEqual(['started', 'held', 'refunded'])
      expect(rows[2]).toMatchObject({ actor_type: 'staff', details: { how: 'close', why: 'Refunded in Stripe by the manager', invoiceId: failed.invoice, taken: 40, refunded: 40 } })
      expect(await closedRows()).toMatchObject([{ entity_type: 'payment_retry', details: { kind: 'retry_paid_after_end', why: 'Refunded in Stripe by the manager', membershipId: ID.membership, taken: 40, refunded: 40 } }])
      // Ended: off the list, nothing for a run, and a second press (a new key, or the same one) changes nothing.
      expect(await listed()).toEqual([])
      expect(await retryItems(stripe)).toEqual([])
      expect((await markRefunded(retryId)).data).toMatchObject({ closed: true, alreadyClosed: true, message: PAYMENT_RETRY_CLOSE_WORDS.already })
      expect((await markRefunded(retryId, { key })).data).toMatchObject({ closed: true, message: 'Marked as refunded: Stripe shows the £40.00 refunded in full. It is no longer listed.' })
      expect(await states()).toEqual(['started', 'held', 'refunded'])
      expect(await closedRows()).toHaveLength(1)
      // A retry that was never recorded: not listed.
      expect((await markRefunded(crypto.randomUUID())).data).toMatchObject({ closed: false, reason: 'not_listed', message: PAYMENT_RETRY_CLOSE_WORDS.notListed })
      expect(await membership()).toMatchObject({ status: 'past_due' })
    })
  })

  it('the reconcile path: a retry held waiting on the customer, the subscription cancelled by Stripe, then the customer approves and the invoice is paid: the run holds it `paid_after_end` (one note on the record), it is listed with Mark refunded, and is never ended as paid', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.nextPayEnds(failed.invoice, 'requires_action')
      const answer = await pressShown(failed.invoice)
      expect(answer.error?.details?.reason).toBe('payment_needs_action')
      const retryId = answer.error?.details?.held?.retryId as string
      pastTheWindow()
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'left', reason: 'payment_needs_action' }])
      expect((await listed())[0] && 'close' in ((await listed())[0] as object)).toBe(false)
      // Stripe's dunning cancels the subscription; later the customer approves the payment on the open invoice.
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      stripe.settleInvoicePayment(failed.invoice, 'succeeded')
      expect(stripe.netPence).toBe(4000)
      const before = stripe.calls.length
      expect(await retryItems(stripe)).toEqual([{ kind: 'payment_retry', id: retryId, outcome: 'left', reason: 'paid_after_end', detail: `invoice ${failed.invoice} is paid; Stripe shows the subscription as canceled` }])
      expect(writesSince(stripe, before)).toEqual([])
      const rows = await retryRows()
      expect(rows.map((row) => row.details['state'])).toEqual(['started', 'held', 'held'])
      expect(rows[2]).toMatchObject({ actor_type: 'system', details: { reason: 'paid_after_end', how: 'reconcile' } })
      // Another run: left again, and no second note.
      expect(await retryItems(stripe)).toMatchObject([{ id: retryId, outcome: 'left', reason: 'paid_after_end' }])
      expect(await states()).toEqual(['started', 'held', 'held'])
      expect(await membership()).toMatchObject({ status: 'past_due' })
      expect(await listed()).toMatchObject([{ retryId, reason: 'paid_after_end', words: AFTER_END_LISTED, close: { kind: 'retry_paid_after_end', orderId: retryId } }])
      // A run that can't read Stripe leaves it `unclear`; the list still says what it is, with its close.
      stripe.failNext('invoices.retrieve', noAnswer())
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'left', reason: 'unclear' }])
      expect(await listed()).toMatchObject([{ retryId, reason: 'paid_after_end', close: { kind: 'retry_paid_after_end', orderId: retryId } }])
      // Refunded in Stripe, then Mark refunded.
      expect((await markRefunded(retryId)).data).toMatchObject({ closed: false, reason: 'not_refunded' })
      await stripe.refunds.create({ payment_intent: stripe.invoiceState(failed.invoice).paymentIntent as string })
      expect((await markRefunded(retryId)).data).toMatchObject({ closed: true })
      expect(await states()).toEqual(['started', 'held', 'held', 'refunded'])
      expect(await listed()).toEqual([])
      expect(await retryItems(stripe)).toEqual([])
      expect(stripe.netPence).toBe(0)
    })
  })

  it('the membership ended here (its row cancelled) while the payment was being taken, and a membership that no longer has the subscription: held the same way; `incomplete_expired` too', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      // The row is cancelled here after the record is written (while the send is at Stripe).
      replayStripe.current = withAChangeAfter(stripe, 'invoices', 'pay', async () => {
        await db.query("UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE id = $1", [ID.membership])
      })
      const answer = await pressShown(failed.invoice)
      replayStripe.current = stripe
      // W47r-b (W47r-a "Noticed" 2): Stripe's subscription is still live here (the write got as far as the row), so the
      // words add checking it, at the press and on the list; the record's `held` row says which case it is.
      expect(refusalOf(answer)).toEqual([
        502,
        'PAYMENT_UNCONFIRMED',
        'paid_after_end',
        '£40.00 was taken on the card ending 4444 after this membership had ended here. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded on the Orders page.',
      ])
      expect((await retryRows())[1]?.details).toMatchObject({ reason: 'paid_after_end', cancelledHere: true, detail: `invoice ${failed.invoice} is paid; the membership here has ended` })
      expect(await listed()).toMatchObject([
        {
          reason: 'paid_after_end',
          words: '£40.00 was taken on the card ending 4444 after this membership had ended here. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded.',
          close: { kind: 'retry_paid_after_end' },
        },
      ])
      expect(stripe.netPence).toBe(4000)
    })
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      replayStripe.current = withAChangeAfter(stripe, 'invoices', 'pay', async () => {
        await db.query("UPDATE customer_memberships SET stripe_subscription_id = 'sub_another' WHERE id = $1", [ID.membership])
      })
      const answer = await pressShown(failed.invoice)
      replayStripe.current = stripe
      expect(refusalOf(answer)).toEqual([502, 'PAYMENT_UNCONFIRMED', 'paid_after_end', AFTER_END_PRESS])
      const held = (await retryRows())[1]?.details ?? {}
      expect(held).toMatchObject({ reason: 'paid_after_end', detail: `invoice ${failed.invoice} is paid; no membership here has the subscription any more` })
      // Only a row cancelled here is told to check the subscription.
      expect('cancelledHere' in held).toBe(false)
    })
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', () => stripe.setSubscription(MO_SUBSCRIPTION, { status: 'incomplete_expired' }))
      const answer = await pressShown(failed.invoice)
      replayStripe.current = stripe
      expect(refusalOf(answer)).toEqual([502, 'PAYMENT_UNCONFIRMED', 'paid_after_end', AFTER_END_PRESS])
    })
  })

  it("Stripe hasn't caught up (the subscription still reads past due straight after its invoice is paid): not money to give back. The record ends paid, with words that say Stripe's notice will bring the membership up to date", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      replayStripe.current = withAChangeAfter(stripe, 'invoices', 'pay', () => stripe.setSubscription(MO_SUBSCRIPTION, { status: 'past_due' }))
      const answer = await pressShown(failed.invoice)
      replayStripe.current = stripe
      expect(answer.status).toBe(200)
      expect(answer.data).toMatchObject({
        membershipUpdated: false,
        amountCharged: 40,
        message:
          "£40.00 was taken on the Visa card ending 4444. The membership here was not changed: Stripe hasn't shown the subscription as paid up yet; the membership is brought up to date when Stripe's notice arrives. Look again in a few minutes.",
      })
      expect(await states()).toEqual(['started', 'paid'])
      expect(await listed()).toEqual([])
    })
  })
})

describe('W47r-a S2 (the W47r review): a paid retry is recorded fast, and its booking does not lapse in the gap', () => {
  it("the reviewer's P2, turned round: paid at the press at 13:55 with the write failed; the 14:00 deadline passes; the sweep leaves the booking (`payment_retry_held`); the run straight after records the payment without waiting for the window, and the booking is confirmed", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      expect((await booking(failed.fifteenth))?.due).toMatch(/^2026-12-13 14:00:00/)
      vi.setSystemTime(new Date('2026-12-13T13:55:00.000Z'))
      stripe.failNext('subscriptions.retrieve', { kind: 'none' })
      stripe.failNext('subscriptions.retrieve', noAnswer())
      const answer = await pressShown(failed.invoice)
      expect(refusalOf(answer)).toEqual([502, 'PAYMENT_UNCONFIRMED', 'paid_not_recorded', PAYMENT_RETRY_WORDS.paidNotRecorded])
      const retryId = answer.error?.details?.held?.retryId as string
      expect(stripe.netPence).toBe(4000)
      // 14:01: the booking's deadline has passed, the retry is six minutes old (inside the window), nothing is recorded yet.
      vi.setSystemTime(new Date('2026-12-13T14:01:00.000Z'))
      const sweep = await sweepNow()
      expect(sweep).toMatchObject({ ran: true, lapsed: 0, failed: 0 })
      expect(sweep.items).toContainEqual({ bookingId: failed.fifteenth, outcome: 'left', reason: 'payment_retry_held' })
      expect((await booking(failed.fifteenth))?.status).toBe('payment_needed')
      // The same scheduled run's reconcile: the record has its `held` row, so it is read now, not at 14:10.
      expect(await retryItems(stripe)).toEqual([{ kind: 'payment_retry', id: retryId, outcome: 'finalised', detail: `invoice ${failed.invoice} is paid; the membership was marked paid` }])
      expect(await states()).toEqual(['started', 'held', 'paid'])
      expect(await membership()).toEqual({ status: 'active', renews: '2027-01-10' })
      expect(await booking(failed.fifteenth)).toEqual({ status: 'confirmed', due: null })
      // The next sweep has nothing of Mo's.
      expect((await sweepNow()).items.filter((item) => item.bookingId === failed.fifteenth)).toEqual([])
      expect(await booking(failed.fifteenth)).toEqual({ status: 'confirmed', due: null })
      expect(pays(stripe)).toHaveLength(1)
      expect(stripe.netPence).toBe(4000)
    })
  })

  it('the hour: a retry held waiting on the customer keeps the booking from lapsing while it is younger than an hour, and not after: two hours old, the booking lapses as it always did', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      // 13:30 on the 13th: the press is left waiting on the customer's approval (nothing taken).
      vi.setSystemTime(new Date('2026-12-13T13:30:00.000Z'))
      stripe.nextPayEnds(failed.invoice, 'requires_action')
      expect((await pressShown(failed.invoice)).error?.details?.reason).toBe('payment_needs_action')
      // 14:01: the deadline has passed and the retry is 31 minutes old: left.
      vi.setSystemTime(new Date('2026-12-13T14:01:00.000Z'))
      expect((await sweepNow()).items).toContainEqual({ bookingId: failed.fifteenth, outcome: 'left', reason: 'payment_retry_held' })
      expect((await booking(failed.fifteenth))?.status).toBe('payment_needed')
      // 14:29: 59 minutes old: still left.
      vi.setSystemTime(new Date('2026-12-13T14:29:00.000Z'))
      expect((await sweepNow()).items).toContainEqual({ bookingId: failed.fifteenth, outcome: 'left', reason: 'payment_retry_held' })
      // 15:31: two hours old and still open (a run has left it, payment_needs_action): the booking lapses.
      vi.setSystemTime(new Date('2026-12-13T15:31:00.000Z'))
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'left', reason: 'payment_needs_action' }])
      expect(await states()).toEqual(['started', 'held'])
      const sweep = await sweepNow()
      expect(sweep.items).toContainEqual(expect.objectContaining({ bookingId: failed.fifteenth, outcome: 'lapsed' }))
      expect((await booking(failed.fifteenth))?.status).toBe('cancelled')
      expect(stripe.netPence).toBe(0)
      // The hour is the one the banner's line for Stripe's notices uses.
      expect(PAYMENT_RETRY_HOLDS_LAPSE_MINUTES).toBe(WEBHOOK_ERROR_MINUTES)
      expect(PAYMENT_RETRY_HOLDS_LAPSE_MINUTES).toBe(60)
    })
  })

  it('only an open retry holds the sweep off: one that ended declined three minutes ago does not', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      vi.setSystemTime(new Date('2026-12-13T13:58:00.000Z'))
      stripe.declineCard(OLD_CARD)
      expect((await pressShown(failed.invoice)).error?.code).toBe('PAYMENT_FAILED')
      expect(await states()).toEqual(['started', 'declined'])
      vi.setSystemTime(new Date('2026-12-13T14:01:00.000Z'))
      expect((await sweepNow()).items).toContainEqual(expect.objectContaining({ bookingId: failed.fifteenth, outcome: 'lapsed' }))
      expect((await booking(failed.fifteenth))?.status).toBe('cancelled')
    })
  })

  it('inside the window a run records a payment it finds paid, and never ends a record as not taken; a record with no `held` row (its press may still be running) is not read until the window has passed', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      // No clear answer, and the send has not landed: held. A minute later a run reads "nothing taken", and leaves it.
      stripe.failNext('invoices.pay', noAnswer())
      const answer = await pressShown(failed.invoice)
      const retryId = answer.error?.details?.held?.retryId as string
      vi.setSystemTime(Date.now() + 60_000)
      expect(await retryItems(stripe)).toMatchObject([{ id: retryId, outcome: 'left', reason: 'waiting' }])
      expect(await states()).toEqual(['started', 'held'])
      // The send lands late (three minutes in). The next run finds the invoice paid and records it, inside the window.
      vi.setSystemTime(Date.now() + 120_000)
      stripe.stripeRetryPays(failed.invoice)
      expect(await retryItems(stripe)).toMatchObject([{ id: retryId, outcome: 'finalised' }])
      expect(await states()).toEqual(['started', 'held', 'paid'])
      expect(await membership()).toEqual({ status: 'active', renews: '2027-01-10' })
      expect(stripe.netPence).toBe(4000)
    })
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      // Held with nothing taken, and nothing lands: left inside the window, ended as not taken only past it.
      stripe.failNext('invoices.pay', noAnswer())
      await pressShown(failed.invoice)
      vi.setSystemTime(Date.now() + 14 * 60_000)
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'left', reason: 'waiting' }])
      vi.setSystemTime(Date.now() + 2 * 60_000)
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'undone' }])
      expect(await states()).toEqual(['started', 'held', 'not_taken'])
    })
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      // No `held` row: the press never got to say (the Worker died at the send, after it landed).
      const dying = dyingAtThePay(stripe, true)
      replayStripe.current = dying.client
      void pressShown(failed.invoice)
      await dying.reached
      replayStripe.current = stripe
      expect(await states()).toEqual(['started'])
      vi.setSystemTime(Date.now() + 14 * 60_000)
      expect(await retryItems(stripe)).toEqual([])
      expect(await listed()).toEqual([])
      vi.setSystemTime(Date.now() + 2 * 60_000)
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'finalised' }])
    })
  })
})

describe('W47r-a S3 (the W47r review): the press confirms the card the window showed', () => {
  it("Fran's window shows the Visa ending 4444; a second desk saves Mo's Mastercard and its move goes through; Fran's press is refused `card_changed`, nothing is sent and no record is opened; a window opened again charges the new card", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      const shown = (await quote()).data as { invoiceId: string; amount: number; paymentMethodId: string; cardLast4: string }
      expect(shown).toMatchObject({ paymentMethodId: OLD_CARD, cardLast4: '4444', refusal: null })
      // The second desk: the card is replaced and the subscription moved to it (no step left open).
      expect((await replaceCard(stripe)).status).toBe(200)
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.defaultPaymentMethod).toBe(NEW_CARD)
      const before = stripe.calls.length
      const answer = await press({ confirmed: { invoiceId: shown.invoiceId, amount: shown.amount, paymentMethodId: shown.paymentMethodId } })
      expect(refusalOf(answer)).toEqual([409, 'CONFLICT', 'card_changed', "The customer's saved card has changed since this window opened. Nothing was charged. Close this and open it again."])
      expect(writesSince(stripe, before)).toEqual([])
      expect(pays(stripe)).toEqual([])
      expect(await retryRows()).toEqual([])
      expect(stripe.netPence).toBe(0)
      // Opened again: the window names the Mastercard, and the press charges it.
      const again = (await quote()).data as { invoiceId: string; amount: number; paymentMethodId: string }
      expect(again).toMatchObject({ paymentMethodId: NEW_CARD, cardLast4: '1881' })
      const paid = await press({ confirmed: { invoiceId: again.invoiceId, amount: again.amount, paymentMethodId: again.paymentMethodId } })
      expect(paid.status).toBe(200)
      expect(pays(stripe)).toHaveLength(1)
      expect(pays(stripe)[0]?.params).toMatchObject({ payment_method: NEW_CARD })
      expect((await retryRows())[0]?.details).toMatchObject({ paymentMethodId: NEW_CARD, shown: { invoiceId: failed.invoice, amount: 40, paymentMethodId: NEW_CARD } })
      expect(stripe.netPence).toBe(4000)
    })
  })

  it("the whole card replace lands after the press has read the membership's row and before it reads Stripe: under the lock the saved card is the Mastercard, not the Visa the window named, so nothing is charged (the card is checked against the row as it is under the lock)", async () => {
    await onASeed(async (stripe) => {
      await renewalHasFailed(stripe)
      const shown = (await quote()).data as { invoiceId: string; amount: number; paymentMethodId: string }
      expect(shown.paymentMethodId).toBe(OLD_CARD)
      // Before the press's first Stripe read is answered: the second desk's replace is saved here and has gone through in Stripe.
      let landed = false
      const subscriptions = {
        ...stripe.subscriptions,
        retrieve: async (...args: Parameters<StripeClient['subscriptions']['retrieve']>) => {
          if (!landed) {
            landed = true
            await db.query("UPDATE customers SET saved_payment_method_id = $2, saved_card_last4 = '1881', saved_card_brand = 'mastercard' WHERE id = $1", [ID.member, NEW_CARD])
            await stripe.subscriptions.update(MO_SUBSCRIPTION, { default_payment_method: NEW_CARD })
          }
          return stripe.subscriptions.retrieve(...args)
        },
      }
      replayStripe.current = new Proxy(stripe, { get: (target, prop) => (prop === 'subscriptions' ? subscriptions : Reflect.get(target, prop)) }) as unknown as StripeClient
      const answer = await press({ confirmed: { invoiceId: shown.invoiceId, amount: shown.amount, paymentMethodId: shown.paymentMethodId } })
      replayStripe.current = stripe
      expect(landed).toBe(true)
      expect(refusalOf(answer)).toEqual([409, 'CONFLICT', 'card_changed', PAYMENT_RETRY_REFUSALS.cardChanged])
      expect(pays(stripe)).toEqual([])
      expect(await retryRows()).toEqual([])
      expect(stripe.netPence).toBe(0)
    })
  })
})

describe('W47r-a S4, L1 (the W47r review): the words', () => {
  it("authentication needed no longer offers paying online; Stripe's plain decline is said once, any other decline in Stripe's words; the paid-write sentences by status; the held line's way out", () => {
    expect(PAYMENT_RETRY_WORDS.authenticationRequired).toBe(
      "The card needs the customer to approve the payment with their bank, which can't be done from here. Nothing was charged and the membership is still overdue. Stripe's own retries carry on, and the bookings waiting for payment keep the deadline they had. Ask the customer for another card and save it on the reader, then try again."
    )
    expect(PAYMENT_RETRY_WORDS.authenticationRequired).not.toMatch(/online/)
    expect(PAYMENT_RETRY_WORDS.declined('Your card was declined')).toBe(
      "The card was declined. Nothing was charged and the membership is still overdue. Stripe's own retries carry on, and the bookings waiting for payment keep the deadline they had."
    )
    expect(PAYMENT_RETRY_WORDS.declined('Your card has insufficient funds')).toBe(
      "The card was declined: Your card has insufficient funds. Nothing was charged and the membership is still overdue. Stripe's own retries carry on, and the bookings waiting for payment keep the deadline they had."
    )
    const notPaidUp = PAYMENT_RETRY_WORDS.notUpdated.subscription_not_paid_up
    expect(notPaidUp('past_due')).toBe("Stripe hasn't shown the subscription as paid up yet; the membership is brought up to date when Stripe's notice arrives. Look again in a few minutes.")
    for (const ended of ['canceled', 'incomplete_expired']) {
      expect(notPaidUp(ended)).toBe('Stripe shows its subscription has ended, so the payment Stripe took for it has nothing to pay for. Refund it in Stripe (tell a manager).')
    }
    expect(notPaidUp('paused')).toBe('Stripe still shows its subscription as paused. Tell a manager.')
    expect(PAYMENT_RETRY_WORDS.paidAfterEnd(40, '4444')).toBe("£40.00 was taken on the card ending 4444 after this membership's subscription had ended. Refund it in Stripe (tell a manager), then press Mark refunded.")
    expect(PAYMENT_RETRY_WORDS.paidAfterEnd(40, null)).toBe("£40.00 was taken on the saved card after this membership's subscription had ended. Refund it in Stripe (tell a manager), then press Mark refunded.")
    expect(PAYMENT_RETRY_STUCK_WORDS['payment_needs_action']).toContain(
      'If Stripe has ended the subscription, the payment stays waiting: a manager voids the invoice in Stripe, and the automatic check then ends this as not taken.'
    )
  })

  it("a decline in Stripe's own words is still said in full", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.failNext('invoices.pay', { kind: 'error', error: Object.assign(fakeStripeErrors.cardDeclined(), { message: 'Your card has insufficient funds.' }) })
      expect(refusalOf(await pressShown(failed.invoice))).toEqual([402, 'PAYMENT_FAILED', 'payment_failed', PAYMENT_RETRY_WORDS.declined('Your card has insufficient funds')])
    })
  })

  it("L1: a retry held waiting on the customer, whose subscription Stripe has ended, is ended as not taken once a manager voids the invoice (which cancels its payment)", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.nextPayEnds(failed.invoice, 'requires_action')
      await pressShown(failed.invoice)
      pastTheWindow()
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'left', reason: 'payment_needs_action' }])
      stripe.settleInvoicePayment(failed.invoice, 'canceled')
      stripe.setInvoiceStatus(failed.invoice, 'void')
      expect(await retryItems(stripe)).toMatchObject([{ outcome: 'undone' }])
      expect(await states()).toEqual(['started', 'held', 'not_taken'])
      expect(await listed()).toEqual([])
      expect(stripe.netPence).toBe(0)
    })
  })
})

describe('the record and its words', () => {
  it('the closing states are the six that end a retry (W47r-a: `refunded`; W47r-d: `owed`), and the words staff read are these', () => {
    expect([...PAYMENT_RETRY_CLOSING_STATES]).toEqual(['paid', 'declined', 'not_taken', 'not_sent', 'refunded', 'owed'])
    expect(PAYMENT_RETRY_REFUSALS.retryHeld).toBe(
      "A payment was already tried for this membership and Stripe hasn't said how it ended, so it can't be tried again yet: the card could be charged twice. Nothing was charged by this press. The automatic check finishes the first one once Stripe answers (the Orders page lists it)."
    )
    expect(PAYMENT_RETRY_WORDS.heldProcessing).toBe(
      "The payment is still being processed by the customer's bank, so it isn't known yet whether it went through. It is on hold and the automatic check will finish it once the bank answers. Don't take the payment again or another way. Check the Orders page in a few minutes."
    )
    expect(PAYMENT_RETRY_WORDS.paidNotRecorded).toBe(
      "The payment went through, but the membership couldn't be brought up to date here yet. The automatic check does that within a few minutes, and the bookings waiting for payment go back to confirmed then. Don't take the payment again."
    )
    expect(PAYMENT_RETRY_STUCK_WORDS['waiting']).toBe(
      "A membership payment tried again from the desk didn't get a clear answer: the card may or may not have been charged. The automatic check, every 5 minutes, reads the invoice in Stripe and records the payment or ends this as not taken; it never charges. Don't take the payment again or another way."
    )
    expect(PAYMENT_RETRY_STUCK_WORDS['payment_processing']).toBe(
      "A membership payment tried again from the desk is still being processed by the customer's bank. Wait for the bank: the automatic check looks every 5 minutes and, once Stripe says whether it went through, records the payment or ends this as not taken. It can't be closed by hand, and the payment can't be tried again until then. Don't take the payment again or another way."
    )
    // Every reason a run can leave a retry with has its own line.
    for (const reason of ['waiting', 'unclear', 'payment_processing', 'payment_needs_action', 'paid_not_recorded', 'close_failed', 'other_mode', 'invoice_missing']) {
      expect(PAYMENT_RETRY_STUCK_WORDS[reason], reason).toEqual(expect.any(String))
    }
    expect(PAYMENT_RETRY_WORDS.membershipActive(1, 1, null)).toBe('The membership is active again. 1 booking that was waiting for payment is confirmed again. 1 booking on this membership is still waiting for payment: open it to see why.')
  })
})

// Brief W47r-b (W47r-a "Noticed" 1; the lead's call, 19 Nov): an invoice Stripe took a payment for at or after the
// moment its subscription ended is always listed for a refund, by the one rule the webhook's `invoice.paid` and the
// retry's "already paid before the press" share (dispatch.ts, recordInvoicePaid; paid-after-end.ts). One paid BEFORE
// the subscription ended is not: that money was owed. The line is written once for an invoice, and never beside a
// retry's own `paid_after_end` hold of the same invoice.
describe('W47r-b: an invoice paid after its subscription had ended is always listed for a refund, once', () => {
  const LISTED_WORDS = "£40.00 was taken by Stripe after this membership's subscription had ended. Refund it in Stripe (tell a manager), then press Mark refunded."
  const secondsAt = (iso: string): number => Date.parse(iso) / 1000
  /** 10 December 2026, 16:00:00: where `renewalHasFailed` leaves the clock. */
  const FOUR_PM = secondsAt('2026-12-10T16:00:00.000Z')
  const lister = (requestId: string) => listPaidAfterEnd(db, { actor: { type: 'system', id: null }, requestId }, 'webhook')
  /** Stripe's notice as the route handles it: its row claimed, the handler run with the route's listing, the outcome recorded. */
  const notice = (stripe: SubscriptionReader, event: Stripe.Event) => processWebhookEvent(event, webhookClient(db), stripe, lister(event.id))
  const eventRow = (event: Stripe.Event) => webhookClient(db).eventRow(event.id)
  const invoiceRows = () => audited(INVOICE_PAID_AFTER_END_ACTION)
  const methodsSince = (stripe: FakeStripe, from: number) => stripe.calls.slice(from).map((call) => call.method)

  it("Stripe's own retry pays at 16:00:00 and a manager cancels at 16:00:01 (paid before the end): not listed, through the notice and through the press; the press says nothing needs refunding", async () => {
    // Through Stripe's notice.
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.stripeRetryPays(failed.invoice)
      vi.setSystemTime(new Date('2026-12-10T16:00:01.000Z'))
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      const before = stripe.calls.length
      const event = paidEvent(failed.invoice)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      expect(await eventRow(event)).toMatchObject({
        outcome: 'ignored',
        detail: { reason: 'subscription_not_paid_up', status: 'canceled', paid_after_end: { listed: false, why: 'paid_before_end', paid_at: FOUR_PM, ended_at: FOUR_PM + 1 } },
      })
      // The subscription, then (only because it has ended) its invoice. Nothing else, and nothing sent.
      expect(methodsSince(stripe, before)).toEqual(['subscriptions.retrieve', 'invoices.retrieve'])
      expect(await invoiceRows()).toEqual([])
      expect(await listed()).toEqual([])
    })
    // Through the press: Stripe's retry got there first; the manager's cancel lands while the press is reading.
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.stripeRetryPays(failed.invoice)
      expect((await quote()).data).toMatchObject({ refusal: null, alreadyPaid: true, invoiceId: failed.invoice })
      // The press (at 16:00:01) reads the subscription paid up and its invoice paid; then the cancel lands, before the write reads the subscription.
      replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', () => stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' }))
      const answer = await press({ confirmed: { invoiceId: failed.invoice, amount: 0 } })
      replayStripe.current = stripe
      expect(answer.status).toBe(200)
      expect(answer.data).toMatchObject({
        retryId: null,
        alreadyPaid: true,
        amountCharged: 0,
        membershipUpdated: false,
        message:
          'Stripe shows this payment had already gone through (one of its own retries got there first), so nothing was charged by this press. The membership here was not changed: Stripe shows its subscription has ended since, and the payment was taken before it ended, so it paid for time the member had. Nothing needs refunding.',
      })
      expect((await retryRows()).map((row) => row.details)).toMatchObject([{ state: 'paid', sent: false, membership: { reason: 'subscription_not_paid_up', status: 'canceled', paid_after_end: { listed: false, why: 'paid_before_end' } } }])
      expect(await invoiceRows()).toEqual([])
      expect(await listed()).toEqual([])
      expect(pays(stripe)).toEqual([])
    })
  })

  it("cancelled at 16:00:00 and a late approval pays at 16:00:05: Stripe's notice lists it, once, with Mark refunded; the same notice sent again, another notice for the invoice, a run and a press add nothing", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      vi.setSystemTime(new Date('2026-12-10T16:00:05.000Z'))
      // Stripe leaves a cancelled subscription's open invoice payable: the payment goes through five seconds later.
      stripe.stripeRetryPays(failed.invoice)
      expect(stripe.netPence).toBe(4000)
      expect(stripe.subscription(MO_SUBSCRIPTION)?.status).toBe('canceled')
      const before = stripe.calls.length
      const event = paidEvent(failed.invoice)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      expect(methodsSince(stripe, before)).toEqual(['subscriptions.retrieve', 'invoices.retrieve'])
      const rows = await invoiceRows()
      expect(rows).toHaveLength(1)
      const listingId = rows[0]?.details['listingId'] as string
      expect(rows[0]).toEqual({
        action: INVOICE_PAID_AFTER_END_ACTION,
        actor_type: 'system',
        actor_id: null,
        entity_type: 'membership_invoice',
        entity_id: failed.invoice,
        details: {
          listingId,
          state: 'listed',
          how: 'webhook',
          membershipId: ID.membership,
          customerId: ID.member,
          subscriptionId: MO_SUBSCRIPTION,
          invoiceId: failed.invoice,
          amount: 40,
          status: 'canceled',
          paidAt: '2026-12-10T16:00:05.000Z',
          endedAt: '2026-12-10T16:00:00.000Z',
          livemode: false,
        },
      })
      expect(await eventRow(event)).toMatchObject({
        outcome: 'ignored',
        detail: { reason: 'subscription_not_paid_up', status: 'canceled', paid_after_end: { listed: true, why: 'listed', listing: listingId, paid_at: FOUR_PM + 5, ended_at: FOUR_PM } },
      })
      // Nothing is written to the membership (W46): only the line.
      expect(await membership()).toEqual({ status: 'past_due', renews: '2026-12-10' })

      // On the Orders page under the membership payments, with W47r-a's close.
      const line = {
        retryId: listingId,
        membershipId: ID.membership,
        customerId: ID.member,
        customerName: 'Mo Member',
        invoiceId: failed.invoice,
        amount: 40,
        cardBrand: null,
        cardLast4: null,
        createdAt: expect.any(String),
        ageMinutes: 0,
        reason: 'paid_after_end',
        words: LISTED_WORDS,
        close: { kind: 'retry_paid_after_end', orderId: listingId },
        // W47r-d, a named difference: the line's second close, Mark as owed.
        closeOwed: { kind: 'paid_after_end_owed', orderId: listingId },
      }
      const list = await stuckList(db)
      expect(stuckListOutputSchema.safeParse(list).success).toBe(true)
      expect(list.paymentRetries).toEqual([line])

      // The same notice sent again: a duplicate, nothing handled.
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true, duplicate: true } })
      // Another notice for the same invoice (a new event id): handled, and it finds the line already there.
      vi.setSystemTime(Date.now() + 1000)
      const again = paidEvent(failed.invoice)
      expect(await notice(stripe, again)).toEqual({ status: 200, body: { received: true } })
      expect(await eventRow(again)).toMatchObject({ outcome: 'ignored', detail: { paid_after_end: { listed: false, why: 'already_listed' } } })
      expect(await invoiceRows()).toHaveLength(1)
      // A run has nothing of it to read (no retry was ever recorded) and sends nothing; the window and a press are refused as before.
      const calls = stripe.calls.length
      expect(await retryItems(stripe)).toEqual([])
      expect(writesSince(stripe, calls)).toEqual([])
      expect((await quote()).data).toMatchObject({ refusal: PAYMENT_RETRY_REFUSALS.stripeCancelled, reason: 'subscription_cancelled' })
      expect(refusalOf(await pressShown(failed.invoice))).toEqual([409, 'CONFLICT', 'subscription_cancelled', PAYMENT_RETRY_REFUSALS.stripeCancelled])
      expect(await retryRows()).toEqual([])
      expect(await invoiceRows()).toHaveLength(1)
      expect(await listed()).toEqual([line])
      expect(pays(stripe)).toEqual([])
      expect(stripe.netPence).toBe(4000)
    })
  })

  it("through the retry's quote and press (already paid before the press, the subscription ended in the second the payment was taken): the press lists it and says where the button is; Stripe's notice afterwards adds nothing", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.stripeRetryPays(failed.invoice)
      const shown = await quote()
      expect(shown.data).toMatchObject({ refusal: null, alreadyPaid: true, invoiceId: failed.invoice, amount: 0 })
      // The press reads the subscription paid up and its invoice paid. Stripe then shows the subscription ended in the
      // very second the payment was taken (whole seconds: which came first can't be told), before the write reads it.
      replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', () => stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled', endedAt: FOUR_PM }))
      const before = stripe.calls.length
      const answer = await press({ confirmed: { invoiceId: failed.invoice, amount: 0 } })
      replayStripe.current = stripe
      expect(answer.status).toBe(200)
      expect(answer.data).toMatchObject({
        retryId: null,
        alreadyPaid: true,
        amountCharged: 0,
        membershipUpdated: false,
        message:
          'Stripe shows this payment had already gone through (one of its own retries got there first), so nothing was charged by this press. The membership here was not changed: Stripe shows its subscription has ended, so the payment Stripe took for it has nothing to pay for. Refund it in Stripe (tell a manager), then press Mark refunded on the Orders page.',
      })
      expect(retryPaymentOutputSchema.safeParse(answer.data).success).toBe(true)
      expect(writesSince(stripe, before)).toEqual([])
      const rows = await invoiceRows()
      expect(rows).toHaveLength(1)
      const listingId = rows[0]?.details['listingId'] as string
      expect(rows[0]).toMatchObject({
        actor_type: 'staff',
        entity_id: failed.invoice,
        details: { state: 'listed', how: 'retry', membershipId: ID.membership, invoiceId: failed.invoice, amount: 40, status: 'canceled', paidAt: '2026-12-10T16:00:00.000Z', endedAt: '2026-12-10T16:00:00.000Z' },
      })
      expect((await retryRows()).map((row) => row.details)).toMatchObject([{ state: 'paid', sent: false, membership: { paid_after_end: { listed: true, why: 'listed', listing: listingId } } }])
      expect(await listed()).toMatchObject([{ retryId: listingId, invoiceId: failed.invoice, amount: 40, reason: 'paid_after_end', words: LISTED_WORDS, close: { kind: 'retry_paid_after_end', orderId: listingId } }])

      // Stripe's own notice for the payment, handled afterwards: the invoice is listed already.
      const event = paidEvent(failed.invoice)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      expect(await eventRow(event)).toMatchObject({ outcome: 'ignored', detail: { paid_after_end: { listed: false, why: 'already_listed' } } })
      // And a second press: Stripe shows the subscription cancelled, so it is refused before the write.
      expect(refusalOf(await press({ confirmed: { invoiceId: failed.invoice, amount: 0 } }))).toEqual([409, 'CONFLICT', 'subscription_cancelled', PAYMENT_RETRY_REFUSALS.stripeCancelled])
      expect(await invoiceRows()).toHaveLength(1)
      expect(await listed()).toHaveLength(1)
      expect(pays(stripe)).toEqual([])
    })
  })

  it("the retry's own hold (W47r-a) is the one line for its invoice: Stripe's notice for the same payment lists nothing beside it, before the run, after it, or once it has been marked refunded", async () => {
    // At the press: the subscription is cancelled between the press's reads and its charge.
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', () => stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' }))
      const answer = await pressShown(failed.invoice)
      replayStripe.current = stripe
      const retryId = answer.error?.details?.held?.retryId as string
      expect(answer.error?.details?.reason).toBe('paid_after_end')
      expect(await listed()).toMatchObject([{ retryId, reason: 'paid_after_end', cardLast4: '4444' }])
      // Stripe's notice for the payment the press took.
      const event = paidEvent(failed.invoice)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      expect(await eventRow(event)).toMatchObject({ outcome: 'ignored', detail: { paid_after_end: { listed: false, why: 'retry_holds' } } })
      expect(await invoiceRows()).toEqual([])
      expect(await listed()).toMatchObject([{ retryId }])
      expect(await retryItems(stripe)).toMatchObject([{ id: retryId, outcome: 'left', reason: 'paid_after_end' }])
      expect(await listed()).toHaveLength(1)
      // Refunded in Stripe and marked: off the list. A notice handled after that (Stripe sends for three days) lists nothing.
      await stripe.refunds.create({ payment_intent: stripe.invoiceState(failed.invoice).paymentIntent as string })
      expect((await markRefunded(retryId)).data).toMatchObject({ closed: true })
      expect(await listed()).toEqual([])
      const late = paidEvent(failed.invoice)
      expect(await notice(stripe, late)).toEqual({ status: 200, body: { received: true } })
      expect(await eventRow(late)).toMatchObject({ detail: { paid_after_end: { listed: false, why: 'retry_holds' } } })
      expect(await invoiceRows()).toEqual([])
      expect(await listed()).toEqual([])
    })
    // Found by the run: a retry held waiting on the customer, the subscription cancelled at 16:00:00, the customer's approval at 16:00:05. The notice is handled BEFORE the run has looked.
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.nextPayEnds(failed.invoice, 'requires_action')
      const retryId = (await pressShown(failed.invoice)).error?.details?.held?.retryId as string
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      vi.setSystemTime(Date.now() + 5000)
      stripe.settleInvoicePayment(failed.invoice, 'succeeded')
      const event = paidEvent(failed.invoice)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      expect(await eventRow(event)).toMatchObject({ detail: { paid_after_end: { listed: false, why: 'retry_holds' } } })
      expect(await invoiceRows()).toEqual([])
      // One line throughout: the retry's, which the run then holds as paid after the end, with its close.
      // (No run has looked since the press, so the list still gives it as waiting on the automatic check.)
      expect(await listed()).toMatchObject([{ retryId, reason: 'waiting' }])
      expect(await retryItems(stripe)).toMatchObject([{ id: retryId, outcome: 'left', reason: 'paid_after_end' }])
      expect(await listed()).toMatchObject([{ retryId, reason: 'paid_after_end', close: { kind: 'retry_paid_after_end', orderId: retryId } }])
      expect(await invoiceRows()).toEqual([])
    })
    // A retry that ended with nothing taken holds nothing: its invoice, paid later by Stripe after the end, is listed.
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.declineCard(OLD_CARD)
      expect((await pressShown(failed.invoice)).error?.code).toBe('PAYMENT_FAILED')
      expect(await states()).toEqual(['started', 'declined'])
      stripe.declineCard(OLD_CARD, false)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      vi.setSystemTime(Date.now() + 5000)
      stripe.stripeRetryPays(failed.invoice)
      const event = paidEvent(failed.invoice)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      expect(await eventRow(event)).toMatchObject({ detail: { paid_after_end: { listed: true, why: 'listed' } } })
      expect(await listed()).toMatchObject([{ invoiceId: failed.invoice, reason: 'paid_after_end', cardLast4: null, words: LISTED_WORDS }])
    })
  })

  it('Mark refunded on a listed invoice reads the refunds in Stripe first: refused with nothing or part refunded or Stripe unreadable, allowed once Stripe shows it all back; it sends nothing, needs Issue refunds, and the invoice is never listed again', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      vi.setSystemTime(Date.now() + 5000)
      stripe.stripeRetryPays(failed.invoice)
      expect(await notice(stripe, paidEvent(failed.invoice))).toEqual({ status: 200, body: { received: true } })
      const listingId = (await listed())[0]?.retryId as string
      const payment = stripe.invoiceState(failed.invoice).paymentIntent as string
      const closedRows = async () => (await audited('order.close')).filter((row) => row.entity_id === failed.invoice)
      const lineStates = async () => (await invoiceRows()).map((row) => row.details['state'])

      // No Issue refunds: the route refuses before anything is read.
      const calls = stripe.calls.length
      expect((await markRefunded(listingId, { email: NO_REFUNDS })).status).toBe(403)
      expect(stripe.calls.slice(calls)).toEqual([])

      // Nothing refunded yet: refused, and the only calls are reads.
      const first = await markRefunded(listingId)
      expect(first.status).toBe(200)
      expect(first.data).toEqual({
        kind: 'retry_paid_after_end',
        orderId: listingId,
        closed: false,
        reason: 'not_refunded',
        message: 'Stripe shows none of the £40.00 refunded. Nothing was changed. Refund it in Stripe, then press Mark refunded again.',
      })
      expect(methodsSince(stripe, calls)).toEqual(['invoices.retrieve', 'paymentIntents.retrieve', 'refunds.list'])
      // £15 back: still refused. Stripe unreadable: refused, nothing concluded.
      await stripe.refunds.create({ payment_intent: payment, amount: 1500 })
      expect((await markRefunded(listingId)).data).toMatchObject({
        closed: false,
        reason: 'not_refunded',
        message: 'Stripe shows only £15.00 of the £40.00 refunded. Nothing was changed. Refund the rest in Stripe, then press Mark refunded again.',
      })
      stripe.failNext('refunds.list', noAnswer())
      expect((await markRefunded(listingId)).data).toMatchObject({ closed: false, reason: 'refunds_not_read', message: PAYMENT_RETRY_CLOSE_WORDS.notRead })
      expect(await lineStates()).toEqual(['listed'])
      expect(await closedRows()).toEqual([])
      expect(await listed()).toMatchObject([{ retryId: listingId, reason: 'paid_after_end' }])

      // The other £25 back: Stripe shows the whole £40 refunded. Marked, with nothing sent by any press.
      await stripe.refunds.create({ payment_intent: payment, amount: 2500 })
      expect(stripe.netPence).toBe(0)
      const sends = stripe.calls.length
      const key = crypto.randomUUID()
      const done = await markRefunded(listingId, { key })
      expect(done.data).toEqual({ kind: 'retry_paid_after_end', orderId: listingId, closed: true, message: 'Marked as refunded: Stripe shows the £40.00 refunded in full. It is no longer listed.' })
      expect(writesSince(stripe, sends)).toEqual([])
      const rows = await invoiceRows()
      expect(rows.map((row) => row.details['state'])).toEqual(['listed', 'refunded'])
      expect(rows[1]).toMatchObject({ actor_type: 'staff', entity_type: 'membership_invoice', entity_id: failed.invoice, details: { listingId, how: 'close', why: 'Refunded in Stripe by the manager', membershipId: ID.membership, invoiceId: failed.invoice, taken: 40, refunded: 40 } })
      expect(await closedRows()).toMatchObject([{ entity_type: 'membership_invoice', details: { kind: 'retry_paid_after_end', why: 'Refunded in Stripe by the manager', listingId, membershipId: ID.membership, taken: 40, refunded: 40 } }])
      // Off the list; a second press (a new key, or the same one) changes nothing.
      expect(await listed()).toEqual([])
      expect((await markRefunded(listingId)).data).toMatchObject({ closed: true, alreadyClosed: true, message: PAYMENT_RETRY_CLOSE_WORDS.already })
      expect((await markRefunded(listingId, { key })).data).toMatchObject({ closed: true, message: 'Marked as refunded: Stripe shows the £40.00 refunded in full. It is no longer listed.' })
      expect(await lineStates()).toEqual(['listed', 'refunded'])
      expect(await closedRows()).toHaveLength(1)
      // The invoice's notice handled again after that: it has its line, refunded; it is never listed a second time.
      const late = paidEvent(failed.invoice)
      expect(await notice(stripe, late)).toEqual({ status: 200, body: { received: true } })
      expect(await eventRow(late)).toMatchObject({ detail: { paid_after_end: { listed: false, why: 'already_listed' } } })
      expect(await lineStates()).toEqual(['listed', 'refunded'])
      expect(await listed()).toEqual([])
    })
  })

  it("a normal end-of-term cancel, and December's invoice.paid sent again after the membership has ended: not listed (paid a month before the end); a live subscription's notice reads no invoice at all", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      // December's payment goes through on Stripe's retry at 16:00 on 10 December, and its notice marks the membership paid.
      stripe.stripeRetryPays(failed.invoice)
      // Stripe a moment behind its own invoice (the subscription still reads past due): not ended, so nothing is
      // listed and the invoice isn't read. W46's answer exactly.
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'past_due' })
      const lagging = stripe.calls.length
      expect(await dispatchStripeEvent(paidEvent(failed.invoice), webhookRpc(db), stripe, lister('evt_lagging'))).toEqual({ outcome: 'ignored', detail: { reason: 'subscription_not_paid_up', status: 'past_due' } })
      expect(methodsSince(stripe, lagging)).toEqual(['subscriptions.retrieve'])
      expect(await invoiceRows()).toEqual([])
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'active' })
      const before = stripe.calls.length
      const paid = paidEvent(failed.invoice)
      expect(await notice(stripe, paid)).toEqual({ status: 200, body: { received: true } })
      expect(await eventRow(paid)).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated', bookings_restored: 2 } })
      // A live subscription: the two reads the handler always made (before and after its write), and no invoice read.
      expect(methodsSince(stripe, before)).toEqual(['subscriptions.retrieve', 'subscriptions.retrieve'])
      // Mo cancels on 20 December; his paid month runs out and Stripe ends the subscription on 10 January.
      vi.setSystemTime(new Date('2027-01-10T00:00:05.000Z'))
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled', endedAt: JAN_10, canceledAt: secondsAt('2026-12-20T10:00:00.000Z') })
      // Stripe sends December's notice again (a new delivery of an invoice paid a month before the end).
      const late = paidEvent(failed.invoice)
      expect(await notice(stripe, late)).toEqual({ status: 200, body: { received: true } })
      expect(await eventRow(late)).toMatchObject({
        outcome: 'ignored',
        detail: { reason: 'subscription_not_paid_up', status: 'canceled', paid_after_end: { listed: false, why: 'paid_before_end', paid_at: FOUR_PM, ended_at: JAN_10 } },
      })
      expect(await invoiceRows()).toEqual([])
      expect(await listed()).toEqual([])
    })
  })

  it('the times Stripe gives: `ended_at` is the end; `canceled_at` only when there is no `ended_at`; with neither, or the same second, it is listed; a paid invoice that took nothing is not', async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.stripeRetryPays(failed.invoice)
      const found = async (reader: SubscriptionReader = stripe) => (await dispatchStripeEvent(paidEvent(failed.invoice), webhookRpc(db), reader, lister('evt_times')))?.detail?.['paid_after_end']
      // `canceled_at` (the day the cancel was asked for) is earlier than the payment, but `ended_at` is later: Stripe's `ended_at` decides. Not listed.
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled', endedAt: FOUR_PM + 60, canceledAt: FOUR_PM - 86_400 })
      expect(await found()).toEqual({ listed: false, why: 'paid_before_end', paid_at: FOUR_PM, ended_at: FOUR_PM + 60 })
      // No `ended_at`: `canceled_at` is all Stripe gives. Later than the payment: not listed.
      stripe.setSubscription(MO_SUBSCRIPTION, { endedAt: null, canceledAt: FOUR_PM + 60 })
      expect(await found()).toEqual({ listed: false, why: 'paid_before_end', paid_at: FOUR_PM, ended_at: FOUR_PM + 60 })
      // A paid invoice that took nothing (a £0 one), after the end: nothing to give back.
      stripe.setSubscription(MO_SUBSCRIPTION, { endedAt: FOUR_PM - 60 })
      const nothingTaken: SubscriptionReader = { subscriptions: stripe.subscriptions, invoices: { retrieve: async (id) => ({ ...(await stripe.invoices.retrieve(id)), amount_paid: 0 }) } }
      expect(await found(nothingTaken)).toEqual({ listed: false, why: 'nothing_taken', invoice_status: 'paid', amount_paid: 0 })
      expect(await invoiceRows()).toEqual([])
      // `incomplete_expired`, ended in the same second as the payment: listed (the order inside a second can't be told).
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'incomplete_expired', endedAt: FOUR_PM })
      expect(await found()).toMatchObject({ listed: true, why: 'listed', paid_at: FOUR_PM, ended_at: FOUR_PM })
      expect((await invoiceRows()).map((row) => row.details)).toMatchObject([{ state: 'listed', status: 'incomplete_expired', paidAt: '2026-12-10T16:00:00.000Z', endedAt: '2026-12-10T16:00:00.000Z' }])
    })
    // No `ended_at` and `canceled_at` before the payment: listed. And with neither time: listed (it can't be shown the payment came first).
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.stripeRetryPays(failed.invoice)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled', endedAt: null, canceledAt: FOUR_PM - 60 })
      expect((await dispatchStripeEvent(paidEvent(failed.invoice), webhookRpc(db), stripe, lister('evt_canceled_at')))?.detail?.['paid_after_end']).toMatchObject({ listed: true, why: 'listed', paid_at: FOUR_PM, ended_at: FOUR_PM - 60 })
      expect(await listed()).toHaveLength(1)
    })
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.stripeRetryPays(failed.invoice)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled', endedAt: null, canceledAt: null })
      expect((await dispatchStripeEvent(paidEvent(failed.invoice), webhookRpc(db), stripe, lister('evt_no_times')))?.detail?.['paid_after_end']).toMatchObject({ listed: true, why: 'listed', paid_at: FOUR_PM, ended_at: null })
      expect((await invoiceRows()).map((row) => row.details)).toMatchObject([{ state: 'listed', endedAt: null }])
    })
  })

  it("what can't be read or written is an error, so Stripe sends the notice again and it is listed then; no membership here, and test data since deleted, are said and not listed; a caller that gives no listing gets the handler as it was", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      vi.setSystemTime(Date.now() + 5000)
      stripe.stripeRetryPays(failed.invoice)
      const event = paidEvent(failed.invoice)
      // A caller with no listing (every test of another rule): W46's answer exactly, and no invoice read.
      const before = stripe.calls.length
      expect(await dispatchStripeEvent(event, webhookRpc(db), stripe)).toEqual({ outcome: 'ignored', detail: { reason: 'subscription_not_paid_up', status: 'canceled' } })
      expect(methodsSince(stripe, before)).toEqual(['subscriptions.retrieve'])
      // The invoice can't be read: the notice is an error (500), nothing is listed, and nothing says it was handled.
      stripe.failNext('invoices.retrieve', noAnswer())
      expect(await notice(stripe, event)).toEqual({ status: 500, body: { error: 'Internal server error' } })
      expect(await eventRow(event)).toMatchObject({ outcome: 'error' })
      expect(await invoiceRows()).toEqual([])
      // The line can't be written (the database): an error too.
      const failing = () => processWebhookEvent(event, webhookClient(db), stripe, async () => Promise.reject(new Error('the database is away')))
      expect(await failing()).toEqual({ status: 500, body: { error: 'Internal server error' } })
      expect(await eventRow(event)).toMatchObject({ outcome: 'error', error: 'the database is away' })
      // A listing with no way to read the invoice is a wiring fault, and loud.
      await expect(dispatchStripeEvent(event, webhookRpc(db), { subscriptions: stripe.subscriptions }, lister('evt_unwired'))).rejects.toThrow(/no invoice read was given/)
      expect(await invoiceRows()).toEqual([])
      // "No such invoice" for a test-mode notice (test data since deleted): said, and not an error. For a live one it is an error.
      const gone: SubscriptionReader = { subscriptions: stripe.subscriptions, invoices: { retrieve: async () => Promise.reject(fakeStripeErrors.missing(`invoice: '${failed.invoice}'`)) } }
      expect(await dispatchStripeEvent(event, webhookRpc(db), gone, lister('evt_gone'))).toMatchObject({ outcome: 'ignored', detail: { paid_after_end: { listed: false, why: 'invoice_missing' } } })
      await expect(dispatchStripeEvent(asLive(event), webhookRpc(db), gone, lister('evt_gone_live'))).rejects.toThrow()
      expect(await invoiceRows()).toEqual([])
      // Stripe sends the notice again: handled, and listed once.
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      expect(await eventRow(event)).toMatchObject({ outcome: 'ignored', error: null, detail: { paid_after_end: { listed: true } } })
      expect(await invoiceRows()).toHaveLength(1)
      expect(await listed()).toHaveLength(1)
    })
    // No membership here has the subscription: there is nobody to list it against. Said on the notice's row.
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      vi.setSystemTime(Date.now() + 5000)
      stripe.stripeRetryPays(failed.invoice)
      await db.query("UPDATE customer_memberships SET stripe_subscription_id = 'sub_another' WHERE id = $1", [ID.membership])
      const event = paidEvent(failed.invoice)
      expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
      expect(await eventRow(event)).toMatchObject({ outcome: 'ignored', detail: { paid_after_end: { listed: false, why: 'no_membership' } } })
      expect(await invoiceRows()).toEqual([])
      expect(await listed()).toEqual([])
    })
  })

  it("through the staff app's own wrappers: the Orders page's list carries the line and its Mark refunded; the close wrapper reaches the Worker, which refuses until Stripe shows the refund", async () => {
    await onASeed(async (stripe) => {
      const failed = await renewalHasFailed(stripe)
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      vi.setSystemTime(Date.now() + 5000)
      stripe.stripeRetryPays(failed.invoice)
      expect(await notice(stripe, paidEvent(failed.invoice))).toEqual({ status: 200, body: { received: true } })
      const stuck = async () => ((await throughStaffApp('getStuckReaderPayments')(db, {})) as { paymentRetries: Array<{ retryId: string; close?: { kind: string; orderId: string } }> }).paymentRetries
      const [line] = await stuck()
      expect(line).toMatchObject({ customerName: 'Mo Member', invoiceId: failed.invoice, amount: 40, cardLast4: null, reason: 'paid_after_end', words: LISTED_WORDS, close: { kind: 'retry_paid_after_end', orderId: line?.retryId } })
      const close = () => {
        vi.setSystemTime(Date.now() + 1000)
        return throughStaffApp('closeStuckOrder')(db, { ...line?.close, reason: 'Refunded in Stripe by the manager', idempotencyKey: crypto.randomUUID() })
      }
      expect(await close()).toMatchObject({ closed: false, kind: 'retry_paid_after_end', reason: 'not_refunded', message: 'Stripe shows none of the £40.00 refunded. Nothing was changed. Refund it in Stripe, then press Mark refunded again.' })
      await stripe.refunds.create({ payment_intent: stripe.invoiceState(failed.invoice).paymentIntent as string })
      expect(await close()).toEqual({ closed: true, kind: 'retry_paid_after_end', orderId: line?.retryId, message: 'Marked as refunded: Stripe shows the £40.00 refunded in full. It is no longer listed.' })
      expect(await stuck()).toEqual([])
    })
  })

  it("the words (brief item 2): `unpaid` after the pay is said as `past_due` is; an ended subscription's sentence goes by what the write found; a row cancelled here adds checking the subscription", () => {
    const notPaidUp = PAYMENT_RETRY_WORDS.notUpdated.subscription_not_paid_up
    const gentle = "Stripe hasn't shown the subscription as paid up yet; the membership is brought up to date when Stripe's notice arrives. Look again in a few minutes."
    expect(notPaidUp('unpaid')).toBe(gentle)
    expect(notPaidUp('past_due')).toBe(gentle)
    expect(notPaidUp('paused')).toBe('Stripe still shows its subscription as paused. Tell a manager.')
    const listedSentence = 'Stripe shows its subscription has ended, so the payment Stripe took for it has nothing to pay for. Refund it in Stripe (tell a manager), then press Mark refunded on the Orders page.'
    for (const why of ['listed', 'already_listed', 'retry_holds']) expect(notPaidUp('canceled', why), why).toBe(listedSentence)
    expect(notPaidUp('canceled', 'paid_before_end')).toBe('Stripe shows its subscription has ended since, and the payment was taken before it ended, so it paid for time the member had. Nothing needs refunding.')
    expect(notPaidUp('incomplete_expired', 'nothing_taken')).toBe('Stripe shows its subscription has ended, and nothing was taken for this invoice. Nothing needs refunding.')
    // Not listed and not shown to be owed (no membership to list it against, no listing asked): W47r-a's words, which name no button.
    for (const why of ['no_membership', 'invoice_missing', null]) {
      expect(notPaidUp('canceled', why), String(why)).toBe('Stripe shows its subscription has ended, so the payment Stripe took for it has nothing to pay for. Refund it in Stripe (tell a manager).')
    }
    expect(PAYMENT_RETRY_WORDS.invoicePaidAfterEnd(40)).toBe(LISTED_WORDS)
    expect(PAYMENT_RETRY_WORDS.paidAfterEnd(40, '4444', true)).toBe(
      '£40.00 was taken on the card ending 4444 after this membership had ended here. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded.'
    )
    expect(PAYMENT_RETRY_WORDS.paidAfterEndAtThePress(40, '4444', true)).toBe(
      '£40.00 was taken on the card ending 4444 after this membership had ended here. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded on the Orders page.'
    )
    // Stripe's subscription ended: W47r-a's sentences, unchanged.
    expect(PAYMENT_RETRY_WORDS.paidAfterEnd(40, '4444', false)).toBe(PAYMENT_RETRY_WORDS.paidAfterEnd(40, '4444'))
    expect(PAYMENT_RETRY_WORDS.paidAfterEndAtThePress(40, '4444')).toBe(
      "£40.00 was taken on the card ending 4444 after this membership's subscription had ended. Refund it in Stripe (tell a manager), then press Mark refunded on the Orders page."
    )
  })

  it("the webhook's route gives the handler its listing, on the Worker's own database connection, opened only when there is a line to write", () => {
    const route = readFileSync(join(process.cwd(), 'app/api/stripe/webhook/route.ts'), 'utf8')
    expect(route).toContain("listPaidAfterEnd(db, { actor: { type: 'system', id: null }, requestId: event.id }, 'webhook')(found)")
    // W47r-e, a named difference: the call also gives the handler the update notice's write (cancel-wins.test.ts holds it).
    expect(route).toContain('createStripeClient(process.env.STRIPE_SECRET_KEY, READ_STRIPE_LIMITS), list, syncCancelDate)')
    // The connection is opened inside the listing, never at the top of the handler: a notice with nothing to list opens none.
    const opened = route.indexOf('openRequestDb()')
    expect(opened).toBeGreaterThan(route.indexOf('const list: ListPaidAfterEnd = async (found) => {'))
    // W47r-e, a named difference: opened in one more place, inside the update notice's write for a subscription with
    // no end, and nowhere else: still never at the top of the handler.
    expect(route.match(/openRequestDb\(\)/g)).toHaveLength(2)
    expect(route.lastIndexOf('openRequestDb()')).toBeGreaterThan(route.indexOf('const syncCancelDate: SyncCancelDate = async (params) => {'))
    expect(route.match(/await closeRequestDb\(db\)/g)).toHaveLength(2)
  })
})

// Brief W47r-c (W47r-b "Noticed" 1 and 2): the last two gaps. (1) A retry's own hold goes by the time rule the line
// goes by: money a press took BEFORE the subscription ended was owed, so its record ends `paid`; taken at or after
// the end it is held for a refund, as before. (2) A renewal Stripe takes on a subscription that is still live there,
// for a membership whose row has ended here, is listed for a refund by the same line, once, unless it was paid before
// the row's last day (a late or re-sent notice for a month the member had).
describe('W47r-c: the hold goes by the time rule, and a renewal taken for a membership ended here is listed', () => {
  const secondsAt = (iso: string): number => Date.parse(iso) / 1000
  /** 10 December 2026, 16:00:00: where `renewalHasFailed` leaves the clock. */
  const FOUR_PM = secondsAt('2026-12-10T16:00:00.000Z')
  const HELD_PRESS = "£40.00 was taken on the card ending 4444 after this membership's subscription had ended. Refund it in Stripe (tell a manager), then press Mark refunded on the Orders page."
  const ENDED_HERE_LINE = '£40.00 was taken by Stripe after this membership had ended here. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded.'
  const lister = (requestId: string) => listPaidAfterEnd(db, { actor: { type: 'system', id: null }, requestId }, 'webhook')
  /** Stripe's notice as the route handles it: its row claimed, the handler run with the route's listing, the outcome recorded. */
  const notice = (stripe: SubscriptionReader, event: Stripe.Event) => processWebhookEvent(event, webhookClient(db), stripe, lister(event.id))
  const eventRow = (event: Stripe.Event) => webhookClient(db).eventRow(event.id)
  const invoiceRows = () => audited(INVOICE_PAID_AFTER_END_ACTION)
  const methodsSince = (stripe: FakeStripe, from: number) => stripe.calls.slice(from).map((call) => call.method)
  /** The membership's row ended here, as a cancel that never reached Stripe leaves it: `lastDay` its last day of access, or none. */
  const endedHere = (lastDay: string | null) => db.query("UPDATE customer_memberships SET subscription_status = 'cancelled', cancel_effective_date = $1::date WHERE id = $2", [lastDay, ID.membership])
  const januaryEvent = (invoice: string): Stripe.Event => invoiceEvent('invoice.paid', MO_SUBSCRIPTION, { id: invoice, periodEnd: FEB_10, amountPaid: 4000 })

  describe('item 1: a retry held, or not, by when its money was taken', () => {
    it("Mo's press takes £40 at 16:00:00, a manager cancels at 16:00:01 and the press's write reads the subscription at 16:00:02: the money was owed. The record ends `paid`, nothing is listed, and nothing asks for a refund", async () => {
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        // `press` moves the clock on a second before the route runs: back one, so the charge lands at 16:00:00.
        vi.setSystemTime(new Date('2026-12-10T15:59:59.000Z'))
        replayStripe.current = withAChangeAfter(stripe, 'invoices', 'pay', () => {
          vi.setSystemTime(new Date('2026-12-10T16:00:01.000Z'))
          stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
          vi.setSystemTime(new Date('2026-12-10T16:00:02.000Z'))
        })
        const answer = await pressShown(failed.invoice)
        replayStripe.current = stripe
        expect(stripe.netPence).toBe(4000)
        expect(pays(stripe)).toHaveLength(1)
        // Until W47r-c this was 502 PAYMENT_UNCONFIRMED `paid_after_end`, "Refund it in Stripe": for money that was owed.
        expect(answer.status).toBe(200)
        expect(retryPaymentOutputSchema.safeParse(answer.data).success).toBe(true)
        expect(answer.data).toMatchObject({
          alreadyPaid: false,
          amountCharged: 40,
          membershipUpdated: false,
          message:
            '£40.00 was taken on the Visa card ending 4444. The membership here was not changed: Stripe shows its subscription has ended since, and the payment was taken before it ended, so it paid for time the member had. Nothing needs refunding.',
        })
        const rows = await retryRows()
        expect(rows.map((row) => row.details['state'])).toEqual(['started', 'paid'])
        expect(rows[1]?.details).toMatchObject({
          how: 'press',
          amount: 40,
          membership: { outcome: 'ignored', reason: 'subscription_not_paid_up', status: 'canceled', paid_after_end: { listed: false, why: 'paid_before_end', paid_at: FOUR_PM, ended_at: FOUR_PM + 1 } },
        })
        expect(await listed()).toEqual([])
        expect(await invoiceRows()).toEqual([])
        // A run has nothing of it to read; Stripe's own notice for the payment lists nothing either.
        const before = stripe.calls.length
        expect(await retryItems(stripe)).toEqual([])
        const event = paidEvent(failed.invoice)
        expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
        expect(await eventRow(event)).toMatchObject({ outcome: 'ignored', detail: { paid_after_end: { listed: false, why: 'paid_before_end' } } })
        expect(writesSince(stripe, before)).toEqual([])
        expect(await states()).toEqual(['started', 'paid'])
        expect(await listed()).toEqual([])
        expect(await invoiceRows()).toEqual([])
      })
    })

    it('cancelled at 16:00:00 and the press takes £40 at 16:00:01: held `paid_after_end` as before, listed with Mark refunded, which is refused until Stripe shows the refund', async () => {
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        vi.setSystemTime(new Date('2026-12-10T15:59:59.000Z'))
        // The press's read of the invoice is answered at 16:00:00; the cancel lands in that second; the charge is a second later.
        replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', () => {
          stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
          vi.setSystemTime(new Date('2026-12-10T16:00:01.000Z'))
        })
        const answer = await pressShown(failed.invoice)
        replayStripe.current = stripe
        expect(stripe.netPence).toBe(4000)
        expect(refusalOf(answer)).toEqual([502, 'PAYMENT_UNCONFIRMED', 'paid_after_end', HELD_PRESS])
        const retryId = answer.error?.details?.held?.retryId as string
        expect(await states()).toEqual(['started', 'held'])
        expect((await retryRows())[1]?.details).toMatchObject({ reason: 'paid_after_end', detail: `invoice ${failed.invoice} is paid; Stripe shows the subscription as canceled` })
        expect((await stripe.invoices.retrieve(failed.invoice)).status_transitions?.paid_at).toBe(FOUR_PM + 1)
        expect((await stripe.subscriptions.retrieve(MO_SUBSCRIPTION)).ended_at).toBe(FOUR_PM)
        expect(await listed()).toMatchObject([{ retryId, reason: 'paid_after_end', cardLast4: '4444', close: { kind: 'retry_paid_after_end', orderId: retryId } }])
        expect(await retryItems(stripe)).toMatchObject([{ id: retryId, outcome: 'left', reason: 'paid_after_end' }])
        expect((await markRefunded(retryId)).data).toMatchObject({ closed: false, reason: 'not_refunded' })
        await stripe.refunds.create({ payment_intent: stripe.invoiceState(failed.invoice).paymentIntent as string })
        expect((await markRefunded(retryId)).data).toMatchObject({ closed: true })
        expect(await states()).toEqual(['started', 'held', 'refunded'])
        expect(await listed()).toEqual([])
      })
    })

    it("the same second (cancelled and charged at 16:00:00) and a time Stripe doesn't give: held, as the line's rule has them", async () => {
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        vi.setSystemTime(new Date('2026-12-10T15:59:59.000Z'))
        replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', () => stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' }))
        expect(refusalOf(await pressShown(failed.invoice))).toEqual([502, 'PAYMENT_UNCONFIRMED', 'paid_after_end', HELD_PRESS])
        replayStripe.current = stripe
        expect(await states()).toEqual(['started', 'held'])
      })
      // Charged at 16:00:00, cancelled a second later, but Stripe gives no time for the end: it can't be shown the payment came first.
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        vi.setSystemTime(new Date('2026-12-10T15:59:59.000Z'))
        replayStripe.current = withAChangeAfter(stripe, 'invoices', 'pay', () => {
          vi.setSystemTime(new Date('2026-12-10T16:00:01.000Z'))
          stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled', endedAt: null, canceledAt: null })
        })
        expect(refusalOf(await pressShown(failed.invoice))).toEqual([502, 'PAYMENT_UNCONFIRMED', 'paid_after_end', HELD_PRESS])
        replayStripe.current = stripe
        expect(await states()).toEqual(['started', 'held'])
        expect(await listed()).toMatchObject([{ reason: 'paid_after_end', close: { kind: 'retry_paid_after_end' } }])
      })
    })

    it("the reconcile path: a retry held waiting on the customer, who approves at 16:00:05; the subscription is cancelled at 16:00:10: the run finds the money was taken before the end and ends the record `paid`, with nothing listed", async () => {
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        stripe.nextPayEnds(failed.invoice, 'requires_action')
        const retryId = (await pressShown(failed.invoice)).error?.details?.held?.retryId as string
        expect(await states()).toEqual(['started', 'held'])
        vi.setSystemTime(new Date('2026-12-10T16:00:05.000Z'))
        stripe.settleInvoicePayment(failed.invoice, 'succeeded')
        vi.setSystemTime(new Date('2026-12-10T16:00:10.000Z'))
        stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
        const before = stripe.calls.length
        // Until W47r-c the run left it `paid_after_end`, with Mark refunded, for money that was owed.
        expect(await retryItems(stripe)).toMatchObject([{ kind: 'payment_retry', id: retryId, outcome: 'finalised' }])
        expect(writesSince(stripe, before)).toEqual([])
        const rows = await retryRows()
        expect(rows.map((row) => row.details['state'])).toEqual(['started', 'held', 'paid'])
        expect(rows[2]?.details).toMatchObject({ how: 'reconcile', membership: { reason: 'subscription_not_paid_up', status: 'canceled', paid_after_end: { listed: false, why: 'paid_before_end', paid_at: FOUR_PM + 5, ended_at: FOUR_PM + 10 } } })
        expect(await listed()).toEqual([])
        expect(await invoiceRows()).toEqual([])
        expect(await retryItems(stripe)).toEqual([])
      })
    })

    it("a record once held for a person stays held: held because the row had ended here, its subscription is then cancelled in Stripe (as the line's words ask), and the run does not end it `paid` though Stripe now shows the payment before the end; Stripe's notice lists nothing beside it; Mark refunded still ends it", async () => {
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        // The row is ended here while the send is at Stripe, with no last day on it (as a refund leaves it).
        // W47r-d, a named difference: this test had the last day as 9 December. With a last day on or before the
        // payment the listing's own rule now keeps the record held (W47r-d's test of that is below), so the guard is
        // shown on the row it is still the only thing holding: one with no last day.
        replayStripe.current = withAChangeAfter(stripe, 'invoices', 'pay', async () => {
          await endedHere(null)
        })
        const answer = await pressShown(failed.invoice)
        replayStripe.current = stripe
        expect(answer.error?.details?.reason).toBe('paid_after_end')
        const retryId = answer.error?.details?.held?.retryId as string
        expect((await retryRows())[1]?.details).toMatchObject({ reason: 'paid_after_end', cancelledHere: true })
        const line = { retryId, reason: 'paid_after_end', words: '£40.00 was taken on the card ending 4444 after this membership had ended here. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded.' }
        expect(await listed()).toMatchObject([line])
        // The retry's record is the one line for its invoice (W47r-b): the paid write's own listing leaves it alone.
        const event = paidEvent(failed.invoice)
        expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
        expect(await eventRow(event)).toMatchObject({ outcome: 'processed', detail: { action: 'ignored_cancelled', paid_after_end: { listed: false, why: 'retry_holds', cancelled_here: true } } })
        expect(await invoiceRows()).toEqual([])
        // A manager does as the words say and cancels the subscription in Stripe, a minute after the payment.
        vi.setSystemTime(Date.now() + 60_000)
        stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
        expect(await retryItems(stripe)).toEqual([
          { kind: 'payment_retry', id: retryId, outcome: 'left', reason: 'paid_after_end', detail: `invoice ${failed.invoice} is paid; held for a refund since an earlier look, and only Mark refunded ends it` },
        ])
        expect(await states()).toEqual(['started', 'held'])
        expect(await listed()).toMatchObject([line])
        // The notice handled again now (Stripe shows it paid before the end there): still nothing beside the record.
        const late = paidEvent(failed.invoice)
        expect(await notice(stripe, late)).toEqual({ status: 200, body: { received: true } })
        expect(await eventRow(late)).toMatchObject({ outcome: 'ignored', detail: { paid_after_end: { listed: false, why: 'paid_before_end' } } })
        expect(await invoiceRows()).toEqual([])
        await stripe.refunds.create({ payment_intent: stripe.invoiceState(failed.invoice).paymentIntent as string })
        expect((await markRefunded(retryId)).data).toMatchObject({ closed: true })
        expect(await states()).toEqual(['started', 'held', 'refunded'])
        expect(await listed()).toEqual([])
      })
    })

    it("a row ended here while the send is at Stripe, with its last day still to come: the press's money was for time the member has, so the record ends `paid`; with its last day today it is held", async () => {
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        replayStripe.current = withAChangeAfter(stripe, 'invoices', 'pay', async () => {
          await endedHere('2026-12-31')
        })
        const answer = await pressShown(failed.invoice)
        replayStripe.current = stripe
        expect(answer.status).toBe(200)
        expect(answer.data).toMatchObject({
          amountCharged: 40,
          membershipUpdated: false,
          message:
            '£40.00 was taken on the Visa card ending 4444. The membership here was not changed: it has ended here, and the payment was taken before its last day, so it paid for time the member had. Nothing needs refunding. Tell a manager to check the subscription is cancelled in Stripe.',
        })
        const rows = await retryRows()
        expect(rows.map((row) => row.details['state'])).toEqual(['started', 'paid'])
        expect(rows[1]?.details).toMatchObject({ membership: { action: 'ignored_cancelled', paid_after_end: { listed: false, why: 'paid_before_last_day', last_day: '2026-12-31', cancelled_here: true } } })
        expect(await listed()).toEqual([])
        expect(await invoiceRows()).toEqual([])
      })
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        replayStripe.current = withAChangeAfter(stripe, 'invoices', 'pay', async () => {
          await endedHere('2026-12-10')
        })
        const answer = await pressShown(failed.invoice)
        replayStripe.current = stripe
        expect(answer.error?.details?.reason).toBe('paid_after_end')
        expect(await states()).toEqual(['started', 'held'])
        expect((await retryRows())[1]?.details).toMatchObject({ reason: 'paid_after_end', cancelledHere: true })
        // One line: the record's. The listing wrote nothing beside it.
        expect(await invoiceRows()).toEqual([])
        expect(await listed()).toHaveLength(1)
      })
    })
  })

  describe("item 2: a renewal Stripe takes on a live subscription whose membership's row has ended here", () => {
    /**
     * December's renewal goes through on Stripe's retry (10 December, 16:00) and its notice marks Mo paid to 10
     * January. His membership is then ended here with its last day on 9 January, and the cancel never reaches Stripe:
     * the subscription there stays `active`. Leaves the clock at 00:00:05 on 10 January.
     */
    async function endedHereStripeLive(stripe: FakeStripe): Promise<Failed> {
      const failed = await renewalHasFailed(stripe)
      stripe.stripeRetryPays(failed.invoice)
      expect(await dispatchStripeEvent(paidEvent(failed.invoice), webhookRpc(db), stripe)).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated' } })
      vi.setSystemTime(new Date('2027-01-10T00:00:05.000Z'))
      await endedHere('2027-01-09')
      expect(stripe.subscription(MO_SUBSCRIPTION)?.status).toBe('active')
      return failed
    }
    /** 10 January: Stripe starts the renewal at 13:00 and takes £40 for it at 14:00. The invoice. */
    function stripeRenewsInJanuary(stripe: FakeStripe): string {
      vi.setSystemTime(new Date('2027-01-10T13:00:00.000Z'))
      stripe.startRenewal(MO_SUBSCRIPTION, FEB_10)
      vi.setSystemTime(new Date('2027-01-10T14:00:00.000Z'))
      // The fake finalises a renewal as a charge that fails; its retry in the same second is the payment going through.
      const january = stripe.renewalFails(MO_SUBSCRIPTION)
      stripe.stripeRetryPays(january.invoice)
      expect(stripe.subscription(MO_SUBSCRIPTION)?.status).toBe('active')
      return january.invoice
    }
    const TWO_PM_JAN_10 = secondsAt('2027-01-10T14:00:00.000Z')

    it("the brief's case: a notice sent again for December (paid a month before the last day) is not listed; Stripe then takes £40 on 10 January, the day after the last day: listed once, with the words to check the subscription; sent again, nothing more; Mark refunded refused, then allowed", async () => {
      await onASeed(async (stripe) => {
        const december = await endedHereStripeLive(stripe)
        const netBefore = stripe.netPence

        // Stripe sends December's notice again (a new delivery): that month was Mo's. Owed, not listed.
        const first = stripe.calls.length
        const again = paidEvent(december.invoice)
        expect(await notice(stripe, again)).toEqual({ status: 200, body: { received: true } })
        expect(await eventRow(again)).toMatchObject({
          outcome: 'processed',
          detail: { found: true, action: 'ignored_cancelled', paid_after_end: { listed: false, why: 'paid_before_last_day', last_day: '2027-01-09', cancelled_here: true, paid_at: FOUR_PM } },
        })
        // The subscription, then (only because the row has ended here) its invoice. Nothing sent.
        expect(methodsSince(stripe, first)).toEqual(['subscriptions.retrieve', 'invoices.retrieve'])
        expect(await invoiceRows()).toEqual([])
        expect(await listed()).toEqual([])
        // And again: still nothing.
        vi.setSystemTime(Date.now() + 1000)
        const third = paidEvent(december.invoice)
        expect(await notice(stripe, third)).toEqual({ status: 200, body: { received: true } })
        expect(await eventRow(third)).toMatchObject({ detail: { paid_after_end: { listed: false, why: 'paid_before_last_day' } } })
        expect(await invoiceRows()).toEqual([])

        // 10 January: Stripe, never told of the cancel, renews and takes £40. Until W47r-c the notice ended at `ignored_cancelled`.
        const invoice = stripeRenewsInJanuary(stripe)
        expect(stripe.netPence).toBe(netBefore + 4000)
        const before = stripe.calls.length
        const event = januaryEvent(invoice)
        expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
        expect(methodsSince(stripe, before)).toEqual(['subscriptions.retrieve', 'invoices.retrieve'])
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
            lastDay: '2027-01-09',
          },
        })
        expect(await eventRow(event)).toMatchObject({
          outcome: 'processed',
          detail: { found: true, action: 'ignored_cancelled', paid_after_end: { listed: true, why: 'listed', listing: listingId, last_day: '2027-01-09', cancelled_here: true, paid_at: TWO_PM_JAN_10 } },
        })
        // Nothing is written to the membership: it stays ended.
        expect(await membership()).toEqual({ status: 'cancelled', renews: '2027-01-10' })

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
          // W47r-d, a named difference: the line's second close, Mark as owed.
          closeOwed: { kind: 'paid_after_end_owed', orderId: listingId },
        }
        const list = await stuckList(db)
        expect(stuckListOutputSchema.safeParse(list).success).toBe(true)
        expect(list.paymentRetries).toEqual([line])

        // The same notice sent again: a duplicate. Another notice for the invoice (a new event id): the line is there already.
        expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true, duplicate: true } })
        vi.setSystemTime(Date.now() + 1000)
        const resent = januaryEvent(invoice)
        expect(await notice(stripe, resent)).toEqual({ status: 200, body: { received: true } })
        expect(await eventRow(resent)).toMatchObject({ outcome: 'processed', detail: { action: 'ignored_cancelled', paid_after_end: { listed: false, why: 'already_listed' } } })
        expect(await invoiceRows()).toHaveLength(1)
        // December's notice once more, now that January's invoice is the newest: not a payment to record (W46b), and no invoice read.
        const old = stripe.calls.length
        expect(await dispatchStripeEvent(paidEvent(december.invoice), webhookRpc(db), stripe, lister('evt_december_late'))).toEqual({ outcome: 'ignored', detail: { reason: 'not_latest_invoice' } })
        expect(methodsSince(stripe, old)).toEqual(['subscriptions.retrieve'])
        // A run reads nothing for it and sends nothing.
        const calls = stripe.calls.length
        expect(await retryItems(stripe)).toEqual([])
        expect(writesSince(stripe, calls)).toEqual([])
        expect(await listed()).toEqual([line])

        // Mark refunded: refused while Stripe shows nothing back, allowed once it shows the £40 refunded. It sends nothing.
        expect((await markRefunded(listingId, { email: NO_REFUNDS })).status).toBe(403)
        expect((await markRefunded(listingId)).data).toEqual({
          kind: 'retry_paid_after_end',
          orderId: listingId,
          closed: false,
          reason: 'not_refunded',
          message: 'Stripe shows none of the £40.00 refunded. Nothing was changed. Refund it in Stripe, then press Mark refunded again.',
        })
        expect(await listed()).toEqual([line])
        await stripe.refunds.create({ payment_intent: stripe.invoiceState(invoice).paymentIntent as string })
        const sends = stripe.calls.length
        expect((await markRefunded(listingId)).data).toEqual({ kind: 'retry_paid_after_end', orderId: listingId, closed: true, message: 'Marked as refunded: Stripe shows the £40.00 refunded in full. It is no longer listed.' })
        expect(writesSince(stripe, sends)).toEqual([])
        expect((await invoiceRows()).map((row) => row.details['state'])).toEqual(['listed', 'refunded'])
        expect(await listed()).toEqual([])
        // The invoice's notice handled after that: it has its line, refunded; it is never listed a second time.
        vi.setSystemTime(Date.now() + 1000)
        const late = januaryEvent(invoice)
        expect(await notice(stripe, late)).toEqual({ status: 200, body: { received: true } })
        expect(await eventRow(late)).toMatchObject({ detail: { paid_after_end: { listed: false, why: 'already_listed' } } })
        expect((await invoiceRows()).map((row) => row.details['state'])).toEqual(['listed', 'refunded'])
        expect(await listed()).toEqual([])
      })
    })

    it("the last day, by London's date: paid the day before it is owed; on the day itself, with no last day on the row, or with no time for the payment, it is listed; a paid invoice that took nothing is not", async () => {
      const found = async (stripe: SubscriptionReader, invoice: string, id: string) => (await dispatchStripeEvent(paidEvent(invoice), webhookRpc(db), stripe, lister(id)))?.detail?.['paid_after_end']
      await onASeed(async (stripe) => {
        const december = await endedHereStripeLive(stripe)
        // 23:59:59 on 8 January, the day before the last day: owed.
        stripe.setInvoicePaidAt(december.invoice, secondsAt('2027-01-08T23:59:59.000Z'))
        expect(await found(stripe, december.invoice, 'evt_day_before')).toEqual({ listed: false, why: 'paid_before_last_day', last_day: '2027-01-09', cancelled_here: true, paid_at: secondsAt('2027-01-08T23:59:59.000Z') })
        // Summer: 23:30 UTC on 30 June is 00:30 on 1 July in London. A last day of 2 July: before it. Owed.
        const summer = secondsAt('2027-06-30T23:30:00.000Z')
        stripe.setInvoicePaidAt(december.invoice, summer)
        await endedHere('2027-07-02')
        expect(await found(stripe, december.invoice, 'evt_summer_before')).toMatchObject({ listed: false, why: 'paid_before_last_day', last_day: '2027-07-02' })
        // A paid invoice that took nothing (a £0 one): nothing to give back, whatever the day.
        await endedHere('2026-01-01')
        const nothingTaken: SubscriptionReader = { subscriptions: stripe.subscriptions, invoices: { retrieve: async (id) => ({ ...(await stripe.invoices.retrieve(id)), amount_paid: 0 }) } }
        expect(await found(nothingTaken, december.invoice, 'evt_nothing')).toEqual({ listed: false, why: 'nothing_taken', invoice_status: 'paid', amount_paid: 0 })
        expect(await invoiceRows()).toEqual([])
        // A last day of 1 July: by London's date the payment was on the last day itself (by UTC's, the day before). Listed.
        await endedHere('2027-07-01')
        expect(await found(stripe, december.invoice, 'evt_summer_on')).toMatchObject({ listed: true, why: 'listed', last_day: '2027-07-01', cancelled_here: true, paid_at: summer })
        expect((await invoiceRows()).map((row) => row.details)).toMatchObject([{ state: 'listed', cancelledHere: true, lastDay: '2027-07-01', paidAt: '2027-06-30T23:30:00.000Z', endedAt: null, status: 'active' }])
        expect(await listed()).toMatchObject([{ words: ENDED_HERE_LINE }])
      })
      // Midnight on the last day itself (9 January, 00:00:00): listed.
      await onASeed(async (stripe) => {
        const december = await endedHereStripeLive(stripe)
        stripe.setInvoicePaidAt(december.invoice, secondsAt('2027-01-09T00:00:00.000Z'))
        expect(await found(stripe, december.invoice, 'evt_on_the_day')).toMatchObject({ listed: true, why: 'listed', last_day: '2027-01-09' })
      })
      // A row ended here with no last day (a refunded membership's row has none): it can't be shown the payment came first. Listed.
      await onASeed(async (stripe) => {
        const december = await endedHereStripeLive(stripe)
        await endedHere(null)
        expect(await found(stripe, december.invoice, 'evt_no_last_day')).toMatchObject({ listed: true, why: 'listed', last_day: null, cancelled_here: true })
        expect((await invoiceRows()).map((row) => row.details)).toMatchObject([{ state: 'listed', cancelledHere: true, lastDay: null }])
      })
      // No time for the payment from Stripe: listed.
      await onASeed(async (stripe) => {
        const december = await endedHereStripeLive(stripe)
        stripe.setInvoicePaidAt(december.invoice, null)
        expect(await found(stripe, december.invoice, 'evt_no_paid_at')).toMatchObject({ listed: true, why: 'listed', last_day: '2027-01-09', paid_at: null })
      })
    })

    it("what can't be read or written is an error, so Stripe sends the notice again and it is listed then; a caller that gives no listing gets the handler as it was; a membership that is live here reads no invoice", async () => {
      await onASeed(async (stripe) => {
        await endedHereStripeLive(stripe)
        const invoice = stripeRenewsInJanuary(stripe)
        const event = januaryEvent(invoice)
        // A caller with no listing (every test of another rule): W46's answer exactly, and no invoice read.
        const before = stripe.calls.length
        expect(await dispatchStripeEvent(event, webhookRpc(db), stripe)).toEqual({ outcome: 'processed', detail: { found: true, action: 'ignored_cancelled' } })
        expect(methodsSince(stripe, before)).toEqual(['subscriptions.retrieve'])
        // The invoice can't be read: the notice is an error (500) and nothing is listed.
        stripe.failNext('invoices.retrieve', noAnswer())
        expect(await notice(stripe, event)).toEqual({ status: 500, body: { error: 'Internal server error' } })
        expect(await eventRow(event)).toMatchObject({ outcome: 'error' })
        expect(await invoiceRows()).toEqual([])
        // The line can't be written (the database): an error too.
        expect(await processWebhookEvent(event, webhookClient(db), stripe, async () => Promise.reject(new Error('the database is away')))).toEqual({ status: 500, body: { error: 'Internal server error' } })
        expect(await eventRow(event)).toMatchObject({ outcome: 'error', error: 'the database is away' })
        // A listing with no way to read the invoice is a wiring fault, and loud.
        await expect(dispatchStripeEvent(event, webhookRpc(db), { subscriptions: stripe.subscriptions }, lister('evt_unwired'))).rejects.toThrow(/has ended here and its invoice .* can't be read: no invoice read was given/)
        // "No such invoice" for a test-mode notice (test data since deleted): said, and not an error. For a live one it is an error.
        const gone: SubscriptionReader = { subscriptions: stripe.subscriptions, invoices: { retrieve: async () => Promise.reject(fakeStripeErrors.missing(`invoice: '${invoice}'`)) } }
        expect(await dispatchStripeEvent(event, webhookRpc(db), gone, lister('evt_gone'))).toMatchObject({ outcome: 'processed', detail: { action: 'ignored_cancelled', paid_after_end: { listed: false, why: 'invoice_missing' } } })
        await expect(dispatchStripeEvent(asLive(event), webhookRpc(db), gone, lister('evt_gone_live'))).rejects.toThrow()
        expect(await invoiceRows()).toEqual([])
        // Stripe sends the notice again: handled, and listed once.
        expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
        expect(await eventRow(event)).toMatchObject({ outcome: 'processed', error: null, detail: { action: 'ignored_cancelled', paid_after_end: { listed: true } } })
        expect(await invoiceRows()).toHaveLength(1)
        expect(await listed()).toHaveLength(1)
      })
      // The same renewal for a membership that is live here: recorded as paid, as ever; the invoice is not read and nothing is listed.
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        stripe.stripeRetryPays(failed.invoice)
        expect(await dispatchStripeEvent(paidEvent(failed.invoice), webhookRpc(db), stripe)).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated' } })
        const invoice = stripeRenewsInJanuary(stripe)
        const before = stripe.calls.length
        const event = januaryEvent(invoice)
        expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
        const row = await eventRow(event)
        expect(row).toMatchObject({ outcome: 'processed', detail: { action: 'reactivated' } })
        expect(row?.detail && 'paid_after_end' in row.detail).toBe(false)
        expect(methodsSince(stripe, before)).toEqual(['subscriptions.retrieve', 'subscriptions.retrieve'])
        expect(await invoiceRows()).toEqual([])
        expect(await membership()).toEqual({ status: 'active', renews: '2027-02-10' })
      })
    })

    it("through the press (already paid before the press, and the row ended here before the press's write): the press lists it by the same line and says where the button is; Stripe's notice afterwards adds nothing", async () => {
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        stripe.stripeRetryPays(failed.invoice)
        expect((await quote()).data).toMatchObject({ refusal: null, alreadyPaid: true, invoiceId: failed.invoice })
        // The press reads the row past due and Stripe's invoice paid; the row is then ended here (its last day yesterday) before the write.
        replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', async () => {
          await endedHere('2026-12-09')
        })
        const before = stripe.calls.length
        const answer = await press({ confirmed: { invoiceId: failed.invoice, amount: 0 } })
        replayStripe.current = stripe
        expect(answer.status).toBe(200)
        expect(answer.data).toMatchObject({
          retryId: null,
          alreadyPaid: true,
          amountCharged: 0,
          membershipUpdated: false,
          message:
            'Stripe shows this payment had already gone through (one of its own retries got there first), so nothing was charged by this press. The membership here was not changed: it has ended here, so the payment Stripe took for it has nothing to pay for. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded on the Orders page.',
        })
        expect(writesSince(stripe, before)).toEqual([])
        const rows = await invoiceRows()
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ actor_type: 'staff', entity_id: failed.invoice, details: { state: 'listed', how: 'retry', amount: 40, status: 'active', cancelledHere: true, lastDay: '2026-12-09', endedAt: null } })
        expect(await listed()).toMatchObject([{ invoiceId: failed.invoice, amount: 40, cardLast4: null, reason: 'paid_after_end', words: ENDED_HERE_LINE, close: { kind: 'retry_paid_after_end' } }])
        const event = paidEvent(failed.invoice)
        expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
        expect(await eventRow(event)).toMatchObject({ outcome: 'processed', detail: { paid_after_end: { listed: false, why: 'already_listed' } } })
        expect(await invoiceRows()).toHaveLength(1)
        expect(pays(stripe)).toEqual([])
      })
    })

    it("through the staff app's own wrappers: the Orders page's list carries the line and its Mark refunded; the close wrapper reaches the Worker, which refuses until Stripe shows the refund", async () => {
      await onASeed(async (stripe) => {
        await endedHereStripeLive(stripe)
        const invoice = stripeRenewsInJanuary(stripe)
        expect(await notice(stripe, januaryEvent(invoice))).toEqual({ status: 200, body: { received: true } })
        const stuck = async () => ((await throughStaffApp('getStuckReaderPayments')(db, {})) as { paymentRetries: Array<{ retryId: string; close?: { kind: string; orderId: string } }> }).paymentRetries
        const [line] = await stuck()
        expect(line).toMatchObject({ customerName: 'Mo Member', invoiceId: invoice, amount: 40, cardLast4: null, reason: 'paid_after_end', words: ENDED_HERE_LINE, close: { kind: 'retry_paid_after_end', orderId: line?.retryId } })
        const close = () => {
          vi.setSystemTime(Date.now() + 1000)
          return throughStaffApp('closeStuckOrder')(db, { ...line?.close, reason: 'Refunded in Stripe by the manager', idempotencyKey: crypto.randomUUID() })
        }
        expect(await close()).toMatchObject({ closed: false, kind: 'retry_paid_after_end', reason: 'not_refunded' })
        await stripe.refunds.create({ payment_intent: stripe.invoiceState(invoice).paymentIntent as string })
        expect(await close()).toMatchObject({ closed: true, kind: 'retry_paid_after_end', orderId: line?.retryId })
        expect(await stuck()).toEqual([])
      })
    })

    it('the words: the line for a row ended here adds checking the subscription; the press goes by what the write found', () => {
      expect(PAYMENT_RETRY_WORDS.invoicePaidAfterEnd(40, true)).toBe(ENDED_HERE_LINE)
      // Stripe's subscription ended: W47r-b's sentence, unchanged.
      expect(PAYMENT_RETRY_WORDS.invoicePaidAfterEnd(40)).toBe("£40.00 was taken by Stripe after this membership's subscription had ended. Refund it in Stripe (tell a manager), then press Mark refunded.")
      expect(PAYMENT_RETRY_WORDS.invoicePaidAfterEnd(40, false)).toBe(PAYMENT_RETRY_WORDS.invoicePaidAfterEnd(40))
      const endedHereWords = PAYMENT_RETRY_WORDS.notUpdated.ignored_cancelled
      const listedSentence = 'it has ended here, so the payment Stripe took for it has nothing to pay for. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded on the Orders page.'
      for (const why of ['listed', 'already_listed', 'retry_holds']) expect(endedHereWords(why), why).toBe(listedSentence)
      expect(endedHereWords('paid_before_last_day')).toBe(
        'it has ended here, and the payment was taken before its last day, so it paid for time the member had. Nothing needs refunding. Tell a manager to check the subscription is cancelled in Stripe.'
      )
      expect(endedHereWords('nothing_taken')).toBe('it has ended here, and nothing was taken for this invoice. Nothing needs refunding. Tell a manager to check the subscription is cancelled in Stripe.')
      // Not listed and not shown to be owed (no listing asked, the invoice gone in test mode): W47r-a's words.
      for (const why of ['invoice_missing', 'no_membership', null]) expect(endedHereWords(why), String(why)).toBe('it has ended here. Tell a manager: the payment may need refunding in Stripe.')
      expect(endedHereWords()).toBe('it has ended here. Tell a manager: the payment may need refunding in Stripe.')
    })
  })
})

// Brief W47r-d (W47r-c "Noticed" 1 to 3), the retry's side. (The webhook's side, migration 031 on Mo's January dates
// and the listed invoice's Mark as owed are in cancelled-here.test.ts.) (1) With migration 031 the paid write answers
// `ignored_cancelled` for a row whose last day has passed: the press and reconcile read it as they read a row ended
// here, and hold the payment for a person. (2) A retry held because its row had ended here, with a last day on or
// before the payment, stays held by the listing's own rule once the subscription is cancelled in Stripe. (3) Mark as
// owed ends a retry held as paid after the end, with a reason, no Stripe call, and its invoice is never listed again.
describe("W47r-d: the retry reads 031's answer, and Mark as owed ends a held retry", () => {
  const HELD_HERE_PRESS = '£40.00 was taken on the card ending 4444 after this membership had ended here. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded on the Orders page.'
  const HELD_HERE_LINE = '£40.00 was taken on the card ending 4444 after this membership had ended here. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded.'
  const OWED_REASON = 'The payment was for December, which Mo had'
  /** 10 December 2026, 16:00:00: where `renewalHasFailed` leaves the clock. A press is made a second later. */
  const FOUR_PM = Date.parse('2026-12-10T16:00:00.000Z') / 1000
  const lister = (requestId: string) => listPaidAfterEnd(db, { actor: { type: 'system', id: null }, requestId }, 'webhook')
  const notice = (stripe: SubscriptionReader, event: Stripe.Event) => processWebhookEvent(event, webhookClient(db), stripe, lister(event.id))
  const eventRow = (event: Stripe.Event) => webhookClient(db).eventRow(event.id)
  const invoiceRows = () => audited(INVOICE_PAID_AFTER_END_ACTION)
  /** What Cancel writes here (memberships/cancel.ts, M1): the last day only; the status stays as it is. */
  const lastDayIs = (lastDay: string) => db.query('UPDATE customer_memberships SET cancel_effective_date = $1::date WHERE id = $2', [lastDay, ID.membership])
  /** `work` with `membership_mark_paid` as 031 leaves it, or as it was before; the saved function is put back after. */
  async function withFunction(with031: boolean, work: () => Promise<void>): Promise<void> {
    await asOwner(environment.database.pg, with031 ? migration031() : BEFORE_031_SQL)
    try {
      await work()
    } finally {
      await asOwner(environment.database.pg, savedFunctionSql())
    }
  }
  /** Mark as owed through the close route. `reason`: null for a press that sends none. */
  async function markOwed(retryId: string, reason: string | null = OWED_REASON, { email = REPLAY_USER.email, key = crypto.randomUUID() as string } = {}): Promise<Answer> {
    vi.setSystemTime(Date.now() + 1000)
    return read(
      await closeRoute(
        new Request('https://worker.test/api/v1/staff/orders/stuck/close', { method: 'POST', headers: headers(email, key), body: JSON.stringify({ kind: 'paid_after_end_owed', orderId: retryId, ...(reason === null ? {} : { reason }) }) })
      )
    )
  }
  /** A retry held as paid after the end: the subscription is cancelled in Stripe at 16:00:00 and the press takes £40 at 16:00:01. Its id. */
  async function heldAfterTheEnd(stripe: FakeStripe, failed: Failed): Promise<string> {
    vi.setSystemTime(new Date('2026-12-10T15:59:59.000Z'))
    replayStripe.current = withAChangeAfter(stripe, 'invoices', 'retrieve', () => {
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      vi.setSystemTime(new Date('2026-12-10T16:00:01.000Z'))
    })
    const answer = await pressShown(failed.invoice)
    replayStripe.current = stripe
    expect(answer.error?.details?.reason).toBe('paid_after_end')
    return answer.error?.details?.held?.retryId as string
  }

  describe('migration 031 and the retry', () => {
    it.each([
      ['before 031', false],
      ['with 031', true],
    ] as const)(
      "%s: the last day passes while the press's charge is at Stripe (Cancel pressed here, last day 9 December, the row still past due). With 031 the paid write answers `ignored_cancelled`: nothing is written to the membership, the record is held `paid_after_end` for a person, and the press says to refund it. Before 031 the payment is recorded and the record ends `paid`",
      async (_name, with031) => {
        await withFunction(with031, () =>
          onASeed(async (stripe) => {
            const failed = await renewalHasFailed(stripe)
            replayStripe.current = withAChangeAfter(stripe, 'invoices', 'pay', async () => {
              await lastDayIs('2026-12-09')
            })
            const answer = await pressShown(failed.invoice)
            replayStripe.current = stripe
            expect(stripe.netPence).toBe(4000)
            if (!with031) {
              expect(answer.status).toBe(200)
              expect(await states()).toEqual(['started', 'paid'])
              expect(await membership()).toEqual({ status: 'active', renews: '2027-01-10' })
              expect((await booking(failed.fifteenth))?.status).toBe('confirmed')
              expect(await listed()).toEqual([])
              return
            }
            expect(refusalOf(answer)).toEqual([502, 'PAYMENT_UNCONFIRMED', 'paid_after_end', HELD_HERE_PRESS])
            const retryId = answer.error?.details?.held?.retryId as string
            expect(await states()).toEqual(['started', 'held'])
            expect((await retryRows())[1]?.details).toMatchObject({ reason: 'paid_after_end', cancelledHere: true, detail: `invoice ${failed.invoice} is paid; the membership here has ended` })
            // Nothing written to the membership: still past due, its next payment date unmoved, its bookings still waiting.
            expect(await membership()).toEqual({ status: 'past_due', renews: '2026-12-10' })
            expect((await booking(failed.eleventh))?.status).toBe('payment_needed')
            expect((await booking(failed.fifteenth))?.status).toBe('payment_needed')
            // One line: the record's own, with both closes. The listing wrote nothing beside it.
            expect(await invoiceRows()).toEqual([])
            expect(await listed()).toMatchObject([
              { retryId, reason: 'paid_after_end', cardLast4: '4444', words: HELD_HERE_LINE, close: { kind: 'retry_paid_after_end', orderId: retryId }, closeOwed: { kind: 'paid_after_end_owed', orderId: retryId } },
            ])
            // A run reads it and leaves it; Stripe's own notice for the invoice lists nothing beside it.
            expect(await retryItems(stripe)).toMatchObject([{ id: retryId, outcome: 'left', reason: 'paid_after_end' }])
            const event = paidEvent(failed.invoice)
            expect(await notice(stripe, event)).toEqual({ status: 200, body: { received: true } })
            expect((await eventRow(event))?.detail).toEqual({ found: true, action: 'ignored_cancelled', last_day: '2026-12-09', paid_after_end: { listed: false, why: 'retry_holds', cancelled_here: true, paid_at: FOUR_PM + 1 } })
            expect(await invoiceRows()).toEqual([])
            expect(await states()).toEqual(['started', 'held'])
          })
        )
      }
    )

    it("with 031, reconcile: a press that got no answer is held; the last day passes; the run finds the invoice paid, the paid write answers `ignored_cancelled`, and the record is left `paid_after_end` for a person (never ended `paid`), with nothing written to the membership", async () => {
      await withFunction(true, () =>
        onASeed(async (stripe) => {
          const failed = await renewalHasFailed(stripe)
          stripe.nextPayEnds(failed.invoice, 'requires_action')
          const retryId = (await pressShown(failed.invoice)).error?.details?.held?.retryId as string
          expect(await states()).toEqual(['started', 'held'])
          // Cancel is pressed here with the last day today; the customer approves the payment the next morning.
          await lastDayIs('2026-12-10')
          vi.setSystemTime(new Date('2026-12-11T09:00:00.000Z'))
          stripe.settleInvoicePayment(failed.invoice, 'succeeded')
          const before = stripe.calls.length
          expect(await retryItems(stripe)).toMatchObject([{ kind: 'payment_retry', id: retryId, outcome: 'left', reason: 'paid_after_end', detail: `invoice ${failed.invoice} is paid; the membership here has ended` }])
          expect(writesSince(stripe, before)).toEqual([])
          expect(await states()).toEqual(['started', 'held', 'held'])
          expect((await retryRows())[2]?.details).toMatchObject({ reason: 'paid_after_end', cancelledHere: true })
          expect(await membership()).toEqual({ status: 'past_due', renews: '2026-12-10' })
          expect((await booking(failed.fifteenth))?.status).toBe('payment_needed')
          expect(await listed()).toMatchObject([{ retryId, reason: 'paid_after_end', words: HELD_HERE_LINE, closeOwed: { kind: 'paid_after_end_owed', orderId: retryId } }])
          expect(await invoiceRows()).toEqual([])
        })
      )
    })
  })

  describe('item 2 and a retry: held by the last day once the subscription is cancelled in Stripe', () => {
    it("held because the row had ended here with its last day yesterday; a manager then cancels the subscription in Stripe (as the line's words ask). Stripe now shows the payment before the end, but the last day here shows it was after: the run keeps it held by that rule, and Stripe's notice lists nothing beside it", async () => {
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        replayStripe.current = withAChangeAfter(stripe, 'invoices', 'pay', async () => {
          await db.query("UPDATE customer_memberships SET subscription_status = 'cancelled', cancel_effective_date = '2026-12-09' WHERE id = $1", [ID.membership])
        })
        const answer = await pressShown(failed.invoice)
        replayStripe.current = stripe
        const retryId = answer.error?.details?.held?.retryId as string
        expect((await retryRows())[1]?.details).toMatchObject({ reason: 'paid_after_end', cancelledHere: true })
        vi.setSystemTime(Date.now() + 60_000)
        stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
        // Until W47r-d only W47r-c's guard kept this held ("held for a refund since an earlier look").
        expect(await retryItems(stripe)).toEqual([{ kind: 'payment_retry', id: retryId, outcome: 'left', reason: 'paid_after_end', detail: `invoice ${failed.invoice} is paid; Stripe shows the subscription as canceled` }])
        expect(await states()).toEqual(['started', 'held'])
        const late = paidEvent(failed.invoice)
        expect(await notice(stripe, late)).toEqual({ status: 200, body: { received: true } })
        expect((await eventRow(late))?.detail).toMatchObject({ reason: 'subscription_not_paid_up', status: 'canceled', paid_after_end: { listed: false, why: 'retry_holds' } })
        expect(await invoiceRows()).toEqual([])
        expect(await listed()).toMatchObject([{ retryId, reason: 'paid_after_end' }])
      })
    })
  })

  describe('item 3: Mark as owed on a retry held as paid after the end', () => {
    it('refused, with nothing written and Stripe never asked: without Issue refunds (403); with no reason or one under five characters (400); a retry on hold for any other reason (it has no such button, and the close says so)', async () => {
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        const retryId = await heldAfterTheEnd(stripe, failed)
        const calls = stripe.calls.length
        const clients = stripeClientsMade.length
        expect((await markOwed(retryId, OWED_REASON, { email: NO_REFUNDS })).status).toBe(403)
        for (const reason of [null, '', 'owed']) {
          const answer = await markOwed(retryId, reason)
          expect([reason, answer.status, answer.error?.code]).toEqual([reason, 400, 'VALIDATION'])
        }
        expect(await states()).toEqual(['started', 'held'])
        expect(await audited(CLOSE_ACTION)).toEqual([])
        expect(await listed()).toHaveLength(1)
        expect(stripe.calls.length).toBe(calls)
        expect(stripeClientsMade.length).toBe(clients)
      })
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        stripe.nextPayEnds(failed.invoice, 'requires_action')
        const retryId = (await pressShown(failed.invoice)).error?.details?.held?.retryId as string
        const line = (await listed())[0]
        // Not yet read by a run: listed as waiting, with no close of either kind.
        expect(line).toMatchObject({ retryId, reason: 'waiting' })
        expect(line).not.toHaveProperty('close')
        expect(line).not.toHaveProperty('closeOwed')
        expect((await markOwed(retryId)).data).toEqual({
          kind: 'paid_after_end_owed',
          orderId: retryId,
          closed: false,
          reason: 'not_paid_after_end',
          message: "This payment isn't one taken after its membership had ended, so it can't be marked as owed: the automatic check finishes it from what Stripe shows. Nothing was changed.",
        })
        expect(await states()).toEqual(['started', 'held'])
        expect(await audited(CLOSE_ACTION)).toEqual([])
      })
    })

    it("Mark as owed with Issue refunds and a reason: the record ends `owed`, the reason is on its row and on the `order.close` row, Stripe is never called, and it is no longer listed; pressed again it answers 'already'; Mark refunded then finds it gone; a run leaves it alone; Stripe's notice for the invoice never lists it again", async () => {
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        const retryId = await heldAfterTheEnd(stripe, failed)
        expect(await listed()).toMatchObject([{ retryId, close: { kind: 'retry_paid_after_end', orderId: retryId }, closeOwed: { kind: 'paid_after_end_owed', orderId: retryId } }])
        const calls = stripe.calls.length
        const clients = stripeClientsMade.length
        const answer = await markOwed(retryId)
        expect(answer.status).toBe(200)
        expect(answer.data).toEqual({
          kind: 'paid_after_end_owed',
          orderId: retryId,
          closed: true,
          message: 'Marked as owed: the £40.00 is recorded, with your reason, as a payment for a period the member had. Nothing was refunded. It is no longer listed.',
        })
        expect(stripe.calls.length).toBe(calls)
        expect(stripeClientsMade.length).toBe(clients)
        expect(stripe.netPence).toBe(4000)
        expect(await states()).toEqual(['started', 'held', 'owed'])
        const rows = await retryRows()
        expect(rows[2]).toMatchObject({ actor_type: 'staff', actor_id: ID.staff, entity_id: ID.membership })
        expect(rows[2]?.details).toEqual({ retryId, state: 'owed', how: 'close', why: OWED_REASON, invoiceId: failed.invoice, amount: 40 })
        expect(await audited(CLOSE_ACTION)).toEqual([
          {
            action: CLOSE_ACTION,
            actor_type: 'staff',
            actor_id: ID.staff,
            entity_type: 'payment_retry',
            entity_id: retryId,
            details: { kind: 'paid_after_end_owed', why: OWED_REASON, membershipId: ID.membership, invoiceId: failed.invoice, amount: 40 },
          },
        ])
        expect(await listed()).toEqual([])

        expect((await markOwed(retryId)).data).toEqual({ kind: 'paid_after_end_owed', orderId: retryId, closed: true, alreadyClosed: true, message: 'This was already marked as owed (an earlier press went through). Nothing more was done.' })
        expect((await markRefunded(retryId)).data).toMatchObject({ closed: false, reason: 'not_listed' })
        expect(await states()).toEqual(['started', 'held', 'owed'])
        expect(await audited(CLOSE_ACTION)).toHaveLength(1)
        // A run has nothing to read for it; the invoice's notice finds the retry's record still holds the invoice.
        const before = stripe.calls.length
        expect(await retryItems(stripe)).toEqual([])
        expect(stripe.calls.length).toBe(before)
        const late = paidEvent(failed.invoice)
        expect(await notice(stripe, late)).toEqual({ status: 200, body: { received: true } })
        expect((await eventRow(late))?.detail).toMatchObject({ paid_after_end: { listed: false, why: 'retry_holds' } })
        expect(await invoiceRows()).toEqual([])
        expect(await listed()).toEqual([])
      })
    })

    it('a retry already marked refunded can no longer be marked as owed, and nothing more is written', async () => {
      await onASeed(async (stripe) => {
        const failed = await renewalHasFailed(stripe)
        const retryId = await heldAfterTheEnd(stripe, failed)
        await stripe.refunds.create({ payment_intent: stripe.invoiceState(failed.invoice).paymentIntent as string })
        expect((await markRefunded(retryId)).data).toMatchObject({ closed: true })
        expect((await markOwed(retryId)).data).toEqual({ kind: 'paid_after_end_owed', orderId: retryId, closed: false, reason: 'not_listed', message: 'This payment is no longer on the list (it was settled in the meantime). Nothing was changed.' })
        expect(await states()).toEqual(['started', 'held', 'refunded'])
        expect((await audited(CLOSE_ACTION)).map((row) => row.details['kind'])).toEqual(['retry_paid_after_end'])
      })
    })
  })
})
