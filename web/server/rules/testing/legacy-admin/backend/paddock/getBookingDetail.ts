import { bookingPaymentOpenMessage } from './shared/bookingPaymentOpenWords'

export interface BookingGuestRow {
  id: string
  booking_id: string
  guest_name: string
  guest_email: string | null
  guest_type: string
  date_of_birth: string | null
  waiver_accepted: boolean | null
  waiver_accepted_at: string | null
  waiver_method: string | null
  waiver_version: string | null
  reminder_sent_at: string | null
  created_at: string
  /** What this seat pays under band pricing — null on bookings recorded before per-seat pricing. */
  unit_price: string | null
  /** How the seat is covered: 'paid', 'membership_credit', 'session_pass_credit', 'gift_card' —
   *  null on bookings recorded before per-seat pricing. */
  pay_by: string | null
}

export interface BookingAddonLineRow {
  id: string
  booking_id: string
  addon_id: string
  addon_name: string
  quantity: number
  price_at_purchase: string
  sku_at_purchase: string
  redemption_source: string | null
  prepared: boolean
  prepared_at: string | null
  prepared_by: string | null
  created_at: string
  /** Membership whose add-on credit paid for it (redemption_source 'membership_credit'). */
  redeemed_membership_id: string | null
  /** Set when the add-on was cancelled (kept for history, shown greyed as "Removed"). */
  removed_at: string | null
  removed_by_name: string | null
  refunded_amount: string
  card_refunded_amount: string
  refund_method: 'card' | 'credit' | 'none' | 'credit_returned' | null
  /** The order that paid for this add-on took a card payment (so a refund can go back to card). */
  order_has_card: boolean
}

export interface GetBookingDetailParams {
  bookingId: string
}

export interface BookingDetail {
  guests: BookingGuestRow[]
  addonLines: BookingAddonLineRow[]
  /** The booking's special requests (dietary/accessibility needs etc.) — null when none. */
  specialRequests: string | null
  /** Money still to give back after a failed refund, for "Refund the rest". */
  refundOwedAmount: string
  /** What staff are told when a payment is still being taken on the booking, or null: the card words when every
   *  open flow is a saved-card one (W19a), the reader words otherwise. The refund, move and guest buttons are greyed
   *  with this as their tooltip; the server refuses them anyway. */
  readerPaymentOpenMessage: string | null
}

export default async function getBookingDetail(req: { params: GetBookingDetailParams }): Promise<BookingDetail> {
  const { bookingId } = req.params

  const [guests, addonLines, bookingRow, paymentOpenMessage] = await Promise.all([
    paddockData.query<BookingGuestRow>(
      `SELECT id, booking_id, guest_name, guest_email, guest_type, date_of_birth, waiver_accepted,
              waiver_accepted_at, waiver_method, waiver_version, reminder_sent_at, created_at,
              unit_price, pay_by
       FROM booking_guests WHERE booking_id = $1 ORDER BY created_at, id`,
      [bookingId]
    ),
    paddockData.query<BookingAddonLineRow>(
      `SELECT aol.id, aol.booking_id, aol.addon_id, a.name AS addon_name, aol.quantity,
              aol.price_at_purchase, aol.sku_at_purchase, aol.redemption_source, aol.prepared,
              aol.prepared_at, aol.prepared_by, aol.created_at, aol.redeemed_membership_id, aol.removed_at,
              NULLIF(trim(concat_ws(' ', s.first_name, s.last_name)), '') AS removed_by_name,
              aol.refunded_amount, aol.card_refunded_amount, aol.refund_method,
              COALESCE(o.stripe_payment_intent_id IS NOT NULL, false) AS order_has_card
       FROM addon_order_lines aol
       LEFT JOIN orders o ON o.id = aol.order_id
       JOIN addons a ON a.id = aol.addon_id
       LEFT JOIN staff s ON s.id = aol.removed_by
       WHERE aol.booking_id = $1
       ORDER BY aol.created_at`,
      [bookingId]
    ),
    paddockData.query<{ special_requests: string | null; refund_owed_amount: string }>(
      'SELECT special_requests, refund_owed_amount FROM bookings WHERE id = $1',
      [bookingId]
    ),
    bookingPaymentOpenMessage(bookingId),
  ])

  return {
    guests: guests.data,
    addonLines: addonLines.data,
    specialRequests: bookingRow.data[0]?.special_requests ?? null,
    refundOwedAmount: bookingRow.data[0]?.refund_owed_amount ?? '0',
    readerPaymentOpenMessage: paymentOpenMessage,
  }
}
