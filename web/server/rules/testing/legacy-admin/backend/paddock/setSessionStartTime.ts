import { isValidIsoDateTime } from './shared/isoDateTime'
import { resolveStaffId } from './shared/resolveStaffId'

export interface SetSessionStartTimeResult {
  updated: boolean
  reason?: 'invalid_start_time' | 'session_not_found' | 'session_has_bookings' | 'slot_already_exists'
  /** Staff-facing text, set with 'invalid_start_time'. */
  message?: string
  session?: { id: string; start_time: string; end_time: string }
  /** The band the session now sits in — recomputed by the sessions_assign_band trigger from the
   *  new start_time, unless the session is band_overridden (in which case its overridden band
   *  stays). Null for private sessions. Shown in the success message. */
  band?: { code: string; name: string; overridden: boolean } | null
}

export interface SetSessionStartTimeParams {
  sessionId: string
  /** New start_time as an ISO timestamp. end_time is always recomputed as this plus the
   *  session's own service type's duration — this tool only ever moves the start, never the
   *  duration. */
  startTime: string
}

/**
 * One-off override of a single session's start_time (and its recomputed end_time) — does not
 * touch service_type_schedule_slots at all, so this is a genuine one-time exception, not a
 * change to the recurring rule. Combined with generateUpcomingSessions.ts's edge-forward-only
 * design (never re-examining already-generated dates), an edited session is never silently
 * regenerated back to its original time.
 *
 * Only permitted while the session has zero active (pending/confirmed) bookings — guarded
 * atomically in the final UPDATE so a booking landing in the race window between the check and
 * the write is still caught. Deliberately does NOT validate against other sessions' times: two
 * sessions of different service types legitimately coexist at overlapping times already (that's
 * normal), and real double-booking is prevented later, at actual booking time, by the existing
 * cross-session exclusion constraint — which compares live time ranges, so it stays correct
 * regardless of this edit.
 */
export default async function setSessionStartTime(
  req: { params: SetSessionStartTimeParams; user: User }
): Promise<SetSessionStartTimeResult> {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { sessionId, startTime } = req.params
  // Postgres takes a year of 5 or more digits without complaint, so this must be refused here.
  if (!isValidIsoDateTime(startTime)) {
    return { updated: false, reason: 'invalid_start_time', message: 'Enter a valid date and time.' }
  }

  const sessionLookup = await paddockData.query<{ id: string; duration: number }>(
    `SELECT s.id, st.duration
     FROM sessions s
     JOIN service_types st ON st.id = s.service_type_id
     WHERE s.id = $1`,
    [sessionId]
  )
  const session = sessionLookup.data[0]
  if (!session) {
    return { updated: false, reason: 'session_not_found' }
  }

  const bookingCount = await paddockData.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM bookings WHERE session_id = $1 AND status IN ('pending', 'confirmed')`,
    [sessionId]
  )
  if (Number.parseInt(bookingCount.data[0]?.count ?? '0', 10) > 0) {
    return { updated: false, reason: 'session_has_bookings' }
  }

  try {
    const result = await paddockData.query<{ id: string; start_time: string; end_time: string }>(
      `UPDATE sessions s
       SET start_time = $1, end_time = $2::timestamptz + ($3 || ' minutes')::interval, updated_at = now()
       WHERE s.id = $4
         AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.session_id = s.id AND b.status IN ('pending', 'confirmed'))
       RETURNING s.id, s.start_time, s.end_time`,
      [startTime, startTime, session.duration, sessionId]
    )
    if (result.data.length === 0) {
      // A booking landed in the race window between the check above and this update.
      return { updated: false, reason: 'session_has_bookings' }
    }
    const updated = result.data[0]!
    const bandLookup = await paddockData.query<{ code: string | null; name: string | null; band_overridden: boolean | null }>(
      `SELECT sb.code, sb.name, s.band_overridden
       FROM sessions s
       LEFT JOIN session_bands sb ON sb.id = s.band_id
       WHERE s.id = $1`,
      [sessionId]
    )
    const bandRow = bandLookup.data[0]
    return {
      updated: true,
      session: updated,
      band: bandRow?.code ? { code: bandRow.code, name: bandRow.name ?? bandRow.code, overridden: bandRow.band_overridden === true } : null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('sessions_service_type_start_time_key')) {
      return { updated: false, reason: 'slot_already_exists' }
    }
    throw err
  }
}
