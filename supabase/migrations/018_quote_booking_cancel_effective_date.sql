-- 018: quote_booking ignores a membership past its last day.
-- A membership that is still 'active' but whose cancel_effective_date has passed
-- no longer gives member seat prices or credit eligibility. Same rule as
-- event_member_level and customerHasActiveMembership (last day inclusive, London date).
-- Found in W05 (report "For later" 1). Applied live by the lead on 6 Nov 2026.

CREATE OR REPLACE FUNCTION public.quote_booking(p_session_id uuid, p_customer_id uuid, p_party_size integer)
 RETURNS TABLE(seat_no integer, seat_kind text, band_id uuid, list_price numeric, unit_price numeric, credit_eligible boolean, membership_level text, discount_percent numeric)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_band UUID;
  v_price NUMERIC;
  v_level TEXT;
  v_eligible BOOLEAN := false;
  v_discount NUMERIC := 0;
BEGIN
  IF p_party_size IS NULL OR p_party_size < 1 THEN
    RAISE EXCEPTION 'Party size must be at least 1';
  END IF;

  SELECT s.band_id INTO v_band
  FROM sessions s
  WHERE s.id = p_session_id AND s.type = 'public';

  IF v_band IS NULL THEN
    RAISE EXCEPTION 'Session % is not a public session with a band', p_session_id;
  END IF;

  SELECT b.price INTO v_price FROM session_bands b WHERE b.id = v_band;

  SELECT mp.level INTO v_level
  FROM customer_memberships cm
  JOIN membership_plans mp ON mp.id = cm.plan_id
  WHERE cm.customer_id = p_customer_id
    AND cm.subscription_status = 'active'
    AND (cm.cancel_effective_date IS NULL
         OR cm.cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date)
    AND mp.level IS NOT NULL
  ORDER BY cm.created_at DESC
  LIMIT 1;

  IF v_level IS NOT NULL THEN
    SELECT t.credit_eligible, t.discount_percent
      INTO v_eligible, v_discount
    FROM membership_band_terms t
    WHERE t.membership_level = v_level AND t.band_id = v_band;

    v_eligible := COALESCE(v_eligible, false);
    v_discount := COALESCE(v_discount, 0);
  END IF;

  RETURN QUERY
  SELECT
    g,
    CASE WHEN g = 1 THEN 'account_holder' ELSE 'guest' END,
    v_band,
    v_price,
    CASE WHEN g = 1 THEN ROUND(v_price * (1 - v_discount / 100), 2) ELSE v_price END,
    (g = 1 AND v_eligible),
    CASE WHEN g = 1 THEN v_level ELSE NULL END,
    CASE WHEN g = 1 THEN v_discount ELSE 0::NUMERIC END
  FROM generate_series(1, p_party_size) AS g;
END;
$function$;
