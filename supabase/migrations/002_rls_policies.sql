-- ============================================
-- Row Level Security Policies
-- ============================================
-- Basic policies - customers can read their own data
-- Service role (backend) bypasses RLS entirely

-- ============================================
-- CUSTOMERS
-- ============================================
-- Users can read and update their own customer record
CREATE POLICY "Users can view own customer data"
  ON customers FOR SELECT
  USING (auth.uid() = auth_user_id);

CREATE POLICY "Users can update own customer data"
  ON customers FOR UPDATE
  USING (auth.uid() = auth_user_id);

-- ============================================
-- BOOKINGS
-- ============================================
-- Users can view their own bookings
CREATE POLICY "Users can view own bookings"
  ON bookings FOR SELECT
  USING (customer_id IN (
    SELECT id FROM customers WHERE auth_user_id = auth.uid()
  ));

-- ============================================
-- BOOKING GUESTS
-- ============================================
-- Users can view guests for their own bookings
CREATE POLICY "Users can view own booking guests"
  ON booking_guests FOR SELECT
  USING (booking_id IN (
    SELECT b.id FROM bookings b
    JOIN customers c ON b.customer_id = c.id
    WHERE c.auth_user_id = auth.uid()
  ));

-- ============================================
-- CUSTOMER MEMBERSHIPS
-- ============================================
CREATE POLICY "Users can view own memberships"
  ON customer_memberships FOR SELECT
  USING (customer_id IN (
    SELECT id FROM customers WHERE auth_user_id = auth.uid()
  ));

-- ============================================
-- CUSTOMER SESSION PASSES
-- ============================================
CREATE POLICY "Users can view own session passes"
  ON customer_session_passes FOR SELECT
  USING (customer_id IN (
    SELECT id FROM customers WHERE auth_user_id = auth.uid()
  ));

-- ============================================
-- GIFT CARDS
-- ============================================
-- Users can view gift cards they purchased or received
CREATE POLICY "Users can view own gift cards"
  ON gift_cards FOR SELECT
  USING (
    purchaser_id IN (
      SELECT id FROM customers WHERE auth_user_id = auth.uid()
    )
    OR recipient_email IN (
      SELECT email FROM customers WHERE auth_user_id = auth.uid()
    )
  );

-- ============================================
-- ORDERS
-- ============================================
CREATE POLICY "Users can view own orders"
  ON orders FOR SELECT
  USING (customer_id IN (
    SELECT id FROM customers WHERE auth_user_id = auth.uid()
  ));

-- ============================================
-- ORDER LINE ITEMS
-- ============================================
CREATE POLICY "Users can view own order line items"
  ON order_line_items FOR SELECT
  USING (order_id IN (
    SELECT o.id FROM orders o
    JOIN customers c ON o.customer_id = c.id
    WHERE c.auth_user_id = auth.uid()
  ));

-- ============================================
-- PUBLIC READ ACCESS (No auth required)
-- ============================================
-- These tables are public catalogs - anyone can read

CREATE POLICY "Public read access to service types"
  ON service_types FOR SELECT
  USING (active = true);

CREATE POLICY "Public read access to service type price tiers"
  ON service_type_price_tiers FOR SELECT
  USING (true);

CREATE POLICY "Public read access to sessions"
  ON sessions FOR SELECT
  USING (true);

CREATE POLICY "Public read access to addons"
  ON addons FOR SELECT
  USING (active = true);

CREATE POLICY "Public read access to products"
  ON products FOR SELECT
  USING (active = true);

CREATE POLICY "Public read access to product variants"
  ON product_variants FOR SELECT
  USING (true);

CREATE POLICY "Public read access to membership plans"
  ON membership_plans FOR SELECT
  USING (active = true);

CREATE POLICY "Public read access to session pass types"
  ON session_pass_types FOR SELECT
  USING (active = true);
