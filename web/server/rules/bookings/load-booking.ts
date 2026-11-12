// New in W17 (D-plan 4.1): the lookups at the top of each old step D function (moveBooking, addBookingGuest,
// settleLapsedBooking, removeBookingGuest, refundBooking, cancelCreditBooking, removeBookingAddon and the two setters),
// as one read: the booking, its seats, its session and type, what is open on it, and its refund figures. Inside a
// change's transaction it locks first (lockForBooking, in LOCK_ORDER), so what it reads is current until commit.
import 'server-only'
import type { Queryable, Tx } from '@/server/db'
import { lockForBooking, type BookingLockTargets, type HeldBookingLocks } from './locks'
import { loadBookingMoneyLeft, type BookingMoneyLeft } from './money-left'

/** The six statuses a booking can have (bookings.status). */
export const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'no-show', 'payment_needed'] as const
export type BookingStatus = (typeof BOOKING_STATUSES)[number]

export interface BookingSeat {
  id: string
  /** 'account_holder' for seat 1, else 'additional_guest'. */
  guestType: string
  guestName: string
  guestEmail: string | null
  dateOfBirth: string | null
  /** The seat's price when it was booked or last moved; null on private and pre-band seats. */
  unitPrice: number | null
  payBy: string | null
  createdAt: string
}

export interface BookingSession {
  id: string
  serviceTypeId: string
  /** The service type's: 'public' or 'private'. */
  bookingType: string
  startTime: string
  endTime: string
  capacity: number
  totalBooked: number
  status: string
  bandId: string | null
}

/**
 * A pending pending_reader_payments row on the booking (a Move, Settle or Add Guest flow not yet finished or undone).
 * `method` is the Worker's (`card` or `reader`, with a request id); null for a flow the old screens started. Any of
 * them holds the booking: the old code's NO_READER_PAYMENT_OPEN counts every pending row, and so does the Worker.
 */
export interface OpenFlow {
  id: string
  flow: string
  method: 'card' | 'reader' | null
  createdAt: string
}

export interface LoadedBooking {
  id: string
  customerId: string
  sessionId: string
  status: string
  partySize: number
  pricePaid: number
  partRefunded: number
  refundOwed: number
  redemptionSource: string | null
  redeemedMembershipId: string | null
  redeemedSessionPassId: string | null
  creditPeriodId: string | null
  bandId: string | null
  startTime: string | null
  endTime: string | null
  paymentDueBy: string | null
  specialRequests: string | null
  cancelledAt: string | null
  updatedAt: string
  session: BookingSession
  /** Seat 1 first: the first guest row (created_at, then id), as Settle and Cancel & return credit read it. */
  seats: BookingSeat[]
  openFlows: OpenFlow[]
  /**
   * A pending order paying for this booking that still counts as open: one with a reader intent, or one under 15
   * minutes old (the old NO_READER_PAYMENT_OPEN's second half).
   */
  orderBeingPaid: boolean
  figures: BookingMoneyLeft
}

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value))
const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value))
const amount = (value: string | null): number => Number.parseFloat(value ?? '0')

const BOOKING_SQL = `
SELECT b.id, b.customer_id, b.session_id, b.status, b.party_size, b.price_paid::text AS price_paid,
       b.part_refunded_amount::text AS part_refunded_amount, b.refund_owed_amount::text AS refund_owed_amount,
       b.redemption_source, b.redeemed_membership_id, b.redeemed_session_pass_id, b.credit_period_id, b.band_id,
       b.start_time, b.end_time, b.payment_due_by, b.special_requests, b.cancelled_at, b.updated_at,
       s.service_type_id, st.booking_type, s.start_time AS session_start, s.end_time AS session_end, s.capacity,
       s.total_booked, s.status AS session_status, s.band_id AS session_band_id,
       EXISTS (
         SELECT 1 FROM orders paying
         JOIN order_line_items paying_line ON paying_line.order_id = paying.id
         WHERE paying_line.booking_id = b.id AND paying.payment_status = 'pending'
           AND (paying.reader_payment->>'payment_intent_id' IS NOT NULL OR paying.created_at > now() - interval '15 minutes')
       ) AS order_being_paid
FROM bookings b
JOIN sessions s ON s.id = b.session_id
JOIN service_types st ON st.id = s.service_type_id
WHERE b.id = $1::uuid`

type BookingRow = {
  id: string
  customer_id: string
  session_id: string
  status: string
  party_size: number
  price_paid: string | null
  part_refunded_amount: string
  refund_owed_amount: string
  redemption_source: string | null
  redeemed_membership_id: string | null
  redeemed_session_pass_id: string | null
  credit_period_id: string | null
  band_id: string | null
  start_time: unknown
  end_time: unknown
  payment_due_by: unknown
  special_requests: string | null
  cancelled_at: unknown
  updated_at: unknown
  service_type_id: string
  booking_type: string
  session_start: unknown
  session_end: unknown
  capacity: number
  total_booked: number
  session_status: string
  session_band_id: string | null
  order_being_paid: boolean
}

/** A flow the Worker started names its method and request id (as reader-flow.ts's isWorkerFlow, card included). */
const workerMethod = (method: string | null, requestId: string | null): OpenFlow['method'] =>
  requestId !== null && (method === 'card' || method === 'reader') ? method : null

/** The booking as a change reads it, or null when it doesn't exist. Locks nothing: lockAndLoadBooking locks first. */
export async function loadBooking(db: Queryable, bookingId: string): Promise<LoadedBooking | null> {
  const row = (await db.query<BookingRow>(BOOKING_SQL, [bookingId]))[0]
  if (!row) return null
  const seats = await db.query<{
    id: string
    guest_type: string
    guest_name: string
    guest_email: string | null
    date_of_birth: unknown
    unit_price: string | null
    pay_by: string | null
    created_at: unknown
  }>(
    `SELECT id, guest_type, guest_name, guest_email, date_of_birth::text AS date_of_birth, unit_price::text AS unit_price, pay_by, created_at
     FROM booking_guests WHERE booking_id = $1::uuid ORDER BY created_at, id`,
    [bookingId]
  )
  const flows = await db.query<{ id: string; flow: string; method: string | null; request_id: string | null; created_at: unknown }>(
    `SELECT id, flow, snapshot->>'method' AS method, snapshot->>'request_id' AS request_id, created_at
     FROM pending_reader_payments
     WHERE record_id = $1::uuid AND flow IN ('move', 'settle', 'add_guest') AND status = 'pending'
     ORDER BY created_at, id`,
    [bookingId]
  )
  const figures = await loadBookingMoneyLeft(db, bookingId)
  if (!figures) return null
  return {
    id: row.id,
    customerId: row.customer_id,
    sessionId: row.session_id,
    status: row.status,
    partySize: Number(row.party_size),
    pricePaid: amount(row.price_paid),
    partRefunded: amount(row.part_refunded_amount),
    refundOwed: amount(row.refund_owed_amount),
    redemptionSource: row.redemption_source,
    redeemedMembershipId: row.redeemed_membership_id,
    redeemedSessionPassId: row.redeemed_session_pass_id,
    creditPeriodId: row.credit_period_id,
    bandId: row.band_id,
    startTime: isoOrNull(row.start_time),
    endTime: isoOrNull(row.end_time),
    paymentDueBy: isoOrNull(row.payment_due_by),
    specialRequests: row.special_requests,
    cancelledAt: isoOrNull(row.cancelled_at),
    updatedAt: iso(row.updated_at),
    session: {
      id: row.session_id,
      serviceTypeId: row.service_type_id,
      bookingType: row.booking_type,
      startTime: iso(row.session_start),
      endTime: iso(row.session_end),
      capacity: Number(row.capacity),
      totalBooked: Number(row.total_booked),
      status: row.session_status,
      bandId: row.session_band_id,
    },
    seats: seats.map((seat) => ({
      id: seat.id,
      guestType: seat.guest_type,
      guestName: seat.guest_name,
      guestEmail: seat.guest_email,
      dateOfBirth: seat.date_of_birth === null ? null : String(seat.date_of_birth),
      unitPrice: seat.unit_price === null ? null : amount(seat.unit_price),
      payBy: seat.pay_by,
      createdAt: iso(seat.created_at),
    })),
    openFlows: flows.map((flow) => ({ id: flow.id, flow: flow.flow, method: workerMethod(flow.method, flow.request_id), createdAt: iso(flow.created_at) })),
    orderBeingPaid: row.order_being_paid,
    figures,
  }
}

/** Whether a payment is still being taken on the booking: any open flow, card or reader, old or new, or an order still being paid. */
export const paymentOpen = (booking: Pick<LoadedBooking, 'openFlows' | 'orderBeingPaid'>): boolean => booking.openFlows.length > 0 || booking.orderBeingPaid

/**
 * Inside a change's transaction: locks the booking and `targets` in LOCK_ORDER, then reads it. Null when the booking
 * doesn't exist (nothing else is locked then).
 */
export async function lockAndLoadBooking(tx: Tx, targets: BookingLockTargets): Promise<{ booking: LoadedBooking; locks: HeldBookingLocks } | null> {
  const locks = await lockForBooking(tx, { ownSession: true, ...targets })
  if (!locks) return null
  const booking = await loadBooking(tx, targets.bookingId)
  if (!booking) return null
  return { booking, locks }
}
