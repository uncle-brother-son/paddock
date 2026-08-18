-- ============================================
-- Fix NOT NULL constraints on Postgres-owned fields
-- ============================================
-- These fields are set by staff in Retool, not synced from Sanity.
-- They should allow NULL when webhooks create initial rows.

-- Fix products table pricing (all three tiers are Retool-managed)
ALTER TABLE products 
ALTER COLUMN base_price DROP NOT NULL;

-- Fix addons table pricing (same three-tier model)
ALTER TABLE addons
ALTER COLUMN base_price DROP NOT NULL;

-- Fix service_types operational fields (all Retool-managed)
ALTER TABLE service_types
ALTER COLUMN duration DROP NOT NULL,
ALTER COLUMN capacity DROP NOT NULL,
ALTER COLUMN booking_type DROP NOT NULL;

-- Fix membership_plans pricing
ALTER TABLE membership_plans
ALTER COLUMN price DROP NOT NULL;

-- Fix session_pass_types pricing
ALTER TABLE session_pass_types
ALTER COLUMN price DROP NOT NULL;
