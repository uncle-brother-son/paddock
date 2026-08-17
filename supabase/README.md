# Supabase Database Setup

This folder contains SQL migrations for The Paddock Wellness Club database schema.

## Migrations

- `001_initial_schema.sql` - **DEPRECATED** - Original schema (replaced by refactored version)
- `002_rls_policies.sql` - Row Level Security policies for customer data protection
- `003_drop_all.sql` - Drops all tables for clean refactor
- `004_refactored_schema.sql` - **CURRENT** - Refactored schema implementing Sanity/Supabase field split + three-tier pricing
- `005_seed_service_types.sql` - Seed data for service types and price tiers

## How to Apply Migrations (Fresh Setup)

### Option 1: Supabase Dashboard (Recommended)

1. Go to your Supabase Dashboard: https://supabase.com/dashboard
2. Select your project
3. Click **SQL Editor** in the left sidebar
4. Run migrations in order:
   - Skip `001_initial_schema.sql` (deprecated)
   - Run `003_drop_all.sql` (clears any existing schema)
   - Run `004_refactored_schema.sql` (creates new schema)
   - Run `002_rls_policies.sql` (security policies)
   - Run `005_seed_service_types.sql` (initial service type data)

### Option 2: Supabase CLI

```bash
# Install Supabase CLI if you haven't already
npm install -g supabase

# Link to your project
supabase link --project-ref YOUR_PROJECT_REF

# Apply migrations
supabase db push
```

## Database Schema Overview

### Architecture Principles

This schema implements the **Sanity/Supabase field split** documented in `/project info/06-sanity-supabase-field-split.md`:

- **Sanity** = Marketing content (descriptions, full image arrays, productGroup links, etc.)
- **Supabase** = Operational data (prices, stock, Stripe IDs, booking state, customer data)
- **Mirror fields** = Small subset synced from Sanity to Supabase (name, thumbnail_url, category) for Retool UX

**Three-tier pricing**: Products and Add-ons have base/member/sale prices, each with its own Stripe Price ID. Priority order: member > sale > base. Promo codes apply on top of selected tier.

### Core Entities

1. **customers** - User accounts with auth, billing, waiver tracking
2. **service_types** - Catalog of session types (Public, Private 60min, Private 120min) *(new)*
3. **service_type_price_tiers** - Headcount-based pricing for private bookings *(new)*
4. **sessions** - Generated time slots (references service_type_id)
5. **bookings** - Customer reservations into sessions
6. **booking_guests** - Waiver tracking for group booking attendees (added guest_type field)
7. **addons** - Catalog of add-ons (refactored with three-tier pricing)
8. **addon_order_lines** - Add-ons purchased with bookings (added price/SKU snapshots)
9. **products** - Merchandise catalog (refactored with three-tier pricing, Sanity mirrors)
10. **product_variants** - Size variants with stock tracking (color removed - handled via productGroup in Sanity)
11. **membership_plans** - Monthly subscription plans (refactored with Sanity mirrors)
12. **customer_memberships** - Active membership instances (added bonus credit fields)
13. **membership_credit_adjustments** - Audit trail for promotional credits *(new)*
14. **session_pass_types** - One-off session bundle products (added expiry_months field)
15. **customer_session_passes** - Purchased passes with remaining sessions
16. **gift_cards** - Monetary or session-based gift cards (removed shipping fields)
17. **gift_card_redemptions** - Redemption history
18. **orders** - Unified checkout records
19. **order_line_items** - Polymorphic line items (bookings, products, memberships, etc.)
20. **staff** - Admin/staff users with role-based permissions

### Key Features

- ✅ **Sanity/Supabase field split** - Marketing content in Sanity, operational data in Postgres, with strategic mirror fields
- ✅ **Three-tier pricing** - base/member/sale prices with separate Stripe Price IDs per tier
- ✅ **Headcount-based private pricing** - Tiered pricing by party size (1-6, 7, 8, 9, 10 adults)
- ✅ **Automatic timestamps** - `created_at` and `updated_at` with triggers
- ✅ **UUID primary keys** - All tables use UUIDs
- ✅ **Row Level Security** - Customer data protected, public catalog data readable
- ✅ **Stripe integration** - Fields for Stripe IDs throughout (product/price IDs per tier)
- ✅ **Polymorphic relationships** - Order line items can reference multiple entity types
- ✅ **Credit tracking** - Membership/session pass credits + bonus promotional credits
- ✅ **Waiver tracking** - Account-level and per-guest waivers with guest_type distinction
- ✅ **Gift card origin** - Distinguishes purchased vs issued-as-credit cards
- ✅ **Price/SKU snapshots** - Historical orders freeze prices/SKUs at time of purchase

## Security Model

### Row Level Security (RLS)

- **Customers can:** Read and update their own data (bookings, memberships, orders, etc.)
- **Public can:** Read catalog data (sessions, products, addons, membership plans)
- **Service role:** Bypasses RLS entirely (used for backend operations)

### Auth Integration

- Customer accounts linked to Supabase Auth (`auth_user_id` → `auth.users.id`)
- Passwordless magic link login (configured in Supabase Dashboard → Authentication)
- Middleware automatically refreshes sessions

## Next Steps After Migration

1. **Verify Schema**
   ```sql
   SELECT table_name FROM information_schema.tables 
   WHERE table_schema = 'public' ORDER BY table_name;
   ```
   Should show 20 tables including new `service_types`, `service_type_price_tiers`, and `membership_credit_adjustments`.

2. **Verify Seed Data**
   ```sql
   SELECT name, booking_type, duration FROM service_types ORDER BY duration, name;
   SELECT st.name, t.min_people, t.max_people, t.price 
   FROM service_type_price_tiers t 
   JOIN service_types st ON t.service_type_id = st.id
   ORDER BY st.duration, t.min_people;
   ```
   Should show 3 service types and price tiers (confirmed + pending NULL prices).

3. **Update Pending Prices** (when HH confirms)
   ```sql
   -- Example: Set 9-adult 60min tier to £150
   UPDATE service_type_price_tiers 
   SET price = 150.00 
   WHERE service_type_id = 'a0000000-0000-0000-0000-000000000001' 
   AND min_people = 9;
   ```

4. **Configure Auth Providers**
   - Dashboard → Authentication → Providers
   - Enable Email (magic link)
   - Configure email templates

5. **Connect Retool**
   - Add Supabase as a resource using DATABASE_URL
   - Build staff dashboard views

6. **Build Sanity Schemas**
   - Create schemas for Products, Add-ons, Service Types, Membership Plans, Session Passes
   - Each needs `_id` field that will sync to `sanity_*_id` in Postgres

7. **Build Sync Webhooks**
   - See `/project info/07-write-architecture.md` for complete flow
   - Sanity publish → webhook → backend → Postgres (mirrors) + Stripe (product shell)

## TypeScript Types

To generate TypeScript types from your schema:

```bash
npx supabase gen types typescript --project-id YOUR_PROJECT_REF > web/lib/supabase/database.types.ts
```

Then import in your code:
```typescript
import { Database } from '@/lib/supabase/database.types'
```

## Questions?

Refer to:
- **Full architecture**: `/project info/` folder (00-07.md files)
- **Field split rules**: `/project info/06-sanity-supabase-field-split.md`
- **Write architecture**: `/project info/07-write-architecture.md` (Sanity/Retool/Stripe sync flows)
- **Data model**: `/project info/05-data-model.md` (all entities, business rules)
- **Booking rules**: `/project info/05-data-model.md` → Section 5.2
- **Credit systems**: `/project info/05-data-model.md` → Sections 5.3, 5.5, 5.6

## Key Differences from Original Schema

1. **New Tables**: `service_types`, `service_type_price_tiers`, `membership_credit_adjustments`
2. **Removed Fields**: Marketing content (description, images, product_info) from catalog tables
3. **Added Fields**: `sanity_*_id` links, three-tier pricing columns, mirror fields (name, thumbnail_url, category)
4. **Booking Guests**: Added `guest_type` field (account_holder / additional_guest)
5. **Gift Cards**: Removed `fulfillment_type` and shipping fields
6. **Session Passes**: Added `expiry_months` configurable field (default 12 months)
7. **Memberships**: Added `bonus_session_credits` and `bonus_addon_credits` fields
8. **Add-on Lines**: Added `price_at_purchase` and `sku_at_purchase` snapshot fields
