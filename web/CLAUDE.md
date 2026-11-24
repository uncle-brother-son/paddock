# The Paddock Wellness Club: website and Worker

Follow `docs/build-standards.md` for every website task (accessibility, SEO, metadata, AI tools, video, motion, performance); the routes are in `docs/url-map.md`. This file holds the Paddock-specific facts; where it is more specific, it wins.

**Hard rule (Wayne, WQ8): the Figma designs are the source of truth for how everything looks. Build nothing that changes a design; if a standard seems to need a visual change, stop and list it for the lead.**

@AGENTS.md

## What this repo is
- `web/` is one Next.js 16 app deployed to Cloudflare Workers with OpenNext (worker name `paddock`, currently https://paddock.paddock-55d.workers.dev). It serves:
  - the **customer website** (being built; the pages under `app/` are still the starter);
  - **API routes** under `app/api/v1/*`, used by the Retool staff app, and the Stripe and Sanity webhooks. These are live. Do not change their contracts without agreeing it, because the staff app depends on them.
- `studio/` is Sanity Studio (v5). Project `qx4gqx7t`, dataset `production`. Content types: `contentPage`, `infoPage`, `blogPost`, `productFamily`, `sizeGuide` and the single documents `siteSettings`, `navigation`, `shopSettings`, `eventsSettings` (website only), plus `serviceType`, `product`, `addon`, `membershipPlan`, `sessionPassType`, `giftCardType`, `event`, `productCategory` (mirrored into Supabase). Shared blocks: `picture`, `media`, `richText`, `seo`, `linkTo` (`studio/schemaTypes/objects/`). A product's, an event's and the gift card's pictures are galleries of `media` (an image or an MP4); the staff app's picture is the gallery's first image. The site reads them through `lib/sanity/read.ts` only. Words a page can't have as its address: `lib/routes/reserved-slugs.ts`, the one list both sides read. A document with a slug keeps its old ones (`previousSlugs`, added by the Studio's Publish action); a page that finds nothing at a slug asks `lib/sanity/redirects.ts` where it went.
- `supabase/` holds the migrations. Supabase project `paddock` holds bookings, customers, orders, memberships, credits and all live data.
- `project info/` holds the original scope, user flows and data model notes. What the rules should be is the Notion "Paddock Build Specification"; what they are is `web/server/rules/` and its tests.
- The staff tool is a Retool React app (`~/Documents/Code/paddock-retool-app`). It is not in this repo, and it holds screens only: the rules are here, in `web/server/rules/`.

## Commands
- `npm run dev`: local dev (run by Wayne on his Mac).
- `npx tsc --noEmit`: type check (Claude runs this).
- `npm run test:unit`: every test. One file: `npx vitest run --config vitest.unit.config.ts <file>`.
- `npm run check:fast`: what a website change needs (see "Test levels").
- `npm run schema:test -- --check` and `npm run check:contracts`: the two generated files are up to date (without `--check`, the first rewrites its file).
- `npm run storybook`: Storybook on port 6006. `npx vitest run --config vitest.config.ts`: every story, with the accessibility check (it needs Playwright's browser: `npx playwright install chromium`, with Wayne's yes).
- Deploying: pushing to `main` on GitHub (uncle-brother-son/paddock) triggers a Cloudflare build and deploy automatically. No manual `npm run deploy` needed.
- Wayne commits and pushes. Claude never commits, pushes, deploys, installs packages or deletes files without his yes.

## Test levels (WQ29)
`npm run check:fast` reads the changed files (against `origin/main`, committed or not), prints the level and runs that level's checks.
- **Level 1, money and backend:** anything in `web/server/`, `web/contracts/`, `web/app/api/`, `supabase/`, `custom-worker.ts`, `wrangler.jsonc`; a package change; a website file that uses Stripe or server code; a Studio field the Worker's Sanity webhook reads (`WEBHOOK_FIELDS` in `scripts/check-fast-level.mjs`). The full process: the full Worker run once, planted bugs, an independent review, a full report. `check:fast` runs nothing: it names the files and exits 2.
- **Level 2, website and Sanity:** lint and `tsc`, the changed `*.test.ts` files, and only the changed components' Storybook tests (accessibility included). No full Worker run, no OpenNext build, no planted bugs, no screenshots unless asked. Wayne's look in Storybook or on the preview is the check. Half-page report.
- **Level 3, a small visual fix:** no brief; Wayne says it directly. Edit, lint, that component's story test (`check:fast` runs the same as Level 2).

## Design
- **Figma file:** "Website" (UBS workspace).
  - `00 Sitemap`: page structure.
  - `01 Concepts`: Wayne's original Homepage; every page follows its styling.
  - `02 Designs`: new page designs.
  - `02 Booking flow`: the Book pop-up and checkout.
  - Never edit Wayne's existing frames.
- **Concept:** old-meets-new. Old print newspaper layout, spacing and type, with modern interactive moments. Style references: Belmond, oddritualgolf.com, malvah.co.
- **Build order (WQ5):** the frame first (W71 foundations: tokens, grid, fonts, motion, Storybook; W72 the Sanity schema for the frame and products; W73 header, footer, menu, hero, intro, page transitions), then products (the list and the product page, signed off first as the pattern), then the other purchasable pages (events, memberships, passes, gift cards), then buying all at once (bag, sign-in, checkout, payment, confirmation, account, emails), then end-to-end testing. Sign-off: Storybook for design, the preview for flows and motion, a full review for money. Desktop first in Figma, then mobile.
- **Fonts:** GT Sectra Fine (Figma "Primary", 400) and GT America Standard (Figma "Secondary", 400 and 500), the licensed woff2 files in `app/fonts`, loaded in `app/fonts.ts` with `next/font/local` as `--font-primary` and `--font-secondary`. Use Wayne's existing text styles; never invent new ones without asking.
- **Tokens:** `app/globals.css` holds the Figma variables and text styles; `lib/design/figma-tokens.json` is the lead's read of the Figma file, and `lib/design/tokens.test.ts` fails when the two differ. Tailwind's own colour, type, spacing and radius scales are switched off, so only these exist:
  - colours: the theme colours (`bg-surface-primary`, `text-text-muted-primary`, `text-text-error`), set per mode by `data-theme` (`light` on `<html>`; `dark`, `fjord` or `mud` on a section; Fjord and Mud never for forms or error messages). The palette (`bg-sand-light`, `bg-black-65`) is there too;
  - text: one class per Figma text style (`text-hero-caps`, `text-h1` ... `text-label-10`);
  - spacing: Figma's scale, named by its pixel value (`p-16` is 16px, `gap-8` is 8px); corners `rounded-s` and `rounded-m`;
  - the grid: `<Grid>` (`components/layout/Grid.tsx`), 6 columns below 768px and 24 from 768px, with `col-span-*` / `md:col-span-*` inside it.
  - trim: every text style but H3 is trimmed to its capitals (`text-box`), so the space between two blocks of text is always a gap or padding from the spacing scale, never the line height. Put a text style on the element that holds the text; a trimmed one-line link or button needs padding for its tap area and focus ring;
  - the grid overlay: Ctrl + G (or `?grid=1`, off with `?grid=0`) draws the grid on any test copy, never on the live domain.
  Storybook's Foundations pages (`components/foundations/`) show them all, in each mode.
- **Motion (WQ20-WQ23):** one curve and two durations for every animation, from one source: `lib/motion/tokens.ts` for Motion (`EASE_SMOOTH`, `DURATION_SHORT` for hovers and panels, `DURATION_LONG` for page transitions and the intro) and the same in CSS (`--ease-smooth`, `--duration-short`, `--duration-long`; the classes `ease-smooth`, `duration-short`, `duration-long`). Never type in a curve, an ease keyword, a spring or a duration: `lib/motion/typed-in-motion.test.ts` fails on one. Lenis (smooth scroll, off with reduced motion) and Motion's defaults are set once in `components/providers/MotionProviders.tsx`; a panel that scrolls by itself carries `data-lenis-prevent`. Use the installed `lenis` and `framer-motion`; GSAP or any other package only with Wayne's yes.

## Architecture (agreed at the start; the move finished at step G, the tests' move at step H, Nov 2026)
- This Worker is the ONE backend for both the website and the Retool staff app. Every booking, pricing, credit, order, payment, refund and admin action runs here; only this Worker talks to Stripe and the database. The staff app is screens only, calling `/api/v1/staff/...` through one Retool resource ("Paddock Worker v1"); the website calls `/api/v1/customer/...` and `/api/v1/public/...`.
- `server/rules/` holds the rules and is **the source of truth for how bookings, orders, payments, refunds, memberships and the catalogue behave** (`server/rules/README.md` says what each slice decided and why). The old Retool code, its frozen copies and the golden files are gone (W61, W65).
- `app/api/` is `v1/` (each route through `defineRoute`: sign-in, permissions, input, idempotency) and two webhooks, `stripe/webhook` and `sanity/webhook` (each with its own signature check, on the Worker's own database connection; no service-role key). Nothing else: `server/api-allowlist.test.ts`.
- **Contracts** (`contracts/`, zod) are what the screens compile against: after any edit there, `npm run export:contracts` writes the staff app's `workerContracts.ts` (`npm run check:contracts` fails when it is behind).
- **Tests.** Each decision has a rule test beside its rule, on the live schema (`server/rules/testing/live-schema.sql`, generated from the live catalog, up to migration 034, and carrying 035, which the lead applies before the W72a push). The all-Worker sweep (`server/rules/testing/sweep/`) presses every scenario through the Worker as its screen does and compares it with its recording (`testing/recordings/`), with the money invariants checked on each. A recording is not a rule test: `UPDATE_RECORDINGS=1` would accept a change, so a new rule needs a test of its own. `server/staff-app-*.test.ts` read the staff app's files. No test reaches real Stripe.
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
- Test copies stay out of search: every host but `thepaddockwellness.co.uk` answers `X-Robots-Tag: noindex, nofollow` (`next.config.ts` for what the Worker answers, `public/_headers` for the static files Cloudflare answers itself) and a robots.txt that disallows everything (`app/robots.ts`). `lib/seo/noindex.test.ts` holds all three.
