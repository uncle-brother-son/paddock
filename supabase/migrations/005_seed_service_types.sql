-- ============================================
-- Seed Data - Service Types & Price Tiers
-- ============================================
-- Creates placeholder service types with confirmed and pending price tiers

-- Public Session service type
INSERT INTO service_types (name, duration, capacity, booking_type, price, active)
VALUES ('Public Session', 60, 6, 'public', 15.00, true);

-- Private Session 60min
INSERT INTO service_types (id, name, duration, capacity, booking_type, active)
VALUES 
  ('a0000000-0000-0000-0000-000000000001', 'Private Session (60 min)', 60, 6, 'private', true);

-- Private Session 120min
INSERT INTO service_types (id, name, duration, capacity, booking_type, active)
VALUES 
  ('a0000000-0000-0000-0000-000000000002', 'Private Session (120 min)', 120, 6, 'private', true);

-- ============================================
-- Private Session 60min Price Tiers
-- ============================================

-- Confirmed tiers
INSERT INTO service_type_price_tiers (service_type_id, min_people, max_people, price) VALUES
  ('a0000000-0000-0000-0000-000000000001', 1, 6, 105.00),
  ('a0000000-0000-0000-0000-000000000001', 7, 7, 120.00),
  ('a0000000-0000-0000-0000-000000000001', 8, 8, 140.00),
  ('a0000000-0000-0000-0000-000000000001', 10, 10, 170.00);

-- Pending tier (9 adults - awaiting HH confirmation)
INSERT INTO service_type_price_tiers (service_type_id, min_people, max_people, price) VALUES
  ('a0000000-0000-0000-0000-000000000001', 9, 9, NULL);

-- ============================================
-- Private Session 120min Price Tiers
-- ============================================

-- Confirmed tier
INSERT INTO service_type_price_tiers (service_type_id, min_people, max_people, price) VALUES
  ('a0000000-0000-0000-0000-000000000002', 1, 6, 210.00);

-- Pending tiers (7/8/9/10 adults - awaiting HH confirmation)
INSERT INTO service_type_price_tiers (service_type_id, min_people, max_people, price) VALUES
  ('a0000000-0000-0000-0000-000000000002', 7, 7, NULL),
  ('a0000000-0000-0000-0000-000000000002', 8, 8, NULL),
  ('a0000000-0000-0000-0000-000000000002', 9, 9, NULL),
  ('a0000000-0000-0000-0000-000000000002', 10, 10, NULL);

-- ============================================
-- Notes for Later
-- ============================================
-- When HH confirms pending prices:
-- UPDATE service_type_price_tiers SET price = X.XX WHERE service_type_id = '...' AND min_people = N;
