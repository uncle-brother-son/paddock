import { londonToday } from './shared/londonTime'
import { resolveStaffId } from './shared/resolveStaffId'

export interface GenerateUpcomingSessionsResult {
  slotsInserted: number
  horizonEnd: string
}

// 14 weeks (98 days) per run. Each weekly run fills everything from just past the furthest
// already-generated date up to 14 weeks beyond it, so the rolling horizon stays ~14 weeks ahead
// of today and stays idempotent (ON CONFLICT DO NOTHING) no matter how often it runs.
const DAYS_PER_RUN = 98

// DUPLICATION NOTICE: this function's SQL is also pasted directly into a Resource Query block in
// a Retool Workflow (Schedule trigger → weekly run against the "Paddock Data" resource), because
// Workflows have no way to call an app's backend function directly — there is no HTTP endpoint or
// other bridge exposing this function outside this app. If you change the query logic or the
// table/column names it touches, you must update that Workflow's SQL block to match, or the two
// will silently drift apart.
//
// Incremental (edge-forward-only) session generator. This intentionally does NOT rescan the
// whole rolling window on every run — it only ever generates days strictly after the furthest
// date already generated ("the edge"), advancing that edge by DAYS_PER_RUN (98 days = 14 weeks)
// per run, matching the external Workflow's weekly trigger cadence.
//
// Why: the previous version recomputed the full ~365-day window from `now()` every run and
// relied on the `sessions_service_type_start_time_key` unique constraint (service_type_id,
// start_time) + `ON CONFLICT DO NOTHING` to make repeated runs idempotent. That silently
// regenerated anything that had been edited away from its originally-scheduled (service_type_id,
// start_time) pair — a moved/edited session's OLD slot combination no longer existed, so the
// rescan saw a "gap" at that old time and refilled it, resurrecting a slot staff had deliberately
// changed. Never re-examining any date at or before the edge protects, automatically and for
// free, three things without this function needing to know anything about them: one-off session
// edits/overrides (planned, not yet built), blocked sessions, and manually-created bespoke
// sessions (also planned) — none of their dates are ever looked at again once past the edge.
//
// Each active service type's OWN explicit schedule (service_type_schedule_slots — staff-defined
// day-of-week + start-time rows) and its duration are what generate that service type's slots;
// business_hours is not consulted here at all. block-day/block-session remains the tool for
// one-off closures on an otherwise-scheduled day.
//
// KNOWN, ACCEPTED LIMITATION: a brand-new Service Type added after the system has been running
// only starts generating from the current edge forward — it does NOT backfill the gap between
// today and the existing window's start. That requires one manual one-off generation run
// (temporarily widening the range) when a new Service Type is first added. This is expected
// behavior, not a bug.
export default async function generateUpcomingSessions(req: { user: User }): Promise<GenerateUpcomingSessionsResult> {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const result = await paddockData.query<{ id: string }>(
    `WITH bounds AS (
       -- The furthest date already generated, across every session regardless of status — a
       -- blocked or edited session still marks its date as "already handled". Falls back to
       -- yesterday (London's date) when the table is empty, so the very first run starts today.
       SELECT COALESCE(MAX(start_time)::date, (now() AT TIME ZONE 'Europe/London')::date - INTERVAL '1 day') AS edge_date
       FROM sessions
     ),
     days AS (
       SELECT gs::date AS day
       FROM bounds,
       LATERAL generate_series(
         (bounds.edge_date + INTERVAL '1 day')::date::timestamp,
         (bounds.edge_date + ($1 || ' days')::interval)::date::timestamp,
         interval '1 day'
       ) AS gs
     ),
     svc AS (
       SELECT id AS service_type_id, duration, capacity, booking_type
       FROM service_types
       WHERE active = true
         AND duration IS NOT NULL AND duration > 0
         AND booking_type IS NOT NULL
     ),
     slots AS (
       SELECT
         svc.service_type_id,
         svc.capacity,
         svc.booking_type,
         (d.day + sl.start_time) AS start_time,
         (d.day + sl.start_time) + (svc.duration || ' minutes')::interval AS end_time
       FROM days d
       JOIN service_type_schedule_slots sl ON sl.day_of_week = EXTRACT(DOW FROM d.day)::smallint
       JOIN svc ON svc.service_type_id = sl.service_type_id
     )
     INSERT INTO sessions (service_type_id, start_time, end_time, type, capacity, status)
     SELECT service_type_id, start_time, end_time, booking_type, capacity, 'open'
     FROM slots
     ON CONFLICT (service_type_id, start_time) DO NOTHING
     RETURNING id`,
    [DAYS_PER_RUN]
  )

  // Report the true resulting edge (post-insert), rather than recomputing the date in JS —
  // this stays correct even if a schedule slot's day/time means the last calendar day in the
  // range doesn't actually produce a session.
  const horizon = await paddockData.query<{ max: string | null }>(
    `SELECT MAX(start_time) AS max FROM sessions`
  )
  const horizonEnd = horizon.data[0]?.max ? horizon.data[0].max.slice(0, 10) : londonToday()

  return {
    slotsInserted: result.data.length,
    horizonEnd,
  }
}
