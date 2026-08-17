# 09. Write Architecture — Sanity / Retool / Postgres / Stripe

Rule for the agent: **the backend (Cloudflare Workers) is the only thing that ever writes to
Stripe.** Postgres is passive storage — it never calls Stripe itself, and nothing should call
Stripe directly from Retool or the frontend. Every write that touches both Postgres and Stripe
must go through a single backend endpoint that does both as one operation.

## Two write flows

### 1. Sanity publish → new/updated catalog row

Trigger: Sanity webhook fires on publish (Products, Add-ons, Session/Service Types, Membership
Plans, Session Passes).

Flow: `Sanity webhook → backend → Postgres (create/update mirrored fields) → Stripe (create
shell Product on first creation, store returned stripe_product_id back onto the row)`.

This flow only ever touches the **Sanity-owned mirror fields** (name, thumbnail, category where
applicable) — see `08-sanity-supabase-field-split.md` for which fields are mirrored per entity.
It must never touch price.

### 2. Staff action in Retool → price/stock change, or new Variant creation

Trigger: staff edits price (or another Postgres-owned operational field with a Stripe
counterpart) in Retool — **or creates a new Product Variant** (e.g. adding a "Large" size),
which needs a Stripe Price created for the first time, not just updated.

**Retool must call a backend API endpoint for both cases — it must never write the price
column, or insert a new Variant row, directly against Postgres.** The endpoint does, as one
operation:
1. Create a new Stripe Price object (Stripe Prices are immutable — a "price change" always
   means pointing the product at a new Price, never editing an existing one; a new Variant
   always means creating its Price for the first time)
2. Write the new/updated price value **and** the `stripe_price_id` into Postgres together

If the Stripe call fails, the Postgres write must not happen — the two must succeed or fail
together, never partially.

**Resolved:** Products and Add-ons have three price tiers — base, sale, member — each backed by
its own real Stripe Price object under the same Stripe Product (not one Price plus coupons for
the tiers themselves). Which tier applies is a strict priority order, decided by checkout logic
at time of purchase, not stored as a single "the" price:
1. Customer is a member → **always member price**, regardless of whether a sale is active
2. Not a member, sale currently active → **sale price**
3. Neither → **base price**

Promo/discount codes are a separate, orthogonal layer on top of this — Stripe's native Coupon /
Promotion Code feature, applied against whichever tier Price was selected. They are not a
fourth tier and don't compete with base/sale/member in the priority order above.

Practical effect on the write flow: a Retool "set sale price" or "set member price" action
creates a **new Stripe Price for that specific tier** (each tier's Price is independently
immutable/replaceable, same rule as before) and writes its ID into the matching Postgres field
(`stripe_price_id_base`, `stripe_price_id_sale`, `stripe_price_id_member`) — not a single shared
`stripe_price_id`.

## Why not write straight from Retool to Postgres and let something else notice

Two options were considered and rejected for this specific case:

- **Retool writes directly to the Postgres price column, nothing else reacts to it.** Rejected —
  Postgres and Stripe would silently drift out of sync (database says one price, Stripe still
  has the old one), with no mechanism forcing them back into agreement.
- **A Supabase database trigger / Edge Function reacts to the Postgres row change and calls
  Stripe automatically.** A legitimate pattern in general, but rejected here — error handling is
  much harder to reason about (if Stripe's API is down when the trigger fires, the price change
  can silently fail to reach Stripe with no clear signal back to the staff member who made the
  change). An explicit backend endpoint can return a clear success/failure Retool can surface
  directly to the user.

## Practical rule for building Retool screens

Any Retool action that touches a Postgres-owned field with a Stripe counterpart (price, and any
future field with the same shape) must call the backend API, never write to the Supabase table
directly. Fields that are Sanity-owned mirrors (name, thumbnail, category) are never edited in
Retool at all — Retool should treat them as read-only, since they're always overwritten by the
next Sanity publish regardless of what's typed over them.
