import { vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { throughStaffApp, withSwitch } from './booking-side'
import { EVENT_CANCEL_KINDS_ON, EVENT_PLACE_ACTIONS, eventPlacesAsTheDialogPresses, settleHeldEventRefund } from './event-places-side'
import { oldSide, type ReplaySide } from './harness'
import { replayStripe } from './stripe-binding'

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

/** The two old actions W31 gives to the Worker. */
export const WHOLE_EVENT_ACTIONS: ReadonlySet<string> = new Set(['cancelEvent', 'getEventCancellationOverview'])

type CancelEventParams = { eventId?: string; refund?: string; reason?: string }
type OverviewBooking = { eventBookingId: string; customerName: string; places: number; value: number }
type EventAnswer = { ok: true; overview: { bookings: OverviewBooking[] } } | { ok: false; reason: string; message: string; noAnswer?: boolean }
type PlacesAnswer =
  | { ok: true; places: number; cardRefundedAmount: number; storeCreditRefundedAmount: number; refundOwed?: number; warning?: string }
  | { ok: false; reason: string; message: string; warning?: string; noAnswer?: boolean }
  | null

/** The dialog's own words for a booking whose press got no answer (a copy of CancelEventDialog.tsx's; a test holds the two together). */
export const BOOKING_NO_ANSWER_MESSAGE =
  "No answer came back, so this booking may or may not have been cancelled and refunded. Don't refund it by hand: press Retry (it won't cancel or refund twice)."

/** One booking's press as it was first sent: after no answer it is sent again exactly so, under the same key. */
interface HeldPress {
  key: string
  refund: string | undefined
  reason: string | undefined
  confirmed: number
  customerName: string
  places: number
}

/**
 * cancelEvent as the Cancel event dialog presses it (frontend/components/CancelEventDialog.tsx): the same steps, in
 * the same order, with the same mapping of each booking's answer to its row. The keys of presses that got no answer
 * are kept for the scenario's next cancelEvent (the dialog stays open for Retry).
 */
export function cancelEventAsTheDialogPresses(): (db: Db, params: unknown) => Promise<unknown> {
  const heldPresses = new Map<string, HeldPress>()
  return async (db, params) => {
    const sent = (params ?? {}) as CancelEventParams
    const cancelled = (await withSwitch(EVENT_CANCEL_KINDS_ON, () => throughStaffApp('cancelEvent')(db, { eventId: sent.eventId, refund: sent.refund, reason: typeof sent.reason === 'string' ? sent.reason.trim() : sent.reason }))) as EventAnswer
    // A refusal, or no answer: nothing is pressed, and the dialog shows the words.
    if (!cancelled.ok) return cancelled
    const waiting = new Map<string, HeldPress>()
    for (const [id, held] of heldPresses) waiting.set(id, held)
    for (const booking of cancelled.overview.bookings) {
      if (waiting.has(booking.eventBookingId)) continue
      waiting.set(booking.eventBookingId, { key: crypto.randomUUID(), refund: sent.refund, reason: typeof sent.reason === 'string' ? sent.reason.trim() : sent.reason, confirmed: booking.value, customerName: booking.customerName, places: booking.places })
    }
    const results: unknown[] = []
    for (const [eventBookingId, press] of waiting) {
      // The clock moves between presses, as the old side's moves with each statement (harness.ts, tick).
      vi.setSystemTime(Date.now() + 1)
      const row = { eventBookingId, customerName: press.customerName, places: press.places, cardRefundedAmount: 0, storeCreditRefundedAmount: 0 }
      let answer: PlacesAnswer
      try {
        answer = (await withSwitch(EVENT_CANCEL_KINDS_ON, () =>
          throughStaffApp('cancelEventPlaces')(db, { eventBookingId, refund: press.refund, reason: press.reason, wholeEvent: true, confirmed: { refund: press.confirmed }, idempotencyKey: press.key })
        )) as PlacesAnswer
      } catch (err) {
        heldPresses.set(eventBookingId, press)
        results.push({ ...row, ok: false, message: err instanceof Error && err.message ? `${BOOKING_NO_ANSWER_MESSAGE} (${err.message})` : BOOKING_NO_ANSWER_MESSAGE, noAnswer: true })
        continue
      }
      if (!answer || (!answer.ok && answer.noAnswer)) {
        heldPresses.set(eventBookingId, press)
        results.push({ ...row, ok: false, message: BOOKING_NO_ANSWER_MESSAGE, noAnswer: true })
        continue
      }
      heldPresses.delete(eventBookingId)
      if (!answer.ok) {
        results.push({ ...row, ok: false, message: [answer.message, answer.warning].filter(Boolean).join(' ') })
      } else {
        results.push({
          ...row,
          places: answer.places,
          ok: true,
          cardRefundedAmount: answer.cardRefundedAmount,
          storeCreditRefundedAmount: answer.storeCreditRefundedAmount,
          ...((answer.refundOwed ?? 0) > 0 ? { refundOwed: answer.refundOwed } : {}),
          ...(answer.warning ? { message: answer.warning } : {}),
        })
      }
      // A refund the Worker held is settled as reconcile settles it (it never sends one), as on the place side.
      await settleHeldEventRefund(db, eventBookingId)
    }
    return { ok: true, results }
  }
}

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
