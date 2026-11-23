import { existsSync } from 'node:fs'
import path from 'node:path'
import { vi } from 'vitest'
import type { PlaceOrderInput } from '@/contracts'
import type { Db } from '@/server/db'
import type { LapseSweepResult } from '@/server/rules/bookings/lapse-sweep'
import type { FakeStripe } from '@/server/stripe/fake'
import { replayStripe } from '../replay/stripe-binding'
import { accountAsTheScreensPress, W37_ACTIONS, WRITES as ACCOUNT_WRITES } from './account-presses'
import {
  CREATES,
  PLAN_KIND_ON,
  READS as ADMIN_READS,
  STEP_G_ACTIONS_MOVED,
  W57_WRITES,
  asTheScreenPresses,
  createAsTheDialogPresses as createAsItsDialogPresses,
  runNightlyJobAsNow,
  withTheCountsShown,
  withTheFiguresShown,
  withoutPlanExtras,
  withoutStamps,
  type AnsweredPlanExtra,
  type AnsweredStamp,
} from './admin-presses'
import { bookingOf, bookingPresses, pressSwitch, settleHeldRefund, throughStaffApp, withSwitch } from './booking-presses'
import { createAsTheDialogPresses as createCustomerAsTheDialogPresses, READS_ALREADY_SWITCHED, W39_ACTIONS } from './customer-presses'
import { EVENT_CANCEL_KINDS_ON, EVENT_PLACE_ACTIONS, eventPlacesAsTheDialogPresses, settleHeldEventRefund } from './event-places-presses'
import { giftCardsAsTheScreensPress, W38_ACTIONS } from './gift-card-presses'
import { lapseSweepAsTheWorkerRunsIt } from './lapse-presses'
import { MEMBERSHIP_KINDS_ON, membershipsAsTheDialogPresses, W40_ACTIONS } from './membership-presses'
import { oldResult, orderInput, postOrder, postReaderStep, withQuotedCardFigure, type OrderAnswer } from './order-presses'
import { refundOrderAsTheDialogPresses, settleHeldOrderRefund } from './order-refund-presses'
import { PAYMENT_DATE_KINDS_ON, paymentDatesAsTheDialogPresses, W41_ACTIONS } from './payment-date-presses'
import { REPLAY_USER, type ReplaySide } from './run'
import { bindStaffRoutes } from './staff-routes'
import { staffAppDir } from '../staff-app-dir'
import { cancelEventAsTheDialogPresses, WHOLE_EVENT_ACTIONS } from './whole-event-presses'

/*
 * W64 (H-plan 3.1 and 3.3 step 3): the all-Worker side. Every action a scenario calls goes to the Worker as its screen
 * presses it, through the staff app's thin wrappers and the Worker's routes (the order route for New Order), reusing
 * each family's own press (keys kept after no answer, the figures the dialog showed sent back as confirmed, a refund the
 * Worker held settled as reconcile settles it before the next step on it). Nothing of the old code is loaded: the two
 * old Retool resources (`paddockData`, `paddockBackendApi2`) are stand-ins that refuse, so a scenario that still reached
 * old code would fail here, not pass quietly.
 *
 * Used by the Worker's own rule tests to set up through the Worker (step 1), and by the sweep (sweep-*.test.ts, step 3).
 * A test file using this mocks @/server/db/connection to the replay database and @/server/stripe/client to the run's
 * fake (replay/stripe-binding.ts), and sets STAFF_API_KEY.
 */

/**
 * Every kind the live ORDER_SWITCH lists (CLAUDE.md, 22 Nov). W64a item 8: every press on this side sees exactly these
 * (or `orderSwitch`), its family's own set and New Order's four kinds replaced by them (booking-presses.ts, pressSwitch).
 */
export const LIVE_KINDS_ON =
  'no_stripe,saved_card,reader,membership,booking_changes,reader_flows,order_refunds,event_cancels,membership_changes,payment_date_changes,card_moves,lapse_sweep,payment_retries,plan_changes'

const ORDER_ACTIONS: ReadonlySet<string> = new Set(['createOrder', 'finaliseReaderOrder', 'cancelReaderOrder'])

/** How far the clock moves before each press (see `call` below). */
export const PRESS_STEP_MS = 50

export interface WorkerSideOptions {
  /** Changes an answer after the Worker gives it: how a test plants a deliberate difference. */
  adjust?: (action: string, answer: unknown) => unknown
  /** Every call, as it was made. */
  calls?: string[]
  /** The order route's raw answers, for what staff see. */
  orderAnswers?: OrderAnswer[]
  /** Q4: the figure New Order's screen confirms where a decision changed it (press-forms.ts, NEW_SIDE_CONFIRMS). */
  confirms?: { toCollect: number }
  /** The same press sent twice goes under one key (FB9, FB12, FB15: press-forms.ts, REPEATED_PRESS_SCENARIOS). */
  repeatedPress?: boolean
  /** A read made with `call` that the Worker refuses answers `{ thrown }` (GB14, FB16). */
  refusedReadsAsAnswers?: boolean
  /** A step G press the Worker refuses answers `{ thrown }` (GB10, GB12, GB21, GB23, GB1's two). */
  refusedPressesAsAnswers?: boolean
  /** Each stamp and plan extra set aside from an answer (random: a stamp fingerprints a row whose id is new each run). */
  stamps?: AnsweredStamp[]
  planExtras?: AnsweredPlanExtra[]
  /** The lapse sweep's results, where a scenario runs it. */
  lapseRuns?: LapseSweepResult[]
  /** ORDER_SWITCH for every press and the lapse sweep (default: every live kind). W64a item 8: the families' sets no longer apply. */
  orderSwitch?: string
}

const refusedOld = (what: string) => () => {
  throw new Error(`The old code was reached on the Worker's side (${what}).`)
}

/**
 * A Stripe call made by New Order's pipeline takes a second (replay/stripe-binding.ts, stripeCallsTakeASecond: the
 * clock stands still, so T2's rows would tie with T1's). Only while an order is being placed, finalised or cancelled,
 * as the order family ran it; every other family's presses ran with their Stripe calls taking no time.
 */
function orderCallsTakeASecond(stripe: FakeStripe, placing: { on: boolean }): void {
  const later = () => {
    if (placing.on) vi.setSystemTime(Date.now() + 1_000)
  }
  const charge = stripe.paymentIntents.create
  stripe.paymentIntents.create = (params, options) => {
    later()
    return charge(params, options)
  }
  const subscribe = stripe.subscriptions.create
  stripe.subscriptions.create = (params, options) => {
    later()
    return subscribe(params, options)
  }
  const refund = stripe.refunds.create
  stripe.refunds.create = (params, options) => {
    later()
    return refund(params, options)
  }
}

export function workerSide(options: WorkerSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  const { adjust, calls, orderAnswers, confirms, repeatedPress, refusedReadsAsAnswers, refusedPressesAsAnswers, stamps, planExtras, lapseRuns, orderSwitch = LIVE_KINDS_ON } = options
  return (db, stripe) => {
    // W65b (lead call): kept as a guard. No hook wraps these any more; a staff app function that still reaches an old
    // resource fails loudly here instead of passing quietly.
    vi.stubGlobal('paddockData', { query: refusedOld('paddockData') })
    vi.stubGlobal('paddockBackendApi2', { rawRequest: refusedOld('paddockBackendApi2') })
    vi.stubGlobal('paddockWorkerV1', { rawRequest: bindStaffRoutes(db) })
    vi.stubEnv('ORDER_SWITCH', orderSwitch)
    replayStripe.current = stripe
    const placing = { on: false }
    orderCallsTakeASecond(stripe, placing)

    const pressed = repeatedPress !== undefined ? { repeatedPress } : {}
    const account = accountAsTheScreensPress(pressed)
    const giftCards = giftCardsAsTheScreensPress(pressed)
    const createCustomer = createCustomerAsTheDialogPresses()
    const memberships = membershipsAsTheDialogPresses()
    const paymentDates = paymentDatesAsTheDialogPresses()
    const orderRefund = refundOrderAsTheDialogPresses()
    const eventPlaces = eventPlacesAsTheDialogPresses()
    const cancelEvent = cancelEventAsTheDialogPresses()
    const creates = new Map([...CREATES].map((action) => [action, createAsItsDialogPresses(action)] as const))
    // Each booking press keeps its own held keys across the run, as the dialog does. W64a item 8: a new set for each
    // scenario, so no key is held over from the last one.
    const booking = bookingPresses()

    const order = async (action: string, params: unknown): Promise<unknown> => {
      placing.on = true
      try {
        if (action === 'createOrder') {
          const input = await withQuotedCardFigure(orderInput(params as Record<string, unknown>))
          const sent: PlaceOrderInput = confirms ? { ...input, confirmed: { ...input.confirmed, toCollect: confirms.toCollect } } : input
          const answer = await postOrder(sent)
          orderAnswers?.push(answer)
          return oldResult(answer.body)
        }
        const { orderId } = params as { orderId: string }
        const answer = await postReaderStep(action === 'finaliseReaderOrder' ? 'finalise' : 'cancel', orderId)
        orderAnswers?.push(answer)
        const body = answer.body as { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }
        return body.ok ? body.data : { error: { code: body.error.code, message: body.error.message } }
      } finally {
        placing.on = false
        // T1 stamps its rows a millisecond apart after its own time (one for each line), so the clock is left past
        // them: whatever comes next (a rule test's own route call, with no step of its own) is later than the order.
        vi.setSystemTime(Date.now() + PRESS_STEP_MS)
      }
    }

    const stepG = async (action: string, params: unknown): Promise<unknown> => {
      const stamped = await asTheScreenPresses(action, db, params)
      const figured = await withTheFiguresShown(action, db, stamped)
      const sent = await withTheCountsShown(action, db, figured)
      const press = () => (creates.get(action) ?? throughStaffApp(action))(db, sent)
      // W57: a plan write (and updateCatalogItemPrice, whose plan branch is one) with `plan_changes` on, as live.
      const answer = W57_WRITES.has(action) || action === 'updateCatalogItemPrice' ? await withSwitch(PLAN_KIND_ON, press) : await press()
      return withoutPlanExtras(action, withoutStamps(action, answer, stamps), planExtras)
    }

    const press = async (action: string, params: unknown): Promise<unknown> => {
      if (ORDER_ACTIONS.has(action)) return order(action, params)
      const bookingPress = booking.get(action)
      if (bookingPress) {
        await settleHeldRefund(db, await bookingOf(db, params))
        return bookingPress(db, params)
      }
      if (action === 'refundOrder') {
        await settleHeldOrderRefund(db, (params as { orderId?: string } | null)?.orderId)
        return orderRefund(db, params)
      }
      if (EVENT_PLACE_ACTIONS.has(action)) {
        await settleHeldEventRefund(db, (params as { eventBookingId?: string } | null)?.eventBookingId)
        return action === 'cancelEventPlaces' ? eventPlaces.cancel(db, params) : eventPlaces.quote(db, params)
      }
      if (WHOLE_EVENT_ACTIONS.has(action)) {
        return action === 'cancelEvent' ? cancelEvent(db, params) : withSwitch(EVENT_CANCEL_KINDS_ON, () => throughStaffApp('getEventCancellationOverview')(db, params))
      }
      if (W37_ACTIONS.has(action)) return ACCOUNT_WRITES.has(action) ? account(db, action, params) : throughStaffApp(action)(db, params)
      if (W38_ACTIONS.has(action)) return giftCards(db, action, params)
      if (action === 'createCustomer') return createCustomer(db, params)
      if (W39_ACTIONS.has(action) || READS_ALREADY_SWITCHED.has(action)) return throughStaffApp(action)(db, params)
      if (W40_ACTIONS.has(action)) return withSwitch(MEMBERSHIP_KINDS_ON, () => memberships(db, action, params))
      if (W41_ACTIONS.has(action)) return withSwitch(PAYMENT_DATE_KINDS_ON, () => paymentDates(db, action, params))
      if (STEP_G_ACTIONS_MOVED.has(action)) return stepG(action, params)
      // Any other staff app function (the Orders page's reconcileOrders, getStuckReaderPayments, closeStuckOrder,
      // getMoneyOwed...): the staff app's own file, loaded as Retool runs it. Every one is a thin call to the Worker.
      const own = path.join(staffAppDir(), 'backend/paddock', `${action}.ts`)
      if (!existsSync(own)) throw new Error(`The all-Worker side has no press for ${action}.`)
      const loaded = (await import(/* @vite-ignore */ own)) as { default: (req: { params: unknown; user: typeof REPLAY_USER }) => Promise<unknown> }
      return loaded.default({ params, user: REPLAY_USER })
    }

    const isRead = (action: string) => ADMIN_READS.has(action) || W39_ACTIONS.has(action) || READS_ALREADY_SWITCHED.has(action) || action === 'getSubscriptions'
    return {
      name: 'worker',
      nightlyJob: runNightlyJobAsNow,
      lapseSweep: (sweepDb) => lapseSweepAsTheWorkerRunsIt(sweepDb, { orderSwitch, ...(lapseRuns ? { runs: lapseRuns } : {}) }),
      async call(action, params) {
        calls?.push(action)
        // The clock moves between presses. 50 ms, not the families' 1 ms: New Order's T1 spaces its rows a millisecond
        // apart (one for each line), so with 1 ms the next press's rows could share a created_at with them, and a rule
        // that takes the earliest row (a booking's own order) would pick between them by their random ids. Live, presses
        // are seconds apart; 50 ms is still far inside every window a scenario times (a press's 60 seconds, 24 hours).
        vi.setSystemTime(Date.now() + PRESS_STEP_MS)
        let answer: unknown
        const outer = pressSwitch.live
        pressSwitch.live = orderSwitch
        try {
          answer = await press(action, params)
        } catch (err) {
          const asAnswer = (refusedReadsAsAnswers === true && isRead(action) && action !== 'createCustomer') || (refusedPressesAsAnswers === true && STEP_G_ACTIONS_MOVED.has(action) && !isRead(action))
          if (!asAnswer) throw err
          answer = { thrown: err instanceof Error ? err.message : String(err) }
        } finally {
          pressSwitch.live = outer
        }
        return adjust ? adjust(action, answer) : answer
      },
    }
  }
}
