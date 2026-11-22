import type { Db } from '@/server/db'
import { reconcileClaimNow } from '@/server/rules/orders/reconcile'
import { EVENT_BOOKING_CLAIMS, openClaimOn } from '@/server/rules/refunds/pipeline'
import { BOOKING_KINDS_ON, pressInFlight, throughStaffApp, withSwitch } from './booking-presses'
import { replayStripe } from '../replay/stripe-binding'

/*
 * W64 (H-plan 3.3 step 3): an event place cancel's presses (W30), as the screen presses them, moved here unchanged from
 * `replay/event-places-side.ts` so the all-Worker sweep and the Worker's own rule tests can press the Worker with nothing of the
 * old code loaded. The replay side re-exports all of it; what it keeps is its old side and its comparisons (W65).
 */

/** ORDER_SWITCH as it will be live once Wayne adds `event_cancels` (W27's kind; off with today's secret). */
export const EVENT_CANCEL_KINDS_ON = `${BOOKING_KINDS_ON},order_refunds,event_cancels`

/** The two old actions W30 gives to the Worker. */
export const EVENT_PLACE_ACTIONS: ReadonlySet<string> = new Set(['cancelEventPlaces', 'getEventCancellationQuote'])

export type CancelParams = { eventBookingId?: string; attendeeIds?: string[]; refund?: string; reason?: string }
export type QuoteAnswer = { ok?: boolean; value?: number } | null

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Which places a dialog was opened for: the chosen ones, or the whole booking. */
export const dialogFor = (eventBookingId: string, attendeeIds: readonly string[] | undefined): string => `${eventBookingId}|${attendeeIds ? [...attendeeIds].sort().join(',') : 'all'}`

/**
 * A cancel the Worker held: staff check the Orders page, where reconcile has settled it, before they do anything else
 * to the booking. The replay settles it as reconcile does (it never sends a refund) straight after the press, and
 * again before the booking's next step.
 */
export async function settleHeldEventRefund(db: Db, eventBookingId: string | undefined): Promise<void> {
  if (!eventBookingId || !replayStripe.current || pressInFlight.on || !UUID.test(eventBookingId)) return
  const held = await openClaimOn(db, EVENT_BOOKING_CLAIMS, eventBookingId)
  if (held) await reconcileClaimNow(db, replayStripe.current, held, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID() })
}

/**
 * The two actions as the Cancel place / Cancel booking dialog presses them (brief W30 item 6). The dialog loads the
 * Worker's quote when it opens and sends the refund it shows back as `confirmed` (Q18: £0 for No refund; the old
 * params had no figure), with a press key kept after a press that got no answer until the dialog closes, and the
 * switch on.
 *
 * Where a scenario asks for the quote itself and then presses for the same places, that quote is the one the dialog
 * is showing (it was opened then), whatever happened in between: that is bug E9's recording. With no quote asked for,
 * the dialog was opened just before the press. With no quote to show (the booking is gone, or refused), the press goes
 * with £0 and the Worker answers for the booking.
 */
export function eventPlacesAsTheDialogPresses(options: { settleHeld?: boolean } = {}): { quote(db: Db, params: unknown): Promise<unknown>; cancel(db: Db, params: unknown): Promise<unknown> } {
  /** The refund a dialog opened by the scenario's own quote call is showing. */
  const shown = new Map<string, number>()
  /** The key of a press that got no answer, with the refund the dialog is still showing (it stays open). */
  const heldKeys = new Map<string, { key: string; refund: number }>()
  const askQuote = (db: Db, params: unknown) => withSwitch(EVENT_CANCEL_KINDS_ON, () => throughStaffApp('getEventCancellationQuote')(db, params))
  return {
    async quote(db, params) {
      const sent = (params ?? {}) as CancelParams
      const answer = (await askQuote(db, params)) as QuoteAnswer
      if (sent.eventBookingId && answer?.ok === true && typeof answer.value === 'number') shown.set(dialogFor(sent.eventBookingId, sent.attendeeIds), answer.value)
      return answer
    },
    async cancel(db, params) {
      const sent = (params ?? {}) as CancelParams
      const eventBookingId = sent.eventBookingId ?? ''
      const dialog = dialogFor(eventBookingId, sent.attendeeIds)
      const held = heldKeys.get(dialog)
      let value = held?.refund ?? shown.get(dialog)
      shown.delete(dialog)
      if (value === undefined && eventBookingId) {
        try {
          const fresh = (await askQuote(db, { eventBookingId, ...(sent.attendeeIds ? { attendeeIds: sent.attendeeIds } : {}) })) as QuoteAnswer
          value = fresh?.ok === true && typeof fresh.value === 'number' ? fresh.value : 0
        } catch {
          // No quote: nothing to show, so £0 is sent and the Worker answers for the booking.
          value = 0
        }
      }
      // What the dialog's choice gives back: nothing for No refund, the places' value otherwise.
      const refund = held ? held.refund : sent.refund === 'none' ? 0 : (value ?? 0)
      const idempotencyKey = held?.key ?? crypto.randomUUID()
      const answer = (await withSwitch(EVENT_CANCEL_KINDS_ON, () => throughStaffApp('cancelEventPlaces')(db, { ...sent, confirmed: { refund }, idempotencyKey }))) as { noAnswer?: boolean } | null
      if (answer?.noAnswer) heldKeys.set(dialog, { key: idempotencyKey, refund })
      else heldKeys.delete(dialog)
      if (options.settleHeld !== false) await settleHeldEventRefund(db, eventBookingId)
      return answer
    },
  }
}
