-- 028: the hourly job stops calling the database's lapse sweep (brief W43 item 3; F-plan 1.9, 4.8; N8; bugs FB18, FB19).
-- NOT APPLIED by W43. The lead applies it, after the W43 review, once the Worker's switch kind `lapse_sweep` is ON.
--
-- Before: run_membership_maintenance() (hourly) allocates the membership credit periods, then calls
-- lapse_sweep_expired_bookings(), which cancels every booking that is payment needed, past its deadline and has
-- price_paid = 0: a bare status change (cancel_reason 'membership_lapsed') and its places released. No audit row, none
-- of what a cancel does, none of the Worker's locks' order, and never a booking with money on it (FB18: it then holds
-- its places for ever). A booking with price_paid = 0 and a paid add-on is cancelled and the add-on's money kept, with
-- nothing recorded (FB19).
-- After: run_membership_maintenance() allocates the credit periods and no longer calls the sweep. The Worker's own
-- sweep (web/server/rules/bookings/lapse-sweep.ts), on its five-minute schedule, is the only one: it cancels each due
-- booking through the Worker's cancel, under the booking's locks, with its audit rows, and Wayne's Q48 for money on
-- it (24 hours or more before the session: paid guests and paid add-ons to store credit; inside 24 hours: nothing
-- back; never to a card).
--
-- What changes, exactly: one function, two lines of it. The call is gone, and the answer's
-- 'lapsed_bookings_cancelled' is now always 0 (the key is kept, so whatever reads the job's answer reads the same
-- shape). Its signature, SECURITY DEFINER, search_path and grants are as they were (CREATE OR REPLACE keeps the
-- grants). lapse_sweep_expired_bookings() itself is KEPT, untouched and still callable (the Worker's tests replay
-- W36's recordings of it; W44 or step H can drop it).
--
-- Order (W43a, the W43 review's S4). Steps 2 to 4 in ONE sitting, so the two sweeps run side by side for minutes, not
-- hours. While both run, the database's hourly sweep can reach a booking with price_paid = 0 and a paid add-on before
-- the Worker's run does, and then the add-on's money is kept with nothing recorded, as before (FB19). Nothing else
-- differs while both run (each takes the booking's row lock and the second finds it cancelled;
-- lapse-sweep-postgres.test.ts and lapse-replay.test.ts hold that).
--   1. The Worker released with `lapse_sweep` off (nothing changes).
--   2. Pre-check A (read-only), BEFORE the kind goes on. Expect 0: no payment-needed booking with nothing paid on its
--      seat and a paid add-on still on it (the one booking the database's sweep could get wrong while both run).
--      Not 0: stop and tell the builder.
--        SELECT count(*) FROM bookings b
--        WHERE b.status = 'payment_needed' AND COALESCE(b.price_paid, 0) = 0
--          AND EXISTS (SELECT 1 FROM addon_order_lines a WHERE a.booking_id = b.id AND a.removed_at IS NULL
--                      AND a.redemption_source IS DISTINCT FROM 'membership_credit' AND a.price_at_purchase > 0);
--   3. The kind ON: add `lapse_sweep` to ORDER_SWITCH (no deploy). Both sweeps now run.
--   4. This migration, in the same sitting: as soon as one Worker run has gone by since step 3 (five minutes at most),
--      or pre-check B below passes. Don't leave it for later.
-- Never apply it while the kind is off: no sweep would run at all, and a payment-needed booking past its deadline
-- would hold its places until the kind went on.
--
-- Rollback, in this order: (1) the kind off FIRST (remove `lapse_sweep` from ORDER_SWITCH: no deploy, and it stops
-- the Worker's sweep at once); (2) the Down below, straight after (the database's sweep back in the hourly job).
-- The few minutes in between with no sweep only mean a booking lapses a few minutes late: nothing is given and
-- nothing is kept. (The other way round leaves both sweeps running in between, and keeps the Worker's sweep running
-- longer when it is the reason for the rollback.)
--
-- Pre-check B (read-only), at step 4, with the kind ON. Expect 0 rows: nothing is left past its deadline, so the
-- Worker's sweep is the one doing the work. A row here that stays for more than two runs means the Worker's sweep is
-- leaving it (a payment still being taken, a refund still being checked: see the Worker's `lapse_sweep.run` log line)
-- or isn't running: stop and tell the builder.
--    SELECT id, payment_due_by, price_paid FROM public.bookings
--    WHERE status = 'payment_needed' AND payment_due_by <= now() - interval '10 minutes';
-- (The lead's live check on 18 Nov 2026: 0 bookings in payment_needed at all.)
--
-- No data changes: no row is written or rewritten by the migration.
--
-- Check after applying (read-only): expect false, then true (the sweep is no longer called; it still exists).
--    SELECT pg_get_functiondef('public.run_membership_maintenance()'::regprocedure) LIKE '%lapse_sweep_expired_bookings%';
--    SELECT to_regprocedure('public.lapse_sweep_expired_bookings()') IS NOT NULL;

CREATE OR REPLACE FUNCTION public.run_membership_maintenance()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE p integer;
BEGIN
  p := public.allocate_membership_credit_periods();
  RETURN jsonb_build_object('periods_created', p, 'lapsed_bookings_cancelled', 0);
END $function$;

-- After applying: the saved test schema needs no refresh for the Worker's tests (they pass before and after: brief
-- W43 item 3; migration-028.test.ts holds the migration either way, and no Worker test calls
-- run_membership_maintenance). When the next brief does refresh it (web/server/rules/testing/README.md, "Refreshing
-- the live schema"), it should show this function's two changed lines in live-schema.sql and its new definition in
-- live-catalog.json, and nothing else.
--
-- Down (the function as it was before 028):
--   CREATE OR REPLACE FUNCTION public.run_membership_maintenance()
--    RETURNS jsonb
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--   DECLARE p integer; s integer;
--   BEGIN
--     p := public.allocate_membership_credit_periods();
--     s := public.lapse_sweep_expired_bookings();
--     RETURN jsonb_build_object('periods_created', p, 'lapsed_bookings_cancelled', s);
--   END $function$;
