-- ============================================
-- Drop All Tables - Clean Slate
-- ============================================
-- Run this before 004_refactored_schema.sql

-- Drop in reverse dependency order
DROP TABLE IF EXISTS order_line_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS gift_card_redemptions CASCADE;
DROP TABLE IF EXISTS gift_cards CASCADE;
DROP TABLE IF EXISTS customer_session_passes CASCADE;
DROP TABLE IF EXISTS session_pass_types CASCADE;
DROP TABLE IF EXISTS membership_credit_adjustments CASCADE;
DROP TABLE IF EXISTS customer_memberships CASCADE;
DROP TABLE IF EXISTS membership_plans CASCADE;
DROP TABLE IF EXISTS product_variants CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS addon_order_lines CASCADE;
DROP TABLE IF EXISTS addons CASCADE;
DROP TABLE IF EXISTS booking_guests CASCADE;
DROP TABLE IF EXISTS bookings CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS service_type_price_tiers CASCADE;
DROP TABLE IF EXISTS service_types CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS staff CASCADE;

-- Drop the updated_at trigger function if it exists
DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;
