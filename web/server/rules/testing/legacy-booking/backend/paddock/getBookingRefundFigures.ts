import { loadBookingMoneyLeft, type BookingMoneyLeft } from './shared/bookingMoneyLeft'

export interface GetBookingRefundFiguresParams {
  bookingId: string
}

/** Read-only: what the Part refund and Refund the rest dialogs show. refundBooking checks the same
 *  figures again when staff confirm. */
export default async function getBookingRefundFigures(
  req: { params: GetBookingRefundFiguresParams }
): Promise<BookingMoneyLeft> {
  const figures = await loadBookingMoneyLeft(req.params.bookingId)
  if (!figures) throw new Error('Booking not found.')
  return figures
}
