/**
 * Phase 2 band-based pricing helpers. All per-seat pricing for PUBLIC sessions comes from the
 * database function quote_booking(p_session_id, p_customer_id, p_party_size) — the band itself is
 * assigned by the sessions_assign_band trigger, so app code never computes bands.
 *
 * quote_booking returns one row per seat:
 *   seat_no, seat_kind ('account_holder'|'guest'), band_id, list_price, unit_price,
 *   credit_eligible, membership_level, discount_percent
 * Seat 1 is the account holder and carries the membership terms (discount + credit eligibility
 * from membership_band_terms); every other seat is a guest paying the full band price.
 */

export interface BandSeatQuote {
  seat_no: number
  seat_kind: 'account_holder' | 'guest'
  band_id: string
  list_price: string
  unit_price: string
  credit_eligible: boolean
  membership_level: string | null
  discount_percent: string
}

/** Quotes every seat of a public booking from the database's quote_booking function. */
export async function quoteSeats(sessionId: string, customerId: string, partySize: number): Promise<BandSeatQuote[]> {
  const result = await paddockData.query<BandSeatQuote>(
    'SELECT * FROM quote_booking($1::uuid, $2::uuid, $3::int)',
    [sessionId, customerId, partySize]
  )
  return result.data
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
 * day is derived from the session start_time the same way the trigger does —
 * (start_time AT TIME ZONE 'UTC')::date, because session times are wall-clock digits stored as
 * UTC. The trigger remains the authoritative backstop (it takes an advisory lock and runs
 * atomically at write time); this exists only so the UI can show a plain message before taking
 * payment instead of failing after.
 */
export async function findDuplicateDayBooking(
  customerId: string,
  sessionStartTime: string,
  excludeBookingId?: string
): Promise<DuplicateDayBooking | null> {
  const result = await paddockData.query<DuplicateDayBooking>(
    `SELECT b.id, b.status, (s.start_time AT TIME ZONE 'UTC')::date::text AS day
     FROM bookings b
     JOIN sessions s ON s.id = b.session_id
     WHERE b.customer_id = $1
       AND b.status IN ('pending', 'confirmed', 'payment_needed')
       AND (s.start_time AT TIME ZONE 'UTC')::date = ($2 AT TIME ZONE 'UTC')::date
       AND ($3::uuid IS NULL OR b.id != $4::uuid)
     ORDER BY b.id
     LIMIT 1`,
    [customerId, sessionStartTime, excludeBookingId ?? null, excludeBookingId ?? null]
  )
  return result.data[0] ?? null
}
