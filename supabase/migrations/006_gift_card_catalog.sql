-- ============================================
-- Gift Card Catalog
-- ============================================
-- gift_card_types is a Sanity-synced catalog entity (same pattern as service_types,
-- products, addons, membership_plans, session_pass_types). gift_card_presets is a
-- Postgres-only child entity (same pattern as product_variants) holding the fixed,
-- staff-defined amounts a gift card type can be sold for. Customer-entered custom
-- amounts (see custom_amount_enabled/min/max) never create a preset row — those are
-- priced inline at charge time via Stripe price_data, not a pre-created Price.
--
-- The pre-existing gift_cards table (issued instances: code, balance, purchaser,
-- expiry, voided, origin) is untouched by this migration. This catalog is a new
-- layer in front of it, same relationship as membership_plans -> customer_memberships.

CREATE TABLE gift_card_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sanity_gift_card_type_id TEXT UNIQUE,

  -- Mirrored from Sanity
  name TEXT NOT NULL,
  thumbnail_url TEXT,

  -- Postgres-owned
  active BOOLEAN NOT NULL DEFAULT true,
  stripe_product_id TEXT UNIQUE,
  custom_amount_enabled BOOLEAN NOT NULL DEFAULT false,
  custom_amount_min DECIMAL(10, 2),
  custom_amount_max DECIMAL(10, 2),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gift_card_types_sanity ON gift_card_types(sanity_gift_card_type_id);

CREATE TABLE gift_card_presets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gift_card_type_id UUID NOT NULL REFERENCES gift_card_types(id) ON DELETE CASCADE,

  amount DECIMAL(10, 2) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  stripe_price_id TEXT UNIQUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gift_card_presets_type ON gift_card_presets(gift_card_type_id);

ALTER TABLE gift_card_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_card_presets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access to gift card types"
  ON gift_card_types FOR SELECT
  USING (active = true);

CREATE POLICY "Public read access to gift card presets"
  ON gift_card_presets FOR SELECT
  USING (active = true);

-- update_updated_at_column() already exists (defined in 004_refactored_schema.sql)
CREATE TRIGGER update_gift_card_types_updated_at BEFORE UPDATE ON gift_card_types FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_gift_card_presets_updated_at BEFORE UPDATE ON gift_card_presets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Belt-and-suspenders: explicitly grant service_role on the two new tables. The
-- ALTER DEFAULT PRIVILEGES fix applied earlier this project should already cover
-- newly created tables, but GRANT is idempotent so this is safe to re-run either way.
GRANT ALL ON gift_card_types TO service_role;
GRANT ALL ON gift_card_presets TO service_role;
