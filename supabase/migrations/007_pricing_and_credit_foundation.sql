-- ============================================================================
-- 007: Pricing bands, membership levels and credit periods (Phase 1)
-- ============================================================================
-- Additive and backwards compatible: nothing here removes or renames an existing
-- column, so the Retool app and Worker keep working unchanged after it is applied.
-- (Collapsing the three public service types into one is Phase 2, together with the
-- Retool pricing changes that need it.)
--
-- Session times are stored as wall-clock digits labelled UTC (19:15+00 means 7:15 pm
-- London time). Every band and day calculation below therefore uses AT TIME ZONE 'UTC'
-- and never converts to Europe/London.
--
-- Dependencies already in the database: update_updated_at_column(), btree_gist,
-- uuid_generate_v4(), staff, customer_memberships, bookings, booking_guests, sessions.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Session bands: Off-Peak / Core / Peak with their per-seat price
-- ----------------------------------------------------------------------------
CREATE TABLE session_bands (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+$'),
  name TEXT NOT NULL,
  price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_session_bands_updated_at
  BEFORE UPDATE ON session_bands
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO session_bands (code, name, price, sort_order) VALUES
  ('off_peak', 'Off-Peak', 15.00, 1),
  ('core',     'Core',     17.50, 2),
  ('peak',     'Peak',     20.00, 3);


-- ----------------------------------------------------------------------------
-- 2. Band rules: which day/time window belongs to which band
--    day_of_week: 0 = Sunday ... 6 = Saturday. Windows are [from_time, to_time);
--    to_time may be 24:00. Overlapping windows on the same day are rejected.
-- ----------------------------------------------------------------------------
CREATE TABLE band_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  band_id UUID NOT NULL REFERENCES session_bands(id) ON DELETE RESTRICT,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  from_time TIME NOT NULL,
  to_time TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT band_rules_valid_window CHECK (from_time < to_time),
  CONSTRAINT band_rules_no_overlap EXCLUDE USING gist (
    day_of_week WITH =,
    tsrange(DATE '2000-01-01' + from_time, DATE '2000-01-01' + to_time, '[)') WITH &&
  )
);

CREATE INDEX idx_band_rules_band ON band_rules(band_id);

CREATE TRIGGER update_band_rules_updated_at
  BEFORE UPDATE ON band_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Mon-Thu before 5pm = Off-Peak
INSERT INTO band_rules (band_id, day_of_week, from_time, to_time)
SELECT b.id, d, TIME '00:00', TIME '17:00'
FROM session_bands b, generate_series(1, 4) AS d WHERE b.code = 'off_peak';

-- Mon-Thu from 5pm = Core
INSERT INTO band_rules (band_id, day_of_week, from_time, to_time)
SELECT b.id, d, TIME '17:00', TIME '24:00'
FROM session_bands b, generate_series(1, 4) AS d WHERE b.code = 'core';

-- Friday daytime = Core
INSERT INTO band_rules (band_id, day_of_week, from_time, to_time)
SELECT b.id, 5, TIME '00:00', TIME '17:00' FROM session_bands b WHERE b.code = 'core';

-- Friday evening = Peak
INSERT INTO band_rules (band_id, day_of_week, from_time, to_time)
SELECT b.id, 5, TIME '17:00', TIME '24:00' FROM session_bands b WHERE b.code = 'peak';

-- Saturday and Sunday, all day = Peak
INSERT INTO band_rules (band_id, day_of_week, from_time, to_time)
SELECT b.id, d, TIME '00:00', TIME '24:00'
FROM session_bands b, unnest(ARRAY[6, 0]) AS d WHERE b.code = 'peak';


-- Band for a session start time (wall-clock digits labelled UTC). NULL if no rule matches.
CREATE FUNCTION band_for_session_start(p_start TIMESTAMPTZ)
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT r.band_id
  FROM band_rules r
  WHERE r.day_of_week = EXTRACT(DOW FROM (p_start AT TIME ZONE 'UTC'))::SMALLINT
    AND (p_start AT TIME ZONE 'UTC')::TIME >= r.from_time
    AND (p_start AT TIME ZONE 'UTC')::TIME <  r.to_time
  LIMIT 1
$$;


-- ----------------------------------------------------------------------------
-- 3. Membership terms per level and band: does a credit cover it, and what discount
--    applies when the member pays for it. Core members get 12.5% off Peak (own seat).
-- ----------------------------------------------------------------------------
CREATE TABLE membership_band_terms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  membership_level TEXT NOT NULL CHECK (membership_level IN ('core', 'all_access')),
  band_id UUID NOT NULL REFERENCES session_bands(id) ON DELETE CASCADE,
  credit_eligible BOOLEAN NOT NULL,
  discount_percent NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  updated_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (membership_level, band_id)
);

CREATE TRIGGER update_membership_band_terms_updated_at
  BEFORE UPDATE ON membership_band_terms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO membership_band_terms (membership_level, band_id, credit_eligible, discount_percent)
SELECT 'core', b.id, (b.code <> 'peak'), (CASE WHEN b.code = 'peak' THEN 12.5 ELSE 0 END)
FROM session_bands b;

INSERT INTO membership_band_terms (membership_level, band_id, credit_eligible, discount_percent)
SELECT 'all_access', b.id, true, 0
FROM session_bands b;


-- ----------------------------------------------------------------------------
-- 4. Who may change pricing (bands, windows, discounts, plan prices)
-- ----------------------------------------------------------------------------
ALTER TABLE staff ADD COLUMN can_manage_pricing BOOLEAN NOT NULL DEFAULT false;
UPDATE staff SET can_manage_pricing = true WHERE role = 'admin';


-- ----------------------------------------------------------------------------
-- 5. Sessions carry their band. Assigned by trigger so the weekly generator and
--    "edit start time" keep working with no code change. A staff override sets
--    band_overridden = true and the trigger then leaves the band alone.
-- ----------------------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN band_id UUID REFERENCES session_bands(id),
  ADD COLUMN band_overridden BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_sessions_band ON sessions(band_id);

CREATE FUNCTION sessions_assign_band()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type = 'public' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.band_id IS NULL THEN
        NEW.band_id := band_for_session_start(NEW.start_time);
      END IF;
    ELSIF NEW.start_time IS DISTINCT FROM OLD.start_time AND NOT NEW.band_overridden THEN
      NEW.band_id := band_for_session_start(NEW.start_time);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_assign_band
  BEFORE INSERT OR UPDATE OF start_time ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_assign_band();

UPDATE sessions
SET band_id = band_for_session_start(start_time)
WHERE type = 'public' AND band_id IS NULL;


-- ----------------------------------------------------------------------------
-- 6. Membership plans: level (Core / All-Access), explicit unlimited flag, and a
--    separate Stripe price for the yearly option. Plans created from Sanity start with
--    a NULL level; staff set it on the Membership Plans page.
-- ----------------------------------------------------------------------------
ALTER TABLE membership_plans
  ADD COLUMN level TEXT CHECK (level IN ('core', 'all_access')),
  ADD COLUMN is_unlimited BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN stripe_price_id_yearly TEXT UNIQUE;

-- The three existing plans become the Core plans (their monthly prices already match).
-- Yearly prices: Core 4 = 490, Core 8 = 850, Core Unlimited = 1100.
-- sessions_included is left as is for now; Phase 3 replaces the "10 = unlimited" stand-in.
UPDATE membership_plans SET level = 'core', price_yearly = 490.00
WHERE name = '4 Sessions (Monthly)' AND level IS NULL;

UPDATE membership_plans SET level = 'core', price_yearly = 850.00
WHERE name = '8 Sessions (Monthly)' AND level IS NULL;

UPDATE membership_plans SET level = 'core', price_yearly = 1100.00, is_unlimited = true
WHERE name = 'Unlimited Sessions (Monthly)' AND level IS NULL;


-- ----------------------------------------------------------------------------
-- 7. Credit periods. One row per membership per monthly period. Credits used are
--    derived from bookings (see the view), never stored as a counter, so they cannot
--    drift. Yearly memberships also get monthly periods.
-- ----------------------------------------------------------------------------
CREATE TABLE membership_credit_periods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  membership_id UUID NOT NULL REFERENCES customer_memberships(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,                      -- inclusive
  credits_allocated INTEGER NOT NULL DEFAULT 0 CHECK (credits_allocated >= 0),
  is_unlimited BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT membership_credit_periods_valid CHECK (period_end >= period_start),
  CONSTRAINT membership_credit_periods_unique_start UNIQUE (membership_id, period_start),
  CONSTRAINT membership_credit_periods_no_overlap EXCLUDE USING gist (
    membership_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  )
);

-- Period containing p_day for a membership anchored on p_anchor. Monthly steps are always
-- measured from the anchor, and a month with no such day clamps to its last day:
-- anchor 31 Jan -> 31 Jan, 28 Feb, 31 Mar, 30 Apr ...
CREATE FUNCTION membership_period_for(p_anchor DATE, p_day DATE)
RETURNS TABLE (period_start DATE, period_end DATE)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  n INTEGER;
BEGIN
  IF p_day < p_anchor THEN
    RETURN;
  END IF;
  n := (EXTRACT(YEAR FROM p_day)::INTEGER - EXTRACT(YEAR FROM p_anchor)::INTEGER) * 12
     + (EXTRACT(MONTH FROM p_day)::INTEGER - EXTRACT(MONTH FROM p_anchor)::INTEGER);
  WHILE (p_anchor + make_interval(months => n))::DATE > p_day LOOP
    n := n - 1;
  END LOOP;
  WHILE (p_anchor + make_interval(months => n + 1))::DATE <= p_day LOOP
    n := n + 1;
  END LOOP;
  period_start := (p_anchor + make_interval(months => n))::DATE;
  period_end   := (p_anchor + make_interval(months => n + 1))::DATE - 1;
  RETURN NEXT;
END;
$$;


-- ----------------------------------------------------------------------------
-- 8. Bookings and guests: the fields the pricing, credit and lapse rules need
-- ----------------------------------------------------------------------------
ALTER TABLE bookings
  ADD COLUMN band_id UUID REFERENCES session_bands(id),            -- band at time of booking
  ADD COLUMN credit_period_id UUID REFERENCES membership_credit_periods(id),
  ADD COLUMN payment_due_by TIMESTAMPTZ,                           -- 72-hour deadline when payment_needed
  ADD COLUMN cancel_reason TEXT;

-- Price of each seat after any member discount, and how that seat was settled.
-- NULL on seats created before this migration.
ALTER TABLE booking_guests
  ADD COLUMN unit_price NUMERIC(10, 2) CHECK (unit_price >= 0),
  ADD COLUMN pay_by TEXT CHECK (pay_by IN ('paid', 'membership_credit', 'session_pass_credit', 'gift_card'));

UPDATE bookings b
SET band_id = s.band_id
FROM sessions s
WHERE s.id = b.session_id AND b.band_id IS NULL;

-- New status: payment_needed (booking past a lapsed membership, waiting on payment).
ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending', 'confirmed', 'payment_needed', 'cancelled', 'completed', 'no-show'));

-- A payment_needed booking still holds its slot until it is released, so it stays in the
-- no-overlap rule.
ALTER TABLE bookings DROP CONSTRAINT bookings_no_cross_session_overlap;
ALTER TABLE bookings ADD CONSTRAINT bookings_no_cross_session_overlap EXCLUDE USING gist (
  tstzrange(start_time, end_time, '[)') WITH &&,
  session_id WITH <>
) WHERE (status IN ('pending', 'confirmed', 'payment_needed'));

CREATE INDEX idx_bookings_credit_period ON bookings(credit_period_id) WHERE credit_period_id IS NOT NULL;
CREATE INDEX idx_bookings_payment_due ON bookings(payment_due_by) WHERE status = 'payment_needed';
CREATE INDEX idx_bookings_customer_active ON bookings(customer_id)
  WHERE status IN ('pending', 'confirmed', 'payment_needed');


-- ----------------------------------------------------------------------------
-- 9. One active booking per customer per calendar day (private sessions included;
--    cancelling frees the day). A trigger instead of a unique index so existing
--    test bookings that already share a day are left alone; it only checks rows being
--    created or moved. The advisory lock stops two simultaneous bookings slipping through.
-- ----------------------------------------------------------------------------
CREATE FUNCTION enforce_one_booking_per_customer_day()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_day DATE;
BEGIN
  IF NEW.status NOT IN ('pending', 'confirmed', 'payment_needed') THEN
    RETURN NEW;
  END IF;

  SELECT (s.start_time AT TIME ZONE 'UTC')::DATE INTO v_day
  FROM sessions s WHERE s.id = NEW.session_id;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.customer_id::TEXT || v_day::TEXT, 0));

  IF EXISTS (
    SELECT 1
    FROM bookings b
    JOIN sessions s ON s.id = b.session_id
    WHERE b.customer_id = NEW.customer_id
      AND b.id <> NEW.id
      AND b.status IN ('pending', 'confirmed', 'payment_needed')
      AND (s.start_time AT TIME ZONE 'UTC')::DATE = v_day
  ) THEN
    RAISE EXCEPTION 'This customer already has a booking on %. Only one booking per customer per day is allowed.',
      to_char(v_day, 'DD Mon YYYY');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER bookings_one_per_customer_day
  BEFORE INSERT OR UPDATE OF status, session_id, customer_id ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_one_booking_per_customer_day();


-- ----------------------------------------------------------------------------
-- 10. Credit balance per period, derived from bookings. A booking uses one credit
--     (the member's own seat; guests are always paid). Cancelled and payment_needed
--     bookings do not use one. NULL credits_remaining means unlimited.
-- ----------------------------------------------------------------------------
CREATE VIEW membership_credit_period_balances
WITH (security_invoker = true) AS
SELECT
  p.id,
  p.membership_id,
  p.period_start,
  p.period_end,
  p.credits_allocated,
  p.is_unlimited,
  COUNT(b.id) AS credits_used,
  CASE WHEN p.is_unlimited THEN NULL ELSE p.credits_allocated - COUNT(b.id) END AS credits_remaining
FROM membership_credit_periods p
LEFT JOIN bookings b
  ON b.credit_period_id = p.id
 AND b.redemption_source = 'membership_credit'
 AND b.status IN ('pending', 'confirmed', 'completed', 'no-show')
GROUP BY p.id;


-- ----------------------------------------------------------------------------
-- 11. Row level security, following the existing convention: public catalog reads,
--     service role full access, customers read their own rows.
-- ----------------------------------------------------------------------------
ALTER TABLE session_bands ENABLE ROW LEVEL SECURITY;
ALTER TABLE band_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_band_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_credit_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access to session bands"
  ON session_bands FOR SELECT USING (active = true);
CREATE POLICY "Service role full access"
  ON session_bands FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Public read access to band rules"
  ON band_rules FOR SELECT USING (true);
CREATE POLICY "Service role full access"
  ON band_rules FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Public read access to membership band terms"
  ON membership_band_terms FOR SELECT USING (true);
CREATE POLICY "Service role full access"
  ON membership_band_terms FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Users can view own credit periods"
  ON membership_credit_periods FOR SELECT
  USING (membership_id IN (
    SELECT cm.id FROM customer_memberships cm
    WHERE cm.customer_id IN (SELECT c.id FROM customers c WHERE c.auth_user_id = auth.uid())
  ));
CREATE POLICY "Service role full access"
  ON membership_credit_periods FOR ALL TO service_role USING (true) WITH CHECK (true);
