export type SessionBookingType = 'public' | 'private'

async function lookupBookingType(sessionId: string): Promise<SessionBookingType | null> {
  const lookup = await paddockData.query<{ booking_type: SessionBookingType }>(
    `SELECT st.booking_type
     FROM sessions s
     JOIN service_types st ON st.id = s.service_type_id
     WHERE s.id = $1`,
    [sessionId]
  )
  return lookup.data[0]?.booking_type ?? null
}

/**
 * Atomically claims capacity on a session for a new (or additional) booking.
 *
 * Business rule: a private session is fully exclusive — the FIRST booking on it claims the
 * session's entire capacity in one shot, regardless of that booking's own party size, so no
 * further booking of any kind (private or public) can ever land on it. A public session instead
 * claims capacity per-attendee, sharing normally among unrelated bookings up to its capacity.
 *
 * This is the single place that rule is implemented — callers (createBooking.ts, moveBooking.ts,
 * createOrder.ts's rollback paths) must always go through this instead of writing their own
 * `total_booked` arithmetic, which is how this rule was previously and silently violated
 * (each call site incremented by party_size regardless of booking_type).
 *
 * `bookingType` is optional — pass it when the caller already has it (avoids a redundant lookup);
 * otherwise it's resolved here from the session's service type.
 */
export async function claimSessionCapacity(
  sessionId: string,
  partySize: number,
  bookingType?: SessionBookingType
): Promise<boolean> {
  const resolvedType = bookingType ?? (await lookupBookingType(sessionId))
  if (!resolvedType) return false

  if (resolvedType === 'private') {
    const result = await paddockData.query<{ id: string }>(
      `UPDATE sessions
       SET total_booked = capacity, updated_at = now()
       WHERE id = $1 AND status = 'open' AND total_booked = 0
       RETURNING id`,
      [sessionId]
    )
    return result.data.length > 0
  }

  // Note: partySize is bound twice under two DIFFERENT placeholder numbers ($1 and $3) rather
  // than reusing $1, since this DB driver rejects reusing one placeholder number twice in the
  // same query even for an identical value (see adjustVariantStock.ts for the same pattern).
  const result = await paddockData.query<{ id: string }>(
    `UPDATE sessions
     SET total_booked = total_booked + $1, updated_at = now()
     WHERE id = $2 AND status = 'open' AND (capacity - total_booked) >= $3
     RETURNING id`,
    [partySize, sessionId, partySize]
  )
  return result.data.length > 0
}

/**
 * Releases capacity previously claimed via `claimSessionCapacity`, mirroring its private/public
 * branching: a private session resets `total_booked` to 0 (undoing the full-capacity claim,
 * regardless of the departing booking's own party size), while a public session decrements by
 * the specific party size being released.
 */
export async function releaseSessionCapacity(
  sessionId: string,
  partySize: number,
  bookingType?: SessionBookingType
): Promise<void> {
  const resolvedType = bookingType ?? (await lookupBookingType(sessionId))

  if (resolvedType === 'private') {
    await paddockData.query(`UPDATE sessions SET total_booked = 0, updated_at = now() WHERE id = $1`, [sessionId])
    return
  }

  await paddockData.query(
    `UPDATE sessions SET total_booked = total_booked - $1, updated_at = now() WHERE id = $2`,
    [partySize, sessionId]
  )
}
