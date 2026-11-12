/**
 * Read-only: whether a payment is still being taken on a booking. Until it finishes, price_paid can
 * hold money nobody has paid, so refunding it would give away money that was never collected, and
 * a cancelled move puts the booking back as it was. Rows left open are closed by
 * sweepPendingReaderPayments.
 */
export const READER_PAYMENT_OPEN_MESSAGE =
  'A card reader payment is still open on this booking. Finish or cancel it first, or use Resolve now on the Orders page after 15 minutes.'

/**
 * SQL for a booking aliased `b`, true when nothing is being paid on it: no move, settle or guest on
 * the reader, and no order still being paid. A checkout's order is pending before its reader
 * payment is written, so a young pending order counts too; the 15 minutes is the reader's own
 * window (Q14), so an order that never finished can't block the booking for ever.
 *
 * Inside a statement that writes the booking this closes the gap between checking and acting, with
 * one limit. A statement that waited for the booking's row sees other tables as they were when it
 * started, so a reader that committed during the wait isn't seen here. A flow that opens a reader
 * nearly always changes price_paid in the same statement as its pending row, so the statement must
 * also compare price_paid with the figure it read: Postgres checks that against the newest row.
 *
 * The exceptions are add-ons alone, and a free guest with paid add-ons: their reader doesn't touch
 * price_paid, so a claim that waited can slip past one by milliseconds. No money is lost: the add-on
 * can still be refunded, on the cancelled booking too.
 */
export const NO_READER_PAYMENT_OPEN = `NOT EXISTS (
         SELECT 1 FROM pending_reader_payments prp
         WHERE prp.record_id = b.id AND prp.flow IN ('move', 'settle', 'add_guest') AND prp.status = 'pending'
       ) AND NOT EXISTS (
         SELECT 1 FROM orders paying
         JOIN order_line_items paying_line ON paying_line.order_id = paying.id
         WHERE paying_line.booking_id = b.id AND paying.payment_status = 'pending'
           AND (paying.reader_payment->>'payment_intent_id' IS NOT NULL OR paying.created_at > now() - interval '15 minutes')
       )`

export async function anyReaderPaymentOpenOnBooking(bookingId: string): Promise<boolean> {
  const open = await paddockData.query<{ open: boolean }>(
    `SELECT NOT (${NO_READER_PAYMENT_OPEN}) AS open FROM bookings b WHERE b.id = $1`,
    [bookingId]
  )
  return open.data[0]?.open === true
}
