# Memberships API

## `POST /api/memberships/create-subscription` (removed at W16)

Removed with the staff app's old order code, its only caller. A membership's subscription is now made by the
order route (`POST /api/v1/staff/orders`, `server/rules/orders/membership.ts`). A frozen copy stays for the
replay's set-up only (`server/rules/testing/legacy-order/`, deleted at step H).

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
