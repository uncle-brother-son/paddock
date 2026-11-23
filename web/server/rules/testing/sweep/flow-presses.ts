import { POST as cancelFlowRoute } from '@/app/api/v1/staff/reader-flows/[pendingId]/cancel/route'
import { POST as finaliseFlowRoute } from '@/app/api/v1/staff/reader-flows/[pendingId]/finalise/route'
import type { Db } from '@/server/db'
import { REPLAY_USER, type Scenario, type ScenarioContext } from './run'
import { bea, ID, lapsedSeat, memberCredit, mo, paidSeat, publicOnCard, sam, seed, seedCorePass, settle } from '../replay/scenarios'

/*
 * W64 (H-plan 3.3 step 3): W12's reader flow scenarios and the flow steps, as the screen presses them, moved here unchanged from
 * `replay/flow-side.ts` so the all-Worker sweep and the Worker's own rule tests can press the Worker with nothing of the
 * old code loaded.
 */

export type Pending = { pendingReaderPayment?: { pendingId: string; paymentIntentId: string } }

/** Taps the reader and finalises, or cancels with no tap, as the screen does. */
export async function finishOnTheReader(context: ScenarioContext, started: Pending, tap: boolean): Promise<void> {
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
export function corePassIntoPeak(name: string, tap: boolean): Scenario {
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
export function moveWithStoreCredit(name: string, tap: boolean): Scenario {
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
export function settleWithStoreCredit(name: string, tap: boolean): Scenario {
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
export function guestWithAddonCredit(name: string, tap: boolean): Scenario {
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
