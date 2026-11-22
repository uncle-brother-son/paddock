import { vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { throughStaffApp, withSwitch } from './booking-side'
import { EVENT_CANCEL_KINDS_ON, EVENT_PLACE_ACTIONS, eventPlacesAsTheDialogPresses } from './event-places-side'
import { oldSide, type ReplaySide } from './harness'
import { replayStripe } from './stripe-binding'
import { WHOLE_EVENT_ACTIONS, cancelEventAsTheDialogPresses } from '../sweep/whole-event-presses'

/*
 * W31 (brief item 7; E-plan 4.13 item 3): step E's side of the replay for the whole event. The old cancelEvent's and
 * getEventCancellationOverview's params go to the staff app's thin wrappers, which call the Worker's routes; the old
 * cancelEvent cancelled every booking inside one call (bug E6), so here it is driven as the Cancel event dialog now
 * presses it: the event's own cancel, then each booking in turn through the thin cancelEventPlaces with `wholeEvent`,
 * its own key and the overview's figure as the confirmed refund. The answer is put back in the old function's shape
 * (`{ ok: true, results }`), each row as the dialog lists it. A place cancel inside a whole-event scenario goes as
 * W30's dialog presses it (event-places-side.ts). Everything else (the orders being placed, a reader payment
 * finished) still runs through the frozen copies of the old functions.
 */

// W64: the presses moved to the sweep folder (H-plan 3.3 step 3); re-exported for the old replay's files.
export * from '../sweep/whole-event-presses'

export interface WholeEventSideOptions {
  /** Changes an answer after the Worker gives it: how a test plants a deliberate difference. */
  adjust?: (action: string, answer: unknown) => unknown
  /** Every call, as it was made, for tests that check which side answered. */
  calls?: Array<{ action: string; side: 'new' | 'old' }>
}

/**
 * The new side: cancelEvent and getEventCancellationOverview (and a place cancel or its quote) through the staff
 * app's wrappers and the Worker's routes, everything else through the old functions (the frozen copies), on the same
 * database and the same fake Stripe.
 */
export function newWholeEventSide({ adjust, calls }: WholeEventSideOptions = {}): (db: Db, stripe: FakeStripe) => ReplaySide {
  return (db, stripe) => {
    const old = oldSide(db, stripe)
    replayStripe.current = stripe
    const places = eventPlacesAsTheDialogPresses()
    const cancelEvent = cancelEventAsTheDialogPresses()
    return {
      name: 'new',
      async call(action, params) {
        if (!WHOLE_EVENT_ACTIONS.has(action) && !EVENT_PLACE_ACTIONS.has(action)) {
          calls?.push({ action, side: 'old' })
          return old.call(action, params)
        }
        calls?.push({ action, side: 'new' })
        vi.setSystemTime(Date.now() + 1)
        let answer: unknown
        if (action === 'cancelEvent') answer = await cancelEvent(db, params)
        else if (action === 'getEventCancellationOverview') answer = await withSwitch(EVENT_CANCEL_KINDS_ON, () => throughStaffApp('getEventCancellationOverview')(db, params))
        else if (action === 'cancelEventPlaces') answer = await places.cancel(db, params)
        else answer = await places.quote(db, params)
        return adjust ? adjust(action, answer) : answer
      },
    }
  }
}
