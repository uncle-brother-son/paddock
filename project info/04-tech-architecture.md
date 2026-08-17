# 4. Tech Architecture & Stack

## Third-Party Tools & Services

| Layer | Tool | URL | Notes | Setup / access notes | Owner (sets up account) |
|---|---|---|---|---|---|
| CMS | Sanity | sanity.io | Content, pages, imagery | | Agency |
| Hosting | Cloudflare | cloudflare.com | Workers + Pages | | Agency (transferred to client's own account at handoff) |
| Payments | Stripe | stripe.com | Checkout, Subscriptions, saved cards (`setup_future_usage`) | Account setup, webhook config | Client (business/legal entity must own this account) |
| Auth (TBC) | Clerk / Supabase Auth | clerk.com / supabase.com | **Decision: Supabase Auth** (see rationale below) | | Agency |
| Database | Postgres | postgresql.org | Via Supabase | | Agency |
| Transactional email | Resend + React Email | resend.com / react.email | | API key | Agency |
| Marketing email | Klaviyo | klaviyo.com | Data connection only — client's team builds campaigns | Event/data sync from backend | Client (their team owns and runs this) |
| Staff dashboard | Retool | retool.com | Free tier expected sufficient | Database connection | Agency |
| Reporting | Metabase (TBC) | metabase.com | Self-hosted | Database connection, self-hosted deployment | Agency |
| Staff calendar visibility | Google Calendar API | developers.google.com/calendar | One-way push, display only | OAuth setup (one-time) | Client (their Google Workspace account) |
| Tracking | Google Analytics | | Frontend tracking tool | ID | Agency |

> Note: the Notion "Auth" row still shows "(TBC)" / "Decision pending" — per this project's
> working conversation, **Supabase Auth was selected** (bundled Postgres, Row Level Security
> integration, single-vendor coherence with the rest of the custom backend). Worth updating the
> Notion page to reflect this as resolved.

## Custom-Built Components

| Component | Built with | Notes | Owner |
|---|---|---|---|
| Frontend | React | Fully custom design and build — no third-party booking widgets embedded | Agency |
| Booking engine | Custom backend (own database) | Availability, slot generation, public/private exclusivity logic — see 05-data-model.md → Bookings | Agency |

## Security notes

- No card data ever touches our servers — Stripe handles all card storage and PCI scope
- Auth handled by a managed provider (Supabase Auth), not custom-built
- Row-level security (Supabase) restricts customers to their own data
- Secrets stored in Cloudflare Workers secrets, never exposed client-side

## Infrastructure notes (from working conversation, not yet in Notion)

- Cloudflare Workers run on an edge runtime — raw long-lived Postgres TCP connections aren't
  supported. Use either **Supabase's connection pooler** (PgBouncer, transaction mode) or
  **Cloudflare Hyperdrive** to connect from Workers to Postgres. Decide which before backend
  work starts.
- Supabase project setup: **Data API — on**, **Automatically expose new tables — off**,
  **Automatic RLS — on**. (Auto-expose off + automatic RLS on = new tables are inaccessible by
  default until access is deliberately granted and policies are written — fails closed, not
  open.)
