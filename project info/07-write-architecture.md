# 07. Write Architecture — Sanity / Retool / Postgres / Stripe

Rule for the agent: **the backend (Cloudflare Workers) is the only thing that ever writes to
Stripe.** Postgres is passive storage — it never calls Stripe itself, and nothing should call
Stripe directly from Retool or the frontend. Every write that touches both Postgres and Stripe
must go through a single backend endpoint that does both as one operation.

## Storefront requirement — not yet built

The customer-facing product page and checkout flow (not yet built) must check each catalog
item's `active` status from Postgres before allowing a purchase, independent of whether the
corresponding Sanity document is published. A product can be published/visible in Sanity while
`active = false` in Postgres (a deliberate staff decision, e.g. temporarily out of stock or
discontinued) — in that case, customers may see the product's content, but "Add to Cart" /
checkout must be disabled or show "currently unavailable." This applies to all catalog entities
with an active flag (Products, Add-ons, Service Types, Membership Plans, Session Pass Types),
not just Products.

This is why Retool's active toggle deliberately does not get reactivated automatically when a
Sanity document is republished — the two systems represent different things: Sanity controls
content visibility, Postgres `active` controls purchasability. As long as this storefront check
is correctly built, that separation is safe and doesn't risk customers reaching checkout on
something unpurchasable.

## In-person payments — as actually built (redesigned from the original spec)

**Hardware:** Stripe Terminal, physical reader for production; a Stripe-provided simulated
reader (`simulated: true` on `discoverReaders`, no dashboard registration needed) for
development/testing. No Tap to Pay (native or Dashboard app) — reader only.

**The original spec below described a two-step "save card, then charge the saved card" flow —
this was a real design flaw, not just an implementation detail, discovered once the reader was
actually exercised end-to-end.** It only existed because no PaymentIntent-creation endpoint was
available when the reader integration started; it forced staff to capture a card and charge it
as two separate actions even for a simple in-person sale.

**What's actually built — one tap, one action:**
- `POST /api/terminal/create-payment-intent` — `{ customerId, amount, saveCard: boolean }`.
  Creates a real Stripe PaymentIntent for the order total (`payment_method_types:
  ['card_present']`), with `setup_future_usage: 'off_session'` attached only when `saveCard` is
  true — consent for saving the card is expressed server-side via this flag, not a client-side
  SDK parameter (the Terminal SDK's `collectPaymentMethod` has no consent field at all, unlike
  the SetupIntent-only flow below).
- Frontend: one "Charge £X.XX via Reader" action — `collectPaymentMethod` → `processPayment` in
  a single step — with an **unticked-by-default** "Save this card for future charges?" checkbox
  (customer must actively opt in, staff shouldn't assume).
- `createOrder.ts` records the reader's returned `paymentIntentId` directly as proof of payment
  and never separately calls `chargeSavedCard` afterward — no double-charge risk.
- A defensive check rejects (with a clear manual-refund instruction) if the amount actually
  charged and the order's authoritative computed total have drifted apart between tap and
  submission (e.g. a stale price).
- **Real trade-off, not a bug:** the reader charges *before* the order exists in Postgres. If
  checkout then fails for an unrelated reason, the money has already moved and the order rolls
  back — staff must refund that specific PaymentIntent manually. This matches how physical POS
  terminals actually work; it isn't something a later fix removes.

**The separate SetupIntent-only flow still exists, for a different purpose.** `CollectCardDialog`
(a standalone "save a card with no immediate charge" admin tool) uses
`collectSetupIntentPaymentMethod`, which genuinely does require an explicit client-side consent
argument (`customer_consent_collected`, confirmed against the real installed SDK types — not the
newer-version object shape assumed at first draft). This flow is deliberately left untouched by
the PaymentIntent rework above — proactively saving a card with no purchase happening is a
different, valid use case from paying for an order right now.

**Card display:** the Terminal SDK doesn't reliably return expanded card details (last4/brand)
in this execution environment — a separate `GET /api/payments/method/:id` endpoint fetches them
directly from Stripe after a successful save, rather than relying on the SDK's response shape.

### 1. Sanity publish → new/updated catalog row

Trigger: Sanity webhook fires on publish (Products, Add-ons, Service Types, Membership Plans,
Session Pass Types, Gift Card Types — six catalog types as of the Gift Card Type addition).

Flow: `Sanity webhook → backend → Postgres (create/update mirrored fields) → Stripe (create
shell Product on first creation, store returned stripe_product_id back onto the row)`.

This flow only ever touches the **Sanity-owned mirror fields** (name, thumbnail, category where
applicable) — see `06-sanity-supabase-field-split.md` for which fields are mirrored per entity.
It must never touch price.

**On republish (not just first creation):** the webhook must also push the corrected
name/image to the existing Stripe Product via `stripe.products.update()` — the original
implementation only set Stripe's name/image once, at creation, leaving them permanently stale on
any later rename or image change. Fixed across all six handlers.

**Adding a seventh (or any future) catalog type requires updating two separate places, not
one.** The webhook's own `switch (_type)` code is necessary but not sufficient — Sanity's
webhook configuration has its own hardcoded Filter field (a GROQ query, set in Sanity's
dashboard, entirely separate from the webhook's code) listing which `_type` values it forwards
at all. Missing the Filter update means Sanity never calls the webhook for the new type — the
handler code can be perfectly correct and still never execute, with no error anywhere to signal
why. This cost significant debugging time on the Gift Card Type rollout specifically because
every code-level and infrastructure-level check (URL, project, deployment, swallowed errors,
live runtime logs) came back clean — the fault was sitting in a completely different tool.

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
| Product | Name, description, product info, images, `productGroup`, category | Base/member/sale price, active flag, fulfillment method |
| Product Variant | — (no Sanity equivalent) | SKU, stock quantity (via Stock Adjustment ledger, never a raw edit) |
| Add-on | Name, description, images, category | SKU, base/member/sale price, active flag |
| Service Type | Name, description, images | Duration, capacity, booking type (public/private), price (public only), active flag |
| Service Type Price Tier | — (no Sanity equivalent) | Min/max people, price per band |
| Service Type Schedule Slot | — (no Sanity equivalent) | Day of week, start time — replaces the retired `business_hours` generation input |
| Membership Plan | Name, description, images | Price, billing frequency, sessions included, add-ons included, active flag |
| Session Pass Type | Name, description, images | Price, sessions included, `expiry_months`, active flag |
| Gift Card Type | Name, description, images | Active flag, `custom_amount_enabled`/min/max |
| Gift Card Preset | — (no Sanity equivalent) | Amount, active flag |

"Deleting" any row in the right-hand column always means flipping Active to false via the
backend endpoint described above — never a raw table delete. Price override (Product Variant)
and shipping weight/dimensions (Product) have both been removed from the model entirely — see
`05-data-model.md` for why.

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

## Atomicity applies beyond Postgres + Stripe too

The "must succeed or fail together, never partially" rule isn't only about Postgres-vs-Stripe.
It applies to **any multi-statement write where one statement records a result and another
records the reason/audit trail for that result.** If those are two independent writes, one can
succeed while the other fails, leaving the system in a state that's internally inconsistent —
same failure mode as a Postgres/Stripe mismatch, just contained entirely within Postgres.

**Known instance of this bug:** membership credit adjustments (see 05-data-model.md → 5.5
Memberships → ad-hoc credit adjustments). Adjusting a membership's credit balance and inserting
the corresponding row into `membership_credit_adjustments` (staff ID, amount, reason, date) are
currently two separate writes run with `Promise.all`. If the balance update succeeds but the
audit insert fails (or vice versa), the balance and the audit trail disagree — there's a record
of credits changing with no explanation, or an explanation with no matching balance change. Both
writes must be wrapped in a **single database transaction**, rolling back together on either
failure — not run as independent parallel operations.

**This pattern generalizes** — any future feature that pairs a state change with an audit/log
entry (for example: booking cancellation + refund-method record, gift card issuance + origin
tracking) should be checked for the same risk and wrapped in a transaction rather than assumed
safe because it doesn't involve Stripe.

Any Retool action that touches a Postgres-owned field with a Stripe counterpart (price, and any
future field with the same shape) must call the backend API, never write to the Supabase table
directly. Fields that are Sanity-owned mirrors (name, thumbnail, category) are never edited in
Retool at all — Retool should treat them as read-only, since they're always overwritten by the
next Sanity publish regardless of what's typed over them.
