# 2. Scope

## In scope

- Custom React frontend (content pages, product pages, booking flow, cart, checkout handoff,
  account area)
- Sanity CMS setup (retreat info, pages, blog, imagery)
- Custom booking engine (see 05-data-model.md → Bookings)
- Stripe integration: one-off payments, subscriptions, saved cards, Checkout
- Membership, session pass, and gift card purchase flows
- Merchandise catalog and checkout (unified cart with bookings/add-ons)
- Customer accounts (auth, booking history, membership/gift card balance)
- Staff dashboard (Retool) for booking management and add-on prep
- Reporting dashboard (Metabase — TBC)
- Transactional email templates (Resend + React Email)
- Marketing email platform setup (Klaviyo) — data connection only (syncing customer/order/
  booking events into Klaviyo), not campaign/automation build
- Staff-facing Google Calendar sync (one-way, for visibility only)

> ⚠️ Not yet reflected here but confirmed elsewhere in the spec (see 00-README.md, flag #5):
> Info pages (Terms & Conditions, Privacy Policy, Cookie Management) and Global elements
> (cookie banner, newsletter pop-up/footer) — both listed under 6.1 Content & Structure.
> Recommend adding explicitly to this list.

## Out of scope

- Native mobile app
- Marketing campaign content/copywriting (unless separately scoped)
- Multi-location support beyond the current single site

## Resolved: Loyalty / rewards program

A loyalty/rewards points program exists on the client's current live site ("My Rewards" / "View
points" in main nav). **Confirmed out of scope** — HH: "No need for loyalty section."
