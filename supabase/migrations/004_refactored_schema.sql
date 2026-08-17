-- ============================================
-- The Paddock Wellness Club - Refactored Schema
-- ============================================
-- Based on updated architecture from project info docs
-- Implements Sanity/Supabase field split + three-tier pricing

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 1. CUSTOMERS / ACCOUNTS
-- ============================================
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  stripe_customer_id TEXT UNIQUE,
  saved_payment_method_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Marketing & consent
  marketing_consent BOOLEAN DEFAULT FALSE,
  birthday_marketing_consent BOOLEAN DEFAULT FALSE,
  
  -- Address
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  postcode TEXT,
  country TEXT DEFAULT 'GB',
  
  -- Waiver
  waiver_accepted BOOLEAN DEFAULT FALSE,
  waiver_version TEXT,
  waiver_accepted_at TIMESTAMPTZ,
  date_of_birth DATE NOT NULL,
  
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_customers_stripe_id ON customers(stripe_customer_id);
CREATE INDEX idx_customers_auth_user ON customers(auth_user_id);

-- ============================================
-- 2. SERVICE TYPES (Catalog - Public/Private session types)
-- ============================================
CREATE TABLE service_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sanity_service_type_id TEXT UNIQUE,
  
  -- Mirrored from Sanity
  name TEXT NOT NULL,
  thumbnail_url TEXT,
  
  -- Postgres-owned operational fields
  duration INTEGER NOT NULL, -- minutes (60 or 120)
  capacity INTEGER NOT NULL DEFAULT 6,
  booking_type TEXT NOT NULL CHECK (booking_type IN ('public', 'private')),
  
  -- Price only for public (private uses price tiers)
  price DECIMAL(10, 2),
  
  active BOOLEAN DEFAULT TRUE,
  stripe_product_id TEXT UNIQUE,
  stripe_price_id TEXT, -- public only
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_service_types_active ON service_types(active);
CREATE INDEX idx_service_types_booking_type ON service_types(booking_type);

-- ============================================
-- 3. SERVICE TYPE PRICE TIERS (Private booking headcount pricing)
-- ============================================
CREATE TABLE service_type_price_tiers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_type_id UUID NOT NULL REFERENCES service_types(id) ON DELETE CASCADE,
  
  min_people INTEGER NOT NULL,
  max_people INTEGER NOT NULL,
  price DECIMAL(10, 2), -- null for pending/unconfirmed tiers
  
  stripe_price_id TEXT UNIQUE,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  CONSTRAINT check_people_range CHECK (min_people <= max_people)
);

CREATE INDEX idx_price_tiers_service_type ON service_type_price_tiers(service_type_id);

-- ============================================
-- 4. SESSIONS (Generated time slots)
-- ============================================
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  resource_id UUID,
  service_type_id UUID NOT NULL REFERENCES service_types(id),
  
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  
  type TEXT CHECK (type IN ('public', 'private')),
  capacity INTEGER NOT NULL DEFAULT 6,
  total_booked INTEGER NOT NULL DEFAULT 0,
  
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'blocked')),
  blocked_reason TEXT,
  blocked_by UUID REFERENCES customers(id),
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_start_time ON sessions(start_time);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_type ON sessions(type);
CREATE INDEX idx_sessions_service_type ON sessions(service_type_id);

-- ============================================
-- 5. BOOKINGS
-- ============================================
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  
  party_size INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no-show')),
  
  price_paid DECIMAL(10, 2) NOT NULL,
  stripe_payment_id TEXT,
  stripe_session_id TEXT,
  
  redemption_source TEXT CHECK (redemption_source IN ('paid', 'membership_credit', 'session_pass_credit', 'gift_card')),
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  checked_in_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bookings_session ON bookings(session_id);
CREATE INDEX idx_bookings_customer ON bookings(customer_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_created ON bookings(created_at);

-- ============================================
-- 6. BOOKING GUESTS (Waiver tracking)
-- ============================================
CREATE TABLE booking_guests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  
  guest_type TEXT NOT NULL DEFAULT 'additional_guest' CHECK (guest_type IN ('account_holder', 'additional_guest')),
  guest_name TEXT NOT NULL,
  guest_email TEXT,
  
  waiver_accepted BOOLEAN DEFAULT FALSE,
  waiver_version TEXT,
  waiver_accepted_at TIMESTAMPTZ,
  waiver_method TEXT CHECK (waiver_method IN ('email_link', 'in_person')),
  
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_booking_guests_booking ON booking_guests(booking_id);

-- ============================================
-- 7. ADD-ONS (Catalog)
-- ============================================
CREATE TABLE addons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sanity_addon_id TEXT UNIQUE,
  
  -- Mirrored from Sanity
  name TEXT NOT NULL,
  thumbnail_url TEXT,
  category TEXT,
  
  -- Postgres-owned operational fields
  sku TEXT UNIQUE,
  base_price DECIMAL(10, 2) NOT NULL,
  member_price DECIMAL(10, 2),
  sale_price DECIMAL(10, 2),
  
  stripe_product_id TEXT UNIQUE,
  stripe_price_id_base TEXT UNIQUE,
  stripe_price_id_member TEXT UNIQUE,
  stripe_price_id_sale TEXT UNIQUE,
  
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_addons_active ON addons(active);
CREATE INDEX idx_addons_category ON addons(category);

-- ============================================
-- 8. ADD-ON ORDER LINES
-- ============================================
CREATE TABLE addon_order_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  addon_id UUID NOT NULL REFERENCES addons(id),
  
  quantity INTEGER NOT NULL DEFAULT 1,
  price_at_purchase DECIMAL(10, 2) NOT NULL,
  sku_at_purchase TEXT NOT NULL,
  
  redemption_source TEXT CHECK (redemption_source IN ('paid', 'membership_credit')),
  stripe_price_id TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_addon_lines_booking ON addon_order_lines(booking_id);

-- ============================================
-- 9. PRODUCTS / MERCHANDISE (Catalog)
-- ============================================
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sanity_product_id TEXT UNIQUE,
  
  -- Mirrored from Sanity
  name TEXT NOT NULL,
  thumbnail_url TEXT,
  category TEXT,
  
  -- Postgres-owned operational fields
  base_price DECIMAL(10, 2) NOT NULL,
  member_price DECIMAL(10, 2),
  sale_price DECIMAL(10, 2),
  
  fulfillment_method TEXT DEFAULT 'both' CHECK (fulfillment_method IN ('shipping', 'pickup', 'both')),
  shipping_weight DECIMAL(10, 2), -- kg
  shipping_dimensions JSONB, -- {length, width, height} in cm
  
  stripe_product_id TEXT UNIQUE,
  stripe_price_id_base TEXT UNIQUE,
  stripe_price_id_member TEXT UNIQUE,
  stripe_price_id_sale TEXT UNIQUE,
  
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_products_active ON products(active);
CREATE INDEX idx_products_category ON products(category);

-- ============================================
-- 10. PRODUCT VARIANTS
-- ============================================
CREATE TABLE product_variants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  
  size TEXT,
  sku TEXT UNIQUE NOT NULL,
  
  price_override DECIMAL(10, 2),
  stock_quantity INTEGER NOT NULL DEFAULT 0,
  
  stripe_price_id TEXT UNIQUE,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_variants_product ON product_variants(product_id);
CREATE INDEX idx_variants_sku ON product_variants(sku);

-- ============================================
-- 11. MEMBERSHIP PLANS (Catalog)
-- ============================================
CREATE TABLE membership_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sanity_plan_id TEXT UNIQUE,
  
  -- Mirrored from Sanity
  name TEXT NOT NULL,
  thumbnail_url TEXT,
  
  -- Postgres-owned operational fields
  price DECIMAL(10, 2) NOT NULL,
  billing_frequency TEXT NOT NULL DEFAULT 'monthly',
  
  sessions_included INTEGER NOT NULL DEFAULT 0,
  addons_included INTEGER NOT NULL DEFAULT 0,
  
  stripe_product_id TEXT UNIQUE,
  stripe_price_id TEXT UNIQUE,
  
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_membership_plans_active ON membership_plans(active);

-- ============================================
-- 12. CUSTOMER MEMBERSHIP INSTANCES
-- ============================================
CREATE TABLE customer_memberships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES membership_plans(id),
  
  stripe_subscription_id TEXT UNIQUE,
  subscription_status TEXT CHECK (subscription_status IN ('active', 'paused', 'cancelled')),
  
  start_date DATE NOT NULL,
  next_renewal_date DATE,
  
  -- Current cycle credits
  session_credits_remaining INTEGER NOT NULL DEFAULT 0,
  addon_credits_remaining INTEGER NOT NULL DEFAULT 0,
  
  -- Ad-hoc bonus credits (promotions)
  bonus_session_credits INTEGER NOT NULL DEFAULT 0,
  bonus_addon_credits INTEGER NOT NULL DEFAULT 0,
  
  credits_reset_date DATE,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memberships_customer ON customer_memberships(customer_id);
CREATE INDEX idx_memberships_status ON customer_memberships(subscription_status);

-- ============================================
-- 13. MEMBERSHIP CREDIT ADJUSTMENTS (Audit trail for bonus credits)
-- ============================================
CREATE TABLE membership_credit_adjustments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  membership_id UUID NOT NULL REFERENCES customer_memberships(id) ON DELETE CASCADE,
  
  credit_type TEXT NOT NULL CHECK (credit_type IN ('session', 'addon')),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  
  staff_id UUID REFERENCES customers(id), -- Staff user who made the adjustment
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credit_adjustments_membership ON membership_credit_adjustments(membership_id);

-- ============================================
-- 14. SESSION PASS TYPES (Catalog)
-- ============================================
CREATE TABLE session_pass_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sanity_pass_type_id TEXT UNIQUE,
  
  -- Mirrored from Sanity
  name TEXT NOT NULL,
  thumbnail_url TEXT,
  
  -- Postgres-owned operational fields
  price DECIMAL(10, 2) NOT NULL,
  sessions_included INTEGER NOT NULL,
  expiry_months INTEGER NOT NULL DEFAULT 12, -- Configurable in Retool
  
  stripe_product_id TEXT UNIQUE,
  stripe_price_id TEXT UNIQUE,
  
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pass_types_active ON session_pass_types(active);

-- ============================================
-- 15. CUSTOMER SESSION PASS INSTANCES
-- ============================================
CREATE TABLE customer_session_passes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  pass_type_id UUID NOT NULL REFERENCES session_pass_types(id),
  
  purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
  sessions_remaining INTEGER NOT NULL,
  expiry_date DATE NOT NULL,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_passes_customer ON customer_session_passes(customer_id);
CREATE INDEX idx_passes_expiry ON customer_session_passes(expiry_date);

-- ============================================
-- 16. GIFT CARDS
-- ============================================
CREATE TABLE gift_cards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT UNIQUE NOT NULL,
  
  type TEXT NOT NULL CHECK (type IN ('monetary', 'session_based')),
  
  original_value DECIMAL(10, 2) NOT NULL,
  remaining_balance DECIMAL(10, 2) NOT NULL,
  
  purchaser_id UUID REFERENCES customers(id),
  recipient_name TEXT,
  recipient_email TEXT,
  gift_message TEXT,
  
  -- Origin tracking (for cancellation/refund policy)
  origin TEXT NOT NULL CHECK (origin IN ('customer_purchase', 'issued_as_credit')),
  
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expiry_date DATE NOT NULL,
  
  redeemed_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_giftcards_code ON gift_cards(code);
CREATE INDEX idx_giftcards_purchaser ON gift_cards(purchaser_id);

-- ============================================
-- 17. GIFT CARD REDEMPTION HISTORY
-- ============================================
CREATE TABLE gift_card_redemptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gift_card_id UUID NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  order_id UUID,
  booking_id UUID REFERENCES bookings(id),
  
  amount_used DECIMAL(10, 2) NOT NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_redemptions_giftcard ON gift_card_redemptions(gift_card_id);

-- ============================================
-- 18. ORDERS / CHECKOUT
-- ============================================
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  
  order_total DECIMAL(10, 2) NOT NULL,
  payment_status TEXT NOT NULL CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
  
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  
  promo_code TEXT,
  discount_amount DECIMAL(10, 2) DEFAULT 0,
  
  shipping_address JSONB,
  shipping_status TEXT CHECK (shipping_status IN ('pending', 'shipped', 'delivered')),
  tracking_number TEXT,
  
  order_source TEXT DEFAULT 'online' CHECK (order_source IN ('online', 'staff_created')),
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(payment_status);
CREATE INDEX idx_orders_created ON orders(created_at);

-- ============================================
-- 19. ORDER LINE ITEMS (Polymorphic)
-- ============================================
CREATE TABLE order_line_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  
  booking_id UUID REFERENCES bookings(id),
  product_variant_id UUID REFERENCES product_variants(id),
  membership_plan_id UUID REFERENCES membership_plans(id),
  session_pass_type_id UUID REFERENCES session_pass_types(id),
  gift_card_id UUID REFERENCES gift_cards(id),
  
  item_type TEXT NOT NULL CHECK (item_type IN ('booking', 'product', 'membership', 'session_pass', 'gift_card', 'addon')),
  
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price DECIMAL(10, 2) NOT NULL,
  line_total DECIMAL(10, 2) NOT NULL,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_lines_order ON order_line_items(order_id);

-- ============================================
-- 20. STAFF / ADMIN USERS
-- ============================================
CREATE TABLE staff (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
  
  can_issue_refunds BOOLEAN DEFAULT FALSE,
  can_charge_saved_cards BOOLEAN DEFAULT FALSE,
  can_view_reports BOOLEAN DEFAULT FALSE,
  
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_staff_customer ON staff(customer_id);
CREATE INDEX idx_staff_role ON staff(role);

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables with updated_at
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_service_types_updated_at BEFORE UPDATE ON service_types FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_price_tiers_updated_at BEFORE UPDATE ON service_type_price_tiers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_sessions_updated_at BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_bookings_updated_at BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_addons_updated_at BEFORE UPDATE ON addons FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_product_variants_updated_at BEFORE UPDATE ON product_variants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_membership_plans_updated_at BEFORE UPDATE ON membership_plans FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_customer_memberships_updated_at BEFORE UPDATE ON customer_memberships FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_session_pass_types_updated_at BEFORE UPDATE ON session_pass_types FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_customer_session_passes_updated_at BEFORE UPDATE ON customer_session_passes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_gift_cards_updated_at BEFORE UPDATE ON gift_cards FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_staff_updated_at BEFORE UPDATE ON staff FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_guests ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_session_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_line_items ENABLE ROW LEVEL SECURITY;
