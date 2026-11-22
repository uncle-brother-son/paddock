import { vi } from 'vitest'
import type { Db } from '@/server/db'
import { throughStaffApp, withSwitch } from './booking-presses'
import { EVENT_CANCEL_KINDS_ON, settleHeldEventRefund } from './event-places-presses'

/*
 * W64 (H-plan 3.3 step 3): the Cancel event dialog's presses (W31, W52), as the screen presses them, moved here unchanged from
 * `replay/whole-event-side.ts` so the all-Worker sweep and the Worker's own rule tests can press the Worker with nothing of the
 * old code loaded. The replay side re-exports all of it; what it keeps is its old side and its comparisons (W65).
 */

/** The two old actions W31 gives to the Worker. */
export const WHOLE_EVENT_ACTIONS: ReadonlySet<string> = new Set(['cancelEvent', 'getEventCancellationOverview'])

export type CancelEventParams = { eventId?: string; refund?: string; reason?: string }
export type OverviewBooking = { eventBookingId: string; customerName: string; places: number; value: number; problem?: string | null }
export type EventAnswer = { ok: true; overview: { bookings: OverviewBooking[] } } | { ok: false; reason: string; message: string; noAnswer?: boolean }
export type PlacesAnswer =
  | { ok: true; places: number; cardRefundedAmount: number; storeCreditRefundedAmount: number; refundOwed?: number; warning?: string }
  | { ok: false; reason: string; message: string; warning?: string; noAnswer?: boolean }
  | null

/** The dialog's own words for a booking whose press got no answer (a copy of CancelEventDialog.tsx's; a test holds the two together). */
export const BOOKING_NO_ANSWER_MESSAGE =
  "No answer came back, so this booking may or may not have been cancelled and refunded. Don't refund it by hand: press Retry (it won't cancel or refund twice)."

/** One booking's press as it was first sent: after no answer it is sent again exactly so, under the same key. */
export interface HeldPress {
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
 *
 * W52 (W35 audit rows 23 and 25): as the dialog now does, the overview is read again after every press, and a press
 * sent again under its first key that comes back a refusal, while the fresh overview still lists the booking with
 * nothing in its way, is pressed once more in the same run as a new press with the figure as it now stands (the
 * staff app's utils/eventCancelRun.ts, pressAgainAfterHeldPress). The dialog's two display marks on a row (`held`,
 * `settledSince`) are the screen's own and are not part of the row here, which stays in the old function's fields.
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
    /** One booking's press, and its row as the dialog lists it. `definite`: an answer came back (the key is dropped). */
    const pressBooking = async (eventBookingId: string, press: HeldPress): Promise<{ row: Record<string, unknown>; definite: boolean; ok: boolean }> => {
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
        return { row: { ...row, ok: false, message: err instanceof Error && err.message ? `${BOOKING_NO_ANSWER_MESSAGE} (${err.message})` : BOOKING_NO_ANSWER_MESSAGE, noAnswer: true }, definite: false, ok: false }
      }
      if (!answer || (!answer.ok && answer.noAnswer)) {
        heldPresses.set(eventBookingId, press)
        return { row: { ...row, ok: false, message: BOOKING_NO_ANSWER_MESSAGE, noAnswer: true }, definite: false, ok: false }
      }
      heldPresses.delete(eventBookingId)
      if (!answer.ok) return { row: { ...row, ok: false, message: [answer.message, answer.warning].filter(Boolean).join(' ') }, definite: true, ok: false }
      return {
        row: {
          ...row,
          places: answer.places,
          ok: true,
          cardRefundedAmount: answer.cardRefundedAmount,
          storeCreditRefundedAmount: answer.storeCreditRefundedAmount,
          ...((answer.refundOwed ?? 0) > 0 ? { refundOwed: answer.refundOwed } : {}),
          ...(answer.warning ? { message: answer.warning } : {}),
        },
        definite: true,
        ok: true,
      }
    }
    /** W52: the overview read again, as the dialog reads it after every press; null when the read fails (the run carries on with the one it has). */
    const readOverview = async (): Promise<{ bookings: OverviewBooking[] } | null> => {
      try {
        const overview = (await withSwitch(EVENT_CANCEL_KINDS_ON, () => throughStaffApp('getEventCancellationOverview')(db, { eventId: sent.eventId }))) as { bookings?: OverviewBooking[] } | null
        return overview && Array.isArray(overview.bookings) ? { bookings: overview.bookings } : null
      } catch {
        return null
      }
    }

    const results: unknown[] = []
    let latest: { bookings: OverviewBooking[] } = cancelled.overview
    for (const [eventBookingId, press] of waiting) {
      const wasHeld = heldPresses.has(eventBookingId)
      let pressed = await pressBooking(eventBookingId, press)
      // A refund the Worker held is settled as reconcile settles it (it never sends one), as on the place side.
      if (pressed.definite) await settleHeldEventRefund(db, eventBookingId)
      latest = (await readOverview()) ?? latest
      // W52 (row 25): a press sent again under its first key that came back a refusal, and the booking is still to cancel.
      const listedNow = latest.bookings.find((booking) => booking.eventBookingId === eventBookingId)
      if (wasHeld && pressed.definite && !pressed.ok && listedNow && (listedNow.problem ?? null) === null) {
        pressed = await pressBooking(eventBookingId, { key: crypto.randomUUID(), refund: sent.refund, reason: typeof sent.reason === 'string' ? sent.reason.trim() : sent.reason, confirmed: listedNow.value, customerName: listedNow.customerName, places: listedNow.places })
        if (pressed.definite) await settleHeldEventRefund(db, eventBookingId)
        latest = (await readOverview()) ?? latest
      }
      results.push(pressed.row)
    }
    return { ok: true, results }
  }
}
