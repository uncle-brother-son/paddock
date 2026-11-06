-- Added on top of schema.sql for the reader order tests: the tables a reader order writes to and,
-- unlike schema.sql, the real foreign keys, because the rollback's order of work is set by them.
-- Copied from the live catalog (5 Nov 2026). Columns the tests don't touch are left out of the
-- wider tables; every foreign key, ON DELETE action and NOT NULL they depend on is as live.

CREATE TABLE public.orders (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  order_total numeric NOT NULL,
  payment_status text NOT NULL CHECK (payment_status = ANY (ARRAY['pending','paid','failed','refunded','partially_refunded'])),
  stripe_payment_intent_id text,
  shipping_address jsonb,
  order_source text CHECK (order_source = ANY (ARRAY['online','staff_created'])),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  payment_method text CHECK (payment_method = ANY (ARRAY['card','reader','cash','gift_card','split'])),
  reader_payment jsonb
);

CREATE TABLE public.gift_cards (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  code text NOT NULL UNIQUE,
  type text NOT NULL,
  original_value numeric NOT NULL,
  remaining_balance numeric NOT NULL,
  origin text NOT NULL,
  expiry_date date NOT NULL,
  redeemed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  voided boolean DEFAULT false
);

CREATE TABLE public.product_variants (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  product_id uuid NOT NULL,
  sku text NOT NULL,
  stock_quantity integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.stock_adjustments (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  variant_id uuid NOT NULL REFERENCES public.product_variants(id),
  change_amount integer NOT NULL,
  reason text NOT NULL,
  staff_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.event_bookings (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES public.events(id),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  places integer NOT NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status = ANY (ARRAY['pending','confirmed','cancelled'])),
  price_paid numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.event_attendees (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  event_booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  attendee_type text NOT NULL,
  name text NOT NULL,
  unit_price numeric NOT NULL,
  price_level text NOT NULL
);

CREATE TABLE public.order_line_items (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES public.bookings(id),
  product_variant_id uuid,
  membership_plan_id uuid,
  session_pass_type_id uuid,
  gift_card_id uuid REFERENCES public.gift_cards(id),
  item_type text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  unit_price numeric NOT NULL,
  line_total numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  event_booking_id uuid REFERENCES public.event_bookings(id)
);

CREATE TABLE public.addons (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE public.addon_order_lines (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  addon_id uuid NOT NULL REFERENCES public.addons(id),
  quantity integer NOT NULL DEFAULT 1,
  price_at_purchase numeric NOT NULL,
  sku_at_purchase text NOT NULL,
  redemption_source text CHECK (redemption_source = ANY (ARRAY['paid','membership_credit'])),
  redeemed_membership_id uuid REFERENCES public.customer_memberships(id),
  order_id uuid REFERENCES public.orders(id)
);

CREATE TABLE public.booking_guests (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  guest_type text NOT NULL DEFAULT 'additional_guest',
  guest_name text NOT NULL
);

-- order_id has no foreign key here, live or in this copy.
CREATE TABLE public.gift_card_redemptions (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  gift_card_id uuid NOT NULL REFERENCES public.gift_cards(id) ON DELETE CASCADE,
  order_id uuid,
  booking_id uuid REFERENCES public.bookings(id),
  amount_used numeric NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  event_booking_id uuid REFERENCES public.event_bookings(id)
);

CREATE TABLE public.store_credit_transactions (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  amount numeric NOT NULL CHECK (amount <> 0),
  balance_after numeric NOT NULL CHECK (balance_after >= 0),
  reason text NOT NULL,
  order_id uuid REFERENCES public.orders(id),
  booking_id uuid REFERENCES public.bookings(id),
  gift_card_id uuid REFERENCES public.gift_cards(id),
  staff_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  event_booking_id uuid REFERENCES public.event_bookings(id)
);

CREATE TABLE public.membership_payment_date_changes (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES public.customer_memberships(id),
  order_id uuid REFERENCES public.orders(id)
);

CREATE TABLE public.pending_reader_payments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  flow text NOT NULL,
  record_id uuid NOT NULL,
  order_id uuid,
  payment_intent_id text,
  expected_amount numeric NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The foreign keys schema.sql leaves out, between its own tables and to the ones above.
ALTER TABLE public.bookings
  ADD FOREIGN KEY (redeemed_membership_id) REFERENCES public.customer_memberships(id),
  ADD FOREIGN KEY (redeemed_session_pass_id) REFERENCES public.customer_session_passes(id),
  ADD FOREIGN KEY (credit_period_id) REFERENCES public.membership_credit_periods(id);
ALTER TABLE public.customer_memberships ADD FOREIGN KEY (order_line_item_id) REFERENCES public.order_line_items(id);
ALTER TABLE public.customer_session_passes ADD FOREIGN KEY (order_line_item_id) REFERENCES public.order_line_items(id);
ALTER TABLE public.membership_credit_periods ADD FOREIGN KEY (membership_id) REFERENCES public.customer_memberships(id) ON DELETE CASCADE;
ALTER TABLE public.promo_code_redemptions ADD FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

-- As live.
CREATE OR REPLACE FUNCTION public.store_credit_apply(p_customer_id uuid, p_amount numeric, p_reason text, p_order_id uuid DEFAULT NULL::uuid, p_booking_id uuid DEFAULT NULL::uuid, p_staff_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text, p_gift_card_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_balance numeric; v_new numeric; v_txn uuid;
BEGIN
  IF p_amount IS NULL OR p_amount = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_required');
  END IF;
  SELECT store_credit_balance INTO v_balance FROM customers WHERE id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'customer_not_found');
  END IF;
  v_new := round(v_balance + p_amount, 2);
  IF v_new < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_store_credit', 'balance', v_balance);
  END IF;
  UPDATE customers SET store_credit_balance = v_new, updated_at = now() WHERE id = p_customer_id;
  INSERT INTO store_credit_transactions (customer_id, amount, balance_after, reason, order_id, booking_id, gift_card_id, staff_id, note)
  VALUES (p_customer_id, round(p_amount,2), v_new, p_reason, p_order_id, p_booking_id, p_gift_card_id, p_staff_id, p_note)
  RETURNING id INTO v_txn;
  RETURN jsonb_build_object('ok', true, 'transaction_id', v_txn, 'balance', v_new);
END $function$;

CREATE OR REPLACE FUNCTION public.release_event_places(p_event_id uuid, p_places integer)
 RETURNS void LANGUAGE sql
AS $function$
  UPDATE public.events SET places_booked = GREATEST(places_booked - p_places, 0), updated_at = now()
  WHERE id = p_event_id;
$function$;

-- Stands in for the live function, which only adds credit periods. Its body doesn't matter here.
CREATE OR REPLACE FUNCTION public.allocate_membership_credit_periods()
 RETURNS integer LANGUAGE sql AS $function$ SELECT 0 $function$;
