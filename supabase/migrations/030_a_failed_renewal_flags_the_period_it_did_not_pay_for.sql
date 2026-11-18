-- 030: a failed renewal flags the period it did not pay for (brief W46a item 1; W46 report "Noticed" 1 and 2).
-- NOT APPLIED by W46a. The lead applies it, after a diff check of this file against live.
--
-- Before: when a renewal payment fails, membership_mark_payment_failed(text) marks the membership past due and flags
-- its credit bookings after the day the member is "covered through" as payment needed. That day was the end of the
-- newest credit period the membership has. But the credit allocation (the daily job at 00:05, the hourly job, and
-- any member's recorded payment) gives every active member their new period at the start of its first day, before
-- Stripe has taken the payment for it. So by the time the payment failed, the newest period was the one that payment
-- was for, the member read as covered to the end of the month they had not paid for, and no booking was flagged.
-- membership_mark_cancelled_by_stripe(text) works out the same day the same way when Stripe ends a past-due
-- subscription, and wrote it as the membership's last day.
-- Example (W46's proof, briefs/W46-logs/33-proof-allocation-before-payment-figures.json): Mo pays GBP 40 a month and
-- renews on the 10th. He has a credit booking on 15 December. At 00:05 on 10 December he is given 10 December to
-- 9 January. At 14:00 his GBP 40 fails: covered_through 2027-01-09, bookings_flagged 0. He is past due and his
-- booking stays confirmed. If every retry fails and Stripe ends the subscription, his last day is written as
-- 9 January: a month of credit sessions for GBP 0 (two sessions at GBP 20 is GBP 40).
-- After: in both functions, when the membership's next_renewal_date is today or earlier (London), the member is
-- covered through the day before it: that payment has not been made, so the period it was for is not paid, whatever
-- credit period exists. Mo: covered_through 2026-12-09, bookings_flagged 1, and his last day, if Stripe ends the
-- subscription, 9 December. Otherwise (no next_renewal_date, or one after today) the day is worked out exactly as
-- before.
--
-- What changes, exactly: two functions, lines added to each and none changed or removed. Their signatures,
-- SECURITY DEFINER, search_path and what they return are as they were, and so are their grants (CREATE OR REPLACE
-- keeps them). No table, row or other function is touched. The lines, as a diff against live:
--   --- saved schema (live): membership_mark_payment_failed(text)
--   +++ migration 030: membership_mark_payment_failed(text)
--   @@ -14,6 +14,11 @@
--      UPDATE customer_memberships SET subscription_status = 'past_due', updated_at = now() WHERE id = m.id;
--      SELECT COALESCE(max(period_end), (now() AT TIME ZONE 'Europe/London')::date - 1) INTO covered
--      FROM membership_credit_periods WHERE membership_id = m.id;
--   +  -- 030: a payment due today or earlier has not been made, so the period it was for is not covered, whatever credit
--   +  -- period has already been allocated for it. Covered through the day before that payment was due.
--   +  IF m.next_renewal_date <= (now() AT TIME ZONE 'Europe/London')::date THEN
--   +    covered := m.next_renewal_date - 1;
--   +  END IF;
--      flagged := public.flag_uncovered_credit_bookings(m.id, covered);
--      RETURN jsonb_build_object('found', true, 'action', 'past_due', 'covered_through', covered, 'bookings_flagged', flagged);
--    END $function$
--   --- saved schema (live): membership_mark_cancelled_by_stripe(text)
--   +++ migration 030: membership_mark_cancelled_by_stripe(text)
--   @@ -13,6 +13,11 @@
--                          CASE WHEN m.subscription_status = 'past_due'
--                               THEN (SELECT COALESCE(max(period_end), today - 1) FROM membership_credit_periods WHERE membership_id = m.id)
--                               ELSE today END);
--   +  -- 030: past due with a payment due today or earlier: that payment was never made, so access ended the day before
--   +  -- it was due, whatever credit period had already been allocated for it.
--   +  IF m.cancel_effective_date IS NULL AND m.subscription_status = 'past_due' AND m.next_renewal_date <= today THEN
--   +    covered := m.next_renewal_date - 1;
--   +  END IF;
--      UPDATE customer_memberships
--      SET subscription_status = 'cancelled',
--          cancel_effective_date = COALESCE(cancel_effective_date, covered),
--
-- What it can and can't do:
--   - It never flags less than before. When the new lines apply, the day is before today, so every confirmed credit
--     booking of the membership that has not started yet is flagged; before, a subset of those was.
--   - It only acts inside these two functions, which the webhook calls when Stripe shows the subscription behind on
--     its payment (past_due, unpaid) or ended. A member who is paid up is never passed to them.
--   - A booking that staff or the customer has since paid for (Settle) is not flagged again by a later failed retry:
--     Settle takes the membership off the booking.
--   - membership_mark_paid(text, timestamptz) is unchanged: a retry that goes through puts every flagged booking back
--     to confirmed and moves next_renewal_date on, as before.
--   - Rows already written are not changed: a membership already past due keeps its bookings as they are until
--     Stripe's next failed retry (which then flags them), and one Stripe already ended keeps the last day it was given.
--
-- Order: either way round is safe, and 030 need not wait for the Worker. The Worker calls both functions with the
-- same argument and reads nothing of their answer but `found` and `action` (app/api/stripe/webhook/dispatch.ts);
-- covered_through and bookings_flagged are only recorded in stripe_webhook_events.detail. The Worker's tests pass
-- with the saved schema as live is today and with 030 in it.
--
-- Pre-checks (read-only). Expect 0 for each:
--    SELECT count(*) FROM public.customer_memberships WHERE subscription_status = 'past_due';
--    SELECT count(*) FROM public.customer_memberships
--    WHERE subscription_status = 'cancelled' AND cancel_effective_date > (now() AT TIME ZONE 'Europe/London')::date;
-- Not 0 on the first: 030 is still safe to apply. Each row is a member whose payment failed under the old sum, so
-- their credit bookings may not have been flagged: tell the builder, and look at each one's confirmed credit bookings.
-- Not 0 on the second: 030 is still safe to apply. Each row may be a membership Stripe ended for non-payment whose
-- last day was written as the end of the month it did not pay for: look at each against Stripe and tell the builder.
--
-- No data changes: no row is written or rewritten by the migration.
--
-- Check after applying (read-only): expect true.
--    SELECT pg_get_functiondef('public.membership_mark_payment_failed(text)'::regprocedure)
--           LIKE '%IF m.next_renewal_date <= (now() AT TIME ZONE ''Europe/London'')::date THEN%'
--       AND pg_get_functiondef('public.membership_mark_cancelled_by_stripe(text)'::regprocedure)
--           LIKE '%IF m.cancel_effective_date IS NULL AND m.subscription_status = ''past_due'' AND m.next_renewal_date <= today THEN%';

CREATE OR REPLACE FUNCTION public.membership_mark_cancelled_by_stripe(p_stripe_subscription_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE m customer_memberships%ROWTYPE; covered date; today date := (now() AT TIME ZONE 'Europe/London')::date; flagged integer;
BEGIN
  SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  -- Involuntary end (was past_due) or Stripe-side cancel: access ends today unless an end date was already set.
  covered := COALESCE(m.cancel_effective_date,
                      CASE WHEN m.subscription_status = 'past_due'
                           THEN (SELECT COALESCE(max(period_end), today - 1) FROM membership_credit_periods WHERE membership_id = m.id)
                           ELSE today END);
  -- 030: past due with a payment due today or earlier: that payment was never made, so access ended the day before
  -- it was due, whatever credit period had already been allocated for it.
  IF m.cancel_effective_date IS NULL AND m.subscription_status = 'past_due' AND m.next_renewal_date <= today THEN
    covered := m.next_renewal_date - 1;
  END IF;
  UPDATE customer_memberships
  SET subscription_status = 'cancelled',
      cancel_effective_date = COALESCE(cancel_effective_date, covered),
      updated_at = now()
  WHERE id = m.id;
  flagged := public.flag_uncovered_credit_bookings(m.id, covered);
  RETURN jsonb_build_object('found', true, 'action', 'cancelled', 'covered_through', covered, 'bookings_flagged', flagged);
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
-- W46a item 1; migration-030.test.ts and memberships/covered-through.test.ts hold the migration either way). When
-- the next Worker brief does refresh it (web/server/rules/testing/README.md, "Refreshing the live schema"), it should
-- show the lines added to these two functions in live-schema.sql and live-catalog.json, and nothing else.
--
-- Rollback: the Down below. It puts back the old sum, under which a failed renewal flags nothing once the credit
-- allocation has run that day.
--
-- Down (the two functions as they were before 030):
--   CREATE OR REPLACE FUNCTION public.membership_mark_cancelled_by_stripe(p_stripe_subscription_id text)
--    RETURNS jsonb
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--   DECLARE m customer_memberships%ROWTYPE; covered date; today date := (now() AT TIME ZONE 'Europe/London')::date; flagged integer;
--   BEGIN
--     SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
--     IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
--     -- Involuntary end (was past_due) or Stripe-side cancel: access ends today unless an end date was already set.
--     covered := COALESCE(m.cancel_effective_date,
--                         CASE WHEN m.subscription_status = 'past_due'
--                              THEN (SELECT COALESCE(max(period_end), today - 1) FROM membership_credit_periods WHERE membership_id = m.id)
--                              ELSE today END);
--     UPDATE customer_memberships
--     SET subscription_status = 'cancelled',
--         cancel_effective_date = COALESCE(cancel_effective_date, covered),
--         updated_at = now()
--     WHERE id = m.id;
--     flagged := public.flag_uncovered_credit_bookings(m.id, covered);
--     RETURN jsonb_build_object('found', true, 'action', 'cancelled', 'covered_through', covered, 'bookings_flagged', flagged);
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
--     flagged := public.flag_uncovered_credit_bookings(m.id, covered);
--     RETURN jsonb_build_object('found', true, 'action', 'past_due', 'covered_through', covered, 'bookings_flagged', flagged);
--   END $function$;
