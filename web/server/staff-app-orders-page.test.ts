import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { asWorkerFlow } from '@/server/rules/testing/replay/flow-side'
import { oldSide, replay, startReplay, type ReplayEnvironment, type ReplaySide } from '@/server/rules/testing/replay/harness'
import { orderInput, postOrder, withQuotedCardFigure } from '@/server/rules/testing/replay/order-side'
import { ID, lapsedSeat, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import type Stripe from 'stripe'
import { fakeStripeErrors } from '@/server/stripe/fake'
import { finaliseOrder } from '@/server/rules/orders/finalise-order'
import { reconcile, SCHEDULED_LIMITS } from '@/server/rules/orders/reconcile'
import { REFUND_FAILED_WORDS, STUCK_WORDS } from '@/server/rules/orders/stuck-list'
import { undoOrder } from '@/server/rules/orders/undo-order'

// Brief W14b: the Orders page's three wrappers, from the staff app's checkout, against the real Worker routes on
// PGlite with the replay seed (the staff app has no test runner of its own). One actor per item: a Worker item goes
// only to the Worker's reconcile, an old item only to the old sweep; the merged stuck list shows each once. And the
// banner's pure helpers (frontend/utils/stuckList.ts).

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

const appDir = staffAppDir()
const stuckHelpers = () => import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/stuckList'))
const backendFunction = (name: string) => import(/* @vite-ignore */ path.join(appDir, `backend/paddock/${name}`))

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = 'test-staff-api-key'
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

const soaps = { productVariantId: ID.variant, quantity: 2, unitPrice: 12 }
const later = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60_000)

async function onASeed(work: (old: ReplaySide, stripe: FakeStripe) => Promise<void>): Promise<void> {
  await replay(
    environment,
    { name: 'orders page', seed, run: async ({ side, stripe }) => work(side, stripe) },
    (seedDb, stripe) => {
      const side = oldSide(seedDb, stripe)
      // The Worker's own routes (its order route, reconcile) charge this run's fake.
      replayStripe.current = stripe
      return side
    }
  )
}

const status = async (orderId: string) => (await db.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [orderId]))[0]?.payment_status ?? 'gone'
const flowStatus = async (pendingId: string) => (await db.query<{ status: string }>('SELECT status FROM pending_reader_payments WHERE id = $1', [pendingId]))[0]?.status

/**
 * One reader order from each side, both untapped and over the window: the old checkout's (Sam) and the Worker's (Mo).
 * W16: no old checkout order can be made live any more (none was left, checked 11 Nov); the old one here comes from the
 * replay's test-only copy, to show nothing settles it twice and the old sweep no longer touches orders at all.
 */
async function oneOfEach(old: ReplaySide, stripe: FakeStripe): Promise<{ oldOrder: string; oldIntent: string; workerOrder: string; workerIntent: string }> {
  const placed = (await old.call('createOrder', { customerId: ID.customer, products: [soaps], payment: { method: 'reader' } })) as { orderId: string; pendingReaderPayment: { paymentIntentId: string } }
  replayStripe.current = stripe
  const worker = await postOrder(await withQuotedCardFigure(orderInput({ customerId: ID.member, products: [soaps], payment: { method: 'reader' } })))
  if (!worker.body.ok || !worker.body.data.pendingReaderPayment) throw new Error('the Worker reader order was not placed')
  later(16)
  return { oldOrder: placed.orderId, oldIntent: placed.pendingReaderPayment.paymentIntentId, workerOrder: worker.body.data.orderId, workerIntent: worker.body.data.pendingReaderPayment.paymentIntentId }
}

/** Every Stripe call naming the intent, by method. */
const callsOn = (stripe: FakeStripe, intent: string) => stripe.calls.filter((call) => JSON.stringify(call).includes(intent)).map((call) => call.method)

describe("Resolve now is the Worker's reconcile alone (W12-3, W13-3; W25: the old sweep is gone)", () => {
  it("a reader order: reconcileOrders settles the Worker's; an order with no mark of the Worker's is left untouched, by everything", async () => {
    await onASeed(async (old, stripe) => {
      const { oldOrder, oldIntent, workerOrder, workerIntent } = await oneOfEach(old, stripe)
      const before = callsOn(stripe, oldIntent).length

      const key = crypto.randomUUID()
      const reconciled = (await old.call('reconcileOrders', { idempotencyKey: key })) as { ok: boolean; run: Record<string, unknown> }
      expect(reconciled).toMatchObject({ ok: true, run: { checked: 1, undone: 1 } })
      // W25: nothing is counted as "the old code's" any more: these are all the run's fields.
      expect(Object.keys(reconciled.run).sort()).toEqual(['checked', 'deferred', 'finalised', 'items', 'left', 'refunds', 'stripeRefused', 'undone'])
      expect(await status(workerOrder)).toBe('gone')
      expect((await stripe.paymentIntents.retrieve(workerIntent)).status).toBe('canceled')
      // The same key again: the stored answer, nothing run twice.
      expect(await old.call('reconcileOrders', { idempotencyKey: key })).toEqual(reconciled)
      // The unmarked order: no Stripe call names its intent, and it stays as it was (listed for a person, below).
      expect(callsOn(stripe, oldIntent)).toHaveLength(before)
      expect(await status(oldOrder)).toBe('pending')
    })
  })

  it("a reader flow: reconcileOrders settles the Worker's; a flow with no mark of the Worker's is left untouched", async () => {
    for (const worker of [true, false]) {
      await onASeed(async (old, stripe) => {
        const bookingId = await lapsedSeat((action, params) => old.call(action, params), db)
        const started = (await old.call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })) as { pendingReaderPayment: { pendingId: string } }
        const pendingId = started.pendingReaderPayment.pendingId
        if (worker) await asWorkerFlow(db, pendingId)
        replayStripe.current = stripe
        later(16)
        const calls = stripe.calls.length
        const reconciled = (await old.call('reconcileOrders', {})) as { run: { checked: number; undone: number } }
        expect(reconciled.run).toMatchObject(worker ? { checked: 1, undone: 1 } : { checked: 0, undone: 0 })
        expect(await flowStatus(pendingId)).toBe(worker ? 'cancelled' : 'pending')
        if (!worker) expect(stripe.calls.length).toBe(calls)
      })
    }
  })

  it("the flow wrappers send every flow to the Worker: one with no mark of the Worker's is refused there, in words that send staff to a manager", async () => {
    await onASeed(async (old, stripe) => {
      const bookingId = await lapsedSeat((action, params) => old.call(action, params), db)
      const started = (await old.call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })) as { pendingReaderPayment: { pendingId: string } }
      const pendingId = started.pendingReaderPayment.pendingId
      replayStripe.current = stripe
      const calls = stripe.calls.length
      const user = { email: 'jo@example.com' }
      const { default: finalise } = await backendFunction('finaliseReaderPayment')
      const { default: cancel } = await backendFunction('cancelReaderPayment')
      const finalised = (await finalise({ params: { pendingId }, user })) as { finalised: boolean; reason?: string; message?: string }
      const cancelled = (await cancel({ params: { pendingId }, user })) as { cancelled: boolean; reason?: string; message?: string }
      expect(finalised).toMatchObject({ finalised: false, reason: 'not_a_reader_flow' })
      expect(cancelled).toMatchObject({ cancelled: false, reason: 'not_a_reader_flow' })
      expect(finalised.message).toMatch(/tell a manager/)
      expect(finalised.message).not.toMatch(/old booking screens|Resolve now/)
      // Nothing was asked of Stripe and nothing changed.
      expect(stripe.calls.length).toBe(calls)
      expect(await flowStatus(pendingId)).toBe('pending')
    })
  })
})

describe("one stuck list, the Worker's (W12-5; W25: the staff app's own two queries are gone)", () => {
  it("the Worker's order with its reason and words; an order with no mark of the Worker's with words to tell a manager; nothing twice", async () => {
    await onASeed(async (old, stripe) => {
      const { oldOrder, workerOrder } = await oneOfEach(old, stripe)
      const listed = (await old.call('getStuckReaderPayments', { olderThanMinutes: 15 })) as { checkout: Array<Record<string, unknown> & { orderId: string; reason: string; words: string }>; workerProblem?: string }
      expect(listed.workerProblem).toBeUndefined()
      expect(listed.checkout.map((item) => item.orderId).sort()).toEqual([oldOrder, workerOrder].sort())
      expect(listed.checkout).toContainEqual(expect.objectContaining({ orderId: workerOrder, reason: 'waiting', words: STUCK_WORDS['waiting'] }))
      expect(listed.checkout).toContainEqual(expect.objectContaining({ orderId: oldOrder, reason: 'not_started_here', words: STUCK_WORDS['not_started_here'] }))
      expect(STUCK_WORDS['not_started_here']).toMatch(/tell a manager/)
      expect(listed.checkout.every((item) => !('madeBy' in item))).toBe(true)
      // After Resolve now, only the unmarked order is left, once.
      await old.call('reconcileOrders', {})
      const after = (await old.call('getStuckReaderPayments', { olderThanMinutes: 15 })) as typeof listed
      expect(after.checkout.map((item) => item.orderId)).toEqual([oldOrder])
    })
  })

  it("flows: a Worker flow once, waiting; a flow with no mark of the Worker's once, with words to tell a manager", async () => {
    for (const worker of [true, false]) {
      await onASeed(async (old, stripe) => {
        const bookingId = await lapsedSeat((action, params) => old.call(action, params), db)
        const started = (await old.call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })) as { pendingReaderPayment: { pendingId: string } }
        if (worker) await asWorkerFlow(db, started.pendingReaderPayment.pendingId)
        replayStripe.current = stripe
        later(16)
        const listed = (await old.call('getStuckReaderPayments', {})) as { flows: Array<Record<string, unknown> & { pendingId: string }> }
        expect(listed.flows).toEqual([
          expect.objectContaining(
            worker
              ? { pendingId: started.pendingReaderPayment.pendingId, reason: 'waiting' }
              : { pendingId: started.pendingReaderPayment.pendingId, reason: 'not_started_here', words: STUCK_WORDS['not_started_here'] }
          ),
        ])
        expect(listed.flows.every((item) => !('madeBy' in item))).toBe(true)
      })
    }
  })

  it("the Worker can't be reached: nothing is listed, with words saying so (no query of the staff app's own stands in)", async () => {
    await onASeed(async (old, stripe) => {
      await oneOfEach(old, stripe)
      const { STUCK_LIST_UNREACHABLE } = await backendFunction('getStuckReaderPayments')
      vi.stubGlobal('paddockWorkerV1', {
        rawRequest: async () => {
          throw new Error('connect ECONNREFUSED')
        },
      })
      const listed = (await old.call('getStuckReaderPayments', {})) as { checkout: unknown[]; flows: unknown[]; workerProblem?: string }
      expect(listed.checkout).toEqual([])
      expect(listed.flows).toEqual([])
      expect(listed.workerProblem).toBe(STUCK_LIST_UNREACHABLE)
    })
  })
})

describe('the wrappers when the Worker gives no answer, or refuses', () => {
  it('reconcileOrders: no answer keeps the key (the run may have happened); CONFLICT says a run is still going', async () => {
    await onASeed(async (old) => {
      const { RECONCILE_NO_ANSWER_MESSAGE, RECONCILE_STILL_RUNNING_MESSAGE } = await backendFunction('reconcileOrders')
      const { keyAfterAnswer } = await import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/orderAnswers'))
      vi.stubGlobal('paddockWorkerV1', {
        rawRequest: async () => {
          throw new Error('socket hang up')
        },
      })
      const noAnswer = (await old.call('reconcileOrders', { idempotencyKey: 'k1' })) as { ok: false; workerCode: string; message: string }
      expect(noAnswer).toEqual({ ok: false, workerCode: 'WORKER_UNREACHABLE', message: RECONCILE_NO_ANSWER_MESSAGE })
      expect(keyAfterAnswer({ success: false, workerCode: noAnswer.workerCode })).toBe('keep')
      vi.stubGlobal('paddockWorkerV1', { rawRequest: async () => ({ data: { ok: false, error: { code: 'CONFLICT', message: 'Still running.' }, requestId: 'r' } }) })
      expect(await old.call('reconcileOrders', { idempotencyKey: 'k1' })).toEqual({ ok: false, workerCode: 'CONFLICT', message: RECONCILE_STILL_RUNNING_MESSAGE })
      expect(keyAfterAnswer({ success: true })).toBe('new')
    })
  })

  it("closeStuckOrder: the Worker's refusals as data (no Issue refunds: FORBIDDEN, a new key next time); no answer keeps the key", async () => {
    await onASeed(async (old) => {
      const { CLOSE_NO_ANSWER_MESSAGE } = await backendFunction('closeStuckOrder')
      const { keyAfterAnswer } = await import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/orderAnswers'))
      const orderId = crypto.randomUUID()
      // Through the real route: an order that doesn't exist is refused as data, nothing changed.
      expect(await old.call('closeStuckOrder', { kind: 'held_order', orderId, reason: 'Nothing to close here.' })).toMatchObject({ closed: false, kind: 'held_order', orderId, reason: 'gone' })
      // No Issue refunds: the route's FORBIDDEN, in the close's shape.
      await db.query('UPDATE staff SET can_issue_refunds = false WHERE id = $1', [ID.staff])
      const forbidden = (await old.call('closeStuckOrder', { kind: 'held_order', orderId, reason: 'Nothing to close here.' })) as { closed: boolean; workerCode: string }
      expect(forbidden).toMatchObject({ closed: false, reason: 'forbidden', workerCode: 'FORBIDDEN' })
      expect(keyAfterAnswer({ success: forbidden.closed, workerCode: forbidden.workerCode })).toBe('new')
      vi.stubGlobal('paddockWorkerV1', {
        rawRequest: async () => {
          throw new Error('socket hang up')
        },
      })
      const lost = (await old.call('closeStuckOrder', { kind: 'held_order', orderId, reason: 'Nothing to close here.' })) as { closed: boolean; workerCode: string; message: string }
      expect(lost).toMatchObject({ closed: false, reason: 'no_answer', message: CLOSE_NO_ANSWER_MESSAGE, workerCode: 'WORKER_UNREACHABLE' })
      expect(keyAfterAnswer({ success: lost.closed, workerCode: lost.workerCode })).toBe('keep')
    })
  })

  it('W14c (W14b N1): a refused late refund is listed with Mark refunded; closeStuckOrder passes its payment and the Worker records it refunded by hand', async () => {
    await onASeed(async (old, stripe) => {
      // A Worker saved-card order, undone, whose charge then lands; Stripe refuses its automatic refund.
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      await postOrder(await withQuotedCardFigure(orderInput({ customerId: ID.customer, products: [soaps], payment: { method: 'card' } })))
      const orderId = (await db.query<{ id: string }>("SELECT id FROM orders WHERE payment_status = 'pending'"))[0]?.id as string
      const paymentIntentId = [...stripe.chargedByIntent.keys()][0] as string
      await undoOrder(db, orderId, { actor: { type: 'system', id: null }, requestId: 't', why: 'test' })
      later(1)
      const paymentIntent = (await stripe.paymentIntents.retrieve(paymentIntentId)) as Stripe.PaymentIntent
      await finaliseOrder(db, orderId, paymentIntent, { actor: { type: 'system', id: null }, requestId: 't' })
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.invalid('charge_disputed', 'This charge is disputed.') })
      await reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: 't', ...SCHEDULED_LIMITS })

      const listed = (await old.call('getStuckReaderPayments', { olderThanMinutes: 15 })) as { refunds: Array<Record<string, unknown>> }
      const close = { kind: 'late_refund', orderId, paymentIntentId }
      expect(listed.refunds).toEqual([expect.objectContaining({ id: orderId, state: 'failed', words: REFUND_FAILED_WORDS(24, paymentIntentId), close })])
      const reason = 'Refunded in the Stripe dashboard.'
      // Without the payment the Worker refuses the input, as data.
      expect(await old.call('closeStuckOrder', { kind: 'late_refund', orderId, reason })).toMatchObject({ closed: false, workerCode: 'VALIDATION' })
      expect(await old.call('closeStuckOrder', { ...close, reason })).toMatchObject({ closed: true, kind: 'late_refund', orderId })
      expect(((await old.call('getStuckReaderPayments', { olderThanMinutes: 15 })) as { refunds: unknown[] }).refunds).toEqual([])
    })
  })
})

describe("the banner's words (frontend/utils/stuckList.ts)", () => {
  it('counts everything listed for a person, and the oldest held payment', async () => {
    const { stuckCount, oldestAgeMinutes } = await stuckHelpers()
    const empty = { checkout: [], flows: [], refunds: [], warnings: [], alert: null }
    expect(stuckCount(empty)).toBe(0)
    expect(stuckCount(undefined)).toBe(0)
    const listed = { ...empty, checkout: [{ ageMinutes: 20 }], flows: [{ ageMinutes: 40 }], refunds: [{}], warnings: [{}], alert: { at: 'now', words: 'x' } }
    expect(stuckCount(listed)).toBe(5)
    expect(oldestAgeMinutes(listed)).toBe(40)
    // W21: a held refund claim counts too, and its age.
    const withClaim = { ...listed, claims: [{ ageMinutes: 55 }] }
    expect(stuckCount(withClaim)).toBe(6)
    expect(oldestAgeMinutes(withClaim)).toBe(55)
  })

  it("says what each run did, and a close's button and what it does", async () => {
    const helpers = await stuckHelpers()
    const { reconcileLine, closeButtonLabel, closeDialogText } = helpers
    // W25: the old sweep's line went with the sweep: these are all the helpers.
    expect(Object.keys(helpers).sort()).toEqual(['closeButtonLabel', 'closeDialogText', 'flowLabel', 'oldestAgeMinutes', 'reconcileLine', 'stuckCount'])
    const run = (fields: Record<string, unknown>) => ({ ok: true, run: { checked: 0, finalised: 0, undone: 0, refunds: 0, left: 0, deferred: 0, stripeRefused: false, ...fields } })
    expect(reconcileLine(run({}))).toBe('The automatic check found nothing to settle.')
    expect(reconcileLine(run({ checked: 3, finalised: 1, undone: 1, left: 1, deferred: 2 }))).toBe(
      'The automatic check looked at 3 payments: 1 finished, 1 cancelled, 1 left for a person. 2 more payments wait for the next check (every 5 minutes).'
    )
    expect(reconcileLine(run({ stripeRefused: true }))).toContain('Tell a manager straight away')
    expect(reconcileLine({ ok: false, workerCode: 'WORKER_UNREACHABLE', message: 'No answer.' })).toBe('No answer.')
    expect(closeButtonLabel('held_order')).toBe('Close order')
    expect(closeButtonLabel('changed_elsewhere')).toBe('Mark sorted')
    expect(closeButtonLabel('subscription_left')).toBe('Mark sorted')
    expect(closeButtonLabel('late_refund')).toBe('Mark refunded')
    expect(closeDialogText('late_refund')).toContain('Only do this once you have refunded it in Stripe')
    expect(closeDialogText('held_order')).toContain('The booking is left exactly as it is now')
    expect(closeDialogText('subscription_left')).toContain('Nothing is cancelled or refunded here')
    // W21: a held change is undone; a held refund closed, its card money owed on the booking.
    expect(closeButtonLabel('held_flow')).toBe('Undo change')
    expect(closeButtonLabel('held_claim')).toBe('Close refund')
    expect(closeDialogText('held_flow')).toContain('refund it in Stripe by hand')
    expect(closeDialogText('held_claim')).toContain('use It already arrived on the booking; if not, use Refund the rest')
    // W25 (W21 review L4, L5; W23 review later 1): what the close now does, in its words.
    expect(closeDialogText('held_claim')).toContain('Card refunds the automatic check found in Stripe are recorded as refunded')
    expect(closeDialogText('held_claim')).toContain('on a cancelled booking that goes to store credit')
    expect(closeDialogText('held_flow')).toContain('A payment still processing at the bank is watched and refunded automatically if it goes through')
  })

  it("W21: getStuckReaderPayments passes the Worker's held refund claims and a flow's close through", async () => {
    const fn = (await backendFunction('getStuckReaderPayments')).default as (req: { params: object; user: { email: string } }) => Promise<Record<string, unknown>>
    const claim = { claimId: 'c', bookingId: 'b', customerName: 'Sam Test', amount: 20, createdAt: 'x', ageMinutes: 20, reason: 'other_mode', words: 'w', close: { kind: 'held_claim', orderId: 'c' } }
    const flow = { pendingId: 'p', flow: 'settle', recordId: 'b', customerName: 'Sam Test', amount: 20, createdAt: 'x', ageMinutes: 30, reason: 'several_payments', words: 'w', close: { kind: 'held_flow', orderId: 'p' } }
    // W25: the list is the Worker's alone: the staff app's own queries are gone.
    const query = vi.fn().mockResolvedValue({ data: [] })
    vi.stubGlobal('paddockData', { query })
    vi.stubGlobal('paddockWorkerV1', {
      rawRequest: vi.fn().mockResolvedValue({ data: { ok: true, data: { checkout: [], flows: [flow], claims: [claim], refunds: [], warnings: [], alert: null }, requestId: 'r' } }),
    })
    try {
      const listed = await fn({ params: {}, user: { email: 'jo@example.com' } })
      expect(listed['claims']).toEqual([claim])
      expect(listed['flows']).toEqual([flow])
      expect(query).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
