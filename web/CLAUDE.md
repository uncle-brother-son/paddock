# The Paddock Wellness Club: website and Worker

Agency standards: follow the `ubs-frontend-standards` skill for every website task. This file holds the Paddock-specific facts; where it is more specific, it wins.

@AGENTS.md

## What this repo is
- `web/` is one Next.js 16 app deployed to Cloudflare Workers with OpenNext (worker name `paddock`, currently https://paddock.paddock-55d.workers.dev). It serves:
  - the **customer website** (being built; the pages under `app/` are still the starter);
  - **API routes** under `app/api/*`, used by the Retool staff app and by Stripe/Sanity webhooks. These are live. Do not change their contracts without agreeing it, because Retool depends on them.
- `studio/` is Sanity Studio (v5). Project `qx4gqx7t`, dataset `production`. Content types: `page`, `blogPost`, `galleryImage` (website only), plus `serviceType`, `product`, `addon`, `membershipPlan`, `sessionPassType`, `giftCardType` (mirrored into Supabase).
- `supabase/` holds the migrations. Supabase project `paddock` holds bookings, customers, orders, memberships, credits and all live data.
- `project info/` holds the original scope, user flows and data model notes. The current source of truth for business rules is the Notion "Paddock Build Specification".
- The staff tool is a Retool React app. It is not in this repo (`../retool` is an old copy). It is the source of truth for booking and payment rules.

## Commands
- `npm run dev`: local dev (run by Wayne on his Mac).
- `npx tsc --noEmit`: type check (Claude runs this).
- `npm run test:unit`: unit tests. Wayne runs them; Vitest does not run in Claude's shell.
- `npm run storybook`: Storybook on port 6006.
- `npm run deploy`: build and deploy to Cloudflare. Wayne only.
- Wayne commits and deploys. Claude never commits, pushes, deploys, installs packages or deletes files without his yes.

## Design
- **Figma file:** "Website" (UBS workspace).
  - `00 Sitemap`: page structure.
  - `01 Concepts`: Wayne's original Homepage; every page follows its styling.
  - `02 Designs`: new page designs.
  - `02 Booking flow`: the Book pop-up and checkout.
  - Never edit Wayne's existing frames.
- **Concept:** old-meets-new. Old print newspaper layout, spacing and type, with modern interactive moments. Style references: Belmond, oddritualgolf.com, malvah.co.
- **Build order:** booking and checkout flow first, then pages in sitemap order. Desktop first in Figma, then mobile.
- **Fonts:** GT typefaces from Wayne's Figma text styles, self-hosted WOFF2 via `next/font/local`. The licensed web files still need adding. Use his existing text styles; never invent new ones without asking.
- **Tokens:** to be taken from the Figma variables and text styles into `app/globals.css` `@theme` at the start of the build.

## Business rules the website must respect
These are enforced server-side, and the website must never compute them on its own.
- **Ages:** visitors and customers are 18+. Date of birth is collected for every attending guest, plus an 18+ check when booking as an attendee or buying a membership or pass.
- **Session times:** stored as London wall-clock digits labelled UTC. Display them as stored; do not convert time zones. Credit and expiry checks use the London date.
- **Booking:** pick a time, booking type and people, then Book, then add-ons, then checkout or add to bag.
  - Spaces are held only once checkout opens, not while sitting in the bag.
  - A customer can book for others; the booker need not attend.
  - One booking per day is checked against the paying customer.
  - Party size can be changed in the bag and at checkout.
  - A full session flagged in the bag stays there and is left out of checkout.
- **Members:**
  - Sessions show the price per person, with "1 credit for you" underneath.
  - The member is assumed to attend.
  - Band names are Off-Peak, Core and Peak.
  - Add-on credits are only usable by Herd members.
- **Bag:** can hold bookings, events, shop products (including gift cards), memberships and session passes. A membership or pass bought in the same bag can pay for a booking in that order.
- **Sign-in:** an email with a link and a 6-digit code (Supabase Auth).
  - Sign-in is needed to buy a membership or pass.
  - New accounts give their name only.
  - The header says "Account" when signed in.
  - Social sign-in is parked.
  - A known email at checkout gets a sign-in offer but can continue as a guest.
- **Events:** a new feature, not in the backend yet. They can be members-only, public or both, with a member-first window, per-level member pricing and an optional event waiver. Guests are allowed. Events use no session credits and no add-ons, and do not count towards the one-booking-per-day rule.
- **Payment order:** promo code, then store credit, then gift card, then card. Postage is Standard or Express at a flat rate, with a free-Standard threshold. UK only.

## Integrations
- **Stripe** (test mode until go-live): card entry only through Elements or Checkout. Memberships are subscriptions created through `app/api/memberships/create-subscription`.
- **Retool → Worker routes:** authorised with a `Bearer RETOOL_API_KEY` header. Website routes must use their own auth (Supabase session), never this key on the client.
- **Email:** Resend + React Email (templates not built yet). Marketing goes through Klaviyo after consent.
- **Analytics:** GA4 (`NEXT_PUBLIC_GA_ID`) loads only after consent.

## Environment notes
- Node 22 (`.nvmrc`).
- Next's image optimiser does not run on Workers; use the Sanity CDN loader.
- `middleware.ts` refreshes the Supabase session on every request. Keep it light.
