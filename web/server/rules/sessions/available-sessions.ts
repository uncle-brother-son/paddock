// Ported from backend/paddock/getAvailableSessions.ts.
import 'server-only'
import type { AvailableSessionRow, AvailableSessionsInput } from '@/contracts'
import type { Queryable } from '@/server/db'

/**
 * `started` compares start_time (London wall-clock labelled UTC) like for like against London
 * wall-clock now, never against raw now().
 */
export async function getAvailableSessions(db: Queryable, input: AvailableSessionsInput): Promise<AvailableSessionRow[]> {
  const { date, serviceTypeId } = input

  return db.query<AvailableSessionRow>(
    `SELECT
       s.id,
       s.service_type_id,
       st.name AS service_type_name,
       st.booking_type,
       s.start_time,
       s.end_time,
       s.capacity,
       s.total_booked,
       (s.capacity - s.total_booked) AS available,
       s.status,
       s.blocked_reason,
       (s.start_time AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'Europe/London') AS started,
       sb.id AS band_id,
       sb.code AS band_code,
       sb.name AS band_name,
       sb.price AS band_price,
       s.band_overridden
     FROM sessions s
     JOIN service_types st ON st.id = s.service_type_id
     LEFT JOIN session_bands sb ON sb.id = s.band_id
     WHERE s.start_time::date = $1::date
       AND ($2::uuid IS NULL OR s.service_type_id = $3::uuid)
       AND NOT EXISTS (
         SELECT 1
         FROM sessions s2
         JOIN bookings b2 ON b2.session_id = s2.id AND b2.status = 'confirmed'
         WHERE s2.service_type_id != s.service_type_id
           AND s2.start_time < s.end_time
           AND s2.end_time > s.start_time
       )
     ORDER BY s.start_time`,
    [date, serviceTypeId ?? null, serviceTypeId ?? null]
  )
}
