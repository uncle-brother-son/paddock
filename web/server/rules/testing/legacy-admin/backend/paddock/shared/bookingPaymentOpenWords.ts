import { NO_READER_PAYMENT_OPEN, READER_PAYMENT_OPEN_MESSAGE } from './readerPaymentOpen'

/**
 * Brief W19a (W19 review S2): the Worker's words for a held saved-card flow (failure-messages.ts
 * CARD_PAYMENT_OPEN_MESSAGE), word for word. A saved-card flow has no finish or cancel button, so the reader words
 * ("Finish or cancel it first") would send staff looking for one.
 */
export const CARD_PAYMENT_OPEN_MESSAGE =
  "A card payment on this booking is still being checked. Don't take payment again: use Resolve now on the Orders page after 15 minutes."

/**
 * Read-only: what the booking detail tells staff while a payment is still being taken on the booking, or null when
 * none is. The card words when every open flow on it is one the Worker started on a saved card (method 'card' with
 * its request id, as the Worker's load-booking.ts reads it); the reader words otherwise, including an order still
 * being paid with no flow open. Kept out of readerPaymentOpen.ts so the frozen functions that import it are unchanged.
 */
export async function bookingPaymentOpenMessage(bookingId: string): Promise<string | null> {
  const rows = await paddockData.query<{ open: boolean; card_only: boolean }>(
    `SELECT NOT (${NO_READER_PAYMENT_OPEN}) AS open,
            COALESCE((
              SELECT bool_and(p.snapshot->>'method' = 'card' AND (p.snapshot->>'request_id') IS NOT NULL)
              FROM pending_reader_payments p
              WHERE p.record_id = b.id AND p.flow IN ('move', 'settle', 'add_guest') AND p.status = 'pending'
            ), false) AS card_only
     FROM bookings b WHERE b.id = $1`,
    [bookingId]
  )
  const row = rows.data[0]
  if (row?.open !== true) return null
  return row.card_only === true ? CARD_PAYMENT_OPEN_MESSAGE : READER_PAYMENT_OPEN_MESSAGE
}
