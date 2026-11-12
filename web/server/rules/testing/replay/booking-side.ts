import path from 'node:path'
import type { Db } from '@/server/db'
import { loadBookingMoneyLeft } from '@/server/rules/bookings/money-left'
import type { FakeStripe } from '@/server/stripe/fake'
import { staffAppDir } from '../staff-app-dir'
import type { AllowedDifference } from './compare'
import { LEGACY_BOOKING_ACTIONS, oldSide, REPLAY_USER, type ReplaySide } from './harness'
import { replayStripe } from './stripe-binding'

/*
 * W17 (D-plan 4.11 item 1): step D's side of the replay, as order-side.ts is step C's. Each slice (W18 to W24) gives
 * one old action to the Worker: its params go to the new route, and its answer comes back in the old function's shape,
 * as the staff app's thin wrapper will give it to the screen. Every other call, the setup before and the steps after,
 * still runs through the frozen copy of the old functions (legacy-booking/), so the seed state is exactly what each
 * golden file recorded, whichever actions have switched. A test file using a route mocks @/server/db/connection to the
 * replay database and sets STAFF_API_KEY, as order-side.ts's users do.
 *
 * W17 builds no route, so the one action it can give the Worker is the read with no route of its own yet:
 * getBookingRefundFigures, from server/rules/bookings/money-left.ts (its route is W21's).
 */

/** The old step D actions (LEGACY_BOOKING_ACTIONS), and the one each slice moves to the Worker. */
export const BOOKING_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['setBookingSpecialRequests', 'W18'],
  ['setBookingStatus', 'W18'],
  ['settleLapsedBooking', 'W19'],
  ['finaliseReaderPayment', 'W19'],
  ['cancelReaderPayment', 'W19'],
  ['addBookingGuest', 'W20'],
  ['getBookingRefundFigures', 'W21'],
  ['refundBooking', 'W21 to W23'],
  ['removeBookingGuest', 'W22'],
  ['removeBookingAddon', 'W22'],
  ['cancelCreditBooking', 'W23'],
  ['moveBooking', 'W24'],
])

/** How the Worker answers one old action, in the old function's shape. */
export type NewBookingAction = (db: Db, params: unknown) => Promise<unknown>

/**
 * W18 on: the staff app's own thin wrapper, which calls the real route through the old side's paddockWorkerV1
 * stand-in (bindStaffRoutes), so the replay holds the wrapper and the route together to the old function. callWorker
 * puts a fresh request id into an error it throws; that id is left out so a recording repeats.
 */
export function throughStaffApp(name: string): NewBookingAction {
  return async (_db, params) => {
    const wrapper = (await import(/* @vite-ignore */ path.join(staffAppDir(), 'backend/paddock', `${name}.ts`))) as {
      default: (req: { params: unknown; user: typeof REPLAY_USER }) => Promise<unknown>
    }
    try {
      return await wrapper.default({ params, user: REPLAY_USER })
    } catch (err) {
      if (err instanceof Error) throw new Error(err.message.replace(/, request [^)]*\)$/, ')'))
      throw err
    }
  }
}

/**
 * The actions the Worker answers so far, by old name. W17: the refund figures, straight from the rule (the old
 * function threw 'Booking not found.' for a missing booking; so does this). W18: special requests and status, through
 * the staff app's thin wrappers.
 */
export const BUILT_BOOKING_ACTIONS: ReadonlyMap<string, NewBookingAction> = new Map<string, NewBookingAction>([
  ['setBookingSpecialRequests', throughStaffApp('setBookingSpecialRequests')],
  ['setBookingStatus', throughStaffApp('setBookingStatus')],
  [
    'getBookingRefundFigures',
    async (db, params) => {
      const figures = await loadBookingMoneyLeft(db, (params as { bookingId: string }).bookingId)
      if (!figures) throw new Error('Booking not found.')
      return figures
    },
  ],
])

export interface BookingSideOptions {
  /** Which old actions go to the Worker (default: every built one). */
  actions?: ReadonlyMap<string, NewBookingAction>
  /** Changes an answer after the Worker gives it: how a test plants a deliberate difference. */
  adjust?: (action: string, answer: unknown) => unknown
  /** Every call, as it was made, for tests that check which side answered. */
  calls?: Array<{ action: string; side: 'new' | 'old' }>
}

/**
 * The new side: the actions in `actions` through the Worker, everything else through the old functions (the frozen
 * copies for steps C and D, the staff app's checkout for the rest), on the same database and the same fake Stripe.
 */
export function newBookingSide({ actions = BUILT_BOOKING_ACTIONS, adjust, calls }: BookingSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  for (const action of actions.keys()) {
    if (!LEGACY_BOOKING_ACTIONS.has(action)) throw new Error(`${action} isn't one of the old step D actions.`)
  }
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    replayStripe.current = stripe
    return {
      name: 'new',
      async call(action, params) {
        const built = actions.get(action)
        calls?.push({ action, side: built ? 'new' : 'old' })
        if (!built) return old.call(action, params)
        const answer = await built(db, params)
        return adjust ? adjust(action, answer) : answer
      },
    }
  }
}

/**
 * W05l later 1, permanent with Wayne's Q36 answer (12 Nov): a gift card part recorded against the booking with no
 * order (Move, Settle, a reader flow's finalise) counts as gift card money in the figures, where the old figures put
 * it under cash. Only the split of `left` changes: its total, the card figure and everything else stay the same.
 */
export const GIFT_CARD_PART_WITHOUT_ORDER: AllowedDifference = {
  name: 'The refund figures count a gift card part with no order as gift card money, not cash',
  decision: 'W05l later 1; W03-decisions, Wayne 12 Nov (Q36: keep today\'s way, so this stays permanent)',
  path: /^\.results\[\d+\]\.parts\.(giftCard|cash)$/,
}

/** A route stores its answer against the request's key, refusals included (W03-plan 2.6, as brief W06 item 5). */
export const BOOKING_IDEMPOTENCY_ROW: AllowedDifference = {
  name: "The booking route stores its answer against the request's key",
  decision: 'W03-plan 2.6 (as brief W06 item 5)',
  path: /^\.tables\.api_idempotency$/,
}

const N3 =
  "N3 (D-plan section 3; lead's step D plan calls, W03-decisions 12 Nov; brief W18): the status route takes only pending, confirmed, completed and no-show, and never changes a booking awaiting payment or cancelled"

/**
 * W18: the only named differences on the new side for special requests and status, all N3's, against W17's three
 * recordings of the old setBookingStatus. Each status change is refused with its words and writes nothing, so what
 * follows sees the booking as it was. Every other scenario, and every other step, must still match exactly.
 */
export const N3_DIFFERENCES: ReadonlyMap<string, readonly AllowedDifference[]> = new Map([
  [
    'w17-n3-status-set-to-cancelled-on-a-paid-booking',
    [
      {
        name: 'Cancelled is refused (the old code cancelled the paid booking with no refund and kept its places), so the booking stays confirmed and its figures say so',
        decision: N3,
        path: /^\.results\[1\](\.|$)|^\.results\[2\]\.status$|^\.tables\.bookings\.added\[0\]\.(status|cancelled_at)$/,
      },
      BOOKING_IDEMPOTENCY_ROW,
    ],
  ],
  [
    'w17-n3-status-set-to-payment-needed-then-settled-again',
    [
      {
        name: 'Payment needed is refused (the old code let Settle take seat 1 again: £20 charged twice), so Settle then refuses a booking that is not awaiting payment, and price_paid stays £40',
        decision: N3,
        path: /^\.results\[[12]\](\.|$)|^\.tables\.audit_log$|^\.tables\.bookings\.added\[0\]\.price_paid$/,
      },
      BOOKING_IDEMPOTENCY_ROW,
    ],
  ],
  [
    'w17-n3-status-set-to-confirmed-from-payment-needed',
    [
      {
        name: 'A booking awaiting payment is not confirmed with nothing paid: refused, and it stays payment needed',
        decision: N3,
        path: /^\.results\[1\](\.|$)|^\.tables\.bookings\.added\[0\]\.status$/,
      },
      BOOKING_IDEMPOTENCY_ROW,
    ],
  ],
])
