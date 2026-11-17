import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import type { Db } from '@/server/db'
import { MAX_STEP_CHECKS_PER_RUN, MAX_STEPS_PER_RUN, reconcile } from '@/server/rules/orders/reconcile'
import { stuckList } from '@/server/rules/orders/stuck-list'
import { REPLAY_USER, replay, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { ID, MO_SUBSCRIPTION, seed, whileFailing } from '@/server/rules/testing/replay/scenarios'
import type { StripeClient } from '@/server/stripe/client'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { LEFT_STEP_WORDS } from './failure-messages'
import { CHECK_AFTER_MINUTES, leaveStep, leaveStepReplacing, openSteps, recordStepDone, settleLeftStep, sortLeftStep, STEP_CHECK_ACTION, STEP_KINDS, STEP_LEFT_ACTION, stepEndEntry, stepIsDone, stepKey, stepsDue, stepStillBeingSent, stepWhat, stepWords, trySendStep, type LeftStep, type StepKind, type StepWant } from './left'
import { audit } from '@/server/audit'
import { stuckListOutputSchema } from '@/contracts'

// Brief W36 item 3 (F-plan 4.1, 4.2 item 4, 4.10; lead calls L6 and L7): memberships/left.ts, a Stripe step left to
// do after the database change. On the replay's live schema, with the fake Stripe. What must hold: a step is written
// with its database change or not at all; it is read before it is sent, and never sent when Stripe already shows it;
// reconcile sends it again until it is done; one Stripe refuses for good ends as a line for a person and is never
// sent again (L7); a person can mark that line sorted; the newest step for a subscription wins; and nothing here ever
// charges or refunds.

vi.setConfig({ testTimeout: 120_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const KEY = 'test-staff-api-key'
const MEMBER_STRIPE_CUSTOMER = 'cus_member'
const MONTHLY_PRICE = 'price_seed_monthly'
/** 10 December 2026, 00:00 in London: the moment Mo's membership ends when cancelled today. */
const ENDS = 1796860800
const BY = { actor: { type: 'staff' as const, id: ID.staff }, requestId: 'req-press' }

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

/** The replay's seed, with Mo's membership on a Stripe subscription, then `work`. */
async function onASeed(work: (stripe: FakeStripe) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w36 left steps',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await seedDb.query("UPDATE customer_memberships SET stripe_subscription_id = $1, next_renewal_date = '2026-12-10' WHERE id = $2", [MO_SUBSCRIPTION, ID.membership])
        stripe.addSubscription(MO_SUBSCRIPTION, MEMBER_STRIPE_CUSTOMER, MONTHLY_PRICE)
      },
      async run({ stripe }) {
        await work(stripe)
      },
    },
    (_db, stripe) => ({ name: 'test', call: async () => stripe })
  )
}

const leave = (kind: StepKind, want: StepWant, subscriptionId = MO_SUBSCRIPTION): Promise<LeftStep> =>
  db.transaction((tx) => leaveStep(tx, { membershipId: ID.membership, subscriptionId, kind, want }, BY))
const cancelStep = () => leave('cancel_at', { cancelAt: ENDS })
type StepRow = { entity_type: string; entity_id: string; actor_type: string; actor_id: string | null; request_id: string; details: Record<string, unknown> }
const rows = () => db.query<StepRow>('SELECT entity_type, entity_id, actor_type, actor_id, request_id, details FROM audit_log WHERE action = $1', [STEP_LEFT_ACTION])
const statesOf = async (stepId: string) => (await rows()).filter((row) => row.details['stepId'] === stepId).map((row) => String(row.details['state'])).sort()
const calls = (stripe: FakeStripe) => stripe.calls.map((call) => call.method)
const paramsOf = (call: { params: unknown } | undefined): Record<string, unknown> => (call?.params ?? {}) as Record<string, unknown>
const updates = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'subscriptions.update')
/** W40 (S1): the press's window. Reconcile leaves a step alone until it is older than this. */
const WINDOW_MS = 15 * 60_000
const pastTheWindow = () => vi.setSystemTime(Date.now() + WINDOW_MS + 60_000)
const reconcileNow = (stripe: StripeClient, requestId: string = crypto.randomUUID()) => reconcile(db, stripe as FakeStripe, { actor: { type: 'system', id: null }, requestId, maxItems: 50, budgetMs: 60_000 })
/** A run once every step so far is past its press's window (W40, S1): the run these tests are about. */
const runReconcile = (stripe: StripeClient, requestId: string = crypto.randomUUID()) => {
  pastTheWindow()
  return reconcileNow(stripe, requestId)
}
const SYSTEM = { actor: { type: 'system' as const, id: null }, requestId: 'run-1' }
const listed = async () => (await stuckList(db)).steps
const no = () => ({ kind: 'error' as const, error: fakeStripeErrors.invalid('subscription_update_refused', 'This subscription cannot be updated right now.') })
const noAnswer = () => ({ kind: 'error' as const, error: fakeStripeErrors.server() })

async function close(stepId: string, email = REPLAY_USER.email): Promise<{ status: number; data?: Record<string, unknown>; error?: { code: string; message: string } }> {
  const response = await closeRoute(
    new Request('https://worker.test/api/v1/staff/orders/stuck/close', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'left_step', orderId: stepId, reason: 'Set in Stripe by hand' }),
    })
  )
  const body = (await response.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string } }
  return { status: response.status, ...body }
}

describe('a step is written with its database change (leaveStep)', () => {
  it("writes one `left` row on the membership, in the caller's transaction, carrying what a later send needs", async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      expect(step).toMatchObject({ membershipId: ID.membership, subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', want: { cancelAt: ENDS } })
      expect(step.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(await rows()).toEqual([
        {
          entity_type: 'membership',
          entity_id: ID.membership,
          actor_type: 'staff',
          actor_id: ID.staff,
          request_id: 'req-press',
          details: { stepId: step.id, kind: 'cancel_at', state: 'left', subscriptionId: MO_SUBSCRIPTION, want: { cancelAt: ENDS } },
        },
      ])
      // Writing it asks Stripe nothing.
      expect(stripe.calls).toEqual([])
    })
  })

  it('goes with the database change or not at all: a transaction that fails after it leaves no step', async () => {
    await onASeed(async () => {
      await expect(
        db.transaction(async (tx) => {
          await tx.query("UPDATE customer_memberships SET cancel_effective_date = '2026-12-09' WHERE id = $1", [ID.membership])
          await leaveStep(tx, { membershipId: ID.membership, subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', want: { cancelAt: ENDS } }, BY)
          throw new Error('the action failed after recording its step')
        })
      ).rejects.toThrow('the action failed after recording its step')
      expect(await rows()).toEqual([])
      expect(await openSteps(db)).toEqual([])
      expect((await db.query<{ ends: string | null }>('SELECT cancel_effective_date::text AS ends FROM customer_memberships WHERE id = $1', [ID.membership]))[0]?.ends).toBeNull()
    })
  })

  it("a fault in the caller is never written: an unknown kind, a step that doesn't say what it wants, no membership or subscription", async () => {
    await onASeed(async () => {
      await expect(leave('trial_end' as StepKind, { cancelAt: ENDS })).rejects.toThrow('Unknown step kind')
      await expect(leave('cancel_at', {})).rejects.toThrow('needs cancelAt')
      await expect(leave('cancel_at', { cancelAt: 0 })).rejects.toThrow('needs cancelAt')
      await expect(leave('cancel_at', { cancelAt: 1796860800.5 })).rejects.toThrow('needs cancelAt')
      await expect(leave('payment_method', {})).rejects.toThrow('needs paymentMethod')
      await expect(leave('payment_method', { paymentMethod: '  ' })).rejects.toThrow('needs paymentMethod')
      await expect(leave('cancel_at', { cancelAt: ENDS }, '')).rejects.toThrow('needs its membership and its subscription')
      expect(await rows()).toEqual([])
      // An undo's want is "no end": null is a want, not a missing one. Only what the kind wants is kept.
      expect((await leave('cancel_at', { cancelAt: null, paymentMethod: 'pm_stray' })).want).toEqual({ cancelAt: null })
      expect((await leave('payment_method', { paymentMethod: 'pm_new', cancelAt: ENDS })).want).toEqual({ paymentMethod: 'pm_new' })
      expect(STEP_KINDS).toEqual(['cancel_at', 'payment_method'])
    })
  })

  it('the newest wins: a second step of the same kind on the same subscription closes the first as replaced; another kind, or another subscription, is left alone', async () => {
    await onASeed(async (stripe) => {
      stripe.addSubscription('sub_other', MEMBER_STRIPE_CUSTOMER, MONTHLY_PRICE)
      const cancel = await cancelStep()
      const card = await leave('payment_method', { paymentMethod: 'pm_new' })
      const other = await leave('cancel_at', { cancelAt: ENDS }, 'sub_other')
      expect((await openSteps(db)).map((step) => step.id).sort()).toEqual([cancel.id, card.id, other.id].sort())

      const undo = await leave('cancel_at', { cancelAt: null })
      expect(await statesOf(cancel.id)).toEqual(['left', 'replaced'])
      const replaced = (await rows()).find((row) => row.details['stepId'] === cancel.id && row.details['state'] === 'replaced')
      expect(replaced?.details).toEqual({ stepId: cancel.id, kind: 'cancel_at', state: 'replaced', subscriptionId: MO_SUBSCRIPTION, want: { cancelAt: ENDS }, replacedBy: undo.id })
      expect((await openSteps(db)).map((step) => step.id).sort()).toEqual([card.id, other.id, undo.id].sort())

      // Reconcile sends the undo, never the cancel it replaced: Stripe ends with no end date.
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: ENDS })
      await runReconcile(stripe)
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)).toMatchObject({ cancelAt: null, defaultPaymentMethod: 'pm_new' })
      expect(stripe.subscriptionSettings('sub_other')?.cancelAt).toBe(ENDS)
      expect(updates(stripe).map((call) => call.params)).not.toContainEqual({ id: MO_SUBSCRIPTION, cancel_at: ENDS, proration_behavior: 'none' })
      expect(await openSteps(db)).toEqual([])
    })
  })
})

describe('a step is read first and sent only if still needed (trySendStep)', () => {
  it('sets the cancel date: the subscription is read, then changed under a key from the step', async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      expect(await trySendStep(stripe, step, undefined)).toEqual({ kind: 'done', sent: true, detail: 'sent' })
      expect(stripe.calls).toEqual([
        { method: 'subscriptions.retrieve', params: { id: MO_SUBSCRIPTION }, idempotencyKey: null },
        // W40 (W36 review L1): a cancel date never prorates.
        { method: 'subscriptions.update', params: { id: MO_SUBSCRIPTION, cancel_at: ENDS, proration_behavior: 'none' }, idempotencyKey: `${step.id}:cancel-at` },
      ])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      // Sending writes nothing: the caller records how it ended.
      expect(await statesOf(step.id)).toEqual(['left'])
    })
  })

  it('sends nothing when Stripe already shows what was asked', async () => {
    await onASeed(async (stripe) => {
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: ENDS })
      const step = await cancelStep()
      expect(await trySendStep(stripe, step, undefined)).toEqual({ kind: 'done', sent: false, detail: 'Stripe already showed it' })
      expect(calls(stripe)).toEqual(['subscriptions.retrieve'])
      // And an undo of a subscription with no end date.
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
      expect(await trySendStep(stripe, await leave('cancel_at', { cancelAt: null }), undefined)).toMatchObject({ kind: 'done', sent: false })
      expect(updates(stripe)).toEqual([])
    })
  })

  it("clears the cancel date (an undo), and moves the subscription to a card: each its own key", async () => {
    await onASeed(async (stripe) => {
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: ENDS })
      const undo = await leave('cancel_at', { cancelAt: null })
      expect(await trySendStep(stripe, undo, undefined)).toMatchObject({ kind: 'done', sent: true })
      const card = await leave('payment_method', { paymentMethod: 'pm_new' })
      expect(await trySendStep(stripe, card, undefined)).toMatchObject({ kind: 'done', sent: true })
      expect(updates(stripe)).toEqual([
        { method: 'subscriptions.update', params: { id: MO_SUBSCRIPTION, cancel_at: '', proration_behavior: 'none' }, idempotencyKey: `${undo.id}:cancel-at` },
        { method: 'subscriptions.update', params: { id: MO_SUBSCRIPTION, default_payment_method: 'pm_new' }, idempotencyKey: `${card.id}:payment-method` },
      ])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)).toMatchObject({ cancelAt: null, defaultPaymentMethod: 'pm_new' })
      // The card again: already there, so nothing is sent.
      expect(await trySendStep(stripe, card, undefined)).toMatchObject({ kind: 'done', sent: false })
      expect(updates(stripe)).toHaveLength(2)
    })
  })

  it('what counts as done: the cancel date to the second, and the card whether Stripe shows its id or the card itself', () => {
    const cancel = { kind: 'cancel_at' as const, want: { cancelAt: ENDS } }
    expect(stepIsDone({ cancel_at: ENDS, default_payment_method: null }, cancel)).toBe(true)
    expect(stepIsDone({ cancel_at: ENDS + 1, default_payment_method: null }, cancel)).toBe(false)
    expect(stepIsDone({ cancel_at: null, default_payment_method: null }, cancel)).toBe(false)
    expect(stepIsDone({ cancel_at: null, default_payment_method: null }, { kind: 'cancel_at', want: { cancelAt: null } })).toBe(true)
    expect(stepIsDone({ cancel_at: ENDS, default_payment_method: null }, { kind: 'cancel_at', want: { cancelAt: null } })).toBe(false)
    const card = { kind: 'payment_method' as const, want: { paymentMethod: 'pm_new' } }
    expect(stepIsDone({ cancel_at: null, default_payment_method: 'pm_new' }, card)).toBe(true)
    expect(stepIsDone({ cancel_at: null, default_payment_method: { id: 'pm_new' } as never }, card)).toBe(true)
    expect(stepIsDone({ cancel_at: null, default_payment_method: 'pm_old' }, card)).toBe(false)
    expect(stepIsDone({ cancel_at: null, default_payment_method: null }, card)).toBe(false)
  })

  it('refused: Stripe answered and said no. Unclear: no answer, on the read or the send. Neither throws', async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      stripe.failNext('subscriptions.update', no())
      expect(await trySendStep(stripe, step, undefined)).toEqual({ kind: 'refused', message: 'This subscription cannot be updated right now.' })

      stripe.failNext('subscriptions.update', noAnswer())
      expect(await trySendStep(stripe, step, undefined, 'a')).toEqual({ kind: 'unclear', message: 'An error occurred with our API.' })
      stripe.failNext('subscriptions.update', { kind: 'unreachable' })
      expect(await trySendStep(stripe, step, undefined, 'b')).toMatchObject({ kind: 'unclear' })

      stripe.failNext('subscriptions.retrieve', noAnswer())
      expect(await trySendStep(stripe, step, undefined, 'c')).toEqual({ kind: 'unclear', message: 'not read (An error occurred with our API.)' })
      // The read says there is no such subscription with this key: a person's (deleted, or the other Stripe mode's).
      stripe.failNext('subscriptions.retrieve', { kind: 'error', error: fakeStripeErrors.missing(`subscription: '${MO_SUBSCRIPTION}'`) })
      expect(await trySendStep(stripe, step, undefined, 'd')).toEqual({ kind: 'refused', missing: true, message: `Stripe can't find subscription ${MO_SUBSCRIPTION} with the key in use.` })
      // W40 (L2): and when the send itself says so (deleted between the read and the send).
      stripe.failNext('subscriptions.update', { kind: 'error', error: fakeStripeErrors.missing(`subscription: '${MO_SUBSCRIPTION}'`) })
      expect(await trySendStep(stripe, step, undefined, 'd2')).toMatchObject({ kind: 'refused', missing: true })
      // A refused key (401) is the key's fault, not the step's: unclear, so it is sent again once the key works.
      stripe.failNext('subscriptions.update', { kind: 'error', error: fakeStripeErrors.authentication() })
      expect(await trySendStep(stripe, step, undefined, 'e')).toMatchObject({ kind: 'unclear' })
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
    })
  })

  it('with too little time left before the deadline nothing is sent, and the answer is unclear', async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      const now = Date.now()
      expect(await trySendStep(stripe, step, { deadline: now + 1_000, now: () => now })).toMatchObject({ kind: 'unclear', message: expect.stringContaining('Not sent') })
      expect(stripe.calls).toEqual([])
    })
  })

  it('a send that took effect with its answer lost is unclear; the next try reads it as done and sends nothing', async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      stripe.failNext('subscriptions.update', { kind: 'lost_response' })
      expect(await trySendStep(stripe, step, undefined)).toMatchObject({ kind: 'unclear' })
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      expect(await trySendStep(stripe, step, undefined, 'next-run')).toEqual({ kind: 'done', sent: false, detail: 'Stripe already showed it' })
      expect(updates(stripe)).toHaveLength(1)
    })
  })

  it("a subscription Stripe has already ended: an end date or a card is settled without sending; an undo can't be done, and is a person's", async () => {
    await onASeed(async (stripe) => {
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      expect(await trySendStep(stripe, await cancelStep(), undefined)).toEqual({ kind: 'done', sent: false, detail: 'the subscription has already ended in Stripe' })
      expect(await trySendStep(stripe, await leave('payment_method', { paymentMethod: 'pm_new' }), undefined)).toMatchObject({ kind: 'done', sent: false })
      expect(await trySendStep(stripe, await leave('cancel_at', { cancelAt: null }), undefined)).toEqual({
        kind: 'refused',
        message: `Subscription ${MO_SUBSCRIPTION} has already ended in Stripe, so its cancellation can't be undone there.`,
      })
      expect(updates(stripe)).toEqual([])
    })
  })

  it("the key is from the step's id; reconcile's sends carry the run's id too, so an answer Stripe saved for an earlier send can't keep a later one from settling", async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      expect(stepKey(step)).toBe(`${step.id}:cancel-at`)
      expect(stepKey(step, 'run-1')).toBe(`${step.id}:cancel-at:run-1`)
      expect(stepKey({ id: step.id, kind: 'payment_method' })).toBe(`${step.id}:payment-method`)
      // The press's send is answered with a 500, which Stripe saves against its key and replays.
      stripe.failNext('subscriptions.update', noAnswer())
      expect(await trySendStep(stripe, step, undefined)).toMatchObject({ kind: 'unclear' })
      expect(await trySendStep(stripe, step, undefined)).toMatchObject({ kind: 'unclear' })
      // A run's own key is a new request: it goes.
      expect(await trySendStep(stripe, step, undefined, 'run-1')).toMatchObject({ kind: 'done', sent: true })
      expect(updates(stripe).map((call) => call.idempotencyKey)).toEqual([`${step.id}:cancel-at`, `${step.id}:cancel-at`, `${step.id}:cancel-at:run-1`])
    })
  })
})

describe('left: listed, and sent again by reconcile until it is done', () => {
  it('a left step is on the stuck list with its words and no button, and reconcile sends it: done, recorded, off the list, and never a charge or a refund', async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      expect(await listed()).toEqual([
        {
          stepId: step.id,
          membershipId: ID.membership,
          subscriptionId: MO_SUBSCRIPTION,
          step: 'cancel_at',
          // W40 (item 6): what it is, and the last day of access it sets (the day before 10 December).
          what: 'cancel_date',
          lastDay: '2026-12-09',
          customerId: ID.member,
          customerName: 'Mo Member',
          state: 'left',
          at: expect.any(String),
          words: LEFT_STEP_WORDS.cancel_at.left(MO_SUBSCRIPTION),
        },
      ])
      // W40 (S1): inside the press's window it is listed, but not reconcile's yet.
      expect(await stepsDue(db)).toEqual([])
      pastTheWindow()
      expect((await stepsDue(db)).map((due) => due.id)).toEqual([step.id])

      const run = await runReconcile(stripe, 'run-1')
      expect(run).toMatchObject({ checked: 1, finalised: 1, undone: 0, refunds: 0, left: 0, deferred: 0 })
      expect(run.items).toEqual([{ kind: 'step', id: step.id, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      expect(updates(stripe).map((call) => call.idempotencyKey)).toEqual([`${step.id}:cancel-at:run-1`])
      expect(await statesOf(step.id)).toEqual(['done', 'left'])
      const done = (await rows()).find((row) => row.details['state'] === 'done')
      expect(done).toMatchObject({ actor_type: 'system', actor_id: null, request_id: 'run-1', details: { stepId: step.id, kind: 'cancel_at', detail: 'sent', sent: true } })
      // The run's own row, against the step.
      expect(await db.query("SELECT entity_id, details->>'outcome' AS outcome FROM audit_log WHERE action = 'order.reconcile' AND entity_type = 'membership_step'")).toEqual([{ entity_id: step.id, outcome: 'finalised' }])
      expect(await listed()).toEqual([])
      expect(await stepsDue(db)).toEqual([])

      // Nothing more to do, and nothing but the read and the one change ever reached Stripe.
      expect((await runReconcile(stripe)).items).toEqual([])
      expect(calls(stripe)).toEqual(['subscriptions.retrieve', 'subscriptions.update'])
      expect(stripe.netPence).toBe(0)
    })
  })

  it('no clear answer on the retry: left for the next run, still listed, recorded once per reason; then it goes', async () => {
    await onASeed(async (stripe) => {
      const step = await leave('payment_method', { paymentMethod: 'pm_new' })
      expect((await listed())[0]?.words).toBe(LEFT_STEP_WORDS.payment_method.left(MO_SUBSCRIPTION))
      for (const run of ['run-1', 'run-2']) {
        stripe.failNext('subscriptions.update', noAnswer())
        const result = await runReconcile(stripe, run)
        expect(result).toMatchObject({ checked: 1, finalised: 0, left: 1 })
        expect(result.items).toEqual([{ kind: 'step', id: step.id, outcome: 'left', reason: 'step_left', detail: `payment_method on subscription ${MO_SUBSCRIPTION}: An error occurred with our API.` }])
      }
      expect(await statesOf(step.id)).toEqual(['left'])
      expect(await listed()).toHaveLength(1)
      // One `order.reconcile` row for the two runs: the same reason isn't written again.
      expect(await db.query("SELECT details->>'reason' AS reason FROM audit_log WHERE action = 'order.reconcile' AND entity_type = 'membership_step' AND entity_id = $1", [step.id])).toEqual([{ reason: 'step_left' }])

      expect((await runReconcile(stripe, 'run-3')).items).toEqual([expect.objectContaining({ kind: 'step', outcome: 'finalised' })])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.defaultPaymentMethod).toBe('pm_new')
      expect(await listed()).toEqual([])
    })
  })

  it('a step done in Stripe by hand in the meantime is recorded as done without sending anything', async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: ENDS })
      expect((await runReconcile(stripe)).items).toEqual([{ kind: 'step', id: step.id, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: Stripe already showed it` }])
      expect(updates(stripe)).toEqual([])
      expect((await rows()).find((row) => row.details['state'] === 'done')?.details).toMatchObject({ sent: false })
    })
  })

  it("a `done` row that can't be written leaves the step open; the next run reads Stripe, finds it done, and writes it then", async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      const first = await whileFailing(db, { table: 'audit_log', event: 'INSERT', when: `NEW.action = '${STEP_LEFT_ACTION}' AND NEW.details->>'state' = 'done'` }, () => runReconcile(stripe))
      expect(first.items).toEqual([expect.objectContaining({ kind: 'step', id: step.id, outcome: 'left', reason: 'step_left', detail: expect.stringContaining('done in Stripe, not recorded yet') })])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      expect(await listed()).toHaveLength(1)
      expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ outcome: 'finalised', detail: expect.stringContaining('Stripe already showed it') })])
      expect(updates(stripe)).toHaveLength(1)
      expect(await listed()).toEqual([])
    })
  })

  it("a step closed since the run listed it is left alone (the press finished it, or it was replaced)", async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      await db.transaction((tx) => audit.recordAll(tx, [stepEndEntry(step, 'done', BY, 'sent by the press')]))
      pastTheWindow()
      expect(await settleLeftStep(db, stripe, step.id, { actor: { type: 'system', id: null }, requestId: 'run-1' }, undefined)).toEqual({ kind: 'closed' })
      expect(stripe.calls).toEqual([])
      expect(await settleLeftStep(db, stripe, crypto.randomUUID(), { actor: { type: 'system', id: null }, requestId: 'run-1' }, undefined)).toEqual({ kind: 'closed' })
    })
  })

  it("the press's own endings close a step: `done`, and `undone` when its database change is put back after a refusal", async () => {
    await onASeed(async () => {
      const done = await cancelStep()
      await db.transaction((tx) => audit.recordAll(tx, [stepEndEntry(done, 'done', BY)]))
      const undone = await leave('payment_method', { paymentMethod: 'pm_new' })
      await db.transaction(async (tx) => {
        await tx.query('UPDATE customer_memberships SET cancel_effective_date = NULL WHERE id = $1', [ID.membership])
        await audit.recordAll(tx, [stepEndEntry(undone, 'undone', BY, 'Stripe refused: This subscription cannot be updated right now.')])
      })
      expect(await openSteps(db)).toEqual([])
      expect(await statesOf(undone.id)).toEqual(['left', 'undone'])
      expect((await rows()).find((row) => row.details['state'] === 'undone')?.details).toMatchObject({ detail: 'Stripe refused: This subscription cannot be updated right now.' })
    })
  })
})

describe('refused for good: a line for a person, never sent again (lead call L7)', () => {
  it('Stripe says no on the retry: recorded as refused, listed with what to do and a Mark sorted button, and not due again', async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      stripe.failNext('subscriptions.update', no())
      const run = await runReconcile(stripe, 'run-1')
      expect(run).toMatchObject({ checked: 1, finalised: 0, left: 1 })
      expect(run.items).toEqual([{ kind: 'step', id: step.id, outcome: 'left', reason: 'step_refused', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: This subscription cannot be updated right now.` }])
      expect(await statesOf(step.id)).toEqual(['left', 'refused'])
      expect((await rows()).find((row) => row.details['state'] === 'refused')?.details).toEqual({
        stepId: step.id,
        kind: 'cancel_at',
        state: 'refused',
        subscriptionId: MO_SUBSCRIPTION,
        want: { cancelAt: ENDS },
        detail: 'This subscription cannot be updated right now.',
      })

      const line = (await listed())[0]
      expect(line).toMatchObject({ stepId: step.id, state: 'refused', customerName: 'Mo Member', close: { kind: 'left_step', orderId: step.id } })
      expect(line?.words).toBe(
        `A membership's cancellation was recorded, but Stripe refused to change its subscription (${MO_SUBSCRIPTION}), so the automatic check has stopped trying and it could still renew past its last day. Set or clear its cancel date in Stripe by hand to match the membership (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`
      )
      expect(stepWords({ kind: 'payment_method', subscriptionId: 'sub_x', refused: true })).toBe(LEFT_STEP_WORDS.payment_method.refused('sub_x'))

      // Not due again: three more runs read and send nothing.
      expect(await stepsDue(db)).toEqual([])
      const before = stripe.calls.length
      for (let i = 0; i < 3; i++) expect((await runReconcile(stripe)).items).toEqual([])
      expect(stripe.calls).toHaveLength(before)
      expect(await statesOf(step.id)).toEqual(['left', 'refused'])
      expect(await listed()).toHaveLength(1)
    })
  })

  it("a subscription the key can't find, and an undo of one that has ended, are refused for good the same way", async () => {
    await onASeed(async (stripe) => {
      stripe.addSubscription('sub_ended', MEMBER_STRIPE_CUSTOMER, MONTHLY_PRICE)
      stripe.setSubscription('sub_ended', { status: 'canceled' })
      const missing = await leave('cancel_at', { cancelAt: ENDS }, 'sub_gone')
      const ended = await leave('cancel_at', { cancelAt: null }, 'sub_ended')
      const run = await runReconcile(stripe)
      expect(run.items.map((item) => [item.id, item.reason]).sort()).toEqual([[ended.id, 'step_refused'], [missing.id, 'step_refused']].sort())
      expect((await listed()).map((line) => line.state)).toEqual(['refused', 'refused'])
      expect(updates(stripe)).toEqual([])
      expect((await runReconcile(stripe)).items).toEqual([])
    })
  })

  it("a refusal that can't be recorded stays left, and the next run tries again", async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      stripe.failNext('subscriptions.update', no())
      const first = await whileFailing(db, { table: 'audit_log', event: 'INSERT', when: `NEW.action = '${STEP_LEFT_ACTION}' AND NEW.details->>'state' = 'refused'` }, () => runReconcile(stripe))
      expect(first.items).toEqual([expect.objectContaining({ outcome: 'left', reason: 'step_left', detail: expect.stringContaining('refused by Stripe, not recorded yet') })])
      expect(await stepsDue(db)).toHaveLength(1)
      expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ id: step.id, outcome: 'finalised' })])
    })
  })
})

describe('sorted: a person closes a refused step (the manual close, Issue refunds)', () => {
  const refusedStep = async (stripe: FakeStripe): Promise<LeftStep> => {
    const step = await cancelStep()
    stripe.failNext('subscriptions.update', no())
    await runReconcile(stripe)
    return step
  }

  it('Mark sorted records it, takes it off the list, changes nothing else, and a second press answers that it was already closed', async () => {
    await onASeed(async (stripe) => {
      const step = await refusedStep(stripe)
      const before = stripe.calls.length
      const closed = await close(step.id)
      expect(closed.status).toBe(200)
      expect(closed.data).toEqual({ kind: 'left_step', orderId: step.id, closed: true, message: 'Marked as sorted. It is no longer listed.' })
      expect(await statesOf(step.id)).toEqual(['left', 'refused', 'sorted'])
      const sorted = (await rows()).find((row) => row.details['state'] === 'sorted')
      expect(sorted).toMatchObject({ actor_type: 'staff', actor_id: ID.staff, entity_id: ID.membership, details: { stepId: step.id, byHand: { why: 'Set in Stripe by hand' } } })
      expect(await listed()).toEqual([])
      expect(await openSteps(db)).toEqual([])
      // W40 (W36 review L4): and the `order.close` row every manual close writes, in the same transaction.
      expect(await db.query("SELECT actor_type, actor_id, entity_type, entity_id, details FROM audit_log WHERE action = 'order.close'")).toEqual([
        {
          actor_type: 'staff',
          actor_id: ID.staff,
          entity_type: 'membership_step',
          entity_id: step.id,
          details: { kind: 'left_step', why: 'Set in Stripe by hand', membershipId: ID.membership, subscriptionId: MO_SUBSCRIPTION, step: 'cancel_at', want: { cancelAt: ENDS }, refusal: 'This subscription cannot be updated right now.' },
        },
      ])
      // Nothing was sent to Stripe, and the membership is as it was.
      expect(stripe.calls).toHaveLength(before)
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()

      expect((await close(step.id)).data).toEqual({ kind: 'left_step', orderId: step.id, closed: true, alreadyClosed: true, message: 'Marked as sorted. It is no longer listed.' })
      expect(await statesOf(step.id)).toEqual(['left', 'refused', 'sorted'])
      // The second press writes no second close row.
      expect(await db.query("SELECT 1 FROM audit_log WHERE action = 'order.close'")).toHaveLength(1)
      expect((await runReconcile(stripe)).items).toEqual([])
    })
  })

  it("a step the automatic check is still sending can't be sorted, nor one that isn't listed", async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      expect((await close(step.id)).data).toEqual({ kind: 'left_step', orderId: step.id, closed: false, reason: 'still_trying', message: LEFT_STEP_WORDS.stillTrying })
      expect(await statesOf(step.id)).toEqual(['left'])
      const unknown = crypto.randomUUID()
      expect((await close(unknown)).data).toEqual({ kind: 'left_step', orderId: unknown, closed: false, reason: 'not_listed', message: LEFT_STEP_WORDS.notListed })
      // One that reconcile finished is no longer listed either.
      await runReconcile(stripe)
      expect((await close(step.id)).data).toMatchObject({ closed: false, reason: 'not_listed' })
    })
  })

  it('needs the Issue refunds permission, as every manual close', async () => {
    await onASeed(async (stripe) => {
      const step = await refusedStep(stripe)
      await db.query('UPDATE staff SET can_issue_refunds = false WHERE id = $1', [ID.staff])
      const refused = await close(step.id)
      expect(refused.status).toBe(403)
      expect(refused.error?.code).toBe('FORBIDDEN')
      expect(await statesOf(step.id)).toEqual(['left', 'refused'])
    })
  })

  it('the rule itself: sorted once, under its own lock, whoever asks', async () => {
    await onASeed(async (stripe) => {
      const step = await refusedStep(stripe)
      const [one, two] = await Promise.all([sortLeftStep(db, step.id, 'first', BY), sortLeftStep(db, step.id, 'second', BY)])
      expect([one, two].map((answer) => answer.closed)).toEqual([true, true])
      expect([one, two].filter((answer) => answer.closed && answer.alreadyClosed === true)).toHaveLength(1)
      expect((await statesOf(step.id)).filter((state) => state === 'sorted')).toHaveLength(1)
    })
  })
})

describe('what the list reads', () => {
  it('rows this file did not write are never guessed at: an unknown kind is not listed, sent or sorted', async () => {
    await onASeed(async (stripe) => {
      await db.transaction((tx) =>
        audit.recordAll(tx, [
          { actorType: 'system', actorId: null, action: STEP_LEFT_ACTION, entityType: 'membership', entityId: ID.membership, requestId: 'later-worker', details: { stepId: crypto.randomUUID(), kind: 'trial_end', state: 'left', subscriptionId: MO_SUBSCRIPTION, want: {} } },
        ])
      )
      expect(await openSteps(db)).toEqual([])
      expect(await listed()).toEqual([])
      expect((await runReconcile(stripe)).items).toEqual([])
      expect(stripe.calls).toEqual([])
    })
  })

  it("the staff app published before W36 reads the stuck list as before: a step is only ever in `steps`, a field of its own, and no older line carries the new close kind", async () => {
    await onASeed(async (stripe) => {
      const left = await cancelStep()
      const refused = await leave('payment_method', { paymentMethod: 'pm_new' })
      stripe.failNext('subscriptions.update', no())
      pastTheWindow()
      await settleLeftStep(db, stripe, refused.id, { actor: { type: 'system', id: null }, requestId: 'run-1' }, undefined)
      const list = await stuckList(db)
      // The published getStuckReaderPayments copies the six fields it knows by name, and `watched` since W32.
      // W41: and `paymentDates`, a field of its own too.
      expect(Object.keys(list).sort()).toEqual(['alert', 'checkout', 'claims', 'flows', 'paymentDates', 'refunds', 'steps', 'warnings', 'watched'])
      expect(list).toMatchObject({ checkout: [], flows: [], claims: [], refunds: [], warnings: [], watched: [], paymentDates: [], alert: null })
      expect(list.steps.map((step) => [step.stepId, step.state]).sort()).toEqual([[left.id, 'left'], [refused.id, 'refused']].sort())
      // The route's own output check takes it.
      const parsed = stuckListOutputSchema.parse(list)
      expect(parsed.steps.filter((step) => step.close !== undefined).map((step) => step.close)).toEqual([{ kind: 'left_step', orderId: refused.id }])
    })
  })

  it('a step whose membership has gone is still listed, with no customer', async () => {
    await onASeed(async () => {
      const gone = crypto.randomUUID()
      const step = await db.transaction((tx) => leaveStep(tx, { membershipId: gone, subscriptionId: 'sub_orphan', kind: 'cancel_at', want: { cancelAt: ENDS } }, BY))
      expect(await listed()).toEqual([expect.objectContaining({ stepId: step.id, membershipId: gone, customerId: null, customerName: null, state: 'left' })])
    })
  })
})

// Brief W40 items 1 and 3 (W36 review S1, L2, L3): sends to one subscription take turns.
describe('sends to one subscription take turns (W40; W36 review S1)', () => {
  /**
   * The fake, with `gap` run once around its first `subscriptions.<method>`: what a press does while a reconcile run
   * is part way through a step. `before`: between the run's check that the step is open and its call. `after`: once
   * the call has landed in Stripe, before the run looks again and writes its row.
   */
  function withGap(stripe: FakeStripe, method: 'retrieve' | 'update', when: 'before' | 'after', gap: () => Promise<unknown>): StripeClient {
    let fired = false
    const real = stripe.subscriptions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const subscriptions = {
      ...real,
      [method]: async (...args: unknown[]) => {
        const first = !fired
        fired = true
        if (first && when === 'before') await gap()
        const answer = await (real[method] as (...a: unknown[]) => Promise<unknown>)(...args)
        if (first && when === 'after') await gap()
        return answer
      },
    }
    return new Proxy(stripe, { get: (target, prop) => (prop === 'subscriptions' ? subscriptions : Reflect.get(target, prop)) }) as unknown as StripeClient
  }
  /** Staff press Cancel again: step C (10 December) replaces what is open, is sent by its press, and marked done. */
  const pressCancel = async (stripe: FakeStripe): Promise<LeftStep> => {
    const step = await cancelStep()
    expect(await trySendStep(stripe, step, undefined)).toMatchObject({ kind: 'done' })
    expect(await recordStepDone(db, step, BY, 'sent')).toBe(true)
    return step
  }
  const reconcileRows = () => db.query<{ entity_id: string; outcome: string; detail: string | null }>("SELECT entity_id, details->>'outcome' AS outcome, details->>'detail' AS detail FROM audit_log WHERE action = 'order.reconcile' AND entity_type = 'membership_step'")

  it("reconcile never sends a step inside its press's window: it is listed at once, due only once it is older than the window, and a new change of the same kind is refused until then", async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      expect(await listed()).toHaveLength(1)
      expect(await stepsDue(db)).toEqual([])
      expect(await stepStillBeingSent(db, MO_SUBSCRIPTION, 'cancel_at')).toBe(true)
      // Another kind on the same subscription, or another subscription, is not in its way.
      expect(await stepStillBeingSent(db, MO_SUBSCRIPTION, 'payment_method')).toBe(false)
      expect(await stepStillBeingSent(db, 'sub_other', 'cancel_at')).toBe(false)
      // A run inside the window reads and sends nothing, and settleLeftStep itself leaves it to the press.
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(await settleLeftStep(db, stripe, step.id, SYSTEM, undefined)).toEqual({ kind: 'left', message: "recorded less than 15 minutes ago: its press may still be sending it" })
      expect(stripe.calls).toEqual([])

      vi.setSystemTime(Date.now() + WINDOW_MS - 5_000)
      expect(await stepsDue(db)).toEqual([])
      vi.setSystemTime(Date.now() + 10_000)
      expect((await stepsDue(db)).map((due) => due.id)).toEqual([step.id])
      expect(await stepStillBeingSent(db, MO_SUBSCRIPTION, 'cancel_at')).toBe(false)
      expect((await reconcileNow(stripe)).items).toEqual([expect.objectContaining({ id: step.id, outcome: 'finalised' })])
    })
  })

  it('a step Stripe has refused is not "still being sent", even inside the window: a new change replaces it', async () => {
    await onASeed(async (stripe) => {
      const step = await cancelStep()
      await db.transaction((tx) => audit.recordAll(tx, [{ actorType: 'system', actorId: null, action: STEP_LEFT_ACTION, entityType: 'membership', entityId: ID.membership, requestId: 'run-0', details: { stepId: step.id, kind: 'cancel_at', state: 'refused', subscriptionId: MO_SUBSCRIPTION, want: { cancelAt: ENDS }, detail: 'no' } }]))
      expect(await stepStillBeingSent(db, MO_SUBSCRIPTION, 'cancel_at')).toBe(false)
      const { step: undo, replaced } = await db.transaction((tx) => leaveStepReplacing(tx, { membershipId: ID.membership, subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', want: { cancelAt: null } }, BY))
      expect(replaced.map((one) => one.id)).toEqual([step.id])
      expect((await openSteps(db)).map((one) => one.id)).toEqual([undo.id])
      expect(stripe.calls).toEqual([])
    })
  })

  // The review's example. Mo pays £40 a month. Cancel got no clear answer (step A, 10 December), then Undo got none
  // either (step B, clear, replaces A). A reconcile run takes B. Staff press Cancel again (step C, 10 December).
  it("a press racing a reconcile send of the step it replaced, the press first: reconcile's stale clear lands last, and the run puts the newest wish back (the membership ends 9 December in both places, nothing hidden)", async () => {
    await onASeed(async (stripe) => {
      const a = await cancelStep()
      const b = await leave('cancel_at', { cancelAt: null })
      pastTheWindow()
      let c: LeftStep | undefined
      // The press lands between the run's check that B is open and the run's read of Stripe.
      const run = await reconcileNow(withGap(stripe, 'retrieve', 'before', async () => void (c = await pressCancel(stripe))), 'run-1')
      if (!c) throw new Error('the press never ran')
      // Stripe was sent, in order: C's 10 December (the press), B's clear (the run's stale send), C's 10 December again.
      expect(updates(stripe).map((call) => [paramsOf(call)['cancel_at'], call.idempotencyKey])).toEqual([
        [ENDS, `${c.id}:cancel-at`],
        ['', `${b.id}:cancel-at:run-1`],
        [ENDS, `${c.id}:cancel-at:run-1`],
      ])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      // B was replaced, and gets no `done` row for a wish that no longer stands.
      expect(await statesOf(a.id)).toEqual(['left', 'replaced'])
      expect(await statesOf(b.id)).toEqual(['left', 'replaced'])
      expect(await statesOf(c.id)).toEqual(['done', 'left'])
      expect(run.items).toEqual([{ kind: 'step', id: b.id, outcome: 'settled_elsewhere', detail: `replaced by step ${c.id}, already done: sent again` }])
      expect(await reconcileRows()).toEqual([{ entity_id: b.id, outcome: 'settled_elsewhere', detail: `replaced by step ${c.id}, already done: sent again` }])
      expect(await listed()).toEqual([])
      expect(stripe.netPence).toBe(0)
    })
  })

  it("the same race, the run's send first: the press's send lands last, the run looks again, finds the newest wish already shown, and writes nothing for the step it sent", async () => {
    await onASeed(async (stripe) => {
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: ENDS })
      await cancelStep()
      const b = await leave('cancel_at', { cancelAt: null })
      pastTheWindow()
      let c: LeftStep | undefined
      // The press lands once the run's clear is in Stripe, before the run writes its row.
      const run = await reconcileNow(withGap(stripe, 'update', 'after', async () => void (c = await pressCancel(stripe))), 'run-1')
      if (!c) throw new Error('the press never ran')
      expect(updates(stripe).map((call) => [paramsOf(call)['cancel_at'], call.idempotencyKey])).toEqual([
        ['', `${b.id}:cancel-at:run-1`],
        [ENDS, `${c.id}:cancel-at`],
      ])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      expect(await statesOf(b.id)).toEqual(['left', 'replaced'])
      expect(await statesOf(c.id)).toEqual(['done', 'left'])
      expect(run.items).toEqual([{ kind: 'step', id: b.id, outcome: 'settled_elsewhere', detail: `replaced by step ${c.id}, already done: Stripe shows it` }])
      expect(await listed()).toEqual([])
    })
  })

  it("the press that replaced it got no clear answer: the run sends the newest wish itself and marks it done; and when that gets no answer either, the newest step is the one line listed", async () => {
    await onASeed(async (stripe) => {
      await cancelStep()
      const b = await leave('cancel_at', { cancelAt: null })
      pastTheWindow()
      let c: LeftStep | undefined
      const pressWithNoAnswer = async () => {
        c = await cancelStep()
        stripe.failNext('subscriptions.update', noAnswer())
        expect(await trySendStep(stripe, c, undefined)).toMatchObject({ kind: 'unclear' })
      }
      const run = await reconcileNow(withGap(stripe, 'retrieve', 'before', pressWithNoAnswer), 'run-1')
      if (!c) throw new Error('the press never ran')
      // B's clear is already what Stripe shows; C is sent under the run's key and marked done by the run.
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      expect(await statesOf(b.id)).toEqual(['left', 'replaced'])
      expect(await statesOf(c.id)).toEqual(['done', 'left'])
      expect((await rows()).find((row) => row.details['stepId'] === c?.id && row.details['state'] === 'done')).toMatchObject({ actor_type: 'system', request_id: 'run-1', details: { sent: true } })
      expect(run.items).toEqual([{ kind: 'step', id: b.id, outcome: 'settled_elsewhere', detail: `replaced by step ${c.id}: sent again` }])
      expect(await listed()).toEqual([])
    })
    await onASeed(async (stripe) => {
      await cancelStep()
      const b = await leave('cancel_at', { cancelAt: null })
      pastTheWindow()
      let c: LeftStep | undefined
      const pressWithNoAnswer = async () => {
        c = await cancelStep()
        stripe.failNext('subscriptions.update', noAnswer())
        expect(await trySendStep(stripe, c, undefined)).toMatchObject({ kind: 'unclear' })
        // And Stripe gives the run no answer either.
        stripe.failNext('subscriptions.update', noAnswer())
      }
      const run = await reconcileNow(withGap(stripe, 'retrieve', 'before', pressWithNoAnswer), 'run-1')
      if (!c) throw new Error('the press never ran')
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
      expect(run.items).toEqual([{ kind: 'step', id: b.id, outcome: 'settled_elsewhere', detail: `replaced by step ${c.id}, which got no clear answer (An error occurred with our API.)` }])
      // The one line: the newest step, the cancel date still to set. Never B's, and never nothing.
      expect((await listed()).map((line) => [line.stepId, line.state, line.what, line.lastDay])).toEqual([[c.id, 'left', 'cancel_date', '2026-12-09']])
      // The next run past its window sends it.
      expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ id: c.id, outcome: 'finalised' })])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(ENDS)
      expect(await listed()).toEqual([])
    })
  })

  it("a press's `done` is written only while its step is still open; a refused press's `undone` row can name the step left again in its place, and the chain is followed through it", async () => {
    await onASeed(async (stripe) => {
      const a = await cancelStep()
      const b = await leave('cancel_at', { cancelAt: null })
      // A is closed (replaced): no `done` is written on it.
      expect(await recordStepDone(db, a, BY, 'sent')).toBe(false)
      expect(await statesOf(a.id)).toEqual(['left', 'replaced'])
      // B's press is refused and put back: B is `undone`, naming A's wish left again as A2.
      const a2 = await db.transaction(async (tx) => {
        const again = await leaveStep(tx, { membershipId: ID.membership, subscriptionId: 'sub_elsewhere', kind: 'cancel_at', want: { cancelAt: ENDS } }, BY)
        await audit.recordAll(tx, [stepEndEntry(b, 'undone', BY, 'Stripe refused: no', again.id)])
        return again
      })
      expect((await rows()).find((row) => row.details['stepId'] === b.id && row.details['state'] === 'undone')?.details).toMatchObject({ detail: 'Stripe refused: no', replacedBy: a2.id })
      expect((await openSteps(db)).map((one) => one.id)).toEqual([a2.id])
      expect(stripe.calls).toEqual([])
    })
  })

  it("what a step is, for the list: a cancel date with the last day of access it sets (the London day before, in winter and in summer), a cancel date to clear, a card", () => {
    expect(stepWhat({ kind: 'cancel_at', want: { cancelAt: ENDS } })).toEqual({ what: 'cancel_date', lastDay: '2026-12-09' })
    // 1 July 2027, 00:00 in London is 30 June 23:00 UTC: the last day is 30 June.
    expect(stepWhat({ kind: 'cancel_at', want: { cancelAt: Date.UTC(2027, 5, 30, 23) / 1000 } })).toEqual({ what: 'cancel_date', lastDay: '2027-06-30' })
    expect(stepWhat({ kind: 'cancel_at', want: { cancelAt: null } })).toEqual({ what: 'clear_cancel_date' })
    expect(stepWhat({ kind: 'payment_method', want: { paymentMethod: 'pm_new' } })).toEqual({ what: 'card' })
  })

  it("L2: a subscription Stripe can't find is listed in its own words, never as \"refused\"", async () => {
    await onASeed(async (stripe) => {
      const step = await leave('cancel_at', { cancelAt: ENDS }, 'sub_gone')
      const run = await runReconcile(stripe)
      expect(run.items).toEqual([expect.objectContaining({ id: step.id, outcome: 'left', reason: 'step_refused' })])
      expect((await rows()).find((row) => row.details['state'] === 'refused')?.details).toMatchObject({ missing: true, detail: "Stripe can't find subscription sub_gone with the key in use." })
      const [line] = await listed()
      expect(line).toMatchObject({ state: 'refused', close: { kind: 'left_step', orderId: step.id } })
      expect(line?.words).toBe(LEFT_STEP_WORDS.cancel_at.missing('sub_gone'))
      expect(line?.words).toContain("Stripe can't find its subscription (sub_gone)")
      expect(line?.words).not.toContain('refused')
      expect(stepWords({ kind: 'payment_method', subscriptionId: 'sub_x', refused: true, missing: true })).toBe(LEFT_STEP_WORDS.payment_method.missing('sub_x'))
      // Not refused: `missing` changes nothing.
      expect(stepWords({ kind: 'cancel_at', subscriptionId: 'sub_x', refused: false, missing: true })).toBe(LEFT_STEP_WORDS.cancel_at.left('sub_x'))
    })
  })

  it('L3: a run sends at most 10 steps, oldest first; the rest wait for the next run and are counted as waiting', async () => {
    await onASeed(async (stripe) => {
      expect(MAX_STEPS_PER_RUN).toBe(10)
      const steps: LeftStep[] = []
      for (let i = 0; i < 12; i++) {
        stripe.addSubscription(`sub_${i}`, MEMBER_STRIPE_CUSTOMER, MONTHLY_PRICE)
        steps.push(await leave('cancel_at', { cancelAt: ENDS }, `sub_${i}`))
      }
      const first = await runReconcile(stripe)
      expect(first).toMatchObject({ checked: 10, finalised: 10, deferred: 2 })
      // Steps recorded in the same millisecond come in either order, so which ten is not pinned: ten of the twelve, once each.
      const sent = first.items.map((item) => item.id)
      expect(new Set(sent).size).toBe(10)
      expect(sent.every((id) => steps.some((step) => step.id === id))).toBe(true)
      expect((await listed()).map((line) => line.stepId).sort()).toEqual(steps.map((step) => step.id).filter((id) => !sent.includes(id)).sort())
      const second = await runReconcile(stripe)
      expect(second).toMatchObject({ checked: 2, finalised: 2, deferred: 0 })
      expect(await listed()).toEqual([])
    })
  })
})

// Brief W40c: every step that closes is checked once more against Stripe, by one read set against the newest wish.
// cancel.test.ts holds W40b's six open paths through the real routes; these are the cap, a card step, and a
// subscription Stripe can't find or has ended.
describe('W40c: a closed step is checked once more against Stripe', () => {
  const pastTheCheck = () => vi.setSystemTime(Date.now() + CHECK_AFTER_MINUTES * 60_000 + 60_000)
  const checkRows = async () => (await db.query<{ details: Record<string, unknown> }>('SELECT details FROM audit_log WHERE action = $1 ORDER BY at', [STEP_CHECK_ACTION])).map((row) => row.details)
  const methods = (stripe: FakeStripe, from: number) => stripe.calls.slice(from).map((call) => call.method)
  /** A step its press sent and closed as done. */
  async function doneStep(stripe: FakeStripe, kind: StepKind, want: StepWant, subscriptionId = MO_SUBSCRIPTION): Promise<LeftStep> {
    const step = await leave(kind, want, subscriptionId)
    expect(await trySendStep(stripe, step, undefined)).toMatchObject({ kind: 'done' })
    expect(await recordStepDone(db, step, BY, 'sent')).toBe(true)
    return step
  }

  it('the window and its margin: a closed step is checked 20 minutes after it closes', () => {
    expect(CHECK_AFTER_MINUTES).toBe(20)
  })

  it('the cap: a run reads at most 5 checks, oldest first; the rest are read by the next runs, each once', async () => {
    await onASeed(async (stripe) => {
      expect(MAX_STEP_CHECKS_PER_RUN).toBe(5)
      const steps: LeftStep[] = []
      for (let i = 0; i < 12; i++) {
        stripe.addSubscription(`sub_${i}`, MEMBER_STRIPE_CUSTOMER, MONTHLY_PRICE)
        steps.push(await doneStep(stripe, 'cancel_at', { cancelAt: ENDS }, `sub_${i}`))
      }
      pastTheCheck()
      const counts: number[] = []
      for (let run = 0; run < 4; run++) {
        const calls = stripe.calls.length
        expect((await reconcileNow(stripe)).items).toEqual([])
        expect(methods(stripe, calls).every((method) => method === 'subscriptions.retrieve')).toBe(true)
        counts.push(stripe.calls.length - calls)
      }
      expect(counts).toEqual([5, 5, 2, 0])
      const rows = await checkRows()
      expect(rows).toHaveLength(12)
      expect(rows.every((row) => row['outcome'] === 'checked')).toBe(true)
      // Each closed step in one row, and one row only.
      expect(rows.flatMap((row) => row['steps'] as string[]).sort()).toEqual(steps.map((step) => step.id).sort())
      expect(await listed()).toEqual([])
    })
  })

  it("the checks come before the run's own steps and never take their place: with 6 checks due and a step to send, 5 are read, the step is sent, and the sixth waits", async () => {
    await onASeed(async (stripe) => {
      for (let i = 0; i < 6; i++) {
        stripe.addSubscription(`sub_${i}`, MEMBER_STRIPE_CUSTOMER, MONTHLY_PRICE)
        await doneStep(stripe, 'cancel_at', { cancelAt: ENDS }, `sub_${i}`)
      }
      pastTheCheck()
      const open = await cancelStep()
      pastTheWindow()
      const calls = stripe.calls.length
      const run = await reconcileNow(stripe)
      expect(run.items).toEqual([{ kind: 'step', id: open.id, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
      expect(methods(stripe, calls)).toEqual([...Array(5).fill('subscriptions.retrieve'), 'subscriptions.retrieve', 'subscriptions.update'])
      // The step's own read and send are the last two: the five before them are the checks'.
      expect(stripe.calls.slice(calls, calls + 5).every((call) => (call.params as { id: string }).id !== MO_SUBSCRIPTION)).toBe(true)
      expect(await checkRows()).toHaveLength(5)
    })
  })

  it('a card step is checked the same way, against default_payment_method: Stripe showing the new card costs one read; an older card landed over it is found, the card is left again, and the next run moves the subscription back', async () => {
    await onASeed(async (stripe) => {
      const card = await doneStep(stripe, 'payment_method', { paymentMethod: 'pm_new' })
      pastTheCheck()
      const calls = stripe.calls.length
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(methods(stripe, calls)).toEqual(['subscriptions.retrieve'])
      expect(await checkRows()).toEqual([{ subscriptionId: MO_SUBSCRIPTION, kind: 'payment_method', steps: [card.id], outcome: 'checked', wish: card.id, detail: `step ${card.id}: Stripe shows it` }])
    })
    await onASeed(async (stripe) => {
      const card = await doneStep(stripe, 'payment_method', { paymentMethod: 'pm_new' })
      // A send of an older card lands late, after the step closed.
      await stripe.subscriptions.update(MO_SUBSCRIPTION, { default_payment_method: 'pm_old' })
      pastTheCheck()
      const calls = stripe.calls.length
      const run = await reconcileNow(stripe)
      const [line] = await listed()
      const again = String(line?.stepId)
      const detail = `step ${card.id}: Stripe shows the card pm_old, not its wish: left again`
      expect(run.items).toEqual([{ kind: 'step', id: again, outcome: 'left', reason: 'step_check_disagreed', detail: `payment_method on subscription ${MO_SUBSCRIPTION}: checked after closing: ${detail}` }])
      expect(methods(stripe, calls)).toEqual(['subscriptions.retrieve'])
      expect(await checkRows()).toEqual([{ subscriptionId: MO_SUBSCRIPTION, kind: 'payment_method', steps: [card.id], outcome: 'left_again', wish: card.id, leftAgain: again, detail }])
      expect(line).toMatchObject({ step: 'payment_method', what: 'card', state: 'left', words: LEFT_STEP_WORDS.payment_method.left(MO_SUBSCRIPTION) })
      expect((await rows()).find((row) => row.details['stepId'] === again && row.details['state'] === 'left')?.details).toMatchObject({ want: { paymentMethod: 'pm_new' }, leftAgainFor: card.id })
      expect((await runReconcile(stripe)).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `payment_method on subscription ${MO_SUBSCRIPTION}: sent` }])
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.defaultPaymentMethod).toBe('pm_new')
      expect(await listed()).toEqual([])
    })
  })

  it('a cancel step and a card step on one subscription are checked apart: each kind against its own newest wish, a read each', async () => {
    await onASeed(async (stripe) => {
      const cancel = await doneStep(stripe, 'cancel_at', { cancelAt: ENDS })
      const card = await doneStep(stripe, 'payment_method', { paymentMethod: 'pm_new' })
      pastTheCheck()
      const calls = stripe.calls.length
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(methods(stripe, calls)).toEqual(['subscriptions.retrieve', 'subscriptions.retrieve'])
      expect((await checkRows()).map((row) => [row['kind'], row['wish'], row['outcome']]).sort()).toEqual([['cancel_at', cancel.id, 'checked'], ['payment_method', card.id, 'checked']].sort())
    })
  })

  it("a subscription Stripe can't find is listed for a person in its own words and never sent; once a person marks it sorted it is not listed again", async () => {
    await onASeed(async (stripe) => {
      // Closed as done, and the subscription has since gone from Stripe (deleted, or the other mode's).
      const step = await leave('cancel_at', { cancelAt: ENDS }, 'sub_gone')
      expect(await recordStepDone(db, step, BY, 'sent')).toBe(true)
      pastTheCheck()
      const run = await reconcileNow(stripe)
      const [line] = await listed()
      const again = String(line?.stepId)
      const message = "Stripe can't find subscription sub_gone with the key in use."
      expect(run.items).toEqual([{ kind: 'step', id: again, outcome: 'left', reason: 'step_refused', detail: `cancel_at on subscription sub_gone: checked after closing: step ${step.id}: ${message} Left for a person` }])
      expect(line).toMatchObject({ state: 'refused', words: LEFT_STEP_WORDS.cancel_at.missing('sub_gone'), close: { kind: 'left_step', orderId: again } })
      expect(await statesOf(again)).toEqual(['left', 'refused'])
      expect((await checkRows())[0]).toMatchObject({ steps: [step.id], outcome: 'for_a_person', wish: step.id, leftAgain: again })
      // Never sent, however many runs pass.
      for (let i = 0; i < 2; i++) expect((await runReconcile(stripe)).items).toEqual([])
      expect(updates(stripe)).toEqual([])
      // A person marks it sorted. W40d: a sorted wish is theirs, so its closing is settled with no read at all.
      expect((await close(again)).status).toBe(200)
      pastTheCheck()
      const calls = stripe.calls.length
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(stripe.calls).toHaveLength(calls)
      expect((await checkRows()).at(-1)).toEqual({ subscriptionId: 'sub_gone', kind: 'cancel_at', steps: [again], outcome: 'checked', wish: again, detail: `step ${again} was marked sorted by a person: not held to Stripe` })
      expect(await listed()).toEqual([])
      pastTheCheck()
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(stripe.calls).toHaveLength(calls)
    })
  })

  it("a subscription Stripe has already ended: an end date that was set is settled (one read, nothing listed); an undo that can never be met is listed for a person, and never sent", async () => {
    await onASeed(async (stripe) => {
      const cancel = await doneStep(stripe, 'cancel_at', { cancelAt: ENDS })
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      pastTheCheck()
      expect((await reconcileNow(stripe)).items).toEqual([])
      expect(await checkRows()).toEqual([{ subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', steps: [cancel.id], outcome: 'checked', wish: cancel.id, detail: `step ${cancel.id}: the subscription has already ended in Stripe` }])
      expect(await listed()).toEqual([])
    })
    await onASeed(async (stripe) => {
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: ENDS })
      const undo = await doneStep(stripe, 'cancel_at', { cancelAt: null })
      stripe.setSubscription(MO_SUBSCRIPTION, { status: 'canceled' })
      pastTheCheck()
      const run = await reconcileNow(stripe)
      const [line] = await listed()
      const again = String(line?.stepId)
      expect(run.items).toMatchObject([{ kind: 'step', id: again, outcome: 'left', reason: 'step_refused' }])
      expect(line).toMatchObject({ state: 'refused', what: 'clear_cancel_date', words: LEFT_STEP_WORDS.cancel_at.refused(MO_SUBSCRIPTION), close: { kind: 'left_step', orderId: again } })
      expect((await checkRows())[0]).toMatchObject({ steps: [undo.id], outcome: 'for_a_person', wish: undo.id, leftAgain: again })
      const sent = updates(stripe).length
      expect((await runReconcile(stripe)).items).toEqual([])
      expect(updates(stripe)).toHaveLength(sent)
    })
  })

  it("a staff run's check keeps to the run's Stripe deadline: with no time left nothing is read or written, and the next run reads", async () => {
    await onASeed(async (stripe) => {
      const step = await doneStep(stripe, 'cancel_at', { cancelAt: ENDS })
      pastTheCheck()
      const calls = stripe.calls.length
      const late = await reconcile(db, stripe, { actor: { type: 'staff', id: ID.staff }, requestId: 'late', maxItems: 10, budgetMs: 15_000, startedAt: Date.now() - 60_000, stripeDeadlineMs: 20_000 })
      expect(late.items).toEqual([])
      expect(stripe.calls).toHaveLength(calls)
      expect(await checkRows()).toEqual([])
      expect((await reconcile(db, stripe, { actor: { type: 'staff', id: ID.staff }, requestId: 'in-time', maxItems: 10, budgetMs: 15_000, startedAt: Date.now(), stripeDeadlineMs: 20_000 })).items).toEqual([])
      expect(await checkRows()).toMatchObject([{ steps: [step.id], outcome: 'checked' }])
      // Written by whoever ran it.
      expect(await db.query('SELECT actor_type, actor_id, request_id FROM audit_log WHERE action = $1', [STEP_CHECK_ACTION])).toEqual([{ actor_type: 'staff', actor_id: ID.staff, request_id: 'in-time' }])
    })
  })

  // Brief W40d item 1 (W40c review S1, its proofs P1 and P2 turned round). Mo pays £40 a month and renews on
  // 10 December. Stripe refused his cancel for good; a person set the end to 10 January by hand (the only date Stripe
  // would take) and pressed Mark sorted. The check must leave that alone.
  describe('W40d: a sorted wish is a person\'s, never read, held to Stripe or sent again', () => {
    /** 10 January 2027, 00:00 in London: the end a person sets by hand instead. */
    const BY_HAND = ENDS + 31 * 24 * 60 * 60

    /** A cancel step a run sent and Stripe refused for good; then Stripe set to 10 January by hand, and Mark sorted. */
    async function refusedThenSortedByHand(stripe: FakeStripe): Promise<LeftStep> {
      const step = await cancelStep()
      stripe.failNext('subscriptions.update', no())
      expect((await runReconcile(stripe)).items).toMatchObject([{ kind: 'step', id: step.id, outcome: 'left', reason: 'step_refused' }])
      expect((await listed()).map((line) => line.state)).toEqual(['refused'])
      stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: BY_HAND })
      expect((await close(step.id)).status).toBe(200)
      expect(await listed()).toEqual([])
      return step
    }
    const sortedRow = (step: LeftStep) => ({ subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', steps: [step.id], outcome: 'checked', wish: step.id, detail: `step ${step.id} was marked sorted by a person: not held to Stripe` })

    it('P1 turned round: Stripe differs from the sorted wish. One `checked` row, no read, no send, nothing listed, and no loop however many runs pass', async () => {
      await onASeed(async (stripe) => {
        const step = await refusedThenSortedByHand(stripe)
        const calls = stripe.calls.length
        // Not before its 20 minutes, as any closing.
        expect((await reconcileNow(stripe)).items).toEqual([])
        expect(await checkRows()).toEqual([])
        pastTheCheck()
        expect((await reconcileNow(stripe)).items).toEqual([])
        expect(await checkRows()).toEqual([sortedRow(step)])
        for (let round = 1; round <= 3; round++) {
          pastTheCheck()
          expect((await runReconcile(stripe)).items).toEqual([])
          expect(await listed()).toEqual([])
        }
        // Stripe was never asked anything, and the hand fix stands.
        expect(stripe.calls).toHaveLength(calls)
        expect(await checkRows()).toHaveLength(1)
        expect((await rows()).filter((row) => 'leftAgainFor' in row.details)).toEqual([])
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(BY_HAND)
      })
    })

    it("P2 turned round: Stripe would take the wish if it were sent again. It is not sent: the person's 10 January stands, with nothing listed", async () => {
      await onASeed(async (stripe) => {
        const step = await refusedThenSortedByHand(stripe)
        const sent = updates(stripe).length
        pastTheCheck()
        // Nothing is set to fail: a send now would go through, and end Mo on 10 December over the hand fix.
        expect((await reconcileNow(stripe)).items).toEqual([])
        expect((await runReconcile(stripe)).items).toEqual([])
        expect(updates(stripe)).toHaveLength(sent)
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(BY_HAND)
        expect(await checkRows()).toEqual([sortedRow(step)])
        expect(await listed()).toEqual([])
      })
    })

    it('the same with Stripe unreadable, past the 2 hours: the sorted wish is settled without a read, so nothing waits on Stripe and nothing is left again', async () => {
      await onASeed(async (stripe) => {
        const step = await refusedThenSortedByHand(stripe)
        const calls = stripe.calls.length
        // Any read would fail, and the closing is older than the check's limit for no clear read.
        stripe.failNext('subscriptions.retrieve', noAnswer())
        vi.setSystemTime(Date.now() + 3 * 3_600_000)
        expect((await reconcileNow(stripe)).items).toEqual([])
        expect(stripe.calls).toHaveLength(calls)
        expect(await checkRows()).toEqual([sortedRow(step)])
        expect(await listed()).toEqual([])
        expect((await rows()).filter((row) => 'leftAgainFor' in row.details)).toEqual([])
      })
    })

    it("a sorted step followed by a new press: the press's own wish is still checked. A late send over it is found, and the press's wish is left again and sent", async () => {
      await onASeed(async (stripe) => {
        const sorted = await refusedThenSortedByHand(stripe)
        // Staff then undo the cancel in the new screen: a step of its own, sent and done. Stripe shows no end date.
        const undo = await doneStep(stripe, 'cancel_at', { cancelAt: null })
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
        // A stale send lands over it.
        stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: ENDS })
        pastTheCheck()
        const calls = stripe.calls.length
        const run = await reconcileNow(stripe)
        const again = String((await listed())[0]?.stepId)
        expect(run.items).toMatchObject([{ kind: 'step', id: again, outcome: 'left', reason: 'step_check_disagreed' }])
        expect(methods(stripe, calls)).toEqual(['subscriptions.retrieve'])
        const [row] = await checkRows()
        expect(row).toMatchObject({ outcome: 'left_again', wish: undo.id, leftAgain: again })
        expect([...(row?.['steps'] as string[])].sort()).toEqual([sorted.id, undo.id].sort())
        expect((await runReconcile(stripe)).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()
      })
    })

    it('a press Stripe refused and put back, after a sorted step: the sorted wish is the one the database shows again, and it is still not held to Stripe', async () => {
      await onASeed(async (stripe) => {
        const sorted = await refusedThenSortedByHand(stripe)
        // An undo whose press Stripe refused: its step is closed `undone`, with nothing still open to link to.
        const undo = await leave('cancel_at', { cancelAt: null })
        await db.transaction((tx) => audit.recordAll(tx, [stepEndEntry(undo, 'undone', BY, 'Stripe refused')]))
        const calls = stripe.calls.length
        pastTheCheck()
        expect((await reconcileNow(stripe)).items).toEqual([])
        expect(stripe.calls).toHaveLength(calls)
        const [row] = await checkRows()
        expect(row).toMatchObject({ outcome: 'checked', wish: sorted.id, detail: `step ${sorted.id} was marked sorted by a person: not held to Stripe` })
        expect([...(row?.['steps'] as string[])].sort()).toEqual([sorted.id, undo.id].sort())
        expect(await listed()).toEqual([])
        expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(BY_HAND)
      })
    })
  })

  // Brief W40d item 2. The real Stripe may store a value differently from the one sent (a rounded `cancel_at`, say);
  // the fake echoes it, so here it is made to round. Without the guard the check would find a disagreement after
  // every send and the same change would go out about every 40 minutes for ever.
  describe('W40d: the loop guard. A wish the check left again, sent and done, that Stripe still shows differently goes to a person', () => {
    /** What this Stripe stores for 10 December 00:00: a minute less. */
    const STORED = ENDS - 60
    /** The fake, storing every `cancel_at` it is sent rounded down by a minute. */
    function rounding(stripe: FakeStripe): FakeStripe {
      const real = stripe.subscriptions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
      const subscriptions = {
        ...real,
        update: async (...args: unknown[]) => {
          const answer = await (real['update'] as (...a: unknown[]) => Promise<unknown>)(...args)
          const sent = (args[1] as { cancel_at?: unknown } | undefined)?.cancel_at
          if (typeof sent === 'number') stripe.setSubscription(String(args[0]), { cancelAt: sent - 60 })
          return answer
        },
      }
      return new Proxy(stripe, { get: (target, prop) => (prop === 'subscriptions' ? subscriptions : Reflect.get(target, prop)) })
    }

    it('one send by the check\'s own step, then a refused line with Mark sorted: never a third send, and once sorted nothing more, ever', async () => {
      await onASeed(async (fake) => {
        const stripe = rounding(fake)
        // The press: sent and done. Stripe took it, and stores a minute less.
        const press = await doneStep(stripe, 'cancel_at', { cancelAt: ENDS })
        expect(updates(fake)).toHaveLength(1)
        expect(fake.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBe(STORED)
        // The check disagrees and leaves the wish again, as for any stale send.
        pastTheCheck()
        const first = await reconcileNow(stripe)
        const again = String((await listed())[0]?.stepId)
        expect(first.items).toMatchObject([{ kind: 'step', id: again, outcome: 'left', reason: 'step_check_disagreed' }])
        // Past its window the run sends it: Stripe takes it, and stores a minute less again.
        expect((await runReconcile(stripe)).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: sent` }])
        expect(updates(fake)).toHaveLength(2)
        expect(await statesOf(again)).toEqual(['done', 'left'])
        expect(await listed()).toEqual([])
        // The next check disagrees about a wish a check already left and a run sent: not left to send again.
        pastTheCheck()
        const calls = fake.calls.length
        const second = await reconcileNow(stripe)
        const [line] = await listed()
        const person = String(line?.stepId)
        const message = `Subscription ${MO_SUBSCRIPTION} was sent this change again after a check and took it, and Stripe shows cancel_at ${STORED} all the same: it is not sent again.`
        const detail = `step ${again}: ${message} Left for a person`
        expect(second.items).toEqual([{ kind: 'step', id: person, outcome: 'left', reason: 'step_refused', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: checked after closing: ${detail}` }])
        expect(methods(fake, calls)).toEqual(['subscriptions.retrieve'])
        expect((await checkRows()).at(-1)).toEqual({ subscriptionId: MO_SUBSCRIPTION, kind: 'cancel_at', steps: [again], outcome: 'for_a_person', wish: again, leftAgain: person, detail })
        expect(line).toMatchObject({ state: 'refused', what: 'cancel_date', words: LEFT_STEP_WORDS.cancel_at.refused(MO_SUBSCRIPTION), close: { kind: 'left_step', orderId: person } })
        expect(await statesOf(person)).toEqual(['left', 'refused'])
        expect((await rows()).find((row) => row.details['stepId'] === person && row.details['state'] === 'refused')?.details).toMatchObject({ detail: message })
        expect((await rows()).find((row) => row.details['stepId'] === person && row.details['state'] === 'left')?.details).toMatchObject({ want: { cancelAt: ENDS }, leftAgainFor: again })
        // Never sent, however many runs and checks pass.
        for (let i = 0; i < 3; i++) {
          pastTheCheck()
          expect((await runReconcile(stripe)).items).toEqual([])
        }
        expect(updates(fake)).toHaveLength(2)
        expect((await listed()).map((one) => one.stepId)).toEqual([person])
        // A person marks it sorted: a sorted wish is theirs, so that is the end of it.
        expect((await close(person)).status).toBe(200)
        const before = fake.calls.length
        for (let i = 0; i < 3; i++) {
          pastTheCheck()
          expect((await runReconcile(stripe)).items).toEqual([])
        }
        expect(fake.calls).toHaveLength(before)
        expect(await listed()).toEqual([])
        expect(updates(fake)).toHaveLength(2)
        expect(press.id).not.toBe(again)
      })
    })

    it("a check's left-again step that Stripe then shows as sent is settled as before: the guard only bites on a disagreement after its send", async () => {
      await onASeed(async (stripe) => {
        await doneStep(stripe, 'cancel_at', { cancelAt: ENDS })
        stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
        pastTheCheck()
        await reconcileNow(stripe)
        const again = String((await listed())[0]?.stepId)
        expect((await runReconcile(stripe)).items).toMatchObject([{ kind: 'step', id: again, outcome: 'finalised' }])
        pastTheCheck()
        expect((await reconcileNow(stripe)).items).toEqual([])
        expect((await checkRows()).at(-1)).toMatchObject({ steps: [again], outcome: 'checked', wish: again })
        expect(await listed()).toEqual([])
      })
    })

    it('a left-again step Stripe already showed (nothing sent) and that a later change then undid is left again once more: only a send that changed nothing ends the sending', async () => {
      await onASeed(async (stripe) => {
        await doneStep(stripe, 'cancel_at', { cancelAt: ENDS })
        stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
        pastTheCheck()
        await reconcileNow(stripe)
        const again = String((await listed())[0]?.stepId)
        // Stripe shows the wish by the time the run reads for it: done, with nothing sent.
        stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: ENDS })
        expect((await runReconcile(stripe)).items).toEqual([{ kind: 'step', id: again, outcome: 'finalised', detail: `cancel_at on subscription ${MO_SUBSCRIPTION}: Stripe already showed it` }])
        stripe.setSubscription(MO_SUBSCRIPTION, { cancelAt: null })
        pastTheCheck()
        expect((await reconcileNow(stripe)).items).toMatchObject([{ kind: 'step', outcome: 'left', reason: 'step_check_disagreed' }])
        expect((await listed()).map((line) => line.state)).toEqual(['left'])
      })
    })
  })
})
