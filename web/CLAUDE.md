# The Paddock Wellness Club: website and Worker

Agency standards: follow the `ubs-frontend-standards` skill for every website task. This file holds the Paddock-specific facts; where it is more specific, it wins.

@AGENTS.md

## What this repo is
- `web/` is one Next.js 16 app deployed to Cloudflare Workers with OpenNext (worker name `paddock`, currently https://paddock.paddock-55d.workers.dev). It serves:
  - the **customer website** (being built; the pages under `app/` are still the starter);
  - **API routes** under `app/api/v1/*`, used by the Retool staff app, and the Stripe and Sanity webhooks. These are live. Do not change their contracts without agreeing it, because the staff app depends on them.
- `studio/` is Sanity Studio (v5). Project `qx4gqx7t`, dataset `production`. Content types: `page`, `blogPost`, `galleryImage` (website only), plus `serviceType`, `product`, `addon`, `membershipPlan`, `sessionPassType`, `giftCardType` (mirrored into Supabase).
- `supabase/` holds the migrations. Supabase project `paddock` holds bookings, customers, orders, memberships, credits and all live data.
- `project info/` holds the original scope, user flows and data model notes. What the rules should be is the Notion "Paddock Build Specification"; what they are is `web/server/rules/` and its tests.
- The staff tool is a Retool React app (`~/Documents/Code/paddock-retool-app`). It is not in this repo, and it holds screens only: the rules are here, in `web/server/rules/`.

## Commands
- `npm run dev`: local dev (run by Wayne on his Mac).
- `npx tsc --noEmit`: type check (Claude runs this).
- `npm run test:unit`: every test. One file: `npx vitest run --config vitest.unit.config.ts <file>`.
- `npm run schema:test -- --check` and `npm run check:contracts`: the two generated files are up to date (without `--check`, the first rewrites its file).
- `npm run storybook`: Storybook on port 6006.
- Deploying: pushing to `main` on GitHub (uncle-brother-son/paddock) triggers a Cloudflare build and deploy automatically. No manual `npm run deploy` needed.
- Wayne commits and pushes. Claude never commits, pushes, deploys, installs packages or deletes files without his yes.

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

## Architecture (agreed at the start; the move finished at step G, the tests' move at step H, Nov 2026)
- This Worker is the ONE backend for both the website and the Retool staff app. Every booking, pricing, credit, order, payment, refund and admin action runs here; only this Worker talks to Stripe and the database. The staff app is screens only, calling `/api/v1/staff/...` through one Retool resource ("Paddock Worker v1"); the website calls `/api/v1/customer/...` and `/api/v1/public/...`.
- `server/rules/` holds the rules and is **the source of truth for how bookings, orders, payments, refunds, memberships and the catalogue behave** (`server/rules/README.md` says what each slice decided and why). The old Retool code, its frozen copies and the golden files are gone (W61, W65).
- `app/api/` is `v1/` (each route through `defineRoute`: sign-in, permissions, input, idempotency) and two webhooks, `stripe/webhook` and `sanity/webhook` (each with its own signature check, on the Worker's own database connection; no service-role key). Nothing else: `server/api-allowlist.test.ts`.
- **Contracts** (`contracts/`, zod) are what the screens compile against: after any edit there, `npm run export:contracts` writes the staff app's `workerContracts.ts` (`npm run check:contracts` fails when it is behind).
- **Tests.** Each decision has a rule test beside its rule, on the live schema (`server/rules/testing/live-schema.sql`, generated from the live catalog, up to migration 034). The all-Worker sweep (`server/rules/testing/sweep/`) presses every scenario through the Worker as its screen does and compares it with its recording (`testing/recordings/`), with the money invariants checked on each. A recording is not a rule test: `UPDATE_RECORDINGS=1` would accept a change, so a new rule needs a test of its own. `server/staff-app-*.test.ts` read the staff app's files. No test reaches real Stripe.
- **Switches:** `ORDER_SWITCH` lists the kinds of action that are on; a kind off refuses (or, for `lapse_sweep`, pauses) and fixes go forward: there is no old code behind it.
- **Release order:** publish the staff app first when the published app still calls something the Worker removes or changes; deploy the Worker first when the staff app calls a route only the new Worker has. Each brief's report states the order and why.
- Database writes that must be all-or-nothing run in one Postgres transaction. Stripe calls are made outside transactions, always with an idempotency key (but `subscriptions.cancel`, a DELETE, which takes none), with a recorded pending state so a failure can be reconciled (every 5 minutes, `server/scheduled.ts`).
- What is left for the website build and for go-live: the W70 audit's two tables (staff app repo, `briefs/W70-audit-report.md`, point 6) and `briefs/W03-decisions.md`.

## Business rules the website must respect
These are enforced server-side in this Worker; the front end never computes them on its own. Full detail: claude.ai project doc `claude/paddock-website-backend-log.md`.
- **Ages:** every attendee is 18+. Only the account holder gives a date of birth (when attending, or buying a membership or pass). Guests give name and email only; the booker ticks "Everyone else in this booking is 18 or over" (required, checked on the server).
- **Session times:** stored as London wall-clock digits labelled UTC. Display them as stored (24-hour, e.g. 16:00); do not convert time zones. Credit and expiry checks use the London date.
- **Spaces are never held** (not in the bag, not at checkout). Everything is re-checked when checkout opens and again at Pay, before any charge.
- **Booking:** a customer can book for others (the booker need not attend); one booking per day is checked against the paying customer; party size can change in the bag and at checkout; a full session flagged in the bag stays there and is left out of checkout.
- **Members:** per-person price with "1 credit for you"; bands are Off-Peak, Core and Peak; add-on credits only for Herd members; a membership or pass bought in the same order can pay for a booking or event in that order.
- **Guest checkout:** a new email can buy anything (including a membership or pass). An email already on file can attach orders but never changes that customer's details or card; buying a membership or pass with it needs the emailed code.
- **Saved card:** one per customer; replacing it also updates every membership's renewal card.
- **Website payment methods:** card, Apple Pay and Google Pay only.
- **Payment order:** membership/pass credits, then store credit, then gift card, then card or wallet. A discount code reduces prices first (never gift cards or postage). Postage: Standard or Express, flat rate, free Standard over the threshold, UK only.
- **Customers online:** move or cancel a session booking up to 24 hours before (cancel = store credit, never a card refund online); add add-ons up to 2 hours before (no removal online); events cancel to store credit before the event's own cut-off.
- **Events:** members-only, public or members-first; Public / Pre-Herd / Herd prices; guests pay public; no session credits, no add-ons; not counted in one booking per day.

## Integrations
- **Stripe** (test mode until go-live): card entry only through Elements or Checkout. Memberships are subscriptions created by the order route (`server/rules/orders/membership.ts`).
- **Staff routes** (`/api/v1/staff/...`) use the staff auth (the shared key plus the acting staff member's email, permissions checked here). Website routes use the customer's Supabase session, never a staff key in the browser. Supabase's package is loaded for sign-in only (the anon key; four files, `server/no-service-role-key.test.ts`).
- **Sanity** → `app/api/sanity/webhook` (`../WEBHOOK-SETUP.md`): content only; a new item arrives off sale, and nothing from Sanity ever sets a price, stock or puts an item on sale.
- **Email:** Resend + React Email (templates not built yet). Marketing goes through Klaviyo after consent.
- **react-email** is a dev dependency until the email templates are built; move it back to dependencies if templates render at runtime.
- **Analytics:** GA4 (`NEXT_PUBLIC_GA_ID`) loads only after consent.

## Environment notes
- Node 22 (`.nvmrc`).
- Next's image optimiser does not run on Workers; use the Sanity CDN loader.
- `middleware.ts` refreshes the Supabase session on every request. Keep it light.
