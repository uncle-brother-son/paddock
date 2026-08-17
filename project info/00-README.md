# The Paddock Wellness Club — Project Documentation

Exported from Notion (client-shared workspace, "Website & Booking Platform") on 2026-08-15.
Agency: Uncle Brother Son Ltd. Client: The Paddock Wellness Club (Henry & Helen, "HH").

This folder is the canonical spec for the build. Point Copilot/Claude Code at it for context on
architecture, data model, and business rules. Files are numbered to match the Notion structure:

- `01-project-overview.md` — brief, goals, success criteria, stakeholders
- `02-scope.md` — in/out of scope
- `03-user-flows.md` — key journeys + cross-cutting features
- `04-tech-architecture.md` — stack, tools, custom components, security notes
- `05-data-model.md` — full field-level data model, all entities
- `06-sanity-supabase-field-split.md` — which fields live in Sanity vs. Postgres, per catalog
  entity (Products, Add-ons, Session/Service Types, Membership Plans, Session Pass Types)
- `07-write-architecture.md` — how Sanity, Retool, Postgres and Stripe stay in sync; the rule
  that the backend is the only thing that ever writes to Stripe

## Flagged — database/Sanity build

1. **Private session pricing is tiered by headcount, not flat.** See 05-data-model.md → Service
   Type Price Tier for the full structure. 60-min tiers are confirmed (1–6: £105, 7: £120, 8:
   £140, 10: £170) except the 9-adult band, which still needs confirming. 120-min pricing is
   only confirmed for the 1–6 band (£210) — the 7/8/9/10-adult tiers for 120 min still need
   confirming from HH.
2. **Session pass expiry** — `expiry_months` is now a configurable field on Pass Type rather
   than a hardcoded value. Still waiting on HH's actual answer for what that number should be.
3. **Gift Card `Origin` field** — confirmed, already reflected in 05-data-model.md (customer
   purchase / issued as cancellation credit). No open action.
4. ~~Gift Card design/template entity~~ **Resolved** — no entity needed. Just one representative
   image on the Gift Cards page, no design picker — ordinary Sanity page content, not a database
   table.
