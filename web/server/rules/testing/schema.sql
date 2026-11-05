-- Test schema for server/rules: the tables, view and functions the rules read, copied from the
-- live database's catalog (4 Nov 2026). No data. Foreign keys and triggers are left out: fixtures
-- set band_id and the rest directly. Column types, defaults, NOT NULL, CHECK and UNIQUE are as live.
-- If a rule starts reading another table, add it here.

CREATE TABLE public.band_rules (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  band_id uuid NOT NULL,
  day_of_week smallint NOT NULL,
  from_time time without time zone NOT NULL,
  to_time time without time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT band_rules_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6))),
  CONSTRAINT band_rules_valid_window CHECK ((from_time < to_time)),
  CONSTRAINT band_rules_pkey PRIMARY KEY (id)
);

CREATE TABLE public.bookings (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  session_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  party_size integer DEFAULT 1 NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  price_paid numeric(10,2) NOT NULL,
  stripe_payment_id text,
  redemption_source text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  cancelled_at timestamp with time zone,
  checked_in_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  start_time timestamp with time zone,
  end_time timestamp with time zone,
  redeemed_membership_id uuid,
  redeemed_session_pass_id uuid,
  band_id uuid,
  credit_period_id uuid,
  payment_due_by timestamp with time zone,
  cancel_reason text,
  special_requests text,
  guests_over_18_confirmed_at timestamp with time zone,
  CONSTRAINT bookings_redemption_source_check CHECK ((redemption_source = ANY (ARRAY['paid'::text, 'membership_credit'::text, 'session_pass_credit'::text]))),
  CONSTRAINT bookings_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'payment_needed'::text, 'cancelled'::text, 'completed'::text, 'no-show'::text]))),
  CONSTRAINT bookings_pkey PRIMARY KEY (id)
);

CREATE TABLE public.customer_memberships (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  customer_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  stripe_subscription_id text,
  subscription_status text,
  start_date date NOT NULL,
  next_renewal_date date,
  addon_credits_remaining integer DEFAULT 0 NOT NULL,
  bonus_addon_credits integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  order_line_item_id uuid,
  billing_frequency text,
  cancel_effective_date date,
  is_herd boolean DEFAULT false NOT NULL,
  herd_override boolean,
  CONSTRAINT customer_memberships_subscription_status_check CHECK ((subscription_status = ANY (ARRAY['active'::text, 'paused'::text, 'cancelled'::text, 'past_due'::text]))),
  CONSTRAINT customer_memberships_pkey PRIMARY KEY (id),
  CONSTRAINT customer_memberships_stripe_subscription_id_key UNIQUE (stripe_subscription_id)
);

CREATE TABLE public.customer_session_passes (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  customer_id uuid NOT NULL,
  pass_type_id uuid NOT NULL,
  purchase_date date DEFAULT CURRENT_DATE NOT NULL,
  sessions_remaining integer NOT NULL,
  expiry_date date NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  order_line_item_id uuid,
  CONSTRAINT customer_session_passes_pkey PRIMARY KEY (id)
);

CREATE TABLE public.customers (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  auth_user_id uuid,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  phone text,
  stripe_customer_id text,
  saved_payment_method_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  marketing_consent boolean DEFAULT false,
  birthday_marketing_consent boolean DEFAULT false,
  address_line1 text,
  address_line2 text,
  city text,
  postcode text,
  country text DEFAULT 'GB'::text,
  waiver_accepted boolean DEFAULT false,
  waiver_version text,
  waiver_accepted_at timestamp with time zone,
  date_of_birth date NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  saved_card_last4 text,
  saved_card_brand text,
  store_credit_balance numeric(10,2) DEFAULT 0 NOT NULL,
  CONSTRAINT customers_store_credit_balance_nonneg CHECK ((store_credit_balance >= (0)::numeric)),
  CONSTRAINT customers_pkey PRIMARY KEY (id),
  CONSTRAINT customers_email_key UNIQUE (email),
  CONSTRAINT customers_stripe_customer_id_key UNIQUE (stripe_customer_id)
);

CREATE TABLE public.events (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  sanity_event_id text,
  name text NOT NULL,
  thumbnail_url text,
  has_extra_waiver boolean DEFAULT false NOT NULL,
  extra_waiver_version text,
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  capacity integer,
  places_booked integer DEFAULT 0 NOT NULL,
  access text DEFAULT 'public'::text NOT NULL,
  public_release_at timestamp with time zone,
  price_public numeric(10,2),
  price_pre_herd numeric(10,2),
  price_herd numeric(10,2),
  refund_cutoff_at timestamp with time zone,
  active boolean DEFAULT false NOT NULL,
  cancelled_at timestamp with time zone,
  cancelled_by uuid,
  cancel_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT events_access_check CHECK ((access = ANY (ARRAY['public'::text, 'members_only'::text, 'members_first'::text]))),
  CONSTRAINT events_capacity_check CHECK (((capacity IS NULL) OR (capacity > 0))),
  CONSTRAINT events_cutoff_before_start CHECK (((refund_cutoff_at IS NULL) OR (starts_at IS NULL) OR (refund_cutoff_at <= starts_at))),
  CONSTRAINT events_ends_after_start CHECK (((ends_at IS NULL) OR (starts_at IS NULL) OR (ends_at > starts_at))),
  CONSTRAINT events_on_sale_complete CHECK (((NOT active) OR ((starts_at IS NOT NULL) AND (capacity IS NOT NULL) AND (refund_cutoff_at IS NOT NULL) AND (price_public IS NOT NULL) AND (price_pre_herd IS NOT NULL) AND (price_herd IS NOT NULL) AND ((access <> 'members_first'::text) OR (public_release_at IS NOT NULL)) AND (cancelled_at IS NULL)))),
  CONSTRAINT events_places_booked_check CHECK ((places_booked >= 0)),
  CONSTRAINT events_places_within_capacity CHECK (((capacity IS NULL) OR (places_booked <= capacity))),
  CONSTRAINT events_price_herd_check CHECK (((price_herd IS NULL) OR (price_herd >= (0)::numeric))),
  CONSTRAINT events_price_pre_herd_check CHECK (((price_pre_herd IS NULL) OR (price_pre_herd >= (0)::numeric))),
  CONSTRAINT events_price_public_check CHECK (((price_public IS NULL) OR (price_public >= (0)::numeric))),
  CONSTRAINT events_release_before_start CHECK (((public_release_at IS NULL) OR (starts_at IS NULL) OR (public_release_at < starts_at))),
  CONSTRAINT events_pkey PRIMARY KEY (id),
  CONSTRAINT events_sanity_event_id_key UNIQUE (sanity_event_id)
);

CREATE TABLE public.membership_band_terms (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  membership_level text NOT NULL,
  band_id uuid NOT NULL,
  credit_eligible boolean NOT NULL,
  discount_percent numeric(5,2) DEFAULT 0 NOT NULL,
  updated_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT membership_band_terms_discount_percent_check CHECK (((discount_percent >= (0)::numeric) AND (discount_percent <= (100)::numeric))),
  CONSTRAINT membership_band_terms_membership_level_check CHECK ((membership_level = ANY (ARRAY['core'::text, 'all_access'::text]))),
  CONSTRAINT membership_band_terms_pkey PRIMARY KEY (id),
  CONSTRAINT membership_band_terms_membership_level_band_id_key UNIQUE (membership_level, band_id)
);

CREATE TABLE public.membership_credit_periods (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  membership_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  credits_allocated integer DEFAULT 0 NOT NULL,
  is_unlimited boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT membership_credit_periods_credits_allocated_check CHECK ((credits_allocated >= 0)),
  CONSTRAINT membership_credit_periods_valid CHECK ((period_end >= period_start)),
  CONSTRAINT membership_credit_periods_pkey PRIMARY KEY (id),
  CONSTRAINT membership_credit_periods_unique_start UNIQUE (membership_id, period_start)
);

CREATE TABLE public.membership_plans (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  sanity_plan_id text,
  name text NOT NULL,
  thumbnail_url text,
  sessions_included integer DEFAULT 0,
  addons_included integer DEFAULT 0,
  stripe_product_id text,
  stripe_price_id text,
  active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  price_monthly numeric,
  price_yearly numeric,
  level text,
  is_unlimited boolean DEFAULT false NOT NULL,
  stripe_price_id_yearly text,
  CONSTRAINT membership_plans_level_check CHECK ((level = ANY (ARRAY['core'::text, 'all_access'::text]))),
  CONSTRAINT membership_plans_pkey PRIMARY KEY (id),
  CONSTRAINT membership_plans_sanity_plan_id_key UNIQUE (sanity_plan_id),
  CONSTRAINT membership_plans_stripe_price_id_key UNIQUE (stripe_price_id),
  CONSTRAINT membership_plans_stripe_price_id_yearly_key UNIQUE (stripe_price_id_yearly),
  CONSTRAINT membership_plans_stripe_product_id_key UNIQUE (stripe_product_id)
);

CREATE TABLE public.postage_settings (
  id boolean DEFAULT true NOT NULL,
  standard_price numeric(10,2) DEFAULT 4.95 NOT NULL,
  express_price numeric(10,2) DEFAULT 9.95 NOT NULL,
  free_shipping_threshold numeric(10,2) DEFAULT 75.00 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT postage_settings_id_check CHECK (id),
  CONSTRAINT postage_settings_pkey PRIMARY KEY (id)
);

CREATE TABLE public.promo_code_redemptions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  promo_code_id uuid NOT NULL,
  order_id uuid NOT NULL,
  customer_id uuid,
  discount_amount numeric NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT promo_code_redemptions_discount_amount_check CHECK ((discount_amount >= (0)::numeric)),
  CONSTRAINT promo_code_redemptions_pkey PRIMARY KEY (id),
  CONSTRAINT promo_code_redemptions_promo_code_id_order_id_key UNIQUE (promo_code_id, order_id)
);

CREATE TABLE public.promo_codes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  code text NOT NULL,
  description text,
  discount_type text NOT NULL,
  discount_value numeric NOT NULL,
  applies_to text[] DEFAULT ARRAY['booking'::text, 'addon'::text, 'product'::text, 'session_pass'::text, 'membership'::text] NOT NULL,
  applies_on_member_prices boolean DEFAULT false NOT NULL,
  expires_on date,
  max_total_uses integer,
  one_use_per_customer boolean DEFAULT false NOT NULL,
  min_spend numeric,
  restricted_customer_id uuid,
  active boolean DEFAULT true NOT NULL,
  created_by text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT promo_codes_applies_to_valid CHECK (((applies_to <@ ARRAY['booking'::text, 'addon'::text, 'product'::text, 'session_pass'::text, 'membership'::text, 'event'::text]) AND (cardinality(applies_to) > 0))),
  CONSTRAINT promo_codes_discount_type_check CHECK ((discount_type = ANY (ARRAY['percentage'::text, 'fixed'::text]))),
  CONSTRAINT promo_codes_discount_value_check CHECK ((discount_value > (0)::numeric)),
  CONSTRAINT promo_codes_max_total_uses_check CHECK (((max_total_uses IS NULL) OR (max_total_uses > 0))),
  CONSTRAINT promo_codes_min_spend_check CHECK (((min_spend IS NULL) OR (min_spend >= (0)::numeric))),
  CONSTRAINT promo_codes_percentage_max CHECK (((discount_type <> 'percentage'::text) OR (discount_value <= (100)::numeric))),
  CONSTRAINT promo_codes_pkey PRIMARY KEY (id)
);

CREATE TABLE public.service_types (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  sanity_service_type_id text,
  name text NOT NULL,
  thumbnail_url text,
  duration integer,
  capacity integer DEFAULT 6,
  booking_type text,
  price numeric(10,2),
  active boolean DEFAULT true,
  stripe_product_id text,
  stripe_price_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT service_types_booking_type_check CHECK ((booking_type = ANY (ARRAY['public'::text, 'private'::text]))),
  CONSTRAINT service_types_pkey PRIMARY KEY (id),
  CONSTRAINT service_types_sanity_service_type_id_key UNIQUE (sanity_service_type_id),
  CONSTRAINT service_types_stripe_product_id_key UNIQUE (stripe_product_id)
);

CREATE TABLE public.session_bands (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  price numeric(10,2) NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT session_bands_code_check CHECK ((code ~ '^[a-z_]+$'::text)),
  CONSTRAINT session_bands_price_check CHECK ((price >= (0)::numeric)),
  CONSTRAINT session_bands_pkey PRIMARY KEY (id),
  CONSTRAINT session_bands_code_key UNIQUE (code)
);

CREATE TABLE public.session_pass_types (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  sanity_pass_type_id text,
  name text NOT NULL,
  thumbnail_url text,
  price numeric(10,2),
  sessions_included integer,
  expiry_months integer DEFAULT 12 NOT NULL,
  stripe_product_id text,
  stripe_price_id text,
  active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  level text DEFAULT 'all_access'::text NOT NULL,
  CONSTRAINT session_pass_types_level_check CHECK ((level = ANY (ARRAY['core'::text, 'all_access'::text]))),
  CONSTRAINT session_pass_types_pkey PRIMARY KEY (id),
  CONSTRAINT session_pass_types_sanity_pass_type_id_key UNIQUE (sanity_pass_type_id),
  CONSTRAINT session_pass_types_stripe_price_id_key UNIQUE (stripe_price_id),
  CONSTRAINT session_pass_types_stripe_product_id_key UNIQUE (stripe_product_id)
);

CREATE TABLE public.sessions (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  resource_id uuid,
  service_type_id uuid NOT NULL,
  start_time timestamp with time zone NOT NULL,
  end_time timestamp with time zone NOT NULL,
  type text,
  capacity integer DEFAULT 6 NOT NULL,
  total_booked integer DEFAULT 0 NOT NULL,
  status text DEFAULT 'open'::text NOT NULL,
  blocked_reason text,
  blocked_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  band_id uuid,
  band_overridden boolean DEFAULT false NOT NULL,
  CONSTRAINT sessions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'blocked'::text]))),
  CONSTRAINT sessions_type_check CHECK ((type = ANY (ARRAY['public'::text, 'private'::text]))),
  CONSTRAINT sessions_pkey PRIMARY KEY (id),
  CONSTRAINT sessions_service_type_start_time_key UNIQUE (service_type_id, start_time)
);

CREATE TABLE public.staff (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  role text NOT NULL,
  can_issue_refunds boolean DEFAULT false,
  active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  can_manage_pricing boolean DEFAULT false NOT NULL,
  CONSTRAINT staff_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'manager'::text, 'staff'::text]))),
  CONSTRAINT staff_pkey PRIMARY KEY (id),
  CONSTRAINT staff_email_key UNIQUE (email)
);

CREATE UNIQUE INDEX customers_auth_user_id_key ON public.customers USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);

CREATE UNIQUE INDEX promo_codes_code_upper_key ON public.promo_codes USING btree (upper(code));

CREATE VIEW public.membership_current_credits AS
 SELECT p.membership_id,
    p.id AS period_id,
    p.period_start,
    p.period_end,
    p.is_unlimited,
    p.credits_allocated,
    (COALESCE(u.used, (0)::bigint))::integer AS credits_used,
    (
        CASE
            WHEN p.is_unlimited THEN NULL::bigint
            ELSE GREATEST((p.credits_allocated - COALESCE(u.used, (0)::bigint)), (0)::bigint)
        END)::integer AS credits_remaining
   FROM (membership_credit_periods p
     LEFT JOIN LATERAL ( SELECT count(*) AS used
           FROM bookings b
          WHERE ((b.credit_period_id = p.id) AND (b.redemption_source = 'membership_credit'::text) AND (b.status <> 'cancelled'::text))) u ON (true))
  WHERE ((((now() AT TIME ZONE 'Europe/London'::text))::date >= p.period_start) AND (((now() AT TIME ZONE 'Europe/London'::text))::date <= p.period_end));

CREATE OR REPLACE FUNCTION public.event_member_level(p_customer_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE WHEN bool_or(cm.is_herd) THEN 'herd' WHEN count(*) > 0 THEN 'pre_herd' ELSE NULL END
  FROM public.customer_memberships cm
  WHERE cm.customer_id = p_customer_id
    AND cm.subscription_status = 'active'
    AND (cm.cancel_effective_date IS NULL OR cm.cancel_effective_date >= (now() AT TIME ZONE 'Europe/London')::date);
$function$;

CREATE OR REPLACE FUNCTION public.event_member_level_with_new(p_customer_id uuid, p_new_membership_frequency text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE
    WHEN public.event_member_level(p_customer_id) = 'herd' OR p_new_membership_frequency = 'yearly' THEN 'herd'
    WHEN public.event_member_level(p_customer_id) = 'pre_herd' OR p_new_membership_frequency = 'monthly' THEN 'pre_herd'
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.event_booking_block_reason(p_event_id uuid, p_customer_id uuid, p_new_membership_frequency text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  e public.events%ROWTYPE;
  v_now timestamp := now() AT TIME ZONE 'Europe/London';
  v_member boolean := public.event_member_level_with_new(p_customer_id, p_new_membership_frequency) IS NOT NULL;
BEGIN
  SELECT * INTO e FROM public.events WHERE id = p_event_id;
  IF NOT FOUND THEN RETURN 'event_not_found'; END IF;
  IF e.cancelled_at IS NOT NULL THEN RETURN 'event_cancelled'; END IF;
  IF NOT e.active THEN RETURN 'event_not_on_sale'; END IF;
  IF (e.starts_at AT TIME ZONE 'UTC') <= v_now THEN RETURN 'event_started'; END IF;
  IF e.access = 'members_only' AND NOT v_member THEN RETURN 'event_members_only'; END IF;
  IF e.access = 'members_first' AND NOT v_member AND (e.public_release_at AT TIME ZONE 'UTC') > v_now THEN
    RETURN 'event_not_released_yet';
  END IF;
  RETURN NULL;
END; $function$;

CREATE OR REPLACE FUNCTION public.pass_covers_session(p_pass_type_id uuid, p_session_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT COALESCE((
    SELECT CASE
      WHEN s.type <> 'public' OR s.band_id IS NULL THEN false
      WHEN spt.level = 'all_access' THEN true
      ELSE COALESCE((
        SELECT t.credit_eligible FROM public.membership_band_terms t
        WHERE t.membership_level = spt.level AND t.band_id = s.band_id
      ), false)
    END
    FROM public.session_pass_types spt
    CROSS JOIN public.sessions s
    WHERE spt.id = p_pass_type_id AND s.id = p_session_id
  ), false);
$function$;

CREATE OR REPLACE FUNCTION public.plan_seat_terms(p_plan_id uuid, p_session_id uuid)
 RETURNS TABLE(credit_eligible boolean, discount_percent numeric, list_price numeric, unit_price numeric)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT COALESCE(t.credit_eligible, false),
         COALESCE(t.discount_percent, 0),
         b.price,
         ROUND(b.price * (1 - COALESCE(t.discount_percent, 0) / 100), 2)
  FROM public.sessions s
  JOIN public.session_bands b ON b.id = s.band_id
  JOIN public.membership_plans mp ON mp.id = p_plan_id
  LEFT JOIN public.membership_band_terms t ON t.membership_level = mp.level AND t.band_id = s.band_id
  WHERE s.id = p_session_id AND s.type = 'public';
$function$;

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

CREATE OR REPLACE FUNCTION public.quote_event(p_event_id uuid, p_customer_id uuid, p_places integer, p_account_holder_attending boolean, p_new_membership_frequency text DEFAULT NULL::text)
 RETURNS TABLE(place_no integer, attendee_type text, price_level text, unit_price numeric)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  e public.events%ROWTYPE;
  v_level text := public.event_member_level_with_new(p_customer_id, p_new_membership_frequency);
BEGIN
  IF p_places IS NULL OR p_places < 1 THEN RAISE EXCEPTION 'Places must be at least 1'; END IF;
  IF p_new_membership_frequency IS NOT NULL AND p_new_membership_frequency NOT IN ('monthly', 'yearly') THEN
    RAISE EXCEPTION 'Membership frequency must be monthly or yearly';
  END IF;
  SELECT * INTO e FROM public.events WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event % not found', p_event_id; END IF;
  IF e.price_public IS NULL OR e.price_pre_herd IS NULL OR e.price_herd IS NULL THEN
    RAISE EXCEPTION 'Event % has no prices set', p_event_id;
  END IF;
  RETURN QUERY
  SELECT g,
    CASE WHEN g = 1 AND p_account_holder_attending THEN 'account_holder' ELSE 'guest' END,
    CASE WHEN g = 1 AND p_account_holder_attending AND v_level IS NOT NULL THEN v_level ELSE 'public' END,
    CASE
      WHEN g = 1 AND p_account_holder_attending AND v_level = 'herd' THEN e.price_herd
      WHEN g = 1 AND p_account_holder_attending AND v_level = 'pre_herd' THEN e.price_pre_herd
      ELSE e.price_public
    END
  FROM generate_series(1, p_places) AS g;
END; $function$;
