// Ported from backend/paddock/createBooking.ts: the writes. Its checks are in basket-booking.ts (W05),
// which T1 runs first, on rows place-order.ts has already locked.
import 'server-only'
import type { BasketSeat } from '@/contracts'
import type { Tx } from '@/server/db'
import { bookingRefusal } from './order-refusal'

export type PayBy = BasketSeat['payBy']

export interface SeatToWrite {
  guestType: 'account_holder' | 'additional_guest'
  /** Trimmed. */
  name: string
  email: string | null
  /** The account holder's only: guests give none. */
  dateOfBirth: string | null
  /** quote_booking's price for the seat, as it gave it. Null on a private booking, priced as a whole. */
  unitPrice: string | null
  payBy: PayBy
}

export interface BookingToWrite {
  sessionId: string
  customerId: string
  bookingType: 'public' | 'private'
  /** The money seats, before any promo. A private booking's whole price. */
  pricePaid: number
  /** What the booking is recorded as, once a credit that can't apply has fallen back to paid. */
  redemptionSource: PayBy
  redeemedMembershipId: string | null
  redeemedSessionPassId: string | null
  /** Seat 1 on a membership credit: the period it spends from. The guarded insert re-checks it. */
  creditPeriodId: string | null
  /** Seat 1 on a pass: the pass a session is taken from. */
  passToClaim: string | null
  /** The session's band: quote_booking gives the same for every seat. */
  bandId: string | null
  /** Trimmed, at most 500 characters, null when empty. */
  specialRequests: string | null
  /** In the order given: seat 1 is the account holder. */
  seats: readonly SeatToWrite[]
}

/**
 * The booking in one statement: the place (a private session takes all of it), the pass session,
 * the booking, then a row per seat. Each claim is a guarded UPDATE that re-checks inside itself, and
 * the booking is only written when they hold. The seats get created_at from the clock, a millisecond
 * apart in seat order, because now() doesn't move inside a transaction and the screens read seats
 * `ORDER BY created_at, id` with the account holder first (W03-plan 2.4 item 7). A millisecond, not
 * a microsecond, because the drivers read times to the millisecond: closer rows would read as tied.
 *
 * T1 has locked the session, the credit period and the pass and checked them before this runs, so
 * a claim that fails here means something changed that the locks should have stopped. Each one is
 * still refused with createBooking's reason, and the transaction rolls back.
 *
 * The one difference from createBooking: when the guarded insert finds no credit, createBooking wrote
 * the seat as paid instead. Under the period lock that can't happen, and paying for the seat then
 * would take a figure the order has already checked against what staff confirmed, so it is refused.
 */
const BOOKING_SQL = `
WITH clock AS (SELECT clock_timestamp() AS at),
capacity AS (
  UPDATE sessions
  SET total_booked = CASE WHEN $2::text = 'private' THEN capacity ELSE total_booked + $3::int END, updated_at = now()
  WHERE id = $1::uuid AND status = 'open'
    AND CASE WHEN $2::text = 'private' THEN total_booked = 0 ELSE (capacity - total_booked) >= $3::int END
  RETURNING id, start_time, end_time
),
pass AS (
  UPDATE customer_session_passes
  SET sessions_remaining = sessions_remaining - 1, updated_at = now()
  WHERE id = $4::uuid AND sessions_remaining >= 1
    AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date
    AND pass_covers_session(pass_type_id, $1::uuid)
    AND EXISTS (SELECT 1 FROM capacity)
  RETURNING id
),
booking AS (
  INSERT INTO bookings
    (session_id, customer_id, party_size, status, price_paid, redemption_source, start_time, end_time,
     redeemed_membership_id, redeemed_session_pass_id, band_id, credit_period_id, special_requests,
     guests_over_18_confirmed_at)
  SELECT capacity.id, $5::uuid, $3::int, 'confirmed', $6::numeric, $7::text, capacity.start_time, capacity.end_time,
         $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::text, CASE WHEN $3::int > 1 THEN now() END
  FROM capacity
  WHERE ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM pass))
    AND ($11::uuid IS NULL OR EXISTS (
      SELECT 1
      FROM membership_credit_periods p
      JOIN customer_memberships cm ON cm.id = p.membership_id
      WHERE p.id = $11::uuid
        AND cm.subscription_status = 'active'
        AND (cm.cancel_effective_date IS NULL OR cm.cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)
        AND (p.is_unlimited OR (
          SELECT count(*) FROM bookings b
          WHERE b.credit_period_id = p.id AND b.redemption_source = 'membership_credit' AND b.status <> 'cancelled'
        ) < p.credits_allocated)))
  RETURNING id
),
seats AS (
  INSERT INTO booking_guests (booking_id, guest_type, guest_name, guest_email, date_of_birth, waiver_accepted, unit_price, pay_by, created_at)
  SELECT booking.id, g.guest_type, g.guest_name, g.guest_email, g.date_of_birth, false, g.unit_price, g.pay_by,
         clock.at + g.seat_no * interval '1 millisecond'
  FROM booking
  CROSS JOIN clock
  CROSS JOIN jsonb_to_recordset($13::jsonb)
    AS g(seat_no int, guest_type text, guest_name text, guest_email text, date_of_birth date, unit_price numeric, pay_by text)
  RETURNING id
)
SELECT EXISTS (SELECT 1 FROM capacity) AS capacity_claimed,
       EXISTS (SELECT 1 FROM pass) AS pass_claimed,
       (SELECT id FROM booking) AS booking_id,
       (SELECT count(*)::int FROM seats) AS seats_written,
       (SELECT pass_covers_session(pass_type_id, $1::uuid) FROM customer_session_passes WHERE id = $4::uuid) AS pass_covers,
       (SELECT sessions_remaining >= 1 AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date
        FROM customer_session_passes WHERE id = $4::uuid) AS pass_usable`

interface BookingWritten {
  capacity_claimed: boolean
  pass_claimed: boolean
  booking_id: string | null
  seats_written: number
  pass_covers: boolean | null
  pass_usable: boolean | null
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** Writes the booking and its seats, and returns its id. Throws createBooking's refusal if a claim fails. */
export async function writeBooking(tx: Tx, booking: BookingToWrite): Promise<string> {
  const seats = booking.seats.map((seat, i) => ({
    seat_no: i + 1,
    guest_type: seat.guestType,
    guest_name: seat.name,
    guest_email: seat.email,
    date_of_birth: seat.dateOfBirth,
    unit_price: seat.unitPrice,
    pay_by: seat.payBy,
  }))
  const rows = await tx.query<BookingWritten>(BOOKING_SQL, [
    booking.sessionId,
    booking.bookingType,
    booking.seats.length,
    booking.passToClaim,
    booking.customerId,
    round2(booking.pricePaid),
    booking.redemptionSource,
    booking.redeemedMembershipId,
    booking.redeemedSessionPassId,
    booking.bandId,
    booking.creditPeriodId,
    booking.specialRequests,
    seats,
  ])
  const written = rows[0] as BookingWritten

  if (!written.capacity_claimed) throw bookingRefusal('insufficient_capacity')
  if (booking.passToClaim && !written.pass_claimed) {
    if (written.pass_usable === true && written.pass_covers === false) {
      // pass_covers_session is also false for a public session with no band: say so plainly.
      throw bookingRefusal(
        'session_pass_not_valid_for_band',
        booking.bandId
          ? "This is a Core pass, which can't be used for Peak sessions. Choose another way to pay."
          : "This session has no time band set, so a pass can't be used. Set the session's band or choose another way to pay."
      )
    }
    throw bookingRefusal('insufficient_session_pass_credit')
  }
  if (booking.creditPeriodId && !written.booking_id) throw bookingRefusal('insufficient_membership_credit')
  if (!written.booking_id || written.seats_written !== booking.seats.length) {
    throw new Error(`The booking was not written whole: ${written.booking_id ? `${written.seats_written} of ${booking.seats.length} seats` : 'no booking row'}.`)
  }
  return written.booking_id
}
