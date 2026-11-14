import { quoteEventCancellation, round2, type CancelPlacesFailureReason } from './shared/eventCancellationQuote'
import { loadOrderCardPortion } from './shared/orderCardPortion'

export interface GetEventCancellationQuoteParams {
  eventBookingId: string
  /** The places to cancel; omit for every remaining place in the booking. */
  attendeeIds?: string[]
}

export type GetEventCancellationQuoteResult =
  | {
      ok: true
      places: number
      wholeBooking: boolean
      /** What the places are worth now (event_cancellation_quote) — the refund in full. */
      value: number
      refundCutoffAt: string | null
      beforeCutoff: boolean
      eventStarted: boolean
      /** Where a Card refund would go: the card part (capped at the order's card portion still
       *  refundable, 0 with no card on the order) and the rest to store credit. */
      cardAmount: number
      storeCreditAmount: number
    }
  | { ok: false; reason: CancelPlacesFailureReason; message: string }

/** Read-only preview for the Cancel place / Cancel booking dialog (all staff). The cancellation
 *  re-quotes when it runs. */
export default async function getEventCancellationQuote(
  req: { params: GetEventCancellationQuoteParams }
): Promise<GetEventCancellationQuoteResult> {
  const { eventBookingId, attendeeIds } = req.params
  const quoted = await quoteEventCancellation(eventBookingId, attendeeIds)
  if (!quoted.ok) return quoted
  const quote = quoted.quote

  let cardAmount = 0
  if (quote.value > 0) {
    const line = await paddockData.query<{ order_id: string }>(
      `SELECT order_id FROM order_line_items WHERE event_booking_id = $1 AND item_type = 'event' LIMIT 1`,
      [eventBookingId]
    )
    const orderId = line.data[0]?.order_id
    const portion = orderId ? await loadOrderCardPortion(orderId) : null
    if (portion?.paymentIntentId) cardAmount = round2(Math.min(quote.value, portion.cardPortionRemaining))
  }
  return {
    ok: true,
    places: quote.places,
    wholeBooking: quote.whole_booking,
    value: quote.value,
    refundCutoffAt: quote.refund_cutoff_at,
    beforeCutoff: quote.before_cutoff,
    eventStarted: quote.event_started,
    cardAmount,
    storeCreditAmount: round2(quote.value - cardAmount),
  }
}
