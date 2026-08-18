-- ============================================
-- Fix NOT NULL constraints on Postgres-owned fields
-- ============================================
-- Per 06-sanity-supabase-field-split.md:
-- Pricing and operational fields are Postgres-owned (set in Retool)
-- Sanity webhook only syncs mirror fields (name, thumbnail_url, category)

-- Products: base_price is Postgres-owned (three-tier pricing set in Retool)
ALTER TABLE products 
ALTER COLUMN base_price DROP NOT NULL;

-- Addons: base_price is Postgres-owned (three-tier pricing set in Retool)
ALTER TABLE addons 
ALTER COLUMN base_price DROP NOT NULL;

-- Service Types: duration, capacity, booking_type, price are Postgres-owned
ALTER TABLE service_types 
ALTER COLUMN duration DROP NOT NULL,
ALTER COLUMN capacity DROP NOT NULL,
ALTER COLUMN booking_type DROP NOT NULL;

-- Membership Plans: all operational fields are Postgres-owned
ALTER TABLE membership_plans
ALTER COLUMN price DROP NOT NULL,
ALTER COLUMN billing_frequency DROP NOT NULL,
ALTER COLUMN sessions_included DROP NOT NULL,
ALTER COLUMN addons_included DROP NOT NULL;

-- Session Pass Types: price and sessions_included are Postgres-owned
ALTER TABLE session_pass_types
ALTER COLUMN price DROP NOT NULL,
ALTER COLUMN sessions_included DROP NOT NULL;
