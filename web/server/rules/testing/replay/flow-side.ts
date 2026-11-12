import { POST as cancelFlowRoute } from '@/app/api/v1/staff/reader-flows/[pendingId]/cancel/route'
import { POST as finaliseFlowRoute } from '@/app/api/v1/staff/reader-flows/[pendingId]/finalise/route'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { seatLineLessPaidAddOns, type AllowedDifference } from './compare'
import { oldSide, REPLAY_USER, type ReplaySide, type Scenario, type ScenarioContext } from './harness'
import { bea, ID, lapsedSeat, memberCredit, mo, paidSeat, publicOnCard, sam, seed, seedCorePass, settle } from './scenarios'
import { replayStripe } from './stripe-binding'

/*
 * W12: the reader flows' side of the replay (flow-replay.test.ts) and its helpers, shared with
 * server/rules/orders/reader-flow.test.ts and the reconcile tests. A test file using it mocks
 * @/server/db/connection to the replay database and @/server/stripe/client with stripeClientMock, and
 * sets STAFF_API_KEY, as order-side.ts's users do.
 */

/** Every scenario whose golden file finishes or cancels a reader flow (pending_reader_payments rows written). */
export const FLOW_SCENARIOS: readonly string[] = [
  'add-guest-while-a-reader-move-is-open',
  'addon-with-guest-private-reader-not-ticked',
  'addon-with-guest-private-reader-ticked',
  'addon-with-guest-private-split-reader-not-ticked',
  'addon-with-guest-private-split-reader-ticked',
  'addon-with-guest-public-reader-not-ticked',
  'addon-with-guest-public-reader-ticked',
  'addon-with-guest-public-split-reader-not-ticked',
  'addon-with-guest-public-split-reader-ticked',
  'cancel-while-a-guest-is-on-the-reader',
  'cancel-while-a-reader-move-is-open',
  'move-while-a-guest-is-on-the-reader',
  'part-refund-while-a-reader-move-is-open',
  'q25-higher-tier-on-the-reader-then-refund',
  'q25-higher-tier-on-the-reader-to-store-credit',
  'q25-higher-tier-split-on-the-reader-then-refund',
  'q25-reader-cancelled-puts-it-all-back',
  'q27-part-to-card-higher-tier-on-the-reader-then-to-the-card',
  'q27-part-to-credit-higher-tier-on-the-reader-then-to-store-credit',
  'q27-part-to-credit-higher-tier-on-the-reader-then-to-the-card',
  'q27-reader-cancelled-after-a-part-refund',
  'q28-private-dearer-on-the-reader',
  'q28-private-reader-cancelled-puts-it-all-back',
  'q28-public-dearer-on-the-reader',
  'reader-move-finished-then-remove-guest',
  'refund-the-rest-while-a-reader-move-is-open',
  'remove-guest-while-a-guest-is-on-the-reader',
  'remove-guest-while-a-reader-move-is-open',
  'second-guest-while-a-guest-is-on-the-reader',
  'second-move-while-a-reader-move-is-open',
  'w05l-add-guest-gift-card-and-reader-answer-lost-then-cancel',
  'w05l-move-gift-card-and-reader-answer-lost-then-cancel',
  'w05l-move-gift-card-and-reader-then-cancel',
  'w05l-move-gift-card-and-reader-undone-then-cancel',
  'w05l-settle-gift-card-and-reader-answer-lost-then-cancel',
  'w05l-settle-gift-card-and-reader-then-cancel',
  'w05l-settle-gift-card-and-reader-undone-then-settled',
]

type Pending = { pendingReaderPayment?: { pendingId: string; paymentIntentId: string } }

/** Taps the reader and finalises, or cancels with no tap, as the screen does. */
async function finishOnTheReader(context: ScenarioContext, started: Pending, tap: boolean): Promise<void> {
  const pending = started.pendingReaderPayment
  if (!pending) throw new Error('The flow started no reader payment.')
  if (tap) {
    context.stripe.completeReaderPayment(pending.paymentIntentId)
    await context.call('finaliseReaderPayment', { pendingId: pending.pendingId })
  } else {
    await context.call('cancelReaderPayment', { pendingId: pending.pendingId })
  }
}

/** A Core pass seat moved to a Peak session the pass can't cover: the seat is paid on the reader, and finalise gives the pass session back. */
function corePassIntoPeak(name: string, tap: boolean): Scenario {
  return {
    name,
    async seed(db, stripe) {
      await seed(db, stripe)
      await seedCorePass(db)
    },
    async run(context) {
      const { call } = context
      const booking = { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedCorePass }
      const { bookingId } = (await call('createOrder', { customerId: ID.customer, booking, payment: {} })) as { bookingId: string }
      await call('moveBooking', { bookingId, newSessionId: ID.peakSession })
      const started = (await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'reader' } })) as Pending
      await finishOnTheReader(context, started, tap)
    },
  }
}

/** Two seats on the card, moved to the dearer Peak session: £5 of Sam's store credit, the rest on the reader. */
function moveWithStoreCredit(name: string, tap: boolean): Scenario {
  return {
    name,
    seed,
    async run(context) {
      const { call } = context
      const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...publicOnCard })) as { bookingId: string }
      await call('moveBooking', { bookingId, newSessionId: ID.peakSession })
      const started = (await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'reader', storeCredit: { amount: 5 } } })) as Pending
      await finishOnTheReader(context, started, tap)
    },
  }
}

/** Mo's lapsed £20 seat settled with £5 of store credit and £15 on the reader. */
function settleWithStoreCredit(name: string, tap: boolean): Scenario {
  return {
    name,
    async seed(db, stripe) {
      await seed(db, stripe)
      await db.query("UPDATE customers SET store_credit_balance = 10 WHERE id = $1", [ID.member])
    },
    async run(context) {
      const bookingId = await lapsedSeat(context.call, context.db)
      if (tap) {
        await settle(context.call, context.stripe, bookingId, { method: 'reader', storeCredit: { amount: 5 } })
        return
      }
      const started = (await context.call('settleLapsedBooking', { bookingId, payment: { method: 'reader', storeCredit: { amount: 5 } } })) as Pending
      await finishOnTheReader(context, started, false)
    },
  }
}

/** Mo's credit seat, then a paid guest on the reader with a robe on Mo's Herd add-on credit. */
function guestWithAddonCredit(name: string, tap: boolean): Scenario {
  return {
    name,
    seed,
    async run(context) {
      const { call } = context
      const { bookingId } = (await call('createOrder', { customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} })) as { bookingId: string }
      const guest = { bookingId, ...bea, addons: [{ addonId: ID.robe, quantity: 1, redemptionSource: 'membership_credit', membershipId: ID.membership }] }
      await call('addBookingGuest', guest)
      const started = (await call('addBookingGuest', { ...guest, payment: { method: 'reader' } })) as Pending
      await finishOnTheReader(context, started, tap)
    },
  }
}

/** W12's own flow scenarios: what the recorded ones didn't cover (a pass seat, store credit, add-on credit; each finalised and cancelled). */
export const W12_FLOW_SCENARIOS: readonly Scenario[] = [
  corePassIntoPeak('w12-move-core-pass-into-peak-on-the-reader', true),
  corePassIntoPeak('w12-move-core-pass-into-peak-on-the-reader-cancelled', false),
  moveWithStoreCredit('w12-move-store-credit-and-reader', true),
  moveWithStoreCredit('w12-move-store-credit-and-reader-cancelled', false),
  settleWithStoreCredit('w12-settle-store-credit-and-reader', true),
  settleWithStoreCredit('w12-settle-store-credit-and-reader-cancelled', false),
  guestWithAddonCredit('w12-add-guest-addon-credit-on-the-reader', true),
  guestWithAddonCredit('w12-add-guest-addon-credit-on-the-reader-cancelled', false),
]

export const FLOW_REQUEST_ID = 'w12-replay-worker-flow'

/** What step D's Worker start writes onto a flow's record, written here onto the old start's row. */
export async function asWorkerFlow(db: Db, pendingId: string, livemode = false): Promise<void> {
  await db.query(
    `UPDATE pending_reader_payments p
     SET snapshot = p.snapshot || jsonb_build_object('method', 'reader', 'channel', 'staff', 'request_id', $2::text,
                                                     'stripe_customer_id', c.stripe_customer_id, 'livemode', $3::boolean)
     FROM customers c
     WHERE p.id = $1::uuid AND c.id = (p.snapshot->>'customer_id')::uuid`,
    [pendingId, FLOW_REQUEST_ID, livemode]
  )
}

/** POST /api/v1/staff/reader-flows/:pendingId/finalise or /cancel, as step D's screens will call them. */
export async function postFlowStep(step: 'finalise' | 'cancel', pendingId: string, { key = crypto.randomUUID(), email = REPLAY_USER.email } = {}) {
  const route = step === 'finalise' ? finaliseFlowRoute : cancelFlowRoute
  const response = await route(
    new Request(`https://worker.test/api/v1/staff/reader-flows/${pendingId}/${step}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.STAFF_API_KEY}`, 'x-staff-email': email, 'idempotency-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    { params: Promise.resolve({ pendingId }) }
  )
  return { status: response.status, body: (await response.json()) as { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } } }
}

/** The old functions for everything, apart from the flow's finalise and cancel, which go to the new routes. */
export function newFlowSide(): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    replayStripe.current = stripe
    return {
      name: 'new',
      async call(action, params) {
        if (action === 'finaliseReaderPayment' || action === 'cancelReaderPayment') {
          const { pendingId } = params as { pendingId: string }
          const answer = await postFlowStep(action === 'finaliseReaderPayment' ? 'finalise' : 'cancel', pendingId)
          return answer.body.ok ? answer.body.data : { error: answer.body.error }
        }
        const result = (await old.call(action, params)) as { pendingReaderPayment?: { pendingId?: string } } | null
        const pendingId = result?.pendingReaderPayment?.pendingId
        if (pendingId) await asWorkerFlow(db, pendingId)
        return result
      },
    }
  }
}

const STEP_D = 'Brief W12 item 2: the new routes take only flows the Worker started; step D writes these as it starts one'
export const WORKER_FLOW_RECORD: AllowedDifference = {
  name: "A flow's record carries what step D's Worker start writes: method, channel, request id, Stripe customer, the key's mode",
  decision: STEP_D,
  path: /^\.tables\.pending_reader_payments\.added\[\d+\]\.snapshot\.(method|channel|request_id|stripe_customer_id|livemode)$/,
}
const FLOW_AUDIT_ROWS: AllowedDifference = {
  name: 'The flow writes reader_payment.finalise or .cancel in its own transaction',
  decision: 'Brief W12 item 2 (W03-plan 2.9)',
  path: /^\.tables\.audit_log(\.|$)/,
}
const FLOW_IDEMPOTENCY_ROWS: AllowedDifference = {
  name: 'The flow routes store their answers against the Idempotency-Key',
  decision: 'Brief W12 item 2 (W03-plan 2.6)',
  path: /^\.tables\.api_idempotency(\.|$)/,
}

/**
 * W20 (W05c Noticed 5): the Worker's finalise of an Add Guest flow writes the seat on the booking line and the paid
 * add-ons on their own lines of the same order, so where a guest and an add-on were paid on the reader the booking line
 * is smaller by the add-on (never below £0). The refund figures' seat money is unchanged (money-left.ts takes the
 * add-ons out of the old, larger line).
 */
const SEAT_ON_THE_BOOKING_LINE: AllowedDifference = {
  name: "An Add Guest flow's order puts only the seat on the booking line; the paid add-ons are on their own lines of the same order",
  decision: 'W05c Noticed 5 (D-plan 2.3); brief W20 item 2; brief W20a item 4 (exact, booking lines only)',
  path: /^\.tables\.order_line_items\.added\[\d+\]\.(unit_price|line_total)$/,
  actual: seatLineLessPaidAddOns,
}

/** The flow scenarios where a guest and a paid add-on were paid together on the reader (W05c's golden families). */
const GUEST_AND_ADDON_ON_THE_READER: ReadonlySet<string> = new Set([
  'addon-with-guest-private-reader-not-ticked',
  'addon-with-guest-private-reader-ticked',
  'addon-with-guest-private-split-reader-not-ticked',
  'addon-with-guest-private-split-reader-ticked',
  'addon-with-guest-public-reader-not-ticked',
  'addon-with-guest-public-reader-ticked',
  'addon-with-guest-public-split-reader-not-ticked',
  'addon-with-guest-public-split-reader-ticked',
])

/**
 * W12's named differences for the flows: the three above, in every scenario (each finishes or cancels one); W20: and
 * the seat on its own booking line, in the scenarios that paid a guest and an add-on together on the reader.
 */
export function flowDifferences(scenario?: string): AllowedDifference[] {
  return [WORKER_FLOW_RECORD, FLOW_AUDIT_ROWS, FLOW_IDEMPOTENCY_ROWS, ...(scenario && GUEST_AND_ADDON_ON_THE_READER.has(scenario) ? [SEAT_ON_THE_BOOKING_LINE] : [])]
}

