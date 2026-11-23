import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { dispatchStripeEvent } from '@/app/api/stripe/webhook/dispatch'
import { POST as cancelRoute } from '@/app/api/v1/staff/memberships/[membershipId]/cancel/route'
import { GET as quoteRoute } from '@/app/api/v1/staff/memberships/[membershipId]/payment-date/quote/route'
import { POST as changeRoute } from '@/app/api/v1/staff/memberships/[membershipId]/payment-date/route'
import { POST as undoRoute } from '@/app/api/v1/staff/memberships/[membershipId]/undo-cancel/route'
import { GET as listRoute } from '@/app/api/v1/staff/memberships/route'
import { changePaymentDateOutputSchema, paymentDateQuoteOutputSchema } from '@/contracts'
import type { Db } from '@/server/db'
import { CARD_FLOW_PAID_NOT_FINISHED_MESSAGE, CHANGE_PAYMENT_UNCONFIRMED_MESSAGE } from '@/server/rules/bookings/failure-messages'
import { closeStuckItem } from '@/server/rules/orders/close-stuck'
import { ORDER_STILL_PROCESSING_MESSAGE } from '@/server/rules/orders/failure-messages'
import { reconcile } from '@/server/rules/orders/reconcile'
import { STUCK_WORDS, stuckList, WATCH_WORDS } from '@/server/rules/orders/stuck-list'
import { REFUND_WATCH } from '@/server/rules/refunds/refund-watch'
import { insert } from '@/server/rules/testing/database'
import { TABLES } from '@/server/rules/testing/replay/compare'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { ID, MO_SUBSCRIPTION, seed, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { invoiceEvent, webhookRpc } from '@/server/rules/testing/webhook'
import type { StripeClient } from '@/server/stripe/client'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import {
  MEMBERSHIP_CANCEL_NEW_WORDS,
  MEMBERSHIP_PATH_OFF_MESSAGE,
  PAYMENT_DATE_CLOSE_WORDS,
  PAYMENT_DATE_HELD_MESSAGE,
  PAYMENT_DATE_NEW_WORDS,
  PAYMENT_DATE_REFUSALS,
  PAYMENT_DATE_STUCK_WORDS,
  PAYMENT_DATE_NOT_SENT_STUCK_WORDS,
  PAYMENT_DATE_WORDS,
} from './failure-messages'
import { checkSubscription, londonMidnightSeconds, ORDER_PROCESSING_SQL, PAYMENT_DATE_ACTION, PAYMENT_DATE_CLOSE_REASONS, PAYMENT_DATE_REFUND_WATCH_STEP, paymentStillGoingReason } from './payment-date'

// Brief W41 items 2 to 6 and 9 (F-plan 4.4, 4.10; bugs FB1 to FB4; Q10; Q18; R7): a membership's payment date change
// through the Worker's routes, on the replay's live schema with the fake Stripe. What must hold: the record is
// written before anything is asked of Stripe; the card is charged at most once whatever is lost, repeated or raced;
// a charge with no clear answer is held and settled by reconcile, which never charges; a date Stripe refuses to move
// gives the charge back once, watched; the order, the new date and the record are one transaction; and a pending
// record holds the membership.
//
// Mo pays £40 a month, renewing 10 December 2026; today is 10 November. Moving the payment date to 27 December is 17
// extra days of a 31-day period: 40 x 17 / 31 = £21.94.

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
const MEMBER_STRIPE_CUSTOMER = 'cus_member'
const MONTHLY_PRICE = 'price_seed_monthly'
const NEW_DATE = '2026-12-27'
const AMOUNT = 21.94
/** 27 December 2026, 00:00 in London (GMT). */
const TRIAL_END = Date.UTC(2026, 11, 27) / 1000
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

/** The replay's seed with Mo's membership as live ones are (a Stripe subscription, its next payment on 10 December), two more staff, then `prepare`, then `work`. */
async function onASeed(work: (stripe: FakeStripe) => Promise<void>, prepare?: Prepare): Promise<void> {
  await replay(
    environment,
    {
      name: 'w41 payment date',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await seedDb.query("UPDATE customer_memberships SET stripe_subscription_id = $1, next_renewal_date = '2026-12-10' WHERE id = $2", [MO_SUBSCRIPTION, ID.membership])
        stripe.addSubscription(MO_SUBSCRIPTION, MEMBER_STRIPE_CUSTOMER, MONTHLY_PRICE)
        await insert(seedDb, 'staff', { first_name: 'Fran', last_name: 'Desk', email: NO_REFUNDS, role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
        await insert(seedDb, 'staff', { first_name: 'Gone', last_name: 'Away', email: INACTIVE, role: 'staff', can_issue_refunds: true, can_manage_pricing: true, active: false })
        await prepare?.(seedDb, stripe)
      },
      async run({ stripe }) {
        replayStripe.current = stripe
        // These presses run with the kind on.
        // W41a: the date change's own kind; `membership_changes` is on for the cancel and undo presses these tests make.
        vi.stubEnv('ORDER_SWITCH', 'membership_changes,payment_date_changes')
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

type ErrorBody = { code: string; message: string; details?: { reason?: string; message?: string; action?: string; held?: { changeId: string }; quote?: { amount?: number }; kinds?: string[] } }
type Answer = { status: number; replayed: boolean; data?: Record<string, unknown>; error?: ErrorBody }
type PressBody = { newRenewalDate?: string | null; override?: boolean; overrideReason?: string; confirmed?: { amount: number } }
const BODY: PressBody = { newRenewalDate: NEW_DATE, confirmed: { amount: AMOUNT } }

async function read(response: Response): Promise<Answer> {
  const body = (await response.json()) as { data?: Record<string, unknown>; error?: ErrorBody }
  return { status: response.status, replayed: response.headers.get('Idempotency-Replayed') === 'true', ...body }
}
const headers = (email: string, key?: string | null) => ({ authorization: `Bearer ${KEY}`, 'x-staff-email': email, ...(key ? { 'idempotency-key': key } : {}), 'content-type': 'application/json' })

async function press(body: PressBody = BODY, { membershipId = ID.membership as string, email = REPLAY_USER.email, key = crypto.randomUUID() as string | null } = {}): Promise<Answer> {
  // The replay holds the clock still (Postgres's too): moved on between presses, so rows read in time order keep theirs.
  vi.setSystemTime(Date.now() + 1000)
  return read(
    await changeRoute(new Request(`https://worker.test/api/v1/staff/memberships/${membershipId}/payment-date`, { method: 'POST', headers: headers(email, key), body: JSON.stringify(body) }), {
      params: Promise.resolve({ membershipId }),
    })
  )
}
async function quote(newRenewalDate?: string, { membershipId = ID.membership as string, email = REPLAY_USER.email } = {}): Promise<Answer> {
  const query = newRenewalDate === undefined ? '' : `?newRenewalDate=${encodeURIComponent(newRenewalDate)}`
  return read(await quoteRoute(new Request(`https://worker.test/api/v1/staff/memberships/${membershipId}/payment-date/quote${query}`, { headers: headers(email) }), { params: Promise.resolve({ membershipId }) }))
}
async function cancelPress(route: 'cancel' | 'undo-cancel'): Promise<Answer> {
  vi.setSystemTime(Date.now() + 1000)
  return read(
    await (route === 'cancel' ? cancelRoute : undoRoute)(new Request(`https://worker.test/api/v1/staff/memberships/${ID.membership}/${route}`, { method: 'POST', headers: headers(REPLAY_USER.email, crypto.randomUUID()), body: '{}' }), {
      params: Promise.resolve({ membershipId: ID.membership }),
    })
  )
}
const refusalOf = (answer: Answer) => [answer.status, answer.error?.code, answer.error?.details?.reason, answer.error?.details?.message]

type ChangeRow = { id: string; status: string; stripe_payment_intent_id: string | null; order_id: string | null; failure_message: string | null; override_reason: string | null; staff_id: string | null; amount_charged: string; old: string; new: string; extra_days: number }
const changes = () =>
  db.query<ChangeRow>(
    'SELECT id, status, stripe_payment_intent_id, order_id, failure_message, override_reason, staff_id, amount_charged::text, old_renewal_date::text AS old, new_renewal_date::text AS new, extra_days FROM membership_payment_date_changes ORDER BY created_at, id'
  )
const renewal = async () => (await db.query<{ d: string | null }>('SELECT next_renewal_date::text AS d FROM customer_memberships WHERE id = $1', [ID.membership]))[0]?.d ?? null
const orders = () => db.query<{ id: string; order_total: string; payment_status: string; stripe_payment_intent_id: string | null; payment_method: string | null; order_source: string | null }>('SELECT id, order_total::text, payment_status, stripe_payment_intent_id, payment_method, order_source FROM orders ORDER BY created_at, id')
const lines = () => db.query<{ order_id: string; item_type: string; quantity: number; unit_price: string; line_total: string; membership_plan_id: string | null }>('SELECT order_id, item_type, quantity, unit_price::text, line_total::text, membership_plan_id FROM order_line_items')
type AuditRow = { action: string; actor_type: string; actor_id: string | null; entity_type: string; entity_id: string; details: Record<string, unknown> }
const audited = (action: string) => db.query<AuditRow>('SELECT action, actor_type, actor_id, entity_type, entity_id, details FROM audit_log WHERE action = $1 ORDER BY at, ctid', [action])
const states = async () => (await audited(PAYMENT_DATE_ACTION)).map((row) => row.details['state'] as string)
const callsOf = (stripe: FakeStripe, method: string) => stripe.calls.filter((call) => call.method === method)
const paramsOf = (call: { params: unknown } | undefined): Record<string, unknown> => (call?.params ?? {}) as Record<string, unknown>
const charges = (stripe: FakeStripe) => callsOf(stripe, 'paymentIntents.create')
const moves = (stripe: FakeStripe) => callsOf(stripe, 'subscriptions.update')
const refunds = (stripe: FakeStripe) => callsOf(stripe, 'refunds.create')
/** The payments the fake holds for Mo: what was really taken, however many sends there were. */
const taken = async (stripe: FakeStripe) => (await stripe.paymentIntents.list({ customer: MEMBER_STRIPE_CUSTOMER, limit: 100 })).data.filter((intent) => intent.status === 'succeeded')
const listed = async () => (await stuckList(db)).paymentDates
const reconcileNow = (stripe: FakeStripe, requestId: string = crypto.randomUUID()) => reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId, maxItems: 50, budgetMs: 60_000 })
const dateItems = async (stripe: FakeStripe) => (await reconcileNow(stripe)).items.filter((item) => item.kind === 'date_change')
const noAnswer = () => ({ kind: 'error' as const, error: fakeStripeErrors.server() })
const no = () => ({ kind: 'error' as const, error: fakeStripeErrors.invalid('subscription_update_refused', 'This subscription cannot be updated right now.') })
const set = (sql: string, params: unknown[] = [ID.membership]): Prepare => async (seedDb) => void (await seedDb.query(sql, params as never[]))
const earlier = (fields: Record<string, unknown>): Prepare => async (seedDb) => {
  await insert(seedDb, 'membership_payment_date_changes', { membership_id: ID.membership, old_renewal_date: '2026-09-10', new_renewal_date: '2026-09-15', extra_days: 5, amount_charged: '6.67', staff_id: ID.staff, ...fields })
}

/**
 * The fake as the route reaches it, dying at a chosen call: the request never gets an answer and nothing after it
 * runs, as when the Worker itself stops. `after`: the call takes effect in Stripe first.
 */
function dyingAt(stripe: FakeStripe, resource: 'subscriptions' | 'paymentIntents', method: string, after: boolean): { client: StripeClient; reached: Promise<void> } {
  let reach: () => void = () => {}
  const reached = new Promise<void>((resolve) => (reach = resolve))
  const real = stripe[resource] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  const wrapped = {
    ...real,
    [method]: async (...args: unknown[]) => {
      if (after) await (real[method] as (...a: unknown[]) => Promise<unknown>)(...args)
      reach()
      return new Promise<never>(() => {})
    },
  }
  return { client: new Proxy(stripe, { get: (target, prop) => (prop === resource ? wrapped : Reflect.get(target, prop)) }) as unknown as StripeClient, reached }
}
/** A press whose Worker dies at a Stripe call: started, never answered. The record it wrote stays as it was at that moment. */
async function pressThatDies(stripe: FakeStripe, resource: 'subscriptions' | 'paymentIntents', method: string, after: boolean): Promise<void> {
  const dying = dyingAt(stripe, resource, method, after)
  replayStripe.current = dying.client
  void press()
  await dying.reached
  replayStripe.current = stripe
}

describe('the quote (brief W41 item 2): the old quote, field for field', () => {
  it('the window alone, then the figure for a picked date; any active staff member; no such membership is NOT_FOUND', async () => {
    await onASeed(async () => {
      const window = await quote()
      const base = {
        membershipId: ID.membership,
        customerId: ID.member,
        planId: ID.plan,
        stripeSubscriptionId: MO_SUBSCRIPTION,
        refusal: null,
        needsOverride: false,
        lastChangedAt: null,
        currentRenewalDate: '2026-12-10',
        earliestDate: '2026-12-11',
        latestDate: '2027-01-09',
        daysInPeriod: 31,
        monthlyPrice: 40,
        cardLast4: '4444',
        cardBrand: 'visa',
      }
      expect(window).toMatchObject({ status: 200 })
      expect(window.data).toEqual(base)
      expect((await quote(NEW_DATE)).data).toEqual({ ...base, newRenewalDate: NEW_DATE, extraDays: 17, amount: AMOUNT })
      expect(paymentDateQuoteOutputSchema.safeParse(window.data).success).toBe(true)
      // Staff without Issue refunds may read it (the button says why they can't press); an inactive account may not.
      expect((await quote(NEW_DATE, { email: NO_REFUNDS })).status).toBe(200)
      expect((await quote(NEW_DATE, { email: INACTIVE })).status).toBe(403)
      expect(refusalOf(await quote(NEW_DATE, { membershipId: crypto.randomUUID() }))).toEqual([404, 'NOT_FOUND', 'membership_not_found', PAYMENT_DATE_WORDS.notFound])
      // Outside the window, and not a date at all: the old words; 30 February is no date (the old read threw).
      for (const date of ['2026-12-10', '2027-01-10', 'next Friday', '2027-02-30']) expect((await quote(date)).data).toEqual({ ...base, dateError: 'Choose a date from 11 Dec 2026 to 9 Jan 2027' })
      // The quote never asks the switch.
      vi.stubEnv('ORDER_SWITCH', '')
      expect((await quote(NEW_DATE)).status).toBe(200)
    })
  })
})

describe('P1 (brief W41 item 3): every refusal, in the old order, with nothing written and nothing asked of Stripe', () => {
  const nothingHappened = async (stripe: FakeStripe) => {
    expect(stripe.calls).toEqual([])
    expect(await changes()).toEqual([])
    expect(await audited(PAYMENT_DATE_ACTION)).toEqual([])
    expect(await renewal()).toBe('2026-12-10')
  }

  it('the switch (W41a: its own kind, `payment_date_changes`): off, the press answers "switched off" before anything is read, whatever `membership_changes` says; on alone, the press is taken and the cancel is the one switched off', async () => {
    await onASeed(async (stripe) => {
      for (const value of ['', 'no_stripe,saved_card', 'membership_changes', 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows,order_refunds,event_cancels,membership_changes']) {
        vi.stubEnv('ORDER_SWITCH', value)
        const off = await press()
        expect([...refusalOf(off), off.error?.details?.kinds], value).toEqual([501, 'MEMBERSHIP_PATH_OFF', 'membership_path_off', MEMBERSHIP_PATH_OFF_MESSAGE, ['payment_date_changes']])
        // Before who may and before the membership is looked for.
        expect((await press(BODY, { email: NO_REFUNDS, membershipId: crypto.randomUUID() })).error?.code, value).toBe('MEMBERSHIP_PATH_OFF')
      }
      await nothingHappened(stripe)
      // The other way round: the date change on, the cancel and undo off. Neither kind stands in for the other.
      vi.stubEnv('ORDER_SWITCH', 'payment_date_changes')
      const cancel = await cancelPress('cancel')
      expect([cancel.error?.code, cancel.error?.details?.kinds]).toEqual(['MEMBERSHIP_PATH_OFF', ['membership_changes']])
      expect((await press()).status).toBe(200)
    })
  })

  it('the params, then who may, then the membership: each before the next', async () => {
    await onASeed(async (stripe) => {
      // No date and no permission: the params first.
      expect(refusalOf(await press({ confirmed: { amount: AMOUNT } }, { email: NO_REFUNDS }))).toEqual([400, 'VALIDATION', 'params_required', PAYMENT_DATE_WORDS.paramsRequired])
      // No permission and no such membership: who may first (FB20: read from the signed-in staff member).
      expect(refusalOf(await press(BODY, { email: NO_REFUNDS, membershipId: crypto.randomUUID() }))).toEqual([403, 'FORBIDDEN', 'permission_denied', PAYMENT_DATE_WORDS.permissionDenied])
      expect((await press(BODY, { email: INACTIVE })).status).toBe(403)
      expect(refusalOf(await press(BODY, { membershipId: crypto.randomUUID() }))).toEqual([404, 'NOT_FOUND', 'membership_not_found', PAYMENT_DATE_WORDS.notFound])
      await nothingHappened(stripe)
    })
  })

  const quoteRefusals: Array<[string, string, Prepare]> = [
    ['yearly', PAYMENT_DATE_REFUSALS.yearly, set("UPDATE customer_memberships SET billing_frequency = 'yearly' WHERE id = $1")],
    ['a payment failing', PAYMENT_DATE_REFUSALS.paymentFailing, set("UPDATE customer_memberships SET subscription_status = 'past_due' WHERE id = $1")],
    ['not active', PAYMENT_DATE_REFUSALS.notActive, set("UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE id = $1")],
    ['a cancellation scheduled', PAYMENT_DATE_REFUSALS.cancelScheduled, set("UPDATE customer_memberships SET cancel_effective_date = '2026-12-09' WHERE id = $1")],
    ['no subscription', PAYMENT_DATE_REFUSALS.noSubscription, set('UPDATE customer_memberships SET stripe_subscription_id = NULL WHERE id = $1')],
    ['no saved card', PAYMENT_DATE_REFUSALS.noSavedCard, set('UPDATE customers SET saved_payment_method_id = NULL WHERE id = $1', [ID.member])],
    ['changed until its new date', 'Changed on 1 Nov 2026. It can be changed again from 10 Dec 2026.', earlier({ status: 'done', created_at: '2026-11-01T09:00:00.000Z', old_renewal_date: '2026-11-20', new_renewal_date: '2026-12-10' })],
    ['one in progress, however old (no 15-minute expiry)', PAYMENT_DATE_REFUSALS.inProgress, earlier({ status: 'pending', created_at: '2026-11-09T09:00:00.000Z', old_renewal_date: '2026-12-10', new_renewal_date: '2026-12-20' })],
    ['no monthly price', PAYMENT_DATE_REFUSALS.noMonthlyPrice, set('UPDATE membership_plans SET price_monthly = NULL WHERE id = $1', [ID.plan])],
  ]
  it.each(quoteRefusals)("the quote's refusal: %s", async (_name, words, prepare) => {
    await onASeed(async (stripe) => {
      const before = (await changes()).length
      expect(refusalOf(await press())).toEqual([409, 'CONFLICT', 'refused', words])
      expect(stripe.calls).toEqual([])
      expect(await changes()).toHaveLength(before)
      expect(await audited(PAYMENT_DATE_ACTION)).toEqual([])
    }, prepare)
  })

  // Brief W41a item 5 (Wayne, 17 Nov 2026). Stripe takes a renewal at the time of day the subscription began, so on
  // the renewal day the month about to be paid for is not yet paid. A date moved then (or a move sent again by
  // reconcile after it, B1) would be moved over that month. So the day itself is refused, as W40a's cancel is.
  describe('the renewal day (brief W41a item 5): refused while the next renewal date is today or earlier in London, in the quote and the press, before anything is written', () => {
    const DUE = "Today's payment for this membership hasn't gone through yet, so its payment date can't be changed until it has. Try again after the payment."
    const renewsOn = (date: string, periodEnd: number): Prepare => async (seedDb, stripe) => {
      await seedDb.query('UPDATE customer_memberships SET next_renewal_date = $1 WHERE id = $2', [date, ID.membership])
      stripe.setSubscription(MO_SUBSCRIPTION, { periodEnd })
    }

    it('the words', () => {
      expect(PAYMENT_DATE_NEW_WORDS.renewalDueToday).toBe(DUE)
    })

    it.each([
      ['today', '2026-11-10'],
      ['yesterday (overdue)', '2026-11-09'],
    ])('the renewal due %s: the quote says why and the press is refused `renewal_due_today`; nothing is written and Stripe is asked nothing', async (_name, date) => {
      await onASeed(
        async (stripe) => {
          expect((await quote()).data).toMatchObject({ refusal: DUE, currentRenewalDate: date })
          expect(refusalOf(await press({ newRenewalDate: '2026-11-27', confirmed: { amount: 22.67 } }))).toEqual([409, 'CONFLICT', 'renewal_due_today', DUE])
          expect(stripe.calls).toEqual([])
          expect(await changes()).toEqual([])
          expect(await audited(PAYMENT_DATE_ACTION)).toEqual([])
        },
        renewsOn(date, Date.UTC(2026, 10, 10, 14, 32) / 1000)
      )
    })

    it('an older refusal still comes first (a yearly membership due today says yearly), and the lists keep their own words', async () => {
      await onASeed(
        async () => {
          expect((await quote()).data).toMatchObject({ refusal: PAYMENT_DATE_REFUSALS.yearly })
          expect(refusalOf(await press())).toEqual([409, 'CONFLICT', 'refused', PAYMENT_DATE_REFUSALS.yearly])
        },
        async (seedDb) => void (await seedDb.query("UPDATE customer_memberships SET next_renewal_date = '2026-11-10', billing_frequency = 'yearly' WHERE id = $1", [ID.membership]))
      )
    })

    it('the day after, once the webhook has moved the renewal on a month: taken', async () => {
      await onASeed(
        async (stripe) => {
          expect(refusalOf(await press())[2]).toBe('renewal_due_today')
          // 14:32, Stripe takes the month's payment; the webhook moves the membership's next renewal to 10 December.
          await db.query("UPDATE customer_memberships SET next_renewal_date = '2026-12-10' WHERE id = $1", [ID.membership])
          stripe.setSubscription(MO_SUBSCRIPTION, { periodEnd: Date.UTC(2026, 11, 10, 14, 32) / 1000 })
          // 11 November, 09:00.
          vi.setSystemTime(Date.now() + 24 * 60 * 60_000)
          expect((await quote(NEW_DATE)).data).toMatchObject({ refusal: null, currentRenewalDate: '2026-12-10', amount: AMOUNT })
          const answer = await press()
          expect(answer).toMatchObject({ status: 200, data: { newRenewalDate: NEW_DATE, amountCharged: AMOUNT } })
          expect(await renewal()).toBe(NEW_DATE)
          expect(charges(stripe)).toHaveLength(1)
        },
        renewsOn('2026-11-10', Date.UTC(2026, 10, 10, 14, 32) / 1000)
      )
    })

    it('the night before (23:30 in London, the renewal tomorrow): taken; half an hour past midnight the same press is refused', async () => {
      // Renewing 11 November: 17 days on is 28 November, of a 30-day period: 40 x 17 / 30 = £22.67.
      const tomorrow = renewsOn('2026-11-11', Date.UTC(2026, 10, 11, 14, 32) / 1000)
      const body = { newRenewalDate: '2026-11-28', confirmed: { amount: 22.67 } }
      const at = (iso: string) => vi.setSystemTime(new Date(iso))
      await onASeed(async (stripe) => {
        at('2026-11-10T23:30:00.000Z')
        expect((await quote('2026-11-28')).data).toMatchObject({ refusal: null, extraDays: 17, amount: 22.67 })
        const answer = await press(body)
        expect(answer).toMatchObject({ status: 200, data: { newRenewalDate: '2026-11-28', amountCharged: 22.67 } })
        expect(await renewal()).toBe('2026-11-28')
        expect(charges(stripe)).toHaveLength(1)
      }, tomorrow)
      await onASeed(async (stripe) => {
        at('2026-11-10T23:30:00.000Z')
        expect((await quote()).data).toMatchObject({ refusal: null })
        at('2026-11-11T00:30:00.000Z')
        expect((await quote()).data).toMatchObject({ refusal: DUE })
        expect(refusalOf(await press(body))).toEqual([409, 'CONFLICT', 'renewal_due_today', DUE])
        expect(stripe.calls).toEqual([])
        expect(await changes()).toEqual([])
      }, tomorrow)
    })
  })

  it('then the window, then nothing to charge, then the six-month rule: each before the next', async () => {
    await onASeed(
      async (stripe) => {
        // A refusal and a date outside the window: the refusal first (checked above); a date outside the window and an override needed: the window.
        expect(refusalOf(await press({ newRenewalDate: '2027-01-10', confirmed: { amount: 40 } }))).toEqual([409, 'CONFLICT', 'date_out_of_range', 'Choose a date from 11 Dec 2026 to 9 Jan 2027'])
        // The six-month rule without Override, with Override and no reason, with a reason of spaces.
        for (const extra of [{}, { override: true }, { override: true, overrideReason: '   ' }]) {
          expect(refusalOf(await press({ ...BODY, ...extra }))).toEqual([409, 'CONFLICT', 'override_needed', PAYMENT_DATE_WORDS.overrideNeeded])
        }
        expect(stripe.calls).toEqual([])
        expect((await changes()).filter((row) => row.status === 'pending')).toEqual([])
      },
      earlier({ status: 'done', created_at: '2026-09-10T09:00:00.000Z' })
    )
    await onASeed(
      async (stripe) => {
        // 10p a month, one day: £0.00.
        expect(refusalOf(await press({ newRenewalDate: '2026-12-11', confirmed: { amount: 0 } }))).toEqual([409, 'CONFLICT', 'nothing_to_charge', PAYMENT_DATE_WORDS.nothingToCharge])
        expect(stripe.calls).toEqual([])
      },
      set("UPDATE membership_plans SET price_monthly = '0.10' WHERE id = $1", [ID.plan])
    )
  })

  it('the six-month override: with a reason the change goes through and the reason is recorded; after six months an override sent anyway is not', async () => {
    await onASeed(
      async () => {
        expect((await press({ ...BODY, override: true, overrideReason: ' Payday moved to the 27th ' })).status).toBe(200)
        expect((await changes()).at(-1)).toMatchObject({ status: 'done', override_reason: 'Payday moved to the 27th' })
        expect((await audited(PAYMENT_DATE_ACTION)).find((row) => row.details['state'] === 'started')?.details).toMatchObject({ state: 'started', override: { reason: 'Payday moved to the 27th' } })
      },
      earlier({ status: 'done', created_at: '2026-09-10T09:00:00.000Z' })
    )
    await onASeed(
      async () => {
        expect((await press({ ...BODY, override: true, overrideReason: 'Not needed' })).status).toBe(200)
        expect((await changes()).at(-1)).toMatchObject({ status: 'done', override_reason: null })
      },
      earlier({ status: 'done', created_at: '2026-04-09T09:00:00.000Z', old_renewal_date: '2026-04-10', new_renewal_date: '2026-04-15' })
    )
  })

  it('Q10 (lead call L8): refused while this customer has a card order on hold, in the order\'s own words, before the figure is looked at; a paid order holds nothing', async () => {
    await onASeed(async (stripe) => {
      const held = await insert(db, 'orders', {
        customer_id: ID.member,
        order_total: '20.00',
        payment_status: 'pending',
        order_source: 'staff_created',
        payment_method: 'card',
        reader_payment: { method: 'card', flow: 'checkout', expected_amount: 20 },
        created_at: '2026-11-09T09:00:00.000Z',
      })
      // The wrong figure too: Q10 first.
      expect(refusalOf(await press({ newRenewalDate: NEW_DATE, confirmed: { amount: 1 } }))).toEqual([409, 'CONFLICT', 'order_still_processing', ORDER_STILL_PROCESSING_MESSAGE])
      expect(PAYMENT_DATE_NEW_WORDS.orderStillProcessing).toBe('This customer has an order still being processed. Check the Orders page before trying again.')
      expect(stripe.calls).toEqual([])
      expect(await changes()).toEqual([])
      // Settled: the same press goes through.
      await db.query("UPDATE orders SET payment_status = 'paid', reader_payment = NULL WHERE id = $1", [held])
      expect((await press()).status).toBe(200)
    })
  })

  it("Q10's test is the order's own, word for word (orders/load-basket.ts)", () => {
    const basket = readFileSync(path.resolve(__dirname, '../orders/load-basket.ts'), 'utf8')
    const condition = "o.payment_status = 'pending'\n                AND (o.reader_payment->>'method' IN ('card', 'reader') OR o.created_at > now() - interval '${PROCESSING_MINUTES} minutes')"
    expect(basket).toContain(condition)
    expect(ORDER_PROCESSING_SQL.replace(/\s+/g, ' ')).toContain("o.payment_status = 'pending' AND (o.reader_payment->>'method' IN ('card', 'reader') OR o.created_at > now() - interval '15 minutes')")
  })

  it('Q18 / FB4: the figure changed between the quote and the press: refused with the new figure, nothing charged; no figure sent is refused too; half a penny either way is the same figure', async () => {
    await onASeed(async (stripe) => {
      expect((await quote(NEW_DATE)).data).toMatchObject({ amount: AMOUNT })
      // The plan's price is changed to £45 after the dialog showed £21.94: 45 x 17 / 31 = £24.68.
      await db.query("UPDATE membership_plans SET price_monthly = '45.00' WHERE id = $1", [ID.plan])
      const refused = await press()
      const words = 'The part-month charge is now £24.68, not the £21.94 shown. Nothing was charged and the payment date has not changed. Check the new figure with the customer and press again.'
      expect(refusalOf(refused)).toEqual([409, 'TOTAL_CHANGED', 'amount_changed', words])
      expect(refused.error?.details?.quote).toMatchObject({ amount: 24.68, newRenewalDate: NEW_DATE, extraDays: 17, monthlyPrice: 45 })
      expect(refusalOf(await press({ newRenewalDate: NEW_DATE }))).toEqual([400, 'VALIDATION', 'amount_not_confirmed', PAYMENT_DATE_NEW_WORDS.figureMissing])
      expect(refusalOf(await press({ newRenewalDate: NEW_DATE, confirmed: { amount: 24.674 } }))[1]).toBe('TOTAL_CHANGED')
      expect(stripe.calls).toEqual([])
      expect(await changes()).toEqual([])
      // Within half a penny: the Worker's own figure is charged, never the one sent.
      expect((await press({ newRenewalDate: NEW_DATE, confirmed: { amount: 24.684 } })).data).toMatchObject({ amountCharged: 24.68 })
      expect(paramsOf(charges(stripe)[0]).amount).toBe(2468)
    })
  })

  it('a cancel or undo whose Stripe step is still open refuses the change, after the figure', async () => {
    await onASeed(async (stripe) => {
      await cancelPress('cancel')
      // The undo gets no answer: the membership has no cancel date again, and its step is open.
      stripe.failNext('subscriptions.retrieve', noAnswer())
      expect((await cancelPress('undo-cancel')).data).toMatchObject({ left: expect.anything() })
      const calls = stripe.calls.length
      expect(refusalOf(await press({ newRenewalDate: NEW_DATE, confirmed: { amount: 1 } }))[1]).toBe('TOTAL_CHANGED')
      expect(refusalOf(await press())).toEqual([409, 'CONFLICT', 'step_open', PAYMENT_DATE_NEW_WORDS.stepOpen])
      expect(stripe.calls).toHaveLength(calls)
      expect(await changes()).toEqual([])
    })
  })
})

describe('a change that goes through (S1, S2, S3, P2)', () => {
  it('£21.94 for 17 days: the record first, the card charged once under a key from the record, the date moved with no proration, then the order, its line, the new date, the record done and the audit rows in one go (FB2)', async () => {
    await onASeed(async (stripe) => {
      const key = crypto.randomUUID()
      const answer = await press(BODY, { key })
      expect(answer.status).toBe(200)
      const [change] = await changes()
      const [order] = await orders()
      expect(answer.data).toEqual({ newRenewalDate: NEW_DATE, extraDays: 17, amountCharged: AMOUNT, paymentIntentId: change?.stripe_payment_intent_id, orderId: order?.id })
      expect(changePaymentDateOutputSchema.safeParse(answer.data).success).toBe(true)
      expect(change).toMatchObject({ status: 'done', order_id: order?.id, failure_message: null, override_reason: null, staff_id: ID.staff, amount_charged: '21.94', old: '2026-12-10', new: NEW_DATE, extra_days: 17 })
      expect(await orders()).toEqual([{ id: order?.id, order_total: '21.94', payment_status: 'paid', stripe_payment_intent_id: change?.stripe_payment_intent_id, payment_method: 'card', order_source: 'staff_created' }])
      expect(await lines()).toEqual([{ order_id: order?.id, item_type: 'membership', quantity: 1, unit_price: '21.94', line_total: '21.94', membership_plan_id: ID.plan }])
      expect(await renewal()).toBe(NEW_DATE)

      // Stripe: the read, one charge, one move; each write keyed from the record's id, never from the press's key.
      expect(stripe.calls.map((call) => [call.method, call.idempotencyKey])).toEqual([
        ['subscriptions.retrieve', null],
        ['paymentIntents.create', `${change?.id}:charge`],
        ['subscriptions.update', `${change?.id}:move`],
      ])
      expect(paramsOf(charges(stripe)[0])).toEqual({
        amount: 2194,
        currency: 'gbp',
        customer: MEMBER_STRIPE_CUSTOMER,
        payment_method: 'pm_member',
        off_session: true,
        confirm: true,
        description: 'Payment date change: 17 extra days',
        metadata: { purpose: 'membership_payment_date_change', stripe_subscription_id: MO_SUBSCRIPTION, membership_id: ID.membership, new_renewal_date: NEW_DATE, change_id: change?.id },
      })
      expect(paramsOf(moves(stripe)[0])).toEqual({ id: MO_SUBSCRIPTION, trial_end: TRIAL_END, proration_behavior: 'none' })
      expect(londonMidnightSeconds(NEW_DATE)).toBe(TRIAL_END)
      // In summer London midnight is 23:00 UTC the day before.
      expect(londonMidnightSeconds('2026-06-15')).toBe(Date.UTC(2026, 5, 14, 23) / 1000)
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)).toMatchObject({ trialEnd: TRIAL_END, periodEnd: TRIAL_END, cancelAt: null })

      // The audit rows: started (with everything a later step needs), then done; by the staff member; on the membership.
      const rows = await audited(PAYMENT_DATE_ACTION)
      expect(rows.map((row) => [row.actor_type, row.actor_id, row.entity_type, row.entity_id, row.details['state'], row.details['changeId']])).toEqual([
        ['staff', ID.staff, 'membership', ID.membership, 'started', change?.id],
        ['staff', ID.staff, 'membership', ID.membership, 'done', change?.id],
      ])
      expect(rows[0]?.details).toEqual({
        changeId: change?.id,
        state: 'started',
        channel: 'staff',
        customerId: ID.member,
        planId: ID.plan,
        subscriptionId: MO_SUBSCRIPTION,
        stripeCustomerId: MEMBER_STRIPE_CUSTOMER,
        paymentMethodId: 'pm_member',
        livemode: false,
        oldRenewalDate: '2026-12-10',
        newRenewalDate: NEW_DATE,
        extraDays: 17,
        amount: AMOUNT,
        trialEnd: TRIAL_END,
        description: 'Payment date change: 17 extra days',
        shown: AMOUNT,
        override: null,
      })
      expect(rows[1]?.details).toEqual({ changeId: change?.id, state: 'done', how: 'press', paymentIntentId: change?.stripe_payment_intent_id, orderId: order?.id, amount: AMOUNT, nextRenewalDate: { before: '2026-12-10', after: NEW_DATE } })

      // The same press again (the answer was lost): the first answer, nothing new.
      const again = await press(BODY, { key })
      expect(again).toMatchObject({ status: 200, replayed: true, data: answer.data })
      expect(charges(stripe)).toHaveLength(1)
      expect(await orders()).toHaveLength(1)
      // A new press is refused until the new date arrives; the lists carry the same refusal.
      expect(refusalOf(await press({ newRenewalDate: '2027-01-05', confirmed: { amount: 11.61 } }))).toEqual([409, 'CONFLICT', 'refused', 'Changed on 10 Nov 2026. It can be changed again from 27 Dec 2026.'])
      const list = await read(await listRoute(new Request('https://worker.test/api/v1/staff/memberships', { headers: headers(REPLAY_USER.email) })))
      expect((list.data as unknown as Array<Record<string, unknown>>).find((row) => row['id'] === ID.membership)).toMatchObject({ next_renewal_date: NEW_DATE, payment_date_change_blocked: 'Changed on 10 Nov 2026. It can be changed again from 27 Dec 2026.', payment_date_change_needs_override: true })
      expect(await listed()).toEqual([])
    })
  })

  it("R7: the customer's Stripe balance is never touched, on a change that goes through or one that is refunded", async () => {
    await onASeed(async (stripe) => {
      stripe.setCustomerBalance(MEMBER_STRIPE_CUSTOMER, -500)
      expect((await press()).status).toBe(200)
      expect(stripe.customerBalance(MEMBER_STRIPE_CUSTOMER)).toBe(-500)
      expect(stripe.calls.filter((call) => call.method.startsWith('customers.'))).toEqual([])
    })
    await onASeed(async (stripe) => {
      stripe.setCustomerBalance(MEMBER_STRIPE_CUSTOMER, 700)
      stripe.failNext('subscriptions.update', no())
      expect((await press()).status).toBe(409)
      expect(refunds(stripe)).toHaveLength(1)
      expect(stripe.customerBalance(MEMBER_STRIPE_CUSTOMER)).toBe(700)
      expect(stripe.calls.filter((call) => call.method.startsWith('customers.'))).toEqual([])
    })
  })

  it('Stripe taking the change but reporting another date is a warning on the answer, in the old words', async () => {
    await onASeed(async (stripe) => {
      const real = stripe.subscriptions.update.bind(stripe.subscriptions)
      const update = vi.spyOn(stripe.subscriptions, 'update').mockImplementation(async (...args) => ({ ...(await real(...args)), trial_end: TRIAL_END + 3600, billing_cycle_anchor: TRIAL_END + 3600 }) as never)
      try {
        const answer = await press()
        expect(answer.status).toBe(200)
        expect(answer.data?.['warning']).toBe(`Stripe accepted the change but reports trial_end ${TRIAL_END + 3600} and billing_cycle_anchor ${TRIAL_END + 3600}, expected ${TRIAL_END}: check the subscription in Stripe.`)
      } finally {
        update.mockRestore()
      }
    })
  })
})

describe("S1: the legacy route's checks against Stripe's subscription; refused, the record is failed and nothing is charged", () => {
  const refusedAtStripe = async (stripe: FakeStripe, reason: string, words: string) => {
    expect(refusalOf(await press())).toEqual([409, 'CONFLICT', reason, words])
    expect(charges(stripe)).toEqual([])
    expect(moves(stripe)).toEqual([])
    expect((await changes()).map((row) => [row.status, row.failure_message, row.stripe_payment_intent_id])).toEqual([['failed', words, null]])
    expect(await states()).toEqual(['started', 'failed'])
    expect(await renewal()).not.toBe(NEW_DATE)
    expect(await orders()).toEqual([])
    expect(await listed()).toEqual([])
  }

  it("another customer's subscription", async () => {
    await onASeed(async (stripe) => {
      stripe.addCustomer('cus_other')
      stripe.addSubscription('sub_other', 'cus_other', MONTHLY_PRICE)
      await db.query('UPDATE customer_memberships SET stripe_subscription_id = $1 WHERE id = $2', ['sub_other', ID.membership])
      await refusedAtStripe(stripe, 'customer_mismatch', PAYMENT_DATE_WORDS.customerMismatch)
    })
  })
  it('not active in Stripe', async () => {
    await onASeed(async (stripe) => {
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'past_due' })
      await refusedAtStripe(stripe, 'not_active', 'The Stripe subscription is past_due, not active')
    })
  })
  it('a cancellation scheduled in Stripe', async () => {
    await onASeed(async (stripe) => {
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: 1796860800 })
      await refusedAtStripe(stripe, 'cancel_scheduled', PAYMENT_DATE_WORDS.stripeCancelScheduled)
    })
  })
  it('the stale-date guard: Stripe\'s next payment is not on the date the membership shows (dates worded as the old function reworded them)', async () => {
    await onASeed(
      async (stripe) => {
        expect(refusalOf(await press({ newRenewalDate: NEW_DATE, confirmed: { amount: 19.35 } }))).toEqual([409, 'CONFLICT', 'stale_renewal_date', "Stripe's next payment is on 10 Dec 2026, but the membership shows 12 Dec 2026. Refresh and try again."])
        expect(charges(stripe)).toEqual([])
        expect((await changes()).map((row) => row.status)).toEqual(['failed'])
      },
      set("UPDATE customer_memberships SET next_renewal_date = '2026-12-12' WHERE id = $1")
    )
  })
  it("more than a full month at Stripe's price; and a subscription that is not one monthly price", async () => {
    await onASeed(
      async (stripe) => {
        // The plan says £100 a month (17 days: £54.84); Stripe's price is £40.
        expect(refusalOf(await press({ newRenewalDate: NEW_DATE, confirmed: { amount: 54.84 } }))).toEqual([409, 'CONFLICT', 'amount_too_high', PAYMENT_DATE_WORDS.amountTooHigh])
        expect(charges(stripe)).toEqual([])
      },
      set("UPDATE membership_plans SET price_monthly = '100.00' WHERE id = $1", [ID.plan])
    )
    const yearly = { customer: MEMBER_STRIPE_CUSTOMER, status: 'active', cancel_at: null, cancel_at_period_end: false, items: { data: [{ current_period_end: Date.UTC(2026, 11, 10) / 1000, quantity: 1, price: { unit_amount: 40000, recurring: { interval: 'year', interval_count: 1 } } }] } }
    expect(checkSubscription(yearly as never, { stripeCustomerId: MEMBER_STRIPE_CUSTOMER, oldRenewalDate: '2026-12-10', amount: AMOUNT })).toEqual({ ok: false, reason: 'not_monthly', message: PAYMENT_DATE_WORDS.stripeNotMonthly })
  })
  it("Stripe can't be read: Stripe's own words, as before, and nothing charged", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.retrieve', noAnswer())
      await refusedAtStripe(stripe, 'subscription_unreadable', 'An error occurred with our API.')
      // A failed attempt doesn't hold the membership: the next press goes through.
      expect((await press()).status).toBe(200)
    })
  })
})

describe('S2: the charge', () => {
  it('declined: the old words, the record failed, nothing moved; the next press goes through with a charge of its own', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const words = 'The card was declined: Your card was declined. Nothing was charged and the payment date has not changed.'
      expect(refusalOf(await press())).toEqual([402, 'PAYMENT_FAILED', 'payment_failed', words])
      expect(charges(stripe)).toHaveLength(1)
      expect(moves(stripe)).toEqual([])
      expect((await changes()).map((row) => [row.status, row.failure_message])).toEqual([['failed', words]])
      expect(await taken(stripe)).toEqual([])
      expect(await renewal()).toBe('2026-12-10')
      expect((await press()).status).toBe(200)
      expect((await changes()).map((row) => row.status)).toEqual(['failed', 'done'])
      expect(await taken(stripe)).toHaveLength(1)
    })
  })

  it('a card that needs the customer: the old words', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.authenticationRequired() })
      expect(refusalOf(await press())).toEqual([
        402,
        'PAYMENT_NEEDS_AUTHENTICATION',
        'payment_failed',
        'The card was declined: Card requires additional authentication and cannot be charged off-session. Ask the customer to complete a new payment. Nothing was charged and the payment date has not changed.',
      ])
      expect((await changes()).map((row) => row.status)).toEqual(['failed'])
    })
  })

  it("declined, and the record can't be marked failed: the refusal is still the answer, the record stays pending and holds the membership, and reconcile ends it once Stripe shows no payment", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const refused = await whileFailing(db, { table: 'membership_payment_date_changes', event: 'UPDATE', when: 'true' }, () => press())
      expect(refused.status).toBe(402)
      expect((await changes()).map((row) => row.status)).toEqual(['pending'])
      expect(refusalOf(await press())).toEqual([409, 'CONFLICT', 'refused', PAYMENT_DATE_REFUSALS.inProgress])
      pastTheWindow()
      const [change] = await changes()
      expect(await dateItems(stripe)).toEqual([{ kind: 'date_change', id: change?.id, outcome: 'undone', detail: 'Stripe has no payment for this payment date change: nothing was charged' }])
      expect((await changes()).map((row) => row.status)).toEqual(['failed'])
      expect(charges(stripe)).toHaveLength(1)
    })
  })

  it('FB1, no clear answer and nothing taken: held in step D\'s words (PAYMENT_UNCONFIRMED), sent twice under one key and never again; the membership is held; inside the window reconcile leaves it; past it, with no payment in Stripe, the record is ended and nothing was charged', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', noAnswer())
      const answer = await press()
      const [change] = await changes()
      expect(refusalOf(answer)).toEqual([502, 'PAYMENT_UNCONFIRMED', 'payment_unconfirmed', CHANGE_PAYMENT_UNCONFIRMED_MESSAGE])
      expect(PAYMENT_DATE_HELD_MESSAGE).toBe("The card payment didn't get a clear answer, so it may or may not have been taken. The change is on hold: don't take payment again. Check the Orders page in a few minutes.")
      expect(answer.error?.details?.held).toEqual({ changeId: change?.id })
      expect(charges(stripe).map((call) => call.idempotencyKey)).toEqual([`${change?.id}:charge`, `${change?.id}:charge`])
      expect(change).toMatchObject({ status: 'pending', order_id: null })
      expect(await states()).toEqual(['started', 'held'])
      // Held: no second change, no cancel.
      expect(refusalOf(await press())).toEqual([409, 'CONFLICT', 'refused', PAYMENT_DATE_REFUSALS.inProgress])
      expect(refusalOf(await cancelPress('cancel'))).toEqual([409, 'CONFLICT', 'payment_date_changing', MEMBERSHIP_CANCEL_NEW_WORDS.paymentDateChanging])
      // Inside the window it is the press's own: not listed, not reconciled.
      expect(await listed()).toEqual([])
      expect(await dateItems(stripe)).toEqual([])
      pastTheWindow()
      expect((await listed()).map((line) => [line.changeId, line.reason, line.words, line.close, line.amount, line.newRenewalDate, line.customerName])).toEqual([[change?.id, 'waiting', PAYMENT_DATE_STUCK_WORDS['waiting'], undefined, AMOUNT, NEW_DATE, 'Mo Member']])
      expect(await dateItems(stripe)).toEqual([{ kind: 'date_change', id: change?.id, outcome: 'undone', detail: 'Stripe has no payment for this payment date change: nothing was charged' }])
      expect((await changes()).map((row) => [row.status, row.failure_message])).toEqual([['failed', 'Stripe has no payment for this payment date change: nothing was charged. The payment date has not changed.']])
      expect(await states()).toEqual(['started', 'held', 'failed'])
      // Never charged again: the press's two sends are all there ever were.
      expect(charges(stripe)).toHaveLength(2)
      expect(await taken(stripe)).toEqual([])
      expect(await listed()).toEqual([])
      // And the membership is free again.
      expect((await press()).status).toBe(200)
      expect(await taken(stripe)).toHaveLength(1)
    })
  })

  it('FB1, no clear answer and the money taken: reconcile finds the payment by `metadata.change_id`, moves the date and writes the order; £21.94 once', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      expect(refusalOf(await press())[1]).toBe('PAYMENT_UNCONFIRMED')
      const [change] = await changes()
      expect(await taken(stripe)).toHaveLength(1)
      expect(moves(stripe)).toEqual([])
      pastTheWindow()
      const requestId = crypto.randomUUID()
      const run = await reconcileNow(stripe, requestId)
      const [paid] = await taken(stripe)
      expect(run.items.filter((item) => item.kind === 'date_change')).toEqual([{ kind: 'date_change', id: change?.id, outcome: 'finalised', detail: paid?.id }])
      expect(run).toMatchObject({ finalised: 1, left: 0 })
      // Reconcile's own send of the move carries a key of its own run.
      expect(moves(stripe).map((call) => call.idempotencyKey)).toEqual([`${change?.id}:move:${requestId}`])
      expect(await changes()).toMatchObject([{ status: 'done', stripe_payment_intent_id: paid?.id }])
      expect(await orders()).toMatchObject([{ order_total: '21.94', payment_status: 'paid', stripe_payment_intent_id: paid?.id }])
      expect(await renewal()).toBe(NEW_DATE)
      expect((await audited(PAYMENT_DATE_ACTION)).find((row) => row.details['state'] === 'done')).toMatchObject({ actor_type: 'system', details: { state: 'done', how: 'reconcile' } })
      // One payment, however many sends; nothing more on later runs.
      expect(charges(stripe)).toHaveLength(2)
      expect(await taken(stripe)).toHaveLength(1)
      const calls = stripe.calls.length
      pastTheWindow()
      expect(await dateItems(stripe)).toEqual([])
      expect(stripe.calls).toHaveLength(calls)
    })
  })

  it("the other Stripe mode: with a key of another mode than the charge was sent with, \"no payment found\" is never taken as \"nothing charged\": left for a person, with a close; with the right key again it is settled", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      await press()
      const [change] = await changes()
      pastTheWindow()
      // The Worker now runs with the live key: Stripe lists nothing made in test mode.
      stripe.keyLivemode = true
      expect(await dateItems(stripe)).toEqual([{ kind: 'date_change', id: change?.id, outcome: 'left', reason: 'other_mode' }])
      expect((await changes()).map((row) => row.status)).toEqual(['pending'])
      expect((await listed()).map((line) => [line.reason, line.close?.kind])).toEqual([['other_mode', 'held_payment_date']])
      // The test key back: the payment is found, the date moved and the order written.
      stripe.keyLivemode = false
      expect((await dateItems(stripe)).map((item) => item.outcome)).toEqual(['finalised'])
      expect(await changes()).toMatchObject([{ status: 'done' }])
      expect(await taken(stripe)).toHaveLength(1)
    })
  })

  it('a payment still at the bank is left held, and listed with what it is waiting on; two payments for one change are for a person, with a close', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      await press()
      const [change] = await changes()
      const [paid] = await taken(stripe)
      stripe.markProcessing(paid?.id as string)
      pastTheWindow()
      expect(await dateItems(stripe)).toEqual([{ kind: 'date_change', id: change?.id, outcome: 'left', reason: 'payment_processing', detail: `${paid?.id} processing` }])
      // W47 item 5 (the W45 audit's row 37), a named difference: the line used step D's words for a booking change
      // ("The card payment for this change is still being processed by the bank..."). It now says what the payment
      // date change is waiting for, and that it can't be closed by hand until Stripe says how the payment ended.
      expect((await listed()).map((line) => [line.reason, line.words, line.close])).toEqual([['payment_processing', PAYMENT_DATE_STUCK_WORDS['payment_processing'], undefined]])
      expect(PAYMENT_DATE_STUCK_WORDS['payment_processing']).toBe(
        "A payment date change's part-month charge is still being processed by the customer's bank. Wait for the bank: the automatic check looks every 5 minutes and, once Stripe says whether the payment went through, finishes the change or ends it. It can't be closed by hand until then. Don't change the payment date or take the part-month charge again."
      )
      // The close itself refuses while the bank may still finish the payment.
      const refused = await closeStuckItem(db, { kind: 'held_payment_date', orderId: change?.id as string, reason: 'Trying to close it early' }, { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID() })
      expect(refused).toMatchObject({ closed: false, reason: 'still_checking' })
      expect(moves(stripe)).toEqual([])
    })
  })

  it('W47 item 5: once Stripe gives the payment a final state, the change is finished by the automatic check (paid), or left for a person with a Close (paid, but another amount)', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      await press()
      const [paid] = await taken(stripe)
      stripe.markProcessing(paid?.id as string)
      pastTheWindow()
      expect((await dateItems(stripe)).map((item) => item.reason)).toEqual(['payment_processing'])
      expect((await listed()).map((line) => line.close)).toEqual([undefined])
      // The bank finishes it: paid in full. The next run, five minutes on, moves the date and the line goes.
      vi.setSystemTime(Date.now() + 5 * 60_000)
      stripe.completeReaderPayment(paid?.id as string)
      expect((await dateItems(stripe)).map((item) => item.outcome)).toEqual(['finalised'])
      expect(await listed()).toEqual([])
      expect(await changes()).toMatchObject([{ status: 'done' }])
    })
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      await press()
      const [change] = await changes()
      const [paid] = await taken(stripe)
      stripe.markProcessing(paid?.id as string)
      pastTheWindow()
      await dateItems(stripe)
      expect((await listed()).map((line) => [line.reason, line.close])).toEqual([['payment_processing', undefined]])
      // The bank finishes it for another amount than the change asked for: final, and for a person. The next run is
      // five minutes on (under the test's clock two runs' rows would otherwise share a moment).
      vi.setSystemTime(Date.now() + 5 * 60_000)
      stripe.completeReaderPayment(paid?.id as string, { amount: 100 })
      expect((await dateItems(stripe)).map((item) => item.reason)).toEqual(['amount_mismatch'])
      expect((await listed()).map((line) => [line.reason, line.close])).toEqual([['amount_mismatch', { kind: 'held_payment_date', orderId: change?.id }]])
    })
  })

  it('W47 item 5: a payment waiting for the customer to approve it with their bank is listed with what to do (cancel it in Stripe), no Close; once it is cancelled there, the automatic check ends the change and the date can be changed again', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      await press()
      const [change] = await changes()
      const [paid] = await taken(stripe)
      stripe.markRequiresAction(paid?.id as string)
      pastTheWindow()
      const calls = () => stripe.calls.filter((call) => call.method === 'paymentIntents.cancel' || call.method === 'paymentIntents.create' || call.method === 'paymentIntents.confirm').length
      const before = calls()
      expect(await dateItems(stripe)).toEqual([{ kind: 'date_change', id: change?.id, outcome: 'left', reason: 'payment_needs_action', detail: `${paid?.id} requires_action` }])
      // The automatic check reads only: it neither cancels the payment nor charges again.
      expect(calls()).toBe(before)
      expect((await listed()).map((line) => [line.reason, line.words, line.close])).toEqual([['payment_needs_action', PAYMENT_DATE_STUCK_WORDS['payment_needs_action'], undefined]])
      expect(PAYMENT_DATE_STUCK_WORDS['payment_needs_action']).toBe(
        "A payment date change's part-month charge is waiting for a step Stripe needs (usually the customer's bank approval), which can't be done from here, so it won't finish on its own. Tell a manager: cancel that payment in Stripe. Once Stripe shows it cancelled, the automatic check ends the change within 5 minutes (nothing was taken) and the date can be changed again. It can't be closed by hand until then. Don't change the payment date or take the part-month charge again."
      )
      const refused = await closeStuckItem(db, { kind: 'held_payment_date', orderId: change?.id as string, reason: 'Trying to close it early' }, { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID() })
      expect(refused).toMatchObject({ closed: false, reason: 'still_checking' })
      expect(refusalOf(await press())).toEqual([409, 'CONFLICT', 'refused', PAYMENT_DATE_REFUSALS.inProgress])
      // A manager cancels the payment in Stripe: a final state, and nothing was taken. The next run is five minutes on.
      vi.setSystemTime(Date.now() + 5 * 60_000)
      await stripe.paymentIntents.cancel(paid?.id as string)
      expect((await dateItems(stripe)).map((item) => item.outcome)).toEqual(['undone'])
      expect(await listed()).toEqual([])
      expect((await changes()).map((row) => row.status)).toEqual(['failed'])
      expect(moves(stripe)).toEqual([])
    })
  })

  it('W47 item 5: one payment at the bank and one waiting on the customer reads as waiting for the bank, which will end on its own', () => {
    expect(paymentStillGoingReason(['processing'])).toBe('payment_processing')
    expect(paymentStillGoingReason(['requires_action', 'processing'])).toBe('payment_processing')
    expect(paymentStillGoingReason(['requires_action'])).toBe('payment_needs_action')
    expect(paymentStillGoingReason(['requires_confirmation', 'requires_capture'])).toBe('payment_needs_action')
    expect(PAYMENT_DATE_CLOSE_REASONS.has('payment_processing')).toBe(false)
    expect(PAYMENT_DATE_CLOSE_REASONS.has('payment_needs_action')).toBe(false)
  })
})

describe('S3: the date move', () => {
  it('refused: the charge refunded once under its key, watched (FB3), the record failed, the old words; nothing left held', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', no())
      const words = 'This subscription cannot be updated right now.. The part-month charge was refunded in full.'
      expect(refusalOf(await press())).toEqual([409, 'CONFLICT', 'subscription_update_failed', words])
      const [change] = await changes()
      const [paid] = await taken(stripe)
      expect(refunds(stripe).map((call) => [call.idempotencyKey, paramsOf(call)])).toEqual([
        [`${change?.id}:refund`, { payment_intent: paid?.id, metadata: { change_id: change?.id, refund_key: `${change?.id}:refund`, reason: 'payment_date_not_moved' } }],
      ])
      expect(change).toMatchObject({ status: 'failed', failure_message: words, stripe_payment_intent_id: paid?.id, order_id: null })
      expect(await states()).toEqual(['started', 'refunding', 'failed'])
      expect(await renewal()).toBe('2026-12-10')
      expect(await orders()).toEqual([])
      // The refund is on W32's watch, as a compensation refund under the payment date's own step.
      const watch = (await audited(REFUND_WATCH)).map((row) => row.details)
      expect(watch).toMatchObject([{ state: 'watching', paymentIntentId: paid?.id, amount: AMOUNT, on: 'compensation', subjectId: change?.id, step: PAYMENT_DATE_REFUND_WATCH_STEP, status: 'succeeded' }])
      expect(await listed()).toEqual([])
      // The membership is free: a new press charges anew.
      expect((await press()).status).toBe(200)
    })
  })

  it('FB3, the refund accepted and failing later: the watch lists it for a person, in its own words, with Mark sorted', async () => {
    await onASeed(async (stripe) => {
      stripe.refundsStayPending = true
      stripe.failNext('subscriptions.update', no())
      await press()
      const [paid] = await taken(stripe)
      const refundId = (await audited(REFUND_WATCH))[0]?.details['refundId'] as string
      stripe.settleRefund(refundId, 'failed')
      const run = await reconcileNow(stripe)
      expect(run.items).toEqual([expect.objectContaining({ kind: 'refund', id: refundId, outcome: 'refund_failed', reason: 'refund_failed_later' })])
      const watched = (await stuckList(db)).watched
      expect(watched.map((line) => [line.on, line.state, line.customerName, line.amount, line.orderId, line.words, line.close?.kind])).toEqual([
        ['compensation', 'failed', 'Mo Member', AMOUNT, null, WATCH_WORDS.paymentDateFailed(AMOUNT, paid?.id as string), 'refund_watch'],
      ])
      expect(WATCH_WORDS.paymentDateFailed(21.94, 'pi_1')).toBe(
        "An automatic refund of £21.94 (payment pi_1) for a payment date change that Stripe refused was accepted by Stripe and then failed, so the customer has paid for a change that didn't happen and has not had the money back. Refund that payment in Stripe by hand (or tell a manager if Stripe won't). Then press Mark sorted (needs the Issue refunds permission)."
      )
      expect((await audited('payment_date_change.refund_failed_later')).length).toBe(1)
    })
  })

  it('FB3, the refund refused outright: listed for a person at once past the window, never sent again, the membership held until it is closed by hand (Issue refunds), which records what Stripe showed and sends nothing', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', no())
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.invalid('charge_disputed', 'This charge has been disputed and cannot be refunded.') })
      const answer = await press()
      const [change] = await changes()
      const [paid] = await taken(stripe)
      const words = `This subscription cannot be updated right now.. The £21.94 charge (${paid?.id}) could not be refunded automatically (This charge has been disputed and cannot be refunded.). It is listed on the Orders page: refund it in Stripe by hand, then close the line there.`
      expect(refusalOf(answer)).toEqual([502, 'PAYMENT_UNCONFIRMED', 'refund_refused', words])
      expect(change).toMatchObject({ status: 'pending' })
      expect(await states()).toEqual(['started', 'refunding', 'held'])
      pastTheWindow()
      const calls = stripe.calls.length
      // W47 item 5 (W41 "Noticed" 4; the W45 audit's row 39), a named difference: before reconcile's first run past
      // the window the line read "waiting", with no Close, for up to 5 minutes. It now reads the press's own mark.
      expect((await listed()).map((line) => [line.reason, line.words, line.close, line.paymentIntentId])).toEqual([['refund_refused', PAYMENT_DATE_STUCK_WORDS['refund_refused'], { kind: 'held_payment_date', orderId: change?.id }, paid?.id]])
      expect(stripe.calls).toHaveLength(calls)
      expect(await dateItems(stripe)).toEqual([{ kind: 'date_change', id: change?.id, outcome: 'left', reason: 'refund_refused', detail: paid?.id }])
      // No call at all: a refusal for good is never retried (lead call L7's lesson).
      expect(stripe.calls).toHaveLength(calls)
      expect((await listed()).map((line) => [line.reason, line.words, line.close, line.paymentIntentId])).toEqual([['refund_refused', PAYMENT_DATE_STUCK_WORDS['refund_refused'], { kind: 'held_payment_date', orderId: change?.id }, paid?.id]])
      expect(refusalOf(await press())).toEqual([409, 'CONFLICT', 'refused', PAYMENT_DATE_REFUSALS.inProgress])

      const closed = await closeStuckItem(db, { kind: 'held_payment_date', orderId: change?.id as string, reason: 'Refunded in Stripe by hand' }, { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID() })
      expect(closed).toEqual({ closed: true, kind: 'held_payment_date', orderId: change?.id, message: PAYMENT_DATE_CLOSE_WORDS.closed(`refund_refused; ${paid?.id}; payment ${paid?.id}`) })
      expect(stripe.calls).toHaveLength(calls)
      expect((await changes()).map((row) => [row.status, row.failure_message])).toEqual([['failed', 'Closed by hand: Refunded in Stripe by hand']])
      expect((await audited(PAYMENT_DATE_ACTION)).find((row) => row.details['state'] === 'closed')?.details).toMatchObject({ state: 'closed', why: 'Refunded in Stripe by hand', found: { reason: 'refund_refused', paymentIntentId: paid?.id } })
      expect((await audited('order.close')).find((row) => row.entity_id === change?.id)).toMatchObject({ entity_type: 'payment_date_change', entity_id: change?.id, details: { kind: 'held_payment_date', why: 'Refunded in Stripe by hand', reason: 'refund_refused' } })
      expect(await listed()).toEqual([])
      // Closed twice: not listed any more.
      expect(await closeStuckItem(db, { kind: 'held_payment_date', orderId: change?.id as string, reason: 'Again, to be sure' }, { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID() })).toMatchObject({ closed: false, reason: 'not_listed' })
      expect(await renewal()).toBe('2026-12-10')
    })
  })

  it('the manual close is only for a change the automatic check has left for a person: one it is still working on is refused, with nothing changed', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', noAnswer())
      await press()
      const [change] = await changes()
      pastTheWindow()
      expect(await closeStuckItem(db, { kind: 'held_payment_date', orderId: change?.id as string, reason: 'Trying to close it' }, { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID() })).toEqual({
        closed: false,
        kind: 'held_payment_date',
        orderId: change?.id,
        reason: 'still_checking',
        message: PAYMENT_DATE_CLOSE_WORDS.stillChecking,
      })
      expect((await changes()).map((row) => row.status)).toEqual(['pending'])
      expect([...PAYMENT_DATE_CLOSE_REASONS].sort()).toEqual(['amount_mismatch', 'other_mode', 'refund_refused', 'refunded_elsewhere', 'several_payments', 'subscription_missing', 'unexpected_state'])
      expect(stripe.calls.filter((call) => call.method === 'refunds.create')).toEqual([])
    })
  })

  it('refused, and the refund gets no clear answer: held; reconcile finds the refund on the payment and records it (never a second refund), or sends it under a key of its run\'s own if Stripe has none', async () => {
    // The refund went and its answer was lost.
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', no())
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const answer = await press()
      expect(refusalOf(answer)).toEqual([502, 'PAYMENT_UNCONFIRMED', 'refund_unconfirmed', PAYMENT_DATE_NEW_WORDS.refundHeld('This subscription cannot be updated right now.')])
      const [change] = await changes()
      const [paid] = await taken(stripe)
      pastTheWindow()
      const sent = refunds(stripe).length
      expect(await dateItems(stripe)).toEqual([expect.objectContaining({ kind: 'date_change', id: change?.id, outcome: 'undone' })])
      expect(refunds(stripe)).toHaveLength(sent)
      expect(moves(stripe)).toHaveLength(1)
      expect((await changes()).map((row) => [row.status, row.failure_message])).toEqual([['failed', 'This subscription cannot be updated right now.. The part-month charge was refunded in full.']])
      expect((await audited(REFUND_WATCH)).map((row) => row.details)).toMatchObject([{ state: 'watching', paymentIntentId: paid?.id, step: PAYMENT_DATE_REFUND_WATCH_STEP }])
      expect((await stripe.refunds.list({ payment_intent: paid?.id as string })).data).toHaveLength(1)
    })
    // The refund never reached Stripe.
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', no())
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      expect(refusalOf(await press())[2]).toBe('refund_unconfirmed')
      const [change] = await changes()
      const [paid] = await taken(stripe)
      expect((await stripe.refunds.list({ payment_intent: paid?.id as string })).data).toEqual([])
      pastTheWindow()
      const requestId = crypto.randomUUID()
      expect((await reconcileNow(stripe, requestId)).items.filter((item) => item.kind === 'date_change')).toEqual([expect.objectContaining({ kind: 'date_change', id: change?.id, outcome: 'undone' })])
      // W41a B2: the press's two sends under its key, then reconcile's under a key of that run's own.
      expect(refunds(stripe).map((call) => call.idempotencyKey)).toEqual([`${change?.id}:refund`, `${change?.id}:refund`, `${change?.id}:refund:${requestId}`])
      expect((await stripe.refunds.list({ payment_intent: paid?.id as string })).data).toHaveLength(1)
      // The date move is never sent again once the refunding mark is there.
      expect(moves(stripe)).toHaveLength(1)
      expect((await changes()).map((row) => row.status)).toEqual(['failed'])
    })
  })

  it('no clear answer and the date not moved: held in step D\'s paid-not-finished words; reconcile reads the subscription, sends the move again and finishes; one charge', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      const answer = await press()
      expect(refusalOf(answer)).toEqual([502, 'PAYMENT_UNCONFIRMED', 'move_unconfirmed', CARD_FLOW_PAID_NOT_FINISHED_MESSAGE])
      const [change] = await changes()
      const [paid] = await taken(stripe)
      // The payment is on the record already, for the list.
      expect(change).toMatchObject({ status: 'pending', stripe_payment_intent_id: paid?.id })
      expect(moves(stripe).map((call) => call.idempotencyKey)).toEqual([`${change?.id}:move`, `${change?.id}:move`])
      pastTheWindow()
      expect((await listed()).map((line) => [line.reason, line.words, line.paymentIntentId])).toEqual([['waiting', PAYMENT_DATE_STUCK_WORDS['waiting'], paid?.id]])
      const requestId = crypto.randomUUID()
      expect((await reconcileNow(stripe, requestId)).items.filter((item) => item.kind === 'date_change')).toEqual([{ kind: 'date_change', id: change?.id, outcome: 'finalised', detail: paid?.id }])
      expect(moves(stripe).at(-1)?.idempotencyKey).toBe(`${change?.id}:move:${requestId}`)
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.trialEnd).toBe(TRIAL_END)
      expect(await changes()).toMatchObject([{ status: 'done' }])
      expect(await renewal()).toBe(NEW_DATE)
      expect(charges(stripe)).toHaveLength(1)
      expect(refunds(stripe)).toEqual([])
    })
  })

  it('no clear answer and the date moved: reconcile reads the subscription, finds the date as asked and finishes without sending anything', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', { kind: 'lost_response' })
      stripe.failNext('subscriptions.update', { kind: 'lost_response' })
      expect(refusalOf(await press())[2]).toBe('move_unconfirmed')
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.trialEnd).toBe(TRIAL_END)
      const [change] = await changes()
      pastTheWindow()
      const sent = moves(stripe).length
      expect(await dateItems(stripe)).toEqual([expect.objectContaining({ kind: 'date_change', id: change?.id, outcome: 'finalised' })])
      expect(moves(stripe)).toHaveLength(sent)
      expect(await changes()).toMatchObject([{ status: 'done' }])
      expect(await orders()).toHaveLength(1)
      expect(await renewal()).toBe(NEW_DATE)
    })
  })

  it('reconcile\'s own move refused: the charge is refunded once, watched, and the record ended', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      await press()
      const [change] = await changes()
      pastTheWindow()
      stripe.failNext('subscriptions.update', no())
      const requestId = crypto.randomUUID()
      expect((await reconcileNow(stripe, requestId)).items.filter((item) => item.kind === 'date_change')).toEqual([expect.objectContaining({ kind: 'date_change', id: change?.id, outcome: 'undone' })])
      expect(refunds(stripe).map((call) => [call.idempotencyKey, (paramsOf(call)['metadata'] as Record<string, unknown>)['change_id']])).toEqual([[`${change?.id}:refund:${requestId}`, change?.id]])
      expect((await changes()).map((row) => row.status)).toEqual(['failed'])
      expect(await audited(REFUND_WATCH)).toHaveLength(1)
      expect(await renewal()).toBe('2026-12-10')
    })
  })

  it('a payment refunded outside the booking system while it was held: left for a person, and the date is never moved for it', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      await press()
      const [change] = await changes()
      const [paid] = await taken(stripe)
      // Someone refunds it in Stripe's dashboard.
      const byHand = await stripe.refunds.create({ payment_intent: paid?.id as string })
      pastTheWindow()
      const sent = moves(stripe).length
      expect(await dateItems(stripe)).toEqual([{ kind: 'date_change', id: change?.id, outcome: 'left', reason: 'refunded_elsewhere', detail: `${byHand.id} succeeded` }])
      expect(moves(stripe)).toHaveLength(sent)
      expect((await listed()).map((line) => [line.reason, line.words, line.close?.kind])).toEqual([['refunded_elsewhere', PAYMENT_DATE_STUCK_WORDS['refunded_elsewhere'], 'held_payment_date']])
    })
  })
})

// Brief W41a items 2 to 4 (W41 review B1 to B3): three ways reconcile ended a held change wrongly, each proved on a
// copy by the review (briefs/W41-review-logs/w41-review-proofs.test.ts.txt, R1 to R3). Each test is the review's
// proof with the ending the fix gives.
describe('W41a: reconcile and a held change (W41 review B1, B2, B3)', () => {
  const REFUSED_WORDS = 'This subscription cannot be updated right now.. The part-month charge was refunded in full.'
  const refundsInStripe = async (stripe: FakeStripe, paymentIntentId: string) => (await stripe.refunds.list({ payment_intent: paymentIntentId })).data.map((refund) => [refund.amount, refund.metadata?.['change_id'] ?? null])

  it("B1 (R1): held at the move, then Stripe renews the subscription on the old date before reconcile looks: reconcile runs the press's checks again, never moves the date over the month just paid for, refunds the part-month charge once (watched) and ends the record with the check's words; nothing is left listed", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      expect(refusalOf(await press())[2]).toBe('move_unconfirmed')
      const [change] = await changes()
      const [paid] = await taken(stripe)
      // Stripe renews on 10 December (the month to 10 January is billed in full): the period now ends 10 January.
      stripe.setSubscription(MO_SUBSCRIPTION, { periodEnd: Date.UTC(2027, 0, 10) / 1000 })
      pastTheWindow()
      const sent = moves(stripe).length
      const requestId = crypto.randomUUID()
      expect((await reconcileNow(stripe, requestId)).items.filter((item) => item.kind === 'date_change')).toEqual([expect.objectContaining({ kind: 'date_change', id: change?.id, outcome: 'undone' })])
      // The move was not sent again, and the subscription is as the renewal left it.
      expect(moves(stripe)).toHaveLength(sent)
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)).toMatchObject({ trialEnd: null, periodEnd: Date.UTC(2027, 0, 10) / 1000 })
      // The whole charge given back, once, under the run's key, naming the change.
      expect(refunds(stripe).map((call) => call.idempotencyKey)).toEqual([`${change?.id}:refund:${requestId}`])
      expect(await refundsInStripe(stripe, paid?.id as string)).toEqual([[2194, change?.id]])
      expect(stripe.refundedByIntent.get(paid?.id as string)).toBe(2194)
      // W58b (the W45 audit's row 42; W41a "Noticed" 2): the record says the check's own sentence, without the dialog's "Refresh and try again".
      const words = "The payment date wasn't moved: when the automatic check looked again, the subscription no longer allowed it (Stripe's next payment is on 10 Jan 2027, but the membership shows 10 Dec 2026). The part-month charge was refunded in full."
      expect((await changes()).map((row) => [row.status, row.failure_message, row.order_id])).toEqual([['failed', words, null]])
      expect(await states()).toEqual(['started', 'held', 'refunding', 'failed'])
      expect(await renewal()).toBe('2026-12-10')
      expect(await orders()).toEqual([])
      expect((await audited(REFUND_WATCH)).map((row) => row.details)).toMatchObject([{ state: 'watching', paymentIntentId: paid?.id, amount: AMOUNT, on: 'compensation', subjectId: change?.id, step: PAYMENT_DATE_REFUND_WATCH_STEP }])
      expect(await listed()).toEqual([])
      // A later run finds nothing to do and sends nothing.
      const calls = stripe.calls.length
      pastTheWindow()
      expect(await dateItems(stripe)).toEqual([])
      expect(stripe.calls).toHaveLength(calls)
    })
  })

  it.each<[string, Parameters<FakeStripe['setSubscription']>[1], string]>([
    ['no longer active (the renewal payment failing)', { status: 'past_due' }, "The payment date wasn't moved: when the automatic check looked again, the subscription no longer allowed it (The Stripe subscription is past_due, not active). The part-month charge was refunded in full."],
    ['a cancel scheduled meanwhile', { cancelAt: Date.UTC(2026, 11, 10) / 1000 }, "The payment date wasn't moved: when the automatic check looked again, the subscription no longer allowed it (The Stripe subscription has a cancellation scheduled). The part-month charge was refunded in full."],
  ])("B1: held at the move, and the subscription %s when reconcile looks: the change didn't happen, so the charge is refunded and the move never sent again", async (_name, fields, words) => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      await press()
      const [paid] = await taken(stripe)
      stripe.setSubscription(MO_SUBSCRIPTION, fields)
      pastTheWindow()
      const sent = moves(stripe).length
      expect((await dateItems(stripe)).map((item) => item.outcome)).toEqual(['undone'])
      expect(moves(stripe)).toHaveLength(sent)
      expect(stripe.refundedByIntent.get(paid?.id as string)).toBe(2194)
      expect((await changes()).map((row) => [row.status, row.failure_message])).toEqual([['failed', words]])
      expect(await audited(REFUND_WATCH)).toHaveLength(1)
      expect(await listed()).toEqual([])
    })
  })

  it('W58b (the W45 audit\'s row 42; W41a "Noticed" 1): B1, and the refund then gets no clear answer, or is refused: the Orders page\'s line says the date was never sent, not that Stripe refused it', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      await press()
      const [change] = await changes()
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'past_due' })
      pastTheWindow()
      stripe.failNext('refunds.create', noAnswer())
      expect(await dateItems(stripe)).toEqual([expect.objectContaining({ kind: 'date_change', id: change?.id, outcome: 'left', reason: 'refund_unconfirmed' })])
      expect((await listed()).map((line) => [line.reason, line.words])).toEqual([['refund_unconfirmed', PAYMENT_DATE_NOT_SENT_STUCK_WORDS['refund_unconfirmed']]])
      expect(PAYMENT_DATE_NOT_SENT_STUCK_WORDS['refund_unconfirmed']).not.toContain('Stripe refused')
      // The next run's refund is refused for good: the line for a person, still in the not-sent words.
      pastTheWindow()
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.invalid('charge_disputed', 'This charge is disputed.') })
      expect((await dateItems(stripe)).map((item) => [item.outcome, item.reason])).toEqual([['left', 'refund_refused']])
      expect((await listed()).map((line) => [line.reason, line.words, line.close?.kind])).toEqual([['refund_refused', PAYMENT_DATE_NOT_SENT_STUCK_WORDS['refund_refused'], 'held_payment_date']])
    })
  })

  it('B2 (R2): the date move refused and the refund answered with a 500, which Stripe saves against the press\'s key and replays: reconcile lists the payment\'s refunds, finds none of its own and sends the refund under a key of its run\'s own, so it goes through; one refund, the record ended, the membership free', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', no())
      stripe.failNext('refunds.create', noAnswer())
      expect(refusalOf(await press())[2]).toBe('refund_unconfirmed')
      const [change] = await changes()
      const [paid] = await taken(stripe)
      // The press's second send was the saved 500 again: Stripe holds no refund.
      expect(refunds(stripe).map((call) => call.idempotencyKey)).toEqual([`${change?.id}:refund`, `${change?.id}:refund`])
      expect(await refundsInStripe(stripe, paid?.id as string)).toEqual([])
      pastTheWindow()
      const requestId = crypto.randomUUID()
      const before = stripe.calls.length
      expect((await reconcileNow(stripe, requestId)).items.filter((item) => item.kind === 'date_change')).toEqual([expect.objectContaining({ kind: 'date_change', id: change?.id, outcome: 'undone' })])
      // The refunds listed just before the send, which is the run's own request.
      expect(stripe.calls.slice(before).map((call) => call.method)).toEqual(['paymentIntents.list', 'refunds.list', 'refunds.create'])
      expect(refunds(stripe).at(-1)?.idempotencyKey).toBe(`${change?.id}:refund:${requestId}`)
      expect(paramsOf(refunds(stripe).at(-1))).toEqual({ payment_intent: paid?.id, metadata: { change_id: change?.id, refund_key: `${change?.id}:refund:${requestId}`, reason: 'payment_date_not_moved' } })
      expect(await refundsInStripe(stripe, paid?.id as string)).toEqual([[2194, change?.id]])
      expect((await changes()).map((row) => [row.status, row.failure_message])).toEqual([['failed', REFUSED_WORDS]])
      expect((await audited(REFUND_WATCH)).map((row) => row.details)).toMatchObject([{ state: 'watching', paymentIntentId: paid?.id, amount: AMOUNT, step: PAYMENT_DATE_REFUND_WATCH_STEP }])
      expect(await listed()).toEqual([])
      // The date move was never sent again, and a later run sends nothing: never a second refund.
      expect(moves(stripe)).toHaveLength(1)
      const calls = stripe.calls.length
      pastTheWindow()
      expect(await dateItems(stripe)).toEqual([])
      expect(stripe.calls).toHaveLength(calls)
      // The membership is free again.
      expect((await cancelPress('cancel')).status).toBe(200)
    })
  })

  it('B2: a run whose own refund gets a 500 too is left (`refund_unconfirmed`), and the next run, under its own key, gets it through: never held for ever on one saved answer', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', no())
      stripe.failNext('refunds.create', noAnswer())
      await press()
      const [change] = await changes()
      const [paid] = await taken(stripe)
      pastTheWindow()
      stripe.failNext('refunds.create', noAnswer())
      const first = crypto.randomUUID()
      expect((await reconcileNow(stripe, first)).items.filter((item) => item.kind === 'date_change')).toEqual([expect.objectContaining({ outcome: 'left', reason: 'refund_unconfirmed' })])
      expect(await refundsInStripe(stripe, paid?.id as string)).toEqual([])
      pastTheWindow()
      const second = crypto.randomUUID()
      expect((await reconcileNow(stripe, second)).items.filter((item) => item.kind === 'date_change')).toEqual([expect.objectContaining({ outcome: 'undone' })])
      expect([...new Set(refunds(stripe).map((call) => call.idempotencyKey))]).toEqual([`${change?.id}:refund`, `${change?.id}:refund:${first}`, `${change?.id}:refund:${second}`])
      expect(await refundsInStripe(stripe, paid?.id as string)).toEqual([[2194, change?.id]])
    })
  })

  it("B3 (R3): the date move refused, the refund not sent (unreachable), then someone refunds £5 by hand in Stripe: the £5 is not the change's refund (it doesn't name the change), so reconcile sends its own, which gives back the rest; £21.94 refunded in all, and \"refunded in full\" is true", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', no())
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      expect(refusalOf(await press())[2]).toBe('refund_unconfirmed')
      const [change] = await changes()
      const [paid] = await taken(stripe)
      await stripe.refunds.create({ payment_intent: paid?.id as string, amount: 500 })
      pastTheWindow()
      expect(await dateItems(stripe)).toEqual([expect.objectContaining({ kind: 'date_change', id: change?.id, outcome: 'undone' })])
      // Newest first: the change's own £16.94, then the £5 by hand.
      expect((await refundsInStripe(stripe, paid?.id as string)).sort()).toEqual([[1694, change?.id], [500, null]].sort())
      expect(stripe.refundedByIntent.get(paid?.id as string)).toBe(2194)
      expect((await changes()).map((row) => [row.status, row.failure_message])).toEqual([['failed', REFUSED_WORDS]])
      // The watch is on the change's own refund, for what it gave back.
      expect((await audited(REFUND_WATCH)).map((row) => row.details)).toMatchObject([{ state: 'watching', paymentIntentId: paid?.id, amount: 16.94, step: PAYMENT_DATE_REFUND_WATCH_STEP }])
      expect(await listed()).toEqual([])
      expect(moves(stripe)).toHaveLength(1)
    })
  })

  it('B3: with the mark there and the whole charge refunded by hand, the change\'s own refund is answered "already refunded": the record is ended, nothing is refunded twice; with no mark, a refund nobody here made is still left for a person', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', no())
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      await press()
      const [change] = await changes()
      const [paid] = await taken(stripe)
      await stripe.refunds.create({ payment_intent: paid?.id as string })
      pastTheWindow()
      expect(await dateItems(stripe)).toEqual([expect.objectContaining({ kind: 'date_change', id: change?.id, outcome: 'undone' })])
      expect(await refundsInStripe(stripe, paid?.id as string)).toEqual([[2194, null]])
      expect((await changes()).map((row) => [row.status, row.failure_message])).toEqual([['failed', REFUSED_WORDS]])
      expect(await listed()).toEqual([])
    })
    // No mark (held at the move, nothing refused): a part refund by hand is nobody's here, and the date is never moved for it.
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      await press()
      const [change] = await changes()
      const [paid] = await taken(stripe)
      const byHand = await stripe.refunds.create({ payment_intent: paid?.id as string, amount: 500 })
      pastTheWindow()
      const sent = moves(stripe).length
      expect(await dateItems(stripe)).toEqual([{ kind: 'date_change', id: change?.id, outcome: 'left', reason: 'refunded_elsewhere', detail: `${byHand.id} succeeded` }])
      expect(moves(stripe)).toHaveLength(sent)
      expect(refunds(stripe).filter((call) => call.idempotencyKey !== null)).toEqual([])
    })
  })
})

describe('a crash at each step (F-plan 4.12 item 6): reconcile settles it, nothing is charged twice and nothing is hidden', () => {
  it('after P1, before Stripe is asked anything: the record is ended, with nothing charged', async () => {
    await onASeed(async (stripe) => {
      await pressThatDies(stripe, 'subscriptions', 'retrieve', false)
      expect((await changes()).map((row) => row.status)).toEqual(['pending'])
      expect(await states()).toEqual(['started'])
      // Held meanwhile.
      expect(refusalOf(await press())).toEqual([409, 'CONFLICT', 'refused', PAYMENT_DATE_REFUSALS.inProgress])
      pastTheWindow()
      expect((await listed()).map((line) => line.reason)).toEqual(['waiting'])
      expect((await dateItems(stripe)).map((item) => item.outcome)).toEqual(['undone'])
      expect((await changes()).map((row) => row.status)).toEqual(['failed'])
      expect(charges(stripe)).toEqual([])
    })
  })

  it('after S2, the charge taken: reconcile moves the date and writes the order; the card was charged once', async () => {
    await onASeed(async (stripe) => {
      await pressThatDies(stripe, 'paymentIntents', 'create', true)
      expect(await taken(stripe)).toHaveLength(1)
      expect((await changes()).map((row) => [row.status, row.stripe_payment_intent_id])).toEqual([['pending', null]])
      pastTheWindow()
      expect((await dateItems(stripe)).map((item) => item.outcome)).toEqual(['finalised'])
      expect(await changes()).toMatchObject([{ status: 'done' }])
      expect(await orders()).toHaveLength(1)
      expect(await renewal()).toBe(NEW_DATE)
      // The dying press's one send is the only charge there ever was.
      expect(charges(stripe)).toHaveLength(1)
      expect(await taken(stripe)).toHaveLength(1)
    })
  })

  it('after S3, the date moved: reconcile finds the date as asked and writes the order, sending nothing', async () => {
    await onASeed(async (stripe) => {
      await pressThatDies(stripe, 'subscriptions', 'update', true)
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.trialEnd).toBe(TRIAL_END)
      expect((await changes()).map((row) => row.status)).toEqual(['pending'])
      expect(await orders()).toEqual([])
      pastTheWindow()
      expect((await dateItems(stripe)).map((item) => item.outcome)).toEqual(['finalised'])
      // The dying press's own move is the only one: reconcile read the subscription and sent nothing.
      expect(moves(stripe)).toHaveLength(1)
      expect(await changes()).toMatchObject([{ status: 'done' }])
      expect(await orders()).toHaveLength(1)
      expect(await taken(stripe)).toHaveLength(1)
    })
  })

  it('before P2 (FB2), the order cannot be written: held, never "success with a warning"; nothing is half recorded; reconcile finishes it', async () => {
    await onASeed(async (stripe) => {
      const answer = await whileFailing(db, { table: 'orders', event: 'INSERT', when: 'true' }, () => press())
      expect(refusalOf(answer)).toEqual([502, 'PAYMENT_UNCONFIRMED', 'finalise_failed', CARD_FLOW_PAID_NOT_FINISHED_MESSAGE])
      const [paid] = await taken(stripe)
      expect((await changes()).map((row) => [row.status, row.stripe_payment_intent_id, row.order_id])).toEqual([['pending', paid?.id, null]])
      expect(await orders()).toEqual([])
      expect(await renewal()).toBe('2026-12-10')
      pastTheWindow()
      expect((await dateItems(stripe)).map((item) => item.outcome)).toEqual(['finalised'])
      const [order] = await orders()
      expect(await changes()).toMatchObject([{ status: 'done', order_id: order?.id, stripe_payment_intent_id: paid?.id }])
      expect(await renewal()).toBe(NEW_DATE)
      expect(charges(stripe)).toHaveLength(1)
    })
  })

  it("P2 failing on reconcile's run too is left (`finalise_failed`), listed, and finished by a later run", async () => {
    await onASeed(async (stripe) => {
      await pressThatDies(stripe, 'subscriptions', 'update', true)
      const [change] = await changes()
      pastTheWindow()
      const items = await whileFailing(db, { table: 'order_line_items', event: 'INSERT', when: 'true' }, () => dateItems(stripe))
      expect(items).toEqual([expect.objectContaining({ kind: 'date_change', id: change?.id, outcome: 'left', reason: 'finalise_failed' })])
      expect(await orders()).toEqual([])
      expect((await listed()).map((line) => [line.reason, line.words, line.close])).toEqual([['finalise_failed', PAYMENT_DATE_STUCK_WORDS['finalise_failed'], undefined]])
      expect((await dateItems(stripe)).map((item) => item.outcome)).toEqual(['finalised'])
      expect(await orders()).toHaveLength(1)
    })
  })
})

describe('a pending record holds the membership (brief W41 item 4)', () => {
  it('a cancel against a held change is refused with the payment-date words, however old the record; an undo too; once settled, the cancel goes through', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', noAnswer())
      await press()
      // An hour on: the old rule let a pending record go after 15 minutes.
      vi.setSystemTime(Date.now() + 60 * 60_000)
      const calls = stripe.calls.length
      expect(refusalOf(await cancelPress('cancel'))).toEqual([409, 'CONFLICT', 'payment_date_changing', 'A payment date change is already in progress for this membership.'])
      expect(stripe.calls).toHaveLength(calls)
      // A cancel date that arrives from Stripe meanwhile (the webhook) can't be undone here either while it is held.
      await db.query("UPDATE customer_memberships SET cancel_effective_date = '2026-12-09' WHERE id = $1", [ID.membership])
      expect(refusalOf(await cancelPress('undo-cancel'))).toEqual([409, 'CONFLICT', 'payment_date_changing', MEMBERSHIP_CANCEL_NEW_WORDS.paymentDateChanging])
      await db.query('UPDATE customer_memberships SET cancel_effective_date = NULL WHERE id = $1', [ID.membership])
      expect((await dateItems(stripe)).map((item) => item.outcome)).toEqual(['undone'])
      expect((await cancelPress('cancel')).status).toBe(200)
    })
  })

  it('a press against a membership with a cancel scheduled is refused (the old words), and its Stripe side too', async () => {
    await onASeed(async (stripe) => {
      expect((await cancelPress('cancel')).status).toBe(200)
      expect(refusalOf(await press())).toEqual([409, 'CONFLICT', 'refused', PAYMENT_DATE_REFUSALS.cancelScheduled])
      expect(charges(stripe)).toEqual([])
    })
  })

  it('a record the Worker did not start (the old code\'s, left pending) holds the membership, is never guessed at, and is listed for a person with a close', async () => {
    await onASeed(
      async (stripe) => {
        expect(refusalOf(await press())).toEqual([409, 'CONFLICT', 'refused', PAYMENT_DATE_REFUSALS.inProgress])
        const [change] = await changes()
        expect(await dateItems(stripe)).toEqual([{ kind: 'date_change', id: change?.id, outcome: 'left', reason: 'unexpected_state' }])
        expect(stripe.calls).toEqual([])
        // W68 (H3): `not_started_here` and its own words went (none is left); the list's words for `unexpected_state`.
        expect((await listed()).map((line) => [line.reason, line.close?.kind])).toEqual([['unexpected_state', 'held_payment_date']])
        expect((await listed()).map((line) => line.words)).toEqual([STUCK_WORDS['unexpected_state']])
        expect(STUCK_WORDS['unexpected_state']).toMatch(/tell a manager/)
        expect(PAYMENT_DATE_STUCK_WORDS['not_started_here']).toBeUndefined()
        expect((await closeStuckItem(db, { kind: 'held_payment_date', orderId: change?.id as string, reason: 'Checked Stripe: no charge' }, { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID() })).closed).toBe(true)
        expect((await press()).status).toBe(200)
      },
      earlier({ status: 'pending', created_at: '2026-11-09T09:00:00.000Z', old_renewal_date: '2026-12-10', new_renewal_date: '2026-12-20', extra_days: 10, amount_charged: '12.90' })
    )
  })
})

describe('reconcile counts payment date changes inside the run\'s budget (brief W41 item 5)', () => {
  it('a run with room for one item settles the change and nothing else; one over the limit waits for the next run', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', noAnswer())
      await press()
      pastTheWindow()
      const none = await reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 0, budgetMs: 60_000 })
      expect(none).toMatchObject({ checked: 0, deferred: 1, items: [] })
      expect((await changes()).map((row) => row.status)).toEqual(['pending'])
      const one = await reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 1, budgetMs: 60_000 })
      expect(one).toMatchObject({ checked: 1, undone: 1, deferred: 0 })
      expect(one.items.map((item) => item.kind)).toEqual(['date_change'])
      // Its row is on the change's own entity, for the list and the close.
      expect((await audited('order.reconcile')).map((row) => [row.entity_type, row.details['outcome']])).toEqual([['payment_date_change', 'undone']])
    })
  })
})

// Brief W45a item 5 (W45 audit F4; W41 review, test-mode item 1). S3 moves the date by starting a no-charge period
// to the new date, and Stripe raises a GBP 0 invoice for it (billing_reason `subscription_update`), paid at once. Its
// invoice.paid reaches the webhook, which calls the database's membership_mark_paid with the invoice line's period
// end: the new date. That is a second writer of next_renewal_date beside P2, landing before or after it. It must
// write no order (the change's one order is P2's), leave the credits alone, and agree with P2 on the date.
describe("the date change's GBP 0 invoice at the webhook (brief W45a item 5; audit F4)", () => {
  type Rows = Record<string, Record<string, unknown>[]>
  /** Every row of every table, by table. */
  const everything = async (): Promise<Rows> => {
    const all: Rows = {}
    for (const table of TABLES.keys()) {
      const sql = `SELECT to_jsonb(t) AS row FROM public.${table} t`
      const rows = (await db.query<{ row: Record<string, unknown> | string }>(sql)).map(({ row }) => (typeof row === 'string' ? (JSON.parse(row) as Record<string, unknown>) : row))
      all[table] = rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    }
    return all
  }
  /** The same, without the two columns the invoice's event may write: a membership's next payment date and when it was last touched. */
  const butTheDate = (all: Rows): Rows => ({
    ...all,
    customer_memberships: (all['customer_memberships'] ?? []).map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'next_renewal_date' && column !== 'updated_at'))),
  })
  const credits = async () => ({
    periods: await db.query('SELECT id, membership_id, period_start::text, period_end::text, credits_allocated, is_unlimited FROM membership_credit_periods ORDER BY id'),
    addOns: await db.query('SELECT id, addon_credits_remaining, bonus_addon_credits FROM customer_memberships ORDER BY id'),
  })
  /** The invoice.paid event for the GBP 0 invoice, as Stripe makes it once the date is moved, handled by the webhook's own code. */
  const zeroInvoicePaid = (stripe: FakeStripe) => {
    // The no-charge period S3 started runs to the new date: that is the invoice line's period end.
    expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)).toMatchObject({ status: 'trialing', trialEnd: TRIAL_END, periodEnd: TRIAL_END })
    // W46b: the £0 invoice is the subscription's newest (the fake keeps one invoice per subscription unless a test says).
    const event = invoiceEvent('invoice.paid', MO_SUBSCRIPTION, { id: stripe.latestInvoice(MO_SUBSCRIPTION), billingReason: 'subscription_update', amountPaid: 0, periodStart: Math.floor(Date.now() / 1000), periodEnd: TRIAL_END })
    return dispatchStripeEvent(event, webhookRpc(db), stripe)
  }
  const MARKED_PAID = { outcome: 'processed', detail: { found: true, action: 'reactivated', was: 'active', bookings_restored: 0, periods_created: 0 } }

  it("after P2: the invoice's event writes no order and nothing else at all, leaves the credits alone, and its date is P2's", async () => {
    await onASeed(async (stripe) => {
      expect((await press()).status).toBe(200)
      expect(await renewal()).toBe(NEW_DATE)
      const [order] = await orders()
      expect(await orders()).toHaveLength(1)
      const before = await everything()
      const creditsBefore = await credits()
      expect(creditsBefore.periods.length).toBeGreaterThan(0)

      vi.setSystemTime(Date.now() + 5_000)
      expect(await zeroInvoicePaid(stripe)).toEqual(MARKED_PAID)

      // The date the webhook wrote is the one P2 wrote; the change's one order is still the only order.
      expect(await renewal()).toBe(NEW_DATE)
      expect(await orders()).toEqual([order])
      expect(await lines()).toHaveLength(1)
      expect(await credits()).toEqual(creditsBefore)
      const after = await everything()
      expect(butTheDate(after)).toEqual(butTheDate(before))
      // And the date column itself did not move, on any membership.
      expect((after['customer_memberships'] ?? []).map((row) => [row['id'], row['next_renewal_date']])).toEqual((before['customer_memberships'] ?? []).map((row) => [row['id'], row['next_renewal_date']]))
      expect(charges(stripe)).toHaveLength(1)
    })
  })

  it("before P2 (the press died once the date was moved): the invoice's event writes the new date first, with no order and the credits alone; reconcile's P2 then writes the one order and the same date; the event handled again changes nothing", async () => {
    await onASeed(async (stripe) => {
      await pressThatDies(stripe, 'subscriptions', 'update', true)
      expect((await changes()).map((row) => row.status)).toEqual(['pending'])
      expect(await orders()).toEqual([])
      expect(await renewal()).toBe('2026-12-10')
      const before = await everything()
      const creditsBefore = await credits()

      vi.setSystemTime(Date.now() + 5_000)
      expect(await zeroInvoicePaid(stripe)).toEqual(MARKED_PAID)

      // The webhook moved the date on its own, to the date P2 will write: nothing else in the database changed.
      expect(await renewal()).toBe(NEW_DATE)
      expect(await orders()).toEqual([])
      expect(await lines()).toEqual([])
      expect((await changes()).map((row) => [row.status, row.order_id])).toEqual([['pending', null]])
      expect(await credits()).toEqual(creditsBefore)
      expect(butTheDate(await everything())).toEqual(butTheDate(before))

      // P2, by reconcile, with the date already as asked: the order, the record done, the same date. Nothing is sent.
      pastTheWindow()
      expect((await dateItems(stripe)).map((item) => item.outcome)).toEqual(['finalised'])
      const [order] = await orders()
      expect(await orders()).toHaveLength(1)
      expect(order).toMatchObject({ order_total: '21.94', payment_status: 'paid', payment_method: 'card' })
      expect(await changes()).toMatchObject([{ status: 'done', order_id: order?.id, new: NEW_DATE }])
      expect(await renewal()).toBe(NEW_DATE)
      expect(await credits()).toEqual(creditsBefore)
      expect(moves(stripe)).toHaveLength(1)
      expect(charges(stripe)).toHaveLength(1)
      expect(await taken(stripe)).toHaveLength(1)

      // The same invoice's event handled once more, after P2 (a second delivery): still one order, the same date.
      const settled = await everything()
      expect(await zeroInvoicePaid(stripe)).toEqual(MARKED_PAID)
      expect(butTheDate(await everything())).toEqual(butTheDate(settled))
      expect(await renewal()).toBe(NEW_DATE)
      expect(await orders()).toEqual([order])
    })
  })
})
