-- ============================================
-- The Paddock Wellness Club - Database Schema
-- ============================================
-- Based on data model from project info/05-data-model.md
-- Created: 2026-08-15

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
  date_of_birth DATE NOT NULL, -- Required at signup, enforces 18+ minimum
  
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_customers_stripe_id ON customers(stripe_customer_id);
CREATE INDEX idx_customers_auth_user ON customers(auth_user_id);

-- ============================================
-- 2. SESSIONS (Shared time slots)
-- ============================================
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  resource_id UUID, -- Future-proof for multiple saunas
  service_type TEXT NOT NULL DEFAULT 'Sauna Session',
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  
  -- Type determined by first booking
  type TEXT CHECK (type IN ('public', 'private')),
  
  -- Capacity
  capacity INTEGER NOT NULL DEFAULT 6, -- Public: 6, Private: exclusive (party max 10)
  total_booked INTEGER NOT NULL DEFAULT 0,
  
  -- Staff blocking
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'blocked')),
  blocked_reason TEXT,
  blocked_by UUID REFERENCES customers(id), -- Staff user who blocked it
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_start_time ON sessions(start_time);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_type ON sessions(type);

-- ============================================
-- 3. BOOKINGS (Customer reservations)
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
  
  -- How was this booking paid for?
  redemption_source TEXT CHECK (redemption_source IN ('paid', 'membership_credit', 'session_pass_credit', 'gift_card')),
  
  -- Timestamps
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
-- 4. BOOKING GUESTS (Waiver tracking)
-- ============================================
CREATE TABLE booking_guests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  
  guest_name TEXT NOT NULL,
  guest_email TEXT, -- Optional, only needed for pre-arrival waiver link
  
  -- Waiver
  waiver_accepted BOOLEAN DEFAULT FALSE,
  waiver_version TEXT,
  waiver_accepted_at TIMESTAMPTZ,
  waiver_method TEXT CHECK (waiver_method IN ('email_link', 'in_person')),
  
  -- Reminder tracking
  reminder_sent_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_booking_guests_booking ON booking_guests(booking_id);

-- ============================================
-- 5. ADD-ONS (Catalog)
-- ============================================
CREATE TABLE addons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT, -- Includes ingredients/composition
  price DECIMAL(10, 2) NOT NULL,
  sku TEXT UNIQUE,
  
  stripe_product_id TEXT UNIQUE,
  stripe_price_id TEXT UNIQUE,
  
  image_url TEXT,
  active BOOLEAN DEFAULT TRUE,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_addons_active ON addons(active);

-- ============================================
-- 6. ADD-ON ORDER LINES (Per booking)
-- ============================================
CREATE TABLE addon_order_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  addon_id UUID NOT NULL REFERENCES addons(id),
  
  quantity INTEGER NOT NULL DEFAULT 1,
  price_at_purchase DECIMAL(10, 2) NOT NULL,
  
  -- Payment method
  redemption_source TEXT CHECK (redemption_source IN ('paid', 'membership_credit')),
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_addon_lines_booking ON addon_order_lines(booking_id);

-- ============================================
-- 7. PRODUCTS / MERCHANDISE (Catalog)
-- ============================================
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT,
  product_info TEXT, -- Composition, made-in, etc.
  
  base_price DECIMAL(10, 2) NOT NULL,
  member_price DECIMAL(10, 2), -- Optional member discount
  
  category TEXT,
  
  -- Fulfillment
  fulfillment_method TEXT DEFAULT 'both' CHECK (fulfillment_method IN ('shipping', 'pickup', 'both')),
  
  -- Images (up to 5)
  images JSONB, -- Array of URLs
  
  stripe_product_id TEXT UNIQUE,
  active BOOLEAN DEFAULT TRUE,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_products_active ON products(active);
CREATE INDEX idx_products_category ON products(category);

-- ============================================
-- 8. PRODUCT VARIANTS (Size, color, etc.)
-- ============================================
CREATE TABLE product_variants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  
  size TEXT,
  color TEXT,
  sku TEXT UNIQUE NOT NULL,
  
  price_override DECIMAL(10, 2), -- If different from base price
  stock_quantity INTEGER NOT NULL DEFAULT 0,
  
  stripe_price_id TEXT UNIQUE,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_variants_product ON product_variants(product_id);
CREATE INDEX idx_variants_sku ON product_variants(sku);

-- ============================================
-- 9. MEMBERSHIPS (Plans)
-- ============================================
CREATE TABLE membership_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  billing_frequency TEXT NOT NULL DEFAULT 'monthly',
  
  sessions_included INTEGER NOT NULL DEFAULT 0,
  addons_included INTEGER NOT NULL DEFAULT 0, -- Shared pool of credits
  
  stripe_product_id TEXT UNIQUE,
  stripe_price_id TEXT UNIQUE,
  
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- 10. CUSTOMER MEMBERSHIP INSTANCES
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
  
  credits_reset_date DATE, -- When credits reset to zero
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memberships_customer ON customer_memberships(customer_id);
CREATE INDEX idx_memberships_status ON customer_memberships(subscription_status);

-- ============================================
-- 11. SESSION PASSES (One-off bundles)
-- ============================================
CREATE TABLE session_pass_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  sessions_included INTEGER NOT NULL,
  
  stripe_product_id TEXT UNIQUE,
  stripe_price_id TEXT UNIQUE,
  
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- 12. CUSTOMER SESSION PASS INSTANCES
-- ============================================
CREATE TABLE customer_session_passes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  pass_type_id UUID NOT NULL REFERENCES session_pass_types(id),
  
  purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
  sessions_remaining INTEGER NOT NULL,
  expiry_date DATE NOT NULL, -- 6 months from purchase
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_passes_customer ON customer_session_passes(customer_id);
CREATE INDEX idx_passes_expiry ON customer_session_passes(expiry_date);

-- ============================================
-- 13. GIFT CARDS
-- ============================================
CREATE TABLE gift_cards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT UNIQUE NOT NULL, -- Unique redemption code
  
  type TEXT NOT NULL CHECK (type IN ('monetary', 'session_based')),
  
  original_value DECIMAL(10, 2) NOT NULL,
  remaining_balance DECIMAL(10, 2) NOT NULL,
  
  purchaser_id UUID REFERENCES customers(id),
  recipient_name TEXT,
  recipient_email TEXT,
  gift_message TEXT,
  
  -- Fulfillment
  fulfillment_type TEXT CHECK (fulfillment_type IN ('digital', 'pickup')),
  
  -- Origin tracking (for cancellation/refund policy)
  origin TEXT NOT NULL CHECK (origin IN ('customer_purchase', 'issued_as_credit')),
  
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expiry_date DATE NOT NULL, -- 12 months from issue
  
  redeemed_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_giftcards_code ON gift_cards(code);
CREATE INDEX idx_giftcards_purchaser ON gift_cards(purchaser_id);

-- ============================================
-- 14. GIFT CARD REDEMPTION HISTORY
-- ============================================
CREATE TABLE gift_card_redemptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gift_card_id UUID NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  order_id UUID, -- Will reference orders table
  booking_id UUID REFERENCES bookings(id),
  
  amount_used DECIMAL(10, 2) NOT NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_redemptions_giftcard ON gift_card_redemptions(gift_card_id);

-- ============================================
-- 15. ORDERS / CHECKOUT (Unified)
-- ============================================
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  
  order_total DECIMAL(10, 2) NOT NULL,
  payment_status TEXT NOT NULL CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
  
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  
  -- Promo code
  promo_code TEXT,
  discount_amount DECIMAL(10, 2) DEFAULT 0,
  
  -- Shipping (for physical items)
  shipping_address JSONB,
  shipping_status TEXT CHECK (shipping_status IN ('pending', 'shipped', 'delivered')),
  tracking_number TEXT,
  
  -- Source
  order_source TEXT DEFAULT 'online' CHECK (order_source IN ('online', 'staff_created')),
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(payment_status);
CREATE INDEX idx_orders_created ON orders(created_at);

-- ============================================
-- 16. ORDER LINE ITEMS (Polymorphic)
-- ============================================
CREATE TABLE order_line_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  
  -- Polymorphic reference (one of these will be set)
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
-- 17. STAFF / ADMIN USERS
-- ============================================
CREATE TABLE staff (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
  
  -- Permissions
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

-- Auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables with updated_at
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
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
-- ROW LEVEL SECURITY (RLS) - Initial Setup
-- ============================================
-- Note: Policies will be added in a separate migration
-- after business logic requirements are finalized

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_guests ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_session_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_line_items ENABLE ROW LEVEL SECURITY;

-- Public read-only tables (no RLS needed)
-- sessions, addons, products, product_variants, membership_plans, session_pass_types
