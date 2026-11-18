-- 029: the credit allocation skips an active membership that is past its cancel date (brief W45a item 1; W45 audit S1).
-- NOT APPLIED by W45a. The lead applies it, after a diff check of this file against live.
--
-- Before: allocate_membership_credit_periods() gives every eligible membership its current credit period in ONE
-- insert. A cancelled membership is eligible only while its cancel_effective_date is today or later (London); an
-- active one was eligible whatever its cancel_effective_date. The new period's end is capped at
-- cancel_effective_date, so an active membership whose cancel date is before its current period's start gives a
-- period_end before its period_start. The CHECK membership_credit_periods_valid (period_end >= period_start) refuses
-- that row, and the whole statement fails: nobody's period is allocated. Everything that calls the function fails
-- with it: membership_mark_paid (the webhook's invoice.paid, for every member's renewal), the hourly
-- run_membership_maintenance, the daily credit job, and a membership order's T2 (after its card is charged).
-- Example (the audit's proof A): Mo pays GBP 40 a month and renews on the 10th. His row says his last day was 9
-- December while his subscription carries on. From 00:00 on 10 December until the row is put right, Sam's renewal is
-- not recorded and no member gets a new period.
-- How a row gets like that: a Stripe event handled out of order (fixed in the Worker by the same brief: the webhook
-- now reads Stripe); a cancel whose Stripe step never landed before the last day; a cancelled membership with no
-- subscription (nothing ever ends it); or simply the hour between a membership's last day and Stripe's
-- customer.subscription.deleted event being handled.
-- After: an active membership is eligible only while cancel_effective_date IS NULL OR cancel_effective_date >= today
-- (London), the same test a cancelled one already has. Such a row is left out; every other membership gets its period.
-- With that test, a capped end can no longer be before its period's start (period_start <= today <= cancel date).
--
-- What changes, exactly: one function, one line of it (the `active` line of the WHERE). Nothing else in the function
-- changes: its signature, SECURITY DEFINER, search_path, the period arithmetic, the cap, the ON CONFLICT and what it
-- returns are as they were, and so are its grants (CREATE OR REPLACE keeps them). No table, row or other function is
-- touched. The one line, before and after:
--   -        cm.subscription_status = 'active'
--   +        (cm.subscription_status = 'active' and (cm.cancel_effective_date is null or cm.cancel_effective_date >= today))
--
-- Order: either way round is safe, and 029 need not wait for the Worker. No code depends on the function failing, and
-- none on an active membership past its cancel date getting a period: the database's event_member_level and the
-- Worker's test for a credit booking (web/server/rules/orders/write-booking.ts) already count such a membership as
-- ended. The Worker's W45a change (the webhook reads Stripe) neither calls nor reads this function differently.
--
-- Pre-check (read-only). Expect 0 (the lead's live check on 18 Nov 2026: 0):
--    SELECT count(*) FROM public.customer_memberships
--    WHERE subscription_status = 'active' AND cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date;
-- Not 0: 029 is still safe to apply, and is what stops those rows failing the allocation for everyone. But each such
-- row is a membership whose last day has passed while it is still active: look at each against its Stripe
-- subscription (ended, or still renewing?) and tell the builder, because after 029 it quietly gets no new credit
-- period.
--
-- No data changes: no row is written or rewritten by the migration.
--
-- Check after applying (read-only): expect true.
--    SELECT pg_get_functiondef('public.allocate_membership_credit_periods()'::regprocedure)
--           LIKE '%(cm.subscription_status = ''active'' and (cm.cancel_effective_date is null or cm.cancel_effective_date >= today))%';

CREATE OR REPLACE FUNCTION public.allocate_membership_credit_periods()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  today date := (now() at time zone 'Europe/London')::date;
  inserted integer := 0;
begin
  with eligible as (
    select cm.id as membership_id, cm.start_date, cm.cancel_effective_date,
           p.sessions_included, p.is_unlimited,
           -- whole months elapsed since start (anchored to start day), never negative
           greatest(0,
             (extract(year from age(today, cm.start_date))::int * 12
              + extract(month from age(today, cm.start_date))::int)) as n
    from customer_memberships cm
    join membership_plans p on p.id = cm.plan_id
    where cm.start_date is not null
      and cm.start_date <= today
      and (
        (cm.subscription_status = 'active' and (cm.cancel_effective_date is null or cm.cancel_effective_date >= today))
        or (cm.subscription_status = 'cancelled' and cm.cancel_effective_date >= today)
      )
  ), periods as (
    select membership_id, sessions_included, is_unlimited, cancel_effective_date,
           (start_date + make_interval(months => n))::date as period_start,
           ((start_date + make_interval(months => n + 1))::date - 1) as period_end
    from eligible
  ), ins as (
    insert into membership_credit_periods
      (membership_id, period_start, period_end, credits_allocated, is_unlimited)
    select membership_id, period_start,
           least(period_end, coalesce(cancel_effective_date, period_end)),
           case when is_unlimited then 0 else coalesce(sessions_included, 0) end,
           is_unlimited
    from periods
    where period_start <= today and period_end >= today
    on conflict (membership_id, period_start) do nothing
    returning 1
  )
  select count(*) into inserted from ins;
  return inserted;
end;
$function$;

-- After applying: the saved test schema needs no refresh for the Worker's tests (they pass before and after: brief
-- W45a item 1; migration-029.test.ts holds the migration either way). When the next Worker brief does refresh it
-- (web/server/rules/testing/README.md, "Refreshing the live schema"), it should show this function's one changed line
-- in live-schema.sql and its new definition in live-catalog.json, and nothing else.
--
-- Rollback: the Down below. It puts back the club-wide failure for any active membership past its cancel date, so
-- run the pre-check first and expect 0.
--
-- Down (the function as it was before 029):
--   CREATE OR REPLACE FUNCTION public.allocate_membership_credit_periods()
--    RETURNS integer
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--   declare
--     today date := (now() at time zone 'Europe/London')::date;
--     inserted integer := 0;
--   begin
--     with eligible as (
--       select cm.id as membership_id, cm.start_date, cm.cancel_effective_date,
--              p.sessions_included, p.is_unlimited,
--              -- whole months elapsed since start (anchored to start day), never negative
--              greatest(0,
--                (extract(year from age(today, cm.start_date))::int * 12
--                 + extract(month from age(today, cm.start_date))::int)) as n
--       from customer_memberships cm
--       join membership_plans p on p.id = cm.plan_id
--       where cm.start_date is not null
--         and cm.start_date <= today
--         and (
--           cm.subscription_status = 'active'
--           or (cm.subscription_status = 'cancelled' and cm.cancel_effective_date >= today)
--         )
--     ), periods as (
--       select membership_id, sessions_included, is_unlimited, cancel_effective_date,
--              (start_date + make_interval(months => n))::date as period_start,
--              ((start_date + make_interval(months => n + 1))::date - 1) as period_end
--       from eligible
--     ), ins as (
--       insert into membership_credit_periods
--         (membership_id, period_start, period_end, credits_allocated, is_unlimited)
--       select membership_id, period_start,
--              least(period_end, coalesce(cancel_effective_date, period_end)),
--              case when is_unlimited then 0 else coalesce(sessions_included, 0) end,
--              is_unlimited
--       from periods
--       where period_start <= today and period_end >= today
--       on conflict (membership_id, period_start) do nothing
--       returning 1
--     )
--     select count(*) into inserted from ins;
--     return inserted;
--   end;
--   $function$;
