# 09. Write Architecture — Sanity / Retool / Postgres / Stripe

Rule for the agent: **the backend (Cloudflare Workers) is the only thing that ever writes to
Stripe.** Postgres is passive storage — it never calls Stripe itself, and nothing should call
Stripe directly from Retool or the frontend. Every write that touches both Postgres and Stripe
must go through a single backend endpoint that does both as one operation.

## Three write flows

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

### 3. Removing a catalog item — deactivate, never hard delete

**There is no "delete" action exposed to staff in Retool for any catalog entity that could ever
have been ordered against** (Product, Product Variant, Add-on, Service Type, Service Type Price
Tier, Membership Plan, Session Pass Type). The only removal action is flipping **Active to
false**.

Two reasons this is a hard rule, not a preference:
- **Historical Orders and Bookings reference these records.** Hard-deleting a row that a past
  order's line item points to either breaks that reference or leaves reporting (Retool order
  history, Metabase) unable to correctly show what was actually purchased.
- **Stripe itself won't let you hard-delete a Price that's ever been used in a transaction** —
  only archive it. Postgres and Stripe already agree that deactivation, not deletion, is the
  correct model.

Deactivating hides the item from the frontend (nothing new can be booked/purchased against it)
while every past order stays fully intact and correctly attributed. The backend endpoint for
"set Active = false" should also archive the corresponding Stripe Price(s)/Product, keeping the
two systems in agreement.

**Sanity-side deletion is handled the same way.** If a client deletes a Product/Add-on/etc.
entirely in Sanity, that delete event should trigger the backend to set Active = false on the
matching Postgres row — not attempt to delete it. Sanity's delete action becomes "deactivate
everywhere," not "remove everywhere."

**The one genuine exception:** a record created by mistake with zero order history against it —
never purchased, never referenced anywhere — can be hard-deleted directly in Retool. That's the
only case where deletion is actually safe, since there's nothing downstream to preserve.

## What's managed where — quick reference

| Entity | Managed in Sanity | Managed in Retool |
|---|---|---|
| Product | Name, description, product info, images, `productGroup`, category | Base/member/sale price, active flag, fulfillment method, shipping weight/dimensions |
| Product Variant | — (no Sanity equivalent) | SKU, price override, stock quantity |
| Add-on | Name, description, images, category | SKU, base/member/sale price, active flag |
| Service Type | Name, description, images | Duration, capacity, price (public only), active flag |
| Service Type Price Tier | — (no Sanity equivalent) | Min/max people, price per band |
| Membership Plan | Name, description, images | Price, billing frequency, sessions included, add-ons included, active flag |
| Session Pass Type | Name, description, images | Price, sessions included, `expiry_months`, active flag |

"Deleting" any row in the right-hand column always means flipping Active to false via the
backend endpoint described above — never a raw table delete.

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
