import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import type { Db } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { stuckList } from '@/server/rules/orders/stuck-list'
import { REPLAY_USER, replay, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { ID, MO_SUBSCRIPTION, seed, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { LEFT_STEP_WORDS } from './failure-messages'
import { leaveStep, openSteps, settleLeftStep, sortLeftStep, STEP_KINDS, STEP_LEFT_ACTION, stepEndEntry, stepIsDone, stepKey, stepsDue, stepWords, trySendStep, type LeftStep, type StepKind, type StepWant } from './left'
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
const updates = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'subscriptions.update')
const runReconcile = (stripe: FakeStripe, requestId: string = crypto.randomUUID()) => reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId, maxItems: 50, budgetMs: 60_000 })
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
      expect(updates(stripe).map((call) => call.params)).not.toContainEqual({ id: MO_SUBSCRIPTION, cancel_at: ENDS })
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
        { method: 'subscriptions.update', params: { id: MO_SUBSCRIPTION, cancel_at: ENDS }, idempotencyKey: `${step.id}:cancel-at` },
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
        { method: 'subscriptions.update', params: { id: MO_SUBSCRIPTION, cancel_at: '' }, idempotencyKey: `${undo.id}:cancel-at` },
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
      expect(await trySendStep(stripe, step, undefined, 'd')).toEqual({ kind: 'refused', message: `Stripe can't find subscription ${MO_SUBSCRIPTION} with the key in use.` })
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
          customerId: ID.member,
          customerName: 'Mo Member',
          state: 'left',
          at: expect.any(String),
          words: LEFT_STEP_WORDS.cancel_at.left(MO_SUBSCRIPTION),
        },
      ])
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
      // Nothing was sent to Stripe, and the membership is as it was.
      expect(stripe.calls).toHaveLength(before)
      expect(stripe.subscriptionSettings(MO_SUBSCRIPTION)?.cancelAt).toBeNull()

      expect((await close(step.id)).data).toEqual({ kind: 'left_step', orderId: step.id, closed: true, alreadyClosed: true, message: 'Marked as sorted. It is no longer listed.' })
      expect(await statesOf(step.id)).toEqual(['left', 'refused', 'sorted'])
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
      await settleLeftStep(db, stripe, refused.id, { actor: { type: 'system', id: null }, requestId: 'run-1' }, undefined)
      const list = await stuckList(db)
      // The published getStuckReaderPayments copies the six fields it knows by name, and `watched` since W32.
      expect(Object.keys(list).sort()).toEqual(['alert', 'checkout', 'claims', 'flows', 'refunds', 'steps', 'warnings', 'watched'])
      expect(list).toMatchObject({ checkout: [], flows: [], claims: [], refunds: [], warnings: [], watched: [], alert: null })
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
