-- 009: membership credit periods engine, lapse flow and Stripe webhook event log.
-- ALREADY APPLIED to the Supabase project (paddock / mlncsohpjygolixqnrxo) via migrations
-- "allocate_membership_credit_periods", "membership_current_credits_view" and
-- "membership_lapse_flow_and_webhook_events". This file records them in the repo so schema
-- history matches. Safe to re-run (CREATE OR REPLACE / IF NOT EXISTS / guarded constraint swap).
-- The pg_cron job used during development is intentionally NOT recreated: the daily/hourly
-- schedule lives in the Retool Workflow "Allocate membership credits" (calls run_membership_maintenance()).

-- 1. Allocation of monthly credit periods (idempotent; London date; skips past_due/cancelled-expired)
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
           greatest(0,
             (extract(year from age(today, cm.start_date))::int * 12
              + extract(month from age(today, cm.start_date))::int)) as n
    from customer_memberships cm
    join membership_plans p on p.id = cm.plan_id
    where cm.start_date is not null
      and cm.start_date <= today
      and (
        cm.subscription_status = 'active'
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

-- 2. Current-period usage view (usage = non-cancelled credit bookings carrying credit_period_id)
CREATE OR REPLACE VIEW public.membership_current_credits AS
 SELECT p.membership_id,
    p.id AS period_id,
    p.period_start,
    p.period_end,
    p.is_unlimited,
    p.credits_allocated,
    COALESCE(u.used, 0::bigint)::integer AS credits_used,
        CASE
            WHEN p.is_unlimited THEN NULL::bigint
            ELSE GREATEST(p.credits_allocated - COALESCE(u.used, 0::bigint), 0::bigint)
        END::integer AS credits_remaining
   FROM membership_credit_periods p
     LEFT JOIN LATERAL ( SELECT count(*) AS used
           FROM bookings b
          WHERE b.credit_period_id = p.id AND b.redemption_source = 'membership_credit'::text AND b.status <> 'cancelled'::text) u ON true
  WHERE (now() AT TIME ZONE 'Europe/London'::text)::date >= p.period_start AND (now() AT TIME ZONE 'Europe/London'::text)::date <= p.period_end;

-- 3. New membership status: past_due (renewal payment failed; no new credits, bookings blocked)
ALTER TABLE customer_memberships DROP CONSTRAINT IF EXISTS customer_memberships_subscription_status_check;
ALTER TABLE customer_memberships ADD CONSTRAINT customer_memberships_subscription_status_check
  CHECK (subscription_status IN ('active', 'paused', 'cancelled', 'past_due'));

-- 4. Stripe webhook event log: idempotency + audit (RLS on, no policies = service role only)
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  outcome      TEXT,            -- processed / ignored / error
  detail       JSONB,
  error        TEXT
);
ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- 5. Flag credit bookings no longer covered by the membership as payment_needed (72h window).
CREATE OR REPLACE FUNCTION public.flag_uncovered_credit_bookings(p_membership_id uuid, p_covered_through date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  WITH upd AS (
    UPDATE bookings b
    SET status = 'payment_needed',
        payment_due_by = LEAST(
          now() + interval '72 hours',
          ((b.start_time AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')),
        updated_at = now()
    WHERE b.redeemed_membership_id = p_membership_id
      AND b.redemption_source = 'membership_credit'
      AND b.status = 'confirmed'
      AND (b.start_time AT TIME ZONE 'UTC')::date > p_covered_through
      AND (b.start_time AT TIME ZONE 'UTC') > (now() AT TIME ZONE 'Europe/London')
    RETURNING 1)
  SELECT count(*) INTO n FROM upd;
  RETURN n;
END $$;

-- 6. invoice.paid on a renewal: reactivate, restore held bookings, allocate the new period
CREATE OR REPLACE FUNCTION public.membership_mark_paid(p_stripe_subscription_id text, p_period_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m customer_memberships%ROWTYPE; restored integer := 0; periods integer;
BEGIN
  SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  IF m.subscription_status = 'cancelled' THEN
    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled');
  END IF;
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
END $$;

-- 7. invoice.payment_failed on a renewal: past_due, hold uncovered credit bookings for 72h
CREATE OR REPLACE FUNCTION public.membership_mark_payment_failed(p_stripe_subscription_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  flagged := public.flag_uncovered_credit_bookings(m.id, covered);
  RETURN jsonb_build_object('found', true, 'action', 'past_due', 'covered_through', covered, 'bookings_flagged', flagged);
END $$;

-- 8. customer.subscription.deleted: cancelled; credit bookings beyond the paid-through date held for 72h
CREATE OR REPLACE FUNCTION public.membership_mark_cancelled_by_stripe(p_stripe_subscription_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m customer_memberships%ROWTYPE; covered date; today date := (now() AT TIME ZONE 'Europe/London')::date; flagged integer;
BEGIN
  SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  covered := COALESCE(m.cancel_effective_date,
                      CASE WHEN m.subscription_status = 'past_due'
                           THEN (SELECT COALESCE(max(period_end), today - 1) FROM membership_credit_periods WHERE membership_id = m.id)
                           ELSE today END);
  UPDATE customer_memberships
  SET subscription_status = 'cancelled',
      cancel_effective_date = COALESCE(cancel_effective_date, covered),
      updated_at = now()
  WHERE id = m.id;
  flagged := public.flag_uncovered_credit_bookings(m.id, covered);
  RETURN jsonb_build_object('found', true, 'action', 'cancelled', 'covered_through', covered, 'bookings_flagged', flagged);
END $$;

-- 9. customer.subscription.updated: mirror an end-of-period cancellation request (or its reversal)
CREATE OR REPLACE FUNCTION public.membership_sync_cancel_at_period_end(p_stripe_subscription_id text, p_cancel_at_period_end boolean, p_period_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m customer_memberships%ROWTYPE;
BEGIN
  SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  IF m.subscription_status = 'cancelled' THEN
    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled');
  END IF;
  IF p_cancel_at_period_end THEN
    UPDATE customer_memberships
    SET cancel_effective_date = ((p_period_end AT TIME ZONE 'Europe/London')::date - 1), updated_at = now()
    WHERE id = m.id;
    RETURN jsonb_build_object('found', true, 'action', 'cancel_scheduled');
  ELSE
    UPDATE customer_memberships SET cancel_effective_date = NULL, updated_at = now()
    WHERE id = m.id AND subscription_status IN ('active', 'past_due') AND cancel_effective_date IS NOT NULL;
    RETURN jsonb_build_object('found', true, 'action', 'cancel_cleared');
  END IF;
END $$;

-- 10. Hourly sweep: cancel payment_needed bookings whose 72h window has passed. Bookings where real
-- money was already taken (e.g. paid guests) are NOT touched: they stay overdue for staff to resolve.
CREATE OR REPLACE FUNCTION public.lapse_sweep_expired_bookings()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0; r record;
BEGIN
  FOR r IN
    SELECT b.id, b.session_id, b.party_size
    FROM bookings b
    WHERE b.status = 'payment_needed' AND b.payment_due_by <= now() AND COALESCE(b.price_paid, 0) = 0
    FOR UPDATE OF b
  LOOP
    UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'membership_lapsed', updated_at = now()
    WHERE id = r.id;
    UPDATE sessions SET total_booked = GREATEST(total_booked - r.party_size, 0), updated_at = now()
    WHERE id = r.session_id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- 11. Single entry point for the scheduled job (Retool Workflow): allocation + lapse sweep
CREATE OR REPLACE FUNCTION public.run_membership_maintenance()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p integer; s integer;
BEGIN
  p := public.allocate_membership_credit_periods();
  s := public.lapse_sweep_expired_bookings();
  RETURN jsonb_build_object('periods_created', p, 'lapsed_bookings_cancelled', s);
END $$;

-- 12. Lock the functions to the service role (they are SECURITY DEFINER; never callable by anon/authenticated)
REVOKE EXECUTE ON FUNCTION public.flag_uncovered_credit_bookings(uuid,date), public.membership_mark_paid(text,timestamptz), public.membership_mark_payment_failed(text), public.membership_mark_cancelled_by_stripe(text), public.membership_sync_cancel_at_period_end(text,boolean,timestamptz), public.lapse_sweep_expired_bookings(), public.run_membership_maintenance(), public.allocate_membership_credit_periods() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_uncovered_credit_bookings(uuid,date), public.membership_mark_paid(text,timestamptz), public.membership_mark_payment_failed(text), public.membership_mark_cancelled_by_stripe(text), public.membership_sync_cancel_at_period_end(text,boolean,timestamptz), public.lapse_sweep_expired_bookings(), public.run_membership_maintenance(), public.allocate_membership_credit_periods() TO service_role;
