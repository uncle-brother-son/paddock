# Memberships API

## `POST /api/memberships/create-subscription`

Creates a real, auto-renewing Stripe subscription for a membership sold by card or reader. The
first invoice is charged immediately to the customer's saved card. Renewals and payment failures
are handled separately by `/api/stripe/webhook` (which deliberately ignores `billing_reason:
'subscription_create'`, so this first charge is never double-processed).

This route does **not** write to Postgres — no `orders` or `customer_memberships` rows. Retool
owns those writes and stores `subscriptionId`, `paymentIntentId`, and the invoice id itself.

### Request
```json
{
  "customerId": "uuid",
  "membershipPlanId": "uuid",
  "billingFrequency": "monthly | yearly",
  "idempotencyKey": "optional string, forwarded to Stripe's subscriptions.create",
  "discountAmount": "optional number, pounds. Gift card / store credit applied to the FIRST payment only"
}
```

`discountAmount` creates a one-off Stripe coupon (amount_off, GBP, duration once) attached to the
subscription, so only the first invoice is reduced; renewals charge the full price. A discount equal
to the full price gives a £0 first invoice (`paymentIntentId` may be null). The coupon is deleted if
the card is declined. The saved card is still required either way.

### Success response (200)
```json
{
  "success": true,
  "subscriptionId": "sub_...",
  "status": "active",
  "currentPeriodStart": "2026-01-01T00:00:00.000Z",
  "currentPeriodEnd": "2026-02-01T00:00:00.000Z",
  "latestInvoiceId": "in_...",
  "paymentIntentId": "pi_...",
  "amountPaid": 25,
  "discountApplied": 0
}
```

### Error codes
| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `no_saved_card` | Customer has no `stripe_customer_id`/`saved_payment_method_id` on file. |
| 404 | — | Customer or membership plan not found. |
| 400 | — | Membership plan is not active. |
| 400 | `plan_not_synced` | Plan has no Stripe price for the requested billing frequency. |
| 400 | `price_not_recurring` | The plan's price for that frequency isn't a recurring GBP price matching the frequency — never subscribes to a mismatched price. |
| 400 | `invalid_discount` | `discountAmount` is negative or not a number. |
| 400 | `discount_exceeds_total` | `discountAmount` is larger than the plan's first payment. |
| 402 | `payment_failed` | Stripe declined the first charge (card declined, `authentication_required`, etc.) — no subscription is left behind. |
| 500 | — | Internal error (Stripe/Supabase failure unrelated to the card itself). |
