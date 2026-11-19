// New in W46 (G-plan 2.1; W43 "Noticed" 4, the W45 audit's row 53): why a booking lapsed, for the booking detail.
// A lapsed booking said nothing about itself on any screen: `cancel_reason` was written and never read, and what the
// lapse gave back or kept was only in its audit row. The facts ride on the refund-figures read, which the booking
// detail already calls (W47 shows them). A read: nothing is written.
import 'server-only'
import type { BookingLapse } from '@/contracts'
import type { Queryable } from '@/server/db'
import { BOOKING_LAPSED } from './cancel'
import { lapsedWords } from './failure-messages'
import type { LapseKept } from './refunds'

/**
 * A cancelled booking's lapse (`$1`): its `booking.lapsed` row (the Worker's sweep writes one with every lapse, W43),
 * or, with no row, the database's own reason on the booking: its old sweep (before W43) wrote `membership_lapsed` and
 * no row, and only ever lapsed a booking with nothing paid. No row comes back for a booking that didn't lapse.
 */
const LAPSE_SQL = `
SELECT COALESCE(l.at, b.cancelled_at) AS at, l.details
FROM bookings b
LEFT JOIN LATERAL (
  SELECT a.at, a.details FROM audit_log a
  WHERE a.action = '${BOOKING_LAPSED}' AND a.entity_type = 'booking' AND a.entity_id = b.id::text
  ORDER BY a.at DESC
  LIMIT 1
) l ON true
WHERE b.id = $1::uuid AND b.status = 'cancelled' AND (l.at IS NOT NULL OR b.cancel_reason = 'membership_lapsed')`

/** What `booking.lapsed` holds (bookings/cancel.ts, lapsedRow). */
export interface LapsedDetails {
  back?: boolean
  kept?: LapseKept | null
  paymentDueBy?: string | null
  pricePaid?: number
  refundOwed?: number
  addonsKept?: number
  storeCreditRefunded?: number
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const amount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * A lapse's facts from its row's time and details, with the words for them. W47: also what the "money kept on lapsed
 * bookings" list reads (refunds/money-owed-list.ts), so the list and the booking detail can't give two figures.
 */
export function lapseFacts(at: string | Date, details: LapsedDetails | null): BookingLapse {
  const row = details ?? {}
  const owed = round2(amount(row.refundOwed))
  // W43a: what a lapse kept is the price paid less what was owed, and the paid add-ons removed with nothing back.
  // Only when nothing came back: 24 hours or more before, everything that isn't owed is given.
  const kept = row.back === false ? Math.max(0, round2(amount(row.pricePaid) - owed + amount(row.addonsKept))) : 0
  const facts = {
    at: new Date(at).toISOString(),
    paymentDueBy: row.paymentDueBy ? new Date(row.paymentDueBy).toISOString() : null,
    givenBack: round2(amount(row.storeCreditRefunded)),
    kept,
    keptBecause: kept > 0 ? (row.kept ?? null) : null,
    owed,
  }
  return { ...facts, words: lapsedWords(facts) }
}

/** The booking's lapse facts, or null when it wasn't cancelled by a lapse. */
export async function loadBookingLapse(db: Queryable, bookingId: string): Promise<BookingLapse | null> {
  const [row] = await db.query<{ at: string | Date | null; details: LapsedDetails | null }>(LAPSE_SQL, [bookingId])
  if (!row || row.at === null) return null
  return lapseFacts(row.at, row.details)
}
