// New in W18 (D-plan 1.9, 4.4): the two booking changes that move no money, setBookingSpecialRequests and
// setBookingStatus, each as one transaction: the booking locked and read (lockAndLoadBooking), the rule, then the
// audit row and the write. A refusal writes nothing. Neither moves money, so the switch doesn't gate them (W17 call 3).
import 'server-only'
import type { ApiErrorCode, BookingSpecialRequestsOutput, BookingStatusOutput } from '@/contracts'
import { audit } from '@/server/audit'
import { postgresRefusal, type Db, type Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import {
  CANCEL_CREDIT_WORDS,
  CARD_PAYMENT_OPEN_MESSAGE,
  invalidStatusMessage,
  READER_PAYMENT_OPEN_MESSAGE,
  STATUS_PAYMENT_NEEDED_MESSAGE,
  STATUS_TIME_CONFLICT_MESSAGE,
  STATUS_WORDS,
  staffSees,
} from './failure-messages'
import { lockAndLoadBooking, paymentOpen, type LoadedBooking } from './load-booking'

export interface EditOptions {
  actor: { type: 'staff'; id: string }
  requestId: string
}

/** The old function's limit: longer text is cut, not refused. */
export const SPECIAL_REQUESTS_MAX = 500

/**
 * N3 (D-plan section 3): the four statuses the status select offers. A booking awaiting payment or cancelled never
 * changes here, and nothing is moved into either: a cancel goes through Cancel & Refund or Cancel & return credit (so
 * its places and money go back), and a booking becomes payment needed only by lapsing.
 */
export const STAFF_STATUSES = ['pending', 'confirmed', 'completed', 'no-show'] as const

/** Trimmed, cut to 500 characters, and null when empty: as setBookingSpecialRequests saved it. */
export function normaliseSpecialRequests(text: string | null | undefined): string | null {
  return typeof text === 'string' && text.trim() !== '' ? text.trim().slice(0, SPECIAL_REQUESTS_MAX) : null
}

function refusal(code: ApiErrorCode, action: 'special_requests' | 'status', reason: string, message: string, extras: { field?: string } = {}): ApiError {
  return new ApiError(code, message, { ...extras, details: { reason, message, action } })
}

async function lockBooking(tx: Tx, bookingId: string): Promise<LoadedBooking | null> {
  // Only the booking (and its customer, which every booking change locks): neither change counts places.
  return (await lockAndLoadBooking(tx, { bookingId, ownSession: false }))?.booking ?? null
}

/** setBookingSpecialRequests: any booking that isn't cancelled (a cancelled booking's record is frozen). */
export async function setSpecialRequests(db: Db, bookingId: string, text: string | null | undefined, options: EditOptions): Promise<BookingSpecialRequestsOutput> {
  const specialRequests = normaliseSpecialRequests(text)
  return db.transaction(async (tx) => {
    const booking = await lockBooking(tx, bookingId)
    if (!booking) throw refusal('NOT_FOUND', 'special_requests', 'booking_not_found', staffSees('special_requests', 'booking_not_found'))
    if (booking.status === 'cancelled') {
      throw refusal('CONFLICT', 'special_requests', 'booking_cancelled', staffSees('special_requests', 'booking_cancelled'))
    }
    // The audit row first, so a failure after it (the write) takes it back too. The text itself stays on the booking.
    await audit.record(tx, {
      actorType: options.actor.type,
      actorId: options.actor.id,
      action: 'booking.special_requests',
      entityType: 'booking',
      entityId: bookingId,
      requestId: options.requestId,
      details: {
        changed: booking.specialRequests !== specialRequests,
        previousLength: booking.specialRequests?.length ?? null,
        length: specialRequests?.length ?? null,
      },
    })
    const [row] = await tx.query<{ id: string; special_requests: string | null }>(
      'UPDATE bookings SET special_requests = $1, updated_at = now() WHERE id = $2::uuid RETURNING id, special_requests',
      [specialRequests, bookingId]
    )
    if (!row) throw new Error(`Booking ${bookingId} was locked but not updated.`)
    return { updated: true, booking: { id: row.id, special_requests: row.special_requests } }
  })
}

const DUPLICATE_DAY_TEXT = 'This customer already has a booking on'

/**
 * setBookingStatus under N3: only to one of the four the select offers, and never from payment needed or cancelled,
 * nor while a payment is still being taken on the booking (W18 review S1).
 * Making a no-show or completed booking active again can meet the one-booking-a-day trigger or the overlap constraint;
 * both end the transaction, so they become refusals after it, with the trigger's own words or the overlap's.
 */
export async function setStatus(db: Db, bookingId: string, status: string, options: EditOptions): Promise<BookingStatusOutput> {
  if (!(STAFF_STATUSES as readonly string[]).includes(status)) {
    throw refusal('VALIDATION', 'status', 'invalid_status', invalidStatusMessage(status, STAFF_STATUSES), { field: 'status' })
  }
  try {
    return await db.transaction(async (tx) => {
      const booking = await lockBooking(tx, bookingId)
      if (!booking) throw refusal('NOT_FOUND', 'status', 'booking_not_found', CANCEL_CREDIT_WORDS.bookingNotFound)
      // A cancelled booking keeps its price_paid after its refund, so bringing one back would let that money go twice.
      if (booking.status === 'cancelled') throw refusal('CONFLICT', 'status', 'booking_cancelled', STATUS_WORDS.cancelled)
      if (booking.status === 'payment_needed') throw refusal('CONFLICT', 'status', 'booking_payment_needed', STATUS_PAYMENT_NEEDED_MESSAGE)
      // W18 review S1 (D-plan 4.2, held means held): while a payment is still being taken on the booking (a held Move,
      // Settle or Add Guest flow, or an order still being paid), its undo needs the status it left. A held Settle has
      // already set the booking confirmed with the amount in price_paid, so changing the status now could leave a
      // refundable price_paid for money never taken. The old setBookingStatus allowed it.
      if (paymentOpen(booking)) {
        const cardOnly = booking.openFlows.length > 0 && booking.openFlows.every((flow) => flow.method === 'card')
        throw cardOnly
          ? refusal('CONFLICT', 'status', 'card_payment_open', CARD_PAYMENT_OPEN_MESSAGE)
          : refusal('CONFLICT', 'status', 'reader_payment_open', READER_PAYMENT_OPEN_MESSAGE)
      }
      await audit.record(tx, {
        actorType: options.actor.type,
        actorId: options.actor.id,
        action: 'booking.status',
        entityType: 'booking',
        entityId: bookingId,
        requestId: options.requestId,
        details: { from: booking.status, to: status },
      })
      // cancelled_at as the old function wrote it for any status but cancelled.
      const [row] = await tx.query<{ id: string; status: string }>(
        'UPDATE bookings SET status = $1, updated_at = now(), cancelled_at = NULL WHERE id = $2::uuid RETURNING id, status',
        [status, bookingId]
      )
      if (!row) throw new Error(`Booking ${bookingId} was locked but not updated.`)
      return { id: row.id, status: row.status, cancelled_at: null }
    })
  } catch (err) {
    const refused = postgresRefusal(err)
    if (refused?.code === 'P0001' && refused.message.startsWith(DUPLICATE_DAY_TEXT)) {
      throw refusal('DAY_ALREADY_BOOKED', 'status', 'duplicate_day_booking', refused.message)
    }
    if (refused?.constraint === 'bookings_no_cross_session_overlap') throw refusal('CONFLICT', 'status', 'time_conflict', STATUS_TIME_CONFLICT_MESSAGE)
    throw err
  }
}
