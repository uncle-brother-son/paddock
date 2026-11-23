import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as savedCardRoute } from '@/app/api/v1/staff/customers/[customerId]/saved-card/route'
import { POST as cancelRoute } from '@/app/api/v1/staff/memberships/[membershipId]/cancel/route'
import type { Db } from '@/server/db'
import { LEFT_STEP_WORDS } from '@/server/rules/memberships/failure-messages'
import { CHECK_AFTER_MINUTES, OPEN_STEPS_SQL, sortLeftStep, STEP_CHECK_ACTION, STEP_LEFT_ACTION, stepKey } from '@/server/rules/memberships/left'
import { reconcile } from '@/server/rules/orders/reconcile'
import { stuckList } from '@/server/rules/orders/stuck-list'
import { insert } from '@/server/rules/testing/database'
import { orderInput, postOrder, postReaderStep, withQuotedCardFigure, type OrderAnswer } from '@/server/rules/testing/sweep/order-presses'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { ID, MO_SUBSCRIPTION, seed, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { SAVED_CARD_WORDS } from './failure-messages'
import { CARD_SAVED_ACTION, INVOICE_DEFAULT_ACTION } from './saved-card'

// Brief W42 items 1 to 4 and 7 (F-plan 4.7; Q19; Wayne's Q45; W11 F4 / FB17; lead call L11): a customer's card
// replaced through the Worker's route on the replay's live schema with the fake Stripe. What must hold: a tap made
// for another customer is refused with nothing saved; the card, its audit row and one card step per live membership
// go in one transaction; each subscription is then moved under its step's key, with only its card sent; the card is
// saved whatever Stripe says about a membership; a step Stripe didn't take is listed, sent again and checked by W40's
// machinery; the newest card wins; and with `card_moves` off the card is saved exactly as before W42.

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
/** Mo: the member, with one live membership on `sub_mo` and the card `pm_member`. */
const MO_STRIPE = 'cus_member'
/** Sam: a customer with a card (`pm_seed`) and no membership. */
const SAM_STRIPE = 'cus_seed'
const MONTHLY_PRICE = 'price_seed_monthly'
const SECOND_MEMBERSHIP = '10000000-0000-4000-8000-0000000042a1'
const SECOND_SUBSCRIPTION = 'sub_mo_second'
const ON = 'membership_changes,payment_date_changes,card_moves'
const WINDOW_MS = 15 * 60_000
const pastTheWindow = () => vi.setSystemTime(Date.now() + WINDOW_MS + 60_000)
const pastTheCheck = () => vi.setSystemTime(Date.now() + (CHECK_AFTER_MINUTES + 1) * 60_000)

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

/** The replay's seed with Mo's membership as live ones are (a Stripe subscription), one more staff member, then `prepare`, then `work`. */
async function onASeed(work: (stripe: FakeStripe) => Promise<void>, prepare?: Prepare, switchValue: string = ON): Promise<void> {
  await replay(
    environment,
    {
      name: 'w42 replace card',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await seedDb.query("UPDATE customer_memberships SET stripe_subscription_id = $1, next_renewal_date = '2026-12-10' WHERE id = $2", [MO_SUBSCRIPTION, ID.membership])
        stripe.addSubscription(MO_SUBSCRIPTION, MO_STRIPE, MONTHLY_PRICE)
        await insert(seedDb, 'staff', { first_name: 'Fran', last_name: 'Desk', email: NO_REFUNDS, role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
        await prepare?.(seedDb, stripe)
      },
      async run({ stripe }) {
        replayStripe.current = stripe
        // These presses run with the kinds named.
        vi.stubEnv('ORDER_SWITCH', switchValue)
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

/** A second live membership for Mo, on its own subscription. */
const secondMembership =
  (status = 'active'): Prepare =>
  async (seedDb, stripe) => {
    await insert(seedDb, 'customer_memberships', { id: SECOND_MEMBERSHIP, customer_id: ID.member, plan_id: ID.plan, start_date: '2026-02-01', subscription_status: status, billing_frequency: 'monthly', stripe_subscription_id: SECOND_SUBSCRIPTION })
    stripe.addSubscription(SECOND_SUBSCRIPTION, MO_STRIPE, MONTHLY_PRICE)
  }
const set =
  (sql: string, params: unknown[] = [ID.membership]): Prepare =>
  async (seedDb) =>
    void (await seedDb.query(sql, params as string[]))

/** A card-save tap on the reader for `stripeCustomer`, which leaves the reusable card `card`. */
async function tapped(stripe: FakeStripe, stripeCustomer: string | undefined, card: string): Promise<string> {
  const intent = await stripe.setupIntents.create({ ...(stripeCustomer ? { customer: stripeCustomer } : {}), payment_method_types: ['card_present'], usage: 'off_session' })
  stripe.completeReaderSetup(intent.id, { generatedCard: card })
  return intent.id
}

type ErrorBody = { code: string; message: string; details?: { reason?: string; message?: string; action?: string } }
type Answer = { status: number; replayed: boolean; data?: Record<string, unknown>; error?: ErrorBody }

async function save(setupIntentId: string, { customerId = ID.member as string, email = REPLAY_USER.email, key = crypto.randomUUID() as string } = {}): Promise<Answer> {
  // The replay holds the clock still (Postgres's too): moved on between presses, so rows read in time order keep theirs.
  vi.setSystemTime(Date.now() + 1000)
  const response = await savedCardRoute(
    new Request(`https://worker.test/api/v1/staff/customers/${customerId}/saved-card`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': email, 'idempotency-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ setupIntentId }),
    }),
    { params: Promise.resolve({ customerId }) }
  )
  const body = (await response.json()) as { data?: Record<string, unknown>; error?: ErrorBody }
  return { status: response.status, replayed: response.headers.get('Idempotency-Replayed') === 'true', ...body }
}
/** Mo taps `card` and it is saved to her. */
const replace = async (stripe: FakeStripe, card: string) => save(await tapped(stripe, MO_STRIPE, card))

async function cancel(membershipId: string = ID.membership): Promise<Answer> {
  vi.setSystemTime(Date.now() + 1000)
  const response = await cancelRoute(
    new Request(`https://worker.test/api/v1/staff/memberships/${membershipId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      body: '{}',
    }),
    { params: Promise.resolve({ membershipId }) }
  )
  const body = (await response.json()) as { data?: Record<string, unknown>; error?: ErrorBody }
  return { status: response.status, replayed: false, ...body }
}

type AuditRow = { action: string; actor_type: string; actor_id: string | null; entity_type: string; entity_id: string; details: Record<string, unknown> }
// Rows written back to back can share a millisecond: a step's `left` row is read before any other row of that moment.
const audited = (action: string) =>
  db.query<AuditRow>("SELECT action, actor_type, actor_id, entity_type, entity_id, details FROM audit_log WHERE action = $1 ORDER BY at, (details->>'state' = 'left') DESC NULLS LAST, details->>'stepId'", [action])
const cardOf = async (customerId: string = ID.member) =>
  (await db.query<{ card: string | null; last4: string | null; brand: string | null }>('SELECT saved_payment_method_id AS card, saved_card_last4 AS last4, saved_card_brand AS brand FROM customers WHERE id = $1', [customerId]))[0]
/** Every step row, oldest first: [kind, state, the card or cancel date it wants, its subscription]. */
const stepRows = async () =>
  (await audited(STEP_LEFT_ACTION)).map((row) => {
    const want = row.details['want'] as { paymentMethod?: string; cancelAt?: number | null }
    return [row.details['kind'], row.details['state'], want.paymentMethod ?? want.cancelAt ?? null, row.details['subscriptionId']]
  })
const cardStepIds = async () => (await audited(STEP_LEFT_ACTION)).filter((row) => row.details['kind'] === 'payment_method' && row.details['state'] === 'left').map((row) => String(row.details['stepId']))
const paramsOf = (call: { params: unknown } | undefined): Record<string, unknown> => (call?.params ?? {}) as Record<string, unknown>
const updates = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'subscriptions.update')
const invoiceDefaults = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'customers.update')
const subscriptionCard = (stripe: FakeStripe, id: string = MO_SUBSCRIPTION) => stripe.subscriptionSettings(id)?.defaultPaymentMethod ?? null
const listed = async () => (await stuckList(db)).steps
const reconcileNow = (stripe: FakeStripe) => reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
const no = () => ({ kind: 'error' as const, error: fakeStripeErrors.invalid('subscription_update_refused', 'This subscription cannot be updated right now.') })
const noAnswer = () => ({ kind: 'error' as const, error: fakeStripeErrors.server() })
const counts = (answer: Answer) => [answer.status, answer.data?.['membershipsMoved'], answer.data?.['membershipsToMove']]

describe("F4 / FB17: the tap must be this customer's", () => {
  it("another customer's tap is refused in plain words, with nothing saved, no step and nothing sent to Stripe", async () => {
    await onASeed(async (stripe) => {
      // Sam taps his card (Stripe customer cus_seed). The save names Mo.
      const answer = await save(await tapped(stripe, SAM_STRIPE, 'pm_sams_card'))
      expect([answer.status, answer.error?.code, answer.error?.details?.reason, answer.error?.details?.action, answer.error?.message]).toEqual([409, 'CONFLICT', 'other_customer', 'saved_card', SAVED_CARD_WORDS.otherCustomer])
      expect(SAVED_CARD_WORDS.otherCustomer).toBe("This card was tapped for a different customer, so it can't be saved to this one. Nothing was saved. Start again from this customer's own page and ask them to tap their card.")
      expect((await cardOf())?.card).toBe('pm_member')
      expect((await cardOf(ID.customer))?.card).toBe('pm_seed')
      expect(await audited(CARD_SAVED_ACTION)).toEqual([])
      expect(await audited(INVOICE_DEFAULT_ACTION)).toEqual([])
      expect(await stepRows()).toEqual([])
      expect([...updates(stripe), ...invoiceDefaults(stripe)]).toEqual([])
      expect(subscriptionCard(stripe)).toBeNull()
    })
  })

  it('a tap that names no Stripe customer, and a customer with no Stripe customer of their own, are refused the same way', async () => {
    await onASeed(async (stripe) => {
      const unnamed = await save(await tapped(stripe, undefined, 'pm_nobodys_card'))
      expect([unnamed.status, unnamed.error?.details?.reason]).toEqual([409, 'other_customer'])
      await db.query('UPDATE customers SET stripe_customer_id = NULL WHERE id = $1', [ID.member])
      const noStripeCustomer = await save(await tapped(stripe, MO_STRIPE, 'pm_mos_new_card'))
      expect([noStripeCustomer.status, noStripeCustomer.error?.details?.reason]).toEqual([409, 'other_customer'])
      expect((await cardOf())?.card).toBe('pm_member')
      expect(await audited(CARD_SAVED_ACTION)).toEqual([])
      expect(await stepRows()).toEqual([])
    })
  })

  it('an unknown customer and a card that cannot be charged later keep their old words', async () => {
    await onASeed(async (stripe) => {
      const unknown = await save(await tapped(stripe, MO_STRIPE, 'pm_mos_new_card'), { customerId: '10000000-0000-4000-8000-0000000042ff' })
      expect([unknown.status, unknown.error?.message]).toEqual([404, 'Customer not found'])
      // The simulated reader: a card_present card with no reusable companion.
      const intent = await stripe.setupIntents.create({ customer: MO_STRIPE, payment_method_types: ['card_present'], usage: 'off_session' })
      stripe.completeReaderSetup(intent.id)
      const simulated = await save(intent.id)
      expect(simulated.status).toBe(400)
      expect(simulated.error?.message).toContain('This card cannot be saved for future off-session charges')
      expect((await cardOf())?.card).toBe('pm_member')
      expect(await stepRows()).toEqual([])
    })
  })
})

describe('K1 and the move: one, two and no memberships (Q19)', () => {
  it("one membership: the card, its audit row and one card step in K1; then the invoice default and the subscription's card, and only its card, under the step's key", async () => {
    await onASeed(async (stripe) => {
      const answer = await replace(stripe, 'pm_mos_new_card')
      expect(answer.status).toBe(200)
      expect(answer.data).toEqual({ id: ID.member, stripe_customer_id: MO_STRIPE, saved_payment_method_id: 'pm_mos_new_card', saved_card_last4: '1881', saved_card_brand: 'mastercard', membershipsMoved: 1, membershipsToMove: 0 })
      expect(await cardOf()).toEqual({ card: 'pm_mos_new_card', last4: '1881', brand: 'mastercard' })

      const [stepId] = await cardStepIds()
      expect(await stepRows()).toEqual([
        ['payment_method', 'left', 'pm_mos_new_card', MO_SUBSCRIPTION],
        ['payment_method', 'done', 'pm_mos_new_card', MO_SUBSCRIPTION],
      ])
      const [saved] = await audited(CARD_SAVED_ACTION)
      expect(saved).toMatchObject({ actor_type: 'staff', actor_id: ID.staff, entity_type: 'customer', entity_id: ID.member })
      expect(saved?.details).toMatchObject({ paymentMethodId: 'pm_mos_new_card', last4: '1881', brand: 'mastercard', replaced: 'pm_member', subscriptions: [MO_SUBSCRIPTION] })

      // Stripe: the subscription read and its one update, and the customer's invoice default last (W42a, W42 review L4:
      // a slow invoice default must not use up the time the subscription needs).
      expect(stripe.calls.map((call) => call.method).filter((method) => /^(customers\.update|subscriptions\.)/.test(method))).toEqual(['subscriptions.retrieve', 'subscriptions.update', 'customers.update'])
      expect(invoiceDefaults(stripe).map((call) => call.params)).toEqual([{ id: MO_STRIPE, invoice_settings: { default_payment_method: 'pm_mos_new_card' } }])
      expect(updates(stripe)).toHaveLength(1)
      // W40 review L5: a card step sends its own field and nothing else (no cancel date, no proration, no trial end).
      expect(paramsOf(updates(stripe)[0])).toEqual({ id: MO_SUBSCRIPTION, default_payment_method: 'pm_mos_new_card' })
      expect(updates(stripe)[0]?.idempotencyKey).toBe(stepKey({ id: stepId as string, kind: 'payment_method' }))
      expect(subscriptionCard(stripe)).toBe('pm_mos_new_card')
      expect((await audited(INVOICE_DEFAULT_ACTION)).map((row) => row.details)).toEqual([{ stripeCustomerId: MO_STRIPE, paymentMethodId: 'pm_mos_new_card', set: true }])
      // Nothing is charged, refunded or cancelled, and nothing is listed.
      expect(stripe.calls.filter((call) => /^(paymentIntents\.create|refunds\.|subscriptions\.cancel|invoices\.)/.test(call.method))).toEqual([])
      expect(await listed()).toEqual([])
    })
  })

  it('two memberships: one step each, both moved; any active staff member may (no Issue refunds needed)', async () => {
    await onASeed(async (stripe) => {
      const answer = await save(await tapped(stripe, MO_STRIPE, 'pm_mos_new_card'), { email: NO_REFUNDS })
      expect(counts(answer)).toEqual([200, 2, 0])
      expect(subscriptionCard(stripe)).toBe('pm_mos_new_card')
      expect(subscriptionCard(stripe, SECOND_SUBSCRIPTION)).toBe('pm_mos_new_card')
      expect((await stepRows()).filter(([, state]) => state === 'left').map(([, , , subscription]) => subscription).sort()).toEqual([MO_SUBSCRIPTION, SECOND_SUBSCRIPTION].sort())
      expect((await stepRows()).filter(([, state]) => state === 'done')).toHaveLength(2)
      expect(invoiceDefaults(stripe)).toHaveLength(1)
      // W42a (L4): both subscriptions first, the invoice default after them.
      expect(stripe.calls.map((call) => call.method).filter((method) => /^(customers\.update|subscriptions\.update)/.test(method))).toEqual(['subscriptions.update', 'subscriptions.update', 'customers.update'])
    }, secondMembership())
  })

  it('no membership: the card is saved, the invoice default set, no step and no subscription touched', async () => {
    await onASeed(async (stripe) => {
      const answer = await save(await tapped(stripe, SAM_STRIPE, 'pm_sams_new_card'), { customerId: ID.customer })
      expect(counts(answer)).toEqual([200, 0, 0])
      expect((await cardOf(ID.customer))?.card).toBe('pm_sams_new_card')
      expect(await stepRows()).toEqual([])
      expect(updates(stripe)).toEqual([])
      expect(stripe.calls.filter((call) => call.method === 'subscriptions.retrieve')).toEqual([])
      expect(invoiceDefaults(stripe).map((call) => call.params)).toEqual([{ id: SAM_STRIPE, invoice_settings: { default_payment_method: 'pm_sams_new_card' } }])
      // Mo's card and subscription are as they were.
      expect((await cardOf())?.card).toBe('pm_member')
      expect(subscriptionCard(stripe)).toBeNull()
    })
  })

  it('a failing membership is moved like any other, and no payment is taken (Q45)', async () => {
    await onASeed(
      async (stripe) => {
        expect(counts(await replace(stripe, 'pm_mos_new_card'))).toEqual([200, 1, 0])
        expect(subscriptionCard(stripe)).toBe('pm_mos_new_card')
        expect(stripe.calls.filter((call) => /^(paymentIntents\.|invoices\.|refunds\.)/.test(call.method))).toEqual([])
        expect((await db.query<{ status: string }>('SELECT subscription_status AS status FROM customer_memberships WHERE id = $1', [ID.membership]))[0]?.status).toBe('past_due')
      },
      set("UPDATE customer_memberships SET subscription_status = 'past_due' WHERE id = $1")
    )
  })

  it('an ended membership is left alone: no step, and its subscription is not read or changed', async () => {
    await onASeed(async (stripe) => {
      expect(counts(await replace(stripe, 'pm_mos_new_card'))).toEqual([200, 1, 0])
      expect((await stepRows()).map(([, , , subscription]) => subscription)).toEqual([MO_SUBSCRIPTION, MO_SUBSCRIPTION])
      expect(stripe.calls.filter((call) => paramsOf(call)['id'] === SECOND_SUBSCRIPTION)).toEqual([])
      expect(subscriptionCard(stripe, SECOND_SUBSCRIPTION)).toBeNull()
    }, secondMembership('cancelled'))
  })

  it('a subscription Stripe has already ended settles its step with nothing sent', async () => {
    await onASeed(async (stripe) => {
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      expect(counts(await replace(stripe, 'pm_mos_new_card'))).toEqual([200, 1, 0])
      expect(updates(stripe)).toEqual([])
      expect((await stepRows()).map(([, state]) => state)).toEqual(['left', 'done'])
    })
  })

  it('the same press again (the same key) answers what the first did and does nothing more', async () => {
    await onASeed(async (stripe) => {
      const intent = await tapped(stripe, MO_STRIPE, 'pm_mos_new_card')
      const key = crypto.randomUUID()
      const first = await save(intent, { key })
      const again = await save(intent, { key })
      expect(again.replayed).toBe(true)
      expect(again.data).toEqual(first.data)
      expect(updates(stripe)).toHaveLength(1)
      expect(await audited(CARD_SAVED_ACTION)).toHaveLength(1)
      expect(await cardStepIds()).toHaveLength(1)
    })
  })
})

describe('a membership that cannot be moved yet: the card is saved, the step left, listed, sent again', () => {
  it('refused by Stripe, then left, then moved by reconcile once past the window', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', no())
      const answer = await replace(stripe, 'pm_mos_new_card')
      // The card is saved even though the membership couldn't be moved.
      expect(counts(answer)).toEqual([200, 0, 1])
      expect((await cardOf())?.card).toBe('pm_mos_new_card')
      expect(subscriptionCard(stripe)).toBeNull()
      const [stepId] = await cardStepIds()
      expect((await stepRows()).map(([, state]) => state)).toEqual(['left'])

      // Listed, with the card's words; not something a person can close while the check is still sending it.
      const [line] = await listed()
      expect(line).toMatchObject({ stepId, membershipId: ID.membership, subscriptionId: MO_SUBSCRIPTION, step: 'payment_method', what: 'card', state: 'left', customerId: ID.member })
      expect(line?.words).toBe(LEFT_STEP_WORDS.payment_method.left(MO_SUBSCRIPTION))
      expect(line?.words).toContain('its next payment could still go to the old card')
      expect(line?.close).toBeUndefined()

      // Inside the press's window reconcile leaves it alone.
      await reconcileNow(stripe)
      expect(updates(stripe)).toHaveLength(1)
      // Past it: read, sent again under a key of that run, done.
      pastTheWindow()
      await reconcileNow(stripe)
      expect(updates(stripe)).toHaveLength(2)
      expect(paramsOf(updates(stripe)[1])).toEqual({ id: MO_SUBSCRIPTION, default_payment_method: 'pm_mos_new_card' })
      expect(updates(stripe)[1]?.idempotencyKey?.startsWith(`${stepKey({ id: stepId as string, kind: 'payment_method' })}:`)).toBe(true)
      expect(subscriptionCard(stripe)).toBe('pm_mos_new_card')
      expect((await stepRows()).map(([, state]) => state)).toEqual(['left', 'done'])
      expect(await listed()).toEqual([])
    })
  })

  it('no clear answer from Stripe: left the same way, and a later run that finds Stripe already shows the card sends nothing', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      expect(counts(await replace(stripe, 'pm_mos_new_card'))).toEqual([200, 0, 1])
      expect(await listed()).toHaveLength(1)
      // The send landed after all (or a person set it in Stripe by hand).
      await stripe.subscriptions.update(MO_SUBSCRIPTION, { default_payment_method: 'pm_mos_new_card' })
      const sent = updates(stripe).length
      pastTheWindow()
      await reconcileNow(stripe)
      expect(updates(stripe)).toHaveLength(sent)
      expect((await stepRows()).map(([, state]) => state)).toEqual(['left', 'done'])
      expect(await listed()).toEqual([])
    })
  })

  it('refused again by reconcile: recorded as refused, listed for a person with the refused words, never sent again, and Mark sorted closes it', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', no())
      await replace(stripe, 'pm_mos_new_card')
      pastTheWindow()
      stripe.failNext('subscriptions.update', no())
      await reconcileNow(stripe)
      const [line] = await listed()
      expect(line).toMatchObject({ step: 'payment_method', what: 'card', state: 'refused' })
      expect(line?.words).toBe(LEFT_STEP_WORDS.payment_method.refused(MO_SUBSCRIPTION))
      expect(line?.close).toEqual({ kind: 'left_step', orderId: line?.stepId })
      const sent = updates(stripe).length
      pastTheWindow()
      await reconcileNow(stripe)
      expect(updates(stripe)).toHaveLength(sent)
      // The card stays saved throughout.
      expect((await cardOf())?.card).toBe('pm_mos_new_card')
      const sorted = await sortLeftStep(db, line?.stepId as string, 'set in Stripe by hand', { actor: { type: 'staff', id: ID.staff }, requestId: 'req-sorted' })
      expect(sorted).toEqual({ closed: true, message: LEFT_STEP_WORDS.sorted })
      expect(await listed()).toEqual([])
    })
  })

  it('two memberships, one refused: one moved, one still to move, and only that one is listed', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', no())
      const answer = await replace(stripe, 'pm_mos_new_card')
      expect(counts(answer)).toEqual([200, 1, 1])
      expect(await listed()).toHaveLength(1)
      const cards = [subscriptionCard(stripe), subscriptionCard(stripe, SECOND_SUBSCRIPTION)].sort()
      expect(cards).toEqual(['pm_mos_new_card', null].sort())
    }, secondMembership())
  })
})

describe('a second replace before the first has finished: the newest card wins', () => {
  // The replay's clock stands still inside a press, so rows of one press can share a moment: compared as a set.
  const byCardThenState = (rows: unknown[][]) => rows.map((row) => row.join(' ')).sort()

  it("the first's open card step ends as replaced; the second's is sent, and (W42a, S2) because the first press may still be sending, its wish is left again and stays listed until a run past the window has read Stripe", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      expect(counts(await replace(stripe, 'pm_first_new_card'))).toEqual([200, 0, 1])
      // Inside the first's window: not refused (a cancel would be), because the newest card must be the one saved.
      const second = await replace(stripe, 'pm_second_new_card')
      expect(counts(second)).toEqual([200, 1, 0])
      expect((await cardOf())?.card).toBe('pm_second_new_card')
      // The second's step was left over one still inside its window: marked in K1, so its press's ending leaves the
      // wish again (the step closed as replaced by a new one) instead of closing it done.
      expect(byCardThenState(await stepRows())).toEqual(
        byCardThenState([
          ['payment_method', 'left', 'pm_first_new_card', MO_SUBSCRIPTION],
          ['payment_method', 'replaced', 'pm_first_new_card', MO_SUBSCRIPTION],
          ['payment_method', 'left', 'pm_second_new_card', MO_SUBSCRIPTION],
          ['payment_method', 'stale_send', 'pm_second_new_card', MO_SUBSCRIPTION],
          ['payment_method', 'replaced', 'pm_second_new_card', MO_SUBSCRIPTION],
          ['payment_method', 'left', 'pm_second_new_card', MO_SUBSCRIPTION],
        ])
      )
      // The mark names the step whose press may still be sending, and is written with the new step's `left` row (K1's own request).
      const rows = await audited(STEP_LEFT_ACTION)
      const [firstStep] = rows.filter((row) => row.details['state'] === 'left' && (row.details['want'] as { paymentMethod?: string }).paymentMethod === 'pm_first_new_card')
      const mark = rows.find((row) => row.details['state'] === 'stale_send')
      expect(mark?.details['staleStep']).toBe(firstStep?.details['stepId'])
      expect(subscriptionCard(stripe)).toBe('pm_second_new_card')
      expect((await listed()).map((line) => [line.step, line.state, line.what])).toEqual([['payment_method', 'left', 'card']])
      expect((await audited(CARD_SAVED_ACTION)).map((row) => row.details['replaced'])).toEqual(['pm_member', 'pm_first_new_card'])
      // Past the window the run reads Stripe, finds the second card, and closes the step: nothing more is sent, and
      // never the replaced step's card.
      pastTheWindow()
      await reconcileNow(stripe)
      expect(updates(stripe).map((call) => paramsOf(call)['default_payment_method'])).toEqual(['pm_first_new_card', 'pm_second_new_card'])
      expect(subscriptionCard(stripe)).toBe('pm_second_new_card')
      expect(await listed()).toEqual([])
    })
  })

  it("the first's send lands late, over the second's: it is listed from the second press on (W42a, S2), and the first run past the window sends the newest card again; the check then has nothing to put right", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      await replace(stripe, 'pm_first_new_card')
      await replace(stripe, 'pm_second_new_card')
      // The first press's send, which got no answer, lands in Stripe now.
      stripe.setSubscription(MO_SUBSCRIPTION, {})
      await stripe.subscriptions.update(MO_SUBSCRIPTION, { default_payment_method: 'pm_first_new_card' })
      expect(subscriptionCard(stripe)).toBe('pm_first_new_card')
      // Before W42a nothing was listed here until the check, 20 minutes on.
      expect((await listed()).map((line) => [line.step, line.state])).toEqual([['payment_method', 'left']])

      pastTheWindow()
      await reconcileNow(stripe)
      expect(subscriptionCard(stripe)).toBe('pm_second_new_card')
      expect(await listed()).toEqual([])
      pastTheCheck()
      await reconcileNow(stripe)
      expect((await audited(STEP_CHECK_ACTION)).map((row) => row.details['outcome'])).toEqual(['checked'])
      expect(subscriptionCard(stripe)).toBe('pm_second_new_card')
      expect(await listed()).toEqual([])
    })
  })

  it("W42 review R2, turned round: a first press still at Stripe when a second replaces its step sends the older card after the second's; Stripe ends on card 2, and it is listed until it does", async () => {
    await onASeed(async (stripe) => {
      // Press 1 has left its step and is reading the subscription (its send comes next). Press 2 runs to the end
      // there; then press 1's read is answered as it was made, and press 1 sends its own, older card.
      const subscriptions = stripe.subscriptions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
      const retrieve = subscriptions['retrieve'] as (...args: unknown[]) => Promise<unknown>
      let second: Answer | null = null
      let held = false
      subscriptions['retrieve'] = async (...args: unknown[]) => {
        const answer = await retrieve.apply(stripe.subscriptions, args)
        if (!held) {
          held = true
          second = await replace(stripe, 'pm_second_new_card')
        }
        return answer
      }
      const first = await replace(stripe, 'pm_first_new_card')
      expect(counts(second as unknown as Answer)).toEqual([200, 1, 0])
      expect(first.status).toBe(200)
      expect((await cardOf())?.card).toBe('pm_second_new_card')
      // The sends landed in the wrong order: Stripe shows press 1's card, the profile press 2's.
      expect(updates(stripe).map((call) => paramsOf(call)['default_payment_method'])).toEqual(['pm_second_new_card', 'pm_first_new_card'])
      expect(subscriptionCard(stripe)).toBe('pm_first_new_card')
      // Listed, as a card still being sent, from the moment press 2 finished: not 20 minutes later.
      const lines = await listed()
      expect(lines.map((line) => [line.step, line.state, line.what])).toEqual([['payment_method', 'left', 'card']])
      // Inside the window the run leaves it to the press.
      await reconcileNow(stripe)
      expect(subscriptionCard(stripe)).toBe('pm_first_new_card')
      expect(await listed()).toHaveLength(1)
      // The first run past the window reads Stripe, finds card 1 and sends card 2.
      pastTheWindow()
      await reconcileNow(stripe)
      expect(subscriptionCard(stripe)).toBe('pm_second_new_card')
      expect(await listed()).toEqual([])
      // The check, later, agrees: nothing left again.
      pastTheCheck()
      await reconcileNow(stripe)
      expect((await audited(STEP_CHECK_ACTION)).map((row) => row.details['outcome'])).toEqual(['checked'])
      expect(subscriptionCard(stripe)).toBe('pm_second_new_card')
    })
  })

  it("a press whose step has been replaced by the time it comes to send it sends nothing for it (W42a, S2's narrowing): two memberships, the second replace lands while the first press is on the first membership", async () => {
    await onASeed(async (stripe) => {
      const subscriptions = stripe.subscriptions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
      const update = subscriptions['update'] as (...args: unknown[]) => Promise<unknown>
      let second: Answer | null = null
      let held = false
      subscriptions['update'] = async (...args: unknown[]) => {
        const answer = await update.apply(stripe.subscriptions, args)
        if (!held) {
          held = true
          second = await replace(stripe, 'pm_second_new_card')
        }
        return answer
      }
      const first = await replace(stripe, 'pm_first_new_card')
      expect(counts(second as unknown as Answer)).toEqual([200, 2, 0])
      // Press 1 moved the one membership it had already sent, and sent nothing for the other: its step was replaced.
      expect(counts(first)).toEqual([200, 1, 1])
      const sent = updates(stripe).map((call) => [paramsOf(call)['id'], paramsOf(call)['default_payment_method']])
      expect(sent.filter(([, card]) => card === 'pm_first_new_card')).toHaveLength(1)
      expect(subscriptionCard(stripe)).toBe('pm_second_new_card')
      expect(subscriptionCard(stripe, SECOND_SUBSCRIPTION)).toBe('pm_second_new_card')
      pastTheWindow()
      await reconcileNow(stripe)
      expect(subscriptionCard(stripe)).toBe('pm_second_new_card')
      expect(subscriptionCard(stripe, SECOND_SUBSCRIPTION)).toBe('pm_second_new_card')
      expect(await listed()).toEqual([])
    }, secondMembership())
  })
})

// W42a item 1 (W42 review S1; W42 report, Noticed 1): one rule for "the memberships follow the customer's saved
// card". With `card_moves` on, an order's T2 that writes a membership or saves a card takes the customer's lock and
// leaves a card step for every live membership against the customer's saved card as it is then; the caller sends them.
describe("W42a: an order's T2 runs the same rule (card_moves on)", () => {
  const ORDER_KINDS_ON = 'no_stripe,saved_card,reader,membership,membership_changes,payment_date_changes,card_moves'
  const ORDER_KINDS_NO_MOVES = 'no_stripe,saved_card,reader,membership,membership_changes,payment_date_changes'
  const towel = { addonId: ID.addon, quantity: 1, unitPrice: 5, systemUnitPrice: 5 }
  const membershipOnCard = () => ({ ...orderInput({ customerId: ID.customer, membershipPlanId: ID.plan, membershipBillingFrequency: 'monthly', payment: { method: 'card' } }), confirmed: { toCollect: 0, firstInvoice: 40 } })
  const samsMembership = async () => (await db.query<{ id: string; stripe_subscription_id: string | null; subscription_status: string }>('SELECT id, stripe_subscription_id, subscription_status FROM customer_memberships WHERE customer_id = $1', [ID.customer]))[0]
  const placed = (answer: OrderAnswer) => (answer.body.ok ? answer.body.data : null)

  /** Sam replaces his card at the moment the membership order's subscription is being made (after its T1, before its T2). */
  function replacingDuringTheOrder(stripe: FakeStripe, card: string): { answer(): Answer | null } {
    const subscriptions = stripe.subscriptions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const create = subscriptions['create'] as (...args: unknown[]) => Promise<unknown>
    let replaced: Answer | null = null
    let done = false
    subscriptions['create'] = async (...args: unknown[]) => {
      if (!done) {
        done = true
        replaced = await save(await tapped(stripe, SAM_STRIPE, card), { customerId: ID.customer })
      }
      return create.apply(stripe.subscriptions, args)
    }
    return { answer: () => replaced }
  }

  it("W42 review R1, turned round: the card is replaced while a saved-card membership order is at Stripe (before its T2): the subscription is made on the old card, T2 leaves a step for the customer's card as it is now, and the new membership ends on the new card", async () => {
    await onASeed(async (stripe) => {
      const during = replacingDuringTheOrder(stripe, 'pm_sams_new_card')
      const order = await postOrder(membershipOnCard(), { orderSwitch: ORDER_KINDS_ON })
      expect(order.status).toBe(200)
      // The replace found no membership yet: nothing for it to move.
      expect(counts(during.answer() as Answer)).toEqual([200, 0, 0])
      const membership = await samsMembership()
      expect(membership?.subscription_status).toBe('active')
      const subscription = membership?.stripe_subscription_id as string
      // The subscription was made on the card T1 read.
      const made = stripe.calls.find((call) => call.method === 'subscriptions.create')
      expect(paramsOf(made)['default_payment_method']).toBe('pm_seed')
      // T2 read the card as it is now, left one step for it, and the order's press sent it.
      expect((await cardOf(ID.customer))?.card).toBe('pm_sams_new_card')
      expect(await stepRows()).toEqual([
        ['payment_method', 'left', 'pm_sams_new_card', subscription],
        ['payment_method', 'done', 'pm_sams_new_card', subscription],
      ])
      const [left] = await audited(STEP_LEFT_ACTION)
      expect(left).toMatchObject({ actor_type: 'staff', actor_id: ID.staff, entity_type: 'membership', entity_id: membership?.id })
      expect(updates(stripe).map((call) => [paramsOf(call)['id'], paramsOf(call)['default_payment_method'], call.idempotencyKey])).toEqual([[subscription, 'pm_sams_new_card', stepKey({ id: String(left?.details['stepId']), kind: 'payment_method' })]])
      expect(subscriptionCard(stripe, subscription)).toBe('pm_sams_new_card')
      // The invoice default ends on the new card too: the order set it to the old one before the subscription, then
      // the replace set it, and the order's follow-on sets it last, to the card as it is now.
      expect(invoiceDefaults(stripe).map((call) => (paramsOf(call)['invoice_settings'] as { default_payment_method?: string }).default_payment_method)).toEqual(['pm_seed', 'pm_sams_new_card', 'pm_sams_new_card'])
      expect(await listed()).toEqual([])
      // And it stays so: past the window and past the check.
      pastTheWindow()
      await reconcileNow(stripe)
      pastTheCheck()
      await reconcileNow(stripe)
      expect(subscriptionCard(stripe, subscription)).toBe('pm_sams_new_card')
      expect((await audited(STEP_CHECK_ACTION)).map((row) => row.details['outcome'])).toEqual(['checked'])
      expect(await listed()).toEqual([])
    })
  })

  it("the same order when Stripe won't take the move yet: the membership is written, the order answers as placed, and the step is listed and sent by reconcile past the window", async () => {
    await onASeed(async (stripe) => {
      const during = replacingDuringTheOrder(stripe, 'pm_sams_new_card')
      stripe.failNext('subscriptions.update', noAnswer())
      const order = await postOrder(membershipOnCard(), { orderSwitch: ORDER_KINDS_ON })
      expect(order.status).toBe(200)
      expect(placed(order)?.membershipId).toBeTruthy()
      expect(counts(during.answer() as Answer)).toEqual([200, 0, 0])
      const subscription = (await samsMembership())?.stripe_subscription_id as string
      expect(subscriptionCard(stripe, subscription)).toBe('pm_seed')
      expect((await listed()).map((line) => [line.step, line.state, line.subscriptionId])).toEqual([['payment_method', 'left', subscription]])
      pastTheWindow()
      await reconcileNow(stripe)
      expect(subscriptionCard(stripe, subscription)).toBe('pm_sams_new_card')
      expect(await listed()).toEqual([])
    })
  })

  it("no replace in the way: the membership order's step is settled by one read and sends nothing; a replace after the order's T2 then finds the membership and moves it", async () => {
    await onASeed(async (stripe) => {
      const order = await postOrder(membershipOnCard(), { orderSwitch: ORDER_KINDS_ON })
      expect(order.status).toBe(200)
      const subscription = (await samsMembership())?.stripe_subscription_id as string
      // One step, for the card the subscription was made on: read once, nothing sent.
      expect(await stepRows()).toEqual([
        ['payment_method', 'left', 'pm_seed', subscription],
        ['payment_method', 'done', 'pm_seed', subscription],
      ])
      expect((await audited(STEP_LEFT_ACTION)).find((row) => row.details['state'] === 'done')?.details['detail']).toBe('Stripe already showed it')
      expect(updates(stripe)).toEqual([])
      expect(stripe.calls.filter((call) => call.method === 'subscriptions.retrieve' && paramsOf(call)['id'] === subscription)).toHaveLength(1)
      expect(await listed()).toEqual([])

      // The replace after T2: K1 sees the new membership.
      const replaced = await save(await tapped(stripe, SAM_STRIPE, 'pm_sams_new_card'), { customerId: ID.customer })
      expect(counts(replaced)).toEqual([200, 1, 0])
      expect(subscriptionCard(stripe, subscription)).toBe('pm_sams_new_card')
      expect(updates(stripe).map((call) => paramsOf(call)['default_payment_method'])).toEqual(['pm_sams_new_card'])
      expect(await listed()).toEqual([])
    })
  })

  it("the kind off: the same race ends as it does today (the new membership on the old card, no step, nothing sent about it), and the order's T2 takes no card step for anyone", async () => {
    await onASeed(
      async (stripe) => {
        const during = replacingDuringTheOrder(stripe, 'pm_sams_new_card')
        const order = await postOrder(membershipOnCard(), { orderSwitch: ORDER_KINDS_NO_MOVES })
        expect(order.status).toBe(200)
        // Off, the route saves the card as before W42: five fields, no counts.
        expect(during.answer()?.status).toBe(200)
        expect(during.answer()?.data).not.toHaveProperty('membershipsMoved')
        const subscription = (await samsMembership())?.stripe_subscription_id as string
        expect((await cardOf(ID.customer))?.card).toBe('pm_sams_new_card')
        expect(subscriptionCard(stripe, subscription)).toBe('pm_seed')
        expect(await stepRows()).toEqual([])
        expect(updates(stripe)).toEqual([])
        expect(stripe.calls.filter((call) => call.method === 'subscriptions.retrieve')).toEqual([])
        expect(await audited(INVOICE_DEFAULT_ACTION)).toEqual([])
        expect(await listed()).toEqual([])
      },
      undefined,
      ORDER_KINDS_NO_MOVES
    )
  })

  /** The same membership order with its press's T2 failing (the database, as a lost connection): held, paid for, with no membership row yet. */
  async function orderHeldBeforeT2(stripe: FakeStripe): Promise<void> {
    replacingDuringTheOrder(stripe, 'pm_sams_new_card')
    const order = await whileFailing(db, { table: 'orders', event: 'UPDATE', when: "NEW.payment_status = 'paid'" }, () => postOrder(membershipOnCard(), { orderSwitch: ORDER_KINDS_ON }))
    expect(order.status).not.toBe(200)
    expect(await samsMembership()).toBeUndefined()
    expect((await cardOf(ID.customer))?.card).toBe('pm_sams_new_card')
    pastTheWindow()
  }
  const runWithSwitch = (stripe: FakeStripe, orderSwitch: string | null) => reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000, orderSwitch })

  it("an order whose press never reached T2 is finalised by reconcile, and that T2 runs the rule too, by the run's own switch (the scheduled run's environment is not the routes'): the step is left by the system and sent in the same run", async () => {
    await onASeed(async (stripe) => {
      await orderHeldBeforeT2(stripe)
      // The environment says off here; the run is told on, as the scheduled handler tells it from its own env.
      vi.stubEnv('ORDER_SWITCH', '')
      const run = await runWithSwitch(stripe, ORDER_KINDS_ON)
      expect(run.finalised).toBe(1)
      const membership = await samsMembership()
      const subscription = membership?.stripe_subscription_id as string
      expect(await stepRows()).toEqual([
        ['payment_method', 'left', 'pm_sams_new_card', subscription],
        ['payment_method', 'done', 'pm_sams_new_card', subscription],
      ])
      expect((await audited(STEP_LEFT_ACTION)).map((row) => [row.actor_type, row.actor_id, row.entity_id])).toEqual([
        ['system', null, membership?.id],
        ['system', null, membership?.id],
      ])
      expect(subscriptionCard(stripe, subscription)).toBe('pm_sams_new_card')
      expect(await listed()).toEqual([])
    })
  })

  it("the same, with the run's switch not naming card_moves (and the environment naming it): the order is finalised as today, with no step", async () => {
    await onASeed(async (stripe) => {
      await orderHeldBeforeT2(stripe)
      const run = await runWithSwitch(stripe, null)
      expect(run.finalised).toBe(1)
      const subscription = (await samsMembership())?.stripe_subscription_id as string
      expect(await stepRows()).toEqual([])
      expect(subscriptionCard(stripe, subscription)).toBe('pm_seed')
    })
  })

  /** Mo pays for a towel on the reader with "save card" ticked and taps `card`; the order is then finalised. */
  async function readerOrderSavingCard(stripe: FakeStripe, card: string, orderSwitch: string): Promise<OrderAnswer> {
    const input = await withQuotedCardFigure(orderInput({ customerId: ID.member, standaloneAddons: [towel], payment: { method: 'reader', readerSaveCard: true } }))
    const order = await postOrder(input, { orderSwitch })
    const data = placed(order)
    expect(order.status).toBe(200)
    stripe.completeReaderPayment(data?.pendingReaderPayment?.paymentIntentId as string, { generatedCard: card })
    vi.setSystemTime(Date.now() + 1000)
    return postReaderStep('finalise', data?.orderId as string)
  }

  it('W42 report, Noticed 1: a reader order that saves card B for a customer whose membership renews on card A: the membership moves to B, with its step, and the order answers as it always did', async () => {
    await onASeed(async (stripe) => {
      const finalised = await readerOrderSavingCard(stripe, 'pm_mos_reader_card', ORDER_KINDS_ON)
      expect(finalised.status).toBe(200)
      expect(finalised.body).toMatchObject({ ok: true, data: { finalised: true } })
      // The order's answer carries no sentence and no counts: the screen there says "Card saved" as before.
      expect(JSON.stringify(finalised.body)).not.toMatch(/membershipsMoved|moved|renew/)
      expect((await cardOf())?.card).toBe('pm_mos_reader_card')
      expect(await stepRows()).toEqual([
        ['payment_method', 'left', 'pm_mos_reader_card', MO_SUBSCRIPTION],
        ['payment_method', 'done', 'pm_mos_reader_card', MO_SUBSCRIPTION],
      ])
      expect(updates(stripe).map((call) => [paramsOf(call)['id'], paramsOf(call)['default_payment_method']])).toEqual([[MO_SUBSCRIPTION, 'pm_mos_reader_card']])
      expect(subscriptionCard(stripe)).toBe('pm_mos_reader_card')
      // As the replace press does: the subscription first, then the invoice default, recorded.
      expect(invoiceDefaults(stripe).map((call) => call.params)).toEqual([{ id: MO_STRIPE, invoice_settings: { default_payment_method: 'pm_mos_reader_card' } }])
      expect((await audited(INVOICE_DEFAULT_ACTION)).map((row) => row.details)).toEqual([{ stripeCustomerId: MO_STRIPE, paymentMethodId: 'pm_mos_reader_card', set: true }])
      const order = stripe.calls.map((call) => call.method).filter((method) => /^(customers\.update|subscriptions\.update)/.test(method))
      expect(order).toEqual(['subscriptions.update', 'customers.update'])
      // No payment beyond the tap, nothing listed.
      expect(stripe.calls.filter((call) => /^(refunds\.|subscriptions\.cancel|invoices\.)/.test(call.method))).toEqual([])
      expect(await listed()).toEqual([])
    })
  })

  it('the same reader order when Stripe refuses the move: the order is still paid and the card saved; the membership is listed, and reconcile sends it past the window', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      const finalised = await readerOrderSavingCard(stripe, 'pm_mos_reader_card', ORDER_KINDS_ON)
      expect(finalised.body).toMatchObject({ ok: true, data: { finalised: true } })
      expect((await cardOf())?.card).toBe('pm_mos_reader_card')
      // Not moved yet (the seed's subscription names no card of its own).
      expect(subscriptionCard(stripe)).toBeNull()
      expect((await listed()).map((line) => [line.step, line.state, line.what])).toEqual([['payment_method', 'left', 'card']])
      pastTheWindow()
      await reconcileNow(stripe)
      expect(subscriptionCard(stripe)).toBe('pm_mos_reader_card')
      expect(await listed()).toEqual([])
    })
  })

  it('the kind off: the reader order saves the card as today and no membership is moved: no step, nothing sent to the subscription or the invoice default', async () => {
    await onASeed(
      async (stripe) => {
        const finalised = await readerOrderSavingCard(stripe, 'pm_mos_reader_card', ORDER_KINDS_NO_MOVES)
        expect(finalised.body).toMatchObject({ ok: true, data: { finalised: true } })
        expect((await cardOf())?.card).toBe('pm_mos_reader_card')
        // Untouched (the seed's subscription names no card of its own).
        expect(subscriptionCard(stripe)).toBeNull()
        expect(await stepRows()).toEqual([])
        expect(stripe.calls.filter((call) => /^(customers\.update|subscriptions\.)/.test(call.method))).toEqual([])
        expect(await audited(INVOICE_DEFAULT_ACTION)).toEqual([])
        expect(await listed()).toEqual([])
      },
      undefined,
      ORDER_KINDS_NO_MOVES
    )
  })

  it('a reader order that saves no card (the simulated reader, or "save card" not ticked) and writes no membership leaves no step, with the kind on', async () => {
    await onASeed(async (stripe) => {
      const input = await withQuotedCardFigure(orderInput({ customerId: ID.member, standaloneAddons: [towel], payment: { method: 'reader' } }))
      const order = await postOrder(input, { orderSwitch: ORDER_KINDS_ON })
      stripe.completeReaderPayment(placed(order)?.pendingReaderPayment?.paymentIntentId as string, { generatedCard: 'pm_not_asked_for' })
      expect((await postReaderStep('finalise', placed(order)?.orderId as string)).body).toMatchObject({ ok: true, data: { finalised: true } })
      expect((await cardOf())?.card).toBe('pm_member')
      expect(await stepRows()).toEqual([])
      expect(stripe.calls.filter((call) => /^(customers\.update|subscriptions\.)/.test(call.method))).toEqual([])
    })
  })
})

describe('the switch kind `card_moves` (brief W42 item 1)', () => {
  it('off: the card is saved exactly as before W42: five fields, no step, nothing sent about a subscription or the invoice default, and no F4', async () => {
    await onASeed(
      async (stripe) => {
        const answer = await replace(stripe, 'pm_mos_new_card')
        expect(answer.status).toBe(200)
        expect(answer.data).toEqual({ id: ID.member, stripe_customer_id: MO_STRIPE, saved_payment_method_id: 'pm_mos_new_card', saved_card_last4: '1881', saved_card_brand: 'mastercard' })
        expect(await stepRows()).toEqual([])
        expect([...updates(stripe), ...invoiceDefaults(stripe), ...stripe.calls.filter((call) => call.method === 'subscriptions.retrieve')]).toEqual([])
        expect(subscriptionCard(stripe)).toBeNull()
        expect((await audited(CARD_SAVED_ACTION)).map((row) => Object.keys(row.details).sort())).toEqual([['brand', 'last4', 'paymentMethodId', 'setupIntentId']])
        expect(await audited(INVOICE_DEFAULT_ACTION)).toEqual([])
        // As before W42 (FB17 stands while the kind is off): another customer's tap is saved.
        const other = await save(await tapped(stripe, SAM_STRIPE, 'pm_sams_card'))
        expect([other.status, other.data?.['saved_payment_method_id']]).toEqual([200, 'pm_sams_card'])
      },
      undefined,
      'no_stripe,saved_card,reader,membership,booking_changes,reader_flows,order_refunds,event_cancels,membership_changes,payment_date_changes'
    )
  })

  it("off does not stop reconcile or the check: a card step left while it was on is still sent, and checked after it closes", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      await replace(stripe, 'pm_mos_new_card')
      vi.stubEnv('ORDER_SWITCH', '')
      pastTheWindow()
      await reconcileNow(stripe)
      expect(subscriptionCard(stripe)).toBe('pm_mos_new_card')
      expect(await listed()).toEqual([])
      pastTheCheck()
      await reconcileNow(stripe)
      expect((await audited(STEP_CHECK_ACTION)).map((row) => row.details['outcome'])).toEqual(['checked'])
    })
  })
})

describe("the Stripe customer's invoice default", () => {
  it.each([
    ['refused', no, 'refused'],
    ['given no clear answer', noAnswer, 'unclear'],
  ] as const)('%s: the card is saved and the membership moved all the same; it is recorded, not listed, and not sent again by reconcile', async (_name, fault, outcome) => {
    await onASeed(async (stripe) => {
      stripe.failNext('customers.update', fault())
      const answer = await replace(stripe, 'pm_mos_new_card')
      expect(counts(answer)).toEqual([200, 1, 0])
      expect((await cardOf())?.card).toBe('pm_mos_new_card')
      // The subscription has its own card, so nothing is charged from the customer's default.
      expect(subscriptionCard(stripe)).toBe('pm_mos_new_card')
      const [row] = await audited(INVOICE_DEFAULT_ACTION)
      expect(row?.details).toMatchObject({ stripeCustomerId: MO_STRIPE, paymentMethodId: 'pm_mos_new_card', set: false, outcome })
      expect(await listed()).toEqual([])
      pastTheWindow()
      await reconcileNow(stripe)
      pastTheCheck()
      await reconcileNow(stripe)
      expect(invoiceDefaults(stripe)).toHaveLength(1)
      // The next replace sets it again.
      expect(counts(await replace(stripe, 'pm_mos_next_card'))).toEqual([200, 1, 0])
      expect(invoiceDefaults(stripe).map((call) => (paramsOf(call)['invoice_settings'] as { default_payment_method: string }).default_payment_method)).toEqual(['pm_mos_new_card', 'pm_mos_next_card'])
    })
  })
})

describe('a card step and a cancel step on one subscription (W40 review L5, W40c review L6, W40d Noticed 2)', () => {
  it("neither replaces, blocks or undoes the other: both open, both sent by reconcile, each with its own field; each kind's check agrees", async () => {
    await onASeed(async (stripe) => {
      // A cancel Stripe gives no answer on: its step is open.
      stripe.failNext('subscriptions.update', noAnswer())
      const cancelled = await cancel()
      expect(cancelled.status).toBe(200)
      // A replaced card inside the cancel's window: not refused as "still being sent", and its own step is left open too.
      stripe.failNext('subscriptions.update', noAnswer())
      expect(counts(await replace(stripe, 'pm_mos_new_card'))).toEqual([200, 0, 1])
      expect((await stepRows()).map(([kind, state]) => [kind, state])).toEqual([
        ['cancel_at', 'left'],
        ['payment_method', 'left'],
      ])
      expect((await listed()).map((line) => line.what).sort()).toEqual(['cancel_date', 'card'])

      pastTheWindow()
      await reconcileNow(stripe)
      const sent = updates(stripe).slice(2).map((call) => Object.keys(paramsOf(call)).sort())
      expect(sent.sort()).toEqual([['cancel_at', 'id', 'proration_behavior'], ['default_payment_method', 'id']].sort())
      const settings = stripe.subscriptionSettings(MO_SUBSCRIPTION)
      expect(settings?.defaultPaymentMethod).toBe('pm_mos_new_card')
      expect(typeof settings?.cancelAt).toBe('number')
      expect(await listed()).toEqual([])

      // 20 minutes after they closed: one check per kind, each against its own field, and nothing is put back.
      pastTheCheck()
      await reconcileNow(stripe)
      expect((await audited(STEP_CHECK_ACTION)).map((row) => [row.details['kind'], row.details['outcome']]).sort()).toEqual([
        ['cancel_at', 'checked'],
        ['payment_method', 'checked'],
      ])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)).toEqual(settings)
      expect(await listed()).toEqual([])
    })
  })

  it("a cancel after a replaced card whose step is still open goes through, and leaves the card step as it was", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.update', noAnswer())
      await replace(stripe, 'pm_mos_new_card')
      expect((await cancel()).status).toBe(200)
      expect((await stepRows()).map(([kind, state]) => [kind, state])).toEqual([
        ['payment_method', 'left'],
        ['cancel_at', 'left'],
        ['cancel_at', 'done'],
      ])
      expect(subscriptionCard(stripe)).toBeNull()
    })
  })
})

describe('the check after a card step closes (W40c)', () => {
  it('Stripe shows the card: one checked row, one read, nothing sent', async () => {
    await onASeed(async (stripe) => {
      await replace(stripe, 'pm_mos_new_card')
      const before = stripe.calls.length
      pastTheCheck()
      await reconcileNow(stripe)
      const [check] = await audited(STEP_CHECK_ACTION)
      expect(check?.details).toMatchObject({ kind: 'payment_method', subscriptionId: MO_SUBSCRIPTION, outcome: 'checked', steps: await cardStepIds() })
      expect(stripe.calls.slice(before).map((call) => call.method)).toEqual(['subscriptions.retrieve'])
      // Checked once: a later run reads nothing more.
      pastTheCheck()
      await reconcileNow(stripe)
      expect(await audited(STEP_CHECK_ACTION)).toHaveLength(1)
      expect(stripe.calls.slice(before)).toHaveLength(1)
    })
  })

  it('the card was changed by hand in Stripe inside the 20 minutes: the check leaves the new card again and the next run puts it back', async () => {
    await onASeed(async (stripe) => {
      await replace(stripe, 'pm_mos_new_card')
      await stripe.subscriptions.update(MO_SUBSCRIPTION, { default_payment_method: 'pm_member' })
      pastTheCheck()
      await reconcileNow(stripe)
      expect((await audited(STEP_CHECK_ACTION)).map((row) => row.details['outcome'])).toEqual(['left_again'])
      expect((await listed()).map((line) => line.what)).toEqual(['card'])
      pastTheWindow()
      await reconcileNow(stripe)
      expect(subscriptionCard(stripe)).toBe('pm_mos_new_card')
    })
  })
})

describe('W42b: the last card gaps before card_moves goes on (W42a review S1, S2, L3, L4)', () => {
  const KINDS_ON = 'no_stripe,saved_card,reader,membership,membership_changes,payment_date_changes,card_moves'
  const KINDS_NO_MOVES = 'no_stripe,saved_card,reader,membership,membership_changes,payment_date_changes'
  const towel = { addonId: ID.addon, quantity: 1, unitPrice: 5, systemUnitPrice: 5 }
  const CARD_NOT_SAVED = 'customer.card_not_saved'
  /** A run as the scheduled handler starts it: told the switch from its own env. */
  const runTold = (stripe: FakeStripe, orderSwitch: string | null) => reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000, orderSwitch })
  const paidRows = async () => (await audited('order.paid')).map((row) => row.details['cardSaved'])

  /** Mo (a membership on sub_mo) buys a towel on the reader with "save card" ticked and taps `card`. The screen's finalise never arrives: the order is pending with its money taken. */
  async function heldReaderOrder(stripe: FakeStripe, card: string): Promise<string> {
    const input = await withQuotedCardFigure(orderInput({ customerId: ID.member, standaloneAddons: [towel], payment: { method: 'reader', readerSaveCard: true } }))
    const order = await postOrder(input, { orderSwitch: KINDS_ON })
    expect(order.status).toBe(200)
    const data = order.body.ok ? order.body.data : null
    // The tap comes a moment after the order is placed, as at a real reader.
    vi.setSystemTime(Date.now() + 5000)
    stripe.completeReaderPayment(data?.pendingReaderPayment?.paymentIntentId as string, { generatedCard: card })
    return data?.orderId as string
  }

  describe("S1: every T2 of a run is given the run's own switch", () => {
    it("review P2 turned round: the scheduled run (told card_moves is on, its process.env empty) finalises a held reader order with \"save card\": the card is saved, the membership's step is left by the system and sent, and the membership renews on the new card", async () => {
      await onASeed(async (stripe) => {
        await heldReaderOrder(stripe, 'pm_mos_reader_card')
        pastTheWindow()
        // A scheduled run in a fresh isolate: nothing in process.env, the switch only from the handler's env.
        vi.stubEnv('ORDER_SWITCH', '')
        const run = await runTold(stripe, KINDS_ON)
        expect(run.finalised).toBe(1)
        expect((await cardOf())?.card).toBe('pm_mos_reader_card')
        expect(await stepRows()).toEqual([
          ['payment_method', 'left', 'pm_mos_reader_card', MO_SUBSCRIPTION],
          ['payment_method', 'done', 'pm_mos_reader_card', MO_SUBSCRIPTION],
        ])
        expect((await audited(STEP_LEFT_ACTION)).map((row) => [row.actor_type, row.actor_id])).toEqual([
          ['system', null],
          ['system', null],
        ])
        expect(subscriptionCard(stripe)).toBe('pm_mos_reader_card')
        expect(invoiceDefaults(stripe).map((call) => call.params)).toEqual([{ id: MO_STRIPE, invoice_settings: { default_payment_method: 'pm_mos_reader_card' } }])
        expect(await listed()).toEqual([])
        pastTheCheck()
        await runTold(stripe, KINDS_ON)
        expect(subscriptionCard(stripe)).toBe('pm_mos_reader_card')
        expect(await listed()).toEqual([])
      })
    })

    it("the other way: the run told the kind is off, with process.env naming it (a warm isolate's stale copy): the order is finalised as W11 had it, with no step. The run's word is the one T2 hears", async () => {
      await onASeed(async (stripe) => {
        await heldReaderOrder(stripe, 'pm_mos_reader_card')
        pastTheWindow()
        vi.stubEnv('ORDER_SWITCH', KINDS_ON)
        const run = await runTold(stripe, KINDS_NO_MOVES)
        expect(run.finalised).toBe(1)
        expect((await cardOf())?.card).toBe('pm_mos_reader_card')
        expect(await stepRows()).toEqual([])
        expect(subscriptionCard(stripe)).toBeNull()
        expect(invoiceDefaults(stripe)).toEqual([])
      })
    })

    it("a held reader order with no intent on its record (found by listing Stripe): the run finalises it through the reader's finalise, and that T2 hears the run's switch too", async () => {
      await onASeed(async (stripe) => {
        const orderId = await heldReaderOrder(stripe, 'pm_mos_reader_card')
        // As when the Worker died before writing the intent onto the order: the record names no intent.
        await db.query("UPDATE orders SET reader_payment = reader_payment - 'payment_intent_id' WHERE id = $1", [orderId])
        pastTheWindow()
        vi.stubEnv('ORDER_SWITCH', '')
        const run = await runTold(stripe, KINDS_ON)
        expect(run.finalised).toBe(1)
        expect((await cardOf())?.card).toBe('pm_mos_reader_card')
        expect((await stepRows()).map((row) => row[1])).toEqual(['left', 'done'])
        expect(subscriptionCard(stripe)).toBe('pm_mos_reader_card')
        expect(await listed()).toEqual([])
      })
    })

    it("a run started by a request (staff's Resolve now) is told nothing and reads the request's environment once, as its route would", async () => {
      await onASeed(async (stripe) => {
        await heldReaderOrder(stripe, 'pm_mos_reader_card')
        pastTheWindow()
        vi.stubEnv('ORDER_SWITCH', KINDS_ON)
        const run = await reconcileNow(stripe)
        expect(run.finalised).toBe(1)
        expect(subscriptionCard(stripe)).toBe('pm_mos_reader_card')
        expect(await listed()).toEqual([])
      })
    })

    it("reconcile.ts reaches T2 only through its three helpers, each given the run's switch by its type, and reads the environment for the switch in one place", () => {
      const source = readFileSync(path.resolve(__dirname, '../orders/reconcile.ts'), 'utf8')
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n')
      const calls = (name: string) => code.match(new RegExp(`(?<![A-Za-z])${name}\\(`, 'g')) ?? []
      // One call each, inside its helper, with `t2By(run)`: the run's actor, request and switch.
      expect(calls('finaliseOrder')).toHaveLength(1)
      expect(calls('cancelReaderOrder')).toHaveLength(1)
      expect(calls('finaliseReaderOrderFound')).toHaveLength(1)
      expect(code).toContain('finaliseOrder(run.db, orderId, paymentIntent, { ...t2By(run), ...more })')
      expect(code).toContain("cancelReaderOrder(run.db, run.stripe, orderId, { ...t2By(run), ...(run.timing ? { timing: run.timing } : {}), ...more })")
      expect(code).toContain('finaliseReaderOrderFound(run.db, run.stripe, orderId, snapshot, paymentIntent, { ...t2By(run), ...more }, run.timing)')
      // The switch is a field every run has, and T2's options from a run always carry it.
      expect(code).toContain('const t2By = (run: Run): RunT2 => ({ actor: run.options.actor, requestId: run.options.requestId, orderSwitch: run.orderSwitch })')
      expect(code).toMatch(/interface RunT2 \{[^}]*orderSwitch: string \| null\n\}/)
      expect(code.match(/process\.env/g)).toHaveLength(1)
      expect(code).toContain("const runSwitch = (options: Pick<ReconcileOptions, 'orderSwitch'>): string | null => (options.orderSwitch === undefined ? (process.env.ORDER_SWITCH ?? null) : options.orderSwitch)")
    })
  })

  describe('S2: an older tap never takes the place of a newer card (card_moves on)', () => {
    /** The held reader order (tap: `pm_mos_tapped_card`), then two minutes later Jo replaces Mo's card with `pm_mos_newest_card`: Mo's latest instruction. */
    async function heldReaderOrderThenReplace(stripe: FakeStripe): Promise<string> {
      const orderId = await heldReaderOrder(stripe, 'pm_mos_tapped_card')
      vi.setSystemTime(Date.now() + 120_000)
      const replaced = await replace(stripe, 'pm_mos_newest_card')
      expect(counts(replaced)).toEqual([200, 1, 0])
      expect((await cardOf())?.card).toBe('pm_mos_newest_card')
      expect(subscriptionCard(stripe)).toBe('pm_mos_newest_card')
      pastTheWindow()
      return orderId
    }

    it('review P1 turned round: reconcile finalises the held order after the replace: the order is paid, the tapped card is NOT saved over the newer one (recorded, with why), and the membership stays on the newer card, through the check', async () => {
      await onASeed(async (stripe) => {
        const orderId = await heldReaderOrderThenReplace(stripe)
        vi.stubEnv('ORDER_SWITCH', '')
        const run = await runTold(stripe, KINDS_ON)
        expect(run.finalised).toBe(1)
        expect(await cardOf()).toEqual({ card: 'pm_mos_newest_card', last4: '1881', brand: 'mastercard' })
        expect(subscriptionCard(stripe)).toBe('pm_mos_newest_card')
        // The order is paid, and says the card was not saved; the reason is on the customer's own row.
        expect(await paidRows()).toEqual([false])
        const notSaved = await audited(CARD_NOT_SAVED)
        expect(notSaved.map((row) => [row.actor_type, row.entity_type, row.entity_id])).toEqual([['system', 'customer', ID.member]])
        expect(notSaved[0]?.details).toMatchObject({ reason: 'newer_card_on_file', paymentMethodId: 'pm_mos_tapped_card', last4: '4242', brand: 'visa', orderId })
        expect(typeof notSaved[0]?.details['tappedAt']).toBe('number')
        // One card saved in all: the replace's. The order saved none.
        expect((await audited(CARD_SAVED_ACTION)).map((row) => row.details['paymentMethodId'])).toEqual(['pm_mos_newest_card'])
        // The follow-on ran against the customer's card as it is: a step for the newer card, settled by one read.
        expect(await stepRows()).toEqual([
          ['payment_method', 'left', 'pm_mos_newest_card', MO_SUBSCRIPTION],
          ['payment_method', 'done', 'pm_mos_newest_card', MO_SUBSCRIPTION],
          ['payment_method', 'left', 'pm_mos_newest_card', MO_SUBSCRIPTION],
          ['payment_method', 'done', 'pm_mos_newest_card', MO_SUBSCRIPTION],
        ])
        // Nothing was ever sent for the tapped card: not to the subscription, not as the invoice default.
        expect(updates(stripe).map((call) => paramsOf(call)['default_payment_method'])).toEqual(['pm_mos_newest_card'])
        expect(invoiceDefaults(stripe).map((call) => (paramsOf(call)['invoice_settings'] as { default_payment_method: string }).default_payment_method)).toEqual(['pm_mos_newest_card', 'pm_mos_newest_card'])
        expect(await listed()).toEqual([])
        pastTheCheck()
        await runTold(stripe, KINDS_ON)
        expect((await cardOf())?.card).toBe('pm_mos_newest_card')
        expect(subscriptionCard(stripe)).toBe('pm_mos_newest_card')
        expect(await listed()).toEqual([])
      })
    })

    it("with card_moves off for the run, W11's behaviour is exactly as it was: the tapped card is saved over the newer one, no row says otherwise, and no membership is touched", async () => {
      await onASeed(async (stripe) => {
        await heldReaderOrderThenReplace(stripe)
        vi.stubEnv('ORDER_SWITCH', KINDS_NO_MOVES)
        const run = await runTold(stripe, KINDS_NO_MOVES)
        expect(run.finalised).toBe(1)
        expect((await cardOf())?.card).toBe('pm_mos_tapped_card')
        expect(await paidRows()).toEqual([true])
        expect(await audited(CARD_NOT_SAVED)).toEqual([])
        expect((await audited(CARD_SAVED_ACTION)).map((row) => row.details['paymentMethodId'])).toEqual(['pm_mos_newest_card', 'pm_mos_tapped_card'])
        expect(subscriptionCard(stripe)).toBe('pm_mos_newest_card')
        expect(updates(stripe).map((call) => paramsOf(call)['default_payment_method'])).toEqual(['pm_mos_newest_card'])
      })
    })

    it('a replace made BEFORE the tap is the older instruction: the held order is finalised with its tapped card saved, and the membership moves to it', async () => {
      await onASeed(async (stripe) => {
        const replaced = await replace(stripe, 'pm_mos_earlier_card')
        expect(counts(replaced)).toEqual([200, 1, 0])
        vi.setSystemTime(Date.now() + 60_000)
        await heldReaderOrder(stripe, 'pm_mos_tapped_card')
        pastTheWindow()
        vi.stubEnv('ORDER_SWITCH', '')
        const run = await runTold(stripe, KINDS_ON)
        expect(run.finalised).toBe(1)
        expect((await cardOf())?.card).toBe('pm_mos_tapped_card')
        expect(await paidRows()).toEqual([true])
        expect(await audited(CARD_NOT_SAVED)).toEqual([])
        expect(subscriptionCard(stripe)).toBe('pm_mos_tapped_card')
        expect(await listed()).toEqual([])
      })
    })

    it("a replace made after the order was placed but before its tap is still the older instruction: the tap's own time (the charge's) is what counts, not the order's", async () => {
      await onASeed(async (stripe) => {
        const input = await withQuotedCardFigure(orderInput({ customerId: ID.member, standaloneAddons: [towel], payment: { method: 'reader', readerSaveCard: true } }))
        const order = await postOrder(input, { orderSwitch: KINDS_ON })
        const data = order.body.ok ? order.body.data : null
        // The reader is waiting for the tap when another till replaces Mo's card; then she taps for the order.
        vi.setSystemTime(Date.now() + 5000)
        expect(counts(await replace(stripe, 'pm_mos_earlier_card'))).toEqual([200, 1, 0])
        vi.setSystemTime(Date.now() + 5000)
        stripe.completeReaderPayment(data?.pendingReaderPayment?.paymentIntentId as string, { generatedCard: 'pm_mos_tapped_card' })
        pastTheWindow()
        vi.stubEnv('ORDER_SWITCH', '')
        const run = await runTold(stripe, KINDS_ON)
        expect(run.finalised).toBe(1)
        expect((await cardOf())?.card).toBe('pm_mos_tapped_card')
        expect(await audited(CARD_NOT_SAVED)).toEqual([])
        expect(subscriptionCard(stripe)).toBe('pm_mos_tapped_card')
        expect(await listed()).toEqual([])
      })
    })

    it("a reader membership order whose card is replaced between the tap and the finalise: the new subscription is made on the tapped card, the tapped card is not saved, and the new membership moves to the customer's newer card like any other", async () => {
      await onASeed(async (stripe) => {
        // Sam (card pm_seed, no membership) buys a monthly membership on the reader and taps card T.
        const input = await withQuotedCardFigure(orderInput({ customerId: ID.customer, membershipPlanId: ID.plan, membershipBillingFrequency: 'monthly', payment: { method: 'reader', readerSaveCard: true } }))
        const order = await postOrder(input, { orderSwitch: KINDS_ON })
        expect(order.status).toBe(200)
        const data = order.body.ok ? order.body.data : null
        vi.setSystemTime(Date.now() + 5000)
        stripe.completeReaderPayment(data?.pendingReaderPayment?.paymentIntentId as string, { generatedCard: 'pm_sams_tapped_card' })
        // Before the screen's finalise arrives, Jo replaces Sam's card with card B.
        vi.setSystemTime(Date.now() + 30_000)
        const replaced = await save(await tapped(stripe, SAM_STRIPE, 'pm_sams_newest_card'), { customerId: ID.customer })
        expect(counts(replaced)).toEqual([200, 0, 0])
        vi.stubEnv('ORDER_SWITCH', KINDS_ON)
        const finalised = await postReaderStep('finalise', data?.orderId as string)
        expect(finalised.body).toMatchObject({ ok: true, data: { finalised: true } })
        const membership = (await db.query<{ id: string; stripe_subscription_id: string | null; subscription_status: string }>('SELECT id, stripe_subscription_id, subscription_status FROM customer_memberships WHERE customer_id = $1', [ID.customer]))[0]
        expect(membership?.subscription_status).toBe('active')
        const subscription = membership?.stripe_subscription_id as string
        // The subscription was made on the card the tap left (the membership's own finalise needs it).
        expect(paramsOf(stripe.calls.find((call) => call.method === 'subscriptions.create'))['default_payment_method']).toBe('pm_sams_tapped_card')
        // The customer's card is still the newer one, and the new membership has been moved to it.
        expect((await cardOf(ID.customer))?.card).toBe('pm_sams_newest_card')
        expect((await audited(CARD_NOT_SAVED)).map((row) => [row.entity_id, row.details['reason'], row.details['paymentMethodId']])).toEqual([[ID.customer, 'newer_card_on_file', 'pm_sams_tapped_card']])
        expect(await stepRows()).toEqual([
          ['payment_method', 'left', 'pm_sams_newest_card', subscription],
          ['payment_method', 'done', 'pm_sams_newest_card', subscription],
        ])
        expect(updates(stripe).map((call) => [paramsOf(call)['id'], paramsOf(call)['default_payment_method']])).toEqual([[subscription, 'pm_sams_newest_card']])
        expect(subscriptionCard(stripe, subscription)).toBe('pm_sams_newest_card')
        // The invoice default ends on the newer card too (the follow-on sets it last).
        expect((paramsOf(invoiceDefaults(stripe).at(-1))['invoice_settings'] as { default_payment_method: string }).default_payment_method).toBe('pm_sams_newest_card')
        expect(await listed()).toEqual([])
      })
    })

    it("every writer of a customer's saved card writes a customer.card_saved row (what T2's question reads)", () => {
      const web = path.resolve(__dirname, '../../..')
      const sources = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const file = path.join(dir, name)
          if (statSync(file).isDirectory()) return /^(node_modules|testing|\.next|\.open-next|\.wrangler)$/.test(name) ? [] : sources(file)
          return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [file] : []
        })
      const writers = [...sources(path.join(web, 'server')), ...sources(path.join(web, 'app')), ...sources(path.join(web, 'lib'))]
        .filter((file) => /saved_payment_method_id\s*=\s*(\$|CASE)/.test(readFileSync(file, 'utf8')))
        .map((file) => path.relative(web, file).split(path.sep).join('/'))
        .sort()
      expect(writers).toEqual(['server/rules/customers/saved-card.ts', 'server/rules/orders/finalise-order.ts', 'server/rules/payments/terminal.ts'])
      for (const file of writers) expect(readFileSync(path.join(web, file), 'utf8')).toMatch(/action: ('customer\.card_saved'|CARD_SAVED_ACTION)/)
    })
  })

  describe('L3: an older action finishing late never puts the invoice default back', () => {
    it("a replace lands while a reader order's press is sending its step: the order's press does not send the invoice default for its older card, and says so in its row", async () => {
      await onASeed(async (stripe) => {
        const input = await withQuotedCardFigure(orderInput({ customerId: ID.member, standaloneAddons: [towel], payment: { method: 'reader', readerSaveCard: true } }))
        const order = await postOrder(input, { orderSwitch: KINDS_ON })
        const data = order.body.ok ? order.body.data : null
        vi.setSystemTime(Date.now() + 5000)
        stripe.completeReaderPayment(data?.pendingReaderPayment?.paymentIntentId as string, { generatedCard: 'pm_orders_card' })
        // The order's T2 has committed (card: pm_orders_card) and its press is reading the subscription for its
        // step when Jo's replace (pm_newest_card) runs from start to end.
        const subscriptions = stripe.subscriptions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
        const retrieve = subscriptions['retrieve'] as (...args: unknown[]) => Promise<unknown>
        let replaced: Answer | null = null
        let done = false
        subscriptions['retrieve'] = async (...args: unknown[]) => {
          if (!done) {
            done = true
            replaced = await replace(stripe, 'pm_newest_card')
          }
          return retrieve.apply(stripe.subscriptions, args)
        }
        vi.setSystemTime(Date.now() + 1000)
        const finalised = await postReaderStep('finalise', data?.orderId as string)
        expect(finalised.body).toMatchObject({ ok: true, data: { finalised: true } })
        expect((replaced as Answer | null)?.status).toBe(200)
        expect((await cardOf())?.card).toBe('pm_newest_card')
        // The only invoice default sent is the replace's. The order's, for the card that is no longer the
        // customer's, was not sent; its row says why.
        expect(invoiceDefaults(stripe).map((call) => (paramsOf(call)['invoice_settings'] as { default_payment_method: string }).default_payment_method)).toEqual(['pm_newest_card'])
        expect((await audited(INVOICE_DEFAULT_ACTION)).map((row) => [row.details['paymentMethodId'], row.details['set'], row.details['outcome'] ?? null])).toEqual([
          ['pm_newest_card', true, null],
          ['pm_orders_card', false, 'replaced'],
        ])
        expect((await audited(INVOICE_DEFAULT_ACTION))[1]?.details['message']).toBe("Not sent: the customer's saved card has changed since, and the newer change sets the invoice default.")
        // The steps are S2's business (W42a): whatever landed last, a run past the window ends on the newest card.
        pastTheWindow()
        await reconcileNow(stripe)
        pastTheCheck()
        await reconcileNow(stripe)
        expect(subscriptionCard(stripe)).toBe('pm_newest_card')
        expect(await listed()).toEqual([])
      })
    })

    it('with nothing in the way the invoice default is sent as before (one read more, the same call and row)', async () => {
      await onASeed(async (stripe) => {
        expect(counts(await replace(stripe, 'pm_mos_new_card'))).toEqual([200, 1, 0])
        expect(invoiceDefaults(stripe).map((call) => call.params)).toEqual([{ id: MO_STRIPE, invoice_settings: { default_payment_method: 'pm_mos_new_card' } }])
        expect((await audited(INVOICE_DEFAULT_ACTION)).map((row) => row.details)).toEqual([{ stripeCustomerId: MO_STRIPE, paymentMethodId: 'pm_mos_new_card', set: true }])
      })
    })
  })

  describe('L4: the open steps are read once per action, not once per membership', () => {
    /** `inner`, counting the statements run inside its transactions that are exactly the open steps' list. */
    function countingOpenStepReads(inner: Db): { db: Db; reads(): number } {
      let reads = 0
      const counted = (tx: object): object =>
        new Proxy(tx, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver) as unknown
            if (property !== 'query' || typeof value !== 'function') return value
            return (sql: string, ...rest: unknown[]) => {
              if (sql === OPEN_STEPS_SQL) reads += 1
              return (value as (...args: unknown[]) => unknown).call(target, sql, ...rest)
            }
          },
        })
      const proxy = new Proxy(inner, {
        get(target, property, receiver) {
          if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
          return <T>(work: (tx: never) => Promise<T>): Promise<T> => target.transaction((tx) => work(counted(tx) as never))
        },
      })
      return { db: proxy, reads: () => reads }
    }

    it('a replace for a customer with two live memberships, each with an older step still open: one read of the open steps, and both older steps are still closed as replaced', async () => {
      await onASeed(async (stripe) => {
        // The first replace gets no answer for either membership: two steps stay open.
        stripe.failNext('subscriptions.update', noAnswer())
        stripe.failNext('subscriptions.update', noAnswer())
        expect(counts(await replace(stripe, 'pm_first_card'))).toEqual([200, 0, 2])
        // Past the first press's window (no run in between), so the second's steps carry no mark and its sends
        // leave nothing again: the only read of the open steps in the second press is K1's own.
        pastTheWindow()
        const counting = countingOpenStepReads(db)
        holder.db = counting.db
        try {
          expect(counts(await replace(stripe, 'pm_second_card'))).toEqual([200, 2, 0])
        } finally {
          holder.db = db
        }
        expect(counting.reads()).toBe(1)
        const states = (await stepRows()).map((row) => `${String(row[1])} ${String(row[2])} ${String(row[3])}`)
        expect(states.filter((state) => state.startsWith('replaced pm_first_card')).sort()).toEqual([`replaced pm_first_card ${MO_SUBSCRIPTION}`, `replaced pm_first_card ${SECOND_SUBSCRIPTION}`])
        expect(states.filter((state) => state.startsWith('left pm_second_card'))).toHaveLength(2)
      }, secondMembership())
    })
  })
})

describe("who writes a subscription's card (W40 review L5, W40c review L6)", () => {
  const web = path.resolve(__dirname, '../../..')
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const file = path.join(dir, name)
      if (statSync(file).isDirectory()) return /^(node_modules|testing|\.next|\.open-next|\.wrangler)$/.test(name) ? [] : sources(file)
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [file] : []
    })

  it('only a step (left.ts) and a new subscription (orders/membership.ts) send default_payment_method; the invoice default has two senders', () => {
    const naming = [...sources(path.join(web, 'server')), ...sources(path.join(web, 'app')), ...sources(path.join(web, 'lib'))]
      .filter((file) => !file.endsWith(path.join('stripe', 'fake.ts')))
      .filter((file) => /default_payment_method\s*:/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(web, file).split(path.sep).join('/'))
      .sort()
    // W42a: the invoice default's send moved, with the step-leaving, into card-steps.ts (shared with an order's T2).
    expect(naming).toEqual(['server/rules/customers/card-steps.ts', 'server/rules/memberships/left.ts', 'server/rules/orders/membership.ts'])
    // That file's only use is the customer's invoice default; a subscription's card goes through a step.
    const own = readFileSync(path.join(web, 'server/rules/customers/card-steps.ts'), 'utf8')
    expect(own.match(/default_payment_method\s*:/g)).toHaveLength(1)
    expect(own).toContain('invoice_settings: { default_payment_method: left.paymentMethodId }')
    expect(own).not.toContain('subscriptions.update')
    expect(readFileSync(path.join(web, 'server/rules/customers/saved-card.ts'), 'utf8')).not.toMatch(/default_payment_method\s*:|subscriptions\.update|customers\.update/)
  })
})

describe('the staff app (brief W42 item 5): saveCustomerCardOnFile and the words on SaveCardOnReaderButton', () => {
  type Wrapper = (req: { params: { customerId: string; setupIntentId: string }; user: typeof REPLAY_USER }) => Promise<Record<string, unknown>>
  const wrapper = async (): Promise<Wrapper> => ((await import(/* @vite-ignore */ path.join(staffAppDir(), 'backend/paddock/saveCustomerCardOnFile.ts'))) as { default: Wrapper }).default

  it('the thin wrapper answers the same five fields plus moved and toMove, and a refusal as data with nothing thrown', async () => {
    await onASeed(async (stripe) => {
      const saveCard = await wrapper()
      stripe.failNext('subscriptions.update', no())
      const saved = await saveCard({ params: { customerId: ID.member, setupIntentId: await tapped(stripe, MO_STRIPE, 'pm_mos_new_card') }, user: REPLAY_USER })
      expect(saved).toEqual({ id: ID.member, stripe_customer_id: MO_STRIPE, saved_payment_method_id: 'pm_mos_new_card', saved_card_last4: '1881', saved_card_brand: 'mastercard', moved: 1, toMove: 1 })
      const refused = await saveCard({ params: { customerId: ID.member, setupIntentId: await tapped(stripe, SAM_STRIPE, 'pm_sams_card') }, user: REPLAY_USER })
      expect(refused).toEqual({ id: ID.member, stripe_customer_id: null, saved_payment_method_id: null, saved_card_last4: null, saved_card_brand: null, refused: { reason: 'other_customer', message: SAVED_CARD_WORDS.otherCustomer } })
      expect((await cardOf())?.card).toBe('pm_mos_new_card')
      // A failure with no reason of its own is still thrown, in the Worker's words, as before W42.
      await expect(saveCard({ params: { customerId: '10000000-0000-4000-8000-0000000042ff', setupIntentId: await tapped(stripe, MO_STRIPE, 'pm_x') }, user: REPLAY_USER })).rejects.toThrow('Customer not found')
    }, secondMembership())
  })

  it('with `card_moves` off the wrapper answers the five fields alone, so the screen says nothing about memberships', async () => {
    await onASeed(
      async (stripe) => {
        const saved = await (await wrapper())({ params: { customerId: ID.member, setupIntentId: await tapped(stripe, MO_STRIPE, 'pm_mos_new_card') }, user: REPLAY_USER })
        expect(Object.keys(saved).sort()).toEqual(['id', 'saved_card_brand', 'saved_card_last4', 'saved_payment_method_id', 'stripe_customer_id'])
      },
      undefined,
      'membership_changes,payment_date_changes'
    )
  })

  it("Wayne's sentence with N (Q45), the words for some still to move, and nothing to say when no membership moved", async () => {
    const { membershipsMovedWords } = (await import(/* @vite-ignore */ path.join(staffAppDir(), 'frontend/utils/savedCardWords.ts'))) as {
      membershipsMovedWords: (result: { membershipsMoved: number | null; membershipsToMove: number | null }) => string | null
    }
    const words = (membershipsMoved: number | null, membershipsToMove: number | null) => membershipsMovedWords({ membershipsMoved, membershipsToMove })
    expect(words(2, 0)).toBe('2 memberships now renew on this card. A failed payment will be tried again on the new card automatically.')
    expect(words(1, 0)).toBe('1 membership now renews on this card. A failed payment will be tried again on the new card automatically.')
    expect(words(1, 2)).toBe("1 membership now renews on this card. 2 more will move shortly; the Orders page lists any that don't. A failed payment will be tried again on the new card automatically.")
    expect(words(0, 1)).toBe("1 membership will move to this card shortly; the Orders page lists any that don't. A failed payment will be tried again on the new card automatically.")
    expect(words(0, 0)).toBeNull()
    expect(words(null, null)).toBeNull()
    // The button and the checkout both show them, from the reader flow's answer.
    const button = readFileSync(path.join(staffAppDir(), 'frontend/components/SaveCardOnReaderButton.tsx'), 'utf8')
    expect(button).toContain('membershipsMovedWords(saved)')
    expect(readFileSync(path.join(staffAppDir(), 'frontend/components/checkout/PaymentStep.tsx'), 'utf8')).toContain('membershipsMovedWords(savedCardResult)')
    const flow = readFileSync(path.join(staffAppDir(), 'frontend/utils/saveCardViaReader.ts'), 'utf8')
    expect(flow).toContain('if (saveResult?.refused) {')
    expect(flow).toContain('membershipsMoved: saveResult.moved ?? null')
  })
})
