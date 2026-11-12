import type { Db } from '@/server/db'
import { loadBookingMoneyLeft } from '@/server/rules/bookings/money-left'
import type { FakeStripe } from '@/server/stripe/fake'
import type { AllowedDifference } from './compare'
import { LEGACY_BOOKING_ACTIONS, oldSide, type ReplaySide } from './harness'
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
 * The actions the Worker answers so far, by old name. W17: the refund figures, straight from the rule (the old
 * function threw 'Booking not found.' for a missing booking; so does this).
 */
export const BUILT_BOOKING_ACTIONS: ReadonlyMap<string, NewBookingAction> = new Map<string, NewBookingAction>([
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
