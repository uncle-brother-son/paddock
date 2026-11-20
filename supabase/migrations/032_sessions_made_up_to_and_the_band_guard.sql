-- 032: the nightly job keeps its own "sessions made up to" date, takes the band guard, and never makes sessions on a
-- closed date; re-banding compares with London's wall clock (brief W51 item 1; G-plan 4.5; bugs GB3 and W51-1; W50
-- review L3; brief W51a item 2: closed dates, W51 review L3; Wayne, 20 Nov 2026).
-- NOT APPLIED by W51 or W51a. The lead applies it after the W51 review and BEFORE the Worker push: the Worker's
-- calendar read (GET /api/v1/staff/sessions) reads the two new tables.
-- APPLY IT AS ONE TRANSACTION (`apply_migration`, or the SQL editor's one multi-statement run). Its second step can
-- stop with an error (see the pre-check), and only inside one transaction does that leave nothing behind. Never
-- `psql -f` without `--single-transaction`.
--
-- Before:
--   * generate_upcoming_sessions() (nightly) makes sessions only beyond the furthest date that has ANY session. One
--     one-off session made for a far date (what Create One-Off Session is for) is past the job's 98-day target, so
--     the job makes nothing from then on (GB3). Example: a private hire session made for 1 June 2027; from that night
--     no new date is made, and from 27 February there is nothing to book until someone notices.
--   * the job reads the band windows in its own snapshot and waits for nobody. A session it makes while a manager's
--     band-window save is in progress is banded by the OLD windows, and the save can't see it to re-band it (W51-1).
--     Example: Saturday 10:00 is Core, GBP 20; a manager moves Peak (GBP 25) to start at 10:00 while the job makes
--     next month's Saturday 10:00: that session sells at GBP 20 until Saturday's windows are saved again.
--   * reassign_session_bands() compares session times with the real now(). Session times are London wall-clock
--     digits stored as UTC, so in summer a save at 10:30 on the wall (09:30 UTC) also re-bands a session that started
--     at 10:00 (W50 review L3).
--   * a date further ahead than the job has reached can't be closed. Example: in June staff press Block Day on
--     25 December; no session exists yet, so nothing is blocked, and in September the job makes that day's sessions,
--     open and bookable (W51 review L3).
-- After:
--   * a one-row table, sessions_made_up_to, holds the last date the job has made. The job makes from the day after it
--     to London's today + 98, then moves it. A one-off session, however far ahead, no longer matters.
--   * the job first takes the band guard shared (every session_bands row, in id order, FOR SHARE). A band-window save
--     holds those rows FOR NO KEY UPDATE, so the job waits for a save in progress and bands by the new windows, and a
--     later save waits for the job and re-bands what it made.
--   * reassign_session_bands()'s default "from" is London's wall clock now, in the stored form. The Worker passes the
--     same moment itself (server/rules/pricing/admin.ts), so it is right before and after this migration.
--   * a table of closed dates (date, reason, who, when). Block Day writes a row, Unblock Day deletes it (the Worker,
--     server/rules/sessions/admin.ts). The job makes no session on a closed date, and remembers the closed dates it
--     left out (sessions_made_up_to.closed_days_skipped), so the first run after one is reopened makes that day's
--     sessions. The job and those presses take one lock for the date (a transaction advisory lock on
--     'session_day:YYYY-MM-DD'), so a date can't be closed while the job is making it, or made while it is being closed.
--
-- What changes, exactly: two new tables (one with one row, one empty); two functions replaced.
-- generate_upcoming_sessions keeps its signature (horizon_days integer DEFAULT 98), SECURITY DEFINER, search_path and
-- grants, so the cron entry that calls it is unchanged. reassign_session_bands keeps its signature and grants; only
-- its parameter's default changes. No session, slot, band or booking row is written or rewritten by the migration.
--
-- Wayne's Q50 (20 Nov 2026): a weekly slot added or removed, or a capacity or length change, still reaches only the
-- dates the job makes from now on. Nothing here changes that; the staff app says so on the screen, with this date.
--
-- Pre-checks (read-only), BEFORE applying.
--   P1. The furthest session and the job's target. Expect `furthest` to be London's today + 98, or the day before if
--       it is applied before that day's 02:15 run (the lead's check on 20 Nov 2026: 2027-02-26), and never after `target`:
--        SELECT max((start_time AT TIME ZONE 'UTC')::date) AS furthest,
--               (now() AT TIME ZONE 'Europe/London')::date + 98 AS target
--          FROM public.sessions;
--   P2. The last date the job made: the furthest date with a session whose service type has a weekly slot on that
--       weekday and time. THE TWO DATES MUST AGREE: this one must equal P1's `furthest`. If they differ, STOP and
--       tell the builder: a one-off session lies beyond the last date the job made, so "the furthest session" is not
--       the date the job has reached, and the row must be set to this date instead. (If `furthest` is after `target`
--       the migration stops by itself with an error and changes nothing; a one-off on exactly the target day, made
--       before that day's 02:15 run, is the case only this check sees.)
--        SELECT max((s.start_time AT TIME ZONE 'UTC')::date) AS last_made
--          FROM public.sessions s
--          JOIN public.service_type_schedule_slots sl
--            ON sl.service_type_id = s.service_type_id
--           AND sl.day_of_week = EXTRACT(DOW FROM (s.start_time AT TIME ZONE 'UTC'))::smallint
--           AND sl.start_time = (s.start_time AT TIME ZONE 'UTC')::time;
--   P3. The cron entry, kept to compare in check 3:
--        SELECT jobid, jobname, schedule, command, active FROM cron.job WHERE command ILIKE '%generate_upcoming_sessions%';
--
-- Checks after applying (read-only), each with what to expect:
--   1. The date: P1's `furthest`. No closed day left out yet: {}.
--        SELECT made_up_to FROM public.sessions_made_up_to;
--        SELECT closed_days_skipped FROM public.sessions_made_up_to;
--   2. One row, and the Worker's role can read it:
--        SELECT count(*) FROM public.sessions_made_up_to;                                              -- 1
--        SELECT has_table_privilege('paddock_worker', 'public.sessions_made_up_to', 'SELECT');         -- true
--        SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sessions_made_up_to'::regclass;       -- true
--   3. The cron entry is unchanged (compare with P3):
--        SELECT jobid, jobname, schedule, command, active FROM cron.job WHERE command ILIKE '%generate_upcoming_sessions%';
--   4. Both functions are the new ones: true, true, true, true.
--        SELECT pg_get_functiondef('public.generate_upcoming_sessions(integer)'::regprocedure) LIKE '%sessions_made_up_to%';
--        SELECT pg_get_functiondef('public.generate_upcoming_sessions(integer)'::regprocedure) LIKE '%from session_bands order by id for share%';
--        SELECT pg_get_functiondef('public.generate_upcoming_sessions(integer)'::regprocedure) LIKE '%left join closed_dates%';
--        SELECT pg_get_functiondef('public.reassign_session_bands(timestamp with time zone)'::regprocedure) LIKE '%Europe/London%';
--   5. One run of the job, on a copy if there is one. On live it can be run inside a transaction that is rolled back
--      (it holds the band guard shared for that moment, and nothing is kept). Before the 02:15 run of the day it is
--      applied, expect one new day's sessions (or 0 if the 02:15 run has been) and the date moved to today + 98:
--        BEGIN;
--        SELECT public.generate_upcoming_sessions();
--        SELECT made_up_to, (now() AT TIME ZONE 'Europe/London')::date + 98 AS target FROM public.sessions_made_up_to;
--        ROLLBACK;
--   6. The morning after: the date has moved by one day, and the standing band check is 0 (London's wall clock now,
--      in the stored form, as the re-band itself compares):
--        SELECT made_up_to FROM public.sessions_made_up_to;
--        SELECT count(*) FROM public.sessions
--         WHERE type = 'public' AND NOT band_overridden
--           AND start_time >= ((now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'UTC')
--           AND band_id IS DISTINCT FROM band_for_session_start(start_time);
--   7. Closed dates: no row yet; row level security on; the Worker's role can read, insert and delete, and not
--      update: 0, true, true, true, true, false.
--        SELECT count(*) FROM public.closed_dates;
--        SELECT relrowsecurity FROM pg_class WHERE oid = 'public.closed_dates'::regclass;
--        SELECT has_table_privilege('paddock_worker', 'public.closed_dates', 'SELECT');
--        SELECT has_table_privilege('paddock_worker', 'public.closed_dates', 'INSERT');
--        SELECT has_table_privilege('paddock_worker', 'public.closed_dates', 'DELETE');
--        SELECT has_table_privilege('paddock_worker', 'public.closed_dates', 'UPDATE');
--   8. Standing, after the Worker is released (expect 0): an open session on a closed date that is still to come.
--        SELECT count(*) FROM public.sessions s JOIN public.closed_dates c ON c.closed_on = (s.start_time AT TIME ZONE 'UTC')::date
--         WHERE s.status = 'open' AND c.closed_on >= (now() AT TIME ZONE 'Europe/London')::date;
--      (A session unblocked on its own card on a closed date counts here: that is a staff choice, shown on the calendar.)
-- Then refresh the saved schema (web/server/rules/testing/README.md): the diff should show nothing.
--
-- Rollback: the Down below. The Worker's calendar read needs the tables, so roll the Worker back first.
-- BEFORE ANY DOWN (read-only; go ahead only on false, false):
--        SELECT max((start_time AT TIME ZONE 'UTC')::date) > (now() AT TIME ZONE 'Europe/London')::date + 98 AS would_stop_old_job FROM public.sessions;
--        SELECT count(*) > 0 AS closed_dates_would_be_lost FROM public.closed_dates;
--   The first true: a one-off session made far ahead while 032 was live would stop the old job again (GB3 returns).
--   The second true: the old job knows no closed dates, and will make sessions on them; note the dates first
--   (SELECT * FROM public.closed_dates ORDER BY closed_on), and block those days by hand as the old job reaches them.

-- 1. The date the nightly job has made sessions up to, and the closed days it left out on the way. One row (id is
--    always true), as postage_settings.
CREATE TABLE public.sessions_made_up_to (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  made_up_to date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_days_skipped date[] NOT NULL DEFAULT '{}'
);
ALTER TABLE public.sessions_made_up_to ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.sessions_made_up_to IS 'One row: the last date generate_upcoming_sessions() has made sessions for, and the closed dates it left out (it makes one on its next run once the date is reopened). Only that function moves it; the Worker reads it.';
-- The Worker reads the date and never writes it (the default privileges of migration 016 would let it).
REVOKE INSERT, UPDATE, DELETE ON public.sessions_made_up_to FROM paddock_worker;
GRANT SELECT ON public.sessions_made_up_to TO paddock_worker;

-- 2. Its row: the furthest session date already made. Stops, changing nothing, if a session lies beyond the job's
--    horizon (see the pre-checks above). With no session at all: yesterday, so the job starts from today.
DO $$
DECLARE v_furthest date; v_target date := (now() AT TIME ZONE 'Europe/London')::date + 98;
BEGIN
  SELECT max((start_time AT TIME ZONE 'UTC')::date) INTO v_furthest FROM public.sessions;
  IF v_furthest > v_target THEN
    RAISE EXCEPTION 'Migration 032 stopped: a session exists on %, after the nightly job''s horizon (%). The furthest session is not the date the job has made up to: see the pre-check in the migration file.', v_furthest, v_target;
  END IF;
  INSERT INTO public.sessions_made_up_to (made_up_to)
  VALUES (COALESCE(v_furthest, (now() AT TIME ZONE 'Europe/London')::date - 1));
END $$;

-- 3. Closed dates (W51a). A row is a date the club is closed: Block Day writes it, Unblock Day deletes it. The date
--    is a London calendar date, as a session's day is read (the stored digits). `closed_by` is the staff member.
CREATE TABLE public.closed_dates (
  closed_on date PRIMARY KEY,
  reason text,
  closed_by uuid REFERENCES public.staff(id),
  closed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.closed_dates ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.closed_dates IS 'Dates the club is closed. generate_upcoming_sessions() makes no session on one; the Worker refuses a one-off session on one. Written by Block Day and deleted by Unblock Day (the Worker), under the date''s advisory lock.';
-- The Worker reads, inserts and deletes a closed date and never rewrites one (a date closed twice keeps its first
-- reason and who).
REVOKE UPDATE ON public.closed_dates FROM paddock_worker;
GRANT SELECT, INSERT, DELETE ON public.closed_dates TO paddock_worker;

-- 4. The nightly job.
CREATE OR REPLACE FUNCTION public.generate_upcoming_sessions(horizon_days integer DEFAULT 98)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_edge date; v_target date; v_inserted int; v_skipped date[]; v_days date[]; v_open date[]; v_closed date[];
begin
  -- 032 (W51-1): the band guard, shared, before anything is written. A band-window save holds these rows, so a
  -- session made here is banded by the windows the save leaves, and a save that starts later waits for this run.
  perform 1 from session_bands order by id for share;
  v_target := (now() at time zone 'Europe/London')::date + horizon_days;
  -- 032 (GB3): the job's own date, not the furthest session. Locked, so two runs at once take turns. With no row
  -- (a database never set up) it starts from today, and writes the row below.
  select made_up_to, closed_days_skipped into v_edge, v_skipped from sessions_made_up_to where id for update;
  if not found then v_edge := (now() at time zone 'Europe/London')::date - 1; v_skipped := '{}'; end if;
  -- 032 (closed dates): the days this run is for. Each day after the job's date up to the target, and each closed
  -- day an earlier run left out that hasn't passed. Then one lock for each, in date order: the lock Block Day,
  -- Unblock Day and a one-off session take for their date, so no date is closed or reopened while this run makes it.
  -- Then which of them are closed, read after the locks (a new statement sees what a press that held one committed).
  select coalesce(array_agg(q.day order by q.day), '{}') into v_days
    from (select g.day_ts::date as day from generate_series((v_edge + 1)::timestamp, v_target::timestamp, interval '1 day') as g(day_ts)
          union
          select s.day from unnest(v_skipped) as s(day) where s.day >= (now() at time zone 'Europe/London')::date) q;
  if v_days = '{}' then return 0; end if;
  perform pg_advisory_xact_lock(hashtextextended('session_day:' || to_char(l.day, 'YYYY-MM-DD'), 0)) from unnest(v_days) as l(day);
  select coalesce(array_agg(q.day order by q.day) filter (where c.closed_on is null), '{}'),
         coalesce(array_agg(q.day order by q.day) filter (where c.closed_on is not null), '{}')
    into v_open, v_closed
    from unnest(v_days) as q(day) left join closed_dates c on c.closed_on = q.day;

  insert into sessions (service_type_id, start_time, end_time, type, capacity, status)
  select svc.id, (d.day + sl.start_time),
         (d.day + sl.start_time) + (svc.duration || ' minutes')::interval,
         svc.booking_type, svc.capacity, 'open'
  from unnest(v_open) as g(day_ts)
  cross join lateral (select g.day_ts::date as day) d
  join service_type_schedule_slots sl on sl.day_of_week = extract(dow from d.day)::smallint
  join service_types svc on svc.id = sl.service_type_id
  where svc.active and svc.duration is not null and svc.duration > 0 and svc.booking_type is not null
  on conflict (service_type_id, start_time) do nothing;

  get diagnostics v_inserted = row_count;
  -- 032 (GB3): made up to the target, whether or not any slot fell on those days (never moved back by a run with a
  -- shorter horizon). The closed days this run left out are kept, so a later run makes one that has been reopened.
  insert into sessions_made_up_to (id, made_up_to, closed_days_skipped) values (true, greatest(v_edge, v_target), v_closed)
  on conflict (id) do update set made_up_to = excluded.made_up_to, closed_days_skipped = excluded.closed_days_skipped, updated_at = now();
  return v_inserted;
end $function$;

-- 5. Re-banding: "from" is London's wall clock now, in the stored form (London digits labelled UTC).
CREATE OR REPLACE FUNCTION public.reassign_session_bands(p_from timestamp with time zone DEFAULT ((now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'UTC'))
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE sessions s
  SET band_id = band_for_session_start(s.start_time)
  WHERE s.type = 'public'
    AND s.band_overridden = false
    AND s.start_time >= p_from
    AND s.band_id IS DISTINCT FROM band_for_session_start(s.start_time);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- Down (the two functions as they were before 032, then the two tables gone):
--   CREATE OR REPLACE FUNCTION public.generate_upcoming_sessions(horizon_days integer DEFAULT 98)
--    RETURNS integer
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--   declare v_edge date; v_target date; v_inserted int;
--   begin
--     v_target := (now() at time zone 'Europe/London')::date + horizon_days;
--     select coalesce(max(start_time)::date, (now() at time zone 'Europe/London')::date - 1)
--       into v_edge from sessions;
--     if v_edge >= v_target then return 0; end if;
--
--     insert into sessions (service_type_id, start_time, end_time, type, capacity, status)
--     select svc.id, (d.day + sl.start_time),
--            (d.day + sl.start_time) + (svc.duration || ' minutes')::interval,
--            svc.booking_type, svc.capacity, 'open'
--     from generate_series((v_edge + 1)::timestamp, v_target::timestamp, interval '1 day') as g(day_ts)
--     cross join lateral (select g.day_ts::date as day) d
--     join service_type_schedule_slots sl on sl.day_of_week = extract(dow from d.day)::smallint
--     join service_types svc on svc.id = sl.service_type_id
--     where svc.active and svc.duration is not null and svc.duration > 0 and svc.booking_type is not null
--     on conflict (service_type_id, start_time) do nothing;
--
--     get diagnostics v_inserted = row_count;
--     return v_inserted;
--   end $function$;
--
--   CREATE OR REPLACE FUNCTION public.reassign_session_bands(p_from timestamp with time zone DEFAULT now())
--    RETURNS integer
--    LANGUAGE plpgsql
--   AS $function$
--   DECLARE
--     v_count INTEGER;
--   BEGIN
--     UPDATE sessions s
--     SET band_id = band_for_session_start(s.start_time)
--     WHERE s.type = 'public'
--       AND s.band_overridden = false
--       AND s.start_time >= p_from
--       AND s.band_id IS DISTINCT FROM band_for_session_start(s.start_time);
--
--     GET DIAGNOSTICS v_count = ROW_COUNT;
--     RETURN v_count;
--   END;
--   $function$;
--
--   DROP TABLE public.closed_dates;
--   DROP TABLE public.sessions_made_up_to;
