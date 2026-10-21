-- 011: membership_sync_cancel_at_period_end now derives cancel_effective_date from Stripe's
-- `cancel_at` (an exact timestamp) when present, instead of always using current_period_end.
-- This is needed because the minimum-term cancellation rule (see web/lib/membership-cancellation.ts)
-- can push the real cancellation date later than the current billing period's end — so our own
-- staff-cancel route sets Stripe's `cancel_at` directly (not `cancel_at_period_end`), and this
-- function must honour that date rather than overwriting it with current_period_end - 1 day.
--
-- Falls back to the legacy cancel_at_period_end/current_period_end behaviour for a subscription
-- cancelled directly in the Stripe dashboard (which still just sets cancel_at_period_end), so
-- that path keeps working unchanged. Idempotent: does not write when the stored
-- cancel_effective_date already matches, so repeat/duplicate webhook deliveries are safe no-ops.
-- membership_mark_cancelled_by_stripe is untouched.
--
-- CREATE OR REPLACE with a different parameter list creates an additional overload rather than
-- replacing the function — drop the old 3-arg signature explicitly so only the fixed version remains.
DROP FUNCTION IF EXISTS public.membership_sync_cancel_at_period_end(text, boolean, timestamptz);

CREATE OR REPLACE FUNCTION public.membership_sync_cancel_at_period_end(
  p_stripe_subscription_id text,
  p_cancel_at_period_end boolean,
  p_cancel_at timestamptz,
  p_period_end timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m customer_memberships%ROWTYPE; new_date date;
BEGIN
  SELECT * INTO m FROM customer_memberships WHERE stripe_subscription_id = p_stripe_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  IF m.subscription_status = 'cancelled' THEN
    RETURN jsonb_build_object('found', true, 'action', 'ignored_cancelled');
  END IF;

  IF p_cancel_at IS NOT NULL THEN
    new_date := (p_cancel_at AT TIME ZONE 'Europe/London')::date - 1;
  ELSIF p_cancel_at_period_end THEN
    new_date := (p_period_end AT TIME ZONE 'Europe/London')::date - 1;
  ELSE
    new_date := NULL;
  END IF;

  IF m.cancel_effective_date IS NOT DISTINCT FROM new_date THEN
    RETURN jsonb_build_object('found', true, 'action', 'unchanged', 'cancel_effective_date', new_date);
  END IF;

  UPDATE customer_memberships SET cancel_effective_date = new_date, updated_at = now() WHERE id = m.id;
  RETURN jsonb_build_object(
    'found', true,
    'action', CASE WHEN new_date IS NULL THEN 'cancel_cleared' ELSE 'cancel_scheduled' END,
    'cancel_effective_date', new_date
  );
END $$;

REVOKE EXECUTE ON FUNCTION public.membership_sync_cancel_at_period_end(text, boolean, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.membership_sync_cancel_at_period_end(text, boolean, timestamptz, timestamptz) TO service_role;
