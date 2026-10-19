-- ============================================================================
-- 008: One public session type, seat pricing function, band re-assignment (Phase 2)
-- ============================================================================
-- Public session price now comes from the session's band (migration 007), so the
-- three price-named public types (Early Bird / Off-Peak / Peak) collapse into one.
-- The "Contrast Therapy - Off-Peak" row is kept because it already carries the Sanity
-- document and Stripe product; the other two are made inactive (never deleted, per the
-- catalog rule that the only removal is flipping Active to false).
--
-- After applying: rename the kept type in Sanity Studio to "Contrast Therapy". Its name
-- is mirrored from Sanity, so renaming it here would be overwritten on the next publish.
-- service_types.price on the kept row is no longer used for public sessions.
--
-- Sessions were cleared before this migration, so no sessions are repointed, but the
-- repoint below is included so the migration is safe to run on a database that has some.
-- ============================================================================

-- 1. Collapse the public types ------------------------------------------------
DO $merge$
DECLARE
  v_keep UUID;
  v_old  UUID[];
BEGIN
  SELECT id INTO v_keep
  FROM service_types
  WHERE booking_type = 'public' AND name = 'Contrast Therapy - Off-Peak';

  IF v_keep IS NULL THEN
    RAISE EXCEPTION 'Public service type "Contrast Therapy - Off-Peak" not found';
  END IF;

  SELECT array_agg(id) INTO v_old
  FROM service_types
  WHERE booking_type = 'public' AND id <> v_keep;

  IF v_old IS NOT NULL THEN
    -- Weekly slots move across. Public slots never share a day and time, so the
    -- (service_type_id, day_of_week, start_time) unique rule cannot be hit.
    UPDATE service_type_schedule_slots SET service_type_id = v_keep WHERE service_type_id = ANY(v_old);
    UPDATE sessions SET service_type_id = v_keep WHERE service_type_id = ANY(v_old);
    UPDATE service_types SET active = false WHERE id = ANY(v_old);
  END IF;
END
$merge$;


-- 2. Seat pricing -------------------------------------------------------------
-- One row per seat for a public booking. Seat 1 is the account holder; every other
-- seat is a guest and always pays the full band price (guests never use credits and
-- never get the member discount). The member discount and credit eligibility come from
-- membership_band_terms for the customer's active membership level. Whether the member
-- actually has a credit left is decided by the credit engine, not here.
CREATE FUNCTION quote_booking(p_session_id UUID, p_customer_id UUID, p_party_size INTEGER)
RETURNS TABLE (
  seat_no INTEGER,
  seat_kind TEXT,
  band_id UUID,
  list_price NUMERIC,
  unit_price NUMERIC,
  credit_eligible BOOLEAN,
  membership_level TEXT,
  discount_percent NUMERIC
)
LANGUAGE plpgsql
STABLE
AS $$
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
$$;


-- 3. Re-band after the band windows change ------------------------------------
-- Recomputes the band of future public sessions that staff have not manually overridden.
-- Existing bookings are not touched: they keep the band and price they were booked at.
CREATE FUNCTION reassign_session_bands(p_from TIMESTAMPTZ DEFAULT NOW())
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
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
$$;
