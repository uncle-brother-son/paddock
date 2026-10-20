# Stripe Webhook

Handles subscription billing events for memberships. Verifies the Stripe signature, records
each event in `stripe_webhook_events` for idempotency, then dispatches to the matching
`membership_*` Postgres function (see `supabase/migrations/009_membership_periods_and_lapse.sql`).

## Endpoint

```
https://paddock.paddock-55d.workers.dev/api/stripe/webhook
```

## Events to subscribe (Stripe Dashboard → Developers → Webhooks)

- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Any other event type is accepted and recorded as `ignored` — safe to leave the webhook's filter
on "all events" or add more later without code changes.

## Required env var

- `STRIPE_WEBHOOK_SECRET` — the signing secret for this specific webhook endpoint (starts `whsec_`),
  found on the webhook's detail page in the Stripe Dashboard after creating it.

## Setting it for the Worker

```bash
cd web
wrangler secret put STRIPE_WEBHOOK_SECRET
```
This prompts for the value interactively — never pass it as a command-line argument or paste it
into a file in this repo.

## Idempotency

Each event is claimed via an insert into `stripe_webhook_events` (`event_id` is the primary key).
A duplicate delivery whose prior attempt already finished (`outcome` = `processed` or `ignored`)
is skipped. A prior attempt that crashed or never finished (`outcome` = `error` or `null`) is
retried.
