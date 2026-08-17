# 5. Data Model

Granular field-level breakdown of every entity in the system. This is the definitive,
sign-off-able list of everything that needs to be built.

---

## 5.1 Accounts / Customers

### Fields to store

- Customer ID
- First name, last name
- Email
- Phone number
- Auth provider user reference (Supabase user ID)
- Stripe customer ID
- Saved payment method reference
- Date created
- Marketing consent status (for Klaviyo sync)
- Default / shipping address (for merchandise orders)
- Waiver accepted (yes/no)
- Waiver version
- Waiver accepted at (timestamp)
- Date of birth (required at signup — used to enforce the 18+ minimum age)
- Birthday marketing consent (yes/no) — separate from general marketing consent; specifically
  covers using DOB to send a birthday offer/code

### Resolved decisions

- **Health/liability waiver: required, one-time at signup.** HH: "Yes please - can be one time
  when they sign up." For group bookings, see the **Booking Guest** entity under 5.2 Bookings —
  covers waiver completion for guests beyond the account holder.
- **Minimum age: 18, DOB required at signup.**
- **Birthday marketing (using DOB to send a birthday credit/code):** flagged by HH as needing
  data protection confirmation. Recommend a dedicated opt-in checkbox, separate from general
  marketing consent, before this feature is built — worth confirming with HH's data protection
  advisor rather than assuming it's covered by general marketing consent.
- **Login method:** magic link (passwordless email login) via Supabase Auth — no password
  storage/reset flow needed.

---

## 5.2 Bookings

Bookings are modelled as **three related entities** — a reusable Service Type (Public Session,
Private Session 60min, Private Session 120min), a shared time slot generated from that Service
Type (Session), and each individual customer's reservation into it (Booking). This is necessary
because multiple unrelated customers can each book into the same public session, and capacity
(max 6) is a property of the slot as a whole, not of any single customer's booking.

### Service Type (catalog — see 08-sanity-supabase-field-split.md for the full Sanity/Postgres
split)

- Service Type ID
- `sanity_service_type_id`
- Name (Sanity + Postgres mirror)
- `thumbnail_url` (Sanity + Postgres mirror)
- Description, images (Sanity only)
- Duration (minutes): 60 / 120
- Capacity: 6 — for public, this is the real attendee cap; for private, this is a **blocking
  value only** (see Core booking rules, below) — a private Session always sets total booked to
  6 regardless of actual attendee count, purely to prevent any other booking landing on that
  slot. Actual private attendee count (1–10) is tracked via Booking Guest, not this field.
- Booking type: public / private
- **Price** — for **public** sessions only: a flat per-person rate (charged × party size). For
  **private** sessions, this field is unused — price comes from Service Type Price Tier instead
  (see below), since private pricing is banded by total headcount, not flat or per-person.
- Active flag
- Stripe product ID, Stripe price ID (public sessions only — private sessions have per-tier
  Stripe Price IDs instead, see below)

Every generated Session references a Service Type ID rather than duplicating its price/duration
onto every row.

### Service Type Price Tier (private sessions only)

Private session pricing is banded by total headcount, not flat or per-person — e.g. 1–6 adults
is one flat total price, then price steps up per additional adult up to 10. Each duration
(60 min, 120 min) has its own independent tier table, since prices differ by duration.

- Tier ID (auto-generated)
- Service Type ID (FK — links to a specific private Service Type, e.g. "Private Session 60 min")
- Min people, max people (the headcount band this tier covers)
- Price — a flat total for the whole booking at this band, not per-person
- Stripe price ID — each tier is its own distinct Stripe Price

**Confirmed data to seed (60 min, per screenshot):**

| Band | Price |
|---|---|
| 1–6 adults | £105 |
| 7 adults | £120 |
| 8 adults | £140 |
| 9 adults | *(not visible in screenshot — needs confirming)* |
| 10 adults | £170 |

**120 min:** only the 1–6 band is confirmed so far, at £210 (this is very likely the 120-min
equivalent of the 60-min £105 1–6 tier, resolving the earlier ambiguity about what £210 referred
to) — the 7/8/9/10 adult tiers for 120 min still need confirming, same shape as the 60-min table
above.

### Session (the shared time slot)

- Session ID
- Resource ID (the sauna — future-proofed even though there's currently only one)
- Service Type ID (references the catalog entity above)
- Start time, end time
- Type: public / private — set dynamically by whichever booking claims the slot first
- Capacity: inherited from Service Type (6 for public; blocking value of 6 for private — see
  Service Type, above)
- Total booked (derived — sum of party sizes across all Bookings attached to this Session, with
  the private-booking exception noted in Core booking rules, below)
- Status: open / blocked — staff-controlled, independent of Type
- Blocked reason (if Status = blocked)
- Blocked by (staff ID, if Status = blocked)

### Booking (one customer's reservation into a Session)

The same Booking entity covers both public and private reservations — no separate "private
booking" entity. Whether a Session is public or private lives entirely on the Session's `Type`
field.

- Booking ID
- Session ID
- Customer ID
- Party size (how many people this customer is booking for)
- Status: pending / confirmed / cancelled / completed / no-show
- Price paid
- Stripe payment/session reference
- Redemption source: paid directly / membership credit / session pass credit / gift card
- Linked add-on order items
- Created at
- Cancelled/rescheduled at (if applicable)
- Checked-in at (timestamp, set by staff when the customer arrives — null if not yet checked in)

### Scheduling rules & business hours

- Booking window: customers can book up to 12 months in advance
- Operating days: open every day except Wednesday
- Daily hours: vary by day of week — requires a per-day-of-week open/close configuration
- Session length: 60 minutes
- Buffer between sessions: 15 minutes
- Private 120-minute booking = 2× 60-minute Sessions + the 15-min buffer between them
  (135 minutes of wall-clock time reserved, in reality)

> ⚠️ See 00-README.md flag #1 — private pricing has since been updated to 60 min / 120 min
> from £210 (per 6.1 Content & Structure). This isn't yet reflected in the rule above; the
> mechanic (2 consecutive Sessions) still holds, only the price point needs updating.

**Open:** exact opening/closing time for each operating day, and minimum booking notice period
(e.g. can someone book 10 minutes before a session starts, or is there a cut-off?).

### Core booking rules

- Slots (Sessions) generated from configured business hours
- **Public booking:** adds this Booking's party size to the Session's total booked, up to a cap
  of 6; rejected if it would exceed the cap
- **Private booking:** offered in two durations — single slot (1 hour) or double slot (2 hours).
  Only allowed if the required Session(s) currently have zero Bookings against them; once
  placed, blocks all further bookings (public or private) for the Session(s) it occupies. A
  double-slot booking claims two consecutive Sessions atomically.
  - **A private booking sets the Session's total booked directly to 6 (the blocking value),
    regardless of actual attendee count** — this is not a real headcount, purely a mechanism to
    make the slot read as full so no public booking can land on it. Actual attendee count
    (minimum 1, maximum 10, including the account holder by default) is tracked separately via
    Booking Guest, below.
- No pre-designated public/private Sessions — a Session's type is determined dynamically by
  whichever booking type is placed first
- Stripe webhook (`checkout.session.completed`) confirms the Booking and logs any add-on order

**Worked example:** Sarah books 2 people into the 2pm session → Session total booked = 2/6. Tom
later books 3 people into the same 2pm session → total = 5/6. A further booking of 2 people is
rejected (5 + 2 > 6). If instead someone had tried to book the 2pm slot privately before Sarah's
booking, that would have worked and blocked Sarah's public booking entirely — but once Sarah's
booking exists, private is no longer available for that slot.

### Blocking slots or days

Staff need the ability to block out an individual Session or an entire day — e.g. for
maintenance, cleaning, or a private event — without it being a customer booking.

- Managed in Retool, writing Status = blocked (plus reason and staff ID) to the affected
  Session(s)
- Block a single slot: mark one existing Session as blocked
- Block a whole day: bulk-mark every Session on that date as blocked in one action
- Blocked Sessions are excluded from availability on the frontend regardless of Type
- If a Session already has confirmed Bookings against it, blocking should warn staff rather than
  silently override existing customer bookings

### Cancellation & refund policy

- Cancellation ≥24 hours before session start: eligible for a refund
- Cancellation <24 hours before session start: not eligible for a refund

**If paid by card or gift card:**
- Valid cancellation (≥24hrs): staff choose — refund to original card (card payments only, via
  Stripe), or issue store credit (a system-generated gift card, see 5.7 Gift Cards, Origin:
  issued as cancellation credit) for the value paid
- A gift card payment becomes a new credit, not a restoration to the original gift card balance
- Invalid cancellation (<24hrs): no refund, no credit — payment forfeited

**If paid using membership credit or session pass credit:**
- Valid cancellation (≥24hrs): the session credit is returned to the membership's or pass's
  remaining balance
- Invalid cancellation (<24hrs): the credit is not returned — treated as used

Cancelling a booking (in any case) releases its Session capacity back into availability
immediately.

### Booking Guest (waiver tracking + attendee list for group and private bookings)

Covers the full attendee list for a booking — minimum 1, maximum 10 people — and waiver
completion tracking for each. Relevant for public bookings with party size >1 and every private
booking.

- Guest ID
- Booking ID
- **Guest type: account holder / additional guest** — the account holder's own record is
  auto-created by default when the booking is placed (pre-filled from their Customer record,
  waiver status inherited from their account-level waiver), but can be removed or reassigned if
  they aren't actually attending (e.g. booking on someone else's behalf). Additional guests are
  added manually by the booker, up to 9 more (10 total).
- Guest name
- Guest email (optional — needed only for the pre-arrival email route)
- Waiver accepted: yes/no
- Waiver accepted at (timestamp)
- Waiver version
- Method: pre-arrival email link (single-use signed link, no account creation required) /
  signed in person at check-in
- Reminder sent at (if invited but not yet completed)

**How it flows:** a Booking Guest record for the account holder is created automatically at
time of booking. The booker can then add up to 9 more guest names/emails (minimum total: 1,
maximum: 10). Each guest with an email gets a single-use waiver link to complete in advance. At
check-in, staff see a live completion count (e.g. "3 of 5 guests signed"); anyone who hasn't
completed it in advance signs in person at check-in — a standard, fully supported path, not an
exception.

### Remaining spaces (frontend display)

`Remaining spaces = capacity (6) − total booked`. A Booking must count toward total booked as
soon as it's created in **pending** status (slot held, checkout in progress), not only once
confirmed — otherwise two customers could both see spaces available while both are mid-checkout.

Pending bookings that are never paid **auto-expire after 10 minutes** and release their party
size back into the count.

---

## 5.3 Add-ons

Add-ons (e.g. towels, smoothies) are a **separate system from Products/Merchandise** — no
shared catalog, no shared admin view, and no stock/inventory tracking.

### Add-on (catalog item)

- Add-on ID
- `sanity_addon_id`
- Name (Sanity + Postgres mirror)
- `thumbnail_url` (Sanity + Postgres mirror, resized from image[0])
- Description — includes ingredients list/composition where relevant (HH: yes) — Sanity only
- Images — no fixed limit — Sanity only
- Category — Sanity + Postgres mirror *(superseded HH's earlier "only add member price to
  product merchandise" note on pricing — see below; category confirmed kept)*
- SKU — Postgres only, sits directly on this record since Add-ons have no Variant layer
  beneath them (unlike Product, where SKU lives on the Variant)
- **Base price, member price, sale price** — Postgres only, same three-tier model as Products
  (see 09-write-architecture.md for the selection priority and Stripe Price-per-tier design)
- Active/inactive flag — Postgres only
- Stripe product ID reference — Postgres only

### Add-on order line (per booking)

- Linked booking ID
- Add-on ID
- Quantity
- **Price at time of purchase** — a frozen snapshot of whichever price tier applied, not a live
  reference to the current Add-on price (prices can change after the fact; historical orders
  must show what was actually paid)
- **SKU** — also a frozen snapshot, same reasoning as price
- Stripe price ID reference
- Redemption source: paid directly / membership credit

### Membership add-on credit allowance (see also 5.5 Memberships)

- **Shared pool**, not per-add-on-type limits (e.g. "4 free add-ons a month" redeemable against
  any mix). HH: "yes please - would be a great option"
- **1 credit per item, flat**, regardless of price — current add-ons (towel hire, smoothies) are
  both ~£5, so this works today. **Flagged for future scope:** if higher-value add-ons are added
  later, may need weighted credit costs — not required now, but the model should be able to
  accommodate this later without a full rebuild.
- **Credits reset to zero if unused** — no rollover.
- **New requirement:** staff need the ability to add **ad-hoc bonus credits** to a membership
  (e.g. a "bring a guest" credit during quiet/summer periods as a promotion). This isn't yet
  reflected as a distinct field — recommend adding an `Ad-hoc credit adjustments` sub-entity
  (adjustment ID, membership ID, credit type, amount, reason, staff ID, date) rather than
  overloading the standard cycle-credit fields, so promotional credits are auditable separately
  from the normal monthly allowance.

---

## 5.4 Products / Merchandise

Standalone retail catalog (t-shirts, hoodies, etc.) — kept entirely separate from Add-ons, with
full stock/variant tracking since these are physical, shippable goods.

### Product

- Product ID
- `sanity_product_id`
- Name (Sanity + Postgres mirror)
- `thumbnail_url` (Sanity + Postgres mirror, resized from image[0])
- Description — Sanity only
- Product info — composition/made-in/etc. (HH: yes) — Sanity only
- Images — no fixed limit — Sanity only
- `productGroup` — links colour variants of the same product together for frontend display
  only (e.g. "also available in black" on the white tee's page); colour variants are separate
  Products, not a Variant attribute — Sanity only
- Base price, member price, **sale price** — three independently priced tiers, each with its
  own Stripe Price ID (see 09-write-architecture.md for the selection priority: member always
  wins over sale; sale applies over base when active; promo codes apply on top of whichever
  tier was selected) — Postgres only
- Category/type (Sanity + Postgres mirror)
- Active/inactive flag — Postgres only
- Shipping weight/dimensions (for shipping rate calculation) — Postgres only
- Fulfillment method: shipping / pickup only / both — Postgres only
- Stripe product ID — Postgres only
- Stripe price IDs: `stripe_price_id_base`, `stripe_price_id_sale`, `stripe_price_id_member` —
  Postgres only, one per tier, not a single shared field
- No SKU on the Product record — SKU lives on the Variant (see below), since a bare Product
  isn't directly sellable

### Product variant

Every Product has at least one Variant, even where there's no visible size choice (e.g. a tote
bag gets a single "default" Variant), so SKU/stock/price always come from one consistent place.

- Variant ID, linked product ID
- Size *(colour removed — handled via `productGroup` on the Product, not as a Variant
  attribute)*
- SKU
- Price override (if different from base price)
- Stock quantity
- Stripe price ID reference

---

## 5.5 Memberships

Monthly recurring subscription: pay £X, receive X redeemable sessions (and optionally X free
add-ons) per billing cycle.

### Membership plan (catalog)

- Plan ID
- `sanity_plan_id`
- Name (Sanity + Postgres mirror)
- `thumbnail_url` (Sanity + Postgres mirror, resized from image[0])
- Description/benefits copy — Sanity only
- Images — Sanity only
- Price — Postgres only
- Billing frequency — Postgres only
- Sessions included per billing cycle — Postgres only
- Add-ons included per billing cycle (free add-on allowance — see 5.3 Add-ons for the credit
  design) — Postgres only
- Active/inactive flag — Postgres only
- Stripe product ID, Stripe price ID — Postgres only

No category — only 3 fixed tiers, not enough to warrant grouping.

### Customer membership instance

- Customer ID, plan ID
- Stripe subscription ID
- Subscription status: active / paused / cancelled
- Start date
- Next renewal date
- Session credits remaining this cycle
- Add-on credits remaining this cycle
- Credits reset date (shared reset point for both session and add-on credits)

### Resolved decisions (see also 5.3 Add-ons for full add-on credit design)

- Add-on allowance: shared pool, 1 credit per item flat, resets to zero if unused
- **New:** ad-hoc bonus credits — staff need to add promotional credits (e.g. "bring a guest")
  outside the normal cycle allowance. See 5.3 Add-ons for suggested modelling approach.
- Memberships remain **personal use only** (not shareable) — HH confirmed this messaging/logic
  carries over to the new site.

---

## 5.6 Session Passes

One-off purchase of a bundle of sessions (e.g. a 10-pack), redeemable over time.

### Pass type (catalog)

- Pass type ID
- `sanity_pass_type_id`
- Name (Sanity + Postgres mirror)
- `thumbnail_url` (Sanity + Postgres mirror, resized from image[0])
- Description/benefits copy — Sanity only
- Images — Sanity only
- Price — Postgres only
- Sessions included — Postgres only
- **`expiry_months`** — Postgres only, staff-configurable in Retool (how many months after
  purchase a pass's unused sessions expire). Not hardcoded — HH's confirmed answer is still
  pending (see 00-README.md); making this a configurable field means whatever the real answer
  turns out to be, it's a value staff set rather than a code change.
- Active/inactive flag — Postgres only
- Stripe product ID, Stripe price ID — Postgres only

No category — small, fixed set of pass sizes, not enough to warrant grouping.

### Customer pass instance

- Customer ID, pass type ID
- Purchase date
- Sessions remaining
- Expiry date *(re-confirmed with HH directly that their earlier answer didn't apply to session
  passes — awaiting the correct answer for session pass expiry specifically)*

---

## 5.7 Gift Cards

Gift cards can be monetary value or session-based, and can be sent by the purchaser to someone
else. A single representative image for the Gift Cards page — no design picker, no per-card
artwork choice — is ordinary Sanity page content, unrelated to the fields below; it isn't
attached to individual issued Gift Card records at all.

### Fields to store

- Gift card ID
- Unique redemption code
- Type: monetary / session-based
- Original value, remaining balance
- Purchaser customer ID
- Recipient name, recipient email
- Gift message (optional, free text)
- Fulfillment type: digital / **pickup in person** (see note below — not postal)
- Issue date
- Expiry date
- Redemption status and history (which orders/bookings it's been applied to)
- **`Origin`: customer purchase / issued as cancellation credit** — required by the Bookings
  cancellation policy (5.2) but not yet formally listed on this page in Notion. Included here
  as it's a confirmed dependency — recommend adding it to the Notion page directly.

### Resolved decisions

- **Monetary gift cards expire after 12 months** (extended from the current site's 6 months).
- **Fulfillment: manual, two options — send as digital e-card, or buy & pick up in person.** No
  postal/shipping fulfillment. This **removes the need for shipping address/shipping status
  fields** on the gift card record that were originally scoped assuming postal delivery — see
  00-README.md flag #2.

---

## 5.8 Orders / Checkout

The unified order record covering any combination of bookings, add-ons, products, membership
signups, and gift card purchases in a single checkout.

### Fields to store

- Order ID
- Customer ID
- Line items: a list referencing bookings, add-ons, products, membership signups, and/or gift
  card purchases (polymorphic — each line item references its source record type and ID)
- Order total
- Payment status
- Stripe checkout session / payment intent ID
- Discount/promo code applied (if any)
- Shipping address (if physical items included)
- Shipping status/tracking (if physical items included)
- Order source: online checkout / staff-created (walk-in upsell)
- Created at

---

## 5.9 Staff / Admin Users

### Fields to store

- Staff ID
- Name
- Email
- Role/permission level (relevant for Retool access control — e.g. who can issue refunds,
  charge saved cards, or view reporting)
