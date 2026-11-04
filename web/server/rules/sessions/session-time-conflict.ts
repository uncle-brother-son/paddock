// Ported from backend/paddock/checkSessionTimeConflict.ts.
import 'server-only'
import type { SessionTimeConflictInput, SessionTimeConflictOutput } from '@/contracts'
import type { Queryable } from '@/server/db'

type ConflictingSession = NonNullable<SessionTimeConflictOutput['conflictingSession']>

/**
 * Read-only, advisory check for the edit-start-time and change-service-type dialogs: a confirmed
 * booking on one session blocks any other service type's session at an overlapping time. It does
 * not block the edit; the real guarantee is the bookings_no_cross_session_overlap constraint.
 */
export async function checkSessionTimeConflict(db: Queryable, input: SessionTimeConflictInput): Promise<SessionTimeConflictOutput> {
  const { sessionId, serviceTypeId, startTime, endTime } = input

  const rows = await db.query<ConflictingSession>(
    `SELECT s2.id, st2.name AS service_type_name, s2.start_time, s2.end_time
     FROM sessions s2
     JOIN service_types st2 ON st2.id = s2.service_type_id
     JOIN bookings b2 ON b2.session_id = s2.id AND b2.status = 'confirmed'
     WHERE s2.id != $1
       AND s2.service_type_id != $2
       AND s2.start_time < $3
       AND s2.end_time > $4
     LIMIT 1`,
    [sessionId, serviceTypeId, endTime, startTime]
  )

  const conflictingSession = rows[0] ?? null
  return { conflict: conflictingSession !== null, conflictingSession }
}
