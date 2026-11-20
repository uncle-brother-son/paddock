import { requireCanManagePricing } from './shared/pricingStaff'

export interface SetSessionBandParams {
  /** Change a single session (mutually exclusive with `date`). */
  sessionId?: string
  /** Change every PUBLIC session starting on this "YYYY-MM-DD" date (mutually exclusive with `sessionId`). */
  date?: string
  bandId: string
  /**
   * Step 2 only — set once staff have seen the confirmation counts from the first call. The
   * first call (omit this) only counts what WOULD change.
   */
  confirmed?: boolean
}

export interface SetSessionBandResult {
  confirmed: boolean
  sessionsAffected: number
  /** Active (non-cancelled) bookings on the affected sessions — those bookings keep the price
   *  they were charged; only future quotes see the new band. */
  bookingsAffected: number
}

/**
 * Staff action: override the band of one session, or of every session on a chosen
 * date (public and private — private pricing is band-based now). Sets band_id to the chosen band
 * and band_overridden = true, which stops the
 * sessions_assign_band trigger from re-banding them (until a reset back to automatic). Allowed
 * even when the session already has bookings — those bookings keep the price they were charged.
 *
 * Two-step: call once without `confirmed` to get the sessions/bookings counts for the
 * confirmation message, then again with `confirmed: true` to apply.
 */
export default async function setSessionBand(req: { params: SetSessionBandParams; user: User }): Promise<SetSessionBandResult> {
  const { sessionId, date, bandId, confirmed } = req.params

  if (!sessionId && !date) {
    throw new Error('Provide either a sessionId or a date.')
  }
  if (sessionId && date) {
    throw new Error('Provide either a sessionId or a date, not both.')
  }

  // The permission guard and the band lookup are independent reads — run them in parallel.
  const [bandLookup] = await Promise.all([
    paddockData.query<{ id: string; code: string; name: string }>(
      'SELECT id, code, name FROM session_bands WHERE id = $1 AND active = true',
      [bandId]
    ),
    requireCanManagePricing(req.user.email),
  ])
  const band = bandLookup.data[0]
  if (!band) {
    throw new Error('That band no longer exists.')
  }

  const target = sessionId ?? date
  // The count query only needs the target value — it has exactly one placeholder ($1). The
  // UPDATE below reuses the same WHERE shape but shifted one slot ($2 = target) so $1 can be
  // the band id, so each statement gets its own parameter list matching its own placeholders.
  // Band overrides apply to private sessions too — private pricing is band-based now.
  const targetWhereForCount = sessionId ? 's.id = $1::uuid' : 's.start_time::date = $1::date'
  const targetWhereForUpdate = sessionId ? 's.id = $2::uuid' : 's.start_time::date = $2::date'

  const countResult = await paddockData.query<{ sessions: string; bookings: string }>(
    `SELECT
       COUNT(DISTINCT s.id)::text AS sessions,
       COUNT(b.id) FILTER (WHERE b.id IS NOT NULL AND b.status != 'cancelled')::text AS bookings
     FROM sessions s
     LEFT JOIN bookings b ON b.session_id = s.id
     WHERE ${targetWhereForCount}`,
    [target]
  )
  const sessionsAffected = Number.parseInt(countResult.data[0]?.sessions ?? '0', 10)
  const bookingsAffected = Number.parseInt(countResult.data[0]?.bookings ?? '0', 10)

  if (!confirmed) {
    return { confirmed: false, sessionsAffected, bookingsAffected }
  }

  const updateResult = await paddockData.query<{ id: string }>(
    `UPDATE sessions s
     SET band_id = $1, band_overridden = true, updated_at = now()
     WHERE ${targetWhereForUpdate}
     RETURNING s.id`,
    [bandId, target]
  )

  return { confirmed: true, sessionsAffected: updateResult.data.length, bookingsAffected }
}
