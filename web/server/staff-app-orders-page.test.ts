import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { asTheOldCheckoutStartedIt, asTheOldCodeStartedIt } from '@/server/rules/testing/sweep/old-states'
import { replay, startReplay, type ReplayEnvironment, type ReplaySide } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { orderInput, postOrder, withQuotedCardFigure } from '@/server/rules/testing/sweep/order-presses'
import { ID, lapsedSeat, seed } from '@/server/rules/testing/replay/scenarios'
import { withSwitch } from '@/server/rules/testing/sweep/booking-presses'
import { ORDER_REFUND_KINDS_ON } from '@/server/rules/testing/sweep/order-refund-presses'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import type Stripe from 'stripe'
import { fakeStripeErrors } from '@/server/stripe/fake'
import { finaliseOrder } from '@/server/rules/orders/finalise-order'
import { reconcile, SCHEDULED_LIMITS } from '@/server/rules/orders/reconcile'
import { REFUND_FAILED_WORDS, STUCK_WORDS } from '@/server/rules/orders/stuck-list'
import { undoOrder } from '@/server/rules/orders/undo-order'
import { GET as ordersListRoute } from '@/app/api/v1/staff/orders/route'

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
      const side = workerSide()(seedDb, stripe)
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
 * W16: no old checkout order can be made live any more (none was left, checked 11 Nov); the old one shows nothing
 * settles it twice and the old sweep no longer touches orders at all. W64: it is placed through the Worker and its
 * mark taken off (an SQL fixture, sweep/old-states.ts), the state the old checkout left (that code went at W65).
 */
async function oneOfEach(old: ReplaySide, stripe: FakeStripe): Promise<{ oldOrder: string; oldIntent: string; workerOrder: string; workerIntent: string }> {
  const placed = (await old.call('createOrder', { customerId: ID.customer, products: [soaps], payment: { method: 'reader' } })) as { orderId: string; pendingReaderPayment: { paymentIntentId: string } }
  await asTheOldCheckoutStartedIt(db, placed.orderId)
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
      // W32a: and how many watched refunds are still on their way at Stripe.
      // W47, a named difference: and how many payments are still watched (`paymentsWatched`), never counted as left.
      expect(Object.keys(reconciled.run).sort()).toEqual(['checked', 'deferred', 'finalised', 'items', 'left', 'paymentsWatched', 'refunds', 'refundsWaiting', 'stripeRefused', 'undone'])
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
        // W64: the flow is the Worker's from its start; the other one has the mark taken off (sweep/old-states.ts).
        if (!worker) await asTheOldCodeStartedIt(db, pendingId)
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
      // W64: a flow as the old code started it (sweep/old-states.ts).
      await asTheOldCodeStartedIt(db, pendingId)
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
      expect(listed.checkout).toContainEqual(expect.objectContaining({ orderId: oldOrder, reason: 'unexpected_state', words: STUCK_WORDS['unexpected_state'] }))
      expect(STUCK_WORDS['unexpected_state']).toMatch(/tell a manager/)
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
        if (!worker) await asTheOldCodeStartedIt(db, started.pendingReaderPayment.pendingId)
        replayStripe.current = stripe
        later(16)
        const listed = (await old.call('getStuckReaderPayments', {})) as { flows: Array<Record<string, unknown> & { pendingId: string }> }
        expect(listed.flows).toEqual([
          expect.objectContaining(
            worker
              ? { pendingId: started.pendingReaderPayment.pendingId, reason: 'waiting' }
              : { pendingId: started.pendingReaderPayment.pendingId, reason: 'unexpected_state', words: STUCK_WORDS['unexpected_state'] }
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
    // W47 item 3, a named difference: the key alert is a line of its own and no longer counted as a "card payment"
    // (it made this 5, and each figure below one more).
    expect(stuckCount(listed)).toBe(4)
    expect(oldestAgeMinutes(listed)).toBe(40)
    // W21: a held refund claim counts too, and its age.
    const withClaim = { ...listed, claims: [{ ageMinutes: 55 }] }
    expect(stuckCount(withClaim)).toBe(5)
    expect(oldestAgeMinutes(withClaim)).toBe(55)
    // W32: a refund that failed after Stripe accepted it (or whose watch ran out) counts too; a list from a Worker
    // before W32 has no `watched`, and counts as before.
    expect(stuckCount({ ...withClaim, watched: [{}, {}] })).toBe(7)
    expect(stuckCount({ ...empty, watched: [{}] })).toBe(1)
  })

  it('W32: a failed or timed-out refund has its own heading, Mark sorted, and words for the dialog', async () => {
    const { closeButtonLabel, closeDialogText, watchedLabel } = await stuckHelpers()
    expect(closeButtonLabel('refund_watch')).toBe('Mark sorted')
    expect(closeDialogText('refund_watch')).toBe(
      'Marks this refund as sorted, so it is no longer listed. Only do this once it is dealt with: the money given back with Refund the rest (or It already arrived) where it shows as still to refund, or by hand where the line says so. Nothing is refunded or changed here.'
    )
    expect(watchedLabel({ on: 'booking', state: 'failed', customerName: 'Sam Test' })).toBe('Booking refund failed · Sam Test')
    expect(watchedLabel({ on: 'order', state: 'failed', customerName: 'Sam Test' })).toBe('Order refund failed · Sam Test')
    expect(watchedLabel({ on: 'event_booking', state: 'expired', customerName: 'Sam Test' })).toBe('Event refund not confirmed · Sam Test')
    // A compensation's order was undone, so there is no customer to name.
    expect(watchedLabel({ on: 'compensation', state: 'failed', customerName: null })).toBe('Automatic refund failed')
  })

  it("says what each run did, and a close's button and what it does", async () => {
    const helpers = await stuckHelpers()
    const { reconcileLine, closeButtonLabel, closeDialogText } = helpers
    // W25: the old sweep's line went with the sweep: these are all the helpers. W40: `stepLabel`, a membership step's heading.
    // W41: `paymentDateLabel`, a held payment date change's heading.
    // W47, named differences: the count by kind and the first line's words (`stuckCounts`, `stuckHeadline`,
    // `stuckAnythingToShow`), the two quiet lines, and a watched payment's heading.
    // W47r, a named difference: `paymentRetryLabel`, the heading of a membership payment tried again from the desk and on hold.
    // W57, a named difference: `planLineLabel`, the heading of a membership plan's own line (a price change or a new
    // plan still being finished in Stripe, a plan's product or old price not confirmed).
    expect(Object.keys(helpers).sort()).toEqual([
      'NOTHING_STUCK_LINE',
      'STUCK_LIST_NOT_READ_LINE',
      'closeButtonLabel',
      'closeDialogText',
      'closeReasonHint',
      'flowLabel',
      'oldestAgeMinutes',
      'paymentDateLabel',
      'paymentRetryLabel',
      'planLineLabel',
      'reconcileLine',
      'stepLabel',
      'stuckAnythingToShow',
      'stuckCount',
      'stuckCounts',
      'stuckHeadline',
      'watchedLabel',
      'watchedPaymentLabel',
    ])
    // W41: a payment date change on hold: the date asked for, whose, and whether it needs a person; counted with the rest; its close.
    const { paymentDateLabel } = helpers
    const date = (isoDate: string) => `[${isoDate}]`
    expect(paymentDateLabel({ customerName: 'Mo Member', newRenewalDate: '2026-12-27' }, date)).toBe('Payment date change to [2026-12-27] on hold · Mo Member')
    expect(paymentDateLabel({ customerName: '', newRenewalDate: '2026-12-27', close: { kind: 'held_payment_date', orderId: 'c1' } }, date)).toBe('Payment date change to [2026-12-27] needs a person')
    expect(closeButtonLabel('held_payment_date')).toBe('Close')
    expect(closeDialogText('held_payment_date')).toContain('Nothing is charged, refunded or changed in Stripe here.')
    expect(helpers.stuckCount({ checkout: [], flows: [], claims: [], refunds: [], warnings: [], watched: [], steps: [], paymentDates: [{}, {}], alert: null } as never)).toBe(2)
    // W40: a membership's Stripe step left to do: what it is, whose, and whether Stripe refused it; counted with the rest.
    const { stepLabel, stuckCount } = helpers
    const day = (isoDate: string) => `[${isoDate}]`
    expect(stepLabel({ what: 'cancel_date', lastDay: '2026-12-09', state: 'left', customerName: 'Mo Member' }, day)).toBe('Membership cancellation (last day [2026-12-09]) not confirmed by Stripe yet · Mo Member')
    expect(stepLabel({ what: 'clear_cancel_date', state: 'refused', customerName: null }, day)).toBe('Membership cancellation undone refused by Stripe')
    expect(stepLabel({ what: 'card', state: 'left', customerName: 'Mo Member' }, day)).toBe('Membership card change not confirmed by Stripe yet · Mo Member')
    const empty = { checkout: [], flows: [], claims: [], refunds: [], warnings: [], watched: [], alert: null }
    expect(stuckCount(empty)).toBe(0)
    expect(stuckCount({ ...empty, steps: [{ stepId: 's' }, { stepId: 't' }] })).toBe(2)
    expect(closeButtonLabel('left_step')).toBe('Mark sorted')
    expect(closeDialogText('left_step')).toContain('Nothing is changed in Stripe or on the membership here.')
    // W58b (the lead's item 2, W57 cleanup): Mark sorted says what must be true in Stripe first, by the step's kind.
    const sortedFirst = (what: string) => {
      const text = closeDialogText('left_step', what)
      return text.slice(text.indexOf('membership here: ') + 'membership here: '.length, text.indexOf('. Nothing is changed'))
    }
    expect(['cancel_date', 'clear_cancel_date', 'card', 'plan_price'].map(sortedFirst)).toEqual([
      "the subscription's cancel date set to the membership's last day, by hand",
      "the subscription's cancel date cleared, by hand",
      "the subscription's payment method changed to the customer's new card, by hand",
      "the subscription moved to the plan's new price (with no proration), by hand",
    ])
    expect(closeDialogText('left_step')).toContain('its cancel date set or cleared, or its card changed, by hand')
    // W58b (the W35 audit's row 31): the held claim's close says a later-failed card refund waits on it.
    expect(closeDialogText('held_claim')).toContain('that failed later waits while this is open')
    // W58b (the W35 audit's row 27): a hint per close kind; the old one only where it fits.
    const { closeReasonHint } = helpers
    const kinds = ['held_order', 'changed_elsewhere', 'subscription_left', 'late_refund', 'held_flow', 'held_claim', 'refund_watch', 'left_step', 'held_payment_date', 'payment_watch', 'retry_paid_after_end', 'paid_after_end_owed', 'plan_step', 'frequency_mismatch', 'sanity_delete']
    // W66a (Wayne's Q62): a membership whose subscription renews at another interval in Stripe: its own heading, Mark
    // sorted with its own words, counted with the membership changes.
    expect(stepLabel({ what: 'frequency_mismatch', state: 'refused', customerName: 'Mo Member' }, day)).toBe('Membership renews at a different interval in Stripe · Mo Member')
    expect(stepLabel({ what: 'frequency_mismatch', state: 'refused', customerName: null }, day)).toBe('Membership renews at a different interval in Stripe')
    expect(closeButtonLabel('frequency_mismatch')).toBe('Mark sorted')
    expect(closeDialogText('frequency_mismatch', 'frequency_mismatch')).toContain('Only do this once you have checked the subscription in Stripe and it renews as the membership here says')
    expect(closeDialogText('frequency_mismatch')).toContain('Nothing is changed in Stripe or on the membership here.')
    expect(stuckCount({ ...empty, steps: [{ stepId: 's', what: 'frequency_mismatch' }] })).toBe(1)
    for (const kind of kinds) expect(closeReasonHint(kind), kind).toMatch(/^For example: /)
    // W70a (W68a noticed 1): no hint and no close dialog names the old screens, and the two kinds that did still have a
    // hint of their own.
    expect(kinds.filter((kind) => closeReasonHint(kind).includes('old screens') || closeDialogText(kind).includes('old screens'))).toEqual([])
    expect([closeReasonHint('held_order'), closeReasonHint('changed_elsewhere')]).toEqual(Array(2).fill("For example: booking cancelled another way, customer didn't pay"))
    expect(closeDialogText('held_order')).toContain('if it was cancelled or changed another way, its places and pass session were dealt with then.')
    // W70a (the W70 audit's L2): a plan deleted in Sanity that a price change kept on sale: its own heading, Mark sorted
    // with its own words, counted with the membership changes.
    const { planLineLabel } = helpers
    expect(planLineLabel({ what: 'sanity_delete', state: 'refused', planName: 'All Access' })).toBe('Plan "All Access" deleted in Sanity, still on sale here')
    expect(planLineLabel({ what: 'sanity_delete', state: 'refused', planName: null })).toBe('A plan deleted in Sanity, still on sale here')
    expect(closeButtonLabel('sanity_delete')).toBe('Mark sorted')
    expect(closeDialogText('sanity_delete')).toBe(
      'Marks this line as sorted, so it is no longer listed. Only do this if the plan should stay on sale here, or it has been published again in Sanity. To take it off sale, use its switch on the Membership Plans page instead: the line then goes by itself. Nothing is changed on the plan, in Sanity or in Stripe here.'
    )
    expect(closeReasonHint('sanity_delete')).toBe('For example: deleted by mistake, published again in Sanity')
    expect(stuckCount({ ...empty, plans: [{ lineId: 'l', what: 'sanity_delete' }] })).toBe(1)
    expect(closeReasonHint('paid_after_end_owed')).toBe('For example: it paid for December, which the member had')
    const run = (fields: Record<string, unknown>) => ({ ok: true, run: { checked: 0, finalised: 0, undone: 0, refunds: 0, left: 0, deferred: 0, stripeRefused: false, ...fields } })
    expect(reconcileLine(run({}))).toBe('The automatic check found nothing to settle.')
    expect(reconcileLine(run({ checked: 3, finalised: 1, undone: 1, left: 1, deferred: 2 }))).toBe(
      'The automatic check looked at 3 payments: 1 finished, 1 cancelled, 1 left for a person. 2 more payments wait for the next check (every 5 minutes).'
    )
    expect(reconcileLine(run({ stripeRefused: true }))).toContain('Tell a manager straight away')
    // W32a (W32 review S2): refunds still on their way at Stripe are said on their own, never as "left for a person";
    // a Worker from before W32a sends no such figure, and the line reads as it did.
    expect(reconcileLine(run({ refundsWaiting: 2 }))).toBe('The automatic check found nothing to settle. 2 refunds waiting on Stripe: nothing to do.')
    expect(reconcileLine(run({ checked: 2, finalised: 1, refunds: 1, left: 1, refundsWaiting: 1 }))).toBe(
      'The automatic check looked at 2 payments: 1 finished, 0 cancelled, 1 refund sent or checked, 1 left for a person, 1 refund waiting on Stripe.'
    )
    expect(reconcileLine(run({ checked: 1, finalised: 1, refundsWaiting: 0 }))).toBe('The automatic check looked at 1 payment: 1 finished, 0 cancelled.')
    expect(reconcileLine(run({ checked: 1, finalised: 1 }))).toBe('The automatic check looked at 1 payment: 1 finished, 0 cancelled.')
    expect(reconcileLine({ ok: false, workerCode: 'WORKER_UNREACHABLE', message: 'No answer.' })).toBe('No answer.')
    // W53 (W47r review L3; W47r "Noticed" 5): a membership payment tried again that ended as not taken is counted by
    // the Worker as `undone`. It read "1 cancelled", though nothing was cancelled; it is now said in its own words,
    // and left out of "cancelled". A run with no items (an older Worker) reads as it did.
    const retry = { kind: 'payment_retry', outcome: 'undone' }
    expect(reconcileLine(run({ checked: 1, undone: 1, items: [retry] }))).toBe(
      'The automatic check looked at 1 payment: 0 finished, 0 cancelled, 1 membership payment tried again ended as not taken (nothing was charged).'
    )
    expect(reconcileLine(run({ checked: 3, finalised: 1, undone: 2, items: [retry, { kind: 'flow', outcome: 'undone' }, { kind: 'order', outcome: 'finalised' }] }))).toBe(
      'The automatic check looked at 3 payments: 1 finished, 1 cancelled, 1 membership payment tried again ended as not taken (nothing was charged).'
    )
    expect(reconcileLine(run({ checked: 2, undone: 2, items: [retry, retry] }))).toContain('0 cancelled, 2 membership payments tried again ended as not taken (nothing was charged)')
    // A retry that finished (paid), or was left, is not one of these.
    expect(reconcileLine(run({ checked: 1, finalised: 1, items: [{ kind: 'payment_retry', outcome: 'finalised' }] }))).toBe('The automatic check looked at 1 payment: 1 finished, 0 cancelled.')
    expect(reconcileLine(run({ checked: 1, undone: 1 }))).toBe('The automatic check looked at 1 payment: 0 finished, 1 cancelled.')
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
      // W32: that answer is a Worker's from before W32 (no `watched`): none are listed, and nothing breaks.
      expect(listed['watched']).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("W32: getStuckReaderPayments passes the Worker's failed and timed-out refunds through, each with its words and Mark sorted", async () => {
    const fn = (await backendFunction('getStuckReaderPayments')).default as (req: { params: object; user: { email: string } }) => Promise<Record<string, unknown>>
    const watched = {
      watchId: 'w',
      refundId: 're_1',
      paymentIntentId: 'pi_1',
      on: 'booking',
      bookingId: 'b',
      orderId: null,
      eventBookingId: null,
      eventId: null,
      customerName: 'Sam Test',
      amount: 20,
      owed: 20,
      state: 'failed',
      at: 'x',
      words: 'w',
      close: { kind: 'refund_watch', orderId: 'w' },
    }
    vi.stubGlobal('paddockData', { query: vi.fn().mockResolvedValue({ data: [] }) })
    vi.stubGlobal('paddockWorkerV1', {
      rawRequest: vi.fn().mockResolvedValue({ data: { ok: true, data: { checkout: [], flows: [], claims: [], refunds: [], warnings: [], watched: [watched], alert: null }, requestId: 'r' } }),
    })
    try {
      const listed = await fn({ params: {}, user: { email: 'jo@example.com' } })
      expect(listed['watched']).toEqual([watched])
      const { stuckCount } = await stuckHelpers()
      expect(stuckCount(listed)).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// Brief W47: the staff app's side of items 1 to 4, 6 and 7, from its checkout: the new wrapper against the real
// route, the Orders read, and the pure helpers the Orders page and Overview show (frontend/utils).
const moneyOwedHelpers = () => import(/* @vite-ignore */ path.join(appDir, 'frontend/utils/moneyOwed'))

describe('W47: money still to refund, Resolve now with nothing listed, the banner by kind', () => {
  type Owed = { owed: Array<Record<string, unknown>>; total: number; lapsedKept: unknown[]; keptDays: number; keptNote: string; workerProblem?: string }
  type Listed = Array<{ id: string; computed_status: string; refund_owed_amount: string }>
  /**
   * W59 (W53 "For later" 7): the Orders read the staff app makes now, the Worker's own (`GET /api/v1/staff/orders`,
   * which the thin getOrders calls), not the old function (gone at W65).
   */
  const workerOrders = async (view?: string): Promise<Listed> => {
    const response = await ordersListRoute(
      new Request(`https://worker.test/api/v1/staff/orders${view ? `?view=${view}` : ''}`, {
        headers: { authorization: `Bearer ${process.env.STAFF_API_KEY ?? ''}`, 'x-staff-email': 'jo@example.com' },
      }),
      { params: Promise.resolve({}) }
    )
    const body = (await response.json()) as { ok: boolean; data?: Listed }
    if (!body.ok || !body.data) throw new Error(`The Orders read failed: ${JSON.stringify(body)}`)
    return body.data
  }

  it('nothing owed and nothing stuck: the list is empty, the banner has nothing to show, and Resolve now still runs and says so', async () => {
    await onASeed(async (old) => {
      const owed = (await old.call('getMoneyOwed', {})) as Owed
      expect(owed).toEqual({ owed: [], total: 0, lapsedKept: [], keptDays: 90, keptNote: expect.stringContaining('use Adjust store credit on the customer') })
      const { moneyOwedCount, moneyOwedHeadline } = await moneyOwedHelpers()
      expect(moneyOwedCount(owed)).toBe(0)
      expect(moneyOwedHeadline(owed)).toBe('No money is still to refund.')

      const listed = await old.call('getStuckReaderPayments', { olderThanMinutes: 15 })
      const { stuckAnythingToShow, stuckCount, reconcileLine, NOTHING_STUCK_LINE } = await stuckHelpers()
      expect(stuckCount(listed)).toBe(0)
      // The banner stays quiet: only the line beside the button.
      expect(stuckAnythingToShow(listed)).toBe(false)
      // W47a (W47 review L8): the headline's own words, so it can't read as "nothing to refund" above the money-owed section.
      expect(NOTHING_STUCK_LINE).toBe('No card payments or membership changes need attention. The automatic check runs every 5 minutes; Resolve now runs it straight away.')
      // Resolve now is still there to press (the W35 audit's F2), and the run answers.
      const reconciled = (await old.call('reconcileOrders', { idempotencyKey: crypto.randomUUID() })) as { ok: boolean; run: { checked: number; left: number; paymentsWatched: number } }
      expect(reconciled).toMatchObject({ ok: true, run: { checked: 0, left: 0, deferred: 0, paymentsWatched: 0, refundsWaiting: 0 } })
      expect(reconcileLine(reconciled)).toBe('The automatic check found nothing to settle.')
    })
  })

  it('an order with money owed is on the list through the staff app, counts as needing action in the Orders read, and leaves both once Refund the rest has given it', async () => {
    await onASeed(async (old, stripe) => {
      replayStripe.current = stripe
      const placed = await postOrder(await withQuotedCardFigure(orderInput({ customerId: ID.member, products: [soaps], payment: { method: 'cash', confirmedCashAmount: 24 } })))
      if (!placed.body.ok) throw new Error('the order was not placed')
      const orderId = placed.body.data.orderId
      // Collected at the desk: nothing left to fulfil, so nothing else makes it "needs action".
      await db.query("UPDATE order_line_items SET fulfillment_status = 'fulfilled' WHERE order_id = $1", [orderId])
      const needsAction = async () => (await workerOrders()).filter((order) => order.id === orderId)
      expect(await needsAction()).toEqual([])
      expect((await workerOrders('complete')).filter((order) => order.id === orderId)).toMatchObject([{ computed_status: 'complete' }])

      // £10 of card refund money never reached the customer.
      await db.query('UPDATE orders SET refund_owed_amount = 10 WHERE id = $1', [orderId])
      // W47 item 1 (the W35 audit's F1), a named difference: the order is in the default view. Before W47 it was only
      // under All or Complete, where nobody looks for money owed.
      expect(await needsAction()).toMatchObject([{ id: orderId, computed_status: 'needs_action', refund_owed_amount: '10.00' }])
      expect((await workerOrders('complete')).filter((order) => order.id === orderId)).toEqual([])
      const owed = (await old.call('getMoneyOwed', {})) as Owed
      expect(owed.owed).toMatchObject([{ on: 'order', orderId, bookingId: null, customerName: 'Mo Member', amount: 10 }])
      expect(owed.total).toBe(10)
      const { moneyOwedCount, moneyOwedHeadline, moneyOwedWhat, owedForWords, moneyOwedTileLabel } = await moneyOwedHelpers()
      expect(moneyOwedCount(owed)).toBe(1)
      expect(moneyOwedHeadline(owed)).toBe('1 refund still owed to a customer: £10.00 in all.')
      expect(moneyOwedTileLabel(1)).toBe('refund still owed to a customer (money still to refund)')
      expect(moneyOwedTileLabel(2)).toBe('refunds still owed to customers (money still to refund)')
      expect(moneyOwedWhat(owed.owed[0] as never, String)).toBe(`Order ${orderId.slice(0, 8)}`)
      // Nothing records when this test's money became owed (it was set by hand), and the line says so.
      expect(owedForWords(owed.owed[0] as never)).toBe('owed (no date recorded)')

      // Refund the rest from the list (the same bar as on the order), to store credit.
      const given = (await withSwitch(ORDER_REFUND_KINDS_ON, () => old.call('refundOrderOwed', { orderId, amount: 10, refundMethod: 'credit', idempotencyKey: crypto.randomUUID() }))) as Record<string, unknown>
      expect(given).toMatchObject({ storeCreditRefundedAmount: 10, refundOwed: 0 })
      expect(given).not.toHaveProperty('cardRefundRefused')
      expect(((await old.call('getMoneyOwed', {})) as Owed).owed).toEqual([])
      expect(await needsAction()).toEqual([])
    })
  })

  it("getMoneyOwed when the Worker can't be reached: an empty list with words saying so, never a thrown error", async () => {
    await onASeed(async (old) => {
      const { MONEY_OWED_UNREACHABLE } = await backendFunction('getMoneyOwed')
      vi.stubGlobal('paddockWorkerV1', {
        rawRequest: async () => {
          throw new Error('connect ECONNREFUSED')
        },
      })
      try {
        expect(await old.call('getMoneyOwed', {})).toEqual({ owed: [], total: 0, lapsedKept: [], keptDays: 0, keptNote: '', workerProblem: MONEY_OWED_UNREACHABLE })
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  it('the words on the "Money still to refund" section (frontend/utils/moneyOwed.ts)', async () => {
    const { moneyOwedHeadline, moneyOwedWhat, owedForWords, moneyOwedCount } = await moneyOwedHelpers()
    const session = (value: string) => `[${value}]`
    expect(moneyOwedCount(undefined)).toBe(0)
    expect(moneyOwedHeadline(null)).toBe('No money is still to refund.')
    expect(moneyOwedHeadline({ owed: [{}, {}, {}], total: 44.5 })).toBe('3 refunds still owed to customers: £44.50 in all.')
    expect(owedForWords({ daysOwed: 0 })).toBe('owed since today')
    expect(owedForWords({ daysOwed: 1 })).toBe('owed for 1 day')
    expect(owedForWords({ daysOwed: 12 })).toBe('owed for 12 days')
    expect(owedForWords({ daysOwed: null })).toBe('owed (no date recorded)')
    expect(moneyOwedWhat({ on: 'order', orderId: 'abcdef1234567890' }, session)).toBe('Order abcdef12')
    expect(moneyOwedWhat({ on: 'order', orderId: 'abcdef1234567890', eventBookings: [{ eventName: 'Full moon swim' }] }, session)).toBe('Order abcdef12 · event booking: Full moon swim')
    expect(moneyOwedWhat({ on: 'booking', bookingStatus: 'confirmed', lapsed: false, sessionStart: '2026-12-15T10:00:00.000Z' }, session)).toBe('Booking · [2026-12-15T10:00:00.000Z]')
    expect(moneyOwedWhat({ on: 'booking', bookingStatus: 'cancelled', lapsed: false, sessionStart: '2026-12-15T10:00:00.000Z' }, session)).toBe('Cancelled booking · [2026-12-15T10:00:00.000Z]')
    expect(moneyOwedWhat({ on: 'booking', bookingStatus: 'cancelled', lapsed: true }, session)).toBe('Lapsed booking')
  })

  it("W47 item 6 (the W35 audit's F3): Refund the rest's split on screen is the payment the Worker names: all £40 to the membership's own payment, where the order's own card money gave \"£24 to the card, £16 to store credit\"", async () => {
    const { owedCardSplit } = await moneyOwedHelpers()
    // F3's example: £40 owed for the membership, on an order whose own payment (the soap's) has £24 left.
    expect(owedCardSplit({ refundOwed: 40, cardLeft: 24, owedCard: { payment: 'membership', left: 40 } })).toEqual({ card: 40, storeCredit: 0, payment: 'membership', cardLeft: 40 })
    // Its other half: the soap already refunded to its card (£0 left there), and the membership's payment can take it all.
    expect(owedCardSplit({ refundOwed: 40, cardLeft: 0, owedCard: { payment: 'membership', left: 40 } })).toEqual({ card: 40, storeCredit: 0, payment: 'membership', cardLeft: 40 })
    // The order's own payment, and less left than is owed: the rest to store credit.
    expect(owedCardSplit({ refundOwed: 64, cardLeft: 24, owedCard: { payment: 'order', left: 24 } })).toEqual({ card: 24, storeCredit: 40, payment: 'order', cardLeft: 24 })
    expect(owedCardSplit({ refundOwed: 24, cardLeft: 9, owedCard: { payment: 'order', left: 0 } })).toEqual({ card: 0, storeCredit: 24, payment: 'order', cardLeft: 0 })
    // A Worker from before W47 names no payment: the order's own card money, as before.
    expect(owedCardSplit({ refundOwed: 40, cardLeft: 24 })).toEqual({ card: 24, storeCredit: 16, payment: 'order', cardLeft: 24 })
    expect(owedCardSplit({ refundOwed: 10.1, cardLeft: 10.05 })).toEqual({ card: 10.05, storeCredit: 0.05, payment: 'order', cardLeft: 10.05 })
  })

  it('W47 item 8 (Wayne, 19 Nov): the words of the choice It already arrived asks for', async () => {
    const { ARRIVED_ON_WORDS } = await moneyOwedHelpers()
    expect(ARRIVED_ON_WORDS).toEqual({
      question: 'Where did it reach the customer?',
      card: 'On their card (you have seen the refund in Stripe)',
      other: 'Another way (store credit on their balance, cash, a bank transfer)',
      cardNote: 'Recorded as card money given back, so later card refunds know what the card has left.',
      otherNote: 'Only taken off what is owed: nothing is recorded as card money.',
    })
  })

  it('the banner counts by kind: "N card payments and M membership changes need attention" (W40 "Noticed" 1; the W45 audit\'s row 24)', async () => {
    const { stuckCounts, stuckCount, stuckHeadline, stuckAnythingToShow } = await stuckHelpers()
    const empty = { checkout: [], flows: [], claims: [], refunds: [], warnings: [], watched: [], steps: [], paymentDates: [], watchedPayments: [], webhook: null, alert: null }
    expect(stuckCounts(undefined)).toEqual({ payments: 0, memberships: 0, watching: 0 })
    expect(stuckHeadline(empty)).toBe('No card payments or membership changes need attention.')
    expect(stuckAnythingToShow(empty)).toBe(false)
    // Card payments only, and only one.
    expect(stuckHeadline({ ...empty, checkout: [{ ageMinutes: 20 }] })).toBe('1 card payment needs attention (oldest 20 minutes ago). Each one says what to do.')
    expect(stuckHeadline({ ...empty, checkout: [{ ageMinutes: 1 }], refunds: [{}] })).toBe('2 card payments need attention (oldest 1 minute ago). Each one says what to do.')
    // Membership changes only: a Stripe step left to do, a payment date change on hold. Never "card payments".
    expect(stuckHeadline({ ...empty, steps: [{}] })).toBe('1 membership change needs attention. Each one says what to do.')
    expect(stuckHeadline({ ...empty, steps: [{}], paymentDates: [{}] })).toBe('2 membership changes need attention. Each one says what to do.')
    // Both, each counted as what it is.
    const both = { ...empty, checkout: [{ ageMinutes: 20 }], flows: [{ ageMinutes: 40 }], steps: [{}] }
    expect(stuckCounts(both)).toEqual({ payments: 2, memberships: 1, watching: 0 })
    expect(stuckHeadline(both)).toBe('2 card payments and 1 membership change need attention (oldest 40 minutes ago). Each one says what to do.')
    expect(stuckHeadline({ ...both, steps: [{}, {}], flows: [] })).toBe('1 card payment and 2 membership changes need attention (oldest 20 minutes ago). Each one says what to do.')
    expect(stuckCount(both)).toBe(3)
    // A payment still being watched is listed with nothing to do, so it is counted as neither; one whose watch ran out is for a person.
    const watching = { ...empty, watchedPayments: [{ state: 'watching' }] }
    expect(stuckCounts(watching)).toEqual({ payments: 0, memberships: 0, watching: 1 })
    expect(stuckHeadline(watching)).toBe('No card payments or membership changes need attention.')
    expect(stuckAnythingToShow(watching)).toBe(true)
    expect(stuckCounts({ ...empty, watchedPayments: [{ state: 'watching' }, { state: 'expired' }] })).toEqual({ payments: 1, memberships: 0, watching: 1 })
    // The key alert and the line for Stripe's notices show the banner, each as its own line, and are counted in neither.
    expect(stuckAnythingToShow({ ...empty, alert: { at: 'now', words: 'x' } })).toBe(true)
    expect(stuckAnythingToShow({ ...empty, webhook: { count: 1, oldestAt: 'x', words: 'w' } })).toBe(true)
    expect(stuckCounts({ ...empty, alert: { at: 'now', words: 'x' }, webhook: { count: 3, oldestAt: 'x', words: 'w' } })).toEqual({ payments: 0, memberships: 0, watching: 0 })
    // A list from a Worker before W47 has neither new field, and reads as it did.
    expect(stuckCounts({ checkout: [{ ageMinutes: 5 }], flows: [], refunds: [], warnings: [], alert: null })).toEqual({ payments: 1, memberships: 0, watching: 0 })
  })

  it("a watched payment's heading, Mark sorted and its dialog; Resolve now says how many are still watched and never calls one \"left for a person\"", async () => {
    const { watchedPaymentLabel, closeButtonLabel, closeDialogText, reconcileLine } = await stuckHelpers()
    expect(watchedPaymentLabel({ state: 'watching', flow: 'settle', customerName: 'Mo Member' })).toBe('Settle payment still at the bank, being watched · Mo Member')
    expect(watchedPaymentLabel({ state: 'expired', flow: 'move', customerName: 'Mo Member' })).toBe('Move payment not confirmed by Stripe · Mo Member')
    expect(watchedPaymentLabel({ state: 'expired', flow: null, customerName: null })).toBe('Payment not confirmed by Stripe')
    expect(closeButtonLabel('payment_watch')).toBe('Mark sorted')
    // W47b: the press sorts only a payment Stripe still can't find; one it can see goes back to the automatic check.
    expect(closeDialogText('payment_watch')).toBe(
      "Checks the payment in Stripe first. If Stripe can see it now, the automatic check takes it back and refunds it if it took money (a payment you have already refunded there is not refunded again). If Stripe still can't find it, it is marked as sorted and no longer listed: only do this once you have looked at the payment in Stripe and, if it took money, refunded it there by hand. Nothing is refunded by this press."
    )
    const run = (fields: Record<string, unknown>) => ({ ok: true, run: { checked: 0, finalised: 0, undone: 0, refunds: 0, left: 0, deferred: 0, stripeRefused: false, ...fields } })
    expect(reconcileLine(run({ paymentsWatched: 1 }))).toBe('The automatic check found nothing to settle. 1 payment still being watched at the bank: nothing to do.')
    expect(reconcileLine(run({ paymentsWatched: 2, refundsWaiting: 1 }))).toBe('The automatic check found nothing to settle. 1 refund waiting on Stripe, 2 payments still being watched at the bank: nothing to do.')
    expect(reconcileLine(run({ checked: 1, finalised: 1, paymentsWatched: 1 }))).toBe('The automatic check looked at 1 payment: 1 finished, 0 cancelled, 1 payment still being watched at the bank.')
    // A Worker from before W47 sends no such figure, and the line reads as it did.
    expect(reconcileLine(run({ checked: 1, finalised: 1 }))).toBe('The automatic check looked at 1 payment: 1 finished, 0 cancelled.')
  })

  it("getStuckReaderPayments passes the Worker's watched payments and its line for Stripe's notices through; an older Worker's answer has neither", async () => {
    const fn = (await backendFunction('getStuckReaderPayments')).default as (req: { params: object; user: { email: string } }) => Promise<Record<string, unknown>>
    const watchedPayment = { watchId: 'w', pendingId: 'p', paymentIntentId: 'pi_1', flow: 'settle', recordId: 'b', customerName: 'Mo Member', since: 'x', state: 'expired', words: 'w', close: { kind: 'payment_watch', orderId: 'w' } }
    const webhook = { count: 2, oldestAt: '2026-12-10T14:00:00.000Z', words: 'two notices' }
    const answer = (extra: Record<string, unknown>) => ({ data: { ok: true, data: { checkout: [], flows: [], claims: [], refunds: [], warnings: [], watched: [], steps: [], alert: null, ...extra }, requestId: 'r' } })
    vi.stubGlobal('paddockData', { query: vi.fn().mockResolvedValue({ data: [] }) })
    try {
      vi.stubGlobal('paddockWorkerV1', { rawRequest: vi.fn().mockResolvedValue(answer({ watchedPayments: [watchedPayment], webhook })) })
      const listed = await fn({ params: {}, user: { email: 'jo@example.com' } })
      expect(listed['watchedPayments']).toEqual([watchedPayment])
      expect(listed['webhook']).toEqual(webhook)
      const { stuckCounts, stuckAnythingToShow } = await stuckHelpers()
      expect(stuckCounts(listed)).toEqual({ payments: 1, memberships: 0, watching: 0 })
      expect(stuckAnythingToShow(listed)).toBe(true)
      vi.stubGlobal('paddockWorkerV1', { rawRequest: vi.fn().mockResolvedValue(answer({})) })
      const older = await fn({ params: {}, user: { email: 'jo@example.com' } })
      expect(older['watchedPayments']).toEqual([])
      expect(older['webhook']).toBeNull()
      expect(stuckAnythingToShow(older)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("W47 item 7 (the W35 audit's F4): \"the card refund didn't go through\" comes from the press's own answer, not from the order's total still to refund", async () => {
    const refundOrder = (await backendFunction('refundOrder')).default as (req: { params: object; user: { email: string } }) => Promise<Record<string, unknown>>
    const refundOrderOwed = (await backendFunction('refundOrderOwed')).default as (req: { params: object; user: { email: string } }) => Promise<Record<string, unknown>>
    const answers = (data: Record<string, unknown>) => vi.stubGlobal('paddockWorkerV1', { rawRequest: vi.fn().mockResolvedValue({ data: { ok: true, data, requestId: 'r' } }) })
    const params = { orderId: '10000000-0000-4000-8000-0000000000aa', lineItemIds: ['l'], refundMethod: 'card', idempotencyKey: crypto.randomUUID() }
    try {
      // F4's own example: £20 is owed on the order from an earlier refusal. This refund went through to the card, with
      // a warning (its membership's subscription cancel was left). Before W47 the dialog read the warning and the £20
      // and said the card refund didn't go through.
      answers({ refundedAmount: 40, refundMethod: 'card', cardRefundedAmount: 40, refundOwed: 20, warning: 'The subscription could not be confirmed cancelled yet.' })
      const went = await refundOrder({ params, user: { email: 'jo@example.com' } })
      expect(went).toMatchObject({ success: true, cardRefundedAmount: 40, refundOwed: 20, warning: 'The subscription could not be confirmed cancelled yet.' })
      expect(went).not.toHaveProperty('cardRefundRefused')
      // This press's own card refund refused and not put back: the Worker says so (`held`), and only then is it set.
      answers({ refundedAmount: 24, refundMethod: 'card', refundOwed: 24, held: { claimId: 'c', reason: 'refund_refused_not_put_back', message: 'The card refund was refused.' } })
      expect(await refundOrder({ params, user: { email: 'jo@example.com' } })).toMatchObject({ success: true, refundOwed: 24, cardRefundRefused: true, warning: 'The card refund was refused.' })
      // Refund the rest: the same rule.
      answers({ cardRefundedAmount: 10, storeCreditRefundedAmount: 0, refundOwed: 0, warning: 'A note.' })
      const rest = await refundOrderOwed({ params: { orderId: params.orderId, amount: 10, refundMethod: 'card' }, user: { email: 'jo@example.com' } })
      expect(rest).toMatchObject({ cardRefundedAmount: 10, refundOwed: 0, warning: 'A note.' })
      expect(rest).not.toHaveProperty('cardRefundRefused')
      answers({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 10, held: { claimId: 'c', reason: 'refund_refused_not_put_back', message: 'Refused again.' } })
      expect(await refundOrderOwed({ params: { orderId: params.orderId, amount: 10, refundMethod: 'card' }, user: { email: 'jo@example.com' } })).toMatchObject({ refundOwed: 10, cardRefundRefused: true, warning: 'Refused again.' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// --- Brief W70a item 5 (W68a noticed 1)

describe('no sentence staff see names the old screens (W70a): they are gone, so the words say "another way"', () => {
  const WEB = path.resolve(__dirname, '..')
  const codeFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) return ['node_modules', 'testing', '.next', '.open-next'].includes(name) ? [] : codeFiles(full)
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
    })
  /** The code without its comments: a comment saying where a rule came from is not a sentence staff see. */
  const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  const named = (files: readonly string[]) => files.filter((file) => /old screens?\b/i.test(withoutComments(readFileSync(file, 'utf8')))).map((file) => path.basename(file))

  it('in the Worker (rules, routes, contracts) and in the staff app', () => {
    const worker = ['app', 'contracts', 'lib', 'server'].flatMap((dir) => codeFiles(path.join(WEB, dir)))
    const app = ['backend', 'frontend'].flatMap((dir) => codeFiles(path.join(staffAppDir(), dir)))
    expect([worker.length > 200, app.length > 150]).toEqual([true, true])
    // The fake Stripe is test code (an intent as the old screens made it).
    expect(named(worker.filter((file) => !file.endsWith(path.join('stripe', 'fake.ts'))))).toEqual([])
    expect(named(app)).toEqual([])
  })
})
