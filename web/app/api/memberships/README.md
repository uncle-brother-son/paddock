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

## `POST /api/memberships/change-payment-date`

Moves a monthly membership's payment date forward (staff only, from Retool). The member pays now
for the extra days, then the full monthly price from the new date. Same Retool bearer auth.

### Request
```json
{
  "stripeSubscriptionId": "sub_...",
  "newRenewalDate": "2026-12-25 (London date)",
  "partMonthAmount": 22.00
}
```

1. Refuses unless the membership row is monthly, active and has no `cancel_effective_date`; the
   customer has a saved card; and the Stripe subscription is `active`, one monthly price, not
   `cancel_at_period_end` / `cancel_at`, with its current period end (London date) equal to the
   row's `next_renewal_date` (stale data guard). The new date must be after that date and before
   the same day a month later; `partMonthAmount` can't be more than a full month.
2. Charges `partMonthAmount` off-session on the saved card (description "Payment date change: N
   extra days"). A failed charge stops here.
3. Updates the subscription with `trial_end` = the new date 00:00 Europe/London and
   `proration_behavior: 'none'`, which moves `billing_cycle_anchor` to the new date. If this
   fails, the charge is refunded in full.

The subscription reports `trialing` until the new date. Stripe sends a £0 invoice
(`billing_reason: 'subscription_update'`) whose `invoice.paid` runs `membership_mark_paid` with
the new date as the period end, and `customer.subscription.updated`, which only re-syncs the
(empty) cancellation. Credits and Herd stay on `start_date`. This route does not write to
Postgres: Retool records the order, the new `next_renewal_date` and the
`membership_payment_date_changes` row.

### Success response (200)
```json
{ "success": true, "paymentIntentId": "pi_...", "newPeriodEnd": "2026-12-25T00:00:00.000Z", "extraDays": 22 }
```
A `warning` is added if Stripe doesn't report the expected `trial_end` / `billing_cycle_anchor`.

### Error codes
| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `not_monthly` / `not_active` / `cancel_scheduled` / `no_saved_card` / `date_out_of_range` / `amount_too_high` | Refused before any charge. |
| 409 | `stale_renewal_date` / `not_active` / `cancel_scheduled` / `not_monthly` / `customer_mismatch` | Stripe disagrees with the row; nothing charged. |
| 402 | `payment_failed` | Card declined or needs authentication; nothing changed. |
| 500 | `subscription_update_failed` | Charged, the date move failed, the charge was refunded. |
| 500 | `refund_failed` | Charged, the date move failed and the refund failed: refund the PaymentIntent in Stripe. |
