-- 034: step H's leftovers in the database: one audit_log index, the duplicate email index and what nothing reads any more
-- dropped, and the nightly job's session times name their zone (brief W68 item 5; H-plan H9, H10, H11; the W45 audit's
-- rows 20 and 59; lead calls L-H7 and L-H8; Wayne's yes to the drops, 23 Nov 2026).
-- NOT APPLIED by W68 or W68a. The lead applies it after their reviews and AFTER the W68 Worker is LIVE: `GET /api/test`
-- answers 404 (a push is not enough: until Cloudflare has built it, the Worker before it is still serving, and that one
-- reads service_types.price). The staff app needs nothing from it and it needs nothing from the staff app, so it can be
-- applied before or after the staff app is published.
-- Never run 028's Down after 034 (the hourly job calls the dropped function).
-- APPLY IT AS ONE TRANSACTION (`apply_migration`, or the SQL editor's one multi-statement run): all of it, or none. WITH
-- NOBODY PRESSING (no sale, no booking change), and NOT ON A 5-MINUTE MARK (the Worker's scheduled run starts on each).
--
-- What it does, and why each part is safe:
--   1. CREATE INDEX audit_log_action_entity_idx ON audit_log (action, entity_type, entity_id) (H9). Reconcile, the stuck
--      list, Block Day and the plan reads look rows up by action, most of them by entity too; there are only the primary
--      key, two indexes (by actor, by entity) and the refund claims' own today. 105 rows on 23 Nov 2026: nothing is slow, this is for growth.
--   2. DROP INDEX idx_customers_email (W45 20): `customers_email_key` (the unique key on the same column) already serves
--      every look-up by email as written, and migration 027's index serves lower(email).
--   3. DROP VIEW membership_credit_period_balances (H10): no view, function or Worker statement reads it
--      (membership_current_credits is the one that is read, and is not built on it). A view holds no rows.
--   4. ALTER TABLE service_types DROP COLUMN price (H10): a public type is priced by its band, a private one by its size
--      groups. Every value is null on live (W68-3).
--   5. DROP TABLE parity_log, its nightly purge (function and cron job) (H10): step C's shadow log, written by nothing
--      since W16. 0 rows on live (W68-3).
--   6. DROP FUNCTION membership_period_for and lapse_sweep_expired_bookings (H10, W45 59): nothing calls either. The
--      second is the database's old lapse sweep, which migration 028 took out of the hourly job and kept; its going ends
--      028's Down. RUNBOOK: `lapse_sweep` off pauses lapsing (bookings past their deadline keep their places until it is
--      on again); fix forward.
--   7. generate_upcoming_sessions names AT TIME ZONE 'UTC' for the times it makes (H11). It computed them as a timestamp
--      WITHOUT a zone and let the connection's zone turn it into one. Live's zone is UTC (W68-1), so the rows are the same;
--      under any other zone a 10:00 session would have been stored at another time, on another band. Two lines change (and
--      two comment lines); its signature, SECURITY DEFINER, search_path and grants are as they were.
-- No row of any table is written or rewritten. Nothing is dropped with CASCADE: if something does read one of these, its
-- drop fails and the whole file changes nothing.
--
-- Locks: the first statement takes the three busy tables it changes (audit_log, customers, service_types) at once and
-- NOWAIT (W68 review L4): if anything is using one of them the file fails there and then ("could not obtain lock on
-- relation"), with nothing changed, so it can never sit half locked in a deadlock with a sale. Apply it again a minute
-- later. Then each lock is held for milliseconds (audit_log has 105 rows; a column drop rewrites nothing). lock_timeout is
-- 5s, for what it takes after those.
--
-- PRE-CHECKS (read-only; the lead runs them first, and stops if one isn't as said).
--   P1. Nothing to lose (W68-3). Expect 0, 0. The file itself stops, changing nothing, if either isn't 0.
--        SELECT count(*) AS parity_rows FROM public.parity_log;
--        SELECT count(*) AS priced_service_types FROM public.service_types WHERE price IS NOT NULL;
--   P2. No reader in the database. Expect no row, then only purge_parity_log.
--        SELECT viewname FROM pg_views WHERE schemaname = 'public'
--           AND (definition ILIKE '%membership_credit_period_balances%' OR definition ILIKE '%parity_log%');
--        SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--         WHERE n.nspname = 'public' AND (p.prosrc ILIKE '%membership_credit_period_balances%' OR p.prosrc ILIKE '%parity_log%'
--            OR p.prosrc ILIKE '%membership_period_for%' OR p.prosrc ILIKE '%lapse_sweep_expired_bookings%');
--   P3. No cron job but the purge names any of it. Expect only purge-parity-log.
--        SELECT jobname FROM cron.job WHERE command ILIKE '%parity_log%' OR command ILIKE '%lapse_sweep_expired_bookings%'
--            OR command ILIKE '%membership_period_for%' OR command ILIKE '%membership_credit_period_balances%';
--   P4. The horizon and the bands before, kept to compare the morning after. Expect `furthest` London's today + 98 (or
--       the day before, if today's 02:15 run hasn't been), and 0.
--        SELECT max((start_time AT TIME ZONE 'UTC')::date) AS furthest, (SELECT made_up_to FROM public.sessions_made_up_to) AS made_up_to FROM public.sessions;
--        SELECT count(*) AS wrong_band FROM public.sessions
--         WHERE type = 'public' AND NOT band_overridden
--           AND start_time >= ((now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'UTC')
--           AND band_id IS DISTINCT FROM band_for_session_start(start_time);
--   P5 to P10 (the W68 review's B1 to B6; P5 last, straight before applying).
--   P5 (B1). Nothing long is open, so 034 doesn't fail on its first lock. Expect no row.
--        SELECT pid, usename, state, now() - xact_start AS open_for FROM pg_stat_activity
--         WHERE xact_start < now() - interval '5 seconds' AND pid <> pg_backend_pid();
--   P6 (B2). Functions naming the table (a function's body is not a dependency, so the column's drop wouldn't stop for
--       one). Expect only generate_upcoming_sessions, which doesn't name the column.
--        SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosrc ~* 'service_types';
--   P7 (B3). Anything depending on the column. Expect no row.
--        SELECT pg_describe_object(d.classid, d.objid, d.objsubid) FROM pg_depend d WHERE d.refobjid = 'public.service_types'::regclass
--           AND d.refobjsubid = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.service_types'::regclass AND attname = 'price');
--   P8 (B4). The purge's owner is the role that applies 034 (or the unschedule sees nothing). Expect true.
--        SELECT username = current_user FROM cron.job WHERE jobname = 'purge-parity-log';
--   P9 (B5). The Worker's rights are on the whole table (so a column put back is covered). Expect 4 rows or more.
--        SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'service_types' AND grantee = 'paddock_worker';
--   P10 (B6). The nightly job's grants, kept to compare with check 6.
--        SELECT proacl FROM pg_proc WHERE oid = 'public.generate_upcoming_sessions(integer)'::regprocedure;
--
-- SAVE FIRST (L-H7), to a file kept with the migration log, even when empty:
--        SELECT * FROM public.parity_log ORDER BY at;
--        SELECT id, name, price FROM public.service_types ORDER BY name;
--        SELECT * FROM public.membership_credit_period_balances ORDER BY period_start, id;
--        SELECT jobid, jobname, schedule, command, active FROM cron.job WHERE jobname = 'purge-parity-log';
--        SELECT pg_get_functiondef('public.purge_parity_log()'::regprocedure);
--        SELECT pg_get_functiondef('public.membership_period_for(date, date)'::regprocedure);
--        SELECT pg_get_functiondef('public.lapse_sweep_expired_bookings()'::regprocedure);
--        SELECT pg_get_viewdef('public.membership_credit_period_balances'::regclass);
--
-- CHECKS after applying (read-only), each with what to expect:
--   1. true, then no row:
--        SELECT to_regclass('public.audit_log_action_entity_idx') IS NOT NULL;
--        SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_customers_email';
--   2. All gone: null, null, null, null, null, null, 0:
--        SELECT to_regclass('public.membership_credit_period_balances'), to_regclass('public.parity_log'),
--               to_regprocedure('public.purge_parity_log()'), to_regprocedure('public.membership_period_for(date, date)'),
--               to_regprocedure('public.lapse_sweep_expired_bookings()'),
--               (SELECT attname FROM pg_attribute WHERE attrelid = 'public.service_types'::regclass AND attname = 'price' AND NOT attisdropped),
--               (SELECT count(*) FROM cron.job WHERE jobname = 'purge-parity-log');
--   3. The five other cron jobs are as they were:
--        SELECT jobname, schedule, command, active FROM cron.job ORDER BY jobname;
--   4. The job names its zone: true.
--        SELECT pg_get_functiondef('public.generate_upcoming_sessions(integer)'::regprocedure) LIKE '%(d.day + sl.start_time) at time zone ''UTC''%';
--   5. The morning after: the date has moved by one day, the new day's sessions are at their slots' times, and the
--      standing band check is still 0 (P4's two queries again), then expect 0 rows:
--        SELECT s.id, s.start_time FROM public.sessions s
--         WHERE (s.start_time AT TIME ZONE 'UTC')::date = (SELECT made_up_to FROM public.sessions_made_up_to)
--           AND NOT EXISTS (SELECT 1 FROM public.service_type_schedule_slots sl
--                            WHERE sl.service_type_id = s.service_type_id
--                              AND sl.day_of_week = extract(dow FROM (s.start_time AT TIME ZONE 'UTC'))::smallint
--                              AND sl.start_time = (s.start_time AT TIME ZONE 'UTC')::time);
--      (A one-off session made for that day would be listed: that is staff's.)
--   6 to 8 (the W68 review's A2 to A4).
--   6 (A2). The nightly job's grants, the same as P10:
--        SELECT proacl FROM pg_proc WHERE oid = 'public.generate_upcoming_sessions(integer)'::regprocedure;
--   7 (A3). The morning after: no job failed. Expect no row:
--        SELECT j.jobname, d.status, d.return_message, d.start_time FROM cron.job_run_details d JOIN cron.job j USING (jobid)
--         WHERE d.start_time > now() - interval '26 hours' AND d.status <> 'succeeded';
--   8 (A4). The morning after: no slot of the new day without its session (unless that day is closed). Expect no row:
--        SELECT st.name, sl.start_time FROM public.sessions_made_up_to m
--          JOIN public.service_type_schedule_slots sl ON sl.day_of_week = extract(dow FROM m.made_up_to)::smallint
--          JOIN public.service_types st ON st.id = sl.service_type_id AND st.active AND st.duration > 0 AND st.booking_type IS NOT NULL
--         WHERE NOT EXISTS (SELECT 1 FROM public.closed_dates c WHERE c.closed_on = m.made_up_to)
--           AND NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.service_type_id = st.id AND s.start_time = ((m.made_up_to + sl.start_time) AT TIME ZONE 'UTC'));
-- Then refresh the saved schema (web/server/rules/testing/README.md, "Refreshing the live schema"): the diff should be
-- these seven parts and nothing else. The Worker's tests pass before and after the refresh.
--
-- ROLLBACK. The Worker: a revert to before W68 reads service_types.price, so FIRST put the column back (its values were all null):
--        ALTER TABLE public.service_types ADD COLUMN price numeric(10,2);
-- The database: the Down at the end, for the parts that aren't drops. The drops are not undone (the saved rows and
-- definitions above are the record).

SET LOCAL lock_timeout = '5s';

-- The busy tables it changes, together and at once (W68 review L4): one in use fails the file here, with nothing changed.
LOCK TABLE public.audit_log, public.customers, public.service_types IN ACCESS EXCLUSIVE MODE NOWAIT;

-- The stop: a row that would be lost. Nothing has been changed yet.
DO $$
DECLARE v_parity bigint := 0; v_priced bigint := 0;
BEGIN
  IF to_regclass('public.parity_log') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.parity_log' INTO v_parity;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.service_types'::regclass AND attname = 'price' AND NOT attisdropped) THEN
    EXECUTE 'SELECT count(*) FROM public.service_types WHERE price IS NOT NULL' INTO v_priced;
  END IF;
  IF v_parity > 0 OR v_priced > 0 THEN
    RAISE EXCEPTION 'Migration 034 stopped and changed nothing: parity_log has % row(s), service_types has % priced row(s). Save them, then tell the builder.', v_parity, v_priced;
  END IF;
END $$;

-- 1. The audit log's index.
CREATE INDEX IF NOT EXISTS audit_log_action_entity_idx ON public.audit_log USING btree (action, entity_type, entity_id);

-- 2. The duplicate email index.
DROP INDEX IF EXISTS public.idx_customers_email;

-- 3 to 6. What nothing reads.
DROP VIEW IF EXISTS public.membership_credit_period_balances;
ALTER TABLE public.service_types DROP COLUMN IF EXISTS price;
DO $$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-parity-log';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.purge_parity_log();
DROP TABLE IF EXISTS public.parity_log;
DROP FUNCTION IF EXISTS public.membership_period_for(date, date);
DROP FUNCTION IF EXISTS public.lapse_sweep_expired_bookings();

-- 7. The nightly job's session times name their zone.
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
  -- 034 (H11): a session's time is London's wall-clock digits stored as UTC, named here, so the row is the same
  -- whatever zone the connection running the job is in.
  select svc.id, ((d.day + sl.start_time) at time zone 'UTC'),
         ((d.day + sl.start_time) at time zone 'UTC') + (svc.duration || ' minutes')::interval,
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

-- Down (the parts that aren't drops; the job as it was before 034):
--   DROP INDEX IF EXISTS public.audit_log_action_entity_idx;
--   CREATE INDEX IF NOT EXISTS idx_customers_email ON public.customers USING btree (email);
--   CREATE OR REPLACE FUNCTION public.generate_upcoming_sessions(horizon_days integer DEFAULT 98)
--    RETURNS integer
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--   declare v_edge date; v_target date; v_inserted int; v_skipped date[]; v_days date[]; v_open date[]; v_closed date[];
--   begin
--     -- 032 (W51-1): the band guard, shared, before anything is written. A band-window save holds these rows, so a
--     -- session made here is banded by the windows the save leaves, and a save that starts later waits for this run.
--     perform 1 from session_bands order by id for share;
--     v_target := (now() at time zone 'Europe/London')::date + horizon_days;
--     -- 032 (GB3): the job's own date, not the furthest session. Locked, so two runs at once take turns. With no row
--     -- (a database never set up) it starts from today, and writes the row below.
--     select made_up_to, closed_days_skipped into v_edge, v_skipped from sessions_made_up_to where id for update;
--     if not found then v_edge := (now() at time zone 'Europe/London')::date - 1; v_skipped := '{}'; end if;
--     -- 032 (closed dates): the days this run is for. Each day after the job's date up to the target, and each closed
--     -- day an earlier run left out that hasn't passed. Then one lock for each, in date order: the lock Block Day,
--     -- Unblock Day and a one-off session take for their date, so no date is closed or reopened while this run makes it.
--     -- Then which of them are closed, read after the locks (a new statement sees what a press that held one committed).
--     select coalesce(array_agg(q.day order by q.day), '{}') into v_days
--       from (select g.day_ts::date as day from generate_series((v_edge + 1)::timestamp, v_target::timestamp, interval '1 day') as g(day_ts)
--             union
--             select s.day from unnest(v_skipped) as s(day) where s.day >= (now() at time zone 'Europe/London')::date) q;
--     if v_days = '{}' then return 0; end if;
--     perform pg_advisory_xact_lock(hashtextextended('session_day:' || to_char(l.day, 'YYYY-MM-DD'), 0)) from unnest(v_days) as l(day);
--     select coalesce(array_agg(q.day order by q.day) filter (where c.closed_on is null), '{}'),
--            coalesce(array_agg(q.day order by q.day) filter (where c.closed_on is not null), '{}')
--       into v_open, v_closed
--       from unnest(v_days) as q(day) left join closed_dates c on c.closed_on = q.day;
--
--     insert into sessions (service_type_id, start_time, end_time, type, capacity, status)
--     select svc.id, (d.day + sl.start_time),
--            (d.day + sl.start_time) + (svc.duration || ' minutes')::interval,
--            svc.booking_type, svc.capacity, 'open'
--     from unnest(v_open) as g(day_ts)
--     cross join lateral (select g.day_ts::date as day) d
--     join service_type_schedule_slots sl on sl.day_of_week = extract(dow from d.day)::smallint
--     join service_types svc on svc.id = sl.service_type_id
--     where svc.active and svc.duration is not null and svc.duration > 0 and svc.booking_type is not null
--     on conflict (service_type_id, start_time) do nothing;
--
--     get diagnostics v_inserted = row_count;
--     -- 032 (GB3): made up to the target, whether or not any slot fell on those days (never moved back by a run with a
--     -- shorter horizon). The closed days this run left out are kept, so a later run makes one that has been reopened.
--     insert into sessions_made_up_to (id, made_up_to, closed_days_skipped) values (true, greatest(v_edge, v_target), v_closed)
--     on conflict (id) do update set made_up_to = excluded.made_up_to, closed_days_skipped = excluded.closed_days_skipped, updated_at = now();
--     return v_inserted;
--   end $function$;
