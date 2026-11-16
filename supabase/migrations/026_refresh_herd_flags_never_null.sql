-- 026: the hourly Herd job can no longer be stopped by one membership with no billing frequency (brief W37a item 3;
-- W37 report "Noticed" 1; W37 review L3).
-- NOT APPLIED by W37a. The lead applies it. It can go on before or after the W37 / W37a Worker and staff app: see
-- "Order" below.
--
-- Before: refresh_herd_flags() (run hourly by run_membership_maintenance, and by the staff app's OLD setMembershipHerd
-- when an override is cleared) sets is_herd to the rule's answer for every membership with no override:
--    billing_frequency = 'yearly' OR start_date <= today (London) - the wait
-- For a membership with NO billing frequency that hasn't waited long enough, that is NULL OR false = NULL, and is_herd
-- is NOT NULL. The UPDATE fails ("null value in column "is_herd" ... violates not-null constraint") and, being one
-- statement, rolls back for the whole table: nobody's Herd flag is refreshed that hour, or any hour, until that one
-- row is fixed. Example: a member who reaches six months on the 10th stays "not Herd" (no add-on credits released)
-- for as long as such a row exists.
-- After: the rule is wrapped in COALESCE(..., false) in both places it appears (the value set, and the "is distinct
-- from" that picks the rows), so that membership is simply not Herd and every other membership is refreshed as
-- before. The rule itself is unchanged, word for word: the Worker's single-membership version (HERD_RULE_SQL in
-- web/server/rules/memberships/credits.ts, which already wraps it in COALESCE(..., false)) stays in step, and
-- credits.test.ts fails if the two ever differ. Nothing else in the function changes: its signature, SECURITY
-- DEFINER, search_path and grants are as they were (CREATE OR REPLACE keeps the grants).
--
-- Order: either way round is safe. No code depends on the function failing. The published staff app's old
-- setMembershipHerd calls it when an override is cleared (until W37 is published); the W37 Worker doesn't call it.
--
-- Check first (read-only): how many memberships the old function would fail on. Any number is fine for this
-- migration (it is what 026 fixes); the lead's live check on 16 Nov 2026 found 0 with no billing frequency and no
-- override.
--    SELECT count(*) FROM public.customer_memberships WHERE billing_frequency IS NULL AND herd_override IS NULL;
--
-- No data changes: no row is written or rewritten by the migration. The next hourly run refreshes flags as usual.
--
-- Check after applying (read-only): expect 2.
--    SELECT (length(d) - length(replace(d, 'coalesce((cm.billing_frequency = ''yearly''', ''))) / length('coalesce((cm.billing_frequency = ''yearly''')
--    FROM (SELECT pg_get_functiondef('public.refresh_herd_flags()'::regprocedure) AS d) f;

CREATE OR REPLACE FUNCTION public.refresh_herd_flags()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  wait_months integer;
  changed integer;
begin
  select addon_credit_wait_months into wait_months from public.membership_settings where id;
  wait_months := coalesce(wait_months, 6);
  update public.customer_memberships cm
     set is_herd = coalesce((cm.billing_frequency = 'yearly'
                    or cm.start_date <= (now() at time zone 'Europe/London')::date - (wait_months || ' months')::interval), false),
         updated_at = now()
   where cm.herd_override is null
     and cm.is_herd is distinct from coalesce((cm.billing_frequency = 'yearly'
                    or cm.start_date <= (now() at time zone 'Europe/London')::date - (wait_months || ' months')::interval), false);
  get diagnostics changed = row_count;
  return changed;
end $function$;

-- After applying: refresh the Worker's test schema from the live catalog (web/server/rules/testing/README.md,
-- "Refreshing the live schema") and run `npm run schema:test -- --check`, then the Worker's tests. The refresh should
-- show the function's two changed lines in live-schema.sql and its new definition in live-catalog.json, and nothing
-- else. migration-026.test.ts and credits.test.ts pass before and after the refresh.
--
-- Down (the function as it was before 026): run the statement above again with the two `coalesce(` wrappers and
-- their `, false)` removed, i.e. with
--      set is_herd = (cm.billing_frequency = 'yearly'
--                     or cm.start_date <= (now() at time zone 'Europe/London')::date - (wait_months || ' months')::interval),
-- and
--      and cm.is_herd is distinct from (cm.billing_frequency = 'yearly'
--                     or cm.start_date <= (now() at time zone 'Europe/London')::date - (wait_months || ' months')::interval);
