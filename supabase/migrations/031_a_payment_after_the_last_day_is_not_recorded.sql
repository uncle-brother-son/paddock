-- 031: a payment after the membership's last day is not recorded, and a failed one does not mark it past due
-- (brief W47r-d item 1 and brief W47r-e item 2; W47r-c report "Noticed" 1, fix a; W47r-d report "Noticed" 2; Wayne's
-- rule: a cancelled member is never charged with nothing listed).
-- NOT APPLIED by W47r-d or W47r-e. The lead applies it, with Wayne's yes, after a diff check of this file against live.
--
-- Before: Cancel pressed in the staff app writes the membership's last day (cancel_effective_date) and leaves its
-- status as it is; the row is marked cancelled only when Stripe ends the subscription. If that cancel never reaches
-- Stripe, Stripe renews, and membership_mark_paid(text, timestamptz) records the payment like any other: the
-- membership is marked active, its next payment date moves on a month, its flagged credit bookings go back to
-- confirmed, and nothing says the money needs to go back. And if that renewal's payment fails,
-- membership_mark_payment_failed(text) marks the membership past due, though it ended here on its last day.
-- Example (W47r-c's proof A, briefs/W47rc-logs/14-proofs.test.ts.txt): Mo pays GBP 40 a month and renews on the
-- 10th. Cancel is pressed; his last day is 9 January. The cancel never reaches Stripe. On 10 January Stripe takes
-- GBP 40. Before: answered `reactivated`, status active, next payment 10 February, nothing listed, and Mo has no
-- access (every rule that reads the last day gives him none).
-- Example (W47r-d's proof 2, briefs/W47rd-logs/22-proofs.test.ts.txt): the same, but on 10 January Mo's card is
-- declined. Before: answered `past_due`, and the row reads past due a day after its last day.
-- After: when the membership's last day is before today (London), each function answers `ignored_cancelled`, the
-- answer it already gives for a membership that has ended (here with the last day beside it, `last_day`, so the
-- notice's row says why), and writes nothing: no status, no next payment date, no booking put back or flagged, no
-- credit period. For a payment the Worker reads that answer and lists the payment for a refund, once for an
-- invoice (W47r-c item 2: app/api/stripe/webhook/dispatch.ts, recordInvoicePaid). Mo: nothing written, GBP 40
-- listed on the Orders page with Mark refunded. For a failed payment no money moved, so nothing is listed for it;
-- the Worker lists the membership itself while Stripe's subscription is still live (W47r-e item 3).
-- A payment, or a failed payment, on the last day itself or before it, and one for a membership with no last day,
-- is handled exactly as before. Example: Stripe takes a late payment on 8 January: `reactivated`, as now.
--
-- What changes, exactly: two functions, six lines added to each and none changed or removed. Their signatures,
-- SECURITY DEFINER, search_path and what they return are as they were, and so are their grants (CREATE OR REPLACE
-- keeps them). No table, row or other function is touched. The lines, as diffs against live:
--   --- saved schema (live): membership_mark_paid(text, timestamp with time zone)
--   +++ migration 031: membership_mark_paid(text, timestamp with time zone)
--   @@ -11,6 +11,12 @@
--      IF m.subscription_status = 'cancelled' THEN
--        RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled');
--      END IF;
--   +  -- 031: the membership's last day has passed (London's date). Cancel was pressed here and the row keeps its status
--   +  -- until Stripe ends the subscription, so a payment Stripe takes after that day pays for time the member does not
--   +  -- have. Nothing is written for it; the Worker lists the payment for a refund (W47r-c, W47r-d).
--   +  IF m.cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date THEN
--   +    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled', 'last_day', m.cancel_effective_date);
--   +  END IF; -- 031
--      UPDATE customer_memberships
--      SET subscription_status = 'active',
--          next_renewal_date = COALESCE((p_period_end AT TIME ZONE 'Europe/London')::date, next_renewal_date),
--   --- saved schema (live): membership_mark_payment_failed(text)
--   +++ migration 031: membership_mark_payment_failed(text)
--   @@ -11,6 +11,12 @@
--      IF m.subscription_status = 'cancelled' THEN
--        RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled');
--      END IF;
--   +  -- 031: the membership's last day has passed (London's date). It has ended here, whatever Stripe's subscription
--   +  -- still does, so a payment that fails after that day does not mark it past due and flags no booking. Nothing is
--   +  -- written for it; the Worker lists a subscription still live in Stripe for a person (W47r-e).
--   +  IF m.cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date THEN
--   +    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled', 'last_day', m.cancel_effective_date);
--   +  END IF; -- 031
--      UPDATE customer_memberships SET subscription_status = 'past_due', updated_at = now() WHERE id = m.id;
--      SELECT COALESCE(max(period_end), (now() AT TIME ZONE 'Europe/London')::date - 1) INTO covered
--      FROM membership_credit_periods WHERE membership_id = m.id;
--
-- What it can and can't do:
--   - It only ever writes less than before: the new lines return before each function's first write.
--   - It only acts on a membership that has a last day, and only from the day after it. A member who has not
--     cancelled has none; one cancelled in Stripe as well is marked cancelled by Stripe's own notice and was
--     already answered `ignored_cancelled` by the lines above.
--   - A membership past due whose last day has passed is covered too: a late payment of its last invoice, taken
--     after the last day, is not recorded and its flagged credit bookings stay as they are. The Worker lists that
--     payment for a person, who refunds it or marks it as owed (W47r-d item 3).
--   - A failed payment after the last day no longer flags the membership's credit bookings after the day it was
--     paid up to (flag_uncovered_credit_bookings is not reached). They are flagged, as before, when Stripe ends the
--     subscription (membership_mark_cancelled_by_stripe), which is what the Worker's line asks a manager to do.
--   - Undo cancel clears the last day (it is refused once the day has passed). Stripe's own notice of a subscription
--     with no end clears it too (membership_sync_cancel_at_period_end), but from W47r-e not while a cancel pressed
--     here is still waiting on Stripe. A payment after the day is cleared is recorded as before.
--   - Rows already written are not changed: a membership already marked paid, or past due, past its last day stays
--     as it is.
--   - No other function in the database calls either function. The Worker calls membership_mark_paid from Stripe's
--     invoice.paid notice, from the read after a failed-payment notice's write (L8), and from "Try the payment again
--     now" (the press and reconcile), and membership_mark_payment_failed from Stripe's invoice.payment_failed notice
--     and from the read after a payment's write (L8); each already reads `ignored_cancelled` as "nothing written,
--     and never will be".
--
-- Order: the Worker with W47r-c, W47r-d and W47r-e first, then 031. Either way round nothing breaks, but:
--   - the Worker without 031 does what live does today for these cases (the payment is recorded, nothing listed; a
--     failed payment marks the row past due);
--   - 031 without that Worker (live af5048a) records nothing and lists nothing for a renewal taken by Stripe (that
--     Worker does not list on `ignored_cancelled`), and a notice handled then is not handled again. A payment taken
--     by "Try the payment again now" is held for a refund by either Worker.
-- The Worker's tests pass with the saved schema as live is today and with 031 in it.
--
-- Pre-checks (read-only). Expect 0 for each:
--    SELECT count(*) FROM public.customer_memberships
--    WHERE subscription_status = 'active' AND cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date;
--    SELECT count(*) FROM public.customer_memberships
--    WHERE subscription_status = 'past_due' AND cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date;
-- Not 0 on either: 031 is still safe to apply. Each row is a membership whose last day has passed and which Stripe
-- has not ended (or has no subscription, which the Worker ends on its own, W46): look at each one's
-- subscription in Stripe and cancel it there if it is still live, and tell the builder. The Worker lists each one
-- whose subscription is still live on the Orders page (W47r-e item 3). From 031 on, a payment Stripe takes for one
-- of them is not recorded, and is listed for a refund.
--
-- No data changes: no row is written or rewritten by the migration.
--
-- Check after applying (read-only): expect true.
--    SELECT pg_get_functiondef('public.membership_mark_paid(text, timestamp with time zone)'::regprocedure)
--           LIKE '%IF m.cancel_effective_date < (now() AT TIME ZONE ''Europe/London'')::date THEN%'
--       AND pg_get_functiondef('public.membership_mark_payment_failed(text)'::regprocedure)
--           LIKE '%IF m.cancel_effective_date < (now() AT TIME ZONE ''Europe/London'')::date THEN%';

CREATE OR REPLACE FUNCTION public.membership_mark_paid(p_stripe_subscription_id text, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE m customer_memberships%ROWTYPE; restored integer := 0; periods integer;
BEGIN
  SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  IF m.subscription_status = 'cancelled' THEN
    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled');
  END IF;
  -- 031: the membership's last day has passed (London's date). Cancel was pressed here and the row keeps its status
  -- until Stripe ends the subscription, so a payment Stripe takes after that day pays for time the member does not
  -- have. Nothing is written for it; the Worker lists the payment for a refund (W47r-c, W47r-d).
  IF m.cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date THEN
    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled', 'last_day', m.cancel_effective_date);
  END IF; -- 031
  UPDATE customer_memberships
  SET subscription_status = 'active',
      next_renewal_date = COALESCE((p_period_end AT TIME ZONE 'Europe/London')::date, next_renewal_date),
      updated_at = now()
  WHERE id = m.id;
  WITH r AS (
    UPDATE bookings SET status = 'confirmed', payment_due_by = NULL, updated_at = now()
    WHERE redeemed_membership_id = m.id AND redemption_source = 'membership_credit' AND status = 'payment_needed'
    RETURNING 1)
  SELECT count(*) INTO restored FROM r;
  SELECT public.allocate_membership_credit_periods() INTO periods;
  RETURN jsonb_build_object('found', true, 'action', 'reactivated', 'was', m.subscription_status,
                            'bookings_restored', restored, 'periods_created', periods);
END $function$;

CREATE OR REPLACE FUNCTION public.membership_mark_payment_failed(p_stripe_subscription_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE m customer_memberships%ROWTYPE; covered date; flagged integer;
BEGIN
  SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  IF m.subscription_status = 'cancelled' THEN
    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled');
  END IF;
  -- 031: the membership's last day has passed (London's date). It has ended here, whatever Stripe's subscription
  -- still does, so a payment that fails after that day does not mark it past due and flags no booking. Nothing is
  -- written for it; the Worker lists a subscription still live in Stripe for a person (W47r-e).
  IF m.cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date THEN
    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled', 'last_day', m.cancel_effective_date);
  END IF; -- 031
  UPDATE customer_memberships SET subscription_status = 'past_due', updated_at = now() WHERE id = m.id;
  SELECT COALESCE(max(period_end), (now() AT TIME ZONE 'Europe/London')::date - 1) INTO covered
  FROM membership_credit_periods WHERE membership_id = m.id;
  -- 030: a payment due today or earlier has not been made, so the period it was for is not covered, whatever credit
  -- period has already been allocated for it. Covered through the day before that payment was due.
  IF m.next_renewal_date <= (now() AT TIME ZONE 'Europe/London')::date THEN
    covered := m.next_renewal_date - 1;
  END IF;
  flagged := public.flag_uncovered_credit_bookings(m.id, covered);
  RETURN jsonb_build_object('found', true, 'action', 'past_due', 'covered_through', covered, 'bookings_flagged', flagged);
END $function$;

-- After applying: the saved test schema needs no refresh for the Worker's tests (they pass before and after: brief
-- W47r-d item 1 and brief W47r-e item 2; migration-031.test.ts, memberships/cancelled-here.test.ts and
-- memberships/cancel-wins.test.ts hold the migration either way). When the next Worker brief does refresh it
-- (web/server/rules/testing/README.md, "Refreshing the live schema"), it should show the lines added to these two
-- functions in live-schema.sql and live-catalog.json, and nothing else.
--
-- Rollback: the Down below. It puts back the functions under which a payment taken after the last day is recorded
-- and not listed, and a failed one marks the row past due. A payment already listed stays listed.
--
-- Down (the two functions as they were before 031):
--   CREATE OR REPLACE FUNCTION public.membership_mark_paid(p_stripe_subscription_id text, p_period_end timestamp with time zone)
--    RETURNS jsonb
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--   DECLARE m customer_memberships%ROWTYPE; restored integer := 0; periods integer;
--   BEGIN
--     SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
--     IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
--     IF m.subscription_status = 'cancelled' THEN
--       RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled');
--     END IF;
--     UPDATE customer_memberships
--     SET subscription_status = 'active',
--         next_renewal_date = COALESCE((p_period_end AT TIME ZONE 'Europe/London')::date, next_renewal_date),
--         updated_at = now()
--     WHERE id = m.id;
--     WITH r AS (
--       UPDATE bookings SET status = 'confirmed', payment_due_by = NULL, updated_at = now()
--       WHERE redeemed_membership_id = m.id AND redemption_source = 'membership_credit' AND status = 'payment_needed'
--       RETURNING 1)
--     SELECT count(*) INTO restored FROM r;
--     SELECT public.allocate_membership_credit_periods() INTO periods;
--     RETURN jsonb_build_object('found', true, 'action', 'reactivated', 'was', m.subscription_status,
--                               'bookings_restored', restored, 'periods_created', periods);
--   END $function$;
--
--   CREATE OR REPLACE FUNCTION public.membership_mark_payment_failed(p_stripe_subscription_id text)
--    RETURNS jsonb
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--   DECLARE m customer_memberships%ROWTYPE; covered date; flagged integer;
--   BEGIN
--     SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
--     IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
--     IF m.subscription_status = 'cancelled' THEN
--       RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled');
--     END IF;
--     UPDATE customer_memberships SET subscription_status = 'past_due', updated_at = now() WHERE id = m.id;
--     SELECT COALESCE(max(period_end), (now() AT TIME ZONE 'Europe/London')::date - 1) INTO covered
--     FROM membership_credit_periods WHERE membership_id = m.id;
--     -- 030: a payment due today or earlier has not been made, so the period it was for is not covered, whatever credit
--     -- period has already been allocated for it. Covered through the day before that payment was due.
--     IF m.next_renewal_date <= (now() AT TIME ZONE 'Europe/London')::date THEN
--       covered := m.next_renewal_date - 1;
--     END IF;
--     flagged := public.flag_uncovered_credit_bookings(m.id, covered);
--     RETURN jsonb_build_object('found', true, 'action', 'past_due', 'covered_through', covered, 'bookings_flagged', flagged);
--   END $function$;
