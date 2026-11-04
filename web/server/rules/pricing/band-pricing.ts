// Ported from backend/paddock/shared/bandPricing.ts.
import 'server-only'
import type { BandSeatQuote, SessionBandInfo } from '@/contracts'
import type { Queryable } from '@/server/db'

/**
 * All per-seat pricing for PUBLIC sessions comes from the database function
 * quote_booking(p_session_id, p_customer_id, p_party_size). The band itself is assigned by the
 * sessions_assign_band trigger, so app code never computes bands.
 */

/** Quotes every seat of a public booking from the database's quote_booking function. */
export async function quoteSeats(db: Queryable, sessionId: string, customerId: string, partySize: number): Promise<BandSeatQuote[]> {
  return db.query<BandSeatQuote>('SELECT * FROM quote_booking($1::uuid, $2::uuid, $3::int)', [sessionId, customerId, partySize])
}

export interface DuplicateDayBooking {
  id: string
  status: string
  /** The London calendar day (wall-clock, stored as UTC) both bookings fall on, as "YYYY-MM-DD". */
  day: string
}

/**
 * Pre-check mirroring the bookings_one_per_customer_day trigger exactly: at most one ACTIVE
 * booking (pending / confirmed / payment_needed) per customer per London calendar day, where a
 * day is derived from the session start_time the same way the trigger does:
 * (start_time AT TIME ZONE 'UTC')::date, because session times are wall-clock digits stored as UTC.
 */
export async function findDuplicateDayBooking(
  db: Queryable,
  customerId: string,
  sessionStartTime: string,
  excludeBookingId?: string
): Promise<DuplicateDayBooking | null> {
  const rows = await db.query<DuplicateDayBooking>(
    `SELECT b.id, b.status, (s.start_time AT TIME ZONE 'UTC')::date::text AS day
     FROM bookings b
     JOIN sessions s ON s.id = b.session_id
     WHERE b.customer_id = $1
       AND b.status IN ('pending', 'confirmed', 'payment_needed')
       AND (s.start_time AT TIME ZONE 'UTC')::date = ($2 AT TIME ZONE 'UTC')::date
       AND ($3::uuid IS NULL OR b.id != $4::uuid)
     LIMIT 1`,
    [customerId, sessionStartTime, excludeBookingId ?? null, excludeBookingId ?? null]
  )
  return rows[0] ?? null
}

/** Reads a single session's current band (already assigned by the trigger) with its name/price. */
export async function getSessionBand(db: Queryable, sessionId: string): Promise<SessionBandInfo | null> {
  const rows = await db.query<SessionBandInfo>(
    `SELECT s.band_id, sb.code AS band_code, sb.name AS band_name, sb.price AS band_price,
            s.band_overridden
     FROM sessions s
     LEFT JOIN session_bands sb ON sb.id = s.band_id
     WHERE s.id = $1`,
    [sessionId]
  )
  return rows[0] ?? null
}
